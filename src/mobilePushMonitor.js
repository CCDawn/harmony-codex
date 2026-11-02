import { createHash } from 'node:crypto';

const REQUEST_TYPES = new Map([
  ['desktop/asyncUserInput', 'user_input_required'],
  ['item/tool/requestUserInput', 'user_input_required'],
  ['item/commandExecution/requestApproval', 'approval_required'],
  ['item/fileChange/requestApproval', 'approval_required'],
  ['item/permissions/requestApproval', 'approval_required']
]);
const PROVIDER_CODES = new Set([
  'HUAWEI_PUSH_ACCOUNT_INVALID', 'HUAWEI_PUSH_CONFIG_INVALID', 'HUAWEI_PUSH_INPUT_INVALID',
  'HUAWEI_PUSH_AUTH_INVALID', 'HUAWEI_PUSH_TRANSPORT_UNCERTAIN', 'HUAWEI_PUSH_RESPONSE_INVALID',
  '80200005', '80300002', '80300007'
]);

// Registrations, rather than connected phone streams, own these read-only
// observations. Receipts live in the store; this object retains no event log.
export class MobilePushMonitor {
  #store;
  #sender;
  #readTurn;
  #readRequests;
  #subscribe;
  #logger;
  #intervalMs;
  #timer = null;
  #started = false;
  #closed = false;
  #refreshing = null;
  #refreshAgain = false;
  #threads = new Map();

  constructor({ store, sender, readTurn, readRequests, subscribe, intervalMs = 15_000,
    now = () => Date.now(), logger = null } = {}) {
    if (!store || !['list', 'claim', 'settle', 'releaseUnsent'].every(name => typeof store[name] === 'function')
      || typeof sender?.send !== 'function' || typeof readTurn !== 'function'
      || typeof readRequests !== 'function' || typeof subscribe !== 'function'
      || typeof now !== 'function' || !Number.isInteger(intervalMs)
      || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new TypeError('Invalid mobile push monitor configuration');
    }
    this.#store = store;
    this.#sender = sender;
    this.#readTurn = readTurn;
    this.#readRequests = readRequests;
    this.#subscribe = subscribe;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
  }

