import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMobileLink, inspectGuardianExtras, inspectMobileLinkStatus, inspectPhoneHeartbeat,
  inspectResources, readSystemResources } from '../tools/windows/mobile-link-diagnostics.mjs';
import { decideGuardian } from '../tools/windows/mobile-link-guardian-policy.mjs';

const baseUrl = 'http://127.0.0.1:1234';
for (const status of [404, 429, 200]) {
  test(`voice handshake HTTP ${status} without an upgrade cannot restart services`, async () => {
    const result = await inspectGuardianExtras({ baseUrl, localReady: true,
      fetchImpl: mockFetch({ '/voice/status': { voice: { enabled: true } } }),
      probeVoice: async () => ({ ok: false, status }) });
    assert.equal(result.faults.length, 1);
    assert.equal(result.faults[0].repairable, false);
  });
}
for (const desktop of [{ httpStatus: 404 }, { httpStatus: 429 }, { httpStatus: 503 }, {}, new Error('offline')]) {
  test(`unconfirmed desktop failure ${desktop.httpStatus || desktop.message || 'invalid body'} never authorizes restarts`, async () => {
    const diagnostics = await inspectMobileLink({ baseUrl, collectSignals: true,
      fetchImpl: mockFetch({ '/desktop/live/status': desktop }) });
    assert.ok(diagnostics.guardianSignals.faults.length > 0);
    assert.ok(diagnostics.guardianSignals.faults.every(f => !f.repairable));
    let state = {};
    for (let tick = 0; tick < 5; tick++) {
      const result = decideGuardian({ config: { enabled: true, allowForceRestart: true }, state, diagnostics });
      assert.equal(result.action, null);
      assert.equal(result.status.phase, 'needs_attention');
      state = result.state;
    }
  });
}
function mockFetch(overrides = {}, calls = []) {
  const bodies = { '/health': {ok:true,runtime:{mode:'desktop'}},
    '/desktop/live/status':{desktop:{desktopLive:true}}, '/codex/sessions?limit=1':{sessions:[]},
    '/companion/profile':{profile:{id:'p',roomId:'r'}},
    '/companion/messages?profileId=p&roomId=r':{entries:[]},
    '/companion/computer/status?assistantId=p&roomId=r':{assistantId:'p',roomId:'r',ready:false},
    '/voice/status':{voice:{enabled:false}}, ...overrides };
  return async (url, options) => {
    calls.push({url,options}); const route = new URL(url).pathname + new URL(url).search;
    const value = bodies[route];
    if (value instanceof Error) throw value;
    return {ok:!value?.httpStatus,status:value?.httpStatus??200,json:async()=>value?.errorBody??value};
  };
}
for (const failureClass of ['api_compatibility','account','auth','upstream']) {
  test(`guardian never repairs ${failureClass} by restarting Codex`,async()=>{
    const result=await inspectMobileLink({baseUrl,collectSignals:true,fetchImpl:mockFetch({
      '/companion/profile':{httpStatus:502,errorBody:{failureClass,private:'not returned'}}})});
    // A 5xx gateway failure can never authenticate, so a stale auth body tag
    // is downgraded to the observed upstream failure.
    const expectedKind = failureClass === 'auth' ? 'upstream' : failureClass;
    assert.deepEqual(result.guardianSignals.faults,[{id:'companion',kind:expectedKind,repairable:false,component:'companion'}]);
    assert.equal(JSON.stringify(result).includes('not returned'),false);
  });
}

test('confirmed local desktop outage is repairable, while HDC and waiting cloud are not failures',async()=>{
  const result=await inspectMobileLink({baseUrl,collectSignals:true,fetchImpl:mockFetch({
    '/desktop/live/status':{desktop:{desktopLive:false,failureClass:'codex_plain_no_cdp'}}})});
  assert.deepEqual(result.guardianSignals.faults,[{id:'desktop',kind:'local_service',repairable:true,component:'desktop'}]);
  assert.equal(result.checks.find(x=>x.id==='computer').state,'waiting');
});

