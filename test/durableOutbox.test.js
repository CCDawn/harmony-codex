import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableOutbox, isRetryableOutboxError } from '../src/durableOutbox.js';
import { createOutboxReceiptReconciler } from '../src/outboxReceiptReconciler.js';

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

test('confirmed pre-delivery failure retries with backoff and retains message order', async () => {
  let now = 10_000;
  let calls = 0;
  let receipt = { status: 'unknown' };
  const box = new DurableOutbox({ filePath: await createTempOutboxPath(), schedule: false,
    now: () => now, random: () => 0.5, baseDelayMs: 1000,
    dispatch: async () => { calls++; return calls === 1
      ? { run: { id: 'task-1' }, deliveryPending: true } : { id: `receipt-${calls}` }; },
    reconcile: async () => receipt });
  const first = await box.enqueue(sampleItem());
  await box.dispatchReady();
  const next = await box.enqueue(sampleItem({ submissionId: 'phone-2' }));
  receipt = { status: 'failed', retryable: true, evidence: 'delivery_not_attempted', error: 'not sent' };
  await box.dispatchReady();
  assert.equal(box.get(first.id).retryable, true);
  assert.equal(box.get(first.id).attemptCount, 1);
  assert.equal(calls, 1);
  assert.equal(box.get(next.id).blockedBy, first.id);
  now += 1500;
  await box.dispatchReady();
  assert.equal(box.get(first.id).status, 'submitted');
  now += 1500;
  await box.dispatchReady();
  assert.equal(box.get(next.id).status, 'submitted');
  assert.equal(box.get(next.id).blockedReason, '');
  assert.equal(calls, 3);
});

test('uncertain predecessor exposes the queue blockage and never retries without proof', async () => {
  const box = new DurableOutbox({ filePath: await createTempOutboxPath(), schedule: false,
    dispatch: async () => { throw Object.assign(new Error('write timeout'), { deliveryUncertain: true }); },
    reconcile: async () => ({ status: 'uncertain', retryable: true }) });
  const first = await box.enqueue(sampleItem());
  await box.dispatchReady();
  const next = await box.enqueue(sampleItem({ submissionId: 'phone-2' }));
  await box.dispatchReady();
  assert.equal(box.get(first.id).retryable, false);
  assert.equal(box.get(next.id).blockedBy, first.id);
  assert.match(box.get(next.id).blockedReason, /发送结果待确认/);
  assert.equal(box.get(next.id).attemptCount, 0);
  const saved = JSON.parse(await fs.readFile(box.filePath, 'utf8'));
  assert.equal(saved.items.find(item => item.id === next.id).blockedBy, first.id);
});

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
  const duplicate = await first.enqueue(sampleItem());

  assert.equal(duplicate.id, accepted.id);
  assert.equal(duplicate.text, '第一条消息');

  const restored = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run-2' }), schedule: false });
  await restored.initialize();
  const listed = restored.list();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].submissionId, 'phone-1');
  assert.equal(listed[0].text, '第一条消息');
});

