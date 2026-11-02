import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/taskStore.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { HybridCodexAdapter } from '../src/hybridCodexAdapter.js';

function createStore(adapter) {
  return new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter, eventBus: { publish() {} } });
}

async function waitForDispatch(store, task) {
  const deadline = Date.now() + 1000;
  while (store.getTask(task.id).interruptDispatching && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.getTask(task.id);
}

test('synthetic interrupt binds an observed active turn and confirms that exact turn', async () => {
  const store = createStore({ async interrupt({ emit }) {
    emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'current' });
    emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'current', status: 'interrupted' });
    return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'current', status: 'interrupted' };
  } });
  const task = store.interruptSessionTask('thread');
  await waitForDispatch(store, task);
  assert.equal(task.activeCodexTurnId, 'current');
  assert.equal(task.status, 'interrupted');
});

test('synthetic interrupt does not claim an already terminal unbound turn and stops reporting running', async () => {
  const store = createStore({ async interrupt({ emit }) {
    emit('codex.app_server.turn.terminal_found_for_interrupt', { threadId: 'thread', turnId: 'old', status: 'interrupted' });
    emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'old', status: 'interrupted', source: 'pre_interrupt_terminal_read' });
    return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'old', status: 'interrupted' };
  } });
  const task = store.interruptSessionTask('thread');
  await waitForDispatch(store, task);
  assert.equal(task.activeCodexTurnId, null);
  assert.equal(task.status, 'recovering');
  assert.equal(task.events.some((event) => event.type === 'task.interrupted'), false);
  assert.equal(store.findRunningTaskForSession('thread'), null);
});

test('synthetic interrupt ignores activity from a different thread', async () => {
  const store = createStore({ async interrupt({ emit }) {
    emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'other', turnId: 'other-turn' });
    return { accepted: true, confirmed: true, threadId: 'other', turnId: 'other-turn', status: 'interrupted' };
  } });
  const task = store.interruptSessionTask('thread');
  await waitForDispatch(store, task);
  assert.equal(task.activeCodexTurnId, null);
  assert.equal(task.status, 'recovering');
});

test('session interrupt carries a desktop observed turn through the real adapter and confirms it', async () => {
  const requests = [];
  let interrupted = false;
  const client = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread: { turns: [{ id: 'current', status: interrupted ? 'interrupted' : 'inProgress' }] } };
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
    throw new Error(`unexpected method ${method}`);
  } };
  const adapter = new CodexDesktopCdpAdapter({ client, interruptConfirmationTimeoutMs: 100 });
  const store = createStore(adapter);
  const task = store.interruptSessionTask('thread');
  await waitForDispatch(store, task);
  assert.equal(task.activeCodexTurnId, 'current');
  assert.equal(task.status, 'interrupted');
  assert.deepEqual(requests.find((request) => request.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'current' });
});


test('repeated session stop uses matching previously confirmed turn and fresh terminal snapshot', async () => {
  let calls = 0;
  const store = createStore({ async interrupt({ emit }) {
    calls += 1;
    if (calls === 1) {
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'current' });
      emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'current', status: 'interrupted' });
    } else {
      emit('codex.app_server.turn.terminal_found_for_interrupt', { threadId: 'thread', turnId: 'current', status: 'interrupted' });
      emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'current', status: 'interrupted', source: 'pre_interrupt_terminal_read' });
    }
    return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'current', status: 'interrupted' };
  } });
  const first = store.interruptSessionTask('thread');
  await waitForDispatch(store, first);
  const second = store.interruptSessionTask('thread');
  await waitForDispatch(store, second);
  assert.equal(first.status, 'interrupted');
  assert.equal(second.status, 'interrupted');
  assert.equal(calls, 2);
});

test('an existing successful stop is not reused for a different current terminal turn', async () => {
  let calls = 0;
  const store = createStore({ async interrupt({ emit }) {
    calls += 1;
    if (calls === 1) {
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'old' });
      emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'old', status: 'interrupted' });
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'old', status: 'interrupted' };
    }
    emit('codex.app_server.turn.terminal_found_for_interrupt', { threadId: 'thread', turnId: 'new', status: 'interrupted' });
    return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'new', status: 'interrupted' };
  } });
  const first = store.interruptSessionTask('thread');
  await waitForDispatch(store, first);
  const second = store.interruptSessionTask('thread');
  await waitForDispatch(store, second);
  assert.equal(first.status, 'interrupted');
  assert.equal(second.status, 'recovering');
});

