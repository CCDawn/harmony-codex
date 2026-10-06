import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableOutbox, isRetryableOutboxError } from '../src/durableOutbox.js';

async function createTempOutboxPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-durable-outbox-'));
  return path.join(root, 'outbox.json');
}

test('asynchronous delivery stays dispatching until receipt and never dispatches twice', async () => {
  let calls = 0;
  let receipt = { status: 'unknown' };
  const outbox = new DurableOutbox({ filePath: await createTempOutboxPath(), schedule: false,
    dispatch: async () => { calls++; return { run: { id: 'task-1' }, deliveryPending: true }; },
    reconcile: async () => receipt });
  const item = await outbox.enqueue(sampleItem());
  await outbox.dispatchReady();
  assert.equal(outbox.get(item.id).status, 'dispatching');
  assert.equal(outbox.get(item.id).submittedAt, '');
  await outbox.dispatchReady();
  assert.equal(calls, 1);
  receipt = { status: 'submitted', result: { run: { id: 'task-1' } } };
  await outbox.dispatchReady();
  assert.equal(outbox.get(item.id).status, 'submitted');
  assert.equal(outbox.get(item.id).resultId, 'task-1');
  assert.equal(calls, 1);
});

test('a steering transport timeout is uncertain and is not retried automatically', async () => {
  let calls = 0;
  const outbox = new DurableOutbox({ filePath: await createTempOutboxPath(), schedule: false,
    dispatch: async () => { calls++; throw Object.assign(new Error('CDP timeout'), { deliveryUncertain: true }); } });
  const item = await outbox.enqueue(sampleItem());
  await outbox.dispatchReady();
  assert.equal(outbox.get(item.id).status, 'uncertain');
  assert.equal(outbox.get(item.id).retryable, false);
  await outbox.dispatchReady();
  assert.equal(calls, 1);
});

function sampleItem(overrides = {}) {
  return {
    kind: 'existing_thread',
    threadId: 'thread-a',
    projectId: 'probe',
    submissionId: 'phone-1',
    text: '第一条消息',
    payload: {
      sessionFingerprint: {
        title: '测试会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2
      }
    },
    ...overrides
  };
}

test('late receipt reconciliation cannot resurrect a canceled uncertain message', async () => {
  const outbox = new DurableOutbox({ filePath: await createTempOutboxPath(), schedule: false,
    dispatch: async () => { throw Object.assign(new Error('timeout'), { deliveryUncertain: true }); } });
  const item = await outbox.enqueue(sampleItem());
  await outbox.dispatchReady();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  outbox.reconcile = async () => { started.resolve(); return reply.promise; };
  const pending = outbox.reconcileUncertainItems();
  await started.promise;
  await outbox.cancel(item.id);
  reply.resolve({ status: 'uncertain', error: 'no receipt' });
  await pending;
  assert.equal(outbox.get(item.id).status, 'canceled');
});

test('durable outbox survives restart and deduplicates a submission id', async () => {
  const filePath = await createTempOutboxPath();
  const first = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run-1' }), schedule: false });
  const accepted = await first.enqueue(sampleItem());
  const duplicate = await first.enqueue(sampleItem({ text: '不应覆盖原消息' }));

  assert.equal(duplicate.id, accepted.id);
  assert.equal(duplicate.text, '第一条消息');

  const restored = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run-2' }), schedule: false });
  await restored.initialize();
  const listed = restored.list();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].submissionId, 'phone-1');
  assert.equal(listed[0].text, '第一条消息');
});

test('a persisted non-retryable failure does not block later messages or resend itself', async () => {
  const filePath = await createTempOutboxPath();
  const first = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { throw Object.assign(new Error('no active turn to steer'), { statusCode: 409 }); }
  });
  const failed = await first.enqueue(sampleItem({ submissionId: 'failed' }));
  await first.dispatchReady();
  assert.equal(first.get(failed.id).retryable, false);
  const calls = [];
  const restored = new DurableOutbox({ filePath, schedule: false,
    dispatch: async (item) => { calls.push(item.submissionId); return { id: 'run-next' }; }
  });
  const next = await restored.enqueue(sampleItem({ submissionId: 'next' }));
  await restored.dispatchReady();
  assert.deepEqual(calls, ['next']);
  assert.equal(restored.get(next.id).status, 'submitted');
  assert.equal(restored.get(failed.id).status, 'failed');
});

test('durable outbox dispatches only the first item in a session lane', async () => {
  const filePath = await createTempOutboxPath();
  const calls = [];
  const outbox = new DurableOutbox({
    filePath,
    dispatch: async (item) => {
      calls.push(item.submissionId);
      return { id: `run-${item.submissionId}` };
    },
    schedule: false
  });
  await outbox.enqueue(sampleItem({ submissionId: 'first' }));
  await outbox.enqueue(sampleItem({ submissionId: 'second', text: '第二条消息' }));

  await outbox.dispatchReady();
  assert.deepEqual(calls, ['first']);
  assert.equal(outbox.getBySubmissionId('existing_thread', 'thread-a', 'first').status, 'submitted');
  assert.equal(outbox.getBySubmissionId('existing_thread', 'thread-a', 'second').status, 'queued');

  await outbox.dispatchReady();
  assert.deepEqual(calls, ['first', 'second']);
});