test('same target and submission reject different bodies or payloads without changing the queue', async () => {
  const filePath = await createTempOutboxPath();
  const outbox = new DurableOutbox({ filePath, schedule: false, dispatch: async () => ({ id: 'run' }) });
  const accepted = await outbox.enqueue(sampleItem());
  for (const input of [sampleItem({ text: '不同正文' }),
    sampleItem({ payload: { sessionFingerprint: { filePath: 'other' } } }),
    sampleItem({ projectId: 'other-project' })]) {
    await assert.rejects(outbox.enqueue(input), { statusCode: 409, code: 'CODEX_SUBMISSION_ID_CONFLICT' });
  }
  assert.deepEqual(outbox.get(accepted.id), accepted);
  const duplicate = await outbox.enqueue(sampleItem());
  assert.equal(duplicate.id, accepted.id);
  const reordered = await outbox.enqueue(sampleItem({ payload: { sessionFingerprint: {
    entryCount: 2, filePath: 'C:\\sessions\\rollout.jsonl', projectLabel: 'work',
    projectRoot: 'C:\\work', title: '测试会话'
  } } }));
  assert.equal(reordered.id, accepted.id);
  assert.equal(outbox.list().length, 1);
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

test('restart reconciliation cannot block new durable acceptance', async t => {
  const filePath = await createTempOutboxPath();
  const original = new DurableOutbox({ filePath, dispatch: async () => ({ id: 'run' }), schedule: false });
  const previous = await original.enqueue(sampleItem());
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  persisted.items[0].status = 'dispatching';
  await fs.writeFile(filePath, JSON.stringify(persisted), 'utf8');

  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const restored = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { throw new Error('must not resend uncertain item'); },
    reconcile: async () => { started.resolve(); await gate.promise; return { status: 'unknown' }; } });
  t.after(() => { gate.resolve(); restored.close(); });
  const accepting = restored.enqueue(sampleItem({ submissionId: 'phone-2' }));
  let timeout;
  const accepted = await Promise.race([accepting, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('acceptance waited for reconciliation')), 2000);
  })]).finally(() => clearTimeout(timeout));
  assert.equal(accepted.status, 'queued');
  assert.equal(restored.get(previous.id).status, 'uncertain');
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(saved.items.map(item => item.status), ['uncertain', 'queued']);
  const dispatching = restored.dispatchReady();
  await started.promise;
  const third = await restored.enqueue(sampleItem({ submissionId: 'phone-3' }));
  assert.equal(third.status, 'queued');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).items.length, 3);
  gate.resolve();
  await dispatching;
  assert.equal(restored.get(previous.id).status, 'uncertain');
});

