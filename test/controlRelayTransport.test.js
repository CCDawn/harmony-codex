import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import { createRelayServer } from '../src/hdc-relay/relayServer.js';
import { createBridgeProxy } from '../src/hdc-relay/bridgeProxy.js';

const host = '127.0.0.1';
const token = 'relay-test-secret';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for transport state');
}

async function fixture(t) {
  const relay = createRelayServer({ host, port: 0, token });
  await relay.listen();
  const relayPort = relay.server.address().port;
  const proxies = [];
  const servers = [];
  const localSockets = new Set();
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    await Promise.all(proxies.map((proxy) => proxy.close()));
    await relay.close();
    for (const socket of localSockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function addProxy({ role = 'control-pc', targetId = 'tray-a', label = targetId, hold = false } = {}) {
    const requests = [];
    const server = net.createServer((socket) => {
      localSockets.add(socket);
      socket.once('close', () => localSockets.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\r\n\r\n')) return;
        requests.push(buffer);
        buffer = '';
        const body = JSON.stringify({ label });
        const response = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: ${hold ? 'keep-alive' : 'close'}\r\n\r\n${body}`;
        if (hold) socket.write(response);
        else socket.end(response);
      });
    });
    servers.push(server);
    server.listen(0, host);
    await once(server, 'listening');
    const proxy = createBridgeProxy({
      relayHost: host, relayPort, token, role, targetId,
      localBridgeHost: host, localBridgePort: server.address().port,
      poolSize: 1, reconnectMs: 30
    });
    proxies.push(proxy);
    proxy.start();
    return { proxy, requests };
  }

  function connect() {
    const client = net.createConnection({ host, port: relayPort });
    client.on('error', () => {});
    clients.add(client);
    client.once('close', () => clients.delete(client));
    return client;
  }

  async function request(path) {
    const client = connect();
    let text = '';
    client.on('data', (chunk) => { text += chunk; });
    const ended = once(client, 'end');
    await once(client, 'connect');
    client.write(`GET ${path} HTTP/1.1\r\nhost: relay\r\nconnection: close\r\n\r\n`);
    await ended;
    const [headers, body] = text.split('\r\n\r\n');
    return { status: Number(headers.split(' ')[1]), headers, body: JSON.parse(body) };
  }

  return { relay, relayPort, addProxy, request, connect, localSockets };
}

test('bridge proxy accepts only supported roles and strict control target IDs', () => {
  for (const role of ['pc', 'control', '', null]) {
    assert.throws(() => createBridgeProxy({ relayHost: host, role }), /role must/);
  }
  for (const targetId of [undefined, '', 'a/b', 'a.b', 'a b', 'a'.repeat(65), 42]) {
    assert.throws(() => createBridgeProxy({ relayHost: host, role: 'control-pc', targetId }), /targetId/);
  }
  assert.doesNotThrow(() => createBridgeProxy({ relayHost: host }));
  assert.doesNotThrow(() => createBridgeProxy({ relayHost: host, role: 'control-pc', targetId: 'A_1-z' }));
});

test('control HTTP reaches a separate local agent while the business bridge is absent', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const agent = await f.addProxy();
  await waitFor(() => f.relay.state().controlPc === 1);
  assert.equal(f.relay.state().bridgePc, 0);
  const response = await f.request('/control/v1/targets/tray-a/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { label: 'tray-a' });
  assert.match(agent.requests[0], /^GET \/control\/v1\/targets\/tray-a\/health HTTP/);
  assert.equal(f.relay.state().bridgePc, 0);
});

test('business and two control targets use independent pools without crossed bytes', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const business = await f.addProxy({ role: 'bridge-pc', targetId: undefined, label: 'business' });
  const a = await f.addProxy();
  const b = await f.addProxy({ targetId: 'tray-a2' });
  await waitFor(() => f.relay.state().controlPc === 2 && f.relay.state().bridgePc === 1);
  const replies = await Promise.all([
    f.request('/health'),
    f.request('/control/v1/targets/tray-a/repair'),
    f.request('/control/v1/targets/tray-a2/status?fresh=1')
  ]);
  assert.deepEqual(replies.map((response) => response.body.label), ['business', 'tray-a', 'tray-a2']);
  assert.equal(business.requests.length, 1);
  assert.match(business.requests[0], /^GET \/health /);
  assert.equal(a.requests.length, 1);
  assert.match(a.requests[0], /^GET \/control\/v1\/targets\/tray-a\/repair /);
  assert.equal(b.requests.length, 1);
  assert.match(b.requests[0], /^GET \/control\/v1\/targets\/tray-a2\/status\?fresh=1 /);
  const admin = await f.request(`/__relay/state?token=${token}`);
  assert.equal(admin.status, 200);
  assert.equal(JSON.stringify(admin.body).includes(token), false);
});

test('an offline target returns 503 JSON and never consumes another target or business slot', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const business = await f.addProxy({ role: 'bridge-pc', label: 'business' });
  const agent = await f.addProxy();
  await waitFor(() => f.relay.state().controlPc === 1 && f.relay.state().bridgePc === 1);
  for (const path of ['/control/v1/targets/missing/health', '/control/v1/targets/tray-a2/health']) {
    const response = await f.request(path);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'control_agent_offline');
    assert.match(response.headers, /connection: close/i);
  }
  assert.equal(f.relay.state().bridgePc, 1);
  assert.equal(f.relay.state().controlPc, 1);
  assert.deepEqual(business.requests, []);
  assert.deepEqual(agent.requests, []);
});

test('malformed and normalized control paths cannot fall through to business or a control target', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const business = await f.addProxy({ role: 'bridge-pc' });
  const agent = await f.addProxy();
  await waitFor(() => f.relay.state().controlPc === 1 && f.relay.state().bridgePc === 1);
  for (const path of [
    '/control/v1/targets/tray-a', '/control/v1/targets/tray.a/health',
    '/control/v1/targets/tray-a%2fother/health', '/control/v1/targets//health',
    `/control/v1/targets/${'a'.repeat(65)}/health`, '/control/v1/targets/tray-a/../tray-a2/health',
    '/control/v1/targets/tray-a\\other/health', '/control/v1/targets/tray-a/health#fragment',
    '/control/v1/targets-extra/tray-a/health', '/control-extra/v1/targets/tray-a/health',
    '/%63ontrol/v1/targets/tray-a/health', '/business/../control/v1/targets/tray-a/health',
    'http://relay/control/v1/targets/tray-a/health'
  ]) {
    assert.equal((await f.request(path)).status, 400, path);
  }
  assert.deepEqual(business.requests, []);
  assert.deepEqual(agent.requests, []);
  assert.equal(f.relay.state().bridgePc, 1);
  assert.equal(f.relay.state().controlPc, 1);
});

test('control registration shares relay token authentication and rejects invalid targets', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const hello of [
    { role: 'control-pc', targetId: 'tray-a', token: 'wrong' },
    { role: 'control-pc', targetId: '../tray-a', token },
    { role: 'control-pc', targetId: '', token },
    { role: 'control-pc', token }
  ]) {
    const client = f.connect();
    let response = '';
    client.on('data', (chunk) => { response += chunk; });
    const closed = once(client, 'close');
    await once(client, 'connect');
    client.write(`${JSON.stringify(hello)}\n`);
    await closed;
    assert.equal(JSON.parse(response).ok, false);
    assert.equal(f.relay.state().controlPc, 0);
  }
});

test('relay close releases waiting, active control, business and incomplete hello sockets', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.addProxy({ hold: true });
  await f.addProxy({ role: 'bridge-pc' });
  await waitFor(() => f.relay.state().controlPc === 1 && f.relay.state().bridgePc === 1);
  const active = f.connect();
  await once(active, 'connect');
  const response = once(active, 'data');
  active.write('GET /control/v1/targets/tray-a/events HTTP/1.1\r\nhost: relay\r\n\r\n');
  await response;
  const incomplete = f.connect();
  await once(incomplete, 'connect');
  incomplete.write('GET /control');
  await waitFor(() => f.relay.state().controlPc === 1);
  active.resume();
  incomplete.resume();
  await f.relay.close();
  await waitFor(() => active.destroyed && incomplete.destroyed && f.localSockets.size === 0);
  assert.equal(f.relay.server.listening, false);
  assert.equal(f.relay.state().controlPc, 0);
  assert.equal(f.relay.state().bridgePc, 0);
});

test('proxy close releases local active sockets and cancels pending reconnects', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const { proxy } = await f.addProxy({ hold: true });
  await waitFor(() => f.relay.state().controlPc === 1);
  const client = f.connect();
  await once(client, 'connect');
  const response = once(client, 'data');
  client.write('GET /control/v1/targets/tray-a/events HTTP/1.1\r\nhost: relay\r\n\r\n');
  await response;
  client.resume();
  await waitFor(() => f.relay.state().controlPc === 1);
  await proxy.close();
  await waitFor(() => client.destroyed && f.localSockets.size === 0 && f.relay.state().controlPc === 0);

  let attempts = 0;
  f.relay.server.on('connection', () => { attempts += 1; });
  const rejected = createBridgeProxy({ relayHost: host, relayPort: f.relayPort, role: 'control-pc', targetId: 'tray-a', token: 'wrong', poolSize: 1, reconnectMs: 100 });
  t.after(() => rejected.close());
  rejected.start();
  await waitFor(() => attempts === 1);
  await delay(20);
  await rejected.close();
  await delay(150);
  assert.equal(attempts, 1);
});
