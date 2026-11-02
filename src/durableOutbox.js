import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compactOutboxResult } from './outboxResult.js';

export { compactOutboxResult } from './outboxResult.js';

const ACTIVE_STATUSES = new Set(['queued', 'failed', 'dispatching', 'uncertain']);
const EDITABLE_STATUSES = new Set(['queued', 'failed']);
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_HOLD_ERROR = '历史消息超过24小时，已暂停自动发送；请核对后重试';

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
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
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
    this.staleAfterMs = Math.max(1, Number(staleAfterMs) || DEFAULT_STALE_AFTER_MS);
    this.maxItems = Math.max(50, Number(maxItems) || 500);
    this.scheduleEnabled = schedule !== false;
    this.items = [];
    this.initialized = null;
    this.persistPromise = Promise.resolve();
    this.dispatchPromise = null;
    this.pendingDispatchItemIds = new Set();
    this.reconcilePromise = null;
    this.receiptReconciliationRequested = false;
    this.receiptWakeScheduled = false;
    this.receiptWakeRunning = false;
    this.closed = false;
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
    let changed = restored.some(item => item?.result && item.result.outboxSnapshotVersion !== 1);
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
          revision: item.revision + 1,
          error: 'Bridge 在提交过程中重启，发送结果需要确认后才能重试',
          retryable: false,
          nextAttemptAt: '',
          updatedAt: isoAt(this.now())
        };
      });
    changed = this.holdStaleItems() || changed;
    // Loading/migrating a legacy file must not discard terminal receipts. The
    // ordinary enqueue retention policy still applies when accepting new work.
    if (changed) {
      await this.persist();
    }
    // Receipt reads can depend on an unresponsive desktop. Load and persist the
    // recovered state first; the existing dispatch scheduler reconciles it.
    this.scheduleNext(this.items.some(item => item.status === 'uncertain' || item.status === 'held') ? 0 : null);
  }

  async reconcileUncertainItems() {
    if (!this.reconcile) return [];
    if (this.reconcilePromise) return await this.reconcilePromise;
    this.receiptReconciliationRequested = false;
    this.reconcilePromise = this.reconcileUncertainItemsOnce().finally(() => {
      this.reconcilePromise = null;
      this.queueReceiptReconciliation();
    });
    return await this.reconcilePromise;
  }

  requestReceiptReconciliation() {
    if (this.closed || !this.reconcile) return;
    this.receiptReconciliationRequested = true;
    this.queueReceiptReconciliation();
  }

  queueReceiptReconciliation() {
    if (this.closed || !this.scheduleEnabled || !this.receiptReconciliationRequested
      || this.receiptWakeScheduled || this.receiptWakeRunning || this.reconcilePromise) return;
    this.receiptWakeScheduled = true;
    // Coalesce a synchronous event storm, independently of dispatchPromise:
    // another session's slow dispatch must not delay a received ACK.
    queueMicrotask(() => {
      this.receiptWakeScheduled = false;
      if (this.closed || !this.receiptReconciliationRequested) return;
      this.receiptReconciliationRequested = false;
      this.receiptWakeRunning = true;
      let initialized = false;
      void (async () => {
        await this.initialize();
        initialized = true;
        if (!this.closed) await this.reconcileUncertainItems();
      })().catch(error => {
        // A migration/save failure must not spin initialize() in microtasks.
        // Existing scheduler timers or a later receipt notification can retry.
        this.receiptReconciliationRequested = false;
        return this.log('error', 'outbox.reconcile.failed', {
          message: String(error?.message ?? error)
        });
      }).catch(() => {}).finally(() => {
        this.receiptWakeRunning = false;
        this.queueReceiptReconciliation();
        if (initialized) this.scheduleNext();
      });
    });
  }

  async reconcileUncertainItemsOnce() {
    if (!this.reconcile) {
      return [];
    }
    const reconciled = [];
    for (const item of this.items.slice()) {
      // A retried entry can still carry the preceding attempt's receipt id.
      // Its new dispatch must bind its result before that id can be reconciled.
      if (this.pendingDispatchItemIds.has(item.id)) continue;
      // Earlier history reads can yield while a later item is canceled or retried.
      if (item.status !== 'uncertain' && item.status !== 'held'
        && !(item.status === 'dispatching' && item.resultId)) {
        continue;
      }
      const revision = item.revision;
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
      if (item.revision !== revision) {
        continue;
      }
      // A hold is reversible only by a user or positive delivery evidence.
      if (item.status === 'held' && receipt?.status !== 'submitted') {
        continue;
      }
      if (receipt?.status === 'failed' || receipt?.status === 'uncertain') {
        item.status = receipt.status;
        if (receipt.result) item.result = compactOutboxResult(receipt.result, item);
        item.error = receipt.error || '未确认消息进入官方会话，请核对后重试';
        // Only positive pre-delivery evidence permits automatic retry. A lost
        // write acknowledgement must remain uncertain, even if a task failed.
        item.retryable = receipt.status === 'failed' && receipt.retryable === true
          && receipt.evidence === 'delivery_not_attempted';
        if (item.retryable) item.attemptCount += 1;
        item.nextAttemptAt = item.retryable
          ? isoAt(this.now() + retryDelayMs(item.attemptCount, this)) : '';
        item.updatedAt = isoAt(this.now());
        bumpRevision(item);
        await this.persist();
        reconciled.push(clone(item));
        continue;
      }
      if (receipt?.status !== 'submitted') {
        await this.log('info', 'outbox.item.reconcile_unknown', summarize(item));
        continue;
      }
      this.settleSubmitted(item, receipt);
      await this.persist();
      reconciled.push(clone(item));
      await this.log('info', 'outbox.item.reconciled', summarize(item));
    }
    return reconciled;
  }

  holdStaleItems() {
    const now = this.now();
    let changed = false;
    for (const item of this.items) {
      const ageFrom = staleAgeFrom(item);
      if (!Number.isFinite(ageFrom) || now - ageFrom <= this.staleAfterMs) {
        continue;
      }
      item.status = 'held';
      item.error = STALE_HOLD_ERROR;
      item.retryable = false;
      item.nextAttemptAt = '';
      item.blockedBy = '';
      item.blockedReason = '';
      item.updatedAt = isoAt(now);
      bumpRevision(item);
      changed = true;
    }
    return changed;
  }

  settleSubmitted(item, receipt) {
    item.status = 'submitted';
    item.result = compactOutboxResult(receipt.result ?? item.result, item);
    item.resultId = String(item.result?.id ?? item.result?.run?.id ?? item.resultId ?? '');
    item.error = '';
    item.retryable = false;
    item.nextAttemptAt = '';
    item.blockedBy = '';
    item.blockedReason = '';
    item.submittedAt = isoAt(this.now());
    item.updatedAt = item.submittedAt;
    bumpRevision(item);
  }

  async enqueue(input) {
    await this.initialize();
    const normalized = normalizeNewItem(input, this.now());
    const existing = this.items.find((item) => item.dedupeKey === normalized.dedupeKey);
    if (existing) {
      if (existing.text !== normalized.text || existing.projectId !== normalized.projectId
        || !isDeepStrictEqual(existing.payload, normalized.payload)) {
        throw Object.assign(statusError('提交标识已用于其他消息。', 409), { code: 'CODEX_SUBMISSION_ID_CONFLICT' });
      }
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
        bumpRevision(existing);
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
      .filter((item) => includeTerminal || ACTIVE_STATUSES.has(item.status) || item.status === 'held')
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
    bumpRevision(item);
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
    bumpRevision(item);
    bumpRevision(target);
    await this.persist();
    await this.log('info', 'outbox.item.moved', { ...summarize(item), direction });
    return clone(item);
  }

  async cancel(id) {
    await this.initialize();
    const item = this.requireItem(id);
    if ((!ACTIVE_STATUSES.has(item.status) && item.status !== 'held') || item.status === 'dispatching') {
      throw statusError('当前排队消息不能取消', 409);
    }
    item.status = 'canceled';
    item.error = '';
    item.retryable = false;
    item.nextAttemptAt = '';
    item.updatedAt = isoAt(this.now());
    bumpRevision(item);
    await this.persist();
    await this.log('info', 'outbox.item.canceled', summarize(item));
    this.scheduleNext(0);
    return clone(item);
  }

  async retry(id) {
    await this.initialize();
    const item = this.requireItem(id);
    if (!['failed', 'uncertain', 'held'].includes(item.status)) {
      throw statusError('只有失败、待确认或已暂停的消息可以重试', 409);
    }
    if (this.reconcile) {
      const revision = item.revision;
      let receipt = null;
      try {
        receipt = await this.reconcile(clone(item));
      } catch (error) {
        await this.log('warn', 'outbox.item.reconcile_failed', {
          ...summarize(item), error: error?.message ?? String(error)
        });
      }
      if (item.revision !== revision) {
        return clone(item);
      }
      if (receipt?.status === 'submitted') {
        this.settleSubmitted(item, receipt);
        await this.persist();
        this.scheduleNext(0);
        return clone(item);
      }
    }
    item.status = 'queued';
    item.error = '';
    item.retryable = true;
    item.nextAttemptAt = '';
    item.updatedAt = isoAt(this.now());
    bumpRevision(item);
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
    this.closed = true;
    this.receiptReconciliationRequested = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async dispatchReadyOnce() {
    if (this.holdStaleItems()) {
      await this.persist();
    }
    await this.reconcileUncertainItems();
    const now = this.now();
    const firstByLane = new Map();
    for (const item of this.items.slice().sort(compareOutboxItems)) {
      if (!isReady(item, now) || firstByLane.has(item.laneKey)) {
        continue;
      }
      const earlierActive = this.items.find((candidate) => (
        candidate.laneKey === item.laneKey
        && candidate.order < item.order
        && ACTIVE_STATUSES.has(candidate.status)
        && !(candidate.status === 'failed' && candidate.retryable === false)
        && candidate.status !== 'canceled'
        && candidate.status !== 'submitted'
      ));
      if (earlierActive) {
        const reason = earlierActive.status === 'uncertain'
          ? '前一条消息的发送结果待确认，确认后继续发送'
          : '等待前一条消息完成发送';
        const changed = item.blockedBy !== earlierActive.id || item.blockedReason !== reason;
        item.blockedBy = earlierActive.id;
        item.blockedReason = reason;
        item.nextAttemptAt = isoAt(now + this.blockedDelayMs);
        bumpRevision(item);
        if (changed) {
          await this.persist();
          await this.log('info', 'submission.blocked', {
            ...summarize(item), reason: 'earlier_submission', blockedBy: earlierActive.id
          });
        }
      }
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
    if (!isReady(item, this.now())) return null;
    const revision = item.revision;
    if (this.canDispatch) {
      const decision = normalizeDispatchDecision(await this.canDispatch(clone(item)));
      if (item.revision !== revision || !isReady(item, this.now())) return null;
      if (!decision.allowed) {
        item.nextAttemptAt = isoAt(this.now() + this.blockedDelayMs);
        bumpRevision(item);
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
        if (item.revision !== revision || !isReady(item, this.now())) return null;
      }
    }
    item.blockedBy = '';
    item.blockedReason = '';
    item.status = 'dispatching';
    item.lastAttemptAt = isoAt(this.now());
    item.nextAttemptAt = '';
    item.updatedAt = item.lastAttemptAt;
    bumpRevision(item);
    const dispatchRevision = item.revision;
    this.pendingDispatchItemIds.add(item.id);
    try {
      await this.persist();
      await this.log('info', 'outbox.item.dispatching', summarize(item));
      if (item.revision !== dispatchRevision) return null;
      try {
        const result = await this.dispatch(clone(item));
        if (item.revision !== dispatchRevision) return clone(item);
        item.status = result?.deliveryPending === true ? 'dispatching' : 'submitted';
        item.result = compactOutboxResult(result, item);
        item.resultId = String(result?.id ?? result?.run?.id ?? '');
        item.error = '';
        item.retryable = false;
        item.nextAttemptAt = '';
        item.submittedAt = item.status === 'submitted' ? isoAt(this.now()) : '';
        item.updatedAt = isoAt(this.now());
        bumpRevision(item);
        this.pendingDispatchItemIds.delete(item.id);
        await this.persist();
        // The native ACK can be published before dispatch returns its task id.
        // Always check once after binding it, even if that notification was early.
        if (result?.deliveryPending === true) this.requestReceiptReconciliation();
        await this.log('info', item.status === 'submitted' ? 'outbox.item.submitted' : 'outbox.item.awaiting_receipt', summarize(item));
        return clone(item);
      } catch (error) {
        if (item.revision !== dispatchRevision) return clone(item);
        item.attemptCount += 1;
        item.status = error?.deliveryUncertain === true ? 'uncertain' : 'failed';
        if (error?.deliveryUncertain === true) {
          item.resultId = String(error.deliveryTaskId ?? '');
          item.result = compactOutboxResult({ deliveryPending: true, run: { id: item.resultId } }, item);
        }
        item.error = error?.message ?? String(error);
        item.retryable = error?.deliveryUncertain !== true && isRetryableOutboxError(error);
        item.nextAttemptAt = item.retryable
          ? isoAt(this.now() + retryDelayMs(item.attemptCount, this))
          : '';
        item.updatedAt = isoAt(this.now());
        bumpRevision(item);
        this.pendingDispatchItemIds.delete(item.id);
        await this.persist();
        await this.log(item.retryable ? 'warn' : 'error', 'outbox.item.failed', {
          ...summarize(item),
          retryable: item.retryable,
          error: item.error
        });
        return clone(item);
      }
    } finally {
      this.pendingDispatchItemIds.delete(item.id);
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
    const active = this.items.filter((item) => ACTIVE_STATUSES.has(item.status) || item.status === 'held');
    const terminal = this.items
      .filter((item) => !ACTIVE_STATUSES.has(item.status) && item.status !== 'held')
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
    if (!this.scheduleEnabled || this.closed) {
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
    for (const item of this.items) {
      const ageFrom = staleAgeFrom(item);
      if (Number.isFinite(ageFrom)) {
        nextAt = Math.min(Number.isFinite(nextAt) ? nextAt : Infinity,
          ageFrom + this.staleAfterMs + 1);
      }
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
    revision: 0,
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
    revision: Math.max(0, Number(item.revision) || 0),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    attemptCount: Math.max(0, Number(item.attemptCount) || 0),
    retryable: item.retryable !== false,
    error: String(item.error ?? ''),
    nextAttemptAt: String(item.nextAttemptAt ?? ''),
    lastAttemptAt: String(item.lastAttemptAt ?? ''),
    submittedAt: String(item.submittedAt ?? ''),
    resultId: String(item.resultId ?? ''),
    result: compactOutboxResult(item.result, item),
    createdAt: String(item.createdAt ?? new Date().toISOString()),
    updatedAt: String(item.updatedAt ?? item.createdAt ?? new Date().toISOString())
  };
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim();
  return ['queued', 'failed', 'dispatching', 'uncertain', 'held', 'submitted', 'canceled'].includes(value)
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

function staleAgeFrom(item) {
  const createdAt = Date.parse(item.createdAt);
  if (item.status === 'uncertain') {
    const attemptedAt = Date.parse(item.lastAttemptAt);
    return Number.isFinite(attemptedAt) ? attemptedAt : createdAt;
  }
  if (item.status === 'queued') {
    const updatedAt = Date.parse(item.updatedAt);
    return Math.max(Number.isFinite(createdAt) ? createdAt : -Infinity,
      Number.isFinite(updatedAt) ? updatedAt : -Infinity);
  }
  return NaN;
}

function bumpRevision(item) {
  item.revision += 1;
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