test('a confirmed receipt is persisted before a later reconciliation can block', async t => {
  const filePath = await createTempOutboxPath();
  const seed = new DurableOutbox({ filePath, schedule: false, dispatch: async () => ({ id: 'run' }) });
  const first = await seed.enqueue(sampleItem());
  const second = await seed.enqueue(sampleItem({ submissionId: 'phone-2' }));
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const task = { id: 'task-1', codexSessionId: 'thread-a', submissionId: 'phone-1',
    events: [{ taskId: 'task-1', type: 'codex.app_server.turn.started',
      payload: { turn: { id: 'turn-1' } } }] };
  Object.assign(saved.items[0], { status: 'uncertain', resultId: task.id,
    result: { run: task, deliveryPending: true } });
  Object.assign(saved.items[1], { status: 'uncertain', resultId: 'task-2',
    result: { run: { id: 'task-2' }, deliveryPending: true } });
  await fs.writeFile(filePath, JSON.stringify(saved), 'utf8');

  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const strongReceipt = createOutboxReceiptReconciler();
  let logSawPersisted = false;
  const box = new DurableOutbox({ filePath, schedule: false, dispatch: async () => ({ id: 'run' }),
    logger: { write: async (_source, _level, event) => {
      if (event === 'outbox.item.reconciled') {
        const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
        logSawPersisted = disk.items.find(item => item.id === first.id).status === 'submitted';
      }
    } },
    reconcile: async item => {
      if (item.id === second.id) { started.resolve(); await gate.promise; return { status: 'unknown' }; }
      return await strongReceipt(item);
    } });
  t.after(() => { gate.resolve(); box.close(); });
  await box.initialize();
  const pending = box.reconcileUncertainItems();
  try {
    await started.promise;
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const settled = disk.items.find(item => item.id === first.id);
    assert.equal(settled.status, 'submitted');
    assert.equal(settled.result.deliveryPending, false);
    assert.equal(logSawPersisted, true);
    const restarted = new DurableOutbox({ filePath, schedule: false, dispatch: async () => ({ id: 'run' }) });
    await restarted.initialize();
    assert.equal(restarted.get(first.id).status, 'submitted');
    assert.equal(restarted.get(second.id).status, 'uncertain');
    restarted.close();
  } finally {
    gate.resolve();
    await pending;
  }
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

  await restored.dispatchReady();
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

test('legacy result migration keeps every state, payload, identity and unknown item field without dispatch', async t => {
  const filePath = await createTempOutboxPath();
  t.after(() => fs.rm(path.dirname(filePath), { recursive: true, force: true }));
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const statuses = ['queued', 'failed', 'dispatching', 'uncertain', 'held', 'submitted', 'canceled'];
  const items = Array.from({ length: 60 }, (_, index) => {
    const status = statuses[index % statuses.length];
    return { ...sampleItem({ submissionId: `phone-${index}` }), id: `outbox-${index}`, status,
      revision: 4, order: index, attemptCount: 3, retryable: status === 'failed',
      error: status === 'failed' ? 'offline' : '', nextAttemptAt: timestamp,
      lastAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
      legacyExtension: { preserve: index },
      payload: { text: '第一条消息', attachments: [{ name: 'a.png', data: 'data:image/png;base64,fixture' }],
        futureSettings: { mode: 'keep' } }, resultId: `task-${index}`,
      result: { deliveryPending: status !== 'submitted', run: {
        id: `task-${index}`, codexSessionId: 'thread-a', projectId: 'probe',
        submissionId: `phone-${index}`, prompt: '第一条消息', status: 'running',
        deliveryAttempted: true, events: index === 2 ? [
          ...Array.from({ length: 8000 }, () => ({ type: 'codex.output.delta', payload: { text: 'x'.repeat(512) } })),
          { taskId: `task-${index}`, type: 'codex.app_server.turn.started',
            payload: { turn: { id: 'turn-exact' } } }
        ] : []
      } }
    };
  });
  const legacy = JSON.stringify({ version: 1, items });
  await fs.writeFile(filePath, legacy);
  let sends = 0;
  const box = new DurableOutbox({ filePath, schedule: false, maxItems: 50, now: () => now,
    dispatch: async () => { sends++; throw new Error('migration must not dispatch'); },
    reconcile: createOutboxReceiptReconciler() });
  await box.initialize();
  const savedText = await fs.readFile(filePath, 'utf8');
  const saved = JSON.parse(savedText);
  assert.equal(sends, 0);
  assert.equal(saved.items.length, items.length, 'migration must not prune old receipts');
  for (const [index, original] of items.entries()) {
    const actual = saved.items[index];
    assert.equal(actual.status, original.status === 'dispatching' ? 'uncertain' : original.status);
    assert.equal(actual.submissionId, original.submissionId);
    assert.equal(actual.resultId, original.resultId);
    assert.deepEqual(actual.payload, original.payload);
    assert.deepEqual(actual.legacyExtension, original.legacyExtension);
    assert.equal(actual.result.outboxSnapshotVersion, 1);
    assert.equal(actual.result.run.submissionId, original.submissionId);
    if (original.status !== 'dispatching') {
      assert.equal(actual.retryable, original.retryable);
      assert.equal(actual.attemptCount, original.attemptCount);
      assert.equal(actual.error, original.error);
      assert.equal(actual.nextAttemptAt, original.nextAttemptAt);
    }
  }
  assert.ok(savedText.length < legacy.length / 10);
  await box.reconcileUncertainItems();
  assert.equal(box.get('outbox-2').status, 'submitted', 'exact persisted ACK survives migration');
  assert.equal(box.get('outbox-3').status, 'uncertain', 'missing ACK remains uncertain');
  assert.equal(sends, 0);
  assert.equal((await fs.readdir(path.dirname(filePath))).some(name => name.endsWith('.tmp')), false);

  const again = new DurableOutbox({ filePath, schedule: false, now: () => now, dispatch: async () => {} });
  let saves = 0;
  const persist = again.persist.bind(again);
  again.persist = async () => { saves++; await persist(); };
  await again.initialize();
  assert.equal(saves, 0, 'already compact snapshots must not be rewritten on every load');
});

test('legacy explicitly unattempted failure remains eligible for safe backoff after compaction', async t => {
  const filePath = await createTempOutboxPath();
  t.after(() => fs.rm(path.dirname(filePath), { recursive: true, force: true }));
  const seed = new DurableOutbox({ filePath, schedule: false, dispatch: async () => ({ id: 'unused' }) });
  const accepted = await seed.enqueue(sampleItem());
  const legacy = JSON.parse(await fs.readFile(filePath, 'utf8'));
  Object.assign(legacy.items[0], { status: 'dispatching', lastAttemptAt: new Date().toISOString(),
    resultId: 'failed-before-write', result: { deliveryPending: true, run: {
      id: 'failed-before-write', codexSessionId: accepted.threadId, submissionId: accepted.submissionId,
      prompt: accepted.text, status: 'failed', deliveryAttempted: false, error: 'offline',
      events: [{ type: 'task.failed', payload: { output: 'discard' } }]
    } } });
  await fs.writeFile(filePath, JSON.stringify(legacy));
  let sends = 0;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { sends++; }, reconcile: createOutboxReceiptReconciler() });
  await box.initialize();
  await box.reconcileUncertainItems();
  const failed = box.get(accepted.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, true);
  assert.equal(failed.attemptCount, 1);
  assert.ok(failed.nextAttemptAt);
  assert.equal(sends, 0);
});

