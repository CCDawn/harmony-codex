import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { openSessionEventStream } from '../src/sessionEventStream.js';

const THREAD = 'official-thread';
const STARTED = 1_792_612_800;
const item = (text, id = 'official-item') => ({ id, type: 'agentMessage', text });
const snapshot = (text = '当前前缀', status = 'inProgress', extra = {}) => ({ thread: {
  id: THREAD,
  turns: [
    { id: 'old-turn', status: 'completed', items: [item('PRIVATE_OLD_HISTORY', 'old-item')] },
    { id: 'official-turn', status, startedAt: STARTED, items: [
      { id: 'tool', type: 'commandExecution', aggregatedOutput: 'PRIVATE_TOOL_BODY' },
      { id: 'user', type: 'userMessage', content: [{ text: 'PRIVATE_USER_BODY' }] }, item(text)
    ], ...extra }
  ]
} });
const delta = (threadId = THREAD) => ({
  method: 'item/agentMessage/delta',
  params: { threadId, turnId: 'official-turn', itemId: 'official-item', delta: 'DO_NOT_APPEND_DELTA' }
});
const boundary = (method, params = {}) => ({ method, params: { threadId: THREAD, ...params } });
const settle = () => new Promise(resolve => setImmediate(resolve));

async function until(predicate, message = 'condition', timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${message}`);
    await delay(2);
  }
}

function adapterFixture() {
  let stopped = 0;
  let drains = 0;
  const queue = [];
  const arrays = [];
  const client = {
    async drainNotifications() { drains++; return queue.splice(0); },
    async request() { assert.fail('The stream must use its readThread callback only'); }
  };
  const adapter = new CodexDesktopCdpAdapter({ client, notificationPollIntervalMs: 3 });
  const subscribe = adapter.startNotificationPolling.bind(adapter);
  adapter.startNotificationPolling = (...args) => {
    arrays.push(args[1]);
    const subscription = subscribe(...args);
    return { stop() { stopped++; subscription.stop(); } };
  };
  return {
    adapter, queue, arrays,
    notify(...messages) { adapter.dispatchDesktopNotifications(messages); },
    get stopped() { return stopped; },
    get drains() { return drains; }
  };
}

async function httpFixture(t, read, options = {}) {
  const source = adapterFixture();
  let reads = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  let cancel;
  const controller = new AbortController();
  const server = createServer((request, response) => {
    void openSessionEventStream({ request, response, threadId: THREAD, adapter: source.adapter,
      readThread: async () => {
        assert.equal(source.adapter.notificationSubscriptions.size > 0, true, 'subscribe before read');
        reads++;
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try { return await read(reads); } finally { activeReads--; }
      }, ...options
    }).then(value => { cancel = value; });
  });
  t.after(async () => {
    controller.abort();
    cancel?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    source.adapter.stopSharedNotificationPolling();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/events`, { signal: controller.signal });
  let raw = '';
  let done = false;
  const reader = response.body.getReader();
  const consume = (async () => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { done = true; }
  })();
  // Keep the consumer's promise observed during test teardown as well.
  t.after(() => consume.catch(() => {}));
  return {
    source, response, controller, consume,
    get raw() { return raw; }, get done() { return done; },
    get reads() { return reads; }, get maxActiveReads() { return maxActiveReads; },
    events(type) {
      return raw.split('\n\n').filter(frame => frame.startsWith(`event: ${type}\n`))
        .map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
    },
    messages() { return this.events('session.message').map(event => event.entry); }
  };
}

test('HTTP observer immediately sends current partial with official identity and no historical/tool bodies', { timeout: 4000 }, async t => {
  const stream = await httpFixture(t, () => snapshot('完整前缀🙂'));
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);
  await until(() => stream.messages().length === 1);
  assert.deepEqual(stream.messages()[0], {
    threadId: THREAD, turnId: 'official-turn', itemId: 'official-item',
    role: 'assistant', type: 'agentMessage', liveKind: 'streaming',
    timestamp: new Date(STARTED * 1000).toISOString(), text: '完整前缀🙂'
  });
  assert.doesNotMatch(stream.raw, /PRIVATE_|^id:/m);
  await delay(35);
  assert.equal(stream.reads, 1, 'heartbeat/shared drain do not poll thread/read');
});

test('real deltas render before completion even when official snapshots contain no partial item', { timeout: 4000 }, async t => {
  let text = '';
  let status = 'inProgress';
  const stream = await httpFixture(t, () => snapshot(text, status), { readDebounceMs: 5 });
  await until(() => stream.reads === 1);await settle();
  const identified = (id, message) => ({ ...message, notificationId: `renderer:0.5:${id}` });
  stream.source.queue.push(identified(1,boundary('item/started',{turnId:'official-turn',item:item('')})),
    identified(2,{...delta(),params:{...delta().params,delta:'前缀'}}));
  await until(() => stream.messages().length === 1);
  assert.equal(stream.messages()[0].text,'前缀');
  const growth=identified(3,{...delta(),params:{...delta().params,delta:'，正在逐步增长'}});
  stream.source.notify(growth);
  await until(() => stream.messages().length === 2);
  assert.equal(stream.messages()[1].text,'前缀，正在逐步增长');
  assert.equal(stream.messages()[1].liveKind,'streaming');
  stream.source.notify(growth,growth);await delay(20);
  assert.equal(stream.messages().length,2);assert.equal(stream.reads,1,'deltas never poll snapshots');
  text='前缀，正在逐步增长';status='completed';
  stream.source.notify(identified(4,boundary('item/completed',{turnId:'official-turn',item:item(text)})),
    identified(5,boundary('turn/completed',{turn:{id:'official-turn',status}})));
  await until(() => stream.messages().length === 3 && stream.reads === 2);
  assert.equal(stream.messages()[2].text,text);assert.equal(stream.messages()[2].liveKind,'completed');
  assert.equal(stream.maxActiveReads,1);assert.equal(stream.source.arrays[0].length,0);
});

