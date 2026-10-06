import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { desktopScriptBridge } from '../src/desktopScriptBridge.js';
import { DeviceRegistry, hashDeviceToken } from '../src/deviceRegistry.js';
import { createPairingSessionStore } from '../src/devicePairing.js';
import { generateTotp } from '../src/totp.js';

const MASTER_TOKEN = 'pair-test-master-token';
const TOTP_TEST_SECRET = 'JBSWY3DPEHPK3PXP';

// 挑一个确定不在 ±1 容差窗口内的 6 位码，避免极小概率的偶发碰撞。
function wrongTotpCode(secret, nowMs) {
  const valid = new Set();
  const currentStep = Math.floor(nowMs / 1000 / 30);
  for (let step = currentStep - 1; step <= currentStep + 1; step += 1) {
    valid.add(generateTotp(secret, { counter: step }));
  }
  for (let candidate = 0; candidate < 1000000; candidate += 1) {
    const code = String(candidate).padStart(6, '0');
    if (!valid.has(code)) {
      return code;
    }
  }
  return '000000';
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createPairingTestConfig({ root, clock }) {
  const config = {
    appServerRuntimeMode: 'desktop',
    outboxEnabled: false,
    desktopLiveDiagnostics: false,
    logger: new DiagnosticLogger({ root }),
    repoRoot: root,
    deviceRegistryPath: path.join(root, 'state', 'device-registry.json'),
    authClock: clock,
    projects: [{
      id: 'probe',
      name: 'Probe Workspace',
      root: process.cwd(),
      allowedCommands: []
    }]
  };
  config.threadService = {
    async listProjects() {
      return config.projects;
    }
  };
  return config;
}

async function startPairingServer(config) {
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, logger };
}

function masterHeaders() {
  return {
    'content-type': 'application/json',
    'x-codex-bridge-token': MASTER_TOKEN
  };
}

async function readSecurityAudit(root) {
  return fs.readFile(path.join(root, 'current-run', 'security.jsonl'), 'utf8');
}

