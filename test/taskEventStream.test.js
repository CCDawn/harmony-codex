import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createApp } from '../src/app.js';
import { EventBus } from '../src/eventBus.js';
import { openTaskEventStream, readStreamCursor } from '../src/taskEventStream.js';

const event = (seq, type = 'task.progress') => ({ seq, type, payload: { text: `part-${seq}` } });

const presentationContext = vm.createContext({});
const presentationSource = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionStreamPresentation.ets', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
vm.runInContext(stripTypeScriptTypes(`${presentationSource}\nglobalThis.render = latestSessionStreamText;`), presentationContext);

async function httpFixture(t) {
  const savedEnv = ['CODEX_BRIDGE_TOKEN', 'CODEX_BRIDGE_TOTP_SECRET'].map((key) => [key, process.env[key]]);
  process.env.CODEX_BRIDGE_TOKEN = 'sse-test-only';
  delete process.env.CODEX_BRIDGE_TOTP_SECRET;
  t.after(() => { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const runs = new Map();
  const app = createApp({ config: {
    projects: [], outboxEnabled: false, desktopLiveDiagnostics: false,
    desktopSupervisor: { armed: false },
    threadService: { getRun(id) {
      if (runs.has(id)) return runs.get(id);
      throw Object.assign(new Error('Unknown Codex run'), { statusCode: 404 });
    } },
    deviceRegistry: { initialize() {} },
    logger: { async write() {} }
  }, adapter: {} });
  const controller = new AbortController();
  t.after(() => { controller.abort(); app.server.closeAllConnections(); app.server.close(); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { ...app, runs, fetch: (pathname, headers = {}) => fetch(
    `http://127.0.0.1:${app.server.address().port}${pathname}`,
    { signal: controller.signal, headers: { authorization: 'Bearer sse-test-only', ...headers } }
  ) };
}

test('task SSE resumes after its cursor and delivers a delayed event before EOF', { timeout: 3000 }, async (t) => {
  const app = await httpFixture(t);
  app.store.tasks.set('task-stream', { id: 'task-stream', status: 'running', events: [event(1), event(2)] });
  const response = await app.fetch('/tasks/task-stream/events?afterSeq=1');
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('\n\n')) received += new TextDecoder().decode((await reader.read()).value);
  assert.match(received, /id: 2\n/);
  assert.doesNotMatch(received, /part-1/);
  const pending = reader.read();
  setTimeout(() => app.store.addEvent('task-stream', 'task.progress', { text: 'delayed-part' }), 10);
  const next = await pending;
  assert.equal(next.done, false);
  assert.match(new TextDecoder().decode(next.value), /delayed-part/);
});

test('both API run routes honor cursors and terminal controls, including task-backed runs', { timeout: 3000 }, async (t) => {
  const app = await httpFixture(t);
  app.store.tasks.set('task-run', { id: 'task-run', status: 'completed', events: [event(1), event(2)] });
  app.runs.set('native-run', { id: 'native-run', status: 'completed', events: [event(1), event(2)] });
  for (const sourceId of ['task-run', 'native-run']) {
    const response = await app.fetch(`/api/codex/runs/${sourceId}/events`, { 'last-event-id': '1' });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /id: 2\n/);
    assert.doesNotMatch(text, /part-1/);
    assert.match(text, /event: stream.control\ndata: .*"reason":"terminal"/);
    assert.equal(app.eventBus.listeners.size, 0);
  }
  assert.equal((await app.fetch('/api/codex/runs/unknown/events')).status, 404);
  assert.equal((await app.fetch('/tasks/unknown/events')).status, 404);
  assert.equal((await app.fetch('/api/codex/runs/native-run/events?afterSeq=-1')).status, 400);
});

test('an empty running stream flushes HTTP headers before any business event exists', { timeout: 3000 }, async (t) => {
  const app = await httpFixture(t);
  app.store.tasks.set('empty', { id: 'empty', status: 'running', events: [] });
  const response = await app.fetch('/tasks/empty/events');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(app.eventBus.listeners.get('empty').size, 1);
  await response.body.cancel();
});

const assistantText = '长文本续传'.repeat(1000);
const toolOutput = 'PRIVATE_TOOL_OUTPUT_'.repeat(5000);
const assistantItem = { id: 'assistant-item', type: 'agentMessage', text: assistantText, phase: 'final_answer' };
const streamPayloadCases = [
  {
    name: 'assistant delta',
    payload: { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'assistant-item', delta: assistantText } },
    identity: (payload) => [payload.params.threadId, payload.params.turnId, payload.params.itemId]
  },
  {
    name: 'completed assistant item',
    payload: { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: assistantItem } },
    identity: (payload) => [payload.params.threadId, payload.params.turnId, payload.params.item.id]
  },
  {
    name: 'completed turn with mixed assistant and tool items',
    payload: { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [
      { id: 'tool', type: 'commandExecution', aggregatedOutput: toolOutput }, assistantItem
    ] } } },
    identity: (payload) => [payload.params.threadId, payload.params.turn.id, payload.params.turn.items.find((item) => item.type === 'agentMessage').id]
  },
  {
    name: 'legacy completed assistant item',
    payload: { type: 'item.completed', item: { ...assistantItem, type: 'agent_message' } },
    identity: (payload) => [payload.item.id]
  }
];

