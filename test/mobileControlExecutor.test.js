import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMobileControlExecutor } from '../src/mobileControlExecutor.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-executor-'));
const previous = [process.env.CODEX_BRIDGE_TOKEN, process.env.CODEX_BRIDGE_TOTP_SECRET];
process.env.CODEX_BRIDGE_TOKEN = 'test-only-token';
process.env.CODEX_BRIDGE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
after(async () => {
  for (const [index, key] of ['CODEX_BRIDGE_TOKEN', 'CODEX_BRIDGE_TOTP_SECRET'].entries()) {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }
  await fs.rm(root, { recursive: true, force: true });
});
const healthy = { health: { ok: true, runtime: { existingThreadExecution: 'desktop' } },
  sessions: { sessions: [] }, desktop: { desktop: { desktopLive: true, sessionVerified: true, targetSessionId: 'target' } },
  link: { link: { executionMode: 'desktop', recommendedAction: 'none', hdc: { ok: false } } } };
function fixture(states = [healthy], runner) {
  const calls = []; const reads = []; const phases = []; let round = -1;
  const fetchImpl = async (url, options) => {
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-Codex-Bridge-Token'], 'test-only-token');
    assert.match(options.headers['X-Codex-Bridge-OTP'], /^\d{6}$/);
    if (url.pathname === '/health') round++;
    reads.push(url.toString());
    const state = states[Math.min(round, states.length - 1)];
    const kind = { '/health': 'health', '/codex/sessions': 'sessions', '/desktop/live/status': 'desktop', '/system/link/status': 'link' }[url.pathname]
      ?? (url.pathname.startsWith('/codex/sessions/') ? 'target' : undefined);
    assert.ok(kind, `Unexpected request path: ${url.pathname}`);
    if (state[kind] === 'offline') throw new Error('ECONNREFUSED');
    const status = state[`${kind}Status`] ?? 200;
    return { ok: status === 200, status, json: async () => structuredClone(state[kind]) };
  };
  const execute = createMobileControlExecutor({ repoRoot: root, fetchImpl, now: () => 1730000000000,
    runProcess: async (...args) => {
      calls.push(args);
      assert.equal(args[2].shell, false); assert.equal(args[2].windowsHide, true);
      assert.ok(args[2].timeout > 0 && args[2].timeout <= 240000);
      assert.equal(args[0], 'pwsh.exe');
      assert.ok(!args[1].join(' ').includes('test-only-token'));
      return runner ? runner(...args) : { stdout: '{}' };
    } });
  return { calls, reads, phases, run: (job = {}) => execute({ mode: 'auto', sessionId: 'target', ...job }, async ({ phase }) => phases.push(phase)) };
}
const hardFault = { ...healthy, desktop: { desktop: { desktopLive: false, failureClass: 'codex_plain_no_cdp' } },
  link: { link: { recommendedAction: 'desktop_cdp_restart_required' } } };
const softFault = { ...healthy, desktop: { desktop: { desktopLive: false } } };
const appServer = { ...hardFault, health: { ok: true, runtime: { existingThreadExecution: 'app_server' } },
  target: { session: { id: 'target', messages: [] } } };

