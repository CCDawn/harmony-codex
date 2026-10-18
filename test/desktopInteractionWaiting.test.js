import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDesktopCdpAdapter, desktopWaitingForInteraction } from '../src/codexDesktopCdpAdapter.js';

test('recognizes official human-interaction flags and only those flags', () => {
  for (const status of [{ type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] }, 'waiting_input', 'waiting_approval']) {
    assert.equal(desktopWaitingForInteraction(status), true);
  }
  for (const status of ['completed', 'inProgress', { type: 'active', activeFlags: ['compacting'] },
    { type: 'idle', activeFlags: ['waitingOnApproval'] }]) {
    assert.equal(desktopWaitingForInteraction(status), false);
  }
});

test('confirmed pending decision survives short idle deadline and completes after answer', async () => {
  const adapter = new CodexDesktopCdpAdapter({ client: {}, idleTimeoutMs: 50 });
  let reads = 0;
  adapter.readRecentThread = async () => {
    reads++;
    return { thread: { id: 'thread-1', status: reads === 1
      ? { type: 'active', activeFlags: ['waitingOnApproval'] } : { type: 'idle' },
      turns: [{ id: 'turn-1', status: reads === 1 ? 'inProgress' : 'completed', items: [] }] }};
  };
  const result = await adapter.waitForDesktopTurnCompletion({
    notifications: [], threadId: 'thread-1', turnId: 'turn-1', emit() {}, timeoutMs: 20
  });
  assert.equal(result.turn.status, 'completed');
  assert.equal(reads, 2);
});

test('lost desktop connection does not preserve a human-wait lease indefinitely', async () => {
  const adapter = new CodexDesktopCdpAdapter({ client: {}, idleTimeoutMs: 50 });
  let reads = 0;
  adapter.readRecentThread = async () => {
    if (++reads > 1) throw new Error('disconnected');
    return { thread: { id: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] }};
  };
  await assert.rejects(adapter.waitForDesktopTurnCompletion({
    notifications: [], threadId: 'thread-1', turnId: 'turn-1', emit() {}, timeoutMs: 20
  }), /超时/);
  assert.ok(reads > 1);
});