async function createPairing(baseUrl, { publicUrl } = {}) {
  const body = publicUrl === undefined ? {} : { publicUrl };
  const response = await fetch(`${baseUrl}/desktop/pair/create`, {
    method: 'POST',
    headers: masterHeaders(),
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function enroll(baseUrl, pairingCode, deviceName = '测试手机') {
  return fetch(`${baseUrl}/pair/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode, deviceName })
  });
}

const WRONG_CODE = 'XXXXXXXXXW';

test('pairing happy path: create, enroll contract, device list and device auth', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-happy-'));
  const config = createPairingTestConfig({ root, clock: () => clockMs });
  const { server } = await startPairingServer(config);

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl, { publicUrl: 'https://pair.example.test:8787/' });

    assert.equal(created.expiresAt, clockMs + 300_000);
    assert.match(created.pairingCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.doesNotMatch(created.pairingCode, /[0O1ILU]/);
    assert.equal(created.publicUrl, 'https://pair.example.test:8787');
    assert.equal(
      created.payload,
      `codexharmony://pair?v=1&u=${encodeURIComponent('https://pair.example.test:8787')}&c=${encodeURIComponent(created.pairingCode)}`
    );
    assert.ok(created.qrSvg.startsWith('<svg'), 'qrSvg should be an SVG document');
    assert.ok(created.qrSvg.includes('viewBox'));

    const enrollResponse = await enroll(baseUrl, created.pairingCode, '测试手机');
    assert.equal(enrollResponse.status, 200);
    const enrolled = await enrollResponse.json();
    assert.deepEqual(Object.keys(enrolled).sort(), ['deviceId', 'deviceName', 'pairedAt', 'token', 'totpSecret']);
    assert.match(enrolled.deviceId, /^dev_[0-9a-f]{12}$/);
    assert.equal(enrolled.deviceName, '测试手机');
    assert.match(enrolled.token, /^[0-9a-f]{64}$/);
    assert.match(enrolled.totpSecret, /^[A-Z2-7]{32}$/);
    assert.equal(enrolled.pairedAt, new Date(clockMs).toISOString());

    const devicesResponse = await fetch(`${baseUrl}/desktop/pair/devices`, { headers: masterHeaders() });
    assert.equal(devicesResponse.status, 200);
    const { devices } = await devicesResponse.json();
    assert.equal(devices.length, 1);
    assert.deepEqual(Object.keys(devices[0]).sort(), ['createdAt', 'deviceId', 'deviceName', 'lastSeenAt', 'revoked']);
    assert.equal(devices[0].deviceId, enrolled.deviceId);
    assert.equal(devices[0].revoked, false);
    assert.equal(Object.values(devices[0]).some((value) => String(value).includes(enrolled.token)), false);

    const deviceAuth = await fetch(`${baseUrl}/tasks`, {
      headers: {
        'x-codex-bridge-token': enrolled.token,
        'x-codex-bridge-otp': generateTotp(enrolled.totpSecret, { nowMs: clockMs })
      }
    });
    assert.equal(deviceAuth.status, 200, 'device token + device OTP should pass while global TOTP is on');

    const listResponse = await fetch(`${baseUrl}/desktop/pair/devices`, { headers: masterHeaders() });
    const listed = (await listResponse.json()).devices[0];
    assert.equal(listed.lastSeenAt, new Date(clockMs).toISOString());
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }
});

test('pairing code expires after five minutes (authClock driven)', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-expire-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    clockMs += 300_001;
    const response = await enroll(baseUrl, created.pairingCode);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'pairing_failed', reason: 'code_expired' });
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('pairing code can only be consumed once', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-consume-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    const first = await enroll(baseUrl, created.pairingCode, '第一台');
    assert.equal(first.status, 200);
    const second = await enroll(baseUrl, created.pairingCode, '第二台');
    assert.equal(second.status, 401);
    assert.deepEqual(await second.json(), { error: 'pairing_failed', reason: 'code_consumed' });
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('five wrong attempts invalidate the session, the correct code then fails too', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-attempt-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    // 每次错码换一个 x-forwarded-for 来源，避免先触发「每来源 5 次失败」的限速桶，
    // 从而单独验证「同一会话累计 5 次错码即作废」的会话语义。
    const enrollFromSource = (source, code) => fetch(`${baseUrl}/pair/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
      body: JSON.stringify({ pairingCode: code, deviceName: `错码-${source}` })
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await enrollFromSource(`attacker-${attempt}`, WRONG_CODE);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).reason, 'code_invalid');
    }
    const correctAfterInvalidation = await enrollFromSource('fresh-source', created.pairingCode);
    assert.equal(correctAfterInvalidation.status, 401);
    assert.equal((await correctAfterInvalidation.json()).reason, 'code_invalid');
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('pairing session store: attempt threshold and reason precedence', async () => {
  let clockMs = 1_700_000_000_000;
  const store = createPairingSessionStore({ now: () => clockMs });
  const { code } = store.create();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(store.tryEnroll(WRONG_CODE), { ok: false, reason: 'code_invalid' });
  }
  // 第 5 次错码触发会话作废，之后正确配对码也无法使用。
  assert.deepEqual(store.tryEnroll(WRONG_CODE), { ok: false, reason: 'code_invalid' });
  assert.deepEqual(store.tryEnroll(code), { ok: false, reason: 'code_invalid' });

  // 过期优先于已消费：过期后即使已消费也返回 code_expired。
  clockMs = 1_700_000_000_100;
  const expiredFirst = createPairingSessionStore({ now: () => clockMs });
  const consumed = expiredFirst.create();
  assert.ok(expiredFirst.tryEnroll(consumed.code).ok);
  clockMs += 300_001;
  assert.deepEqual(expiredFirst.tryEnroll(consumed.code), { ok: false, reason: 'code_expired' });

  // 大小写与连字符归一化。
  clockMs = 1_700_000_000_200;
  const normalizing = createPairingSessionStore({ now: () => clockMs });
  const raw = normalizing.create();
  assert.ok(normalizing.tryEnroll(raw.code.toLowerCase().replace(/(\w{5})/, '$1-')).ok);
});

test('enroll rate limits after five failures, 429 responses do not accumulate', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-ratelimit-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await enroll(baseUrl, WRONG_CODE);
      assert.equal(response.status, 401);
    }
    const blocked = await enroll(baseUrl, WRONG_CODE);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

    clockMs += 10_000;
    const stillBlocked = await enroll(baseUrl, WRONG_CODE);
    assert.equal(stillBlocked.status, 429);
    assert.equal(stillBlocked.headers.get('retry-after'), '50', '429 attempts must not extend the window');

    // 5 次错码已把会话作废（见上一条用例），窗口滑过后新建会话验证限速恢复。
    clockMs += 51_000;
    const recoveredSession = await createPairing(baseUrl);
    const recovered = await enroll(baseUrl, recoveredSession.pairingCode);
    assert.equal(recovered.status, 200);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('enroll rejects oversized bodies, malformed JSON and over-long fields', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-invalid-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const oversized = await fetch(`${baseUrl}/pair/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: WRONG_CODE, deviceName: 'a'.repeat(5000) })
    });
    assert.equal(oversized.status, 413);

    const malformed = await fetch(`${baseUrl}/pair/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this-is-not-json'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid_request' });

    const longName = await enroll(baseUrl, WRONG_CODE, 'a'.repeat(65));
    assert.equal(longName.status, 400);

    const missingFields = await fetch(`${baseUrl}/pair/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName: '缺配对码' })
    });
    assert.equal(missingFields.status, 400);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('creating a new pairing session invalidates the previous one', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-replace-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const first = await createPairing(baseUrl);
    const second = await createPairing(baseUrl);
    assert.notEqual(first.pairingCode, second.pairingCode);

    const stale = await enroll(baseUrl, first.pairingCode);
    assert.equal(stale.status, 401);
    assert.equal((await stale.json()).reason, 'code_invalid');

    const current = await enroll(baseUrl, second.pairingCode);
    assert.equal(current.status, 200);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('publicUrl precedence: body overrides env, empty default keeps payload usable', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousPublicUrl = process.env.CODEX_BRIDGE_PUBLIC_URL;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-url-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const empty = await createPairing(baseUrl);
    assert.equal(empty.publicUrl, '');
    const emptyPayload = new URL(empty.payload);
    assert.equal(emptyPayload.searchParams.get('v'), '1');
    assert.equal(emptyPayload.searchParams.get('u'), '');
    assert.equal(emptyPayload.searchParams.get('c'), empty.pairingCode);

    process.env.CODEX_BRIDGE_PUBLIC_URL = 'https://from-env.example.test';
    const fromEnv = await createPairing(baseUrl);
    assert.equal(fromEnv.publicUrl, 'https://from-env.example.test');
    assert.ok(fromEnv.payload.includes('u=https%3A%2F%2Ffrom-env.example.test'), 'payload must carry the encoded url');
    assert.equal(new URL(fromEnv.payload).searchParams.get('u'), 'https://from-env.example.test');

    const fromBody = await createPairing(baseUrl, { publicUrl: 'https://from-body.example.test/' });
    assert.equal(fromBody.publicUrl, 'https://from-body.example.test');
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_PUBLIC_URL', previousPublicUrl);
  }
});