test('retained replay and events arriving during the initial read reconstruct one prefix without duplication', { timeout: 4000 }, async t => {
  const initial=Promise.withResolvers();
  const identified=(id,message)=>({...message,notificationId:`renderer:0.5:${id}`});
  const started=identified(1,boundary('item/started',{turnId:'official-turn',item:item('')}));
  const first=identified(2,{...delta(),params:{...delta().params,delta:'前缀'}});
  const growth=identified(3,{...delta(),params:{...delta().params,delta:'增长'}});
  const stream=await httpFixture(t,()=>initial.promise,{readRetainedNotifications:async()=>[started,first]});
  stream.source.notify(first,growth);initial.resolve(snapshot(''));
  await until(()=>stream.messages().length===1);
  assert.equal(stream.messages()[0].text,'前缀增长');assert.equal(stream.reads,1);
  stream.source.notify(first,growth);await delay(20);assert.equal(stream.messages().length,1);
});

test('assistant boundaries switch turns without whole-history reads and completion overwrites the same item', { timeout: 4000 }, async t => {
  let value = snapshot('之前已完成', 'completed');
  const stream = await httpFixture(t, () => value.thread, { readDebounceMs: 2 });
  await until(() => stream.messages().length === 1);
  assert.equal(stream.messages()[0].liveKind, 'completed');
  value = snapshot('之前已完成', 'completed');
  value.thread.turns.push({ id: 'next-turn', status: 'inProgress', updatedAt: '2026-10-22T01:02:03Z', items: [] });
  stream.source.notify(boundary('turn/started', { turn: { id: 'next-turn' } }));
  assert.equal(stream.reads,1);
  stream.source.notify(boundary('item/started', { turnId: 'next-turn', item: item('', 'next-item') }));
  stream.source.notify({method:'item/agentMessage/delta',params:{threadId:THREAD,turnId:'next-turn',itemId:'next-item',delta:'新一轮正文'}});
  await until(() => stream.messages().length === 2);
  assert.equal(stream.messages()[1].turnId, 'next-turn');
  stream.source.notify(boundary('item/completed', { turnId: 'next-turn', item: item('新一轮正文，完整', 'next-item') }));
  await until(() => stream.messages().length === 3);
  assert.equal(stream.messages()[2].text, '新一轮正文，完整');
  assert.equal(stream.messages().filter(entry => entry.turnId === 'official-turn').length, 1);
  assert.equal(stream.reads,1);
});

test('missing retained prefix never masquerades as a complete answer and terminal item repairs it',async t=>{
 const stream=await httpFixture(t,()=>snapshot(''));
 await until(()=>stream.reads===1);await settle();
 stream.source.notify({...delta(),notificationId:'renderer:5',params:{...delta().params,delta:'尾段'}});
 await delay(10);assert.equal(stream.messages().length,0);
 stream.source.notify({...boundary('item/completed',{turnId:'official-turn',item:item('完整前缀和尾段')}),notificationId:'renderer:6'});
 await until(()=>stream.messages().length===1);assert.equal(stream.messages()[0].text,'完整前缀和尾段');
});

test('short retained replay cannot roll back a longer official snapshot, and a new renderer epoch can continue',async t=>{
 const start={...boundary('item/started',{turnId:'official-turn',item:item('')}),notificationId:'old:100'};
 const first={...delta(),notificationId:'old:101',params:{...delta().params,delta:'前'}};
 const stream=await httpFixture(t,()=>snapshot('前缀'),{readRetainedNotifications:async()=>[start,first]});
 await until(()=>stream.messages().length===1);assert.equal(stream.messages()[0].text,'前缀');
 const event={...delta(),notificationId:'new:1',params:{...delta().params,delta:'缀继续'}};
 stream.source.notify(event,event);
 await until(()=>stream.messages().length===2);assert.equal(stream.messages()[1].text,'前缀继续');
});

test('foreign thread notifications are isolated and metadata invalidations merge without per-output reads', { timeout: 4000 }, async t => {
  const stream = await httpFixture(t, () => snapshot(), { readDebounceMs: 2, invalidateMs: 15 });
  await until(() => stream.messages().length === 1);
  stream.source.notify(delta('other-thread'));
  for (let index = 0; index < 100; index++) {
    stream.source.notify(boundary('item/commandExecution/outputDelta', { delta: 'PRIVATE_OUTPUT' }));
  }
  await delay(30);
  assert.equal(stream.reads, 1);
  assert.equal(stream.events('session.invalidate').length, 0);
  for (let index = 0; index < 100; index++) {
    stream.source.notify(boundary('thread/settings/updated', { threadSettings: { secret: 'PRIVATE_SETTINGS' } }));
    stream.source.notify(boundary('item/commandExecution/requestApproval', { command: 'PRIVATE_COMMAND' }));
    stream.source.notify(boundary('item/completed', { item: { id: 'tool', type: 'commandExecution' } }));
  }
  await until(() => stream.events('session.invalidate').length === 1);
  assert.deepEqual(stream.events('session.invalidate'), [{ threadId: THREAD }]);
  assert.equal(stream.reads, 1);
  assert.equal(stream.source.arrays[0].length, 0);
  assert.doesNotMatch(stream.raw, /PRIVATE_/);
});

