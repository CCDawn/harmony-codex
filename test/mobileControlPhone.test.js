import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = '../HarmonyCodexRemote/entry/src/main/ets/';
const read = file => fs.readFileSync(new URL(root + file, import.meta.url), 'utf8');
const indexSource = read('pages/Index.ets');
const clientSource = read('services/BridgeClient.ets');
const serviceSource = read('services/MobileControlService.ets');
const executable = source => stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const job = (overrides = {}) => ({
  version: 1, id: 'a'.repeat(32), requestId: 'phone-request', mode: 'auto', sessionId: 'session-one',
  status: 'succeeded', phase: 'verified', message: 'desktop verified', createdAt: '', updatedAt: '', completedAt: '',
  verification: { bridge: true, sessions: true, targetSession: true, desktopRequired: true, desktop: true }, ...overrides
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('both draft and existing conversations expose bounded progress only while repair runs', () => {
  const panel = indexSource.slice(indexSource.indexOf('  SessionConversationPanel()'), indexSource.indexOf('  SessionControlProgress()'));
  assert.equal((panel.match(/this\.SessionControlProgress\(\)/g) ?? []).length, 2);
  const progress = indexSource.slice(indexSource.indexOf('  SessionControlProgress()'), indexSource.indexOf('  SessionPendingInteractions()'));
  assert.match(progress, /if \(this\.desktopLiveRestarting\)/);
  assert.match(progress, /Text\(this\.mobileControlMessage\)/);
  assert.match(progress, /maxLines\(2\)/);
});

function clientHarness(respond) {
  const calls = [];
  let destroyed = 0;
  const http = { RequestMethod: { GET: 'GET', POST: 'POST' }, createHttp: () => ({
    async request(url, options) { calls.push({ url, ...options }); return respond(url, options, calls.length); },
    destroy() { destroyed++; }
  }) };
  const Client = new Function('http', 'CredentialRuntime', 'TotpGenerator', executable(clientSource) + '; return BridgeClient;')(
    http, { getRuntimeTotpSecret: () => '' }, { currentCode: async () => '' });
  Client.delay = async () => {};
  return { Client, calls, destroyed: () => destroyed };
}

function controlService(client) {
  const Service = new Function('BridgeClient', executable(serviceSource) + '; return MobileControlService;')(client);
  Service.delay = async () => {};
  return Service;
}

function indexMethod(name) {
  const match = new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm').exec(indexSource);
  assert.ok(match, `Index method ${name} exists`);
  const start = match.index;
  const next = indexSource.indexOf('\n  private ', start + 1);
  return indexSource.slice(start, next < 0 ? undefined : next).trim();
}

function phoneHarness(client, service = controlService(client)) {
  const methods = ['repairDesktopLiveFromPhone', 'repairDesktopLiveHardFromPhone', 'runMobileControlRepair',
    'refreshMobileControlStatus', 'openConfigurationPage', 'initializeBridgeCredential'];
  const credential = deferred();
  const create = new Function('BridgeClient', 'MobileControlService', 'DEFAULT_CONTROL_TARGET_ID',
    'BridgeCredentialStore', 'CredentialRuntime', 'getContext', executable(`class Phone {
      ${methods.map(indexMethod).join('\n')}
    }`) + '; return new Phone();');
  const phone = create(client, service, 'desktop-one', { loadCredential: () => credential.promise },
    { getRuntimeToken: () => phone.bridgeToken }, () => ({}));
  Object.assign(phone, {
    url: 'https://phone.example', bridgeToken: 'old-token', desktopLiveRestarting: false,
    selectedSession: { id: 'session-one' }, isNewSessionDraft: false,
    mobileControlJob: null, mobileControlMessage: '', message: 'current page',
    navigation: { revision: 1 }, dashboardCalls: [], detailCalls: [],
    normalizedBridgeUrl() { return this.url; }, readSessionNavigation() { return this.navigation; },
    async refreshDashboard(...args) { this.dashboardCalls.push(args); },
    async loadSessionDetail(id) { this.detailCalls.push(id); }, errorText: error => error.message, log() {},
    stopSessionEventStream() {}, refreshPairingUiState() {}, checkPairingConnection() {}, syncPushRegistration() {},
    detectScanPairingSupport: () => false, startBridgeOtpRefresh() {}, loadCompanionProfile() {},
    applyRuntimeCredential(value) { this.url = value.bridgeUrl; this.bridgeToken = value.token; }
  });
  return { phone, service, credential };
}

test('control endpoints use the independent control route without probing business APIs', async () => {
  const { Client, calls } = clientHarness(url => {
    assert.match(url, /^https:\/\/phone.example\/control\/v1\/targets\/desktop-one\//);
    return { responseCode: 200, result: JSON.stringify(url.endsWith('/status')
      ? { version: 1, agent: { online: true, targetId: 'desktop-one' }, activeJob: null, lastJob: null }
      : { version: 1, job: job() }) };
  });
  await Client.getMobileControlStatus('https://phone.example/', 'token', 'desktop-one');
  await Client.startMobileControlRepair('https://phone.example/', 'token', 'desktop-one', 'session-one', false, 'stable-id');
  await Client.getMobileControlRepair('https://phone.example/', 'token', 'desktop-one', job().id);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET']);
  assert.equal(calls[1].header['X-Codex-Bridge-Token'], 'token');
  assert.deepEqual(JSON.parse(calls[1].extraData), { requestId: 'stable-id', sessionId: 'session-one', mode: 'auto', confirmHardRestart: false });
});

test('POST transport retry preserves the request id and body, uses bounded options, and creates no second logical task', async () => {
  const requests = new Map();
  const { Client, calls, destroyed } = clientHarness((_url, options, count) => {
    const payload = JSON.parse(options.extraData);
    if (!requests.has(payload.requestId)) requests.set(payload.requestId, job({ requestId: payload.requestId }));
    if (count === 1) throw new Error('operation timeout after desktop accepted POST');
    return { responseCode: 200, result: JSON.stringify({ version: 1, job: requests.get(payload.requestId) }) };
  });
  const service = controlService(Client);
  service.requestId = () => 'fixed-phone-request';
  assert.equal((await service.repair('https://phone.example', 'token', 'desktop-one', 'session-one', false, () => {})).requestId, 'fixed-phone-request');
  assert.equal(calls.length, 2);
  assert.equal(requests.size, 1);
  assert.equal(calls[0].extraData, calls[1].extraData);
  assert.ok(calls.every(call => call.method === 'POST' && call.connectTimeout === 8000 && call.readTimeout === 20000));
  assert.equal(destroyed(), 2);
});

test('repair submission stops after one transient retry and never retries an authorization failure', async () => {
  for (const failure of ['timeout', 'authorization']) {
    const { Client, calls } = clientHarness(() => {
      if (failure === 'timeout') throw new Error('operation timeout');
      return { responseCode: 403, result: JSON.stringify({ error: 'denied' }) };
    });
    await assert.rejects(Client.startMobileControlRepair('https://phone.example', 'token', 'desktop-one', '', false, 'stable-id'));
    assert.equal(calls.length, failure === 'timeout' ? 2 : 1);
    assert.ok(calls.every(call => JSON.parse(call.extraData).requestId === 'stable-id'));
  }
});

test('hard restart requires explicit hard confirmation while automatic repair never supplies it', async () => {
  const { Client, calls } = clientHarness((_url, options) => ({ responseCode: 200,
    result: JSON.stringify({ version: 1, job: job({ mode: JSON.parse(options.extraData).mode }) }) }));
  for (const hard of [false, true]) await Client.startMobileControlRepair('https://phone.example', 'token', 'desktop-one', '', hard, `id-${hard}`);
  assert.deepEqual(calls.map(call => JSON.parse(call.extraData)), [
    { requestId: 'id-false', sessionId: '', mode: 'auto', confirmHardRestart: false },
    { requestId: 'id-true', sessionId: '', mode: 'hard', confirmHardRestart: true }
  ]);
  const { phone } = phoneHarness({});
  const delegated = [];
  phone.runMobileControlRepair = async (...args) => { delegated.push(args); return true; };
  await phone.repairDesktopLiveFromPhone('soft', true);
  await phone.repairDesktopLiveHardFromPhone('confirmed');
  assert.deepEqual(delegated, [['soft', false], ['confirmed', true]]);
});

test('polling recovers from transport loss using only GET and deduplicates unchanged progress', async () => {
  const calls = [];
  let polls = 0;
  const running = job({ status: 'running', phase: 'repairing', message: 'working' });
  const service = controlService({
    async startMobileControlRepair(...args) { calls.push(['POST', ...args]); return running; },
    async getMobileControlRepair(...args) {
      calls.push(['GET', ...args]); polls++;
      if (polls === 1) throw new Error('HTTP 503 network disconnected');
      return polls === 2 ? { ...running } : job();
    }
  });
  const progress = [];
  assert.equal((await service.repair('control-url', 'token', 'desktop-one', 'session-one', false, value => progress.push(value.status))).status, 'succeeded');
  assert.deepEqual(calls.map(call => call[0]), ['POST', 'GET', 'GET', 'GET']);
  assert.deepEqual(progress, ['running', 'succeeded']);
  assert.ok(calls.slice(1).every(call => call.at(-1) === running.id));
});

test('authentication, missing jobs and incompatible polling results stop instead of retrying forever', async () => {
  for (const message of ['HTTP 401 authentication', 'HTTP 403 denied', 'HTTP 404 job missing', '响应格式不兼容']) {
    let polls = 0;
    const service = controlService({ getMobileControlRepair: async () => { polls++; throw new Error(message); } });
    await assert.rejects(service.watch('', '', '', job({ status: 'running' }), () => {}), error => error.message === message);
    assert.equal(polls, 1);
  }
});

test('initial session and mode mismatches are rejected before watching the task', async () => {
  for (const mismatch of [{ sessionId: 'other-session' }, { mode: 'hard' }]) {
    const service = controlService({ startMobileControlRepair: async () => job(mismatch), getMobileControlRepair() { assert.fail('must not poll foreign task'); } });
    await assert.rejects(service.repair('', '', '', 'session-one', false, () => assert.fail('foreign task progress')), /不一致/);
  }
});

test('poll responses must retain task id, session and mode before publishing progress', async () => {
  for (const mismatch of [{ id: 'b'.repeat(32) }, { sessionId: 'other-session' }, { mode: 'hard' }]) {
    const service = controlService({ getMobileControlRepair: async () => job(mismatch) });
    const published = [];
    await assert.rejects(service.watch('', '', '', job({ status: 'running' }), value => published.push(value)), /不一致/);
    assert.equal(published.length, 1);
    assert.equal(published[0].status, 'running');
  }
});

test('verification requires succeeded status, exact target and literal true for every required check', () => {
  const service = controlService({});
  assert.equal(service.verified(job(), 'session-one'), true);
  assert.equal(service.verified(job({ verification: { ...job().verification, desktopRequired: false, desktop: false } }), 'session-one'), true);
  for (const status of ['queued', 'running', 'failed', 'needs_confirmation']) assert.equal(service.verified(job({ status }), 'session-one'), false);
  assert.equal(service.verified(job(), 'other-session'), false);
  assert.equal(service.verified(job({ verification: undefined }), 'session-one'), false);
  for (const field of ['bridge', 'sessions', 'targetSession', 'desktop']) {
    for (const value of [false, undefined, 'true', 1]) assert.equal(service.verified(job({ verification: { ...job().verification, [field]: value } }), 'session-one'), false, `${field}=${value}`);
  }
  assert.equal(service.verified(job({ verification: { ...job().verification, desktopRequired: undefined, desktop: false } }), 'session-one'), false);
  for (const desktopRequired of [undefined, null, 'false', 'true', 0, 1]) {
    assert.equal(service.verified(job({ verification: { ...job().verification, desktopRequired } }), 'session-one'), false, `desktopRequired=${desktopRequired}`);
  }
  for (const desktop of [undefined, null, 'false', 'true', 0, 1]) {
    assert.equal(service.verified(job({ verification: { ...job().verification, desktopRequired: false, desktop } }), 'session-one'), false, `optional desktop=${desktop}`);
  }
});

test('control response parsers reject malformed task identity and incompatible status discovery', async () => {
  for (const override of [{ version: 2 }, { id: 'not-a-job' }, { sessionId: null }, { mode: 'soft' }, { status: 'ready' }, { message: null }]) {
    const { Client } = clientHarness(() => ({ responseCode: 200, result: JSON.stringify({ version: 1, job: job(override) }) }));
    await assert.rejects(Client.getMobileControlRepair('control-url', '', 'desktop-one', job().id), /格式不兼容/);
  }
  for (const agent of [{ online: false, targetId: 'desktop-one' }, { online: true, targetId: 'other' }]) {
    const { Client } = clientHarness(() => ({ responseCode: 200, result: JSON.stringify({ version: 1, agent, activeJob: null, lastJob: null }) }));
    await assert.rejects(Client.getMobileControlStatus('control-url', '', 'desktop-one'), /响应不兼容/);
  }
});

test('status discovery resumes an existing task using GET without a new POST', async () => {
  const calls = [];
  const existing = job({ status: 'running', mode: 'hard' });
  const { phone } = phoneHarness({
    async getMobileControlStatus(...args) { calls.push(['status', ...args]); return { activeJob: existing, lastJob: null }; },
    async getMobileControlRepair(...args) { calls.push(['GET', ...args]); return job({ mode: 'hard' }); },
    startMobileControlRepair() { assert.fail('resume must never POST'); },
    async getSession(...args) { calls.push(['business', ...args]); return { id: 'session-one' }; }
  });
  await phone.refreshMobileControlStatus();
  assert.deepEqual(calls.map(call => call[0]), ['status', 'GET', 'business']);
  assert.equal(calls[1].at(-1), existing.id);
  assert.match(phone.mobileControlMessage, /手机与目标会话验证通过/);
  assert.equal(phone.desktopLiveRestarting, false);
});

test('phone business read failure or wrong target cannot report repair success', async () => {
  for (const readFailure of ['session', 'list', 'wrong-target']) {
    const { phone } = phoneHarness({
      startMobileControlRepair: async () => job({ sessionId: readFailure === 'list' ? '' : 'session-one' }),
      async getSession() { if (readFailure === 'wrong-target') return { id: 'other-session' }; throw new Error('business route offline'); },
      async listSessions() { throw new Error('business route offline'); }
    });
    if (readFailure === 'list') phone.selectedSession = null;
    assert.equal(await phone.runMobileControlRepair('test', false), false);
    assert.match(phone.mobileControlMessage, /结果尚未确认/);
    assert.doesNotMatch(phone.mobileControlMessage, /验证通过/);
    assert.equal(phone.message, 'current page');
    assert.deepEqual(phone.dashboardCalls, []);
    assert.deepEqual(phone.detailCalls, []);
    assert.equal(phone.desktopLiveRestarting, false);
  }
});

test('needs-confirmation response never probes business readiness or automatically restarts', async () => {
  const { phone } = phoneHarness({ startMobileControlRepair: async () => job({ status: 'needs_confirmation' }),
    getSession() { assert.fail('unverified task cannot prove business readiness'); } });
  assert.equal(await phone.runMobileControlRepair('test', false), false);
  assert.match(phone.mobileControlMessage, /重启 Codex.*确认/);
  assert.deepEqual(phone.dashboardCalls, []);
});

test('configuration changes terminate local watch before GET without cancelling desktop execution', async () => {
  const waiting = deferred();
  const { phone, service } = phoneHarness({
    startMobileControlRepair: async () => job({ status: 'running' }),
    getMobileControlRepair() { assert.fail('old configuration must not be polled'); },
    cancelMobileControlRepair() { assert.fail('view changes do not cancel desktop repair'); }
  });
  const sleeping = deferred();
  service.delay = async () => { sleeping.resolve(); await waiting.promise; };
  const repair = phone.runMobileControlRepair('test', false);
  await sleeping.promise;
  phone.url = 'https://new.example'; phone.bridgeToken = 'new-token';
  phone.mobileControlJob = null; phone.mobileControlMessage = 'new connection';
  waiting.resolve();
  assert.equal(await repair, false);
  assert.equal(phone.mobileControlJob, null);
  assert.equal(phone.mobileControlMessage, 'new connection');
  assert.deepEqual(phone.dashboardCalls, []);
  assert.equal(phone.desktopLiveRestarting, false);
});

test('configuration changes discard late status, repair and business-read results', async () => {
  for (const stage of ['status', 'repair', 'business']) {
    const waiting = deferred();
    const entered = deferred();
    const { phone } = phoneHarness({
      async startMobileControlRepair() {
        if (stage === 'repair') { entered.resolve(); await waiting.promise; }
        return job();
      },
      async getMobileControlStatus() { entered.resolve(); await waiting.promise; return { activeJob: null, lastJob: job() }; },
      async getSession() { entered.resolve(); await waiting.promise; return { id: 'session-one' }; }
    });
    const pending = stage === 'status' ? phone.refreshMobileControlStatus() : phone.runMobileControlRepair('test', false);
    await entered.promise;
    phone.bridgeToken = 'new-token'; phone.mobileControlJob = null; phone.mobileControlMessage = 'new connection';
    waiting.resolve();
    const result = await pending;
    if (stage !== 'status') assert.equal(result, false);
    assert.equal(phone.mobileControlJob, null);
    assert.equal(phone.mobileControlMessage, 'new connection');
    assert.equal(phone.message, 'current page');
    assert.deepEqual(phone.dashboardCalls, []);
  }
});

test('navigation changes keep successful old repair from refreshing or overwriting the new page', async () => {
  const waiting = deferred();
  const entered = deferred();
  const { phone } = phoneHarness({ startMobileControlRepair: async () => job(),
    async getSession() { entered.resolve(); await waiting.promise; return { id: 'session-one' }; } });
  const pending = phone.runMobileControlRepair('test', false);
  await entered.promise;
  phone.navigation = { revision: 2 };
  phone.selectedSession = { id: 'session-two' };
  phone.message = 'new page message';
  waiting.resolve();
  assert.equal(await pending, true);
  assert.equal(phone.message, 'new page message');
  assert.deepEqual(phone.dashboardCalls, []);
  assert.deepEqual(phone.detailCalls, []);
});

test('successful phone validation refreshes the current target and blocks concurrent repair submissions', async () => {
  const waiting = deferred();
  let submits = 0;
  const { phone } = phoneHarness({ async startMobileControlRepair() { submits++; await waiting.promise; return job(); },
    getSession: async () => ({ id: 'session-one' }) });
  const pending = phone.runMobileControlRepair('test', false);
  assert.equal(await phone.runMobileControlRepair('duplicate', true), false);
  waiting.resolve();
  assert.equal(await pending, true);
  assert.equal(submits, 1);
  assert.match(phone.message, /验证通过/);
  assert.deepEqual(phone.dashboardCalls, [[true]]);
  assert.deepEqual(phone.detailCalls, ['session-one']);
});

test('startup discovers control status only after stored credentials load and settings performs discovery again', async () => {
  const appear = indexSource.slice(indexSource.indexOf('  aboutToAppear()'), indexSource.indexOf('  aboutToDisappear()'));
  assert.match(appear, /this\.initializeBridgeCredential\(\)/);
  assert.doesNotMatch(appear, /this\.refreshMobileControlStatus\(\)/, 'appearance must not race credential initialization with an eager status request');
  const calls = [];
  const { phone, credential } = phoneHarness({ async getMobileControlStatus(...args) {
    calls.push(args); return { activeJob: null, lastJob: null };
  } });
  const initialize = phone.initializeBridgeCredential();
  assert.deepEqual(calls, []);
  credential.resolve({ bridgeUrl: 'https://stored.example', token: 'stored-token' });
  await initialize;
  assert.deepEqual(calls, [['https://stored.example', 'stored-token', 'desktop-one']]);
  phone.openConfigurationPage('settings');
  assert.deepEqual(calls, [calls[0], ['https://stored.example', 'stored-token', 'desktop-one']]);
  assert.equal(phone.activeTab, 'settings');
});
