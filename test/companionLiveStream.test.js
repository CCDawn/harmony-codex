import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { attachCompanionMessageTopic, CompanionDesktopClient } from '../src/companionDesktopClient.js';
import { CompanionConversationService, handleCompanionRoute } from '../src/companionConversationService.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTopic({ subscribed = false } = {}) {
  const listeners = new Map();
  let owners = 1; // The real desktop already owns this topic.
  const topic = { released:0, subscribeCalls:0,
    retainSubscription() { owners++; return () => { owners--; topic.released++; }; },
    unsubscribe() { throw Error('must never unsubscribe the desktop owner'); },
    emit(name, value) { for (const listener of [...listeners.get(name) ?? []]) listener(value); },
    get owners() { return owners; },
    get listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); }
  };
  for (const name of ['Message','Disconnect','Subscribed','PotentialMissedMessages']) {
    listeners.set(name, new Set());
    topic[`on${name}`] = callback => {
      listeners.get(name).add(callback);
      if (name === 'Subscribed' && subscribed) callback();
      return () => listeners.get(name).delete(callback);
    };
  }
  return topic;
}

test('real topic notifications coalesce, filter the room, and release only their own ownership', async () => {
  const topic = fakeTopic();
  const events = [];
  const stop = attachCompanionMessageTopic(topic, 'room', event => events.push(event), () => true);
  topic.emit('Subscribed');
  topic.emit('PotentialMissedMessages'); // Expected first subscribe with no offset.
  topic.emit('Message', {type:'calpico-message-update',payload:{room_id:'room',message_id:'m'}});
  topic.emit('Message', {type:'calpico-message-add',payload:{room_id:'room',message:{id:'n'}}});
  await settle();
  assert.deepEqual(events, [{kind:'update'}]);
  topic.emit('Message', {type:'calpico-message-update',payload:{room_id:'another-room',message_id:'m'}});
  topic.emit('Message', {type:'calpico-is-responding-heartbeat',payload:{room_id:'room'}});
  await settle();
  assert.equal(events.length, 1);
  assert.equal(topic.owners, 2);
  topic.emit('Disconnect');
  stop();
  assert.deepEqual(events.at(-1), {kind:'control',reason:'reconnect'});
  assert.equal(topic.owners, 1);
  assert.equal(topic.released, 1);
  assert.equal(topic.listenerCount, 0);
});

test('an established topic gap or changed logged-in identity terminates that watcher', async () => {
  for (const reason of ['gap','terminal']) {
    const topic = fakeTopic({subscribed:true});
    const events = [];
    let current = true;
    const stop = attachCompanionMessageTopic(topic, 'room', event => events.push(event), () => current);
    await settle();
    if (reason === 'gap') topic.emit('PotentialMissedMessages');
    else {
      current = false;
      topic.emit('Message', {type:'calpico-message-update',payload:{room_id:'room'}});
    }
    assert.deepEqual(events.at(-1), {kind:'control',reason});
    assert.equal(topic.owners, 1);
    assert.equal(topic.listenerCount, 0);
    stop();
  }
});

function adapterFixture() {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  const calls = [];
  let binding;
  const transport = {socket,
    async ensureConnected() {},
    async call(method, input) { calls.push({method,input}); if (method === 'Runtime.addBinding') binding = input.name; return {}; },
    async evaluate(expression) { calls.push({expression}); return {subscribed:true}; },
    close() { calls.push({closed:true}); }
  };
  const client = new CompanionDesktopClient(transport);
  client.discover = async () => ({id:'profile',roomId:'room'});
  client.getRoomMetadata = async () => ({authors:[{accountUserId:'assistant',role:'assistant'}]});
  const emit = event => socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({
    method:'Runtime.bindingCalled',params:{name:binding,payload:JSON.stringify(event)}
  })}));
  return {client,transport,socket,calls,emit};
}