test('HTTP disconnect releases only its own shared subscription and ignores a late read', { timeout: 4000 }, async t => {
  const pending = Promise.withResolvers();
  const stream = await httpFixture(t, () => pending.promise, { readDebounceMs: 2 });
  const peerNotifications = [];
  const peer = stream.source.adapter.startNotificationPolling(THREAD, peerNotifications, () => {});
  assert.equal(stream.source.adapter.notificationSubscriptions.size, 2);
  stream.controller.abort();
  await until(() => stream.source.stopped === 1);
  assert.equal(stream.source.adapter.notificationSubscriptions.size, 1);
  assert.equal(stream.source.adapter.notificationPoller.stopped, false);
  pending.resolve(snapshot('LATE_PRIVATE_BODY'));
  await settle();
  stream.source.notify(delta());
  assert.equal(stream.reads, 1);
  assert.equal(stream.raw, '');
  assert.equal(peerNotifications.length, 1);
  peer.stop();
  assert.equal(stream.source.adapter.notificationPoller, null);
});

test('read failure returns reconnect without exception text and immediately releases subscription', { timeout: 4000 }, async t => {
  const stream = await httpFixture(t, async () => { throw new Error('PRIVATE_CONVERSATION_IN_ERROR'); });
  await stream.consume;
  assert.deepEqual(stream.events('stream.control'), [{ type: 'stream.control', reason: 'reconnect', detail: 'read_failed' }]);
  assert.equal(stream.source.stopped, 1);
  assert.equal(stream.source.adapter.notificationSubscriptions.size, 0);
  assert.equal(stream.source.adapter.notificationPoller, null);
  assert.doesNotMatch(stream.raw, /PRIVATE_/);
});

function responseFixture({ backpressure = false, stallEnd = false } = {}) {
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, writableEnded: false, destroyed: false, backpressure });
  response.writeHead = (statusCode, headers) => { response.statusCode = statusCode; response.headers = headers; };
  response.flushHeaders = () => {};
  response.write = frame => { response.frames.push(frame); return !response.backpressure; };
  response.end = frame => {
    if (frame) response.frames.push(frame);
    response.writableEnded = true;
    if (!stallEnd) response.emit('finish');
  };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  return response;
}

async function directFixture(t, options = {}) {
  const { readThread, response: configuredResponse, ...streamOptions } = options;
  const request = new EventEmitter();
  const response = configuredResponse ?? responseFixture();
  let stopped = 0;
  let reads = 0;
  let emit;
  let notifications;
  const cancel = await openSessionEventStream({ request, response, threadId: THREAD,
    adapter: { startNotificationPolling(id, buffer, callback) {
      assert.equal(id, THREAD);
      notifications = buffer;
      emit = callback;
      return { stop() { stopped++; } };
    } },
    readThread: () => { reads++; return readThread ? readThread() : snapshot(); }, ...streamOptions
  });
  t.after(cancel);
  await settle();
  return { request, response, cancel, get reads() { return reads; }, get stopped() { return stopped; },
    notify(message, type = 'codex.desktop_live.notification') { notifications.push(message); emit(type, message); },
    get queued() { return notifications.length; }
  };
}

const directMessages = stream => stream.response.frames.filter(frame => frame.startsWith('event: session.message'))
  .map(frame => JSON.parse(frame.split('\ndata: ')[1]).entry);

function largeCurrentTurn(status = 'inProgress') {
  return snapshot('', status, { items: [
    ...Array.from({ length: 64 }, (_, index) => ({ id: `large-tool-${index}`, type: 'commandExecution',
      status: 'completed', command: `Read fixture ${index}`, aggregatedOutput: 'tool output '.repeat(800) })),
    ...Array.from({ length: 76 }, (_, index) => item('完整正文🙂'.repeat(60), index === 75 ? 'official-item' : `large-text-${index}`))
  ] });
}

test('a realistic 140-item initial snapshot streams all bounded frames instead of reconnecting on aggregate retention', { timeout: 6000 }, async t => {
  const value = largeCurrentTurn();
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 600_000);
  const stream = await httpFixture(t, () => value);
  await until(() => stream.messages().length === 140 || stream.done, 'all large snapshot entries', 4000);
  assert.equal(stream.messages().length, 140);
  assert.equal(stream.source.stopped, 0);
  assert.equal(stream.reads, 1);
  assert.ok(Buffer.byteLength(stream.raw) > 256 * 1024);
  assert.ok(stream.raw.split('\n\n').every(frame => Buffer.byteLength(frame) < 256 * 1024));
  assert.doesNotMatch(stream.raw, /event: stream.control/);
});

test('over-retention current turn repairs history once, stays connected on deltas and resumes streaming at the next turn', async t => {
  let value = snapshot('too-large'.repeat(400));
  const stream = await directFixture(t, { readThread: () => value, maxRetainedBytes: 1200, invalidateMs: 2, readDebounceMs: 2 });
  await delay(10);
  assert.equal(stream.stopped, 0);
  assert.equal(directMessages(stream).length, 0, 'no truncated or partial snapshot is presented as complete');
  const invalidations = () => stream.response.frames.filter(frame => frame.startsWith('event: session.invalidate')).length;
  assert.equal(invalidations(), 1);
  for (let index = 0; index < 200; index++) stream.notify({ ...delta(), notificationId: `repair:${index}` });
  await delay(10);
  assert.equal(invalidations(), 1); assert.equal(stream.reads, 1);
  value = snapshot('too-large'.repeat(400), 'completed');
  stream.notify({ ...boundary('turn/completed', { turn: { id: 'official-turn', status: 'completed' } }), notificationId: 'repair:200' });
  await until(() => stream.reads === 2);
  await delay(10);
  assert.equal(stream.stopped, 0); assert.equal(directMessages(stream).length, 0);
  assert.equal(invalidations(), 2, 'the actual terminal boundary requests one more history repair');
  stream.notify({ ...boundary('turn/completed', { turn: { id: 'official-turn', status: 'completed' } }), notificationId: 'repair:200' });
  await delay(10);
  assert.equal(invalidations(), 2); assert.equal(stream.reads, 2, 'duplicate boundaries cannot make a history-read loop');
  stream.notify({ ...boundary('turn/started', { turn: { id: 'next-turn' } }), notificationId: 'repair:201' });
  stream.notify({ ...boundary('item/started', { turnId: 'next-turn', item: item('下一轮完整正文', 'next-item') }), notificationId: 'repair:202' });
  assert.deepEqual(directMessages(stream).map(entry => [entry.turnId, entry.text]), [['next-turn', '下一轮完整正文']]);
});

