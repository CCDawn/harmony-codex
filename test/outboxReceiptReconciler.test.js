import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurableOutbox } from '../src/durableOutbox.js';
import { TaskStore } from '../src/taskStore.js';
import { createOutboxReceiptReconciler } from '../src/outboxReceiptReconciler.js';

function sampleItem(overrides = {}) {
  return {
    kind: 'existing_thread',
    threadId: 'thread-a',
    projectId: 'probe',
    submissionId: 'phone-1',
    text: '远程提交内容',
    lastAttemptAt: '2026-07-29T00:00:10.000Z',
    ...overrides
  };
}

function imageReceiptFixture() {
  const at = new Date().toISOString();
  const text = '检查图片\n![手机端图片](C:/probe/mobile-image.png)';
  const item = sampleItem({ text, lastAttemptAt: at, resultId: 'task-1', result: { deliveryPending: true } });
  const task = { id: 'task-1', codexSessionId: item.threadId, submissionId: item.submissionId, status: 'running', events: [{
    type: 'codex.session_file.cursor_captured',
    payload: { sessionId: item.threadId, filePath: 'C:/probe/rollout.jsonl', offset: 100 }
  }] };
  const record = { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text },
    { type: 'input_text', text: '<image name=[Image #1] path="C:/probe/mobile-image.png">' },
    { type: 'input_image', image_url: 'data:image/png;base64,fixture' },
    { type: 'input_text', text: '</image>' }
  ] } };
  const sessions = { readSessionRecordsAfterCursor: async () => [record] };
  return { item, task, record, sessions };
}

test('matching image text and cursor alone cannot identify which client sent the input', async () => {
  const { item, task, sessions } = imageReceiptFixture();
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => task }, sessions });
  assert.deepEqual(await reconcile(item), { status: 'unknown', evidence: 'awaiting_official_message' });
  item.result.run = task;
  const afterRestart = createOutboxReceiptReconciler({ sessions });
  assert.equal((await afterRestart(item)).status, 'uncertain');
});

test('image input is accepted only by the matching native start or steer ACK', async t => {
  const gate = Promise.withResolvers();
  const store = new TaskStore({ projects: [{ id: 'probe', root: '.' }], eventBus: { publish() {} },
    adapter: { run: async ({ emit }) => { await gate.promise;
      emit('codex.app_server.turn.started', { turn: { id: 'turn-1', status: 'inProgress' } });
      await new Promise(() => {}); }, steer: async () => ({ turnId: 'turn-1' }) } });
  t.after(() => store.close());
  const fixture = imageReceiptFixture();
  const task = store.createTask({ projectId: 'probe', codexSessionId: 'thread-a', prompt: fixture.item.text, submissionId: 'phone-1' });
  const item = { ...fixture.item, resultId: task.id };
  const reconcile = createOutboxReceiptReconciler({ store, sessions: fixture.sessions });
  assert.equal((await reconcile(item)).status, 'unknown');
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const first = await reconcile(item);
  assert.equal(first.status, 'submitted');
  assert.equal(first.evidence, 'rpc_acknowledgement');
  const second = { ...item, submissionId: 'phone-2' };
  assert.equal((await reconcile(second)).status, 'unknown');
  await store.steerSessionTask('thread-a', { prompt: item.text, submissionId: 'phone-2' });
  const secondReceipt = await reconcile(second);
  assert.equal(secondReceipt.status, 'submitted');
  assert.equal(secondReceipt.evidence, 'rpc_acknowledgement');
});

test('ambiguous image input survives restart uncertain without redispatching on duplicate request', async t => {
  const fixture = imageReceiptFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-restart-image-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  let calls = 0;
  const first = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { calls++; return { run: fixture.task, deliveryPending: true }; } });
  const accepted = await first.enqueue(fixture.item);
  await first.dispatchReady();
  fixture.record.timestamp = new Date(Date.parse(first.get(accepted.id).lastAttemptAt) + 1).toISOString();
  first.close();
  const restored = new DurableOutbox({ filePath, schedule: false,
    reconcile: createOutboxReceiptReconciler({ sessions: fixture.sessions }),
    dispatch: async () => { calls++; throw new Error('ambiguous input must not dispatch again'); } });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.get(accepted.id).status, 'uncertain');
  await restored.enqueue(fixture.item);
  await restored.dispatchReady();
  assert.equal(restored.get(accepted.id).status, 'uncertain');
  assert.equal(calls, 1);
});

