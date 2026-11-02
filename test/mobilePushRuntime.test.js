import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createMobilePushRuntime, pairedPushInstallationId } from '../src/mobilePushRuntime.js';
import { MobilePushStore } from '../src/mobilePushStore.js';

const installationId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333';
const nextTurnId = '44444444-4444-4444-8444-444444444444';
const logger = { async write() {} };

async function harness(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-push-runtime-'));
  const store = new MobilePushStore({ filePath: path.join(root, 'push.json') });
  const callbacks = new Map(), sent = [];
  let turn = { id: turnId, status: 'completed' };
  const config = { repoRoot: root, projects: [], outboxEnabled: false, desktopLiveDiagnostics: false, logger,
    mobilePushStore: store, mobilePushReadTurn: async () => turn, mobilePushReadRequests: async () => [],
    mobilePushSubscribe(id, callback) { callbacks.set(id, callback); return { stop() { callbacks.delete(id); } }; },
    ...overrides };
  const runtime = createMobilePushRuntime({ config, logger });
  t.after(async () => { runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, config, runtime, callbacks, sent, setTurn(value) { turn = value; } };
}
const body = () => ({ installationId, token: 'PRIVATE_PUSH_TOKEN', threadIds: [threadId] });
const master = { kind: 'master' };

test('unconfigured push reports setup and never claims an enabled provider', async t => {
  const h = await harness(t);
  await h.runtime.start();
  const result = await h.runtime.register(master, body());
  assert.equal(result.configured, false);
  assert.equal(result.registration.ready, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PUSH_TOKEN'));
  assert.equal(h.callbacks.size, 0);
  assert.deepEqual((await h.store.list())[0].baselineTurns[threadId], [turnId]);
});

test('paired auth chooses its own stable registration and cannot delete another device', async t => {
  const h = await harness(t);
  const device = { kind: 'device', deviceId: 'dev_fixture_a' };
  const result = await h.runtime.register(device, body());
  assert.equal(result.registration.id, pairedPushInstallationId(device.deviceId));
  assert.notEqual(result.registration.id, installationId);
  await assert.rejects(h.runtime.remove({ kind: 'device', deviceId: 'dev_fixture_b' }, result.registration.id), { statusCode: 403 });
  await h.runtime.revokeDevice(device.deviceId);
  assert.deepEqual(await h.store.list(), []);
});

test('deleting a registration waits for a slow baseline POST and remains deleted', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const h = await harness(t, { mobilePushReadTurn: async () => { entered.resolve(); return await gate.promise; } });
  const registering = h.runtime.register(master, body());
  await entered.promise;
  const removing = h.runtime.remove(master, installationId);
  gate.resolve({ id: turnId, status: 'completed' });
  await Promise.all([registering, removing]);
  assert.deepEqual(await h.store.list(), []);
});

test('a failed baseline cannot enable a new watch or replace a previously saved token', async t => {
  const h = await harness(t, { mobilePushReadTurn: async () => { throw new Error('PRIVATE_DESKTOP_ERROR'); } });
  await assert.rejects(h.runtime.register(master, body()), error => error.statusCode === 503 && !error.message.includes('PRIVATE'));
  assert.deepEqual(await h.store.list(), []);
});

test('new terminal history is delivered without any phone SSE and old baselines stay silent', async t => {
  const messages = [], delivered = Promise.withResolvers();
  const h = await harness(t, { mobilePushSender: { async send(message) { messages.push(message); delivered.resolve(); return { accepted: true }; } } });
  await h.runtime.start();
  await h.runtime.register(master, body());
  // Register is intentionally independent of the native observer round trip.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(messages.length, 0);
  h.setTurn({ id: nextTurnId, status: 'completed' });
  h.callbacks.get(threadId)();
  await delivered.promise;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event.turnId, nextTurnId);
  assert.equal(messages[0].event.type, 'completed');
  assert.ok(!JSON.stringify(messages[0].event).includes('PRIVATE_PUSH_TOKEN'));
});

test('push HTTP endpoints keep the bridge authentication boundary and do not expose tokens', async t => {
  const oldToken = process.env.CODEX_BRIDGE_TOKEN, oldOtp = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = 'push-http-fixture'; delete process.env.CODEX_BRIDGE_TOTP_SECRET;
  t.after(() => {
    if (oldToken === undefined) delete process.env.CODEX_BRIDGE_TOKEN; else process.env.CODEX_BRIDGE_TOKEN = oldToken;
    if (oldOtp === undefined) delete process.env.CODEX_BRIDGE_TOTP_SECRET; else process.env.CODEX_BRIDGE_TOTP_SECRET = oldOtp;
  });
  const h = await harness(t);
  const { server } = createApp({ config: { ...h.config, mobilePushRuntime: h.runtime }, adapter: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/mobile-push`;
  assert.equal((await fetch(base + '/status')).status, 401);
  const headers = { 'x-codex-bridge-token': 'push-http-fixture', 'content-type': 'application/json' };
  const response = await fetch(base + '/registration', { method: 'POST', headers, body: JSON.stringify(body()) });
  assert.equal(response.status, 200);
  const raw = await response.text(); assert.ok(!raw.includes('PRIVATE_PUSH_TOKEN'));
  assert.equal(JSON.parse(raw).registration.ready, false);
  assert.equal((await fetch(base + '/registration', { method: 'DELETE', headers,
    body: JSON.stringify({ installationId }) })).status, 200);
  assert.deepEqual(await h.store.list(), []);
});
