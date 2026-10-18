import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMobileLink, inspectGuardianExtras } from '../tools/windows/mobile-link-diagnostics.mjs';
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
    assert.deepEqual(result.guardianSignals.faults,[{id:'companion',kind:failureClass,repairable:false,component:'companion'}]);
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
  assert.equal(probes,0);assert.equal(result.checks[0].state,'unverified');assert.deepEqual(result.faults,[]);
});

test('voice transport probe is explicitly distinct from an actual call',async()=>{
  const result=await inspectGuardianExtras({baseUrl,localReady:true,
    fetchImpl:mockFetch({'/voice/status':{voice:{enabled:true,pid:null}}}),
    probeVoice:async()=>({ok:true,status:101})});
  assert.equal(result.checks[0].state,'ready');assert.match(result.checks[0].message,/未发起通话/);
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
