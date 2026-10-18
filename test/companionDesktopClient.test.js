import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionDesktopClient, historyEntries } from '../src/companionDesktopClient.js';

async function runCompanionInvokeBody(expression, { api, AbortSignal }) {
  const paramsMarker = 'const params=';
  const paramsStart = expression.indexOf(paramsMarker) + paramsMarker.length;
  const paramsEnd = expression.indexOf(';\n', paramsStart);
  const catchStart = expression.lastIndexOf('}catch(error){');
  assert.ok(paramsStart >= paramsMarker.length && paramsEnd > paramsStart && catchStart > paramsEnd,
    'expected the standard Companion invoke wrapper');
  const params = JSON.parse(expression.slice(paramsStart, paramsEnd));
  const body = expression.slice(paramsEnd + 2, catchStart);
  try {
    return await new Function('params', 'api', 'AbortSignal', `return (async()=>{${body}})()`)(params, api, AbortSignal);
  } catch (error) {
    return { __companionError: true, status: Number(error?.status) || 0, name: String(error?.name || 'Error') };
  }
}

test('older messages follow prev_cursor and keep the verified room identity', async () => {
  const expressions=[];
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    return {items:[{id:'m',role:'user',account_user_id:'u',content:{text:'hello'}}],prev_cursor:'older',next_cursor:'newer'};
  },close(){}});
  c.profile={id:'a',roomId:'room-a'};
  c.roomMetadata={authors:[{accountUserId:'u',role:'user'}]};
  const page=await c.messages({before:'cursor-1'});
  assert.equal(page.nextCursor,'older');
  assert.equal(page.entries[0].text,'hello');
  assert.match(expressions[0],/room-a/);
  assert.match(expressions[0],/cursor-1/);
  assert.match(expressions[0],/limit:32/);
  await assert.rejects(c.messages({before:{unexpected:true}}),/Invalid/);
});

test('avatar comes only from the unique Companion member of the discovered room', async () => {
  const expressions=[];
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    return expressions.length===1 ? {id:'p',name:'Bear',roomId:'r'} : {avatarUrl:'https://example.com/real-avatar.png',authors:[{accountUserId:'bot',role:'assistant'}]};
  },close(){}});
  const profile=await c.profileDetails();
  assert.equal(profile.avatarUrl,'https://example.com/real-avatar.png');
  assert.match(expressions[1],/member.aeon_id === room.aeon_id/);
  assert.match(expressions[1],/members.length !== 1/);
  assert.match(expressions[1],/"roomId":"r"/);
});

test('room membership separates Bear from self even when the API labels both roles user', () => {
  const entries=historyEntries([
    {id:'1',role:'user',account_user_id:'self',content:{text:'question'}},
    {id:'2',role:'user',account_user_id:'bear',content:{text:'answer'}},
    {id:'3',role:'user',account_user_id:'unknown',content:{text:'do not misattribute'}}
  ],[{accountUserId:'self',role:'user'},{accountUserId:'bear',role:'assistant'}]);
  assert.deepEqual(entries.map(entry=>entry.role),['user','assistant']);
  assert.equal(entries[1].text,'answer');
});

test('null cursors on a full page fall back to the oldest raw message id, including call-only messages', async () => {
  const items=Array.from({length:32},(_,i)=>({id:`m-${i}`,created_at:String(1000+i),role:'user',account_user_id:'u',content:{text:i===0?null:`message ${i}`}}));
  const c=new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async()=>({items:items.reverse(),prev_cursor:null,next_cursor:null}),close(){}});
  c.profile={id:'p',roomId:'r'};
  c.roomMetadata={authors:[{accountUserId:'u',role:'user'}]};
  const page=await c.messages();
  assert.equal(page.nextCursor,'m-0');
  assert.equal(page.entries.length,31);
});

