import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { NativeContinueService, NativeContinueJournal } from '../src/nativeContinueService.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const expectedTurnId = 'turn-1';
const token = 'native-continue-fixture-token';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-continue-api-'));
  const oldToken = process.env.CODEX_BRIDGE_TOKEN, oldOtp = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = token; delete process.env.CODEX_BRIDGE_TOTP_SECRET;
  const snapshot = { thread: { id: threadId, goal: null, status: { type: 'idle' }, turns: [{ id: expectedTurnId, status: 'interrupted' }] } };
  let writes = 0, runtimeReads = 0, uncertain = false;
  const nativeClient = { async readContinueSnapshot() { return snapshot; },
    async continueTurn() { writes++; if (uncertain) throw Object.assign(new Error('lost receipt'), { continueWriteAttempted: true });
      return { turnId: 'turn-2', active: true, canContinue: false }; } };
  const nativeContinueService = new NativeContinueService({ client: nativeClient,
    journal: new NativeContinueJournal(path.join(root, 'continue.json')) });
  const desktopAdapter = new CodexDesktopCdpAdapter({ client: { async drainNotifications() { return []; }, close() {} } });
  desktopAdapter.run = () => assert.fail('Native continue must not create a bridge task');
  const app = createApp({ adapter: desktopAdapter, config: { repoRoot: root, projects: [], outboxEnabled: false,
    desktopLiveDiagnostics: false, nativeContinueService,
    mobilePushRuntime: { async start() {}, close() {} },
    threadService: { async getRuntimeSnapshot(options) { runtimeReads++; assert.equal(options.limit, 500);
      return { stale: false, observedAt: new Date().toISOString(), threads: [{ threadId, state: 'idle', nativeState: 'notLoaded' }] }; } },
    logger: new DiagnosticLogger({ root }), deviceRegistryPath: path.join(root, 'devices.json') } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const controllers = [];
  t.after(async () => {
    app.dispose(); for (const controller of controllers) controller.abort();
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await app.logger.writeChain; await app.logger.flushAnalysis();
    if (oldToken === undefined) delete process.env.CODEX_BRIDGE_TOKEN; else process.env.CODEX_BRIDGE_TOKEN = oldToken;
    if (oldOtp === undefined) delete process.env.CODEX_BRIDGE_TOTP_SECRET; else process.env.CODEX_BRIDGE_TOTP_SECRET = oldOtp;
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, snapshot, controllers, get writes() { return writes; }, get runtimeReads() { return runtimeReads; },
    setUncertain() { uncertain = true; },
    request(endpoint, { auth = true, ...options } = {}) { return fetch(base + endpoint, { ...options,
      headers: { ...(auth ? { 'x-codex-bridge-token': token } : {}), ...(options.headers ?? {}) } }); },
    post(input) { return this.request(`/api/codex/threads/${threadId}/continue`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); } };
}

test('continue routes inherit auth; status is read only and success returns a confirmed native turn without a bridge task', async t => {
  const h = await fixture(t), endpoint = `/api/codex/threads/${threadId}/continue-status`;
  assert.equal((await h.request(endpoint, { auth: false })).status, 401);
  const status = await h.request(endpoint);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { threadId, turnId: expectedTurnId, canContinue: true, reason: 'interrupted', state: 'interrupted' });
  assert.equal(h.writes, 0);
  const operationId = randomUUID();
  const first = await h.post({ operationId, expectedTurnId });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { operationId, threadId, expectedTurnId, turnId: 'turn-2', canContinue: false,
    state: 'confirmed', reason: 'started', active: true });
  assert.equal((await h.post({ operationId, expectedTurnId })).status, 200);
  assert.equal(h.writes, 1); assert.equal(h.app.store.listTasks().length, 0);
});

test('invalid/stale expected turns cannot write; uncertain results use 202 and disable future status until the old turn changes', async t => {
  const h = await fixture(t);
  assert.equal((await h.post({ operationId: 'bad', expectedTurnId })).status, 400);
  assert.equal((await h.post({ operationId: randomUUID(), expectedTurnId: 'old-turn' })).status, 409);
  assert.equal(h.writes, 0);
  h.setUncertain(); const operationId = randomUUID();
  const response = await h.post({ operationId, expectedTurnId });
  assert.equal(response.status, 202); assert.equal((await response.json()).state, 'uncertain');
  assert.equal((await h.post({ operationId, expectedTurnId })).status, 202); assert.equal(h.writes, 1);
  const status = await (await h.request(`/api/codex/threads/${threadId}/continue-status`)).json();
  assert.equal(status.canContinue, false); assert.equal(status.reason, 'uncertain_operation');
});

test('authenticated runtime-events shares one global subscription and app disposal releases it and its clients', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/api/codex/runtime-events', { auth: false })).status, 401);
  assert.equal(h.runtimeReads, 0);
  const controller = new AbortController(); h.controllers.push(controller);
  const response = await h.request('/api/codex/runtime-events', { signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let raw = '';
  while (!raw.includes('runtime.snapshot')) {
    const part = await Promise.race([reader.read(), delay(1500).then(() => { throw Error('Missing runtime frame'); })]);
    assert.equal(part.done, false); raw += decoder.decode(part.value, { stream: true });
  }
  assert.match(raw, /"nativeState":"notLoaded"/);
  assert.equal(h.app.store.adapter.notificationSubscriptions.size, 1);
  assert.equal([...h.app.store.adapter.notificationSubscriptions.values()][0].scope, 'runtime');
  h.app.dispose();
  assert.equal(h.app.store.adapter.notificationSubscriptions.size, 0);
  assert.equal(h.app.store.adapter.notificationPoller, null);
});