test('native start and each steer acknowledge only their exact TaskStore submission', async t => {
  const gate = Promise.withResolvers();
  const store = new TaskStore({ projects: [{ id: 'probe', root: '.' }], eventBus: { publish() {} },
    adapter: {
      run: async ({ emit }) => { emit('codex.delivery.attempted', { threadId: 'thread-a' });
        await gate.promise; emit('codex.app_server.turn.started', { turn: { id: 'turn-1', status: 'inProgress' } });
        await new Promise(() => {}); },
      steer: async () => ({ turnId: 'turn-1' })
    } });
  t.after(() => store.close());
  const task = store.createTask({ projectId: 'probe', codexSessionId: 'thread-a', prompt: 'first', submissionId: 'first' });
  const reconcile = createOutboxReceiptReconciler({ store });
  const item = sampleItem({ submissionId: 'first', resultId: task.id,
    lastAttemptAt: new Date().toISOString(), result: { run: task, deliveryPending: true } });
  assert.equal((await reconcile(item)).status, 'unknown', 'running and attempted are not ACKs');
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const first = await reconcile(item);
  assert.equal(first.status, 'submitted');
  assert.equal(first.evidence, 'rpc_acknowledgement');
  assert.equal(first.result.deliveryPending, false);
  assert.equal(first.result.run.status, 'running');
  const second = { ...item, submissionId: 'second' };
  assert.equal((await reconcile(second)).status, 'unknown', 'the first ACK must not acknowledge a later submission');
  await store.steerSessionTask('thread-a', { prompt: 'second', submissionId: 'second' });
  const steered = await reconcile(second);
  assert.equal(steered.status, 'submitted');
  assert.equal(steered.evidence, 'rpc_acknowledgement');
  assert.equal(steered.result.deliveryPending, false);
  assert.equal((await reconcile({ ...item, submissionId: 'third' })).status, 'unknown');
});

test('RPC receipt requires the correct task, thread, submission and nonempty turn ID', async () => {
  const task = { id: 'task-1', codexSessionId: 'thread-a', submissionId: 'first', status: 'running',
    events: [{ taskId: 'task-1', type: 'codex.app_server.turn.started', payload: { turn: { id: 'turn-1' } } },
      { taskId: 'task-1', type: 'task.guidance.accepted', payload: { submissionId: 'second', turnId: 'turn-1' } }] };
  const item = sampleItem({ submissionId: 'first', resultId: task.id, lastAttemptAt: new Date().toISOString(),
    result: { deliveryPending: true } });
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => task } });
  assert.equal((await reconcile({ ...item, threadId: 'wrong' })).status, 'unknown');
  assert.equal((await reconcile({ ...item, resultId: 'wrong' })).status, 'unknown');
  task.events[0].payload.turn.id = '';
  assert.equal((await reconcile(item)).status, 'unknown');
  task.events[1].payload.turnId = '';
  assert.equal((await reconcile({ ...item, submissionId: 'second' })).status, 'unknown');
  task.events[1].payload.turnId = 'turn-1';
  task.events[1].taskId = 'wrong';
  assert.equal((await reconcile({ ...item, submissionId: 'second' })).status, 'unknown');
});

test('native start ACK advances a pending outbox without waiting for generation or history', async t => {
  const gate = Promise.withResolvers();
  const store = new TaskStore({ projects: [{ id: 'probe', root: '.' }], eventBus: { publish() {} },
    adapter: { run: async ({ emit }) => { await gate.promise;
      emit('codex.app_server.turn.started', { turn: { id: 'turn-1', status: 'inProgress' } });
      await new Promise(() => {}); } } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rpc-receipt-'));
  const outbox = new DurableOutbox({ filePath: path.join(root, 'outbox.json'), schedule: false,
    reconcile: createOutboxReceiptReconciler({ store }),
    dispatch: async item => ({ run: store.createTask({ projectId: item.projectId, codexSessionId: item.threadId,
      prompt: item.text, submissionId: item.submissionId }), deliveryPending: true }) });
  t.after(async () => { store.close(); outbox.close(); await fs.rm(root, { recursive: true, force: true }); });
  const item = await outbox.enqueue(sampleItem());
  await outbox.dispatchReady();
  assert.equal(outbox.get(item.id).status, 'dispatching');
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await outbox.dispatchReady();
  assert.equal(outbox.get(item.id).status, 'submitted');
  assert.equal(outbox.get(item.id).result.deliveryPending, false);
  assert.equal(outbox.get(item.id).result.run.status, 'running');
});

test('persisted ACK is recovered as a receipt without reviving a stale running task', async () => {
  const task = { id: 'task-1', createdCodexSessionId: 'new-thread', submissionId: 'phone-1', status: 'running',
    events: [{ taskId: 'task-1', type: 'codex.app_server.turn.started', createdAt: '2026-10-31T00:00:00.000Z',
      payload: { turn: { id: 'turn-1', status: 'inProgress' } } }] };
  const item = sampleItem({ kind: 'new_thread', threadId: '', resultId: task.id,
    result: { run: task, deliveryPending: true } });
  const result = await createOutboxReceiptReconciler()(item);
  assert.equal(result.evidence, 'rpc_acknowledgement');
  assert.equal(result.result.threadId, 'new-thread');
  assert.equal(result.result.submissionId, item.submissionId);
  assert.equal(result.result.run, undefined);
  assert.equal(result.result.deliveryPending, false);
});

test('a pending delivery cannot claim a concurrent same-text desktop user item', async () => {
  const at = new Date().toISOString();
  const task = { id: 'task-1', status: 'running' };
  const entries = [{ role: 'user', text: '远程提交内容', timestamp: new Date(Date.parse(at) - 1).toISOString() }];
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => task }, sessions: { getSession: async () => ({ entries }) } });
  const item = sampleItem({ lastAttemptAt: at, resultId: 'task-1', result: { run: task, deliveryPending: true } });
  assert.equal((await reconcile(item)).status, 'unknown');
  entries.push({ role: 'user', text: 'another insertion', timestamp: at });
  assert.equal((await reconcile(item)).status, 'unknown');
  entries.push({ role: 'user', itemId: 'unrelated-desktop-item', text: item.text, timestamp: at });
  const receipt = await reconcile(item);
  // The earlier positive asserted equal text proved delivery; a concurrent
  // desktop send can have the same body and timestamp without this identity.
  assert.deepEqual(receipt, { status: 'unknown', evidence: 'awaiting_official_message' });
});