test('room history preserves full text, orders messages, and excludes deleted and call-only entries', () => {
  assert.deepEqual(historyEntries([
    {id:'b',role:'assistant',created_at:'2026-10-04T01:00:02Z',content:{text:'second'}},
    {id:'removed',deleted_at:'now',content:{text:'private deleted'}},
    {id:'call',content:{text:null,attachments:[{type:'call'}]}},
    {id:'a',role:'user',created_at:'2026-10-04T01:00:01Z',content:{text:'first\nline'}}
  ]), [
    {itemId:'room:a',role:'user',text:'first\nline',final:true},
    {itemId:'room:b',role:'assistant',text:'second',final:true}
  ]);
});

test('a desktop account or selected assistant change cannot silently retarget a call', async () => {
  let profile = {id:'a',name:'assistant',roomId:'r1'};
  const c = new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async()=>profile,close(){}});
  await c.discover();
  profile = {id:'b',name:'different',roomId:'r2'};
  await assert.rejects(c.start({sdp:'v=0\r\n'}), /selection changed/);
  assert.equal(c.profile.id,'a');
  assert.equal(c.callId,null);
});

test('message and member reads overlap, but entries wait for verified authors', async () => {
  const metadata = Promise.withResolvers();
  let messagesRead = false;
  let returned = false;
  const c = new CompanionDesktopClient({ ensureConnected: async () => {}, evaluate: async expression => {
    if (expression.includes('const room = await api.safeGet')) return metadata.promise;
    messagesRead = true;
    return { items: [
      { id: 'self-message', account_user_id: 'self', content: { text: 'question' } },
      { id: 'bot-message', role: 'user', account_user_id: 'bot', content: { text: 'reply' } }
    ] };
  }, close() {} });
  c.profile = { id: 'assistant', roomId: 'room' };
  const pending = c.messages().then(page => { returned = true; return page; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messagesRead, true, 'history read should start before member read finishes');
    assert.equal(returned, false, 'unverified authors must not be shown');
  } finally {
    metadata.resolve({ authors: [
      { accountUserId: 'self', role: 'user' }, { accountUserId: 'bot', role: 'assistant' }
    ] });
    await pending;
  }
  assert.deepEqual((await pending).entries.map(e => e.role), ['user', 'assistant']);
});

test('a failed member read prevents returning concurrently fetched messages', async () => {
  const metadata = Promise.withResolvers();
  let messagesRead = false;
  const c = new CompanionDesktopClient({ ensureConnected: async () => {}, evaluate: async expression => {
    if (expression.includes('const room = await api.safeGet')) return metadata.promise;
    messagesRead = true;
    return { items: [{ id: 'message', account_user_id: 'unknown', content: { text: 'unverified' } }] };
  }, close() {} });
  c.profile = { id: 'assistant', roomId: 'room' };
  const pending = c.messages();
  const rejected = assert.rejects(pending, /member read failed/);
  await new Promise(resolve => setImmediate(resolve));
  metadata.reject(new Error('member read failed'));
  await rejected;
  assert.equal(messagesRead, true);
  assert.equal(c.roomMetadata, null);
});

test('attach and stop require an owned call, and creation is not silently retried', async () => {
  const expressions=[];
  const c = new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async expression=>{
    expressions.push(expression);
    if(expression.includes('const result = await api.safeGet')) return {id:'a',name:'assistant',roomId:'r'};
    if(expression.includes('const response = await api.postResponse')) return {callId:'rtc_test',sdp:'v=0\r\n'};
    return {ok:true};
  },close(){}});
  await assert.rejects(c.attach(),/No owned/);
  assert.deepEqual(await c.stop(),{ok:true});
  assert.equal(expressions.length,0);
  await c.start({sdp:'v=0\r\n'});
  await assert.rejects(c.start({sdp:'v=0\r\n'}),/already allocated/);
  await c.attach();
  await c.stop();
  assert.equal(c.callId,null);
  assert.equal(expressions.filter(e=>e.includes('const response = await api.postResponse')).length,1);
  assert.ok(expressions.at(-1).includes('rtc_test'));
});

