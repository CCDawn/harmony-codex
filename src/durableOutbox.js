import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ACTIVE_STATUSES = new Set(['queued', 'failed', 'dispatching', 'uncertain']);
const EDITABLE_STATUSES = new Set(['queued', 'failed']);

export class DurableOutbox {
  constructor({
    filePath,
    dispatch,
    reconcile = null,
    canDispatch = null,
    canRequeueSubmitted = null,
    logger = null,
    now = () => Date.now(),
    random = Math.random,
    baseDelayMs = 1_500,
    maxDelayMs = 60_000,
    blockedDelayMs = 1_500,
    maxItems = 500,
    schedule = true
  }) {
    if (!filePath) {
      throw new Error('Durable outbox requires a file path');
    }
    if (typeof dispatch !== 'function') {
      throw new Error('Durable outbox requires a dispatch function');
    }
    this.filePath = path.resolve(filePath);
    this.dispatch = dispatch;
    this.reconcile = typeof reconcile === 'function' ? reconcile : null;
    this.canDispatch = typeof canDispatch === 'function' ? canDispatch : null;
    this.canRequeueSubmitted = typeof canRequeueSubmitted === 'function'
      ? canRequeueSubmitted
      : null;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.baseDelayMs = Math.max(100, Number(baseDelayMs) || 1_500);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 60_000);
    this.blockedDelayMs = Math.max(250, Number(blockedDelayMs) || 1_500);
    this.maxItems = Math.max(50, Number(maxItems) || 500);
    this.scheduleEnabled = schedule !== false;
    this.items = [];
    this.initialized = null;
    this.persistPromise = Promise.resolve();
    this.dispatchPromise = null;
    this.blockedDecisionByItemId = new Map();
    this.timer = null;
  }

  async initialize() {
    if (this.initialized) {
      return await this.initialized;
    }
    this.initialized = this.load();
    try {
      await this.initialized;
      return this.list({ includeTerminal: true });
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  async load() {
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await this.log('error', 'outbox.load.failed', { message: error?.message ?? String(error) });
      }
    }
    const restored = Array.isArray(parsed?.items) ? parsed.items : [];
    let changed = false;
    this.items = restored
      .map((item) => normalizePersistedItem(item))
      .filter(Boolean)
      .map((item) => {
        if (item.status !== 'dispatching') {
          return item;
        }
        changed = true;
        return {
          ...item,
          status: 'uncertain',
          error: 'Bridge 在提交过程中重启，发送结果需要确认后才能重试',
          retryable: false,
          nextAttemptAt: '',
          updatedAt: isoAt(this.now())
        };
      });
    this.prune();
    if (changed) {
      await this.persist();
    }
    await this.reconcileUncertainItems();
    this.scheduleNext();
  }

  async reconcileUncertainItems() {
    if (!this.reconcile) {
      return [];
    }
    const reconciled = [];
    for (const item of this.items.filter((candidate) => candidate.status === 'uncertain'
      || (candidate.status === 'dispatching' && candidate.resultId))) {
      const revision = { status: item.status, updatedAt: item.updatedAt, lastAttemptAt: item.lastAttemptAt };
      let receipt = null;
      try {
        receipt = await this.reconcile(clone(item));
      } catch (error) {
        await this.log('warn', 'outbox.item.reconcile_failed', {
          ...summarize(item),
          error: error?.message ?? String(error)
        });
        continue;
      }
      // A user can cancel or retry while the official history read is in flight.
      // Its stale result must not resurrect a canceled queue entry.
      if (item.status !== revision.status || item.updatedAt !== revision.updatedAt
        || item.lastAttemptAt !== revision.lastAttemptAt) {
        continue;
      }
      if (receipt?.status === 'failed' || receipt?.status === 'uncertain') {
        item.status = receipt.status;
        item.error = receipt.error || '未确认消息进入官方会话，请核对后重试';
        item.retryable = false;
        item.nextAttemptAt = '';
        item.updatedAt = isoAt(this.now());
        reconciled.push(clone(item));
        continue;
      }
      if (receipt?.status !== 'submitted') {
        await this.log('info', 'outbox.item.reconcile_unknown', summarize(item));
        continue;
      }
      item.status = 'submitted';
      item.result = normalizeResult(receipt.result ?? item.result);
      item.resultId = String(item.result?.id ?? item.result?.run?.id ?? item.resultId ?? '');
      item.error = '';
      item.retryable = false;
      item.nextAttemptAt = '';
      item.submittedAt = isoAt(this.now());
      item.updatedAt = item.submittedAt;
      reconciled.push(clone(item));
      await this.log('info', 'outbox.item.reconciled', summarize(item));
    }
    if (reconciled.length > 0) {
      await this.persist();
    }
    return reconciled;
  }

  async enqueue(input) {
    await this.initialize();
    const normalized = normalizeNewItem(input, this.now());
    const existing = this.items.find((item) => item.dedupeKey === normalized.dedupeKey);
    if (existing) {
      if (
        existing.status === 'submitted'
        && this.canRequeueSubmitted
        && await this.canRequeueSubmitted(clone(existing))
      ) {
        existing.status = 'queued';
        existing.result = null;
        existing.resultId = '';
        existing.error = '';
        existing.retryable = true;
        existing.nextAttemptAt = '';
        existing.submittedAt = '';
        existing.updatedAt = isoAt(this.now());
        await this.persist();
        await this.log('warn', 'outbox.item.requeued_after_safe_failure', summarize(existing));
        this.scheduleNext(0);
      }
      return clone(existing);
    }
    normalized.order = nextLaneOrder(this.items, normalized.laneKey);
    this.items.push(normalized);
    this.prune();
    await this.persist();
    await this.log('info', 'outbox.item.queued', summarize(normalized));
    this.scheduleNext(0);
    return clone(normalized);
  }

  list({ threadId = '', includeTerminal = true } = {}) {
    const normalizedThreadId = String(threadId ?? '').trim();
    return this.items
      .filter((item) => !normalizedThreadId || item.threadId === normalizedThreadId)
      .filter((item) => includeTerminal || ACTIVE_STATUSES.has(item.status))
      .sort(compareOutboxItems)
      .map(clone);
  }

  get(id) {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? clone(item) : null;
  }

  getBySubmissionId(kind, targetId, submissionId) {
    const dedupeKey = buildDedupeKey(kind, targetId, submissionId);
    const item = this.items.find((candidate) => candidate.dedupeKey === dedupeKey);
    return item ? clone(item) : null;
  }

  async update(id, patch = {}) {
    await this.initialize();
    const item = this.requireItem(id);
    assertEditable(item);
    if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
      const text = String(patch.text ?? '').trim();
      if (!text) {
        throw statusError('排队消息不能为空', 400);
      }
      item.text = text;
      item.payload = { ...item.payload, text };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'payload')) {
      const payload = normalizePayload(patch.payload);
      item.payload = { ...item.payload, ...payload, text: item.text };
    }
    item.status = 'queued';
    item.error = '';
    item.retryable = true;
    item.nextAttemptAt = '';
    item.updatedAt = isoAt(this.now());
    await this.persist();
    await this.log('info', 'outbox.item.updated', summarize(item));
    this.scheduleNext(0);
    return clone(item);
  }

  async move(id, direction) {
    await this.initialize();
    const item = this.requireItem(id);
    assertEditable(item);
    const lane = this.items
      .filter((candidate) => candidate.laneKey === item.laneKey && EDITABLE_STATUSES.has(candidate.status))
      .sort(compareOutboxItems);
    const currentIndex = lane.findIndex((candidate) => candidate.id === item.id);
    const targetIndex = direction === 'up'
      ? currentIndex - 1
      : direction === 'down'
        ? currentIndex + 1
        : -1;
    if (targetIndex < 0 || targetIndex >= lane.length) {
      return clone(item);
    }
    const target = lane[targetIndex];
    const order = item.order;
    item.order = target.order;
    target.order = order;
    item.updatedAt = isoAt(this.now());
    target.updatedAt = item.updatedAt;
    await this.persist();
    await this.log('info', 'outbox.item.moved', { ...summarize(item), direction });
    return clone(item);
  }

  async cancel(id) {
    await this.initialize();
    const item = this.requireItem(id);
    if (!ACTIVE_STATUSES.has(item.status) || item.status === 'dispatching') {
      throw statusError('当前排队消息不能取消', 409);
    }
    item.status = 'canceled';
    item.error = '';
    item.retryable = false;
    item.nextAttemptAt = '';
    item.updatedAt = isoAt(this.now());
    await this.persist();
    await this.log('info', 'outbox.item.canceled', summarize(item));
    this.scheduleNext(0);
    return clone(item);
  }

  async retry(id) {
    await this.initialize();
    const item = this.requireItem(id);
    if (!['failed', 'uncertain'].includes(item.status)) {
      throw statusError('只有失败或待确认的消息可以重试', 409);
    }
    item.status = 'queued';
    item.error = '';
    item.retryable = true;
    item.nextAttemptAt = '';
    item.updatedAt = isoAt(this.now());
    await this.persist();
    await this.log('warn', 'outbox.item.retry_requested', summarize(item));
    this.scheduleNext(0);
    return clone(item);
  }

  async dispatchReady() {
    await this.initialize();
    if (this.dispatchPromise) {
      return await this.dispatchPromise;
    }
    this.dispatchPromise = this.dispatchReadyOnce()
      .finally(() => {
        this.dispatchPromise = null;
        this.scheduleNext();
      });
    return await this.dispatchPromise;
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async dispatchReadyOnce() {
    await this.reconcileUncertainItems();
    const now = this.now();
    const firstByLane = new Map();
    for (const item of this.items.slice().sort(compareOutboxItems)) {
      if (!isReady(item, now) || firstByLane.has(item.laneKey)) {
        continue;
      }
      const earlierActive = this.items.some((candidate) => (
        candidate.laneKey === item.laneKey
        && candidate.order < item.order
        && ACTIVE_STATUSES.has(candidate.status)
        && !(candidate.status === 'failed' && candidate.retryable === false)
        && candidate.status !== 'canceled'
        && candidate.status !== 'submitted'
      ));
      if (!earlierActive) {
        firstByLane.set(item.laneKey, item);
      }
    }
    const results = await Promise.all(
      [...firstByLane.values()].map((item) => this.dispatchOne(item))
    );
    return results.filter(Boolean);
  }

  async dispatchOne(item) {
    if (this.canDispatch) {
      const decision = normalizeDispatchDecision(await this.canDispatch(clone(item)));
      if (!decision.allowed) {
        item.nextAttemptAt = isoAt(this.now() + this.blockedDelayMs);
        item.updatedAt = isoAt(this.now());
        await this.persist();
        const previousReason = this.blockedDecisionByItemId.get(item.id);
        if (previousReason !== decision.reason) {
          this.blockedDecisionByItemId.set(item.id, decision.reason);
          await this.log('info', decision.reason === 'interrupt_pending'
            ? 'submission.blocked_by_interrupt'
            : 'submission.blocked', {
            ...summarize(item),
            reason: decision.reason,
            runId: decision.runId,
            turnId: decision.turnId
          });
        }
        return clone(item);
      }
      const previousReason = this.blockedDecisionByItemId.get(item.id);
      if (previousReason) {
        this.blockedDecisionByItemId.delete(item.id);
        await this.log('info', 'submission.dequeued', {
          ...summarize(item),
          previousReason
        });
      }
    }
    item.status = 'dispatching';
    item.lastAttemptAt = isoAt(this.now());
    item.nextAttemptAt = '';
    item.updatedAt = item.lastAttemptAt;
    await this.persist();
    await this.log('info', 'outbox.item.dispatching', summarize(item));
    try {
      const result = await this.dispatch(clone(item));
      item.status = result?.deliveryPending === true ? 'dispatching' : 'submitted';
      item.result = normalizeResult(result);
      item.resultId = String(result?.id ?? result?.run?.id ?? '');
      item.error = '';
      item.retryable = false;
      item.nextAttemptAt = '';
      item.submittedAt = item.status === 'submitted' ? isoAt(this.now()) : '';
      item.updatedAt = isoAt(this.now());
      await this.persist();
      await this.log('info', item.status === 'submitted' ? 'outbox.item.submitted' : 'outbox.item.awaiting_receipt', summarize(item));
      return clone(item);
    } catch (error) {
      item.attemptCount += 1;
      item.status = error?.deliveryUncertain === true ? 'uncertain' : 'failed';
      if (error?.deliveryUncertain === true) {
        item.resultId = String(error.deliveryTaskId ?? '');
        item.result = { deliveryPending: true, run: { id: item.resultId } };
      }
      item.error = error?.message ?? String(error);
      item.retryable = error?.deliveryUncertain !== true && isRetryableOutboxError(error);
      item.nextAttemptAt = item.retryable
        ? isoAt(this.now() + retryDelayMs(item.attemptCount, this))
        : '';
      item.updatedAt = isoAt(this.now());
      await this.persist();
      await this.log(item.retryable ? 'warn' : 'error', 'outbox.item.failed', {
        ...summarize(item),
        retryable: item.retryable,
        error: item.error
      });
      return clone(item);
    }
  }

  requireItem(id) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      throw statusError('Unknown outbox item', 404);
    }
    return item;
  }

  prune() {
    if (this.items.length <= this.maxItems) {
      return;
    }
    const active = this.items.filter((item) => ACTIVE_STATUSES.has(item.status));
    const terminal = this.items
      .filter((item) => !ACTIVE_STATUSES.has(item.status))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    this.items = [...active, ...terminal.slice(0, Math.max(0, this.maxItems - active.length))];
  }

  async persist() {
    const snapshot = JSON.stringify({
      version: 1,
      updatedAt: isoAt(this.now()),
      items: this.items
    }, null, 2);
    // A failed save must reach its caller without preventing future saves.
    this.persistPromise = this.persistPromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporaryPath, this.filePath);
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 4) {
            throw error;
          }
          // Windows readers can briefly hold the destination. Keep the old
          // file intact and retry the atomic replacement with bounded backoff.
          await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
        }
      }
    });
    return await this.persistPromise;
  }

  scheduleNext(delayOverride = null) {
    if (!this.scheduleEnabled) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let nextAt = this.items
      .filter((item) => item.status === 'queued' || (item.status === 'failed' && item.retryable))
      .map((item) => item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : now)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (this.items.some(item => item.status === 'dispatching' && item.resultId)) {
      nextAt = Math.min(Number.isFinite(nextAt) ? nextAt : Infinity, now + 1500);
    }
    if (this.items.some(item => item.status === 'uncertain'
      && now - Date.parse(item.lastAttemptAt) < 300_000)) {
      nextAt = Math.min(Number.isFinite(nextAt) ? nextAt : Infinity, now + 5000);
    }
    if (!Number.isFinite(nextAt) && delayOverride === null) {
      return;
    }
    const delay = delayOverride === null
      ? Math.max(0, nextAt - now)
      : Math.max(0, Number(delayOverride) || 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchReady().catch(error => this.log('error', 'outbox.dispatch.failed', {
        code: error?.code,
        message: String(error?.message ?? error)
      })).catch(() => {});
    }, Math.min(delay, 2_147_483_647));
    this.timer.unref?.();
  }

  async log(level, event, payload) {
    await this.logger?.write?.('outbox', level, event, payload).catch(() => {});
  }
}