test('interrupt terminal from another thread does not confirm a bound turn', async () => {
  const store = createStore({ async interrupt({ emit }) {
    emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'current' });
    emit('codex.app_server.turn.interrupted', { threadId: 'other', turnId: 'current', status: 'interrupted' });
    return { accepted: true, confirmed: true, threadId: 'other', turnId: 'current', status: 'interrupted' };
  } });
  const task = store.interruptSessionTask('thread');
  await waitForDispatch(store, task);
  assert.equal(task.status, 'recovering');
  assert.equal(task.events.some((event) => event.type === 'task.interrupted'), false);
});

test('repeated session stop targets a new active turn rather than reusing the old success', async () => {
  let calls = 0;
  const store = createStore({ async interrupt({ emit }) {
    calls += 1;
    const turnId = calls === 1 ? 'old' : 'new';
    emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId });
    emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId, status: 'interrupted' });
    return { accepted: true, confirmed: true, threadId: 'thread', turnId, status: 'interrupted' };
  } });
  const first = store.interruptSessionTask('thread');
  await waitForDispatch(store, first);
  const second = store.interruptSessionTask('thread');
  await waitForDispatch(store, second);
  assert.equal(second.activeCodexTurnId, 'new');
  assert.equal(second.status, 'interrupted');
  assert.equal(calls, 2);
});

test('repeating an interrupted task id returns the same task without interrupting a newer turn', async () => {
  const calls = [];
  const store = createStore({
    async interrupt({ task, emit }) {
      calls.push(task.id);
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'old' });
      emit('codex.app_server.turn.interrupted', { threadId: 'thread', turnId: 'old', status: 'interrupted' });
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'old', status: 'interrupted' };
    },
    async run({ emit }) {
      emit('codex.app_server.turn.started', { turn: { id: 'new', status: 'inProgress' } });
      return await new Promise(() => {});
    }
  });
  const first = store.interruptSessionTask('thread');
  await waitForDispatch(store, first);
  const newer = store.createTask({ projectId: 'p', prompt: 'new turn', codexSessionId: 'thread' });
  assert.equal(newer.activeCodexTurnId, 'new');
  const repeated = store.interruptTask(first.id);
  assert.equal(repeated, first);
  assert.equal(repeated.status, 'interrupted');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [first.id]);
  assert.equal(newer.status, 'running');
  assert.equal(newer.interruptRequested, false);
});

test('thread stop targets official current turn without rebinding an older task', async () => {
  const requests = [];
  let interrupted = false;
  const client = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread: { turns: [{ id: 'new', status: interrupted ? 'interrupted' : 'inProgress' }] } };
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
    throw new Error(`unexpected method ${method}`);
  } };
  const adapter = new CodexDesktopCdpAdapter({ client, interruptConfirmationTimeoutMs: 100 });
  adapter.run = async ({ emit }) => { emit('codex.app_server.turn.started', { turn: { id: 'old' } }); return await new Promise(() => {}); };
  const store = createStore(adapter);
  const old = store.createTask({ projectId: 'p', prompt: 'old', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForDispatch(store, stop);
  assert.notEqual(stop.id, old.id);
  assert.deepEqual(requests.find((entry) => entry.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'new' });
  assert.equal(stop.status, 'interrupted');
  assert.equal(old.activeCodexTurnId, 'old');
  assert.equal(old.status, 'running');
});

test('task stop never switches to a newer turn in the same thread', async () => {
  const requests = [];
  const client = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'turn/interrupt') throw new Error('turn is no longer active');
    if (method === 'thread/read') return { thread: { turns: [{ id: 'new', status: 'inProgress' }] } };
  } };
  const adapter = new CodexDesktopCdpAdapter({ client });
  await assert.rejects(adapter.interrupt({ task: { id: 'task', codexSessionId: 'thread', activeCodexTurnId: 'old' }, interruptScope: 'task', emit() {} }));
  assert.deepEqual(requests[0], { method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'old' } });
  assert.equal(requests.some((entry) => entry.method === 'turn/interrupt' && entry.params.turnId === 'new'), false);
});