test('new dispatch never clones or persists the full run event history', async t => {
  const filePath = await createTempOutboxPath();
  t.after(() => fs.rm(path.dirname(filePath), { recursive: true, force: true }));
  const run = { id: 'task-big', codexSessionId: 'thread-a', submissionId: 'phone-1',
    prompt: '第一条消息', status: 'running', events: Array.from({ length: 12_000 }, () => ({
      type: 'codex.output.delta', payload: { text: 'discard-output'.repeat(100) }
    })) };
  Object.defineProperty(run, 'output', { enumerable: true,
    get() { throw new Error('outbox must not clone runtime output'); } });
  let sends = 0;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { sends++; return { run, deliveryPending: true }; } });
  const item = await box.enqueue(sampleItem({ payload: { attachments: [{ name: 'a.png', source: 'keep' }] } }));
  await box.dispatchReady();
  await box.dispatchReady();
  const savedText = await fs.readFile(filePath, 'utf8');
  const saved = JSON.parse(savedText).items[0];
  assert.equal(saved.status, 'dispatching');
  assert.equal(saved.resultId, run.id);
  assert.equal(saved.result.outboxSnapshotVersion, 1);
  assert.deepEqual(saved.result.run.events, []);
  assert.deepEqual(saved.payload.attachments, item.payload.attachments);
  assert.ok(savedText.length < 5000);
  assert.equal(sends, 1);
});

test('an early ACK is checked after task binding while another lane dispatch is still blocked', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const slowGate = Promise.withResolvers();
  const reconciled = Promise.withResolvers();
  let fastId;
  let slowFinished = false;
  let pending;
  const strongReceipt = createOutboxReceiptReconciler();
  const box = new DurableOutbox({ filePath, schedule: false,
    logger: { write: async (_source, _level, event) => { if (event === 'outbox.item.reconciled') reconciled.resolve(); } },
    reconcile: strongReceipt,
    dispatch: async item => {
      if (item.threadId === 'slow-thread') {
        await slowGate.promise;
        slowFinished = true;
        return { id: 'slow-receipt' };
      }
      box.requestReceiptReconciliation();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(box.get(fastId).resultId, '', 'notification arrives before dispatch binds task id');
      return { deliveryPending: true, run: { id: 'fast-task', codexSessionId: item.threadId,
        submissionId: item.submissionId, status: 'running', events: [{ taskId: 'fast-task',
          type: 'codex.app_server.turn.started', payload: { turn: { id: 'fast-turn' } } }] } };
    }
  });
  t.after(async () => { box.close(); slowGate.resolve(); await pending; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  fastId = (await box.enqueue(sampleItem())).id;
  await box.enqueue(sampleItem({ threadId: 'slow-thread', submissionId: 'slow' }));
  box.scheduleEnabled = true;
  pending = box.dispatchReady();
  await reconciled.promise;
  assert.equal(box.get(fastId).status, 'submitted');
  assert.equal(slowFinished, false);
  assert.ok(box.dispatchPromise, 'receipt reconciliation does not wait for slow dispatchPromise');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).items.find(item => item.id === fastId).status, 'submitted');
  slowGate.resolve();
  await pending;
});