test('default 4MiB aggregate retention enters bounded repair even when every individual frame is small', async t => {
  const value = snapshot('', 'inProgress', { items: Array.from({ length: 600 }, (_, index) => item('body'.repeat(2000), `retained-${index}`)) });
  const stream = await directFixture(t, { readThread: () => value, invalidateMs: 2 });
  await delay(10);
  assert.equal(stream.stopped, 0); assert.equal(stream.reads, 1);
  assert.equal(directMessages(stream).length, 0);
  assert.equal(stream.response.frames.filter(frame => frame.startsWith('event: session.invalidate')).length, 1);
  assert.equal(stream.response.frames.some(frame => frame.startsWith('event: stream.control')), false);
});

test('terminal history refresh drains a large snapshot in batches and keeps complete tool/body identities', { timeout: 6000 }, async t => {
  let value = snapshot('', 'inProgress', { items: [] });
  const stream = await httpFixture(t, () => value, { readDebounceMs: 2 });
  await until(() => stream.reads === 1); await settle();
  value = largeCurrentTurn('completed');
  stream.source.notify(boundary('turn/completed', { turn: { id: 'official-turn', status: 'completed' } }));
  await until(() => stream.messages().length === 140 || stream.done, 'large terminal refresh', 4000);
  assert.equal(stream.messages().length, 140); assert.equal(stream.reads, 2);
  assert.ok(stream.messages().every(entry => entry.turnId === 'official-turn' && entry.liveKind === 'completed'));
  assert.equal(new Set(stream.messages().map(entry => entry.itemId)).size, 140);
  assert.equal(stream.source.stopped, 0); assert.doesNotMatch(stream.raw, /event: stream.control/);
});

test('large pending initialization uses retained capacity and overflow keeps turn/status boundaries without suffix bodies', async t => {
  const first = Promise.withResolvers();
  const stream = await directFixture(t, { readThread: () => first.promise });
  for (const tool of largeCurrentTurn().thread.turns.at(-1).items.slice(0, 64)) {
    stream.notify(boundary('item/started', { turnId: 'official-turn', item: tool }));
  }
  assert.equal(stream.stopped, 0);
  first.resolve(snapshot('', 'inProgress', { items: [] }));
  await until(() => directMessages(stream).length === 64);
  assert.ok(stream.response.frames.reduce((bytes, frame) => bytes + Buffer.byteLength(frame), 0) > 256 * 1024);
  assert.equal(stream.reads, 1); assert.equal(stream.stopped, 0);

  const pending = Promise.withResolvers();
  const latest = { thread: { id: THREAD, goal: null, status: { type: 'idle' },
    turns: [{ id: 'new-turn', status: 'interrupted', items: [] }] } };
  let calls = 0;
  const overflow = await directFixture(t, { maxRetainedBytes: 1200, invalidateMs: 2, readDebounceMs: 2,
    readThread: () => ++calls === 1 ? pending.promise : latest });
  overflow.notify({ ...boundary('turn/started', { turn: { id: 'new-turn' } }), notificationId: 'overflow:1' });
  overflow.notify({ ...boundary('item/started', { turnId: 'new-turn', item: item('must-not-publish'.repeat(300), 'huge') }), notificationId: 'overflow:2' });
  overflow.notify({ ...boundary('turn/completed', { turn: { id: 'new-turn', status: 'interrupted' } }), notificationId: 'overflow:3' });
  overflow.notify({ ...boundary('thread/status/changed', { status: { type: 'idle' } }), notificationId: 'overflow:4' });
  pending.resolve(latest);
  await until(() => overflow.reads === 2);
  await delay(10);
  assert.equal(overflow.stopped, 0); assert.equal(directMessages(overflow).length, 0);
  const statuses = overflow.response.frames.filter(frame => frame.startsWith('event: session.status'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.equal(statuses.at(-1).turnId, 'new-turn'); assert.equal(statuses.at(-1).state, 'interrupted');
  const reads = overflow.reads;
  for (let index = 0; index < 100; index++) overflow.notify({ ...delta(), params: { ...delta().params, turnId: 'new-turn' }, notificationId: `overflow:${index + 5}` });
  await delay(10); assert.equal(overflow.reads, reads);
});

test('snapshot drain waits release on abort/close/finish and timeout without publishing a late batch', async t => {
  for (const event of ['aborted', 'close', 'finish']) {
    const stream = await directFixture(t, { response: responseFixture({ backpressure: true }), readThread: () => largeCurrentTurn() });
    assert.equal(directMessages(stream).length, 1, 'only the accepted first frame may precede drain');
    const count = stream.response.frames.length;
    (event === 'aborted' ? stream.request : stream.response).emit(event);
    await settle();
    stream.response.backpressure = false; stream.response.emit('drain'); await settle();
    assert.equal(stream.response.frames.length, count, event);
    assert.equal(stream.stopped, 1); assert.equal(stream.response.listenerCount('drain'), 0);
  }
  const timeout = await directFixture(t, { response: responseFixture({ backpressure: true }),
    readThread: () => largeCurrentTurn(), backpressureTimeoutMs: 10 });
  await until(() => timeout.stopped === 1);
  const count = timeout.response.frames.length;
  timeout.response.backpressure = false; timeout.response.emit('drain'); await settle();
  assert.equal(timeout.response.frames.length, count); assert.equal(timeout.response.listenerCount('drain'), 0);
  assert.match(timeout.response.frames.at(-1), /backpressure_timeout/);
});

test('live completion and turn switches during a snapshot drain cannot revive an older snapshot batch', async t => {
  const stream = await directFixture(t, { response: responseFixture({ backpressure: true }), readThread: () => largeCurrentTurn() });
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('live authoritative final', 'official-item') }));
  stream.response.backpressure = false; stream.response.emit('drain');
  await until(() => directMessages(stream).length === 140);
  assert.deepEqual(directMessages(stream).filter(entry => entry.itemId === 'official-item').map(entry => entry.text), ['live authoritative final']);

  const switched = await directFixture(t, { response: responseFixture({ backpressure: true }), readThread: () => largeCurrentTurn() });
  switched.notify(boundary('turn/started', { turn: { id: 'next-turn' } }));
  switched.notify(boundary('item/started', { turnId: 'next-turn', item: item('new turn owns output', 'next-item') }));
  switched.response.backpressure = false; switched.response.emit('drain'); await settle();
  assert.equal(switched.stopped, 0);
  assert.equal(directMessages(switched).at(-1).turnId, 'next-turn');
  assert.equal(directMessages(switched).at(-1).text, 'new turn owns output');
  assert.equal(directMessages(switched).some(entry => entry.itemId.startsWith('large-tool-')), false);
  assert.equal(switched.response.listenerCount('drain'), 0);
});