for (const example of streamPayloadCases) {
  test(`REST cursor pages preserve complete ${example.name} before acknowledging its sequence`, { timeout: 3000 }, async (t) => {
    const app = await httpFixture(t);
    const payload = { ...example.payload, diagnosticBlob: toolOutput };
    const storedEvent = { ...event(1, example.payload.method ? 'codex.app_server.notification' : 'codex.exec.event'), id: 'message-event', taskId: 'text', payload };
    app.store.tasks.set('text', { id: 'text', status: 'running', events: [storedEvent] });
    const response = await app.fetch('/tasks/text?afterSeq=0&eventLimit=100');
    const raw = await response.text();
    assert.equal(response.status, 200);
    const task = JSON.parse(raw).task;
    assert.equal(task.eventCursor, 1);
    assert.equal(presentationContext.render(task.events), assistantText);
    assert.deepEqual(example.identity(task.events[0].payload), example.identity(example.payload));
    assert.equal(raw.includes(toolOutput), false);
    assert.ok(Buffer.byteLength(JSON.stringify(task.events[0].payload)) < Buffer.byteLength(assistantText) + 2048);
    assert.equal(storedEvent.payload, payload);
    assert.equal(storedEvent.payload.diagnosticBlob.length, toolOutput.length);
  });
}

