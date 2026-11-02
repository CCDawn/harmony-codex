import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const sourcePath = 'HarmonyCodexRemote/entry/src/main/ets/services/HdcRelayTunnel.ets';
const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
const executable = stripTypeScriptTypes(source + '\nglobalThis.Tunnel = HdcRelayTunnel;');
const config = { relayHost: 'relay.test', relayPort: 1234, deviceId: 'fixture', token: 'fixture', hdcdHost: '127.0.0.1', hdcdPort: 5678 };
const bytes = text => new TextEncoder().encode(text).buffer;
const decode = data => new TextDecoder().decode(data);
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, plans = []) {
  const sockets = [], statuses = [], metrics = [], timers = new Map();
  let timerId = 0;
  class FakeSocket {
    listeners = new Map();
    sends = [];
    connectCalls = 0;
    closeCalls = 0;
    connected = false;
    constructor(plan) { this.plan = plan; }
    on(name, callback) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    }
    emit(name, value) {
      if (name === 'close') this.connected = false;
      for (const listener of this.listeners.get(name) ?? []) listener(value);
    }
    async connect(options) {
      this.connectCalls += 1;
      await this.plan.connect?.(this, options);
      this.connected = true;
    }
    async send(options) {
      this.sends.push(options.data);
      await this.plan.send?.(this, options, this.sends.length);
    }
    async getState() { return this.plan.getState ? this.plan.getState(this) : { isConnected: this.connected }; }
    close() {
      this.closeCalls += 1;
      if (this.plan.emitClose !== false) this.emit('close');
    }
    message(text) { this.emit('message', { message: bytes(text) }); }
  }
  const context = vm.createContext({
    Error,
    socket: { constructTCPSocketInstance() {
      const instance = new FakeSocket(plans[sockets.length] ?? {});
      sockets.push(instance);
      return instance;
    } },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(executable, context, { filename: sourcePath });
  const tunnel = new context.Tunnel((...status) => statuses.push(status), (...metric) => metrics.push(metric));
  t.after(() => { tunnel.stop(); timers.clear(); });
  return { tunnel, sockets, statuses, metrics, timers,
    fire(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected a ${ms} ms timer`);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
    snapshot() { return JSON.stringify({ statuses, metrics, sends: sockets.map(s => s.sends.map(d => typeof d === 'string' ? d : decode(d))), closes: sockets.map(s => s.closeCalls) }); }
  };
}

async function pair(h, relay = h.sockets[0], suffix = '') {
  relay.message('{"ok":true,"mode":"paired","channelId":"fixture"}\n' + suffix);
  await flush();
  return h.sockets.at(-1);
}

for (const phase of ['connect', 'hello send']) {
  for (const pending of [false, true]) {
    test(`Relay close during ${phase} schedules retry even when operation ${pending ? 'stays pending' : 'resolves'}`, async t => {
      const operation = deferred();
      const earlyClose = socket => { socket.emit('close'); return pending ? operation.promise : undefined; };
      const h = harness(t, [phase === 'connect' ? { connect: earlyClose } : { send: earlyClose }]);
      h.tunnel.start(config);
      await flush();
      assert.equal(h.timers.size, 1, 'early close must release connectOnce and let the loop retry');
      assert.ok(h.statuses.some(([state, detail]) => state === '重连中' && detail.includes('1.5')));
      assert.equal(h.statuses.some(([state]) => state === '等待电脑'), false, 'closed Relay must not report ready');
      h.fire(1500);
      await flush();
      assert.equal(h.sockets.length, 2);
      const before = h.snapshot();
      operation.resolve();
      await flush();
      assert.equal(h.snapshot(), before, 'late old setup must not write or publish status');
    });
  }
}

for (const action of ['restart', 'stop']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`late hdcd connect ${outcome} after ${action} cannot pair or forward old bytes`, async t => {
      const connecting = deferred();
      const h = harness(t, [{}, { connect: () => connecting.promise }]);
      h.tunnel.start(config);
      await flush();
      h.sockets[0].message('{"ok":true,"mode":"paired"}\nold-rest');
      await flush();
      h.sockets[0].message('old-pending');
      h.tunnel[action](config);
      await flush();
      if (action === 'restart') await pair(h, h.sockets[2], 'fresh');
      const before = h.snapshot();
      if (outcome === 'reject') connecting.reject(new Error('old connect failed'));
      else connecting.resolve();
      await flush();
      assert.equal(h.snapshot(), before, 'old connect continuation must have no observable effect');
    });
  }
}

for (const phase of ['connect', 'hello send']) {
  for (const action of ['restart', 'stop']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`late Relay ${phase} ${outcome} after ${action} cannot affect current sockets`, async t => {
        const setup = deferred();
        const h = harness(t, [phase === 'connect' ? { connect: () => setup.promise } : { send: () => setup.promise }]);
        h.tunnel.start(config);
        await flush();
        h.tunnel[action](config);
        await flush();
        if (action === 'restart') await pair(h, h.sockets[1], 'fresh');
        const before = h.snapshot();
        if (outcome === 'reject') setup.reject(new Error('old setup failed'));
        else setup.resolve();
        await flush();
        assert.equal(h.snapshot(), before);
      });
    }
  }
}

test('old hdcd completion cannot drain the new pairing queue', async t => {
  const oldConnect = deferred(), newConnect = deferred();
  const h = harness(t, [{}, { connect: () => oldConnect.promise }, {}, { connect: () => newConnect.promise }]);
  h.tunnel.start(config);
  await flush();
  await pair(h, h.sockets[0], 'old-rest');
  h.sockets[0].message('old-queued');
  h.tunnel.restart(config);
  await flush();
  await pair(h, h.sockets[2], 'new-rest');
  h.sockets[2].message('new-queued');
  const before = h.snapshot();
  oldConnect.resolve();
  await flush();
  assert.equal(h.snapshot(), before);
  newConnect.resolve();
  await flush();
  assert.deepEqual(h.sockets[3].sends.map(decode), ['new-rest', 'new-queued']);
});

for (const direction of ['relay to hdcd', 'hdcd to relay']) {
  for (const action of ['restart', 'stop']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`late ${direction} send ${outcome} after ${action} cannot alter the next generation`, async t => {
        const sending = deferred();
        const h = harness(t, [direction === 'hdcd to relay' ? { send: (_socket, _data, count) => count > 1 ? sending.promise : undefined } : {},
          direction === 'relay to hdcd' ? { send: () => sending.promise } : {}]);
        h.tunnel.start(config);
        await flush();
        const hdcd = await pair(h);
        if (direction === 'relay to hdcd') h.sockets[0].message('old-payload');
        else hdcd.message('old-payload');
        await flush();
        h.tunnel[action](config);
        await flush();
        if (action === 'restart') await pair(h, h.sockets[2], 'fresh');
        const before = h.snapshot();
        if (outcome === 'reject') sending.reject(new Error('old send failed'));
        else sending.resolve();
        await flush();
        assert.equal(h.snapshot(), before, 'old send must not change metrics/status or close current sockets');
      });
    }
  }
}

test('same-generation retry ignores old Relay and hdcd callbacks and late send failure', async t => {
  const sending = deferred();
  const h = harness(t, [{}, { send: () => sending.promise }]);
  h.tunnel.start(config);
  await flush();
  const oldRelay = h.sockets[0], oldHdcd = await pair(h);
  oldRelay.message('old-send');
  await flush();
  oldRelay.emit('close');
  await flush();
  h.fire(1500);
  await flush();
  await pair(h, h.sockets[2]);
  const before = h.snapshot();
  oldRelay.message('stale-relay');
  oldHdcd.message('stale-hdcd');
  oldRelay.emit('error', new Error('old relay'));
  oldHdcd.emit('error', new Error('old hdcd'));
  oldRelay.emit('close');
  oldHdcd.emit('close');
  sending.reject(new Error('old send'));
  await flush();
  assert.equal(h.snapshot(), before);
});

test('normal fragmented handshake queues bytes during hdcd connect and forwards both directions', async t => {
  const connecting = deferred();
  const h = harness(t, [{}, { connect: () => connecting.promise }]);
  h.tunnel.start(config);
  await flush();
  const relay = h.sockets[0];
  assert.deepEqual(JSON.parse(relay.sends[0]), { role: 'phone', deviceId: 'fixture', token: 'fixture' });
  relay.message('{"ok":true,"mode":"wait');
  relay.message('ing"}\n');
  await flush();
  assert.equal(h.sockets.length, 1);
  relay.message('{"ok":true,"mode":"paired"}\nfirst');
  await flush();
  relay.message('second');
  connecting.resolve();
  await flush();
  const hdcd = h.sockets[1];
  assert.deepEqual(hdcd.sends.map(decode), ['first', 'second']);
  relay.message('third');
  hdcd.message('reply');
  await flush();
  assert.deepEqual(hdcd.sends.map(decode), ['first', 'second', 'third']);
  assert.equal(decode(relay.sends[1]), 'reply');
  assert.deepEqual(h.metrics.at(-1), [16, 5]);
  h.tunnel.stop();
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(relay.closeCalls, 1);
  assert.equal(hdcd.closeCalls, 1);
});

test('active setup failure closes the connection and retries', async t => {
  const h = harness(t, [{ connect: () => Promise.reject(new Error('fixture connect failed')) }]);
  h.tunnel.start(config);
  await flush();
  assert.equal(h.sockets[0].closeCalls, 1);
  assert.ok(h.statuses.some(([state, detail]) => state === '错误' && detail.includes('fixture connect failed')));
  h.fire(1500);
  await flush();
  assert.equal(h.sockets.length, 2);
});

for (const direction of ['relay to hdcd', 'hdcd to relay']) {
  test(`current ${direction} failure still closes both sockets and retries`, async t => {
    const rejectSend = () => Promise.reject(new Error('current send failed'));
    const h = harness(t, [direction === 'hdcd to relay' ? { send: (_socket, _data, count) => count > 1 ? rejectSend() : undefined } : {},
      direction === 'relay to hdcd' ? { send: rejectSend } : {}]);
    h.tunnel.start(config);
    await flush();
    const hdcd = await pair(h);
    (direction === 'relay to hdcd' ? h.sockets[0] : hdcd).message('payload');
    await flush();
    assert.ok(h.statuses.some(([state, detail]) => state === '错误' && detail.includes('current send failed')));
    assert.deepEqual(h.sockets.map(s => s.closeCalls), [1, 1]);
    assert.equal(h.timers.size, 1);
  });
}

test('manual stop releases pending setup without waiting for a socket close event', async t => {
  const connecting = deferred();
  const h = harness(t, [{ connect: () => connecting.promise, emitClose: false }]);
  h.tunnel.start(config);
  h.tunnel.stop();
  await flush();
  assert.equal(h.timers.size, 0);
  const before = h.snapshot();
  connecting.resolve();
  await flush();
  h.sockets[0].emit('close');
  h.sockets[0].emit('error', new Error('late stop error'));
  h.sockets[0].message('{"ok":true,"mode":"paired"}\n');
  assert.equal(h.snapshot(), before);
});

test('stop clears reconnect timer and restart cannot retain a stale retry timer', async t => {
  const h = harness(t);
  h.tunnel.start(config);
  await flush();
  h.sockets[0].emit('close');
  await flush();
  assert.equal(h.timers.size, 1);
  h.tunnel.restart(config);
  await flush();
  assert.equal(h.timers.size, 0);
  h.sockets[1].emit('close');
  await flush();
  assert.equal(h.timers.size, 1);
  h.tunnel.stop();
  await flush();
  assert.equal(h.timers.size, 0);
});

test('EINPROGRESS uses connected-state polling before forwarding', async t => {
  const h = harness(t, [{}, { connect: () => Promise.reject({ code: 2301115 }), getState: () => ({ isConnected: false }) }]);
  h.tunnel.start(config);
  await flush();
  await pair(h);
  assert.equal(h.timers.size, 1);
  h.sockets[1].plan.getState = () => ({ isConnected: true });
  h.fire(50);
  await flush();
  assert.equal(h.statuses.at(-1)[0], '转发中');
  h.tunnel.stop();
  assert.equal(h.timers.size, 0);
});

test('stop cancels an EINPROGRESS poll timer without scheduling another', async t => {
  const h = harness(t, [{}, { connect: () => Promise.reject({ code: 2301115 }), getState: () => ({ isConnected: false }) }]);
  h.tunnel.start(config);
  await flush();
  await pair(h);
  assert.equal(h.timers.size, 1);
  h.tunnel.stop();
  const before = h.snapshot();
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.snapshot(), before);
});

test('late EINPROGRESS getState completion after restart cannot pair or add a poll timer', async t => {
  const state = deferred();
  const h = harness(t, [{}, { connect: () => Promise.reject({ code: 2301115 }), getState: () => state.promise }]);
  h.tunnel.start(config);
  await flush();
  await pair(h);
  h.tunnel.restart(config);
  await flush();
  await pair(h, h.sockets[2]);
  const before = h.snapshot();
  state.resolve({ isConnected: true });
  await flush();
  assert.equal(h.snapshot(), before);
  assert.equal(h.timers.size, 0);
});