test('official command boundaries stream immediately, deduplicate replay and never regress a terminal item', async t => {
  const command = { id: 'exec-1', type: 'commandExecution', command: 'Start-Sleep -Seconds 50',
    commandActions: [{ type: 'unknown', command: 'Start-Sleep -Seconds 50' }], status: 'inProgress' };
  const start = { ...boundary('item/started', { turnId: 'official-turn', item: command }), notificationId: 'epoch:1' };
  const complete = { ...boundary('item/completed', { turnId: 'official-turn',
    item: { ...command, status: 'completed', aggregatedOutput: 'done' } }), notificationId: 'epoch:2' };
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', { items: [] }),
    readRetainedNotifications: async () => [start, start] });
  let messages = directMessages(stream);
  assert.equal(messages.length, 1);
  assert.deepEqual([messages[0].threadId, messages[0].turnId, messages[0].itemId, messages[0].role,
    messages[0].type, messages[0].toolItems[0].status, messages[0].text],
  [THREAD, 'official-turn', 'exec-1', 'tool', 'tool_call', 'running', 'Start-Sleep -Seconds 50']);
  assert.equal(messages[0].timestamp, new Date(STARTED * 1000).toISOString());
  assert.equal(messages[0].liveKind, 'streaming');
  stream.notify(start);
  stream.notify(complete);
  stream.notify({ ...start, notificationId: 'epoch:3' });
  messages = directMessages(stream);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].toolItems[0].status, 'completed');
  assert.equal(messages[1].liveKind, 'completed');
  assert.equal(messages[1].toolItems[0].detail, 'done');
  assert.equal(stream.reads, 1);
});

test('snapshot terminal tool wins stale replay; incomplete tool starts do not invent titles', async t => {
  const completed = { id: 'exec-1', type: 'commandExecution', command: 'echo done', status: 'completed' };
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', { items: [completed] }),
    readRetainedNotifications: async () => [boundary('item/started', { turnId: 'official-turn',
      item: { ...completed, status: 'inProgress' } })] });
  assert.deepEqual(directMessages(stream).map(e => [e.itemId, e.toolItems[0].status]), [['exec-1', 'completed']]);
  assert.equal(directMessages(stream)[0].liveKind, 'completed');
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: { id: 'incomplete', type: 'commandExecution', status: 'inProgress' } }));
  assert.equal(directMessages(stream).length, 1);
});

test('partial completion keeps official title but does not invent a status; terminal snapshot can enrich it', async t => {
  let items = [];
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', { items }), readDebounceMs: 0 });
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: {
    id: 'exec-1', type: 'commandExecution', command: 'echo done', status: 'inProgress' } }));
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: {
    id: 'exec-1', type: 'commandExecution', aggregatedOutput: 'done' } }));
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: {
    id: 'exec-1', type: 'commandExecution', command: 'echo done', status: 'inProgress' } }));
  assert.deepEqual(directMessages(stream).map(e => [e.text, e.toolItems[0].status]),
    [['echo done', 'running'], ['echo done', 'unknown']]);
  assert.deepEqual(directMessages(stream).map(e => e.liveKind), ['streaming', 'completed']);
  items = [{ id: 'exec-1', type: 'commandExecution', command: 'echo done', status: 'completed', aggregatedOutput: 'done' }];
  stream.notify(boundary('turn/completed', { turn: { id: 'official-turn', status: 'completed', items: [] } }));
  await until(() => stream.reads === 2);
  assert.equal(directMessages(stream).at(-1).toolItems[0].status, 'completed');
});

test('official collaboration activity and calls retain their identities and real fields', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', { items: [] }) });
  for (const tool of [
    { id: 'activity', type: 'subAgentActivity', agentThreadId: 'child-1', agentPath: 'worker', kind: 'started' },
    { id: 'call', type: 'collabAgentToolCall', tool: 'spawn_agent', status: 'inProgress', prompt: 'task', receiverThreadIds: ['child-1'] }
  ]) stream.notify(boundary('item/started', { turnId: 'official-turn', item: tool }));
  const messages = directMessages(stream);
  assert.deepEqual(messages.map(e => [e.threadId, e.turnId, e.itemId, e.role]),
    [[THREAD, 'official-turn', 'activity', 'tool'], [THREAD, 'official-turn', 'call', 'tool']]);
  assert.equal(messages[0].toolItems[0].status, 'unknown');
  assert.equal(messages[1].toolItems[0].status, 'running');
  assert.equal(messages[1].toolItems[0].prompt, 'task');
  assert.equal(stream.reads, 1);
});

