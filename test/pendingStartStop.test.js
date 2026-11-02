import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { TaskStore } from '../src/taskStore.js';

function fixture(turns, ownerThread = 'thread') {
  const writes = [];
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method, params) {
    if (method !== 'turn/interrupt') throw new Error(`unexpected method ${method}`);
    writes.push(params);
    return {};
  } } });
  adapter.pendingTurnStarts.set('owner', Promise.resolve('ack-turn'));
  adapter.pendingTurnThreadIds = new Map([['owner', ownerThread]]);
  adapter.readRecentThread = async (threadId) => ({ thread: { id: threadId, turns } });
  adapter.waitForTurnTerminalAfterInterrupt = async (_threadId, turnId) => ({ id: turnId, status: 'interrupted' });
  return { adapter, writes };
}

function stop(adapter) {
  return adapter.interrupt({ task: { id: 'stop', codexSessionId: 'thread' },
    interruptScope: 'thread', pendingTaskId: 'owner', emit() {} });
}

test('pending start ACK remains the stop target when official history still shows an older terminal turn', async () => {
  const { adapter, writes } = fixture([{ id: 'old', status: 'completed' }]);
  const result = await stop(adapter);
  assert.deepEqual(writes, [{ threadId: 'thread', turnId: 'ack-turn' }]);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.turnId, 'ack-turn');
});

test('a current active official turn takes precedence over an earlier pending ACK', async () => {
  const { adapter, writes } = fixture([{ id: 'ack-turn', status: 'completed' }, { id: 'newer', status: 'inProgress' }]);
  const result = await stop(adapter);
  assert.deepEqual(writes, [{ threadId: 'thread', turnId: 'newer' }]);
  assert.equal(result.turnId, 'newer');
});

test('a pending start registered for another thread cannot become the stop target', async () => {
  const { adapter, writes } = fixture([{ id: 'old', status: 'completed' }], 'other-thread');
  const result = await stop(adapter);
  assert.deepEqual(writes, []);
  assert.equal(result.turnId, 'old');
});

test('pending start ACK is used when the official snapshot has no turn yet', async () => {
  const { adapter, writes } = fixture([]);
  const result = await stop(adapter);
  assert.deepEqual(writes, [{ threadId: 'thread', turnId: 'ack-turn' }]);
  assert.equal(result.turnId, 'ack-turn');
});

test('matching official terminal ACK is returned without a duplicate interrupt', async () => {
  const { adapter, writes } = fixture([{ id: 'ack-turn', status: 'interrupted' }]);
  const result = await stop(adapter);
  assert.deepEqual(writes, []);
  assert.equal(result.turnId, 'ack-turn');
  assert.equal(result.status, 'interrupted');
});

test('ACK target is exposed to TaskStore before an interrupt write can lose its receipt', async () => {
  const records = new Map();
  const journal = { async load() { return [...records.values()]; }, async put(record) { records.set(record.operationId, { ...record }); }, async remove(id) { records.delete(id); } };
  const adapter = new CodexDesktopCdpAdapter({ client: { async request(method) {
    if (method === 'turn/interrupt') throw new Error('response lost');
    throw new Error(`unexpected method ${method}`);
  } } });
  adapter.readRecentThread = async () => ({ thread: { id: 'thread', turns: [{ id: 'old', status: 'completed' }] } });
  adapter.run = async ({ task }) => { adapter.pendingTurnStarts.set(task.id, Promise.resolve('ack-turn'));
    adapter.pendingTurnThreadIds.set(task.id, 'thread'); return await new Promise(() => {}); };
  const store = new TaskStore({ projects: [{ id: 'p', root: '.' }], adapter, eventBus: { publish() {} }, interruptJournal: journal,
    interruptReconciler: async () => ({ status: 'unknown' }) });
  store.createTask({ projectId: 'p', prompt: 'p', codexSessionId: 'thread' });
  const operation = store.interruptSessionTask('thread');
  const deadline = Date.now() + 1000;
  while (operation.status !== 'recovering' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(operation.status, 'recovering');
  assert.equal(operation.activeCodexTurnId, 'ack-turn');
  assert.equal(records.get(operation.id)?.turnId, 'ack-turn');
  assert.equal(store.isSessionInterruptPending('thread'), true);
  store.close();
});
