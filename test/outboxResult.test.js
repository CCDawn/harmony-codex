import assert from 'node:assert/strict';
import test from 'node:test';
import { compactOutboxResult } from '../src/outboxResult.js';
import { createOutboxReceiptReconciler } from '../src/outboxReceiptReconciler.js';

test('receipt snapshot ignores large output before cloning and retains the exact trailing steer ACK', async () => {
  const item = { kind: 'existing_thread', threadId: 'thread-a', submissionId: 'second',
    resultId: 'task-1', text: 'second input', lastAttemptAt: new Date().toISOString() };
  const run = { id: item.resultId, codexSessionId: item.threadId, submissionId: 'first',
    projectId: 'project-a', prompt: item.text, deliveryAttempted: true, status: 'running',
    events: Array.from({ length: 20_000 }, (_, index) => ({ type: 'codex.output.delta',
      payload: { text: `${index}:${'x'.repeat(512)}` } })) };
  run.events.push(
    { taskId: run.id, type: 'codex.app_server.turn.started', payload: { turn: { id: 'turn-1' } } },
    { taskId: run.id, type: 'task.guidance.accepted', payload: { submissionId: 'other', turnId: 'turn-1' } },
    { taskId: run.id, type: 'task.guidance.accepted', createdAt: '2026-11-01T00:00:00Z',
      payload: { submissionId: item.submissionId, turnId: 'turn-1', text: 'discard this body' } },
    { taskId: run.id, type: 'task.guidance.accepted', payload: { submissionId: item.submissionId, turnId: '' } },
    { taskId: 'other-task', type: 'task.guidance.accepted', payload: { submissionId: item.submissionId, turnId: 'wrong-turn' } }
  );
  Object.defineProperty(run, 'output', { enumerable: true, get() { throw new Error('must not clone output'); } });
  const result = { run, deliveryPending: true,
    thread: { id: 'thread-a', title: 'A thread', entries: [{ text: 'discard transcript' }] } };
  item.result = compactOutboxResult(result, item);
  assert.equal(item.result.outboxSnapshotVersion, 1);
  assert.equal(item.result.run.submissionId, 'first');
  assert.equal(item.result.run.events.length, 2);
  assert.ok(JSON.stringify(item.result).length < 1500);
  assert.deepEqual(item.result.thread, { id: 'thread-a', title: 'A thread' });
  const receipt = await createOutboxReceiptReconciler()(item);
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.evidence, 'rpc_acknowledgement');
  assert.deepEqual(compactOutboxResult(item.result, item), item.result);
});

test('flat App Server runs and thread envelopes keep identity without transcript or output', () => {
  const result = { id: 'run-1', threadId: 'thread-a', submissionId: 'send-a', projectId: 'project-a',
    prompt: 'new prompt', status: 'running', deliveryAttempted: false, error: null,
    createdAt: '2026-11-01T00:00:00Z', activeCodexTurnId: 'turn-1',
    events: [{ taskId: 'run-1', type: 'codex.turn.started', payload: {
      turn: { id: 'turn-1', status: 'inProgress', items: [{ text: 'discard' }] } } }],
    summary: { text: 'discard' }, output: 'discard' };
  const compact = compactOutboxResult(result, { submissionId: 'send-a' });
  assert.equal(compact.id, result.id);
  assert.equal(compact.deliveryAttempted, false);
  assert.equal(compact.prompt, result.prompt);
  assert.equal(compact.error, null);
  assert.equal(compact.output, undefined);
  assert.equal(compact.summary, undefined);
  assert.deepEqual(compact.events[0].payload, { turn: { id: 'turn-1', status: 'inProgress' } });
  assert.deepEqual(compactOutboxResult({ thread: { id: 'new-thread', entries: ['discard'] }, run: null }),
    { outboxSnapshotVersion: 1, thread: { id: 'new-thread' }, run: null });
  assert.equal(compactOutboxResult(null), null);
});

test('compaction retains disqualifying attempt evidence and cannot turn another submission ACK into a receipt', async () => {
  const item = { kind: 'existing_thread', threadId: 'thread-a', submissionId: 'second',
    resultId: 'task-1', text: 'second', lastAttemptAt: new Date().toISOString() };
  item.result = compactOutboxResult({ deliveryPending: true, run: {
    id: item.resultId, codexSessionId: item.threadId, submissionId: 'first', prompt: item.text,
    status: 'failed', deliveryAttempted: false, error: 'ambiguous failure', events: [
      { taskId: item.resultId, type: 'codex.app_server.turn.started', payload: { turn: { id: 'turn-1' } } },
      { taskId: item.resultId, type: 'task.guidance.accepted', payload: { submissionId: 'first', turnId: 'turn-1' } },
      { taskId: item.resultId, type: 'codex.delivery.attempted', payload: { threadId: item.threadId } },
      { taskId: item.resultId, type: 'codex.app_server.turn.steered', payload: { turnId: 'turn-1', submissionId: 'first' } }
    ]
  } }, item);
  const receipt = await createOutboxReceiptReconciler()(item);
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.retryable, undefined);
  assert.equal(item.result.run.events.length, 3);
});