test('REST cursor pages still summarize large tool and arbitrary nested payloads', { timeout: 3000 }, async (t) => {
  const app = await httpFixture(t);
  app.store.tasks.set('tools', { id: 'tools', status: 'running', events: [
    { ...event(1), payload: { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution', aggregatedOutput: toolOutput } } } },
    { ...event(2), payload: { method: 'turn/completed', params: { turn: { id: 'turn', items: [{ type: 'commandExecution', aggregatedOutput: toolOutput }] } } } },
    { ...event(3), payload: { arbitrary: { text: toolOutput }, output: toolOutput } }
  ] });
  const response = await app.fetch('/tasks/tools?afterSeq=0&eventLimit=100');
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(raw) < 4096);
  assert.equal(raw.includes(toolOutput), false);
  assert.equal(JSON.parse(raw).task.events.every((item) => item.payload.truncated === true), true);
});

class StreamResponse extends EventEmitter {
  frames = [];
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() { this.flushed = true; }
  write(frame) { this.frames.push(frame); return this.onWrite?.(frame) ?? true; }
  end(frame) {
    if (frame) this.frames.push(frame);
    this.writableEnded = true;
    if (!this.stallEnd) this.emit('finish');
  }
  destroy() { this.destroyed = true; this.emit('close'); }
  get text() { return this.frames.join(''); }
}

function fixture(t, { events = [], status = 'running', url = '/', headers = {}, ...options } = {}) {
  const request = Object.assign(new EventEmitter(), { url, headers });
  const response = new StreamResponse();
  const eventBus = new EventBus();
  const snapshot = { status, events };
  const start = (extra = {}) => openTaskEventStream({
    request, response, eventBus, sourceId: 'source', getSnapshot: () => snapshot,
    ...options, ...extra
  });
  const publish = (next) => { snapshot.events.push(next); eventBus.publish('source', next); };
  t.after(() => response.emit('close'));
  return { request, response, eventBus, snapshot, start, publish };
}

function controls(response) {
  return response.frames.filter((frame) => frame.includes('event: stream.control\n'))
    .map((frame) => JSON.parse(frame.match(/\ndata: ([^\n]+)/)[1]));
}

test('cursor parsing uses query before Last-Event-ID and rejects malformed cursors', () => {
  assert.deepEqual(readStreamCursor({ url: '/' }), { afterSeq: 0, cursorRequested: false });
  assert.deepEqual(readStreamCursor({ url: '/?afterSeq=2', headers: { 'last-event-id': '7' } }), { afterSeq: 2, cursorRequested: true });
  assert.deepEqual(readStreamCursor({ url: '/', headers: { 'last-event-id': '7' } }), { afterSeq: 7, cursorRequested: true });
  for (const raw of ['-1', '1.5', '2junk', '', '9007199254740992']) {
    assert.throws(() => readStreamCursor({ url: `/?afterSeq=${raw}` }), { statusCode: 400 });
  }
});

test('legacy clients replay all history with original event data, then receive live events', (t) => {
  const f = fixture(t, { events: [event(1), event(2)] });
  f.start();
  assert.equal(f.response.flushed, true);
  assert.equal(f.response.headers['x-accel-buffering'], 'no');
  assert.ok(f.response.frames[0].endsWith(`data: ${JSON.stringify(event(1))}\n\n`));
  f.publish(event(3));
  assert.match(f.response.text, /id: 3\n/);
  assert.equal(f.response.writableEnded, false);
});

test('Last-Event-ID reconnect excludes consumed events and duplicate bus notifications', (t) => {
  const f = fixture(t, { events: [event(1), event(2), event(3)], headers: { 'last-event-id': '2' } });
  f.start();
  f.eventBus.publish('source', event(3));
  f.publish(event(4));
  assert.deepEqual(f.response.frames.map((frame) => Number(frame.match(/^id: (\d+)/)[1])), [3, 4]);
});

test('old, future and missing-middle cursors explicitly require snapshot recovery', (t) => {
  for (const options of [
    { events: [event(5), event(6)], url: '/?afterSeq=2' },
    { events: [event(1)], url: '/?afterSeq=8' },
    { events: [event(1), event(3)], url: '/?afterSeq=1' },
    { events: [], url: '/?afterSeq=1' }
  ]) {
    const f = fixture(t, options);
    f.start();
    const [control] = controls(f.response);
    assert.equal(control.reason, 'gap');
    assert.equal(control.requiresSnapshot, true);
    assert.equal(f.response.writableEnded, true);
    assert.equal(f.eventBus.listeners.size, 0);
    assert.doesNotMatch(f.response.frames.at(-1), /^id:/m);
  }
});

test('a live sequence gap does not masquerade as a contiguous update', (t) => {
  const f = fixture(t, { events: [event(1)] });
  f.start();
  f.publish(event(3));
  assert.equal(controls(f.response)[0].reason, 'gap');
  assert.doesNotMatch(f.response.text, /id: 3/);
});

test('a cursor immediately before retained history is valid, including legacy replay', (t) => {
  for (const url of ['/', '/?afterSeq=4']) {
    const f = fixture(t, { events: [event(5), event(6)], url });
    f.start();
    assert.equal(controls(f.response).length, 0);
    assert.match(f.response.text, /id: 5\n/);
    assert.match(f.response.text, /id: 6\n/);
  }
});

test('heartbeat and subscription stop immediately on response close or request abort', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const closeThrough of ['response', 'request']) {
    const f = fixture(t, { heartbeatMs: 10, maxAgeMs: 100 });
    f.start();
    t.mock.timers.tick(10);
    assert.equal(f.response.text, ': heartbeat\n\n');
    if (closeThrough === 'response') f.response.emit('close');
    else f.request.emit('aborted');
    const previous = f.response.text;
    t.mock.timers.tick(200);
    f.publish(event(1));
    assert.equal(f.response.text, previous);
    assert.equal(f.eventBus.listeners.size, 0);
    assert.equal(f.request.listenerCount('aborted'), 0);
  }
});