test('tool lifecycle phase participates in deduplication even when official status is unchanged', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', { items: [] }) });
  const activity = { id: 'activity', type: 'subAgentActivity', agentThreadId: 'child-1', kind: 'started' };
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: activity }));
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: activity }));
  assert.deepEqual(directMessages(stream).map(e => [e.liveKind, e.toolItems[0].status]),
    [['streaming', 'unknown'], ['completed', 'unknown']]);
});

test('active snapshots complete earlier commentary without item statuses and retain only the final assistant owner', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', {
    items: [item('first commentary', 'first'), item('second commentary', 'second'), item('current answer', 'last')]
  }) });
  assert.deepEqual(directMessages(stream).map(entry => [entry.itemId, entry.text, entry.liveKind]), [
    ['first', 'first commentary', 'completed'], ['second', 'second commentary', 'completed'],
    ['last', 'current answer', 'streaming']
  ]);
});

test('a trailing tool, reasoning or approval item leaves no earlier assistant snapshot streaming', async t => {
  for (const type of ['commandExecution', 'reasoning', 'approval']) {
    const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', {
      items: [item('earlier commentary', 'first'), item('latest commentary', 'second'),
        { id: 'last-operation', type, text: 'PRIVATE_OPERATION_BODY' }]
    }) });
    assert.deepEqual(directMessages(stream).map(entry => [entry.itemId, entry.liveKind]), [['first', 'completed'], ['second', 'completed']], type);
    assert.ok(stream.response.frames.every(frame => !frame.includes('PRIVATE_OPERATION_BODY')));
  }
});

test('a new assistant or non-assistant start completes the previous output with unchanged body and identity', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('first answer') });
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('') }));
  stream.notify({ ...delta(), params: { ...delta().params, delta: 'first answer, extended' } });
  const original = directMessages(stream)[1];
  assert.equal(original.text, 'first answer, extended');
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('', 'second') }));
  assert.deepEqual(directMessages(stream)[2], { ...original, liveKind: 'completed' });
  stream.notify({ ...delta(), params: { ...delta().params, itemId: 'second', delta: 'second answer' } });
  const second = directMessages(stream)[3];
  assert.equal(second.liveKind, 'streaming');
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: { id: 'tool-next', type: 'commandExecution', aggregatedOutput: 'PRIVATE_TOOL_BODY' } }));
  assert.deepEqual(directMessages(stream)[4], { ...second, liveKind: 'completed' });
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('', 'official-item') }));
  stream.notify({ ...delta(), params: { ...delta().params, delta: 'late obsolete text' } });
  assert.equal(directMessages(stream).length, 5);
  assert.equal(stream.reads, 1);
});

test('switching turns closes the published old output before the new turn and never revives a retired turn', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('old unfinished answer') });
  const original = directMessages(stream)[0];
  stream.notify(boundary('turn/started', { turn: { id: 'next-turn' } }));
  assert.deepEqual(directMessages(stream)[1], { ...original, liveKind: 'completed' });
  stream.notify(boundary('item/started', { turnId: 'next-turn', item: item('new answer', 'new-item') }));
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('obsolete restart') }));
  stream.notify(delta());
  assert.deepEqual(directMessages(stream).map(entry => [entry.turnId, entry.text, entry.liveKind]), [
    ['official-turn', 'old unfinished answer', 'streaming'], ['official-turn', 'old unfinished answer', 'completed'],
    ['next-turn', 'new answer', 'streaming']
  ]);
  assert.equal(stream.reads, 1);
});

test('reconnect snapshot predecessors stay completed despite retained starts and deltas from the same turn', async t => {
  const retained = [
    boundary('item/started', { turnId: 'official-turn', item: item('', 'first') }),
    { ...delta(), params: { ...delta().params, itemId: 'first', delta: 'stale prefix' } },
    boundary('item/started', { turnId: 'official-turn', item: item('', 'last') }),
    { ...delta(), params: { ...delta().params, itemId: 'last', delta: 'current' } }
  ];
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    const stream = await directFixture(t, { readThread: () => snapshot('', 'inProgress', {
      items: [item('first full commentary', 'first'), item('current full answer', 'last')]
    }), readRetainedNotifications: async () => retained });
    assert.deepEqual(directMessages(stream).map(entry => [entry.itemId, entry.text, entry.liveKind]), [
      ['first', 'first full commentary', 'completed'], ['last', 'current full answer', 'streaming']
    ]);
  }
});

test('explicit retained completion wins over stale snapshot text and later retained start or delta', async t => {
  const retained = [
    boundary('item/completed', { turnId: 'official-turn', item: item('authoritative final') }),
    boundary('item/started', { turnId: 'official-turn', item: item('') }), delta()
  ];
  const stream = await directFixture(t, { readThread: () => snapshot('stale snapshot prefix'),
    readRetainedNotifications: async () => retained, readDebounceMs: 0 });
  assert.deepEqual(directMessages(stream).map(entry => [entry.text, entry.liveKind]), [['authoritative final', 'completed']]);
  stream.notify(boundary('turn/completed', { turn: { id: 'official-turn', status: 'completed', items: [] } }));
  await until(() => stream.reads === 2);
  assert.deepEqual(directMessages(stream).map(entry => [entry.text, entry.liveKind]), [['authoritative final', 'completed']]);
});