test('thread stop awaits a pending start before selecting the official current turn', async () => {
  const requests = [];
  let release;
  let interrupted = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread: { turns: [{ id: 'new', status: interrupted ? 'interrupted' : 'inProgress' }] } };
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
  } };
  const adapter = new CodexDesktopCdpAdapter({ client, interruptConfirmationTimeoutMs: 100 });
  adapter.pendingTurnStarts.set('owner', pending);
  const stop = adapter.interrupt({ task: { id: 'synthetic', codexSessionId: 'thread' }, interruptScope: 'thread', pendingTaskId: 'owner', emit() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(requests, []);
  release('old');
  await stop;
  assert.deepEqual(requests.find((entry) => entry.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'new' });
});

test('a pending thread interrupt prevents steering the existing task and ignores synthetic tasks', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const store = createStore({
    async run({ emit }) { emit('codex.app_server.turn.started', { turn: { id: 'old' } }); return await new Promise(() => {}); },
    async interrupt() { await pending; return { accepted: false }; },
    async steer() { throw new Error('steer must not run'); }
  });
  const old = store.createTask({ projectId: 'p', prompt: 'old', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  assert.notEqual(stop.id, old.id);
  assert.equal(store.findRunningTaskForSession('thread'), null);
  assert.equal(store.canSteerSessionTask('thread'), false);
  await assert.rejects(store.steerSessionTask('thread', { prompt: 'new' }), { code: 'CODEX_INTERRUPT_PENDING' });
  assert.throws(() => store.createTask({ projectId: 'p', prompt: 'new', codexSessionId: 'thread' }), { code: 'CODEX_INTERRUPT_PENDING' });
  release();
  await waitForDispatch(store, stop);
  assert.notEqual(store.findRunningTaskForSession('thread')?.id, stop.id);
  assert.equal(stop.status, 'failed');
  assert.equal(store.canSteerSessionTask('thread'), false);
});

test('a task-scoped stop with no acknowledged turn does not select another active turn', async () => {
  const requests = [];
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method, params) { requests.push({ method, params }); return {}; } } });
  await assert.rejects(adapter.interrupt({ task: { id: 'task', codexSessionId: 'thread' }, interruptScope: 'task', emit() {} }), /尚未|还未/);
  assert.deepEqual(requests, []);
});

test('concurrent thread stops share one in-flight operation', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const store = createStore({ async interrupt() { calls += 1; await pending; return { accepted: false }; } });
  const first = store.interruptSessionTask('thread');
  const second = store.interruptSessionTask('thread');
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  release();
  await waitForDispatch(store, first);
});

test('user stop while preparing prevents the first turn write', async () => {
  let release;
  let stopRequested = false;
  let starts = 0;
  const preparing = new Promise((resolve) => { release = resolve; });
  const adapter = new CodexDesktopCdpAdapter({ client: {} });
  adapter.prepareExistingThread = async () => { await preparing; return { thread: { id: 'thread' }, resumed: false }; };
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.startTurn = async () => { starts += 1; throw new Error('turn/start was not allowed'); };
  const run = adapter.run({ task: { id: 'task', codexSessionId: 'thread', prompt: 'p' }, project: {}, emit() {}, shouldStop: () => stopRequested });
  stopRequested = true;
  release();
  await assert.rejects(run, { code: 'CODEX_USER_STOP_REQUESTED' });
  assert.equal(starts, 0);
});

test('user stop after an interrupted write prevents compaction retry', async () => {
  let stopRequested = false;
  let starts = 0;
  const adapter = new CodexDesktopCdpAdapter({ client: {}, promptMissingRetryCount: 2, promptMissingRetryDelayMs: 0 });
  adapter.prepareExistingThread = async () => ({ thread: { id: 'thread' }, resumed: false });
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.startTurn = async () => ({ turn: { id: `turn-${++starts}` } });
  adapter.waitForDesktopTurnCompletion = async () => {
    stopRequested = true;
    const error = new Error('prompt missing after interrupted turn');
    error.code = 'CODEX_PHONE_MESSAGE_NOT_PERSISTED';
    throw error;
  };
  adapter.waitForPostSubmitCompactionToSettle = async () => {};
  await assert.rejects(adapter.run({ task: { id: 'task', codexSessionId: 'thread', prompt: 'p' }, project: {}, emit() {}, shouldStop: () => stopRequested }), { code: 'CODEX_USER_STOP_REQUESTED' });
  assert.equal(starts, 1);
});

