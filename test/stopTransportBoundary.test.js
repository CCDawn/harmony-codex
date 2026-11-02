import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDesktopCdpClient } from '../src/codexDesktopCdpClient.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { DesktopScriptBridge } from '../src/desktopScriptBridge.js';

async function pause(ms = 15) { return await new Promise(resolve => setTimeout(resolve, ms)); }

test('CDP checks stop after connecting and before the actual write', async () => {
  let release;
  let stopped = false;
  let writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new CodexDesktopCdpClient();
  client.ensureConnected = async () => await gate;
  client.evaluate = async () => { writes += 1; return {}; };
  const pending = client.request('turn/start', { threadId: 'thread' }, { shouldStop: () => stopped });
  stopped = true;
  release();
  await assert.rejects(pending, error => error.code === 'CODEX_USER_STOP_REQUESTED' && error.deliveryAttempted === false);
  assert.equal(writes, 0);
});

test('script bridge drops a timed out command that was never dequeued', async () => {
  const bridge = new DesktopScriptBridge({ requestTimeoutMs: 10, pollTimeoutMs: 10 });
  bridge.connect({ scriptId: 'script', currentSessionId: 'thread' });
  await assert.rejects(bridge.request('turn/start', { threadId: 'thread' }), error =>
    error.code === 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT' && error.deliveryAttempted === false);
  const commands = await bridge.poll({ scriptId: 'script', currentSessionId: 'thread' });
  assert.deepEqual(commands, []);
  bridge.reset();
});

test('script poll cancels a queued write after a stop before dequeue', async () => {
  const bridge = new DesktopScriptBridge({ requestTimeoutMs: 100, pollTimeoutMs: 10 });
  bridge.connect({ scriptId: 'script', currentSessionId: 'thread' });
  let stopped = false;
  let dispatched = 0;
  const pending = bridge.request('turn/steer', { threadId: 'thread' }, { shouldStop: () => stopped, onDispatch: () => dispatched++ });
  stopped = true;
  const commands = await bridge.poll({ scriptId: 'script', currentSessionId: 'thread' });
  await assert.rejects(pending, error => error.code === 'CODEX_USER_STOP_REQUESTED' && error.deliveryAttempted === false);
  assert.deepEqual(commands, []);
  assert.equal(dispatched, 0);
  bridge.reset();
});

test('script command already dequeued remains uncertain on timeout', async () => {
  const bridge = new DesktopScriptBridge({ requestTimeoutMs: 10 });
  bridge.connect({ scriptId: 'script', currentSessionId: 'thread' });
  let dispatched = 0;
  const pending = bridge.request('turn/start', { threadId: 'thread' }, { onDispatch: () => dispatched++ });
  const commands = await bridge.poll({ scriptId: 'script', currentSessionId: 'thread' });
  assert.equal(commands.length, 1);
  assert.equal(dispatched, 1);
  await assert.rejects(pending, error => error.code === 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT' && error.deliveryAttempted === true);
  bridge.reset();
});

test('adapter carries the stop guard through CDP connection for turn/start and steer', async () => {
  let release;
  let stopped = false;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const client = new CodexDesktopCdpClient();
  client.ensureConnected = async () => await gate;
  client.evaluate = async () => { writes += 1; return {}; };
  const adapter = new CodexDesktopCdpAdapter({ client });
  const pending = adapter.startTurn({ id: 'thread' }, { prompt: 'p' }, () => stopped);
  stopped = true;
  release();
  await assert.rejects(pending, { code: 'CODEX_USER_STOP_REQUESTED' });
  assert.equal(writes, 0);
});