test('durable outbox requeues a submitted item only after an authoritative safe failure', async () => {
  const filePath = await createTempOutboxPath();
  const calls = [];
  let canRequeue = false;
  const outbox = new DurableOutbox({
    filePath,
    dispatch: async () => {
      const id = `run-${calls.length + 1}`;
      calls.push(id);
      return { id };
    },
    canRequeueSubmitted: async () => canRequeue,
    schedule: false
  });
  const first = await outbox.enqueue(sampleItem());
  await outbox.dispatchReady();
  assert.equal(outbox.get(first.id).status, 'submitted');

  const duplicate = await outbox.enqueue(sampleItem());
  assert.equal(duplicate.status, 'submitted');
  assert.deepEqual(calls, ['run-1']);

  canRequeue = true;
  const requeued = await outbox.enqueue(sampleItem());
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.resultId, '');
  await outbox.dispatchReady();

  assert.equal(outbox.get(first.id).status, 'submitted');
  assert.equal(outbox.get(first.id).resultId, 'run-2');
  assert.deepEqual(calls, ['run-1', 'run-2']);
});

test('durable outbox edits, reorders, and cancels queued items', async () => {
  const filePath = await createTempOutboxPath();
  const outbox = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run' }), schedule: false });
  const first = await outbox.enqueue(sampleItem({ submissionId: 'first' }));
  const second = await outbox.enqueue(sampleItem({ submissionId: 'second', text: '旧文本' }));
  const third = await outbox.enqueue(sampleItem({ submissionId: 'third', text: '取消我' }));

  const edited = await outbox.update(second.id, { text: '修改后的文本' });
  assert.equal(edited.text, '修改后的文本');
  await outbox.move(second.id, 'up');
  await outbox.cancel(third.id);

  const visible = outbox.list({ threadId: 'thread-a', includeTerminal: false });
  assert.deepEqual(visible.map((item) => item.id), [second.id, first.id]);
  assert.equal(outbox.get(third.id).status, 'canceled');
});

test('durable outbox applies exponential backoff with jitter to server overload', async () => {
  const filePath = await createTempOutboxPath();
  let now = 1_000;
  const overload = Object.assign(new Error('Server overloaded; retry later.'), {
    code: -32001,
    statusCode: 503
  });
  const outbox = new DurableOutbox({
    filePath,
    dispatch: async () => {
      throw overload;
    },
    now: () => now,
    random: () => 0.5,
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
    schedule: false
  });
  const item = await outbox.enqueue(sampleItem());

  await outbox.dispatchReady();
  const firstFailure = outbox.get(item.id);
  assert.equal(firstFailure.status, 'failed');
  assert.equal(firstFailure.attemptCount, 1);
  assert.equal(firstFailure.nextAttemptAt, new Date(3_000).toISOString());

  now = 3_000;
  await outbox.dispatchReady();
  const secondFailure = outbox.get(item.id);
  assert.equal(secondFailure.attemptCount, 2);
  assert.equal(secondFailure.nextAttemptAt, new Date(7_000).toISOString());
  assert.equal(isRetryableOutboxError(overload), true);
});

test('durable outbox restores an interrupted dispatch as uncertain instead of resending it', async () => {
  const filePath = await createTempOutboxPath();
  const outbox = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run' }), schedule: false });
  const item = await outbox.enqueue(sampleItem());
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  persisted.items[0].status = 'dispatching';
  persisted.items[0].updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(persisted), 'utf8');

  let dispatchCount = 0;
  const restored = new DurableOutbox({
    filePath,
    dispatch: async () => {
      dispatchCount += 1;
      return { id: 'duplicate-run' };
    },
    schedule: false
  });
  await restored.initialize();
  await restored.dispatchReady();

  assert.equal(restored.get(item.id).status, 'uncertain');
  assert.equal(dispatchCount, 0);
});

test('durable outbox reconciles an interrupted dispatch from an authoritative receipt', async () => {
  const filePath = await createTempOutboxPath();
  const outbox = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run' }), schedule: false });
  const item = await outbox.enqueue(sampleItem());
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  persisted.items[0].status = 'dispatching';
  persisted.items[0].lastAttemptAt = '2026-07-29T00:00:00.000Z';
  await fs.writeFile(filePath, JSON.stringify(persisted), 'utf8');

  const reconcileCalls = [];
  const restored = new DurableOutbox({
    filePath,
    dispatch: async () => {
      throw new Error('must not dispatch a reconciled receipt');
    },
    reconcile: async (candidate) => {
      reconcileCalls.push(candidate.submissionId);
      return {
        status: 'submitted',
        result: {
          id: 'run-from-receipt',
          threadId: candidate.threadId,
          submissionId: candidate.submissionId
        }
      };
    },
    schedule: false
  });
  await restored.initialize();

  const reconciled = restored.get(item.id);
  assert.deepEqual(reconcileCalls, ['phone-1']);
  assert.equal(reconciled.status, 'submitted');
  assert.equal(reconciled.resultId, 'run-from-receipt');
  assert.equal(reconciled.error, '');
  assert.equal(reconciled.retryable, false);
});

test('durable outbox keeps an interrupted dispatch uncertain when no receipt exists', async () => {
  const filePath = await createTempOutboxPath();
  const outbox = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run' }), schedule: false });
  const item = await outbox.enqueue(sampleItem());
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  persisted.items[0].status = 'dispatching';
  await fs.writeFile(filePath, JSON.stringify(persisted), 'utf8');

  const restored = new DurableOutbox({
    filePath,
    dispatch: async () => ({ id: 'duplicate-run' }),
    reconcile: async () => ({ status: 'unknown' }),
    schedule: false
  });
  await restored.initialize();

  assert.equal(restored.get(item.id).status, 'uncertain');
});