test('unacknowledged interrupt stays recoverable until official matching terminal evidence', async () => {
  const records = new Map();
  const writes = [];
  const journal = {
    async load() { return [...records.values()]; },
    async put(record) { writes.push(record.state); records.set(record.operationId, { ...record }); },
    async remove(id) { records.delete(id); }
  };
  let state = 'unknown';
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) {
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn', status: 'inProgress' }] } };
    if (method === 'turn/interrupt') throw new Error('transport timeout');
  } } });
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter, eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => state === 'unknown' ? { status: 'unknown' } : { status: 'interrupted', threadId: 'thread', turnId: 'turn' } });
  const stop = store.interruptSessionTask('thread');
  await store.waitForInterruptPersistence(stop.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(writes, ['requested', 'writing']);
  assert.equal(stop.status, 'recovering');
  assert.equal(store.isSessionInterruptPending('thread'), true);
  assert.equal(records.get(stop.id)?.turnId, 'turn');
  state = 'interrupted';
  await store.reconcileSyntheticInterrupt(stop.id);
  assert.equal(stop.status, 'interrupted');
  assert.equal(store.isSessionInterruptPending('thread'), false);
  assert.equal(records.has(stop.id), false);
});

test('restore establishes barrier and checks matching turn before release', async () => {
  const record = { operationId: 'op', threadId: 'thread', turnId: 'turn', requestedAt: new Date().toISOString(), state: 'writing' };
  const records = new Map([[record.operationId, record]]);
  const journal = { async load() { return [...records.values()]; }, async put(r) { records.set(r.operationId, r); }, async remove(id) { records.delete(id); } };
  let reconcileStatus = 'unknown';
  let reads = 0;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter: {}, eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async ({ threadId, activeTurnId }) => { reads += 1; assert.equal(threadId, 'thread'); assert.equal(activeTurnId, 'turn');
      return reconcileStatus === 'unknown' ? { status: 'unknown' } : { status: 'interrupted', threadId, turnId: activeTurnId }; } });
  await store.restorePendingInterrupts();
  assert.equal(reads, 1);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  assert.equal(store.getTask('op').status, 'recovering');
  reconcileStatus = 'interrupted';
  await store.reconcileSyntheticInterrupt('op');
  assert.equal(store.isSessionInterruptPending('thread'), false);
  assert.equal(records.size, 0);
});

test('confirmed stop settles only matching original task and removes stale tasks from steer selection', async () => {
  const adapter = {
    async run({ task, emit }) { emit('codex.app_server.turn.started', { turn: { id: task.prompt } }); return await new Promise(() => {}); },
    async interrupt({ emit }) { emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'same' });
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'same', status: 'interrupted' }; },
    async steer() { throw new Error('must not steer stale task'); }
  };
  const store = createStore(adapter);
  const same = store.createTask({ projectId: 'p', prompt: 'same', codexSessionId: 'thread' });
  const different = store.createTask({ projectId: 'p', prompt: 'other', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForDispatch(store, stop);
  assert.equal(stop.status, 'interrupted');
  assert.equal(same.status, 'interrupted');
  assert.equal(different.status, 'running');
  assert.equal(store.findRunningTaskForSession('thread'), null);
  assert.equal(store.canSteerSessionTask('thread'), false);
});

test('journal failure before dispatch never sends an interrupt', async () => {
  let calls = 0;
  const journal = { async load() { return []; }, async put() { throw new Error('disk failed'); }, async remove() {} };
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    adapter: { async interrupt() { calls += 1; } } });
  const stop = store.interruptSessionTask('thread');
  await assert.rejects(store.waitForInterruptPersistence(stop.id), /disk failed/);
  await waitForDispatch(store, stop);
  assert.equal(calls, 0);
  assert.equal(stop.status, 'failed');
});

test('restore of requested stop with no turn releases only on official idle evidence', async () => {
  const records = new Map([['op', { operationId: 'op', threadId: 'thread', turnId: '', requestedAt: new Date().toISOString(), state: 'requested' }]]);
  const journal = { async load() { return [...records.values()]; }, async remove(id) { records.delete(id); } };
  let idle = false;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter: {}, eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => idle ? { status: 'idle', reason: 'official_no_active_turn', threadId: 'thread' } : { status: 'running', threadId: 'thread' } });
  await store.restorePendingInterrupts();
  assert.equal(store.isSessionInterruptPending('thread'), true);
  idle = true;
  await store.reconcileSyntheticInterrupt('op');
  assert.equal(store.isSessionInterruptPending('thread'), false);
  assert.equal(records.size, 0);
});