test('retained non-assistant starts close snapshot commentary without retaining private operation bodies', async t => {
  for (const type of ['commandExecution', 'reasoning', 'approval']) {
    const stream = await directFixture(t, { readThread: () => snapshot('finished commentary'),
      readRetainedNotifications: async () => [boundary('item/started', { turnId: 'official-turn',
        item: { id: 'next-operation', type, text: 'PRIVATE_OPERATION_BODY'.repeat(20_000) } })] });
    assert.equal(stream.stopped, 0);
    assert.deepEqual(directMessages(stream).map(entry => [entry.text, entry.liveKind]), [['finished commentary', 'completed']]);
    assert.ok(stream.response.frames.every(frame => !frame.includes('PRIVATE_OPERATION_BODY')));
  }
});

test('15s heartbeats never read the thread; 5min lease releases timers/listeners and reconnects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const stream = await directFixture(t);
  t.mock.timers.tick(14_999);
  assert.equal(stream.response.frames.filter(frame => !frame.startsWith('event: session.status')).length, 1);
  t.mock.timers.tick(1);
  assert.equal(stream.response.frames.at(-1), ': heartbeat\n\n');
  t.mock.timers.tick(285_000);
  assert.match(stream.response.frames.at(-1), /"reason":"reconnect","detail":"max_age"/);
  assert.equal(stream.reads, 1);
  assert.equal(stream.stopped, 1);
  assert.equal(stream.request.listenerCount('aborted'), 0);
  assert.equal(stream.response.listenerCount('close'), 0);
  assert.equal(stream.response.listenerCount('finish'), 0);
  assert.equal(stream.response.listenerCount('error'), 0);
  const count = stream.response.frames.length;
  t.mock.timers.tick(600_000);
  assert.equal(stream.response.frames.length, count);
  stream.cancel();
  assert.equal(stream.stopped, 1);
});

test('ordinary backpressure coalesces item states and metadata until drain without reading again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const stream = await directFixture(t, { response: responseFixture(), readThread: () => snapshot('') });
  // Let the new initial status frame through before applying backpressure to
  // the first text delta, preserving this test's original accepted-prefix case.
  stream.response.backpressure = true;
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('') }));
  stream.notify({ ...delta(), params: { ...delta().params, delta: '前' } });
  assert.equal(stream.stopped, 0);
  assert.equal(stream.response.frames.filter(frame => !frame.startsWith('event: session.status')).length, 1);
  stream.notify({ ...delta(), params: { ...delta().params, delta: '缀' } });
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('前缀完成') }));
  stream.notify({ ...delta(), params: { ...delta().params, delta: '迟到' } });
  for (let i = 0; i < 20; i++) stream.notify(boundary('thread/settings/updated'));
  t.mock.timers.tick(250);
  assert.equal(stream.response.frames.filter(frame => !frame.startsWith('event: session.status')).length, 1);
  stream.response.backpressure = false;
  stream.response.emit('drain');
  const messages = stream.response.frames.filter(frame => frame.startsWith('event: session.message'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]).entry);
  assert.deepEqual(messages.map(entry => [entry.text, entry.liveKind]), [['前', 'streaming'], ['前缀完成', 'completed']]);
  assert.equal(stream.response.frames.filter(frame => frame.startsWith('event: session.invalidate')).length, 1);
  assert.equal(stream.reads, 1);
  assert.equal(stream.stopped, 0);
  assert.equal(stream.response.listenerCount('drain'), 0);
  t.mock.timers.tick(15_000);
  assert.equal(stream.stopped, 0);
});

test('a consumer that never drains is released at its deadline and forcibly destroyed after grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const stream = await directFixture(t, { response: responseFixture({ backpressure: true, stallEnd: true }), backpressureTimeoutMs: 20 });
  assert.equal(stream.stopped, 0);
  t.mock.timers.tick(20);
  assert.equal(stream.stopped, 1);
  assert.match(stream.response.frames.at(-1), /backpressure_timeout/);
  assert.equal(stream.response.destroyed, false);
  t.mock.timers.tick(1000);
  assert.equal(stream.response.destroyed, true);
  assert.equal(stream.response.listenerCount('close'), 0);
  assert.equal(stream.request.listenerCount('aborted'), 0);
});

test('backpressure preserves completed messages across turns and repeated drains without duplicates', async t => {
  const stream = await directFixture(t, { response: responseFixture({ backpressure: true }) });
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('上一轮完整内容') }));
  stream.notify(boundary('turn/started', { turn: { id: 'next-turn' } }));
  stream.notify(boundary('item/started', { turnId: 'next-turn', item: item('新一轮') }));
  stream.notify(boundary('item/completed', { turnId: 'next-turn', item: item('新一轮完整内容') }));
  stream.notify({ ...delta(), params: { ...delta().params, turnId: 'next-turn', delta: '迟到内容' } });
  stream.response.emit('drain');
  assert.equal(stream.response.frames.length, 2);
  assert.equal(stream.stopped, 0);
  stream.response.backpressure = false;
  stream.response.emit('drain');
  stream.response.emit('drain');
  const messages = stream.response.frames.filter(frame => frame.startsWith('event: session.message'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]).entry);
  assert.deepEqual(messages.map(entry => [entry.turnId, entry.text, entry.liveKind]), [
    ['official-turn', '当前前缀', 'streaming'],
    ['official-turn', '上一轮完整内容', 'completed'],
    ['next-turn', '新一轮完整内容', 'completed']
  ]);
  assert.equal(stream.reads, 1);
  assert.equal(stream.response.listenerCount('drain'), 0);
});