test('device credentials: token+OTP passes, wrong/missing OTP fails with 2fa header, revoked fails, admin routes stay master-only', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-device-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));
  desktopScriptBridge.reset();

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    const enrolled = await (await enroll(baseUrl, created.pairingCode, '矩阵设备')).json();
    const deviceHeaders = (otp) => ({
      'x-codex-bridge-token': enrolled.token,
      ...(otp === undefined ? {} : { 'x-codex-bridge-otp': otp })
    });

    const ok = await fetch(`${baseUrl}/tasks`, {
      headers: deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs }))
    });
    assert.equal(ok.status, 200);

    const wrongOtp = await fetch(`${baseUrl}/tasks`, {
      headers: deviceHeaders(wrongTotpCode(enrolled.totpSecret, clockMs))
    });
    assert.equal(wrongOtp.status, 401);
    assert.equal(wrongOtp.headers.get('x-codex-bridge-2fa'), 'required');

    const missingOtp = await fetch(`${baseUrl}/tasks`, { headers: deviceHeaders() });
    assert.equal(missingOtp.status, 401);
    assert.equal(missingOtp.headers.get('x-codex-bridge-2fa'), 'required');

    const adminChecks = [
      fetch(`${baseUrl}/desktop/pair`, { headers: deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs })) }),
      fetch(`${baseUrl}/desktop/pair/create`, {
        method: 'POST',
        headers: { ...deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs })), 'content-type': 'application/json' },
        body: '{}'
      }),
      fetch(`${baseUrl}/desktop/pair/devices`, { headers: deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs })) }),
      fetch(`${baseUrl}/desktop/pair/revoke`, {
        method: 'POST',
        headers: { ...deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs })), 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: enrolled.deviceId })
      })
    ];
    for (const check of adminChecks) {
      const response = await check;
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'master_required' });
    }

    // 设备不享受 loopback 豁免：无 xff 直连 /desktop/script/status 与 /tasks 仍必须带 OTP。
    const scriptNoExemption = await fetch(`${baseUrl}/desktop/script/status`, { headers: deviceHeaders() });
    assert.equal(scriptNoExemption.status, 401);
    assert.equal(scriptNoExemption.headers.get('x-codex-bridge-2fa'), 'required');
    const tasksNoExemption = await fetch(`${baseUrl}/tasks`, { headers: deviceHeaders() });
    assert.equal(tasksNoExemption.status, 401);
    assert.equal(tasksNoExemption.headers.get('x-codex-bridge-2fa'), 'required');

    const unknownToken = await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': randomBytes(32).toString('hex') }
    });
    assert.equal(unknownToken.status, 401);

    const revoke = await fetch(`${baseUrl}/desktop/pair/revoke`, {
      method: 'POST',
      headers: masterHeaders(),
      body: JSON.stringify({ deviceId: enrolled.deviceId })
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), { revoked: true });

    const revokedRepeat = await fetch(`${baseUrl}/desktop/pair/revoke`, {
      method: 'POST',
      headers: masterHeaders(),
      body: JSON.stringify({ deviceId: enrolled.deviceId })
    });
    assert.equal(revokedRepeat.status, 200, 'revoke must be idempotent');

    const revokedAuth = await fetch(`${baseUrl}/tasks`, {
      headers: deviceHeaders(generateTotp(enrolled.totpSecret, { nowMs: clockMs }))
    });
    assert.equal(revokedAuth.status, 401);
  } finally {
    desktopScriptBridge.reset();
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }
});