test('a stop triggered during delivery-intent publication prevents the turn write', async () => {
  let stopped = false;
  let starts = 0;
  const adapter = new CodexDesktopCdpAdapter({ client: {} });
  adapter.prepareExistingThread = async () => ({ thread: { id: 'thread' }, resumed: false });
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.startTurn = async () => { starts += 1; };
  await assert.rejects(adapter.run({ task: { id: 'task', codexSessionId: 'thread', prompt: 'p' }, project: {},
    emit(type) { if (type === 'codex.delivery.attempted') stopped = true; }, shouldStop: () => stopped }),
    (error) => error.code === 'CODEX_USER_STOP_REQUESTED' && error.deliveryAttempted === false && error.safeToFallback === false);
  assert.equal(starts, 0);
});

test('journal failure when recording the target turn prevents the official interrupt write', async () => {
  let writes = 0;
  const journal = { async load() { return []; }, async put(record) { if (record.state === 'writing') throw new Error('disk failed'); }, async remove() {} };
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) {
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn', status: 'inProgress' }] } };
    if (method === 'turn/interrupt') writes += 1;
  } } });
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter, eventBus: { publish() {} }, interruptJournal: journal });
  const stop = store.interruptSessionTask('thread');
  await waitForDispatch(store, stop);
  assert.equal(writes, 0);
  assert.equal(stop.status, 'failed');
});

test('a confirmed response with running status cannot settle a written stop', async () => {
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} },
    interruptReconciler: async () => ({ status: 'unknown' }),
    adapter: { async interrupt({ emit, beforeInterruptWrite }) {
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'turn' });
      await beforeInterruptWrite({ threadId: 'thread', turnId: 'turn' });
      return { accepted: true, confirmed: true, status: 'running', threadId: 'thread', turnId: 'turn' };
    } } });
  const stop = store.interruptSessionTask('thread');
  await waitForDispatch(store, stop);
  assert.equal(stop.status, 'recovering');
  assert.equal(store.isSessionInterruptPending('thread'), true);
  assert.equal(stop.events.some(event => event.type === 'task.completed'), false);
});

test('matching official failed turn remains failed on the original task', async () => {
  const store = createStore({
    async run({ emit }) { emit('codex.app_server.turn.started', { turn: { id: 'turn' } }); return await new Promise(() => {}); },
    async interrupt({ emit }) { emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'turn' });
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'turn', status: 'failed' }; }
  });
  const task = store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForDispatch(store, stop);
  assert.equal(stop.status, 'completed');
  assert.equal(task.status, 'failed');
  assert.equal(task.events.some(event => event.type === 'task.completed'), false);
});

async function waitForStatus(task, status) {
  const deadline = Date.now() + 1000;
  while (task.status !== status && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(task.status, status);
}

test('a second user stop retries the same active turn after an unacknowledged write', async () => {
  const calls = [];
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} },
    interruptReconciler: async ({ reason }) => reason === 'user_retry'
      ? { status: 'running', threadId: 'thread', turnId: 'turn' } : { status: 'unknown' },
    adapter: { async interrupt({ emit, beforeInterruptWrite, interruptScope, task }) {
      const turnId = 'turn';
      calls.push({ interruptScope, turnId: task.activeCodexTurnId || turnId });
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId });
      await beforeInterruptWrite({ threadId: 'thread', turnId });
      if (calls.length === 1) throw new Error('response lost');
      return { accepted: true, confirmed: true, threadId: 'thread', turnId, status: 'interrupted' };
    } } });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  assert.equal(store.interruptSessionTask('thread'), stop);
  await waitForStatus(stop, 'interrupted');
  assert.deepEqual(calls, [{ interruptScope: 'thread', turnId: 'turn' }, { interruptScope: 'task', turnId: 'turn' }]);
  store.close();
});

