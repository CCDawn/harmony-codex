import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthGate } from '../src/app.js';

const TOKEN = 'local-health-isolation-fixture';
function fixture(t, remoteAddress = '127.0.0.1', forwarded = undefined, secret = 'JBSWY3DPEHPK3PXP', gateOptions = {}) {
  const saved = { token: process.env.CODEX_BRIDGE_TOKEN, secret: process.env.CODEX_BRIDGE_TOTP_SECRET };
  process.env.CODEX_BRIDGE_TOKEN = TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = secret;
  t.after(() => {
    for (const [key, value] of [['CODEX_BRIDGE_TOKEN', saved.token], ['CODEX_BRIDGE_TOTP_SECRET', saved.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const gate = createAuthGate({ logger: { async write() {} }, now: () => 1_700_000_000_000, ...gateOptions });
  const call = (pathname, token = TOKEN, method = 'GET') => {
    const headers = { 'x-codex-bridge-token': token };
    if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
    const request = { headers, method, socket: { remoteAddress } };
    return gate.requireAuth({ request, url: new URL(pathname, 'http://localhost') }).then(() => request.codexAuth);
  };
  return { call };
}
async function exhaust(call) {
  for (let i = 0; i < 11; i++) await assert.rejects(call('/health', 'wrong-token'), error => error.statusCode === 401);
  await assert.rejects(call('/health', 'wrong-token'), error => error.statusCode === 429);
}

for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  test(`authenticated local health survives other local authentication failures: ${address}`, async t => {
    const { call } = fixture(t, address);
    await exhaust(call);
    assert.deepEqual(await call('/health'), { kind: 'master' });
    await assert.rejects(call('/projects'), error => error.statusCode === 429);
    await assert.rejects(call('/health', ''), error => error.statusCode === 429);
    await assert.rejects(call('/health', 'wrong-token'), error => error.statusCode === 429);
  });
}
for (const [address, forwarded] of [['203.0.113.9', undefined], ['127.0.0.1', '203.0.113.9'], ['127.0.0.1', '']]) {
  test(`remote or forwarded health retains its source limit: ${address}/${String(forwarded)}`, async t => {
    const { call } = fixture(t, address, forwarded);
    await exhaust(call);
    await assert.rejects(call('/health'), error => error.statusCode === 429);
  });
}
test('local health isolation also works when OTP is disabled', async t => {
  const { call } = fixture(t, '127.0.0.1', undefined, '');
  await exhaust(call);
  assert.deepEqual(await call('/health'), { kind: 'master' });
});
test('a remote socket cannot gain the health exception through an address resolver', async t => {
  const { call } = fixture(t, '203.0.113.9', undefined, '', { remoteAddressResolver: () => '127.0.0.1' });
  await exhaust(call);
  await assert.rejects(call('/health'), error => error.statusCode === 429);
});
test('non-GET health requests retain the source limit', async t => {
  const { call } = fixture(t);
  await exhaust(call);
  await assert.rejects(call('/health', TOKEN, 'POST'), error => error.statusCode === 429);
});
