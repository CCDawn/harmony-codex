import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const serviceSource = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionConnectionFailure.ets', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
const importSource = async (source) => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const { SessionConnectionFailure } = await importSource(serviceSource);
const unknown = { diagnosticsAvailable: false, failureClass: '', requiresDesktopCdp: false, desktopProcessMode: '', repairAction: '' };
const plain = { ...unknown, diagnosticsAvailable: true, failureClass: 'codex_plain_no_cdp', requiresDesktopCdp: true, desktopProcessMode: 'plain' };
const serverError = '桥接返回异常 HTTP 500：connect ECONNREFUSED 127.0.0.1:9229';
const present = (error, context = unknown) => SessionConnectionFailure.present(error, context);

test('confirmed desktop interface absence offers confirmed restart, while missing desktop offers start', () => {
  assert.equal(present(serverError, plain).kind, 'desktop_interface_missing');
  assert.equal(present(serverError, plain).action, 'hard_restart');
  const missing = present(serverError, { ...plain, failureClass: 'codex_not_running', desktopProcessMode: 'missing' });
  assert.equal(missing.kind, 'desktop_missing');
  assert.equal(missing.actionLabel, '启动桌面连接');
});

test('refused loopback port and stale diagnostics alone never justify CDP restart', () => {
  for (const context of [unknown, { ...plain, diagnosticsAvailable: false }]) {
    assert.equal(present(serverError, context).kind, 'unknown');
    assert.equal(present(serverError, context).action, 'retry');
    assert.equal(present('connect ECONNREFUSED 127.0.0.1:9229', context).kind, 'network');
  }
});

test('actual HTTP auth failure takes precedence and offers pairing', () => {
  for (const code of [401, 403]) {
    const failure = present(`桥接返回异常 HTTP ${code}：拒绝访问`, plain);
    assert.equal(failure.kind, 'authentication');
    assert.equal(failure.action, 'pairing');
  }
  assert.equal(present('桥接返回异常 HTTP 500：unexpected token').kind, 'unknown');
});

test('timeouts and transport failures are not misreported as desktop startup failures', () => {
  for (const text of ['桥接请求失败：Timeout was reached', 'HTTP 504', 'Codex 桌面 CDP 请求超时']) {
    assert.equal(present(text, plain).kind, 'timeout');
    assert.equal(present(text, plain).action, 'retry');
  }
  for (const text of ['桥接请求失败：Could not resolve host', 'Failed to connect', 'ECONNRESET', 'Network is unreachable']) {
    assert.equal(present(text, plain).kind, 'network');
    assert.equal(present(text, plain).action, 'retry');
  }
});

test('known desktop disconnection offers soft recovery and service/unknown failures retain retry', () => {
  for (const failureClass of ['desktop_cdp_unavailable', 'desktop_live_host_offline']) {
    const failure = present(serverError, { ...unknown, diagnosticsAvailable: true, failureClass });
    assert.equal(failure.kind, 'desktop_disconnected');
    assert.equal(failure.action, 'soft_repair');
  }
  assert.equal(present('Codex CDP 连接失败 ECONNREFUSED').action, 'soft_repair');
  assert.equal(present('Bridge 协议不兼容：服务版本过旧').kind, 'protocol');
  assert.equal(present('HTTP 502').kind, 'service_unavailable');
  assert.equal(present('未知错误').action, 'retry');
});

function method(name) {
  const start = indexSource.indexOf(`  private ${name}(`);
  const asyncStart = indexSource.indexOf(`  private async ${name}(`);
  const offset = start >= 0 ? start : asyncStart;
  assert.ok(offset >= 0, `method ${name} exists`);
  const next = indexSource.indexOf('\n  private ', offset + 1);
  return indexSource.slice(offset, next).trim();
}

const { createHarness } = await importSource(`${serviceSource}
export function createHarness(BridgeClient) {
  return new class {
    sessionsLoadError = ''; sessionsFailureDiagnosticsAvailable = false; sessionsFailureDetailsExpanded = false;
    desktopLiveFailureClass = ''; desktopLiveRequiresDesktopCdp = false; desktopLiveProcessMode = ''; systemRepairAction = '';
    isNewSessionDraft = false; selectedSession = null; calls = [];
    sessionRuntimeStore = { mergeSessions: (sessions) => sessions };
    loadCompanionProfile() { return Promise.resolve(); }
    normalizedBridgeUrl() { return 'https://bridge.example'; }
    bridgeToken = 'test';
    errorText(error) { return error.message; }
    applyRuntimeSnapshotOutcome() { return Promise.resolve(); }
    applySystemLinkStatus(link) {
      this.desktopLiveFailureClass = link.desktop?.failureClass ?? '';
      this.desktopLiveRequiresDesktopCdp = link.desktop?.requiresDesktopCdp === true;
      this.desktopLiveProcessMode = link.desktop?.desktopProcessMode ?? '';
      this.systemRepairAction = link.recommendedAction ?? '';
    }
    log() {}
    confirmHardRestartCodexFromPhone(source) { this.calls.push(['confirm', source]); }
    repairDesktopLiveFromPhone(source, desktopOnly) { this.calls.push(['soft', source, desktopOnly]); }
    openConfigurationPage(page) { this.calls.push(['configuration', page]); }
    refreshSessions(source) { this.calls.push(['refresh', source]); }
    ${method('loadCanonicalSessionSummaries')}
    ${method('sessionConnectionFailure')}
    ${method('handleSessionConnectionFailureAction')}
  };
}`);