test('user retry observes old turn terminal before targeting the current new turn', async () => {
  const calls = [];
  let original;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} },
    interruptReconciler: async ({ reason }) => reason === 'user_retry'
      ? { status: 'interrupted', threadId: 'thread', turnId: 'old' } : { status: 'unknown' },
    adapter: {
      async run({ emit }) { emit('codex.app_server.turn.started', { turn: { id: 'old' } }); return await new Promise(() => {}); },
      async interrupt({ emit, beforeInterruptWrite, interruptScope }) {
        const turnId = calls.length ? 'new' : 'old';
        if (calls.length) assert.equal(original.status, 'interrupted');
        calls.push({ interruptScope, turnId });
        emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId });
        await beforeInterruptWrite({ threadId: 'thread', turnId });
        if (calls.length === 1) throw new Error('response lost');
        return { accepted: true, confirmed: true, threadId: 'thread', turnId, status: 'interrupted' };
      }
    } });
  original = store.createTask({ projectId: 'p', prompt: 'old input', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  store.interruptSessionTask('thread');
  await waitForStatus(stop, 'interrupted');
  assert.deepEqual(calls, [{ interruptScope: 'thread', turnId: 'old' }, { interruptScope: 'thread', turnId: 'new' }]);
  store.close();
});

test('concurrent user retries share one official read and one repeat write', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let retryReads = 0;
  let writes = 0;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} },
    interruptReconciler: async ({ reason }) => { if (reason !== 'user_retry') return { status: 'unknown' };
      retryReads += 1; await gate; return { status: 'running', threadId: 'thread', turnId: 'turn' }; },
    adapter: { async interrupt({ emit, beforeInterruptWrite }) {
      writes += 1; emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'turn' });
      await beforeInterruptWrite({ threadId: 'thread', turnId: 'turn' });
      if (writes === 1) throw new Error('response lost');
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'turn', status: 'interrupted' };
    } } });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  assert.equal(store.interruptSessionTask('thread'), stop);
  assert.equal(store.interruptSessionTask('thread'), stop);
  release();
  await waitForStatus(stop, 'interrupted');
  assert.equal(retryReads, 1);
  assert.equal(writes, 2);
  store.close();
});

test('a retry arriving during journal settlement is preserved and targets the current turn', async () => {
  const records = new Map();
  let releaseRemove;
  let onRemove;
  const removeStarted = new Promise(resolve => { onRemove = resolve; });
  const removeGate = new Promise(resolve => { releaseRemove = resolve; });
  let removals = 0;
  const journal = { async load() { return [...records.values()]; }, async put(record) { records.set(record.operationId, { ...record }); },
    async remove(id) { removals += 1; if (removals === 1) { onRemove(); await removeGate; } records.delete(id); } };
  let writes = 0;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async ({ reason }) => ['manual_test', 'user_retry'].includes(reason)
      ? { status: 'interrupted', threadId: 'thread', turnId: 'old' } : { status: 'unknown' },
    adapter: { async interrupt({ emit, beforeInterruptWrite, interruptScope }) {
      writes += 1; const turnId = writes === 1 ? 'old' : 'new';
      if (writes === 2) assert.equal(interruptScope, 'thread');
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId });
      await beforeInterruptWrite({ threadId: 'thread', turnId });
      if (writes === 1) throw new Error('response lost');
      return { accepted: true, confirmed: true, status: 'interrupted', threadId: 'thread', turnId };
    } } });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  const settling = store.reconcileSyntheticInterrupt(stop.id, { reason: 'manual_test' });
  await removeStarted;
  assert.equal(store.interruptSessionTask('thread'), stop);
  const durableRetry = store.waitForInterruptPersistence(stop.id);
  releaseRemove();
  await settling;
  await durableRetry;
  await waitForStatus(stop, 'interrupted');
  assert.equal(writes, 2);
  assert.equal(stop.activeCodexTurnId, 'new');
  assert.equal(records.size, 0);
  store.close();
});

test('stop before first turn and official idle does not report a false stop failure', async () => {
  let release;
  const prepareGate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) {
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 'previous', status: 'completed' }] } };
    if (method === 'turn/interrupt') writes += 1;
  } } });
  adapter.prepareExistingThread = async () => { await prepareGate; return { thread: { id: 'thread' }, resumed: false }; };
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.startTurn = async () => { writes += 1; throw new Error('unexpected turn/start'); };
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, adapter,
    interruptReconciler: async () => ({ status: 'idle', threadId: 'thread', reason: 'official_no_active_turn' }) });
  const original = store.createTask({ projectId: 'p', prompt: 'x', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  release();
  await waitForStatus(stop, 'completed');
  assert.equal(original.status, 'interrupted');
  assert.equal(stop.activeCodexTurnId, null);
  assert.equal(writes, 0);
  assert.equal(store.isSessionInterruptPending('thread'), false);
  store.close();
});