test('a real HTTP response coalesces a delta burst in memory and drains its final state without reconnecting', { timeout: 3000 }, async t => {
  const chunks = [];
  const socket = new Duplex({ highWaterMark: 16 * 1024, read() {},
    write(chunk, encoding, done) { chunks.push(chunk.toString()); setImmediate(done); }
  });
  const request = new IncomingMessage(socket);
  request.method = 'GET';
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  socket.on('drain', () => response.emit('drain'));
  t.after(() => socket.destroy());
  let maximumBuffered = 0;
  const write = response.write;
  response.write = function (...args) {
    const accepted = write.apply(this, args);
    maximumBuffered = Math.max(maximumBuffered, this.writableLength);
    return accepted;
  };
  const stream = await directFixture(t, { response, readThread: () => snapshot('') });
  stream.notify(boundary('item/started', { turnId: 'official-turn', item: item('') }));
  for (let index = 0; index < 200; index++) {
    stream.notify({ ...delta(), params: { ...delta().params, delta: 'x'.repeat(100) } });
  }
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('x'.repeat(20_000)) }));
  await until(() => response.listenerCount('drain') === 0);
  const raw = chunks.join('');
  const messages = [...raw.matchAll(/event: session.message\ndata: ([^\n]+)/g)].map(match => JSON.parse(match[1]).entry);
  assert.equal(messages.at(-1).text.length, 20_000);
  assert.equal(messages.at(-1).liveKind, 'completed');
  assert.equal(new Set(messages.map(entry => `${entry.liveKind}:${entry.text.length}`)).size, messages.length);
  assert.ok(messages.length < 200);
  assert.ok(maximumBuffered < 256 * 1024);
  assert.doesNotMatch(raw, /event: stream.control/);
  assert.equal(stream.stopped, 0);
  assert.equal(stream.reads, 1);
});

test('coalesced frames and existing socket bytes share the buffer cap', async t => {
  const stream = await directFixture(t, { response: responseFixture({ backpressure: true }), maxBufferedBytes: 1200 });
  stream.response.writableLength = 600;
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('x'.repeat(80)) }));
  assert.equal(stream.stopped, 0);
  stream.notify(boundary('turn/started', { turn: { id: 'next-turn' } }));
  stream.notify(boundary('item/completed', { turnId: 'next-turn', item: item('y'.repeat(80)) }));
  assert.equal(stream.stopped, 1);
  assert.match(stream.response.frames.at(-1), /buffer_limit/);
  assert.equal(stream.response.frames.filter(frame => frame.startsWith('event: session.message')).length, 1);
  assert.equal(stream.response.listenerCount('drain'), 0);
});

test('aborting while backpressured discards pending output and cancels its drain deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const stream = await directFixture(t, { response: responseFixture({ backpressure: true }), backpressureTimeoutMs: 20 });
  stream.notify(boundary('item/completed', { turnId: 'official-turn', item: item('取消后不得发送') }));
  const count = stream.response.frames.length;
  stream.request.emit('aborted');
  stream.response.backpressure = false;
  stream.response.emit('drain');
  t.mock.timers.tick(600_000);
  assert.equal(stream.response.frames.length, count);
  assert.equal(stream.response.destroyed, false);
  assert.equal(stream.stopped, 1);
  assert.equal(stream.response.listenerCount('drain'), 0);
  assert.equal(stream.request.listenerCount('aborted'), 0);
});

test('a single frame above 256KiB repairs canonical history without truncating or reconnecting the same turn', async t => {
  const stream = await directFixture(t, { readThread: () => snapshot('x'.repeat(256 * 1024)), invalidateMs: 2 });
  await delay(10);
  assert.equal(stream.stopped, 0);
  assert.equal(directMessages(stream).length, 0);
  assert.equal(stream.response.frames.filter(frame => frame.startsWith('event: session.invalidate')).length, 1);
  assert.equal(stream.response.frames.some(frame => frame.startsWith('event: stream.control')), false);
  assert.ok(stream.response.frames.every(frame => Buffer.byteLength(frame) < 256 * 1024));
});

test('preexisting socket buffer at limit closes immediately without adding a control frame', async t => {
  const response = responseFixture();
  response.writableLength = 256 * 1024;
  const stream = await directFixture(t, { response });
  assert.equal(stream.stopped, 1);
  assert.equal(response.destroyed, true);
  assert.equal(response.frames.length, 0);
});

test('abort cancels pending metadata/read timers once and late failed read cannot write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const pending = Promise.withResolvers();
  const stream = await directFixture(t, { readThread: () => pending.promise });
  stream.notify(delta());
  stream.notify(boundary('thread/status/changed'));
  stream.request.emit('aborted');
  stream.response.emit('close');
  stream.cancel();
  pending.reject(Error('PRIVATE_LATE_ERROR'));
  await settle();
  t.mock.timers.tick(600_000);
  assert.equal(stream.stopped, 1);
  assert.equal(stream.reads, 1);
  assert.equal(stream.queued, 0);
  assert.deepEqual(stream.response.frames, []);
});

test('shared notification failure reconnects and malformed/mismatched official snapshot is never published', async t => {
  const stream = await directFixture(t);
  stream.notify({ message: 'PRIVATE_POLL_ERROR' }, 'codex.desktop_live.poll_failed');
  assert.equal(stream.stopped, 1);
  assert.match(stream.response.frames.at(-1), /notification_failed/);
  assert.doesNotMatch(stream.response.frames.join(''), /PRIVATE_/);
  for (const value of [undefined, { id: 'other-thread', turns: snapshot().thread.turns }]) {
    const invalid = await directFixture(t, { readThread: async () => value });
    assert.equal(invalid.stopped, 1);
    assert.match(invalid.response.frames.at(-1), /read_failed/);
    assert.equal(invalid.response.frames.some(frame => frame.startsWith('event: session.message')), false);
  }
});