test('Companion API failures keep only safe HTTP status, error code, and stage', async () => {
  const c = new CompanionDesktopClient({ ensureConnected: async () => {}, evaluate: async () => ({
    __companionError: true,
    status: 502,
    name: 'FetchError',
    message: 'private response body and bearer token'
  }), close() {} });
  await assert.rejects(c.invoke('return null;', {}, 30000, 'create'), error => {
    assert.equal(error.message, 'Companion HTTP 502');
    assert.equal(error.status, 502);
    assert.equal(error.errorCode, 'http_error');
    assert.equal(error.stage, 'create');
    assert.doesNotMatch(JSON.stringify(error), /private response|bearer token/);
    return true;
  });
});

test('CDP timeout and connection failures are distinguished without preserving their raw messages', async () => {
  const timeout = new CompanionDesktopClient({ ensureConnected: async () => {}, evaluate: async () => {
    throw new Error('Codex 桌面 CDP 请求超时：Runtime.evaluate includes no private data');
  }, close() {} });
  await assert.rejects(timeout.invoke('return null;', {}, 30000, 'discover'), error => {
    assert.equal(error.errorCode, 'timeout');
    assert.equal(error.stage, 'discover');
    assert.doesNotMatch(JSON.stringify(error), /Runtime\.evaluate/);
    return true;
  });

  const disconnected = new CompanionDesktopClient({ ensureConnected: async () => {
    throw new Error('Codex 桌面 CDP 连接已关闭: secret=hidden');
  }, evaluate: async () => null, close() {} });
  await assert.rejects(disconnected.invoke('return null;', {}, 30000, 'attach'), error => {
    assert.equal(error.errorCode, 'cdp_connection');
    assert.equal(error.stage, 'attach');
    assert.doesNotMatch(JSON.stringify(error), /secret=hidden/);
    return true;
  });
});

test('voice call creation uses a cancellable 40s API signal and a 45s CDP wait, preserving HTTP 503', async () => {
  const controller = new AbortController();
  const timeoutCalls = [];
  const evaluateTimeouts = [];
  let requestSignal = null;
  let observedAbort = false;
  const api = {
    async postResponse(_path, request) {
      requestSignal = request.signal;
      request.signal.addEventListener('abort', () => { observedAbort = true; });
      throw Object.assign(new Error('private HTTP 503 response body'), { status: 503 });
    }
  };
  const AbortSignalShim = {
    timeout(ms) { timeoutCalls.push(ms); return controller.signal; }
  };
  const c = new CompanionDesktopClient({ ensureConnected: async () => {}, evaluate: async (expression, timeoutMs) => {
    evaluateTimeouts.push(timeoutMs);
    if (expression.includes("const result = await api.safeGet('/tbo/primary'")) {
      return { id: 'assistant', name: 'Bear', roomId: 'room' };
    }
    assert.ok(expression.includes("const response = await api.postResponse('/tbo/{tbo_id}/voice/calls'"));
    return runCompanionInvokeBody(expression, { api, AbortSignal: AbortSignalShim });
  }, close() {} });

  await assert.rejects(c.start({ sdp: 'v=0\r\n' }), error => {
    assert.equal(error.message, 'Companion HTTP 503');
    assert.equal(error.status, 503);
    assert.equal(error.errorCode, 'http_error');
    assert.equal(error.stage, 'create');
    return true;
  });

  assert.deepEqual(timeoutCalls, [40000]);
  assert.deepEqual(evaluateTimeouts, [30000, 45000], 'profile discovery stays at 30s and create gets 45s');
  assert.strictEqual(requestSignal, controller.signal);
  assert.ok(requestSignal instanceof AbortSignal, 'the request receives a real cancellable AbortSignal');
  controller.abort();
  assert.equal(observedAbort, true, 'the API request is wired to cancellation');
  assert.equal(c.callId, null);
});