test('a steer delayed by Hybrid probing does not write after a session stop', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const cdp = new CodexDesktopCdpAdapter({ client: { async request(method, params) { writes.push({ method, params }); return { turnId: 'turn' }; } } });
  const hybrid = new HybridCodexAdapter({ desktopAdapter: cdp });
  hybrid.run = async ({ emit }) => { emit('codex.app_server.turn.started', { turn: { id: 'turn' } }); return await new Promise(() => {}); };
  hybrid.interrupt = async () => ({ accepted: false });
  hybrid.getDesktopLiveStatus = async () => { await gate; return { desktopLive: true, targetVerified: true,
    targetSessionId: 'thread', status: 'target_ready', transport: 'cdp' }; };
  const store = createStore(hybrid);
  store.createTask({ projectId: 'p', prompt: 'old', codexSessionId: 'thread' });
  const steering = store.steerSessionTask('thread', { prompt: 'next' });
  const stop = store.interruptSessionTask('thread');
  release();
  await assert.rejects(steering, error => error.code === 'CODEX_USER_STOP_REQUESTED' && error.safeToFallback !== true);
  await waitForDispatch(store, stop);
  assert.equal(writes.some(call => call.method === 'turn/steer'), false);
  store.close();
});

test('a session stop while resolving a steer target prevents its write', async () => {
  let stopped = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) { writes.push(method); return {}; } } });
  adapter.findActiveTurnId = async () => { await gate; return 'turn'; };
  const steering = adapter.steer({ task: { id: 'task', codexSessionId: 'thread' }, prompt: 'next', emit() {}, shouldStop: () => stopped });
  stopped = true;
  release();
  await assert.rejects(steering, { code: 'CODEX_USER_STOP_REQUESTED' });
  assert.deepEqual(writes, []);
});

test('run passes its live stop signal into steer and never falls back to turn/start', async () => {
  let stopped = false;
  let starts = 0;
  const writes = [];
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) { writes.push(method); return {}; } } });
  adapter.prepareExistingThread = async () => ({ thread: { id: 'thread' }, resumed: false, activeTurnId: 'turn' });
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.startTurn = async () => { starts += 1; throw new Error('unexpected turn/start'); };
  adapter.steer = async function(context) { stopped = true; return await CodexDesktopCdpAdapter.prototype.steer.call(this, context); };
  await assert.rejects(adapter.run({ task: { id: 'task', codexSessionId: 'thread', prompt: 'p' }, project: {}, emit() {}, shouldStop: () => stopped }),
    error => error.code === 'CODEX_USER_STOP_REQUESTED' && error.safeToFallback === false);
  assert.equal(starts, 0);
  assert.deepEqual(writes, []);
});

test('an uncertain in-flight start survives idle and restart without releasing the stop barrier', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(record) { records.set(record.operationId, { ...record }); },
    async remove(id) { records.delete(id); } };
  const reconciler = async () => ({ status: 'idle', threadId: 'thread', reason: 'official_no_active_turn' });
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: reconciler, adapter: {
      async run({ task }) { task.turnStartInFlight = true; return await new Promise(() => {}); },
      async interrupt() { return { accepted: true, confirmed: true, status: 'completed', threadId: 'thread', turnId: 'older' }; }
    } });
  store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await store.waitForInterruptPersistence(stop.id);
  await waitForStatus(stop, 'recovering');
  assert.equal(records.get(stop.id).hasUncertainStart, true);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
  const restored = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: reconciler, adapter: {} });
  await restored.restorePendingInterrupts();
  assert.equal(restored.getTask(stop.id).hasUncertainStart, true);
  assert.equal(restored.isSessionInterruptPending('thread'), true);
  assert.equal(records.has(stop.id), true);
  restored.close();
});