test('failed session read records current diagnosis without requesting recovery; later success clears failure', async () => {
  let failing = true;
  const bridgeCalls = [];
  const harness = createHarness({
    listSessions: async () => { if (failing) throw new Error(serverError); return [{ id: 'session' }]; },
    getRuntimeSnapshot: async () => ({}),
    getSystemLinkStatus: async () => {
      bridgeCalls.push('diagnose');
      return { desktop: { failureClass: 'codex_plain_no_cdp', requiresDesktopCdp: true, desktopProcessMode: 'plain' } };
    }
  });
  await assert.rejects(harness.loadCanonicalSessionSummaries('test'), /ECONNREFUSED/);
  assert.equal(harness.sessionConnectionFailure().kind, 'desktop_interface_missing');
  assert.deepEqual(bridgeCalls, ['diagnose']);
  assert.deepEqual(harness.calls, []);
  harness.handleSessionConnectionFailureAction();
  assert.deepEqual(harness.calls, [['confirm', 'sessions_connection_failure']]);
  failing = false;
  assert.deepEqual(await harness.loadCanonicalSessionSummaries('test'), [{ id: 'session' }]);
  assert.equal(harness.sessionsLoadError, '');
  assert.equal(harness.sessionsFailureDiagnosticsAvailable, false);
});

test('failed diagnosis and absent desktop result leave old hard-restart state unusable', async () => {
  for (const getSystemLinkStatus of [async () => { throw new Error('offline'); }, async () => ({})]) {
    const harness = createHarness({ listSessions: async () => { throw new Error(serverError); }, getRuntimeSnapshot: async () => ({}), getSystemLinkStatus });
    harness.sessionsFailureDiagnosticsAvailable = true;
    harness.desktopLiveFailureClass = 'codex_plain_no_cdp';
    await assert.rejects(harness.loadCanonicalSessionSummaries('test'));
    assert.equal(harness.sessionConnectionFailure().kind, 'unknown');
    harness.handleSessionConnectionFailureAction();
    assert.deepEqual(harness.calls, [['refresh', 'pull']]);
  }
});

test('action routing uses confirmation, explicit soft recovery, pairing and refresh', () => {
  const harness = createHarness({});
  harness.sessionsLoadError = 'HTTP 401';
  harness.handleSessionConnectionFailureAction();
  harness.sessionsLoadError = 'Codex CDP 连接失败';
  harness.handleSessionConnectionFailureAction();
  harness.sessionsLoadError = 'timeout';
  harness.handleSessionConnectionFailureAction();
  assert.deepEqual(harness.calls, [['configuration', 'pairing'], ['soft', 'sessions_connection_failure', true], ['refresh', 'pull']]);
});

const { createRecoveryHarness } = await importSource(`
export function createRecoveryHarness(BridgeClient) {
  return new class {
    desktopLiveRestarting = false; isNewSessionDraft = false; selectedSession = null; bridgeToken = 'test'; message = '';
    canRepairDesktopLive() { return !this.desktopLiveRestarting; }
    normalizedBridgeUrl() { return 'https://bridge.example'; }
    applySystemLinkStatus() {}
    systemLinkMessageText(link) { return link.message ?? ''; }
    applySystemRepairStatus() {}
    systemRepairMessageText(system) { return system.message ?? ''; }
    log() {}
    refreshDashboard() { return Promise.resolve(); }
    errorText(error) { return error.message; }
    ${method('repairDesktopLiveFromPhone')}
  };
}`);

test('session-list soft action invokes explicit soft endpoint with restart confirmation false', async () => {
  const calls = [];
  const harness = createRecoveryHarness({
    repairSystemLink: async (...args) => { calls.push(args); return { severity: 'ok', desktop: { desktopLive: true } }; },
    recoverSystemLink: async () => { throw new Error('auto recovery must not be requested'); }
  });
  assert.equal(await harness.repairDesktopLiveFromPhone('sessions_connection_failure', true), true);
  assert.deepEqual(calls, [['https://bridge.example', 'test', '', 'soft', false]]);
  assert.equal(harness.desktopLiveRestarting, false);
});