test('receipt wake storms coalesce and a wake during reconciliation persist requests one more pass', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const saving = Promise.withResolvers();
  const saveGate = Promise.withResolvers();
  const reconciled = Promise.withResolvers();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => ({ deliveryPending: true, run: { id: 'task-1' } }),
    logger: { write: async (_source, _level, event) => { if (event === 'outbox.item.reconciled') reconciled.resolve(); } },
    reconcile: async () => {
      maximumActive = Math.max(maximumActive, ++active);
      const receipt = ++calls === 1 ? { status: 'uncertain' }
        : { status: 'submitted', result: { id: 'receipt-1' } };
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return receipt;
    }
  });
  t.after(async () => { box.close(); saveGate.resolve(); await box.reconcilePromise; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  const item = await box.enqueue(sampleItem());
  await box.dispatchReady();
  const persist = box.persist.bind(box);
  box.persist = async () => {
    await persist();
    if (calls === 1) { saving.resolve(); await saveGate.promise; }
  };
  box.scheduleEnabled = true;
  for (let index = 0; index < 1000; index++) box.requestReceiptReconciliation();
  await saving.promise;
  assert.equal(calls, 1);
  for (let index = 0; index < 1000; index++) box.requestReceiptReconciliation();
  saveGate.resolve();
  await reconciled.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(box.get(item.id).status, 'submitted');
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
});

test('ACK wake during dispatch-result persist is not lost when dispatch finally schedules fallback', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const bound = Promise.withResolvers();
  const resultSaveGate = Promise.withResolvers();
  const reconciled = Promise.withResolvers();
  let pending;
  let ack = false;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => ({ deliveryPending: true, run: { id: 'task-1' } }),
    logger: { write: async (_source, _level, event) => { if (event === 'outbox.item.reconciled') reconciled.resolve(); } },
    reconcile: async () => ack ? { status: 'submitted', result: { id: 'receipt-1' } } : { status: 'unknown' }
  });
  t.after(async () => { box.close(); resultSaveGate.resolve(); await pending; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  const item = await box.enqueue(sampleItem());
  const persist = box.persist.bind(box);
  let gated = false;
  box.persist = async () => {
    await persist();
    if (!gated && box.get(item.id).status === 'dispatching' && box.get(item.id).resultId) {
      gated = true; bound.resolve(); await resultSaveGate.promise;
    }
  };
  box.scheduleEnabled = true;
  pending = box.dispatchReady();
  await bound.promise;
  ack = true;
  box.requestReceiptReconciliation();
  await reconciled.promise;
  assert.equal(box.get(item.id).status, 'submitted');
  assert.ok(box.dispatchPromise);
  resultSaveGate.resolve();
  await pending;
  assert.equal(box.get(item.id).status, 'submitted');
  box.close();
  assert.equal(box.timer, null);
});

test('close suppresses queued receipt wakes and rescheduling from in-flight dispatch', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const started = Promise.withResolvers();
  const dispatchGate = Promise.withResolvers();
  let calls = 0;
  let pending;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => { started.resolve(); await dispatchGate.promise;
      return { deliveryPending: true, run: { id: 'task-1' } }; },
    reconcile: async () => { calls++; return { status: 'unknown' }; }
  });
  t.after(async () => { box.close(); dispatchGate.resolve(); await pending; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  await box.enqueue(sampleItem());
  box.scheduleEnabled = true;
  pending = box.dispatchReady();
  await started.promise;
  box.requestReceiptReconciliation();
  box.close();
  dispatchGate.resolve();
  await pending;
  box.requestReceiptReconciliation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(box.timer, null);
  assert.equal(box.receiptReconciliationRequested, false);
  assert.equal(box.receiptWakeScheduled, false);
});

test('receipt wake cannot reconcile a retry with the preceding attempt result before new binding', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const retryStarted = Promise.withResolvers();
  const retryGate = Promise.withResolvers();
  const reconciled = Promise.withResolvers();
  let sends = 0;
  let pending;
  const readIds = [];
  const box = new DurableOutbox({ filePath, schedule: false,
    logger: { write: async (_source, _level, event) => { if (event === 'outbox.item.reconciled') reconciled.resolve(); } },
    dispatch: async () => {
      if (++sends === 1) return { deliveryPending: true, run: { id: 'old-task' } };
      retryStarted.resolve();
      await retryGate.promise;
      return { deliveryPending: true, run: { id: 'new-task' } };
    },
    reconcile: async item => {
      readIds.push(item.resultId);
      return item.resultId === 'old-task'
        ? { status: 'failed', retryable: true, evidence: 'delivery_not_attempted', error: 'offline' }
        : { status: 'submitted', result: { run: { id: 'new-task' }, deliveryPending: false } };
    }
  });
  t.after(async () => { box.close(); retryGate.resolve(); await pending; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  const item = await box.enqueue(sampleItem());
  await box.dispatchReady();
  await box.dispatchReady();
  assert.equal(box.get(item.id).status, 'failed');
  await box.retry(item.id);
  const previousReads = readIds.length;
  box.scheduleEnabled = true;
  pending = box.dispatchReady();
  await retryStarted.promise;
  box.requestReceiptReconciliation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readIds.length, previousReads);
  assert.equal(box.get(item.id).status, 'dispatching');
  assert.equal(box.get(item.id).resultId, 'old-task');
  retryGate.resolve();
  await reconciled.promise;
  await pending;
  assert.equal(box.get(item.id).status, 'submitted');
  assert.equal(box.get(item.id).resultId, 'new-task');
  assert.equal(sends, 2);
  assert.equal(readIds.at(-1), 'new-task');
  assert.equal(box.pendingDispatchItemIds.size, 0);
});

