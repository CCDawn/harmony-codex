import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import { attachVoiceUpgrade } from '../src/voiceProxy.js';

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(t, supervisor = { ensureRunning: async () => {} }) {
  const reservation = net.createServer();
  const voicePort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const connections = new Set();
  const events = [];
  let upstreamBytes = Buffer.alloc(0);
  const upstream = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => { upstreamBytes = Buffer.concat([upstreamBytes, chunk]); });
    socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
  });
  const server = http.createServer();
  attachVoiceUpgrade({
    server, config: { voicePort }, authGate: { requireAuth: async () => {} },
    supervisor,
    logger: { write: (_channel, _level, event, data) => events.push({ event, ...data }) }
  });
  const port = await listen(server);
  const client = net.connect({ host: '127.0.0.1', port });
  client.on('error', () => {});
  let response = '';
  client.on('data', chunk => { response += chunk.toString(); });
  await once(client, 'connect');
  client.write('GET /voice HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  t.after(async () => {
    client.destroy();
    for (const socket of connections) socket.destroy();
    await Promise.all([new Promise(resolve => server.close(resolve)),
      new Promise(resolve => upstream.close(resolve))]);
  });
  return { client, upstream, voicePort, events, response: () => response, upstreamBytes: () => upstreamBytes };
}

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for proxy result');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('first voice request survives an upstream that starts listening after two seconds', async t => {
  const f = await fixture(t);
  await new Promise(resolve => setTimeout(resolve, 2100));
  await listen(f.upstream, f.voicePort);
  await until(() => f.response().includes('\r\n\r\n'));
  assert.match(f.response(), /^HTTP\/1\.1 101 /);
});

test('voice startup has a bounded failure below the phone eight-second timeout', async t => {
  const started = Date.now();
  const f = await fixture(t);
  await until(() => f.response().includes('\r\n\r\n'));
  assert.match(f.response(), /^HTTP\/1\.1 502 /);
  assert.ok(Date.now() - started < 7500);
  assert.equal(f.events.filter(e => e.event === 'voice.upstream.unreachable').length, 1);
});

test('a caller leaving during startup does not create an orphan upstream tunnel', async t => {
  const f = await fixture(t);
  let accepted = 0;
  f.upstream.on('connection', () => { accepted += 1; });
  await new Promise(resolve => setTimeout(resolve, 50));
  f.client.end();
  await new Promise(resolve => setTimeout(resolve, 500));
  await listen(f.upstream, f.voicePort);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(accepted, 0);
  assert.equal(f.events.filter(e => e.event === 'voice.tunnel.opened').length, 0);
  assert.equal(f.events.filter(e => e.event === 'voice.upstream.unreachable').length, 0);
});

test('closing both ends emits one tunnel close event', async t => {
  const f = await fixture(t);
  await listen(f.upstream, f.voicePort);
  await until(() => f.response().includes('\r\n\r\n'));
  f.client.end();
  await until(() => f.events.some(e => e.event === 'voice.tunnel.closed'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.events.filter(e => e.event === 'voice.tunnel.closed').length, 1);
});

test('early bytes arriving during startup are preserved after the upgrade request', async t => {
  const f = await fixture(t);
  const payload = Buffer.from([0x82, 0x03, 0xff, 0x00, 0x71]);
  await new Promise(resolve => setTimeout(resolve, 50));
  f.client.write(payload);
  await new Promise(resolve => setTimeout(resolve, 200));
  await listen(f.upstream, f.voicePort);
  await until(() => f.upstreamBytes().includes(payload));
  const bytes = f.upstreamBytes();
  assert.ok(bytes.subarray(bytes.indexOf('\r\n\r\n') + 4).equals(payload));
});

test('cancelling while the supervisor is pending also cancels startup work', async t => {
  let finish;
  const f = await fixture(t, { ensureRunning: () => new Promise(resolve => { finish = resolve; }) });
  await until(() => finish !== undefined);
  f.client.end();
  await new Promise(resolve => setTimeout(resolve, 100));
  await listen(f.upstream, f.voicePort);
  finish();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.events.filter(e => e.event === 'voice.tunnel.opened').length, 0);
  assert.equal(f.events.filter(e => e.event === 'voice.upstream.unreachable').length, 0);
});
