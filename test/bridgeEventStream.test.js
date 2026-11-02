import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const root = 'HarmonyCodexRemote/entry/src/main/ets/services/';
const code = ['SseParser.ets', 'BridgeEventStream.ets'].map(file => fs.readFileSync(root + file, 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')).join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ pendingTransfer = false, status = 200 } = {}) {
  const requests = [], frames = [], states = [], timers = new Map();
  let timerId = 0, otpCounter = 0, cursor = 0, now = 0;
  const schedule = (fn, ms) => {const id = ++timerId; timers.set(id, {fn, ms, at: now + ms}); return id;};
  const context = vm.createContext({
    http: { RequestMethod: { GET: 'GET' }, createHttp() {
      const listeners = {};
      const request = { listeners, destroyed: false, sdkTimer: -1, finish: null, on(name, callback) {listeners[name] = callback;},
        async requestInStream(url, options) {
          this.url = url; this.options = options;
          listeners.headersReceive({'content-type':'text/event-stream'});
          if (!pendingTransfer || status !== 200) return status;
          // Model SDKs that complete requestInStream at transfer end. Data does
          // not reset their total read budget; the service owns the idle timer.
          return new Promise((resolve, reject) => {
            this.finish = () => resolve(status);
            this.sdkTimer = schedule(() => reject(new Error('SDK total read timeout')), options.readTimeout);
          });
        },
        end() {listeners.dataEnd(); this.finish?.();},
        destroy() {this.destroyed = true; timers.delete(this.sdkTimer); this.finish?.();} };
      requests.push(request); return request;
    } },
    util: {TextDecoder: class { decoder = new TextDecoder(); decodeWithStream(input, options) {return this.decoder.decode(input, options);} }},
    CredentialRuntime: {getRuntimeTotpSecret() {return 'fixture';}},
    TotpGenerator: {async currentCode() {return `otp-${++otpCounter}`;}},
    setTimeout: schedule,
    clearTimeout(id) {timers.delete(id);}
  });
  vm.runInContext(stripTypeScriptTypes(code + '\nglobalThis.Stream = BridgeEventStream;'), context);
  const stream = new context.Stream({url:'https://fixture.test/tasks/t/events', token:'fixture',
    afterSeq:()=>cursor, onFrame:frame=>{frames.push(JSON.parse(JSON.stringify(frame))); if(frame.id)cursor=Number(frame.id);},
    onState:state=>states.push(state), onReconnect() {}});
  return {stream, requests, frames, states, timers, getCursor:()=>cursor,
    fireRetry() {const [id, timer] = [...timers].find(([,timer])=>timer.ms < 45000); timers.delete(id); timer.fn();},
    getNow:()=>now,
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.fn();
        await flush();
      }
      now = target;
      await flush();
    }};
}

test('body remains open after status resolves and UTF-8 split bytes render before EOF', async () => {
  const h = harness(); h.stream.start(); await flush();
  const request = h.requests[0]; assert.equal(request.destroyed, false);
  const bytes = new TextEncoder().encode('id: 1\nevent: delta\ndata: 中文增量\n\n');
  for (const byte of bytes) request.listeners.dataReceive(Uint8Array.of(byte).buffer);
  assert.deepEqual(h.frames, [{event:'delta', data:'中文增量', id:'1'}]);
  assert.equal(request.destroyed, false);
  request.listeners.dataEnd(); assert.equal(request.destroyed, true);
  h.stream.stop(); assert.equal(h.timers.size, 0);
});

test('reconnect authenticates again and uses only applied cursor; closed request cannot emit', async () => {
  const h = harness(); h.stream.start(); await flush();
  const first = h.requests[0];
  first.listeners.dataReceive(new TextEncoder().encode('id: 3\ndata: applied\n\n').buffer);
  first.listeners.dataEnd();
  first.listeners.dataReceive(new TextEncoder().encode('id: 4\ndata: stale\n\n').buffer);
  assert.equal(h.frames.length, 1); assert.equal(h.getCursor(), 3);
  h.fireRetry(); await flush();
  assert.match(h.requests[1].url, /afterSeq=3$/);
  assert.equal(h.requests[1].options.header['X-Codex-Bridge-OTP'], 'otp-2');
  h.stream.stop(); assert.equal(h.timers.size, 0);
  h.requests[1].listeners.dataReceive(new TextEncoder().encode('data: stale\n\n').buffer);
  assert.equal(h.frames.length, 1);
});

test('cancelling before asynchronous credentials resolve never opens a request', async () => {
  const h = harness(); h.stream.start(); h.stream.stop(); await flush();
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
});