test('an unrelated terminal turn cannot release an uncertain start barrier', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(record) { records.set(record.operationId, { ...record }); }, async remove(id) { records.delete(id); } };
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => ({ status: 'interrupted', threadId: 'thread', turnId: 'other' }),
    adapter: { async run({ task }) { task.turnStartInFlight = true; return await new Promise(() => {}); },
      async interrupt({ emit, beforeInterruptWrite }) { emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'other' });
        await beforeInterruptWrite({ threadId: 'thread', turnId: 'other' });
        return { accepted: true, confirmed: true, status: 'interrupted', threadId: 'thread', turnId: 'other' }; } } });
  store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  assert.equal(stop.hasUncertainStart, true);
  assert.equal(records.get(stop.id).hasUncertainStart, true);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
});

test('a definite pending start acknowledgement clears only its own uncertainty', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(record) { records.set(record.operationId, { ...record }); }, async remove(id) { records.delete(id); } };
  let original;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    adapter: { async run({ task }) { task.turnStartInFlight = true; return await new Promise(() => {}); },
      async interrupt({ emit, onPendingStartResolved }) { original.turnStartInFlight = false;
        await onPendingStartResolved({ threadId: 'thread', turnId: 'turn' });
        emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'turn' });
        return { accepted: true, confirmed: true, status: 'interrupted', threadId: 'thread', turnId: 'turn' }; } } });
  original = store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'interrupted');
  assert.equal(stop.hasUncertainStart, false);
  assert.equal(store.isSessionInterruptPending('thread'), false);
  assert.equal(records.size, 0);
  store.close();
});

test('explicit retry may stop the current turn without clearing an earlier uncertain start', async () => {
  const record = { operationId: 'op', threadId: 'thread', turnId: '', requestedAt: new Date().toISOString(), state: 'requested', hasUncertainStart: true };
  const records = new Map([['op', record]]);
  const journal = { async load() { return [...records.values()]; }, async put(value) { records.set(value.operationId, { ...value }); }, async remove(id) { records.delete(id); } };
  let writes = 0;
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => ({ status: 'unknown' }), adapter: { async interrupt({ emit, beforeInterruptWrite, interruptScope }) {
      assert.equal(interruptScope, 'thread'); writes += 1;
      emit('codex.app_server.turn.active_found_for_interrupt', { threadId: 'thread', turnId: 'current' });
      await beforeInterruptWrite({ threadId: 'thread', turnId: 'current' });
      return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'current', status: 'interrupted' };
    } } });
  await store.restorePendingInterrupts();
  const stop = store.interruptSessionTask('thread');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writes, 1);
  assert.equal(stop.status, 'recovering');
  assert.equal(stop.hasUncertainStart, true);
  assert.equal(records.get('op').hasUncertainStart, true);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
});

test('a timed-out start remains uncertain even after its original task failed', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(value) { records.set(value.operationId, { ...value }); }, async remove(id) { records.delete(id); } };
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => ({ status: 'idle', threadId: 'thread', reason: 'official_no_active_turn' }),
    adapter: { async run({ task }) { task.turnStartInFlight = true; throw new Error('start response lost'); },
      async interrupt() { return { accepted: true, confirmed: true, threadId: 'thread', turnId: 'old', status: 'completed' }; } } });
  const original = store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  await waitForStatus(original, 'failed');
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  assert.equal(stop.hasUncertainStart, true);
  assert.equal(records.get(stop.id).hasUncertainStart, true);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
});

test('acknowledging one start does not clear another unresolved start in the same thread', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(value) { records.set(value.operationId, { ...value }); }, async remove(id) { records.delete(id); } };
  let store;
  store = new TaskStore({ projects: [{ id: 'p', root: '.' }], eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => ({ status: 'idle', threadId: 'thread', reason: 'official_no_active_turn' }),
    adapter: { async run({ task }) { task.turnStartInFlight = true; return await new Promise(() => {}); },
      async interrupt({ pendingTaskId, onPendingStartResolved }) { store.getTask(pendingTaskId).turnStartInFlight = false;
        await onPendingStartResolved({ threadId: 'thread', turnId: 'one' });
        return { accepted: true, confirmed: false, threadId: 'thread', turnId: 'one' }; } } });
  store.createTask({ projectId: 'p', prompt: 'one', codexSessionId: 'thread' });
  store.createTask({ projectId: 'p', prompt: 'two', codexSessionId: 'thread' });
  const stop = store.interruptSessionTask('thread');
  await waitForStatus(stop, 'recovering');
  assert.equal(stop.hasUncertainStart, true);
  assert.equal(records.get(stop.id).hasUncertainStart, true);
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
});