test('connection age requests authenticated reconnection and clears its subscription', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, { heartbeatMs: 100, maxAgeMs: 20 });
  f.start();
  t.mock.timers.tick(20);
  assert.equal(controls(f.response)[0].reason, 'reconnect');
  assert.equal(controls(f.response)[0].detail, 'max_age');
  assert.equal(f.eventBus.listeners.size, 0);
  assert.equal(f.response.writableEnded, true);
});

test('a source lookup failure during heartbeat closes only that stream', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, { heartbeatMs: 10 });
  let unavailable = false;
  f.start({ getSnapshot() {
    if (unavailable) throw new Error('source removed');
    return f.snapshot;
  } });
  unavailable = true;
  assert.doesNotThrow(() => t.mock.timers.tick(10));
  assert.equal(controls(f.response)[0].detail, 'source_unavailable');
  assert.equal(f.eventBus.listeners.size, 0);
});

test('terminal history closes normally without a reconnect instruction', (t) => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const f = fixture(t, { status, events: [event(1)] });
    f.start();
    const [control] = controls(f.response);
    assert.equal(control.reason, 'terminal');
    assert.equal(control.status, status);
    assert.equal(control.eventCursor, 1);
    assert.equal(control.reconnect, undefined);
    assert.equal(f.eventBus.listeners.size, 0);
  }
});

test('live terminal notification observes status written immediately after publish', async (t) => {
  const f = fixture(t);
  f.start();
  f.publish(event(1, 'codex.turn.completed'));
  f.snapshot.status = 'completed';
  await Promise.resolve();
  assert.match(f.response.frames[0], /id: 1\nevent: codex.turn.completed/);
  assert.equal(controls(f.response)[0].reason, 'terminal');
  assert.equal(f.response.writableEnded, true);
});

test('an event published during replay is delivered before a concurrent terminal close', async (t) => {
  const f = fixture(t, { events: [event(1)] });
  f.response.onWrite = (frame) => {
    if (frame.startsWith('id: 1\n')) {
      f.publish(event(2, 'task.completed'));
      f.snapshot.status = 'completed';
    }
    return true;
  };
  f.start();
  await Promise.resolve();
  assert.match(f.response.text, /id: 2\nevent: task.completed/);
  assert.equal(controls(f.response)[0].eventCursor, 2);
});

test('ordinary backpressure pauses replay and resumes persisted live events on drain without reconnecting', async (t) => {
  const f = fixture(t, { events: [event(1), event(2), event(3)] });
  f.response.onWrite = frame => !/^id: (1|3)\n/.test(frame);
  f.start();
  assert.equal(f.response.writableEnded, false);
  assert.equal(f.response.frames.length, 1);
  f.publish(event(4));
  f.snapshot.status = 'completed';
  f.publish(event(5, 'task.completed'));
  await Promise.resolve();
  assert.equal(f.response.frames.length, 1);
  assert.equal(f.eventBus.listeners.size, 1);
  f.response.emit('drain');
  assert.equal(f.response.writableEnded, false);
  assert.equal(controls(f.response).length, 0);
  f.response.emit('drain');
  assert.deepEqual(f.response.frames.filter(frame => frame.startsWith('id:')).map(frame => Number(frame.match(/^id: (\d+)/)[1])), [1, 2, 3, 4, 5]);
  assert.equal(controls(f.response).length, 1);
  assert.equal(controls(f.response)[0].reason, 'terminal');
  assert.equal(controls(f.response)[0].eventCursor, 5);
  assert.equal(f.eventBus.listeners.size, 0);
  assert.equal(f.response.listenerCount('drain'), 0);
});

