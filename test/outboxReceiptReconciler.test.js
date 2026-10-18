import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurableOutbox } from '../src/durableOutbox.js';
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

function imageReceiptFixture(overrides = {}) {
  const at = new Date().toISOString();
  const text = '检查图片\n![手机端图片](C:/probe/mobile-image.png)';
  const item = sampleItem({ text, lastAttemptAt: at, resultId: 'task-1', result: { deliveryPending: true } });
  const task = { id: 'task-1', codexSessionId: item.threadId, status: 'running', events: [{
    type: 'codex.session_file.cursor_captured',
    payload: { sessionId: item.threadId, filePath: 'C:/probe/rollout.jsonl', offset: 100 }
  }] };
  const record = {
    timestamp: at, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text },
      { type: 'input_text', text: '<image name=[Image #1] path="C:/probe/mobile-image.png">' },
      { type: 'input_image', image_url: 'data:image/png;base64,fixture' },
      { type: 'input_text', text: '</image>' }
    ] }
  };
  const records = [record];
  const sessions = {
    getSession: async () => ({ entries: [{ role: 'user', text: `${text}\n![桌面端图片](C:/probe/rendered.png)`, timestamp: at }] }),
    readSessionRecordsAfterCursor: async cursor => {
      assert.deepEqual(cursor, task.events[0].payload);
      return records;
    }
  };
  return { item, task, record, records, sessions, ...overrides };
}

test('a current image submission is confirmed from its canonical user input before display formatting', async () => {
  const fixture = imageReceiptFixture();
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => fixture.task }, sessions: fixture.sessions });
  assert.equal((await reconcile(fixture.item)).status, 'submitted');
});

test('canonical image receipt rejects old input, nested file text, other roles and malformed image wrappers', async () => {
  for (const mutate of [
    f => { f.record.timestamp = new Date(Date.parse(f.item.lastAttemptAt) - 1).toISOString(); },
    f => { f.record.payload.content[0].text = `<file>\n${f.item.text}\n</file>`; },
    f => { f.record.payload.role = 'assistant'; },
    f => { f.record.type = 'event_msg'; },
    f => { f.record.payload.type = 'function_call_output'; },
    f => { f.task.events[0].payload.sessionId = 'another-thread'; },
    f => { f.task.id = 'another-task'; },
    f => { f.record.payload.content[1].text = 'unrelated file contents'; },
    f => { f.record.payload.content[1].text = '<image name=[Image #1] path="C:/probe/another-image.png">'; },
    f => { f.record.payload.content[1].text = '<image name=[Image #2] path="C:/probe/mobile-image.png">'; },
    f => { f.record.payload.content[3].text = '</image>\nadditional user content'; },
    f => { f.record.payload.content.push(...f.record.payload.content.slice(1)); }
  ]) {
    const fixture = imageReceiptFixture();
    mutate(fixture);
    const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => fixture.task }, sessions: fixture.sessions });
    assert.equal((await reconcile(fixture.item)).status, 'unknown');
  }
});

test('canonical image receipt stays uncertain without a task-owned cursor and never reads an arbitrary file', async () => {
  const fixture = imageReceiptFixture();
  fixture.task.events = [];
  fixture.item.lastAttemptAt = new Date(Date.now() - 100_000).toISOString();
  let reads = 0;
  fixture.sessions.readSessionRecordsAfterCursor = async () => { reads++; return fixture.records; };
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => fixture.task }, sessions: fixture.sessions });
  assert.equal((await reconcile(fixture.item)).status, 'uncertain');
  assert.equal(reads, 0);
});

test('image receipt reconciliation and duplicate submission never dispatch the accepted message again', async t => {
  const fixture = imageReceiptFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-image-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  let available = false;
  fixture.sessions.readSessionRecordsAfterCursor = async () => available ? fixture.records : [];
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => fixture.task }, sessions: fixture.sessions });
  const outbox = new DurableOutbox({ filePath: path.join(root, 'outbox.json'), schedule: false, reconcile,
    dispatch: async () => { calls++; return { run: fixture.task, deliveryPending: true }; } });
  t.after(() => outbox.close());
  const accepted = await outbox.enqueue(fixture.item);
  await outbox.dispatchReady();
  assert.equal(outbox.get(accepted.id).status, 'dispatching');
  await outbox.dispatchReady();
  assert.equal(calls, 1);
  available = true;
  fixture.record.timestamp = new Date(Date.parse(outbox.get(accepted.id).lastAttemptAt) + 1).toISOString();
  await outbox.dispatchReady();
  assert.equal(outbox.get(accepted.id).status, 'submitted');
  const duplicate = await outbox.enqueue(fixture.item);
  assert.equal(duplicate.id, accepted.id);
  await outbox.dispatchReady();
  assert.equal(calls, 1);
});