test('close discards additional wakes received during an in-flight receipt read', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const started = Promise.withResolvers();
  const receiptGate = Promise.withResolvers();
  let calls = 0;
  const box = new DurableOutbox({ filePath, schedule: false,
    dispatch: async () => ({ deliveryPending: true, run: { id: 'task-1' } }),
    reconcile: async () => { calls++; started.resolve(); await receiptGate.promise; return { status: 'unknown' }; }
  });
  t.after(async () => { box.close(); receiptGate.resolve(); await box.reconcilePromise; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  await box.enqueue(sampleItem());
  await box.dispatchReady();
  box.scheduleEnabled = true;
  box.requestReceiptReconciliation();
  await started.promise;
  box.requestReceiptReconciliation();
  box.close();
  receiptGate.resolve();
  await box.reconcilePromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(box.timer, null);
  assert.equal(box.receiptReconciliationRequested, false);
});

test('failed migration consumes a receipt wake without starving the event loop and a later wake can recover', { timeout: 5000 }, async t => {
  const filePath = await createTempOutboxPath();
  const timestamp = new Date().toISOString();
  const legacy = { ...sampleItem(), id: 'legacy', status: 'uncertain', resultId: 'task-1',
    createdAt: timestamp, updatedAt: timestamp, lastAttemptAt: timestamp,
    result: { deliveryPending: true, run: { id: 'task-1', codexSessionId: 'thread-a',
      submissionId: 'phone-1', status: 'running', events: [{ taskId: 'task-1',
        type: 'codex.app_server.turn.started', payload: { turn: { id: 'turn-1' } } }] } } };
  await fs.writeFile(filePath, JSON.stringify({ version: 1, items: [legacy] }));
  const failed = Promise.withResolvers();
  const recovered = Promise.withResolvers();
  let sends = 0;
  let loads = 0;
  let rejectSave = true;
  const box = new DurableOutbox({ filePath,
    dispatch: async () => { sends++; throw new Error('must not resend'); },
    reconcile: createOutboxReceiptReconciler(),
    logger: { write: async (_source, _level, event) => {
      if (event === 'outbox.reconcile.failed') failed.resolve();
      if (event === 'outbox.item.reconciled') recovered.resolve();
    } }
  });
  t.after(async () => { box.close(); await box.reconcilePromise; await fs.rm(path.dirname(filePath), { recursive: true, force: true }); });
  const persist = box.persist.bind(box);
  box.persist = async () => {
    if (rejectSave) throw Object.assign(new Error('fixture migration write denied'), { code: 'EACCES' });
    return await persist();
  };
  const load = box.load.bind(box);
  box.load = async () => {
    // Bound a broken microtask-loop regression so it fails without hanging the
    // test runner's own timeout and setImmediate callbacks.
    if (++loads > 20) { box.close(); throw new Error('receipt wake spun on failed initialize'); }
    return await load();
  };
  box.requestReceiptReconciliation();
  await failed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(box.receiptReconciliationRequested, false);
  assert.equal(box.receiptWakeRunning, false);
  assert.equal(box.timer, null);
  assert.equal(sends, 0);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).items[0].result.outboxSnapshotVersion, undefined);
  rejectSave = false;
  box.requestReceiptReconciliation();
  await recovered.promise;
  assert.equal(loads, 2);
  assert.equal(box.get(legacy.id).status, 'submitted');
  assert.equal(sends, 0);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).items[0].status, 'submitted');
});