test('desktop task transport failure without official input is uncertain, never delivered', async () => {
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => ({ status: 'failed', error: 'CDP timeout' }) }, sessions: { getSession: async () => ({ entries: [] }) } });
  const result = await reconcile(sampleItem({ resultId: 'task-1', result: { deliveryPending: true } }));
  assert.equal(result.status, 'uncertain');
  assert.match(result.error, /CDP timeout/);
});

test('outbox receipt reconciler prefers an exact persisted submission receipt', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: {
      findRunBySubmission() {
        return {
          id: 'run-1',
          threadId: 'thread-a',
          submissionId: 'phone-1'
        };
      }
    },
    sessions: null
  });

  const result = await reconcile(sampleItem());
  assert.equal(result.status, 'submitted');
  assert.equal(result.result.id, 'run-1');
  assert.equal(result.evidence, 'submission_journal');
});

test('after an interrupted dispatch, same-text history cannot identify the submitted message', async () => {
  const at = '2026-07-29T00:00:10.000Z';
  for (const [description, timestamp] of [
    ['previous submission one second earlier', '2026-07-29T00:00:09.000Z'],
    ['previous submission in the same second', at],
    ['concurrent desktop submission', '2026-07-29T00:00:11.000Z']
  ]) {
    const reconcile = createOutboxReceiptReconciler({ sessions: { getSession: async () => ({ entries: [
      { role: 'user', type: 'userMessage', itemId: 'other-input', text: '远程提交内容', timestamp }
    ] }) } });
    assert.deepEqual(await reconcile(sampleItem({ submissionId: 'second-send', lastAttemptAt: at })),
      { status: 'unknown', evidence: 'no_receipt' }, description);
  }
});

test('restart leaves an ambiguous same-text submission uncertain and never redispatches it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ambiguous-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  const at = '2026-07-29T00:00:10.000Z';
  const now = () => Date.parse(at);
  let sends = 0;
  const first = new DurableOutbox({ filePath, schedule: false, now, dispatch: async () => { sends++; } });
  const input = sampleItem({ submissionId: 'second-send', lastAttemptAt: at });
  const queued = await first.enqueue(input);
  // This is the durable state written just before an in-flight dispatch.
  first.items[0].status = 'dispatching';
  first.items[0].lastAttemptAt = at;
  await first.persist();
  first.close();
  const sessions = { getSession: async () => ({ entries: [{ role: 'user', type: 'userMessage',
    itemId: 'earlier-send', text: input.text, timestamp: '2026-07-29T00:00:09.000Z' }] }) };
  const restored = new DurableOutbox({ filePath, schedule: false, now,
    dispatch: async () => { sends++; }, reconcile: createOutboxReceiptReconciler({ sessions }) });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.get(queued.id).status, 'uncertain');
  assert.equal((await restored.enqueue(input)).id, queued.id);
  await restored.dispatchReady();
  assert.equal(restored.get(queued.id).status, 'uncertain');
  assert.equal(sends, 0);
});

test('matching CDP session text after dispatch began is not an identity-bound receipt', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: null,
    sessions: {
      async getSession() {
        return {
          entries: [{
            timestamp: '2026-07-29T00:00:11.000Z',
            type: 'userMessage',
            role: 'user',
            text: '远程提交内容'
          }]
        };
      }
    }
  });

  const result = await reconcile(sampleItem());
  // The old expectation treated text and timestamp as a receipt, but another
  // send can have identical content after this dispatch began.
  assert.deepEqual(result, { status: 'unknown', evidence: 'no_receipt' });
});

test('outbox receipt reconciler does not accept an older identical session message', async () => {
  const reconcile = createOutboxReceiptReconciler({
    threadService: null,
    sessions: {
      async getSession() {
        return {
          entries: [{
            timestamp: '2026-07-28T23:59:00.000Z',
            type: 'userMessage',
            role: 'user',
            text: '远程提交内容'
          }]
        };
      }
    }
  });

  assert.deepEqual(await reconcile(sampleItem()), {
    status: 'unknown',
    evidence: 'no_receipt'
  });
});