test('device OTP replay of an older window is rejected after a newer window was accepted', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  const baseStep = 56_666_666;
  let clockMs = baseStep * 30_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-replay-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    const enrolled = await (await enroll(baseUrl, created.pairingCode)).json();

    const newerCode = generateTotp(enrolled.totpSecret, { counter: baseStep + 1 });
    const olderCode = generateTotp(enrolled.totpSecret, { counter: baseStep });
    assert.notEqual(newerCode, olderCode);

    const firstUse = await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': enrolled.token, 'x-codex-bridge-otp': newerCode }
    });
    assert.equal(firstUse.status, 200);

    const replayOlder = await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': enrolled.token, 'x-codex-bridge-otp': olderCode }
    });
    assert.equal(replayOlder.status, 401, 'older-window code must be rejected once a newer window was accepted');
    assert.equal(replayOlder.headers.get('x-codex-bridge-2fa'), 'required');
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }
});

test('pairing console page is served inline with password token input and no token echo', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-page-'));
  const { server } = await startPairingServer(createPairingTestConfig({ root, clock: () => clockMs }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/pair`, { headers: masterHeaders() });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('设备配对'));
    assert.ok(html.includes('type="password"'));
    assert.ok(html.includes('codex-hramony-bridge-token'));
    assert.ok(html.includes('生成配对码'));
    assert.ok(html.includes('吊销'));
    assert.doesNotMatch(html, new RegExp(MASTER_TOKEN));
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
  }
});

test('registry reload keeps devices across restart, revoked stay revoked, list hides secrets', async () => {
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-registry-'));
  const filePath = path.join(root, 'state', 'device-registry.json');
  const first = new DeviceRegistry({ filePath, now: () => clockMs });
  const kept = await first.createDevice({ deviceName: '保活设备' });
  const revoked = await first.createDevice({ deviceName: '吊销设备' });
  assert.equal((await first.revoke(revoked.deviceId)).changed, true);
  assert.equal((await first.revoke(revoked.deviceId)).changed, false, 'second revoke is a no-op');

  const second = new DeviceRegistry({ filePath, now: () => clockMs });
  const found = await second.findByTokenHash(hashDeviceToken(kept.token));
  assert.equal(found.deviceId, kept.deviceId);
  assert.equal(found.totpSecret, kept.totpSecret);
  assert.equal(await second.findByTokenHash(hashDeviceToken(revoked.token)), null, 'revoked devices are skipped');
  const revokedAny = await second.findAnyByTokenHash(hashDeviceToken(revoked.token));
  assert.ok(revokedAny.revokedAt !== null);

  const devices = await second.list();
  assert.equal(devices.length, 2);
  for (const device of devices) {
    assert.deepEqual(Object.keys(device).sort(), ['createdAt', 'deviceId', 'deviceName', 'lastSeenAt', 'revoked']);
  }

  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  for (const record of persisted.devices) {
    assert.ok(record.tokenHash);
    assert.ok(record.totpSecret);
    assert.equal(Object.hasOwn(record, 'token'), false, 'plaintext token must never be persisted');
  }
});

test('registry persist leaves no temporary files behind', async () => {
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-atomic-'));
  const filePath = path.join(root, 'state', 'device-registry.json');
  const registry = new DeviceRegistry({ filePath, now: () => clockMs });
  await registry.createDevice({ deviceName: '原子性' });
  await registry.revoke('dev_missing');
  const files = await fs.readdir(path.dirname(filePath));
  assert.deepEqual(files, ['device-registry.json'], 'tmp+rename must leave no .tmp residue');
});

test('registry touch updates lastSeenAt in memory but persists only after the 60s throttle', async () => {
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-touch-'));
  const filePath = path.join(root, 'state', 'device-registry.json');
  const registry = new DeviceRegistry({ filePath, now: () => clockMs });
  const created = await registry.createDevice({ deviceName: '节流设备' });
  const createdAtIso = new Date(clockMs).toISOString();

  clockMs += 1_000;
  registry.touch(created.deviceId, clockMs);
  const inMemory = await registry.list();
  assert.equal(inMemory[0].lastSeenAt, new Date(clockMs).toISOString(), 'memory updates immediately');

  const early = new DeviceRegistry({ filePath, now: () => clockMs });
  assert.equal((await early.list())[0].lastSeenAt, createdAtIso, 'within throttle the disk copy is unchanged');

  clockMs += 61_000;
  registry.touch(created.deviceId, clockMs);
  await registry.persistPromise;
  const late = new DeviceRegistry({ filePath, now: () => clockMs });
  assert.equal((await late.list())[0].lastSeenAt, new Date(clockMs).toISOString(), 'after 60s the touch is persisted');
});

test('a fake config.deviceRegistry injection is used by the auth gate', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-fake-'));
  const config = createPairingTestConfig({ root, clock: () => clockMs });
  const fakeRegistry = {
    initialize() {},
    async findByTokenHash(tokenHash) {
      return tokenHash === hashDeviceToken('fake-device-token')
        ? { deviceId: 'dev_fakesource', totpSecret: TOTP_TEST_SECRET }
        : null;
    },
    touch() {}
  };
  config.deviceRegistry = fakeRegistry;
  const { server } = await startPairingServer(config);

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const accepted = await fetch(`${baseUrl}/projects`, {
      headers: {
        'x-codex-bridge-token': 'fake-device-token',
        'x-codex-bridge-otp': generateTotp(TOTP_TEST_SECRET, { nowMs: clockMs })
      }
    });
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`${baseUrl}/projects`, {
      headers: {
        'x-codex-bridge-token': 'fake-device-token',
        'x-codex-bridge-otp': wrongTotpCode(TOTP_TEST_SECRET, clockMs)
      }
    });
    assert.equal(rejected.status, 401);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }
});

test('empty registry keeps legacy behavior: loopback exemption, token categories, open mode', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-legacy-'));
  const config = createPairingTestConfig({ root, clock: () => clockMs });
  const { server, logger } = await startPairingServer(config);
  desktopScriptBridge.reset();

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const exempt = await fetch(`${baseUrl}/desktop/script/status`, {
      headers: { 'x-codex-bridge-token': MASTER_TOKEN }
    });
    assert.equal(exempt.status, 200, 'loopback token-only exemption for /desktop/ must survive');

    const tasksNeedOtp = await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': MASTER_TOKEN }
    });
    assert.equal(tasksNeedOtp.status, 401);
    assert.equal(tasksNeedOtp.headers.get('x-codex-bridge-2fa'), 'required');

    await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': 'not-a-known-token' }
    });
    await logger.flushAnalysis();
    const auditLog = await readSecurityAudit(root);
    assert.match(auditLog, /"category":"token"/);
    assert.doesNotMatch(auditLog, /not-a-known-token/);
  } finally {
    desktopScriptBridge.reset();
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }

  // open 模式（无 token 无 TOTP）：行为与今天一致，全部放行。
  const openConfig = createPairingTestConfig({ root, clock: () => clockMs });
  const { server: openServer } = await startPairingServer(openConfig);
  try {
    const baseUrl = `http://127.0.0.1:${openServer.address().port}`;
    const tasks = await fetch(`${baseUrl}/tasks`);
    assert.equal(tasks.status, 200);
    const page = await fetch(`${baseUrl}/desktop/pair`);
    assert.equal(page.status, 200);
  } finally {
    openServer.close();
  }
});