test('adapter reads only on upstream events, deduplicates identities, coalesces in-flight notifications and cancels', async () => {
  const {client,calls,emit} = adapterFixture();
  const abort = new AbortController();
  const entries = [], controls = [];
  let reads = 0, text = 'first';
  let wait;
  client.messages = async () => {
    reads++;
    if (wait) await wait.promise;
    return {entries:[{itemId:'room:m',role:'assistant',text,final:true}]};
  };
  const stop = await client.subscribeMessages({profileId:'profile',roomId:'room',signal:abort.signal,
    onEntry:entry => entries.push(entry),onControl:event => controls.push(event)});
  await settle();
  assert.equal(reads, 0, 'no message polling timer');
  emit({kind:'update'});
  await settle();
  emit({kind:'update'});
  await settle();
  assert.equal(entries.length, 1, 'identical server item is not appended twice');
  wait = Promise.withResolvers();
  text = 'first, second segment';
  emit({kind:'update'});
  await settle();
  for (let i=0;i<500;i++) emit({kind:'update'});
  assert.equal(reads, 3, 'bounded in-flight read');
  wait.resolve();
  wait = null;
  await settle();
  assert.equal(reads, 4, 'one further read covers the burst');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].itemId, entries[0].itemId);
  assert.equal(entries[1].text, 'first, second segment');
  abort.abort();
  await stop();
  emit({kind:'update'});
  await settle();
  assert.equal(reads, 4);
  assert.equal(controls.length, 0);
  assert.equal(calls.filter(call => call.method === 'Runtime.removeBinding').length, 1);
  assert.ok(calls.some(call => call.expression?.includes("'_stop')") || call.expression?.includes('_stop\"]?.()')));
  const install = calls.find(call => call.expression?.includes('const topicFactory =')).expression;
  assert.doesNotThrow(() => new Function(`return ${install}`), 'generated renderer script must compile with the existing API loader');
  assert.ok(install.includes('retainSubscription'));
  assert.ok(!install.includes('/live'));
  assert.ok(!install.includes('safePost('));
});

test('abort while renderer installation is pending waits to release the newly installed watcher', async () => {
  const {client,transport,calls} = adapterFixture();
  const installation = Promise.withResolvers();
  transport.evaluate = async expression => {
    calls.push({expression});
    if (expression.includes('const topicFactory =')) await installation.promise;
    return {subscribed:true};
  };
  const abort = new AbortController();
  const pending = client.subscribeMessages({profileId:'profile',roomId:'room',signal:abort.signal});
  await settle();
  abort.abort();
  installation.resolve();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls.filter(call => call.method === 'Runtime.removeBinding').length, 1);
});

test('generated loader discovers the running exports and reuses the logged-in topic without a write', async () => {
  const {client,transport,calls,socket} = adapterFixture();
  const topic = fakeTopic({subscribed:true});
  const id = Symbol('AppScope');
  const scope = {id};
  const account = {scope,resolve() { return 'account'; }};
  const user = {scope,resolve() { return 'user'; }};
  const node = {store:{get:value => value},token:scope};
  const chain = new Map([[id,node]]);
  const window = {__codexRoot:{_internalRoot:{current:{memoizedProps:{value:chain}}}}};
  const reads = [];
  const api = {
    async safeGet(path) {
      reads.push(path);
      assert.equal(path, '/tbo/primary', 'the existing topic must not fetch a fresh websocket URL');
      return {profile:{id:'profile',messaging_room_id:'room',aeon_kind:'orbit',status:'active'}};
    },
    postResponse() { throw Error('unexpected write'); }
  };
  const module = {apiX:api,accountX:account,userX:user,factoryX:(name,getUrl,key) => {
    assert.equal(name, 'calpico-chatgpt-messaging');
    assert.equal(key, JSON.stringify(['account','user']));
    return topic;
  }};
  const source = 'client.safeGet(\'/tbo/primary\');' +
    'factory(c??(s===`all`?`calpico-chatgpt-messaging-all`:`calpico-chatgpt-messaging`));' +
    'n.scope.get(accountAtom)!==n.access.accountId||n.scope.get(userAtom)!==n.access.userId;' +
    'export{client as apiX,factory as factoryX,accountAtom as accountX,userAtom as userX}';
  const document = {scripts:[{type:'module',src:'https://desktop.invalid/assets/index.js'}]};
  const fetch = async url => ({text:async () => String(url).endsWith('/index.js') ? 'import "./app-initial-abc123.js";' : source});
  const originalCall = transport.call;
  transport.call = async (method,input) => {
    await originalCall(method,input);
    if (method === 'Runtime.addBinding') window[input.name] = payload => socket.dispatchEvent(new MessageEvent('message', {
      data:JSON.stringify({method:'Runtime.bindingCalled',params:{name:input.name,payload}})
    }));
    return {};
  };
  transport.evaluate = async expression => {
    calls.push({expression});
    return new Function('document','window','fetch','importModule',
      `return ${expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)')}`)(document,window,fetch,async () => module);
  };
  client.messages = async () => ({entries:[]});
  const stop = await client.subscribeMessages({profileId:'profile',roomId:'room'});
  await settle();
  assert.equal(topic.owners, 2);
  await stop();
  assert.equal(topic.owners, 1);
  assert.equal(topic.listenerCount, 0);
  assert.deepEqual(reads, ['/tbo/primary']);
  assert.deepEqual(Object.keys(window), ['__codexRoot']);
});