  async start() {
    if (this.#closed) return;
    if (!this.#started) {
      this.#started = true;
      this.#timer = setInterval(() => { void this.refresh(); }, this.#intervalMs);
      this.#timer.unref?.();
    }
    await this.refresh();
  }

  async refresh() {
    if (this.#closed || !this.#started) return;
    // Serialize registration snapshots, but never block a registration refresh
    // behind a slow desktop read or provider response.
    this.#refreshAgain = true;
    if (!this.#refreshing) {
      this.#refreshing = Promise.resolve().then(async () => {
        let refreshed = false;
        do {
          this.#refreshAgain = false;
          refreshed = await this.#refreshSubscriptions() || refreshed;
        } while (this.#refreshAgain && !this.#closed);
        return refreshed;
      }).finally(() => { this.#refreshing = null; });
    }
    const refreshed = await this.#refreshing;
    // A call arriving as the shared promise settles still needs a fresh read.
    if (this.#refreshAgain && !this.#closed) { await this.refresh(); return; }
    if (refreshed && !this.#closed) {
      await Promise.all([...this.#threads.keys()].map(threadId => this.reconcile(threadId)));
    }
  }

  reconcile(threadId) {
    const state = this.#threads.get(threadId);
    if (!state || !this.#current(state)) return Promise.resolve();
    state.dirty = true;
    if (state.pending) return state.pending;
    // A microtask also coalesces synchronous native notification bursts. During
    // an observation only a single dirty bit is retained for a trailing read.
    state.pending = Promise.resolve().then(async () => {
      while (state.dirty && this.#current(state)) {
        state.dirty = false;
        await this.#observe(state);
      }
    }).catch(() => { this.#log('MOBILE_PUSH_RECONCILE_FAILED'); }).finally(() => {
      state.pending = null;
      if (state.dirty && this.#current(state)) void this.reconcile(threadId);
    });
    return state.pending;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    const states = [...this.#threads.values()];
    this.#threads.clear();
    for (const state of states) this.#stop(state);
  }

  #current(state) {
    return !this.#closed && this.#threads.get(state.threadId) === state;
  }

  async #refreshSubscriptions() {
    const registrations = await this.#list();
    if (!registrations || this.#closed) return false;
    const wanted = new Set(registrations.filter(item => item.enabled === true)
      .flatMap(item => Array.isArray(item.threadIds) ? item.threadIds : []));
    for (const [threadId, state] of this.#threads) {
      if (!wanted.has(threadId)) {
        this.#threads.delete(threadId);
        this.#stop(state);
      }
    }
    for (const threadId of wanted) {
      let state = this.#threads.get(threadId);
      if (!state) {
        state = { threadId, subscription: null, pending: null, dirty: false };
        this.#threads.set(threadId, state);
      }
      if (state.subscription) continue;
      try {
        state.subscription = this.#subscribe(threadId, () => {
          if (!this.#current(state)) return;
          void this.reconcile(threadId);
        });
        if (typeof state.subscription?.stop !== 'function') {
          state.subscription = null;
          this.#log('MOBILE_PUSH_SUBSCRIBE_FAILED');
        }
      } catch {
        this.#log('MOBILE_PUSH_SUBSCRIBE_FAILED');
      }
    }
    return true;
  }

  #stop(state) {
    try { state.subscription?.stop(); }
    catch { this.#log('MOBILE_PUSH_UNSUBSCRIBE_FAILED'); }
  }

  async #list() {
    try {
      const registrations = await this.#store.list();
      if (!Array.isArray(registrations)) throw new TypeError();
      return registrations;
    } catch {
      this.#log('MOBILE_PUSH_REGISTRATIONS_READ_FAILED');
      return null;
    }
  }

  async #observe(state) {
    const registrations = await this.#list();
    if (!registrations || !this.#current(state)) return;
    const recipients = registrations.filter(item => watches(item, state.threadId));
    if (!recipients.length) return;
    let snapshot;
    try { snapshot = await this.#readTurn(state.threadId); }
    catch { this.#log('MOBILE_PUSH_TURN_READ_FAILED'); return; }
    if (!this.#current(state)) return;
    const turns = (Array.isArray(snapshot) ? snapshot : [snapshot])
      .filter(turn => typeof turn?.id === 'string' && turn.id.trim());
    // A recent metadata snapshot preserves X's terminal fact when Y has already
    // started before this read. Native event payloads are triggers, not facts.
    const terminals = new Map();
    for (const turn of turns) {
      if (turn.status !== 'completed' && turn.status !== 'failed') continue;
      const event = makeEvent(state.threadId, turn.id, turn.status);
      terminals.set(event.eventId, event);
    }
    await this.#notify(state, recipients, terminals.values());
    if (!this.#current(state)) return;
    const active = new Map(turns.filter(turn => turn.status === 'inProgress').map(turn => [turn.id, turn]));
    if (active.size !== 1) return;
    const turn = active.values().next().value;
    let requests;
    try {
      requests = await this.#readRequests(state.threadId);
      if (!Array.isArray(requests)) throw new TypeError();
    } catch { this.#log('MOBILE_PUSH_REQUESTS_READ_FAILED'); return; }
    if (!this.#current(state)) return;
    // Requests are the raw DesktopInteractionClient snapshot. Random HTTP
    // tickets, question text and renderer-generation fields are not identity.
    const events = [];
    const seen = new Set();
    for (const request of requests) {
      const type = REQUEST_TYPES.get(request?.method);
      if (!type || request.completed === true || !validRequestId(request.id)
        || request.params?.threadId !== state.threadId || request.params?.turnId !== turn.id) continue;
      const event = makeEvent(state.threadId, turn.id, type, request.id);
      if (!seen.has(event.eventId)) { seen.add(event.eventId); events.push(event); }
    }
    await this.#notify(state, recipients, events);
  }

  async #notify(state, recipients, events) {
    for (const event of events) {
      for (const recipient of recipients) {
        if (!this.#current(state)) return;
        if (['completed', 'failed'].includes(event.type)
          && baselineTurns(recipient, state.threadId).includes(event.turnId)) continue;
        await this.#deliver(state, recipient, event);
      }
    }
  }

  async #registered(state, recipient) {
    if (!this.#current(state)) return false;
    const registrations = await this.#list();
    return this.#current(state) && registrations?.some(item => watches(item, state.threadId)
      && item.id === recipient.id && item.token === recipient.token
      && item.instanceId === recipient.instanceId
      && sameBaselines(item, recipient, state.threadId)
      && item.createdAt === recipient.createdAt);
  }

  async #deliver(state, recipient, event) {
    if (!await this.#registered(state, recipient)) return;
    let claimId;
    try { claimId = await this.#store.claim(recipient.id, event.eventId); }
    catch { this.#log('MOBILE_PUSH_CLAIM_FAILED'); return; }
    if (typeof claimId !== 'string' || !claimId) return;
    // A token/registration mutation can happen while claim is being persisted.
    // The sender has not been called, so this particular sending claim can be
    // released. Once send is invoked, every outcome must retain its receipt.
    if (!await this.#registered(state, recipient)) {
      try { await this.#store.releaseUnsent(recipient.id, event.eventId, claimId); }
      catch { this.#log('MOBILE_PUSH_RELEASE_UNSENT_FAILED'); }
      return;
    }
    let result;
    try {
      const acknowledgement = await this.#sender.send({ token: recipient.token, event });
      result = acknowledgement?.accepted === true ? { state: 'accepted' }
        : { state: 'uncertain', code: 'MOBILE_PUSH_ACK_UNCONFIRMED' };
    } catch (error) {
      const uncertain = error?.deliveryUncertain === true;
      result = { state: uncertain ? 'uncertain' : 'failed', code: PROVIDER_CODES.has(error?.code)
        ? error.code : (uncertain ? 'MOBILE_PUSH_SEND_UNCERTAIN' : 'MOBILE_PUSH_SEND_FAILED') };
    }
    await this.#settle(recipient.id, event.eventId, { ...result, claimId });
  }

  async #settle(id, eventId, result) {
    try { await this.#store.settle(id, eventId, result); }
    catch { this.#log('MOBILE_PUSH_SETTLE_FAILED'); }
  }

  #log(code) {
    // Provider errors can contain tokens and question bodies. Log fixed codes
    // only, and keep diagnostic failures outside the notification lifecycle.
    try { Promise.resolve(this.#logger?.write?.('mobile-push', 'warn', 'mobile.push.monitor.error', { code })).catch(() => {}); }
    catch { /* Logging cannot authorize a resend. */ }
  }
}

function watches(installation, threadId) {
  return installation?.enabled === true && typeof installation.token === 'string'
    && Array.isArray(installation.threadIds) && installation.threadIds.includes(threadId);
}

function validRequestId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id));
}

function baselineTurns(installation, threadId) {
  const value = installation.baselineTurns?.[threadId];
  return Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
}

function sameBaselines(left, right, threadId) {
  const leftTurns = baselineTurns(left, threadId);
  const rightTurns = baselineTurns(right, threadId);
  return leftTurns.length === rightTurns.length && leftTurns.every(id => rightTurns.includes(id));
}

function makeEvent(threadId, turnId, type, ...extra) {
  return { type, threadId, turnId,
    eventId: createHash('sha256').update(JSON.stringify([threadId, turnId, type, ...extra])).digest('hex') };
}
