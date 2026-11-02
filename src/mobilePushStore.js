import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_RECEIPTS_PER_INSTALLATION = 1000;
const MAX_BASELINE_TURNS_PER_THREAD = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const RECEIPT_STATES = new Set(['sending', 'accepted', 'failed', 'uncertain']);
const SETTLED_STATES = new Set(['accepted', 'failed', 'uncertain']);

// A single store instance owns this file. Every read/mutation joins the same
// queue, and memory advances only after atomic replacement succeeds.
export class MobilePushStore {
  #state = null;
  #initialized = null;
  #operations = Promise.resolve();

  constructor({ filePath, now = () => Date.now() } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Mobile push store requires a file path');
    }
    if (typeof now !== 'function') throw new Error('Mobile push store requires a clock');
    this.filePath = path.resolve(filePath);
    this.now = now;
  }

  async initialize() {
    return await this.#enqueue(() => undefined);
  }

  async upsert(id, { token, threadIds, enabled = true, baselineTurns = {} } = {}) {
    const normalizedId = normalizeUuid(id);
    const normalizedToken = normalizeToken(token);
    const normalizedThreads = normalizeThreads(threadIds);
    const suppliedBaselines = normalizeBaselines(baselineTurns, normalizedThreads);
    if (typeof enabled !== 'boolean') throw inputError('Mobile push enabled must be boolean');
    return await this.#mutate(state => {
      const at = isoAt(this.now());
      const previous = state.installations.find(item => item.id === normalizedId);
      const nextBaselines = Object.fromEntries(normalizedThreads.map(threadId => [threadId,
        previous?.threadIds.includes(threadId)
          ? previous.baselineTurns[threadId]
          : (suppliedBaselines[threadId] ?? [])
      ]));
      const installation = {
        id: normalizedId, token: normalizedToken, threadIds: normalizedThreads, enabled,
        instanceId: previous?.instanceId ?? randomUUID(),
        baselineTurns: nextBaselines,
        createdAt: previous?.createdAt ?? at, updatedAt: at
      };
      if (previous) state.installations[state.installations.indexOf(previous)] = installation;
      else state.installations.push(installation);
      // Receipts belong to the installation, not its replaceable device token.
      return { changed: true, result: installation };
    });
  }

  async remove(id) {
    const normalizedId = normalizeUuid(id);
    return await this.#mutate(state => {
      const changed = state.installations.some(item => item.id === normalizedId);
      if (changed) {
        state.installations = state.installations.filter(item => item.id !== normalizedId);
        state.receipts = state.receipts.filter(item => item.installationId !== normalizedId);
      }
      return { changed, result: { changed } };
    });
  }

  // Internal delivery view contains plaintext push tokens. HTTP handlers must
  // explicitly select public metadata rather than returning this view.
  async list() {
    return await this.#enqueue(() => structuredClone(this.#state.installations));
  }

  // A unique owner ID is returned only after the sending receipt is on disk. A receipt of
  // any state blocks automatic resends, including after process restart. The
  // claim owner may release it only when delivery was never attempted.
  async claim(installationId, eventKey) {
    const id = normalizeUuid(installationId);
    const key = normalizeEventKey(eventKey);
    return await this.#mutate(state => {
      const installation = state.installations.find(item => item.id === id);
      if (!installation?.enabled || state.receipts.some(item => item.installationId === id && item.eventKey === key)) {
        return { changed: false, result: null };
      }
      const receipts = state.receipts.filter(item => item.installationId === id);
      if (receipts.length >= MAX_RECEIPTS_PER_INSTALLATION) {
        const oldestTerminal = receipts.filter(item => item.state === 'accepted' || item.state === 'failed')
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
        // Never evict active or uncertain claims to make room for a new send.
        if (!oldestTerminal) return { changed: false, result: null };
        state.receipts.splice(state.receipts.indexOf(oldestTerminal), 1);
      }
      const at = isoAt(this.now());
      const claimId = randomUUID();
      state.receipts.push({ installationId: id, eventKey: key, claimId, state: 'sending', createdAt: at, updatedAt: at });
      return { changed: true, result: claimId };
    });
  }

  // Only the successful claim owner may call this, once, after confirming the
  // sender was never invoked. Never use it to recover an interrupted delivery.
  async releaseUnsent(installationId, eventKey, claimId) {
    const id = normalizeUuid(installationId);
    const key = normalizeEventKey(eventKey);
    const owner = normalizeUuid(claimId);
    return await this.#mutate(state => {
      const index = state.receipts.findIndex(item => item.installationId === id
        && item.eventKey === key && item.claimId === owner && item.state === 'sending');
      if (index < 0) return { changed: false, result: false };
      state.receipts.splice(index, 1);
      return { changed: true, result: true };
    });
  }

  async settle(installationId, eventKey, { claimId, state: nextState, code } = {}) {
    const id = normalizeUuid(installationId);
    const key = normalizeEventKey(eventKey);
    if (!SETTLED_STATES.has(nextState)) throw inputError('Invalid mobile push receipt state');
    const safeCode = normalizeCode(code);
    const owner = normalizeUuid(claimId);
    return await this.#mutate(state => {
      const receipt = state.receipts.find(item => item.installationId === id && item.eventKey === key && item.claimId === owner);
      if (!receipt) return { changed: false, result: null };
      if (receipt.state === 'accepted' || receipt.state === 'failed') {
        return { changed: false, result: receipt };
      }
      receipt.state = nextState;
      receipt.updatedAt = isoAt(this.now());
      if (safeCode !== undefined) receipt.code = safeCode;
      else delete receipt.code;
      return { changed: true, result: receipt };
    });
  }

  #enqueue(operation) {
    const pending = this.#operations.then(async () => {
      await this.#ensureInitialized();
      return await operation();
    });
    // Deliver each error to its caller without poisoning future operations.
    this.#operations = pending.catch(() => {});
    return pending;
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      const candidate = structuredClone(this.#state);
      const { changed, result } = operation(candidate);
      if (changed) {
        candidate.updatedAt = isoAt(this.now());
        await this.#persist(candidate);
        this.#state = candidate;
      }
      return structuredClone(result);
    });
  }

  async #ensureInitialized() {
    if (this.#state) return;
    if (!this.#initialized) this.#initialized = this.#load();
    try {
      await this.#initialized;
    } catch (error) {
      this.#initialized = null;
      throw error;
    }
  }

  async #load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = { schemaVersion: SCHEMA_VERSION, installations: [], receipts: [] };
      return;
    }
    try {
      this.#state = normalizePersistedState(JSON.parse(raw));
    } catch {
      // JSON parse messages can quote private file contents; do not propagate.
      throw Object.assign(new Error('Mobile push store is invalid; restore its persisted state before sending'), {
        code: 'MOBILE_PUSH_STORE_INVALID', statusCode: 503
      });
    }
  }

  async #persist(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporaryPath, this.filePath);
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
        }
      }
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