test('service validates exact profile and room before subscribing and closes on mismatch', async () => {
  let closed = 0, subscriptions = 0;
  const service = new CompanionConversationService({clientFactory:() => ({
    discover:async () => ({id:'other-profile',roomId:'room'}),
    subscribeMessages:async () => { subscriptions++; }, close() { closed++; }
  })});
  await assert.rejects(service.subscribeMessages({profileId:'profile',roomId:'room'}), error => error.statusCode === 409);
  assert.equal(subscriptions, 0);
  assert.equal(closed, 1);
});

test('subscription compatibility failures remain deterministic and close their desktop client', async () => {
  let closed = 0;
  const service = new CompanionConversationService({clientFactory:() => ({
    discover:async () => ({id:'profile',roomId:'room'}),
    subscribeMessages:async () => { throw Object.assign(Error('private export mismatch'), {failureClass:'api_compatibility'}); },
    close() { closed++; }
  })});
  const response = streamResponse();
  await handleCompanionRoute({request:Object.assign(new EventEmitter(),{method:'GET'}),response,service,
    url:'/companion/events?profileId=profile&roomId=room'});
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.chunks.join('')).failureClass, 'api_compatibility');
  assert.doesNotMatch(response.chunks.join(''), /private export/);
  assert.equal(closed, 1);
});

function streamResponse({backpressure = false} = {}) {
  const response = new EventEmitter();
  response.chunks = [];
  response.writableLength = 0;
  response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; response.headersSent = true; };
  response.write = chunk => { response.chunks.push(chunk); return !backpressure; };
  response.end = chunk => { if (chunk) response.chunks.push(chunk); response.writableEnded = true; response.emit('close'); };
  return response;
}

test('SSE endpoint emits same-item snapshots without replay IDs and reconnect closes/releases it', async () => {
  const request = Object.assign(new EventEmitter(), {method:'GET'});
  const response = streamResponse();
  let input, released = 0;
  const service = {async subscribeMessages(value) {
    input = value;
    // Updates can arrive before HTTP subscription setup has returned.
    value.onEntry({itemId:'room:m',role:'assistant',text:'one',final:true});
    value.onEntry({itemId:'room:m',role:'assistant',text:'one two',final:true});
    return async () => { released++; };
  }};
  assert.equal(await handleCompanionRoute({request,response,service,url:'/companion/events?profileId=profile&roomId=room'}), true);
  assert.equal(response.statusCode, 200);
  const frames = response.chunks.join('');
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.match(frames, /event: companion.message\ndata: /);
  assert.match(frames, /one two/);
  assert.doesNotMatch(frames, /^id:/m);
  assert.equal(response.chunks.filter(chunk => chunk.includes('companion.message')).length, 1);
  input.onControl({type:'stream.control',reason:'reconnect'});
  await settle();
  assert.match(response.chunks.at(-1), /event: stream.control/);
  assert.match(response.chunks.at(-1), /"reason":"reconnect"/);
  assert.equal(input.signal.aborted, true);
  assert.equal(released, 1);
});

test('slow SSE consumers get a gap and close; invalid targets fail before subscription', async () => {
  const request = Object.assign(new EventEmitter(), {method:'GET'});
  const response = streamResponse({backpressure:true});
  let released = 0, subscribed = 0;
  const service = {async subscribeMessages() { subscribed++; return async () => { released++; }; }};
  await handleCompanionRoute({request,response,service,url:'/companion/events?profileId=profile&roomId=room'});
  await settle();
  assert.match(response.chunks.at(-1), /"reason":"gap"/);
  assert.equal(response.writableEnded, true);
  assert.equal(released, 1);
  for (const query of ['?profileId=profile','?profileId=a&profileId=b&roomId=room']) {
    const invalid = streamResponse();
    await handleCompanionRoute({request:Object.assign(new EventEmitter(),{method:'GET'}),response:invalid,service,url:'/companion/events'+query});
    assert.equal(invalid.statusCode, 400);
  }
  assert.equal(subscribed, 1);
});