test('after restart an image receipt uses the persisted cursor without reviving the stale running task', async () => {
  const fixture = imageReceiptFixture();
  fixture.item.result.run = fixture.task;
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => null }, sessions: fixture.sessions });
  const receipt = await reconcile(fixture.item);
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.result.deliveryPending, false);
  assert.equal(receipt.result.run, undefined);
  assert.equal(receipt.result.threadId, fixture.item.threadId);
  assert.equal(receipt.result.submissionId, fixture.item.submissionId);
  assert.equal(receipt.result.observedAt, fixture.record.timestamp);
  assert.equal(fixture.task.status, 'running');
});

test('a persisted running snapshot without the official image input remains uncertain after restart', async () => {
  const fixture = imageReceiptFixture();
  fixture.item.result.run = fixture.task;
  fixture.records.length = 0;
  const reconcile = createOutboxReceiptReconciler({ sessions: fixture.sessions });
  assert.equal((await reconcile(fixture.item)).status, 'uncertain');
});

test('persisted image receipt rejects wrong task, session, cursor identity and missing cursor without reading', async () => {
  for (const mutate of [
    f => { f.task.id = 'another-task'; },
    f => { f.task.codexSessionId = 'another-thread'; },
    f => { delete f.task.codexSessionId; },
    f => { f.task.events[0].payload.sessionId = 'another-thread'; },
    f => { f.task.events[0].taskId = 'another-task'; },
    f => { f.task.events[0].payload.offset = -1; },
    f => { f.task.events[0].payload.offset = 'invalid'; },
    f => { f.task.events[0].payload.offset = ''; },
    f => { delete f.task.events[0].payload.filePath; },
    f => { f.task.events = []; }
  ]) {
    const fixture = imageReceiptFixture();
    fixture.item.result.run = fixture.task;
    mutate(fixture);
    let reads = 0;
    fixture.sessions.readSessionRecordsAfterCursor = async () => { reads++; return fixture.records; };
    const reconcile = createOutboxReceiptReconciler({ sessions: fixture.sessions });
    assert.equal((await reconcile(fixture.item)).status, 'uncertain');
    assert.equal(reads, 0);
  }
});

test('restart reconciles a persisted image submission once without redispatching on duplicate requests', async t => {
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
    dispatch: async () => { calls++; throw new Error('confirmed input must not dispatch again'); } });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.get(accepted.id).status, 'submitted');
  assert.equal(restored.get(accepted.id).result.run, undefined);
  await restored.enqueue(fixture.item);
  await restored.dispatchReady();
  assert.equal(calls, 1);
});

test('desktop receipt requires this exact submission in official history, not task creation or an older identical prompt', async () => {
  const at = new Date().toISOString();
  const task = { id: 'task-1', status: 'running' };
  const entries = [{ role: 'user', text: '远程提交内容', timestamp: new Date(Date.parse(at) - 1).toISOString() }];
  const reconcile = createOutboxReceiptReconciler({ store: { getTask: () => task }, sessions: { getSession: async () => ({ entries }) } });
  const item = sampleItem({ lastAttemptAt: at, resultId: 'task-1', result: { run: task, deliveryPending: true } });
  assert.equal((await reconcile(item)).status, 'unknown');
  entries.push({ role: 'user', text: 'another insertion', timestamp: at });
  assert.equal((await reconcile(item)).status, 'unknown');
  entries.push({ role: 'user', text: item.text, timestamp: at });
  const receipt = await reconcile(item);
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.result.run.id, task.id);
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

test('outbox receipt reconciler recognizes a matching CDP session message after dispatch began', async () => {
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
  assert.equal(result.status, 'submitted');
  assert.equal(result.result.threadId, 'thread-a');
  assert.equal(result.evidence, 'session_user_message');
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