test('continuous frames survive the old minute deadline until the server ends its five-minute lease', async t => {
  const h = harness({pendingTransfer: true});
  t.after(() => h.stream.stop());
  h.stream.start(); await flush();
  const first = h.requests[0];
  for (let sequence = 1; sequence <= 19; sequence += 1) {
    await h.advance(15000);
    first.listeners.dataReceive(new TextEncoder().encode(`id: ${sequence}\nevent: delta\ndata: part-${sequence}\n\n`).buffer);
    assert.equal(first.destroyed, false, `healthy body must stay open at ${h.getNow()} ms`);
    assert.equal(h.requests.length, 1);
    assert.equal(h.states.includes('retrying'), false);
  }
  await h.advance(15000);
  assert.equal(first.destroyed, false, 'server lease must finish before SDK read budget');
  assert.equal(h.frames.length, 19);
  first.end();
  await flush();
  assert.equal(first.destroyed, true);
  assert.equal(h.states.at(-1), 'retrying');
  await h.advance(1000);
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].url, /afterSeq=19$/);
  assert.equal(h.requests[1].options.header['X-Codex-Bridge-OTP'], 'otp-2');
  h.stream.stop();
  assert.equal(h.timers.size, 0);
});

test('after continuous delivery beyond a minute, 45 seconds without data still reclaims the body', async t => {
  const h = harness({pendingTransfer: true});
  t.after(() => h.stream.stop());
  h.stream.start(); await flush();
  const first = h.requests[0];
  for (let step = 0; step < 6; step += 1) {
    await h.advance(15000);
    first.listeners.dataReceive(new TextEncoder().encode(': heartbeat\n\n').buffer);
  }
  await h.advance(44999);
  assert.equal(first.destroyed, false);
  await h.advance(1);
  assert.equal(first.destroyed, true);
  assert.equal(h.states.at(-1), 'retrying');
  h.stream.stop();
  assert.equal(h.timers.size, 0);
  await h.advance(600000);
  assert.equal(h.requests.length, 1);
});

test('a server that keeps sending without ending still has a bounded read lifetime', async t => {
  const h = harness({pendingTransfer: true});
  t.after(() => h.stream.stop());
  h.stream.start(); await flush();
  const first = h.requests[0];
  while (!first.destroyed && h.getNow() < 360000) {
    first.listeners.dataReceive(new TextEncoder().encode(': heartbeat\n\n').buffer);
    await h.advance(15000);
  }
  assert.equal(first.destroyed, true, 'SDK total read budget must stay finite');
  assert.ok(h.getNow() > 300000 && h.getNow() <= 360000, 'budget must outlast the server lease with a bounded margin');
  assert.equal(h.states.at(-1), 'retrying');
  h.stream.stop();
  assert.equal(h.timers.size, 0);
});

test('stop during a long healthy transfer clears idle and SDK timers and rejects late frames', async t => {
  const h = harness({pendingTransfer: true});
  t.after(() => h.stream.stop());
  h.stream.start(); await flush();
  const first = h.requests[0];
  for (let step = 0; step < 6; step += 1) {
    await h.advance(15000);
    first.listeners.dataReceive(new TextEncoder().encode('data: live\n\n').buffer);
  }
  assert.equal(h.requests.length, 1);
  h.stream.stop();
  const frameCount = h.frames.length;
  assert.equal(first.destroyed, true);
  assert.equal(h.timers.size, 0);
  first.listeners.dataReceive(new TextEncoder().encode('data: stale\n\n').buffer);
  first.end();
  await h.advance(600000);
  assert.equal(h.frames.length, frameCount);
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} still stops the stream without a retry`, async () => {
    const h = harness({pendingTransfer: true, status});
    h.stream.start(); await flush();
    assert.equal(h.requests[0].destroyed, true);
    assert.equal(h.stream.isRunning(), false);
    assert.equal(h.states.at(-1), status === 404 ? 'unavailable' : 'auth_error');
    assert.equal(h.timers.size, 0);
    await h.advance(600000);
    assert.equal(h.requests.length, 1);
  });
}

test('stream ownership remains active during transport retry and retires on explicit stop', async () => {
  const h = harness();
  assert.equal(h.stream.isRunning(), false);
  h.stream.start(); await flush();
  assert.equal(h.stream.isRunning(), true);
  h.requests[0].end();
  assert.equal(h.stream.isRunning(), true);
  h.stream.stop();
  assert.equal(h.stream.isRunning(), false);
});
