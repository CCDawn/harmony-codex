import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openSessionEventStream } from '../src/sessionEventStream.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';

const threadId = 'thread-1';
const snapshot = (id = 'turn-1', status = 'interrupted', goal = null) => ({ thread: {
  id: threadId, status: { type: status === 'inProgress' ? 'active' : 'idle' }, goal,
  turns: [{ id, status, items: [] }]
} });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'status stream did not settle'); await delay(2); }
}

async function fixture(t, readThread = async () => snapshot()) {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, writableEnded: false, destroyed: false,
    writeHead() {}, flushHeaders() {}, write(frame) { this.frames.push(frame); return true; },
    end(frame) { if (frame) this.frames.push(frame); this.writableEnded = true; this.emit('finish'); },
    destroy() { this.destroyed = true; this.emit('close'); } });
  let emit, reads = 0;
  const cancel = await openSessionEventStream({ request, response, threadId,
    adapter: { startNotificationPolling(id, buffer, callback) { emit = callback; return { stop() {} }; } },
    readThread: () => { reads++; return readThread(reads); }, readDebounceMs: 2 });
  t.after(cancel); await settle();
  return { response, get reads() { return reads; },
    notify(method, params = {}, notificationId) { emit('codex.desktop_live.notification', { method, notificationId, params: { threadId, ...params } }); },
    statuses() { return response.frames.filter(frame => frame.startsWith('event: session.status\n'))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1])); } };
}

test('initial/terminal snapshots share continue eligibility and text deltas never read history', async t => {
  let value = snapshot();
  const h = await fixture(t, () => value);
  assert.deepEqual(h.statuses().at(-1), { threadId, turnId: 'turn-1', state: 'interrupted', reason: 'interrupted', canContinue: true });
  h.notify('turn/started', { turn: { id: 'turn-2' } });
  assert.deepEqual(h.statuses().at(-1), { threadId, turnId: 'turn-2', state: 'active', reason: 'active', canContinue: false });
  h.notify('item/started', { turnId: 'turn-2', item: { id: 'item-1', type: 'agentMessage', text: '' } });
  for (let i = 0; i < 100; i++) h.notify('item/agentMessage/delta', { turnId: 'turn-2', itemId: 'item-1', delta: 'x' });
  assert.equal(h.reads, 1);
  value = snapshot('turn-2', 'failed');
  value.thread.turns[0].error = { codexErrorInfo: { responseStreamDisconnected: {} }, message: 'PRIVATE_ERROR' };
  h.notify('turn/completed', { turn: { id: 'turn-2', status: 'failed' } });
  assert.equal(h.statuses().at(-1).canContinue, false);
  await until(() => h.statuses().at(-1).canContinue);
  assert.equal(h.statuses().at(-1).reason, 'retryable_error');
  assert.equal(h.reads, 2);
  assert.doesNotMatch(JSON.stringify(h.statuses()), /PRIVATE_ERROR/);
  h.notify('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(h.statuses().at(-1).turnId, 'turn-2');
});

test('thread/status/changed without turnId disables continue immediately and reads the newest canonical page', async t => {
  let value = snapshot();
  const h = await fixture(t, () => value);
  value = snapshot('turn-2', 'completed');
  h.notify('thread/status/changed', { status: { type: 'idle' } }, 'epoch:1');
  assert.equal(h.statuses().at(-1).reason, 'updating');
  assert.equal(h.statuses().at(-1).canContinue, false);
  await until(() => h.reads === 2 && h.statuses().at(-1).turnId === 'turn-2');
  assert.equal(h.statuses().at(-1).state, 'completed');
  h.notify('thread/status/changed', { status: { type: 'idle' } }, 'epoch:1');
  await delay(10); assert.equal(h.reads, 2, 'duplicate notification cannot trigger a new status read');
});

test('a newer confirmed desktop turn owns status while the persisted page still contains the old completion', async t => {
  const value = snapshot('old', 'completed');
  value.thread.turns[0].startedAt = 100;
  value.thread.latestTurn = { id: 'live', status: 'interrupted', startedAt: 200 };
  const h = await fixture(t, async () => value);
  assert.deepEqual(h.statuses().at(-1), { threadId, turnId: 'live', state: 'interrupted',
    canContinue: true, reason: 'interrupted' });
});

test('a status boundary during an in-flight read cannot briefly reenable the stale interrupted turn', async t => {
  const pending = Promise.withResolvers();
  const h = await fixture(t, reads => reads === 2 ? pending.promise : reads >= 3 ? snapshot('turn-2', 'inProgress') : snapshot());
  h.notify('thread/status/changed', { status: { type: 'idle' } }, 'epoch:1');
  await until(() => h.reads === 2);
  const boundaryIndex = h.statuses().length;
  h.notify('turn/started', { turn: { id: 'turn-2' } }, 'epoch:2');
  pending.resolve(snapshot());
  await until(() => h.reads === 3);
  assert.ok(h.statuses().slice(boundaryIndex).every(status => !status.canContinue));
  assert.equal(h.statuses().at(-1).turnId, 'turn-2');
  assert.equal(h.statuses().at(-1).state, 'active');
});

test('goal, missing context and unqualified failures do not enable continue', async t => {
  const h = await fixture(t, () => snapshot('turn-1', 'interrupted', { status: 'active' }));
  assert.equal(h.statuses().at(-1).reason, 'goal_present');
  assert.equal(h.statuses().at(-1).canContinue, false);
});

test('runtime subscriptions explicitly share the poller and receive all official threads without filling thread buffers', async () => {
  const adapter = new CodexDesktopCdpAdapter({ client: { async drainNotifications() { return []; }, close() {} } });
  const global = [], targeted = [], buffer = [];
  const runtime = adapter.subscribeRuntimeNotifications((type, payload) => global.push([type, payload]));
  const poller = adapter.notificationPoller;
  const thread = adapter.startNotificationPolling('target', buffer, (type, payload) => targeted.push([type, payload]));
  assert.equal(adapter.notificationPoller, poller);
  adapter.dispatchDesktopNotifications([{ method: 'thread/status/changed', params: { threadId: 'other', status: { type: 'active' } } },
    { method: 'turn/started', params: { threadId: 'target', turn: { id: 'turn' } } },
    { method: 'account/updated', params: { status: 'changed' } }]);
  assert.equal(global.length, 3); assert.equal(targeted.length, 1); assert.equal(buffer.length, 1);
  runtime.stop(); runtime.stop(); assert.equal(adapter.notificationPoller, poller);
  thread.stop(); assert.equal(adapter.notificationPoller, null);
  adapter.close();
});

test('nativeState preserves notLoaded/systemError without changing legacy runtime state', async () => {
  const adapter = new CodexDesktopCdpAdapter({ client: { async request() {
    return { data: [{ id: 'unloaded', status: { type: 'notLoaded' } }, { id: 'broken', status: { type: 'systemError' } }] };
  } } });
  const states = await adapter.listThreadRuntimeStates();
  assert.deepEqual(states.map(value => [value.state, value.nativeState]), [['idle', 'notLoaded'], ['idle', 'systemError']]);
});