function normalizePersistedState(parsed) {
  if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.installations) || !Array.isArray(parsed.receipts)) {
    throw new Error('Invalid schema');
  }
  const ids = new Set();
  const installations = parsed.installations.map(item => {
    const id = normalizeUuid(item?.id);
    if (ids.has(id) || typeof item.enabled !== 'boolean') throw new Error('Invalid installation');
    ids.add(id);
    const threadIds = normalizeThreads(item.threadIds);
    const baselineTurns = normalizeBaselines(item.baselineTurns ?? {}, threadIds);
    return { id, token: normalizeToken(item.token), threadIds, enabled: item.enabled,
      instanceId: item.instanceId === undefined ? id : normalizeUuid(item.instanceId),
      baselineTurns: Object.fromEntries(threadIds.map(threadId => [threadId, baselineTurns[threadId] ?? []])),
      createdAt: persistedTime(item.createdAt), updatedAt: persistedTime(item.updatedAt) };
  });
  const receiptKeys = new Map();
  const receipts = parsed.receipts.map(item => {
    const installationId = normalizeUuid(item?.installationId);
    const eventKey = normalizeEventKey(item.eventKey);
    if (!ids.has(installationId) || !RECEIPT_STATES.has(item.state)) throw new Error('Invalid receipt');
    const keys = receiptKeys.get(installationId) ?? new Set();
    if (keys.has(eventKey) || keys.size >= MAX_RECEIPTS_PER_INSTALLATION) throw new Error('Invalid receipts');
    keys.add(eventKey);
    receiptKeys.set(installationId, keys);
    const receipt = { installationId, eventKey, state: item.state,
      createdAt: persistedTime(item.createdAt), updatedAt: persistedTime(item.updatedAt) };
    // Older receipts have no owner. They remain consumed, and no caller can
    // release or settle them by accidentally matching an absent claim ID.
    if (item.claimId !== undefined) receipt.claimId = normalizeUuid(item.claimId);
    const code = normalizeCode(item.code);
    if (code !== undefined) receipt.code = code;
    return receipt;
  });
  return { schemaVersion: SCHEMA_VERSION, installations, receipts };
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw inputError('Mobile push identifiers must be UUIDs');
  return value.toLowerCase();
}

function normalizeToken(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 8192 || CONTROLS.test(token)) {
    throw inputError('Invalid mobile push token');
  }
  return token;
}

function normalizeThreads(threadIds) {
  if (!Array.isArray(threadIds)) throw inputError('Mobile push thread watches must be an array');
  const ids = [...new Set(threadIds.map(normalizeUuid))];
  if (ids.length > 100) throw inputError('Mobile push thread watches exceed the limit');
  return ids;
}

function normalizeEventKey(eventKey) {
  if (typeof eventKey !== 'string' || !eventKey.trim() || eventKey.length > 512 || CONTROLS.test(eventKey)) {
    throw inputError('Invalid mobile push event key');
  }
  return eventKey;
}

function normalizeBaselines(value, threadIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('Invalid mobile push baseline turns');
  const watched = new Set(threadIds);
  const normalized = {};
  for (const [rawThreadId, turnIds] of Object.entries(value)) {
    const threadId = normalizeUuid(rawThreadId);
    if (!watched.has(threadId)) throw inputError('Invalid mobile push baseline turns');
    const legacyOrArray = typeof turnIds === 'string' ? (turnIds === '' ? [] : [turnIds]) : turnIds;
    if (!Array.isArray(legacyOrArray)) throw inputError('Invalid mobile push baseline turns');
    const ids = [...new Set(legacyOrArray.map(normalizeUuid))];
    if (ids.length > MAX_BASELINE_TURNS_PER_THREAD) throw inputError('Mobile push baseline turns exceed the limit');
    normalized[threadId] = ids;
  }
  return normalized;
}

function normalizeCode(code) {
  if (code === undefined) return undefined;
  if (typeof code !== 'string' || !/^[A-Z0-9_.-]{1,64}$/.test(code)) throw inputError('Invalid mobile push result code');
  return code;
}

function persistedTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp');
  return value;
}

function isoAt(now) {
  return new Date(Number(now)).toISOString();
}

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
