import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/taskStore.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { createOutboxReceiptReconciler } from '../src/outboxReceiptReconciler.js';

async function failedTask(adapter) {
  const store = new TaskStore({ projects: [{ id: 'project', root: '.' }], adapter, eventBus: { publish() {} } });
  const input = { projectId: 'project', prompt: 'one input', codexSessionId: 'thread', submissionId: 'submission' };
  const task = store.createTask(input);
  for (let n = 0; task.status !== 'failed' && n < 100; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  return { store, task, input };
}

test('read-only preflight failure is safe to retry before the adapter is invoked', async () => {
  let calls = 0;
  const store = new TaskStore({ projects: [{ id: 'project', root: '.' }],
    adapter: { run: async () => { calls++; } }, eventBus: { publish() {} },
    beforeRun: async () => { throw new Error('desktop verification unavailable'); } });
  const task = store.createTask({ projectId: 'project', prompt: 'input', codexSessionId: 'thread' });
  for (let n = 0; task.status !== 'failed' && n < 100; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  assert.equal(calls, 0);
  assert.equal(task.deliveryAttempted, false);
  assert.equal(task.events.find(event => event.type === 'task.failed').payload.deliveryAttempted, false);
});

for (const attempted of [false, true]) {
  test(`desktop failure persists explicit delivery attempt evidence: ${attempted}`, async () => {
    const adapter = new CodexDesktopCdpAdapter({ client: { request: async () => { throw new Error('write acknowledgement lost'); } } });
    adapter.prepareExistingThread = async () => {
      if (!attempted) throw new Error('read-only preparation failed');
      return { thread: { id: 'thread' }, resumed: false };
    };
    adapter.captureSessionFileCursor = async () => null;
    adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
    adapter.startNotificationPolling = () => ({ stop() {} });
    try {
      const { store, task, input } = await failedTask(adapter);
      assert.equal(task.deliveryAttempted, attempted);
      assert.equal(task.events.find(event => event.type === 'task.failed').payload.deliveryAttempted, attempted);
      assert.equal(task.events.some(event => event.type === 'codex.app_server.turn.started'), false);
      const receipt = await createOutboxReceiptReconciler({ store, sessions: { getSession: async () => ({ entries: [] }) } })({
        kind: 'existing_thread', threadId: 'thread', text: input.prompt, submissionId: input.submissionId,
        lastAttemptAt: new Date().toISOString(), resultId: task.id, result: { run: task, deliveryPending: true }
      });
      assert.equal(receipt.status, attempted ? 'uncertain' : 'failed');
      assert.equal(receipt.retryable, attempted ? undefined : true);
      const retry = store.createTask(input);
      assert.equal(retry.id === task.id, attempted);
    } finally {
      adapter.close();
    }
  });
}

for (const scenario of [
  { name: 'safeToFallback alone is unknown', events: [], error: { safeToFallback: true }, expected: null },
  { name: 'safe first transport then write failure', events: [['codex.delivery.failed', { deliveryAttempted: false }], ['codex.desktop_live.transport_retry', {}], ['codex.delivery.attempted', {}]], error: { deliveryAttempted: true }, expected: true },
  { name: 'both transports fail before writing', events: [['codex.delivery.failed', { deliveryAttempted: false }], ['codex.desktop_live.transport_retry', {}]], error: { deliveryAttempted: false }, expected: false },
  { name: 'safe first transport then unknown fallback', events: [['codex.delivery.failed', { deliveryAttempted: false }], ['codex.desktop_live.transport_retry', {}]], error: {}, expected: null },
  { name: 'unknown first transport then safe fallback', events: [['codex.desktop_live.transport_retry', {}]], error: { deliveryAttempted: false }, expected: null },
  { name: 'attempted first transport cannot be cleared', events: [['codex.delivery.attempted', {}], ['codex.desktop_live.transport_retry', {}]], error: { deliveryAttempted: false }, expected: true },
  { name: 'turn acknowledgement is positive write evidence', events: [['codex.app_server.turn.started', { turn: { id: 'turn' } }]], error: { deliveryAttempted: false }, expected: true }
]) {
  test(`delivery safety across fallback: ${scenario.name}`, async () => {
    const { store, task, input } = await failedTask({ async run({ emit }) {
      for (const [type, payload] of scenario.events) emit(type, payload);
      throw Object.assign(new Error('transport failure'), scenario.error);
    } });
    assert.equal(task.deliveryAttempted, scenario.expected);
    assert.equal(task.events.find(event => event.type === 'task.failed').payload.deliveryAttempted, scenario.expected);
    assert.equal(store.createTask(input).id === task.id, scenario.expected !== false);
  });
}

test('restart permits only an exact persisted failed task with explicit no-write evidence', async () => {
  const task = { id: 'task', codexSessionId: 'thread', status: 'failed', prompt: 'one input', deliveryAttempted: false, events: [] };
  const item = { kind: 'existing_thread', threadId: 'thread', resultId: task.id, text: task.prompt,
    lastAttemptAt: new Date().toISOString(), result: { run: task, deliveryPending: true } };
  const reconcile = createOutboxReceiptReconciler({ sessions: { getSession: async () => ({ entries: [] }) } });
  assert.deepEqual(await reconcile(item), {
    status: 'failed', retryable: true, evidence: 'delivery_not_attempted',
    result: { run: task, deliveryPending: true }, error: '消息尚未尝试投递，可在连接恢复后重试。'
  });
  for (const mutation of [
    value => { delete value.deliveryAttempted; },
    value => { value.deliveryAttempted = null; },
    value => { value.deliveryAttempted = true; },
    value => { value.id = 'other'; },
    value => { value.codexSessionId = 'other'; },
    value => { value.prompt = 'other'; },
    value => { value.events.push({ type: 'codex.delivery.attempted' }); },
    value => { value.events.push({ type: 'codex.app_server.turn.started' }); }
  ]) {
    const changed = structuredClone(item);
    mutation(changed.result.run);
    assert.equal((await reconcile(changed)).status, 'uncertain');
  }
});

test('exact native ACK overrides an earlier no-write failure, but matching text alone does not', async () => {
  const at = new Date().toISOString();
  const task = { id: 'task', codexSessionId: 'thread', submissionId: 'submission', status: 'failed',
    prompt: 'one input', deliveryAttempted: false, events: [] };
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => task },
    sessions: { getSession: async () => ({ entries: [{ role: 'user', text: task.prompt, timestamp: at }] }) } });
  const item = { kind: 'existing_thread', threadId: 'thread', text: task.prompt, submissionId: 'submission',
    resultId: task.id, lastAttemptAt: at, result: { deliveryPending: true } };
  assert.equal((await reconcile(item)).status, 'failed', 'matching history alone is not an ACK');
  task.events.push({ taskId: task.id, type: 'codex.app_server.turn.started', payload: { turn: { id: 'turn' } } });
  const receipt = await reconcile(item);
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.evidence, 'rpc_acknowledgement');
  assert.equal(receipt.result.deliveryPending, false);
});