export function isRetryableOutboxError(error) {
  const code = Number(error?.code);
  const status = Number(error?.statusCode ?? error?.status);
  if (code === -32001 || [408, 425, 429, 502, 503, 504].includes(status)) {
    return true;
  }
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('server overloaded')
    || message.includes('retry later')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('offline')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('fetch failed')
    || message.includes('socket hang up')
    || message.includes('network');
}

function normalizeNewItem(input, now) {
  const kind = String(input?.kind ?? '').trim();
  if (!['existing_thread', 'new_thread'].includes(kind)) {
    throw statusError('Unknown outbox item kind', 400);
  }
  const threadId = String(input?.threadId ?? '').trim();
  const projectId = String(input?.projectId ?? '').trim();
  const targetId = kind === 'existing_thread' ? threadId : projectId;
  if (!targetId) {
    throw statusError('Outbox item requires a target', 400);
  }
  const submissionId = String(input?.submissionId ?? '').trim();
  if (!submissionId) {
    throw statusError('Outbox item requires a submission id', 400);
  }
  const text = String(input?.text ?? '').trim();
  if (!text) {
    throw statusError('排队消息不能为空', 400);
  }
  const timestamp = isoAt(now);
  return {
    id: `outbox_${randomUUID()}`,
    kind,
    laneKey: `${kind}:${targetId}`,
    dedupeKey: buildDedupeKey(kind, targetId, submissionId),
    threadId,
    projectId,
    submissionId,
    text,
    payload: { ...normalizePayload(input?.payload), text },
    status: 'queued',
    order: 0,
    attemptCount: 0,
    retryable: true,
    error: '',
    nextAttemptAt: '',
    lastAttemptAt: '',
    submittedAt: '',
    resultId: '',
    result: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizePersistedItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const kind = String(item.kind ?? '').trim();
  const targetId = kind === 'existing_thread'
    ? String(item.threadId ?? '').trim()
    : String(item.projectId ?? '').trim();
  const submissionId = String(item.submissionId ?? '').trim();
  const text = String(item.text ?? '').trim();
  if (!['existing_thread', 'new_thread'].includes(kind) || !targetId || !submissionId || !text) {
    return null;
  }
  return {
    ...item,
    id: String(item.id ?? `outbox_${randomUUID()}`),
    kind,
    laneKey: `${kind}:${targetId}`,
    dedupeKey: buildDedupeKey(kind, targetId, submissionId),
    threadId: String(item.threadId ?? '').trim(),
    projectId: String(item.projectId ?? '').trim(),
    submissionId,
    text,
    payload: { ...normalizePayload(item.payload), text },
    status: normalizeStatus(item.status),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    attemptCount: Math.max(0, Number(item.attemptCount) || 0),
    retryable: item.retryable !== false,
    error: String(item.error ?? ''),
    nextAttemptAt: String(item.nextAttemptAt ?? ''),
    lastAttemptAt: String(item.lastAttemptAt ?? ''),
    submittedAt: String(item.submittedAt ?? ''),
    resultId: String(item.resultId ?? ''),
    result: normalizeResult(item.result),
    createdAt: String(item.createdAt ?? new Date().toISOString()),
    updatedAt: String(item.updatedAt ?? item.createdAt ?? new Date().toISOString())
  };
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim();
  return ['queued', 'failed', 'dispatching', 'uncertain', 'submitted', 'canceled'].includes(value)
    ? value
    : 'queued';
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return clone(payload);
}

function normalizeDispatchDecision(value) {
  if (value && typeof value === 'object') {
    return {
      allowed: value.allowed === true,
      reason: String(value.reason ?? 'runtime_busy'),
      runId: String(value.runId ?? ''),
      turnId: String(value.turnId ?? '')
    };
  }
  return {
    allowed: value === true,
    reason: value === true ? '' : 'runtime_busy',
    runId: '',
    turnId: ''
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  return clone(result);
}

function nextLaneOrder(items, laneKey) {
  return items
    .filter((item) => item.laneKey === laneKey)
    .reduce((maximum, item) => Math.max(maximum, Number(item.order) || 0), 0) + 1;
}

function compareOutboxItems(left, right) {
  if (left.laneKey !== right.laneKey) {
    return String(left.createdAt).localeCompare(String(right.createdAt));
  }
  if (left.order !== right.order) {
    return left.order - right.order;
  }
  return String(left.createdAt).localeCompare(String(right.createdAt));
}

function isReady(item, now) {
  if (item.status === 'queued') {
    return !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now;
  }
  return item.status === 'failed'
    && item.retryable
    && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now);
}

function retryDelayMs(attemptCount, options) {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * (2 ** Math.max(0, attemptCount - 1))
  );
  const jitter = 0.75 + (Math.max(0, Math.min(1, Number(options.random()) || 0)) * 0.5);
  return Math.round(exponential * jitter);
}

function buildDedupeKey(kind, targetId, submissionId) {
  return `${String(kind ?? '').trim()}\u0000${String(targetId ?? '').trim()}\u0000${String(submissionId ?? '').trim()}`;
}

function assertEditable(item) {
  if (!EDITABLE_STATUSES.has(item.status)) {
    throw statusError('只有排队中或发送失败的消息可以编辑和排序', 409);
  }
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isoAt(now) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(Number(value)).toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function summarize(item) {
  return {
    id: item.id,
    kind: item.kind,
    threadId: item.threadId,
    projectId: item.projectId,
    submissionId: item.submissionId,
    status: item.status,
    attemptCount: item.attemptCount,
    resultId: item.resultId
  };
}
