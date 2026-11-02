import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createMobileControlAuth } from '../src/mobileControlAuth.js';
import { createMobileControlServer } from '../src/mobileControlServer.js';
import { DeviceRegistry } from '../src/deviceRegistry.js';
import { generateTotp } from '../src/totp.js';

const TOKEN = 'control-test-master-token';
const SECRET = 'JBSWY3DPEHPK3PXP';
const CLOCK = 1_700_000_000_000;

function environment(t, token = TOKEN, secret = SECRET) {
  const savedToken = process.env.CODEX_BRIDGE_TOKEN;
  const savedSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  if (token === null) delete process.env.CODEX_BRIDGE_TOKEN; else process.env.CODEX_BRIDGE_TOKEN = token;
  if (secret === null) delete process.env.CODEX_BRIDGE_TOTP_SECRET; else process.env.CODEX_BRIDGE_TOTP_SECRET = secret;
  t.after(() => {
    if (savedToken === undefined) delete process.env.CODEX_BRIDGE_TOKEN; else process.env.CODEX_BRIDGE_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.CODEX_BRIDGE_TOTP_SECRET; else process.env.CODEX_BRIDGE_TOTP_SECRET = savedSecret;
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'control-auth-'));
  const file = path.join(root, 'logs', 'state', 'device-registry.json');
  const records = [];
  const control = createMobileControlServer({ targetId: 'test-target', stateDir: path.join(root, 'jobs'),
    authorize: createMobileControlAuth({ repoRoot: root, now: () => CLOCK, logger: { async write(...values) { records.push(values); } } }),
    executeRepair: async () => ({ ok: true, verification: { bridge: true, sessions: true, targetSession: true, desktop: true, desktopRequired: true } }) });
  control.server.listen(0, '127.0.0.1'); await once(control.server, 'listening');
  t.after(async () => { await control.close(); await fs.rm(root, { force: true, recursive: true }); });
  const base = `http://127.0.0.1:${control.server.address().port}/control/v1/targets/test-target`;
  return { root, file, records, base };
}
function headers(token = TOKEN, secret = SECRET) {
  return { authorization: `Bearer ${token}`, 'x-codex-bridge-otp': generateTotp(secret, { nowMs: CLOCK }) };
}

test('control requires token plus OTP even for loopback and never opens without configuration', async (t) => {
  environment(t); const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/status`)).status, 401);
  const tokenOnly = await fetch(`${f.base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(tokenOnly.status, 401); assert.equal(tokenOnly.headers.get('x-codex-bridge-2fa'), 'required');
  const invalidOtp = { ...headers(), 'x-codex-bridge-otp': String((Number(generateTotp(SECRET, { nowMs: CLOCK })) + 17) % 1000000).padStart(6, '0') };
  assert.equal((await fetch(`${f.base}/status`, { headers: invalidOtp })).status, 401);
  const success = await fetch(`${f.base}/status`, { headers: headers() });
  assert.equal(success.status, 200); assert.equal(success.headers.get('connection'), 'close');
  assert.equal((await fetch(`${f.base}/status`, { headers: headers('wrong-token') })).status, 401);
  process.env.CODEX_BRIDGE_TOKEN = '';
  assert.equal((await fetch(`${f.base}/status`, { headers: headers() })).status, 401);
  process.env.CODEX_BRIDGE_TOKEN = TOKEN; process.env.CODEX_BRIDGE_TOTP_SECRET = '';
  assert.equal((await fetch(`${f.base}/status`, { headers: headers() })).status, 401);
  const audit = JSON.stringify(f.records);
  assert.doesNotMatch(audit, new RegExp(TOKEN)); assert.doesNotMatch(audit, new RegExp(SECRET));
});

test('missing initial secrets cannot turn into an open gate', async (t) => {
  environment(t, null, null); const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/status`)).status, 401);
  process.env.CODEX_BRIDGE_TOKEN = TOKEN;
  assert.equal((await fetch(`${f.base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401);
});

test('newly paired devices authenticate from fresh disk state and revocation takes effect without writes', async (t) => {
  environment(t); const f = await fixture(t);
  const registry = new DeviceRegistry({ filePath: f.file, now: () => CLOCK });
  const first = await registry.createDevice({ deviceName: 'first' });
  const second = await registry.createDevice({ deviceName: 'second' });
  const before = await fs.readFile(f.file, 'utf8');
  assert.equal((await fetch(`${f.base}/status`, { headers: { authorization: `Bearer ${first.token}` } })).status, 401);
  assert.equal((await fetch(`${f.base}/status`, { headers: { ...headers(first.token, first.totpSecret), 'x-codex-bridge-otp': 'not-an-otp' } })).status, 401);
  const start = await fetch(`${f.base}/repairs`, { method: 'POST', headers: { ...headers(first.token, first.totpSecret), 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'paired-request-1', mode: 'auto', sessionId: '', confirmHardRestart: false }) });
  assert.equal(start.status, 202); const { job } = await start.json();
  assert.equal((await fetch(`${f.base}/repairs/${job.id}`, { headers: headers(first.token, first.totpSecret) })).status, 200);
  assert.equal((await fetch(`${f.base}/repairs/${job.id}`, { headers: headers(second.token, second.totpSecret) })).status, 404);
  assert.equal((await fetch(`${f.base}/repairs/${job.id}`, { headers: headers() })).status, 200);
  assert.equal(await fs.readFile(f.file, 'utf8'), before, 'control auth never touches the shared registry');
  await registry.revoke(first.deviceId);
  assert.equal((await fetch(`${f.base}/repairs/${job.id}`, { headers: headers(first.token, first.totpSecret) })).status, 401);
  const third = await registry.createDevice({ deviceName: 'third' });
  assert.equal((await fetch(`${f.base}/status`, { headers: headers(third.token, third.totpSecret) })).status, 200);
});

test('registry corruption and oversize files fail closed for devices; missing file is an empty table', async (t) => {
  environment(t); const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/status`, { headers: headers('unknown') })).status, 401);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  for (const contents of ['{broken', JSON.stringify({ schemaVersion: 1, devices: [{ deviceId: 'x' }] }), 'x'.repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(f.file, contents);
    const result = await fetch(`${f.base}/status`, { headers: headers('unknown') });
    assert.equal(result.status, 401); assert.doesNotMatch(await result.text(), /broken|tokenHash|SyntaxError/);
  }
});

test('existing auth failure rate limiting remains active', async (t) => {
  environment(t); const f = await fixture(t); let last;
  for (let n = 0; n < 40; n++) {
    last = await fetch(`${f.base}/status`); await last.arrayBuffer();
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
});
