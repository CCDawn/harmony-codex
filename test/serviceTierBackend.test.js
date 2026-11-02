import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { normalizeServiceTier, serviceTierParams } from '../src/sessionSettingsStore.js';

test('speed values distinguish inheritance from standard and preserve dynamic official ids', () => {
  for (const input of [undefined, null, '', 'auto', 'inherit']) {
    assert.equal(normalizeServiceTier(input), '');
    assert.deepEqual(serviceTierParams(input), {});
  }
  assert.deepEqual(serviceTierParams('standard'), { serviceTier: 'default' });
  assert.deepEqual(serviceTierParams('default'), { serviceTier: 'default' });
  assert.deepEqual(serviceTierParams('priority'), { serviceTier: 'priority' });
  assert.deepEqual(serviceTierParams('future-tier'), { serviceTier: 'future-tier' });
  assert.throws(() => normalizeServiceTier('bad tier'), { statusCode: 400 });
});

for (const serviceTier of ['', 'default', 'priority']) {
  test(`desktop start/resume/turn carry the explicit speed only: ${serviceTier || 'inherit'}`, async () => {
    const calls = [];
    const adapter = new CodexDesktopCdpAdapter({ client: { async request(method, params) {
      calls.push({ method, params });
      return { thread: { id: 'test-tier', cwd: process.cwd() }, turn: { id: 'turn-tier' } };
    } } });
    try {
      const task = { codexSessionId: 'test-tier', prompt: 'synthetic only', serviceTier };
      await adapter.startThread(task, { root: process.cwd() }, () => {});
      await adapter.resumeThread(task, { root: process.cwd() }, () => {});
      await adapter.startTurn({ id: 'test-tier' }, task);
      assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'thread/resume', 'turn/start']);
      for (const { params } of calls) {
        assert.equal(Object.hasOwn(params, 'serviceTier'), Boolean(serviceTier));
        if (serviceTier) assert.equal(params.serviceTier, serviceTier);
      }
    } finally { adapter.close(); }
  });
}

test('desktop settings event draining works while idle and still delivers active subscriptions', async () => {
  const queued = [];
  const notifications = [];
  const adapter = new CodexDesktopCdpAdapter({ client: { async drainNotifications() { return queued.splice(0); } } });
  try {
    assert.equal(await adapter.getThreadSettings('one'), null);
    queued.push({ method: 'thread/settings/updated', params: { threadId: 'one', threadSettings: { serviceTier: 'priority' } } });
    assert.equal((await adapter.getThreadSettings('one')).serviceTier, 'priority');
    assert.equal(await adapter.getThreadSettings('other'), null);
    adapter.notificationSubscriptions.set('test', { threadId: 'one', notifications, emit() {} });
    queued.push({ method: 'thread/settings/updated', params: { threadId: 'one', threadSettings: { serviceTier: null } } });
    assert.equal((await adapter.getThreadSettings('one')).serviceTier, null);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, 'thread/settings/updated');
  } finally { adapter.close(); }
});