test('pairing and device audits never contain codes, tokens or secrets', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousSecret = process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN = MASTER_TOKEN;
  process.env.CODEX_BRIDGE_TOTP_SECRET = TOTP_TEST_SECRET;
  let clockMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pair-audit-'));
  const config = createPairingTestConfig({ root, clock: () => clockMs });
  const { server, logger } = await startPairingServer(config);

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = await createPairing(baseUrl);
    await enroll(baseUrl, WRONG_CODE, '审计设备');
    const enrolled = await (await enroll(baseUrl, created.pairingCode, '审计设备')).json();
    await fetch(`${baseUrl}/tasks`, { headers: { 'x-codex-bridge-token': enrolled.token } });
    await fetch(`${baseUrl}/desktop/pair/revoke`, {
      method: 'POST',
      headers: masterHeaders(),
      body: JSON.stringify({ deviceId: enrolled.deviceId })
    });
    await fetch(`${baseUrl}/tasks`, {
      headers: { 'x-codex-bridge-token': enrolled.token, 'x-codex-bridge-otp': generateTotp(enrolled.totpSecret, { nowMs: clockMs }) }
    });
    await logger.flushAnalysis();

    const auditLog = await readSecurityAudit(root);
    assert.match(auditLog, /"event":"bridge\.pairing\.created"/);
    assert.match(auditLog, /"category":"pairing_invalid"/);
    assert.match(auditLog, /"event":"bridge\.pairing\.enrolled"/);
    assert.match(auditLog, /"category":"device_otp_invalid"/);
    assert.match(auditLog, /"reason":"otp_missing"/);
    assert.match(auditLog, /"event":"bridge\.device\.revoked"/);
    assert.doesNotMatch(auditLog, new RegExp(created.pairingCode.replace('-', '')));
    assert.doesNotMatch(auditLog, new RegExp(enrolled.token));
    assert.doesNotMatch(auditLog, new RegExp(enrolled.totpSecret));
    assert.doesNotMatch(auditLog, new RegExp(MASTER_TOKEN));
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_TOTP_SECRET', previousSecret);
  }
});