test('a large replay drains a real HTTP response in memory without reconnecting or losing events', { timeout: 3000 }, async () => {
  let maximumBuffered = 0;
  const chunks = [];
  const socket = new Duplex({
    highWaterMark: 16 * 1024,
    read() {},
    write(chunk, encoding, done) { chunks.push(chunk.toString()); setImmediate(done); }
  });
  const request = new http.IncomingMessage(socket);
  request.method = 'GET';
  request.url = '/?afterSeq=0';
  const response = new http.ServerResponse(request);
  response.assignSocket(socket);
  // Node's HTTP server forwards socket drain to its active response. This
  // transport is entirely in memory, so supply that server-side wiring here.
  socket.on('drain', () => response.emit('drain'));
  const write = response.write;
  response.write = function (...args) {
    const result = write.apply(this, args);
    maximumBuffered = Math.max(maximumBuffered, this.writableLength);
    return result;
  };
  const eventBus = new EventBus();
  const events = Array.from({ length: 200 }, (_, index) => ({ ...event(index + 1), payload: { text: 'x'.repeat(2000) } }));
  const finished = once(response, 'finish');
  try {
    openTaskEventStream({ request, response, eventBus, sourceId: 'memory', getSnapshot: () => ({ status: 'completed', events }) });
    assert.equal(response.writableEnded, false);
    await finished;
    const text = chunks.join('');
    assert.deepEqual([...text.matchAll(/^id: (\d+)\n/gm)].map(match => Number(match[1])), events.map(item => item.seq));
    assert.doesNotMatch(text, /"reason":"reconnect"/);
    assert.match(text, /"reason":"terminal"/);
    assert.ok(maximumBuffered < 256 * 1024);
    assert.equal(eventBus.listeners.size, 0);
    assert.equal(response.listenerCount('drain'), 0);
  } finally { socket.destroy(); }
});

test('history evicted while paused requests a snapshot instead of skipping events', (t) => {
  const f = fixture(t, { events: [event(1), event(2)] });
  f.response.onWrite = () => false;
  f.start();
  f.snapshot.events = [event(5), event(6)];
  f.response.emit('drain');
  assert.equal(controls(f.response)[0].reason, 'gap');
  assert.equal(controls(f.response)[0].eventCursor, 1);
  assert.doesNotMatch(f.response.text, /id: 5\n/);
  assert.equal(f.eventBus.listeners.size, 0);
});

test('a client that never drains gets bounded shutdown and cannot accumulate further events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, { backpressureTimeoutMs: 20, closeGraceMs: 10 });
  f.response.onWrite = () => false;
  f.response.stallEnd = true;
  f.start();
  f.publish(event(1));
  const length = f.response.text.length;
  for (let seq = 2; seq < 100; seq++) f.publish(event(seq));
  assert.equal(f.response.text.length, length);
  assert.equal(f.response.writableEnded, false);
  t.mock.timers.tick(20);
  assert.equal(controls(f.response)[0].detail, 'backpressure_timeout');
  assert.equal(f.eventBus.listeners.size, 0);
  assert.equal(f.response.listenerCount('drain'), 0);
  t.mock.timers.tick(10);
  assert.equal(f.response.destroyed, true);
});

test('aborting a backpressured stream cancels drain and shutdown timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, { backpressureTimeoutMs: 20 });
  f.response.onWrite = () => false;
  f.start();
  f.publish(event(1));
  const previous = f.response.text;
  f.request.emit('aborted');
  f.response.emit('drain');
  t.mock.timers.tick(1000);
  assert.equal(f.response.text, previous);
  assert.equal(f.response.destroyed, false);
  assert.equal(f.response.listenerCount('drain'), 0);
  assert.equal(f.eventBus.listeners.size, 0);
});

test('an oversized frame requests a snapshot without buffering the payload', (t) => {
  const f = fixture(t, { maxBufferedBytes: 200 });
  f.start();
  f.publish({ ...event(1), payload: { text: 'x'.repeat(500) } });
  assert.equal(controls(f.response)[0].reason, 'gap');
  assert.equal(controls(f.response)[0].eventCursor, 0);
  assert.ok(f.response.text.length < 300);
});

test('a socket already at the buffer cap is destroyed without adding a control frame', (t) => {
  const f = fixture(t, { events: [event(1)], maxBufferedBytes: 200 });
  f.response.writableLength = 200;
  f.start();
  assert.equal(f.response.destroyed, true);
  assert.equal(f.response.frames.length, 0);
  assert.equal(f.eventBus.listeners.size, 0);
});