test('healthy auto verifies target and ignores HDC failure without starting scripts', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.calls.length, 0); assert.deepEqual(f.phases, ['checking']);
  assert.deepEqual(result.verification, { bridge: true, sessions: true, targetSession: true, desktopRequired: true, desktop: true });
});
test('bridge offline starts existing services then reads current readiness again', async () => {
  const f = fixture([{ ...healthy, health: 'offline' }, healthy]);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0][1].includes('Start'));
  assert.equal(f.reads.filter((url) => url.includes('/health?')).length, 2);
  assert.deepEqual(f.phases, ['checking', 'starting_services', 'verifying']);
});
test('zero process exit does not prove repaired business readiness', async () => {
  const f = fixture([{ ...healthy, health: 'offline' }]);
  assert.equal((await f.run()).ok, false); assert.equal(f.calls.length, 1);
});
test('soft repair never includes restart and always re-verifies', async () => {
  const f = fixture([softFault, healthy]); assert.equal((await f.run()).ok, true);
  assert.ok(f.calls[0][1].includes('Repair')); assert.ok(!f.calls[0][1].includes('-RestartDesktop'));
  assert.deepEqual(f.phases, ['checking', 'connecting_desktop', 'verifying']);
});
test('auto requires confirmation for known desktop restart with default policy', async () => {
  const f = fixture([hardFault]); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.requiresConfirmation, true); assert.equal(f.calls.length, 0);
});
test('saved boolean force policy permits exactly one restart with fresh verification', async () => {
  const directory = path.join(root, 'logs', 'state'); await fs.mkdir(directory, { recursive: true });
  const policy = path.join(directory, 'mobile-link-guardian-config.json');
  await fs.writeFile(policy, JSON.stringify({ allowForceRestart: true }));
  try {
    const f = fixture([hardFault, healthy], () => ({ stdout: JSON.stringify({ desktopRecovery: { state: 'restarted' } }) }));
    assert.equal((await f.run()).ok, true); assert.equal(f.calls.length, 1); assert.ok(f.calls[0][1].includes('-RestartDesktop'));
  } finally { await fs.rm(policy); }
});
test('string force policy cannot grant restart', async () => {
  const policy = path.join(root, 'logs', 'state', 'mobile-link-guardian-config.json');
  await fs.writeFile(policy, JSON.stringify({ allowForceRestart: 'true' }));
  try { const f = fixture([hardFault]); assert.equal((await f.run()).requiresConfirmation, true); assert.equal(f.calls.length, 0); }
  finally { await fs.rm(policy); }
});
test('hard without explicit boolean confirmation performs no repair', async () => {
  const f = fixture(); const result = await f.run({ mode: 'hard', confirmHardRestart: 'true' });
  assert.equal(result.ok, false); assert.equal(result.requiresConfirmation, true); assert.equal(f.calls.length, 0);
});
test('confirmed hard executes restart even while healthy', async () => {
  const f = fixture([healthy], () => ({ stdout: JSON.stringify({ desktopRecovery: { state: 'restarted' } }) }));
  assert.equal((await f.run({ mode: 'hard', confirmHardRestart: true })).ok, true);
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0][1].includes('-RestartDesktop'));
  assert.equal(f.reads.filter((url) => url.includes('/health?')).length, 2);
});
test('hard no-op/join/timeout cannot falsely report completed restart', async () => {
  for (const runner of [() => ({ stdout: '{}' }), () => ({ stdout: '{"desktopRecovery":{"state":"pending"}}' }), () => { throw new Error('timeout secret'); }]) {
    const f = fixture([healthy], runner); const result = await f.run({ mode: 'hard', confirmHardRestart: true });
    assert.equal(result.ok, false); assert.equal(result.verification.bridge, true);
    assert.ok(!JSON.stringify(result).includes('secret')); assert.equal(f.calls.length, 1);
  }
});
test('target requires strict verified flag and matching identity, never sessions membership', async () => {
  for (const desktop of [{ desktopLive: true, sessionVerified: 'true' }, { desktopLive: true, targetVerified: true, targetSessionId: 'someone-else' }]) {
    const f = fixture([{ ...healthy, desktop: { desktop } }]);
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.verification.targetSession, false);
    assert.equal(f.calls.length, 1); assert.ok(!f.calls[0][1].includes('-RestartDesktop'));
  }
});
test('empty target is explicitly verified by readable list, app_server does not require desktop', async () => {
  const f = fixture([{ ...healthy, health: { ok: true, runtime: { existingThreadExecution: 'app_server' } }, desktop: { desktop: { desktopLive: false } } }]);
  const result = await f.run({ sessionId: '' });
  assert.equal(result.ok, true); assert.equal(result.verification.targetSession, true); assert.equal(result.verification.desktopRequired, false);
  assert.equal(f.calls.length, 0);
});
test('nonempty app_server target verifies actual detail with CDP offline and routes health by target', async () => {
  const f = fixture([appServer]); const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.verification, { bridge: true, sessions: true, targetSession: true, desktopRequired: false, desktop: false });
  assert.equal(f.calls.length, 0); assert.equal(result.requiresConfirmation, undefined);
  const healthRead = f.reads.map((url) => new URL(url)).find((url) => url.pathname === '/health');
  const targetRead = f.reads.map((url) => new URL(url)).find((url) => url.pathname === '/codex/sessions/target');
  assert.equal(healthRead.searchParams.get('threadId'), 'target');
  assert.equal(targetRead.searchParams.get('tail'), '1');
});
test('app_server target 404 and false detail identity cannot trigger desktop repair even with force policy', async () => {
  const policy = path.join(root, 'logs', 'state', 'mobile-link-guardian-config.json');
  await fs.writeFile(policy, JSON.stringify({ allowForceRestart: true }));
  try {
    for (const response of [{ targetStatus: 404, target: { error: 'not found' } },
      { target: { session: { id: 'another-session' } } }, { target: { session: { threadId: 'target' } } },
      { target: { session: null } }]) {
      const f = fixture([{ ...appServer, sessions: { sessions: [{ id: 'target' }] },
        desktop: healthy.desktop, ...response }]);
      const result = await f.run();
      assert.equal(result.ok, false); assert.equal(result.verification.targetSession, false);
      assert.equal(result.requiresConfirmation, undefined); assert.equal(f.calls.length, 0);
      assert.deepEqual(f.phases, ['checking']);
    }
  } finally { await fs.rm(policy); }
});
test('app_server optional CDP failure cannot block verified business session', async () => {
  const f = fixture([{ ...appServer, desktop: { desktop: { failureClass: 'account' } }, desktopStatus: 503, linkStatus: 429 }]);
  assert.equal((await f.run()).ok, true); assert.equal(f.calls.length, 0);
});
test('app_server detail auth/upstream errors stay failed without local desktop restart', async () => {
  for (const status of [401, 403, 429, 503]) {
    const f = fixture([{ ...appServer, targetStatus: status }]);
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.verification.targetSession, false);
    assert.equal(result.requiresConfirmation, undefined); assert.equal(f.calls.length, 0);
  }
});
test('app_server verifies session list independently and cannot repair it through CDP', async () => {
  const f = fixture([{ ...appServer, sessions: { sessions: null } }]);
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.verification.targetSession, true);
  assert.equal(result.verification.sessions, false); assert.equal(f.calls.length, 0);
});
test('desktop target still requires strict CDP verification despite matching session detail', async () => {
  const f = fixture([{ ...healthy, target: appServer.target,
    desktop: { desktop: { desktopLive: true, targetSessionId: 'target', targetVerified: 'true' } } }]);
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.verification.desktopRequired, true);
  assert.equal(result.verification.targetSession, false);
  assert.ok(!f.reads.some((url) => new URL(url).pathname === '/codex/sessions/target'));
  assert.equal(f.calls.length, 1); assert.ok(!f.calls[0][1].includes('-RestartDesktop'));
});
test('unknown health execution cannot use a link-mode hint to bypass desktop target verification', async () => {
  for (const runtime of [{}, { existingThreadExecution: 'unknown' }]) {
    const f = fixture([{ ...healthy, health: { ok: true, runtime }, target: appServer.target,
      link: { link: { executionMode: 'app_server' } }, desktop: { desktop: { desktopLive: false } } }]);
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.verification.desktopRequired, true);
    assert.equal(result.verification.targetSession, false);
    assert.ok(!f.reads.some((url) => new URL(url).pathname === '/codex/sessions/target'));
  }
});
test('unknown runtime retains desktop requirement and malformed sessions fail verification', async () => {
  const f = fixture([{ ...healthy, health: { ok: true, runtime: {} }, sessions: { ok: true }, desktop: { desktop: { desktopLive: false } } }]);
  const result = await f.run({ sessionId: '' });
  assert.equal(result.ok, false); assert.equal(result.verification.sessions, false); assert.equal(result.verification.desktopRequired, true);
});
test('auth, account and upstream faults do not trigger local restarts', async () => {
  for (const state of [{ ...healthy, healthStatus: 401 }, { ...healthy, sessionsStatus: 503 },
    { ...softFault, desktop: { desktop: { failureClass: 'account' } } }, { ...healthy, linkStatus: 429 }]) {
    const f = fixture([state]); assert.equal((await f.run({ mode: 'hard', confirmHardRestart: true })).ok, false); assert.equal(f.calls.length, 0);
  }
});
test('session text only reaches encoded HTTP URL, never command argv', async () => {
  const sessionId = 'x&invalid="; Remove-Item / #';
  const f = fixture([softFault]); await f.run({ sessionId });
  assert.ok(f.reads.some((url) => new URL(url).searchParams.get('sessionId') === sessionId));
  assert.ok(f.calls.every((call) => !call[1].includes(sessionId)));
});
test('executor rejects remote URLs and invalid jobs before running a script', async () => {
  assert.throws(() => createMobileControlExecutor({ repoRoot: root, bridgeUrl: 'http://example.com' }), /loopback/);
  const f = fixture(); await assert.rejects(f.run({ mode: 'bad' }), /Invalid/); assert.equal(f.calls.length, 0);
});