test('authentication failure of desktop does not turn dependency failures into restart signals',async()=>{
  const result=await inspectMobileLink({baseUrl,collectSignals:true,fetchImpl:mockFetch({
    '/desktop/live/status':{httpStatus:401,errorBody:{}},'/codex/sessions?limit=1':{httpStatus:502,errorBody:{}},
    '/companion/profile':{httpStatus:502,errorBody:{}}})});
  assert.ok(result.guardianSignals.faults.every(f=>f.kind==='auth'&&!f.repairable));
});

test('public gateway outage is repairable only when local business reads pass',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return url.startsWith('https:')
    ?{ok:false,status:502,json:async()=>({})}:{ok:true,status:200,json:async()=>({voice:{enabled:false}})};};
  const result=await inspectGuardianExtras({baseUrl,publicBaseUrl:'https://relay.example',localReady:true,fetchImpl});
  assert.deepEqual(result.faults,[{id:'public',kind:'transport',repairable:true,component:'public'}]);
  assert.equal(calls[0].options.redirect,'manual');
  const blocked=await inspectGuardianExtras({baseUrl,publicBaseUrl:'https://relay.example',localReady:false,fetchImpl});
  assert.deepEqual(blocked.faults,[]);
});

test('idle disabled voice is unverified and no voice handshake or call is attempted',async()=>{
  let probes=0;const result=await inspectGuardianExtras({baseUrl,localReady:true,
    fetchImpl:mockFetch(),probeVoice:async()=>{probes++;}});
  assert.equal(probes,0);assert.equal(result.checks.find(check=>check.id==='voice_transport').state,'unverified');assert.deepEqual(result.faults,[]);
});

test('voice transport probe is explicitly distinct from an actual call',async()=>{
  const result=await inspectGuardianExtras({baseUrl,localReady:true,
    fetchImpl:mockFetch({'/voice/status':{voice:{enabled:true,pid:null}}}),
    probeVoice:async()=>({ok:true,status:101})});
  assert.equal(result.checks.find(check=>check.id==='voice_transport').state,'ready');assert.match(result.checks.find(check=>check.id==='voice_transport').message,/未发起通话/);
  assert.deepEqual(result.faults,[]);
});


test('public voice failure is isolated from a healthy local voice service',async()=>{
  const routes=[];
  const result=await inspectGuardianExtras({baseUrl,publicBaseUrl:'https://relay.example',localReady:true,
    fetchImpl:mockFetch({'/voice/status':{voice:{enabled:true}}}),
    probeVoice:async url=>{routes.push(url);return {ok:url===baseUrl,status:url===baseUrl?101:502};}});
  assert.equal(routes.length,2);
  assert.deepEqual(result.faults,[{id:'voice_public',kind:'transport',repairable:true,component:'public'}]);
});

const GiB = 1024 ** 3;
const healthyResources = () => ({ commitLimitBytes: 32 * GiB, commitAvailableBytes: 16 * GiB, availablePhysicalBytes: 8 * GiB });
const now = Date.parse('2026-10-19T00:00:00Z');
const recentPhone = () => ({ lastSeenAt: new Date(now - 30_000).toISOString() });
const stalePhone = () => ({ lastSeenAt: new Date(now - 300_000).toISOString() });

test('ordinary Status reports a broken public entrance while local reads pass and never probes voice', async () => {
  const calls = [];
  let voiceProbes = 0;
  const localFetch = mockFetch({ '/voice/status': { voice: { enabled: true } } }, calls);
  const result = await inspectMobileLinkStatus({ baseUrl, publicBaseUrl: 'https://relay.example', now,
    phoneProvider: recentPhone, resourceProvider: healthyResources,
    getHeaders: () => ({ 'X-Codex-Bridge-Token': 'private-token' }),
    fetchImpl: (url, options) => url.startsWith('https:')
      ? (calls.push({ url, options }), Promise.resolve({ ok: false, status: 502 })) : localFetch(url, options),
    probeVoice: async () => { voiceProbes++; throw new Error('must not probe'); } });
  assert.equal(result.checks.find(check => check.id === 'bridge').state, 'ready');
  assert.equal(result.checks.find(check => check.id === 'public').state, 'error');
  assert.equal(result.checks.find(check => check.id === 'phone_recent').state, 'ready');
  assert.equal(voiceProbes, 0);
  assert.equal(calls.some(call => call.url.endsWith('/voice/status')), false);
  const publicCall = calls.find(call => call.url.startsWith('https:'));
  assert.equal(publicCall.options.headers['X-Codex-Bridge-Token'], 'private-token');
  assert.equal(publicCall.options.redirect, 'manual');
  assert.ok(publicCall.options.signal instanceof AbortSignal);
  assert.equal(result.guardianSignals, undefined);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('relay.example'), false);
});

