import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { MobileLinkGuardianService } from '../src/mobileLinkGuardianService.js';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';

async function fixture(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-api-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const directory = path.join(repoRoot, 'logs', 'state');
  await fs.mkdir(directory, { recursive: true });
  const write = (name, value) => fs.writeFile(path.join(directory, 'mobile-link-guardian-' + name + '.json'), JSON.stringify(value));
  return { repoRoot, directory, write };
}

test('guardian is disabled until explicitly enabled and GET never launches a process', async t => {
  const f = await fixture(t); let launches = 0;
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot, run: async () => { launches++; } });
  assert.equal((await service.status()).guardian.phase, 'disabled');
  await service.status({ phone: true });
  assert.equal(launches, 0);
  const heartbeat = JSON.parse(await fs.readFile(path.join(f.directory, 'mobile-link-guardian-phone.json')));
  assert.equal(heartbeat.version, 1); assert.ok(Date.parse(heartbeat.lastSeenAt));
  assert.deepEqual(Object.keys(heartbeat).sort(), ['lastSeenAt', 'version']);
});

test('partially damaged status arrays remain readable without exposing raw values', async t => {
  const f = await fixture(t);
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot });
  await f.write('status', { faults: [null, 'bad', { id: 'bridge', title: 'bridge', state: 'error' }], history: [null, 7, { action: 'reconnect' }] });
  const result = await service.status();
  assert.equal(result.guardian.faults.length, 1);
  assert.equal(result.guardian.history.length, 1);
  assert.equal(result.guardian.enabled, false);
});

test('toggle uses a fixed hidden CLI action and only confirms persisted settings', async t => {
  const f = await fixture(t); const calls = [];
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot, run: async (binary, args, options) => {
    calls.push({ binary, args, options });
    await f.write('config', { version: 1, enabled: args.includes('Enable'), allowForceRestart: true });
  } });
  assert.equal((await service.setEnabled({ enabled: true })).guardian.enabled, true);
  assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].binary, 'powershell.exe'); assert.ok(calls[0].args.includes('Enable'));
  assert.equal((await service.setEnabled({ enabled: false })).guardian.phase, 'disabled');
  for (const input of [{ enabled: 'yes' }, { enabled: true, command: 'private-command' }, []]) {
    await assert.rejects(service.setEnabled(input), { statusCode: 400 });
  }
  assert.equal(calls.length, 2);
});

test('subprocess failure does not expose credentials or pretend enabling succeeded', async t => {
  const f = await fixture(t);
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot, run: async () => { throw Error('secret-private-token'); } });
  await assert.rejects(service.setEnabled({ enabled: true }), e => e.statusCode === 503 && !e.message.includes('secret'));
  assert.equal((await service.status()).guardian.enabled, false);
});

test('stale worker state is unknown while bounded in-progress repair stays visible', async t => {
  const f = await fixture(t); const now = Date.parse('2026-10-18T00:00:00Z');
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot, now: () => now });
  await f.write('config', { version: 1, enabled: true, allowForceRestart: true });
  const state = { heartbeatAt: new Date(now - 100000).toISOString(), phase: 'healthy', summary: 'ready' };
  await f.write('status', state);
  assert.equal((await service.status()).guardian.phase, 'unknown');
  await f.write('status', { ...state, phase: 'repairing', nextCheckAt: new Date(now + 30000).toISOString() });
  assert.equal((await service.status()).guardian.phase, 'repairing');
});

test('authenticated guardian API preserves the bridge gate and rejects non-boolean settings', async t => {
  const f = await fixture(t); const saved = [process.env.CODEX_BRIDGE_TOKEN, process.env.CODEX_BRIDGE_TOTP_SECRET];
  process.env.CODEX_BRIDGE_TOKEN = 'guardian-test-token'; delete process.env.CODEX_BRIDGE_TOTP_SECRET;
  t.after(() => { for (const [i, key] of ['CODEX_BRIDGE_TOKEN', 'CODEX_BRIDGE_TOTP_SECRET'].entries()) {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  } });
  let calls = 0;
  const service = new MobileLinkGuardianService({ repoRoot: f.repoRoot, run: async (_binary, args) => {
    calls++; await f.write('config', { version: 1, enabled: args.includes('Enable'), allowForceRestart: true });
  } });
  const config = { repoRoot: f.repoRoot, projects: [], outboxEnabled: false, voiceEnabled: false,
    guardianService: service, logger: new DiagnosticLogger({ root: f.repoRoot }) };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/system/guardian`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { method: 'PUT', body: '{"enabled":true}' })).status, 401);
  assert.equal(calls, 0);
  const headers = { 'X-Codex-Bridge-Token': 'guardian-test-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base, { headers })).status, 200);
  const result = await fetch(base, { method: 'PUT', headers, body: '{"enabled":true}' });
  assert.equal(result.status, 200); assert.equal((await result.json()).guardian.enabled, true);
  assert.equal((await fetch(base, { method: 'PUT', headers, body: '{"enabled":"true"}' })).status, 400);
  assert.equal((await fetch(base, { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal(calls, 1);
});
