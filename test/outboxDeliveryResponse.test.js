import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOutboxDispatchResult } from '../src/outboxDeliveryResponse.js';

function item() {
  return { threadId: 'thread-a', submissionId: 'phone-1', resultId: 'task-a',
    result: { outboxSnapshotVersion: 1, deliveryPending: false,
      run: { id: 'task-a', codexSessionId: 'thread-a', status: 'running' } } };
}

test('delivery responses obtain current task data rather than the compact snapshot', () => {
  const live = { id: 'task-a', codexSessionId: 'thread-a', submissionId: 'phone-1', status: 'completed',
    events: [{ type: 'task.completed' }] };
  const result = resolveOutboxDispatchResult(item(), { store: { getTask: () => live } });
  assert.equal(result.run, live);
  assert.equal(result.outboxSnapshotVersion, undefined);
});

test('restarted, mismatched and steered runs remain delivery-only receipts', () => {
  for (const run of [undefined,
    { id: 'other', codexSessionId: 'thread-a', submissionId: 'phone-1' },
    { id: 'task-a', codexSessionId: 'thread-b', submissionId: 'phone-1' },
    { id: 'task-a', codexSessionId: 'thread-a', submissionId: 'previous' }]) {
    const result = resolveOutboxDispatchResult(item(), { store: { getTask: () => run },
      threadService: { getRun() { throw new Error('not loaded'); } } });
    assert.equal(result.run, undefined);
    assert.equal(result.deliveryPending, false);
  }
});

test('new-thread and app-server receipts hydrate only the matching owned run', () => {
  const queued = item(); queued.threadId = '';
  queued.result.run = { id: 'task-a', createdCodexSessionId: 'thread-new' };
  const run = { id: 'task-a', createdCodexSessionId: 'thread-new', submissionId: 'phone-1' };
  assert.equal(resolveOutboxDispatchResult(queued, { threadService: { getRun: () => run } }).run, run);
  assert.equal(resolveOutboxDispatchResult({ result: { id: 'legacy' } }).id, 'legacy');
});