test('Status and guardian share public, phone and resource check states', async () => {
  const options = { baseUrl, publicBaseUrl: 'https://relay.example', now, fetchImpl: mockFetch(),
    phoneProvider: recentPhone, resourceProvider: healthyResources };
  const status = await inspectMobileLinkStatus(options);
  const guardian = await inspectMobileLinkStatus({ ...options, guardianMode: true });
  for (const id of ['public', 'phone_recent', 'resources']) {
    assert.deepEqual(status.checks.find(check => check.id === id), guardian.checks.find(check => check.id === id));
  }
  assert.equal(guardian.guardianSignals.phoneLastSeenAt, recentPhone().lastSeenAt);
  assert.deepEqual(guardian.guardianSignals.faults, []);
});

test('stale or missing phone heartbeat never authorizes a restart or requires HDC', async () => {
  for (const phoneProvider of [stalePhone, () => null, () => { throw new Error('private file error'); }]) {
    const diagnostics = await inspectMobileLinkStatus({ baseUrl, guardianMode: true, now,
      fetchImpl: mockFetch(), phoneProvider, resourceProvider: healthyResources });
    assert.ok(['waiting', 'unknown'].includes(diagnostics.checks.find(check => check.id === 'phone_recent').state));
    assert.match(diagnostics.checks.find(check => check.id === 'phone_recent').message, /应用/);
    assert.deepEqual(diagnostics.guardianSignals.faults, []);
    assert.equal(diagnostics.checks.some(check => /hdc/i.test(check.id)), false);
    let state = {};
    for (let tick = 0; tick < 5; tick++) {
      const decision = decideGuardian({ config: { enabled: true, allowForceRestart: true }, diagnostics, state });
      assert.equal(decision.action, null); state = decision.state;
    }
  }
});

test('future or malformed phone heartbeat is unknown and expiry uses the two minute boundary', () => {
  for (const lastSeenAt of ['invalid', new Date(now + 1).toISOString()]) {
    assert.equal(inspectPhoneHeartbeat({ phone: { lastSeenAt }, now }).state, 'unknown');
  }
  assert.equal(inspectPhoneHeartbeat({ phone: { lastSeenAt: new Date(now - 120_000).toISOString() }, now }).state, 'ready');
  assert.equal(inspectPhoneHeartbeat({ phone: { lastSeenAt: new Date(now - 120_001).toISOString() }, now }).state, 'waiting');
});

test('resource pressure reports local capacity and never authorizes or blocks confirmed recovery', async () => {
  const resourceProvider = () => ({ ...healthyResources(), commitAvailableBytes: GiB });
  const diagnostics = await inspectMobileLinkStatus({ baseUrl, guardianMode: true, now,
    fetchImpl: mockFetch(), resourceProvider, phoneProvider: recentPhone });
  assert.equal(diagnostics.checks.find(check => check.id === 'resources').state, 'waiting');
  assert.match(diagnostics.summary, /本机资源不足/);
  assert.equal(diagnostics.nextAction, 'check_resources');
  assert.deepEqual(diagnostics.guardianSignals.faults, []);
  assert.equal(decideGuardian({ config: { enabled: true }, diagnostics }).action, null);
  const outage = await inspectMobileLinkStatus({ baseUrl, guardianMode: true, now, resourceProvider,
    phoneProvider: stalePhone, fetchImpl: mockFetch({ '/desktop/live/status': { desktop: { desktopLive: false, failureClass: 'codex_plain_no_cdp' } } }) });
  const first = decideGuardian({ config: { enabled: true }, diagnostics: outage });
  const second = decideGuardian({ config: { enabled: true }, diagnostics: outage, state: first.state });
  assert.deepEqual(second.action, { stage: 'reconnect', components: ['desktop'] });
});

test('resource thresholds include either absolute or percentage commit headroom', async () => {
  for (const [limit, available, state] of [[32, 1.9, 'waiting'], [128, 4, 'waiting'], [40, 2, 'ready'], [32, 16, 'ready']]) {
    const result = await inspectResources({ resourceProvider: () => ({ commitLimitBytes: limit * GiB,
      commitAvailableBytes: available * GiB, availablePhysicalBytes: 4 * GiB }) });
    assert.equal(result.state, state);
  }
});

test('resource failure, invalid counters and timeout remain unconfirmed without exposing raw errors', async () => {
  for (const resourceProvider of [() => { throw new Error('secret details'); }, () => ({}),
    () => ({ ...healthyResources(), commitAvailableBytes: Infinity }), () => new Promise(() => {})]) {
    const result = await inspectResources({ resourceProvider, timeoutMs: 15 });
    assert.equal(result.state, 'unknown');
    assert.match(result.message, /未确认/);
    assert.equal(JSON.stringify(result).includes('secret details'), false);
  }
});

test('resource probe failure stays visible and does not become a guardian fault', async () => {
  const diagnostics = await inspectMobileLinkStatus({ baseUrl, guardianMode: true, now, fetchImpl: mockFetch(),
    phoneProvider: recentPhone, resourceProvider: () => { throw new Error('private counter failure'); } });
  assert.equal(diagnostics.checks.find(check => check.id === 'resources').state, 'unknown');
  assert.match(diagnostics.summary, /资源未确认/);
  assert.deepEqual(diagnostics.guardianSignals.faults, []);
  assert.equal(decideGuardian({ config: { enabled: true }, diagnostics }).action, null);
});

test('public-only probe has an abort deadline and skips every voice request', async () => {
  let calls = 0;
  const start = performance.now();
  // Keep the harness alive while AbortSignal.timeout's unref timer fires.
  const keeper = setTimeout(() => {}, 1000);
  try {
    const result = await inspectGuardianExtras({ baseUrl, publicBaseUrl: 'https://relay.example',
      localReady: true, includeVoice: false, timeoutMs: 15,
      fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
        calls++; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }), probeVoice: () => { throw new Error('must not start voice'); } });
    assert.ok(performance.now() - start < 1000);
    assert.equal(calls, 1);
    assert.equal(result.checks.find(check => check.id === 'public').state, 'error');
    assert.deepEqual(result.faults, [{ id: 'public', kind: 'transport', repairable: true, component: 'public' }]);
  } finally { clearTimeout(keeper); }
});

test('Windows memory probe is hidden, bounded and requests only numeric memory counters', async () => {
  const snapshot = healthyResources(); let launches = 0;
  const actual = await readSystemResources({ platform: 'win32', execFileImpl: (file, args, options, callback) => {
    launches++;
    assert.equal(file, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout <= 3000);
    assert.ok(options.maxBuffer <= 4096);
    assert.match(args.at(-1), /Win32_PerfFormattedData_PerfOS_Memory/);
    assert.doesNotMatch(args.at(-1), /Get-Process|Stop-Process|Win32_Process/);
    callback(null, JSON.stringify(snapshot));
  } });
  assert.deepEqual(actual, snapshot); assert.equal(launches, 1);
  const otherPlatform = await readSystemResources({ platform: 'linux', freeMemory: () => 4 * GiB,
    execFileImpl: () => { throw new Error('must not launch'); } });
  assert.deepEqual(otherPlatform, { availablePhysicalBytes: 4 * GiB });
  assert.equal((await inspectResources({ resourceProvider: () => otherPlatform })).state, 'unknown');
});
