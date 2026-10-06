import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';

const TEST_TOKEN = 'voice-proxy-test-token';
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_TEST_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

function createTestConfig(overrides = {}) {
  const testRoot = path.join(os.tmpdir(), `codex-voice-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    appServerRuntimeMode: 'desktop',
    outboxEnabled: false,
    logger: new DiagnosticLogger({ root: testRoot }),
    deviceRegistryPath: path.join(testRoot, 'state', 'device-registry.json'),
    desktopLiveDiagnostics: false,
    desktopLiveRecovery: {
      shouldRecover() {
        return false;
      },
      async recover() {
        throw new Error('test recovery disabled');
      }
    },
    ...overrides
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// 最小假上游：读到转发来的 upgrade 请求头后回一个合法 101（带计算出的
// Sec-WebSocket-Accept），之后把收到的任意裸字节原样 echo——按字节级验证隧道。
function createFakeVoiceUpstream() {
  return net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.startsWith('GET ') && text.includes('\r\n\r\n')) {
        const keyMatch = /sec-websocket-key:\s*([^\r]+)/i.exec(text);
        assert.ok(keyMatch, 'upstream should receive the forwarded Sec-WebSocket-Key header');
        const accept = crypto.createHash('sha1')
          .update(`${keyMatch[1].trim()}${WS_MAGIC_GUID}`)
          .digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          ''
        ].join('\r\n'));
        return;
      }
      socket.write(chunk);
    });
  });
}

function createUpgradeClient(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let buffer = Buffer.alloc(0);
  const waiters = new Set();
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const waiter of [...waiters]) {
      if (waiter.check(buffer)) {
        waiters.delete(waiter);
      }
    }
  });
  // 读取路径通过 waitFor 暴露错误，这里吞掉 socket 级 error 避免 unhandled。
  socket.on('error', () => {});
  return {
    socket,
    async sendUpgradeRequest({ requestPath = '/voice', headers = {} } = {}) {
      await once(socket, 'connect');
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${WS_TEST_KEY}`,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    },
    waitFor(predicate, timeoutMs = 3000) {
      if (predicate(buffer)) {
        return Promise.resolve(buffer);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          check: (next) => {
            if (predicate(next)) {
              clearTimeout(timer);
              resolve(next);
              return true;
            }
            return false;
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting; buffer so far: ${buffer.toString('utf8').slice(0, 160)}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    bufferText: () => buffer.toString('utf8'),
    rawBuffer: () => buffer
  };
}

function expectedAccept(key) {
  return crypto.createHash('sha1').update(`${key}${WS_MAGIC_GUID}`).digest('base64');
}

async function listenOnFreePort(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function findDeadPort() {
  const probe = net.createServer();
  const port = await listenOnFreePort(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function closeApp(app, server) {
  app.voiceProcess?.close();
  server.close();
  server.closeAllConnections?.();
}

async function pollUntil(check, timeoutMs = 3000, stepMs = 40) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('timed out waiting for condition');
}

test('voice upgrade is rejected with a raw 401 when the token is missing', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const config = createTestConfig({ voiceEnabled: false });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);
  const client = createUpgradeClient(server.address().port);

  try {
    await client.sendUpgradeRequest({ requestPath: '/voice' });
    const buffer = await client.waitFor((next) => next.toString('utf8').includes('\r\n\r\n'));
    assert.match(buffer.toString('utf8'), /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(buffer.toString('utf8'), /Connection: close/i);
  } finally {
    client.socket.destroy();
    closeApp(app, server);
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('non-voice upgrade with a valid token is rejected with a raw 404', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const config = createTestConfig({ voiceEnabled: false });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);
  const client = createUpgradeClient(server.address().port);

  try {
    await client.sendUpgradeRequest({
      requestPath: '/not-voice',
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    const buffer = await client.waitFor((next) => next.toString('utf8').includes('\r\n\r\n'));
    assert.match(buffer.toString('utf8'), /^HTTP\/1\.1 404 Not Found\r\n/);
  } finally {
    client.socket.destroy();
    closeApp(app, server);
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('voice upgrade tunnels text and binary bytes end-to-end after the upstream handshake', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const upstream = createFakeVoiceUpstream();
  const upstreamPort = await listenOnFreePort(upstream);
  const config = createTestConfig({
    voiceEnabled: true,
    voicePort: upstreamPort,
    voiceCommand: 'node -e "setTimeout(()=>{},60000)"'
  });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);
  const client = createUpgradeClient(server.address().port);

  try {
    await client.sendUpgradeRequest({
      requestPath: '/voice',
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    const buffer = await client.waitFor((next) => next.toString('utf8').includes('\r\n\r\n'));
    assert.match(buffer.toString('utf8'), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.ok(
      buffer.toString('utf8').includes(`Sec-WebSocket-Accept: ${expectedAccept(WS_TEST_KEY)}`),
      'upstream-computed Sec-WebSocket-Accept must travel back through the tunnel'
    );

    const beforeBytes = buffer.length;
    const textFrame = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]);
    const binaryBlob = Buffer.from([0x00, 0xff, 0xfe, 0x7f, 0x80, 0x01]);
    const payload = Buffer.concat([textFrame, binaryBlob]);
    client.socket.write(payload);
    const after = await client.waitFor((next) => next.length >= beforeBytes + payload.length);
    assert.ok(after.subarray(beforeBytes).equals(payload));

    const status = await fetch(`http://127.0.0.1:${server.address().port}/voice/status`, {
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.voice.enabled, true);
    assert.equal(body.voice.running, true);
    assert.ok(body.voice.pid > 0);
  } finally {
    client.socket.destroy();
    closeApp(app, server);
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('voice upgrade answers 502 when the upstream voice port is unreachable', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const deadPort = await findDeadPort();
  const config = createTestConfig({
    voiceEnabled: true,
    voicePort: deadPort,
    voiceCommand: 'node -e "process.exit(0)"'
  });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);
  const client = createUpgradeClient(server.address().port);

  try {
    await client.sendUpgradeRequest({
      requestPath: '/voice',
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    const buffer = await client.waitFor((next) => next.toString('utf8').includes('\r\n\r\n'));
    assert.match(buffer.toString('utf8'), /^HTTP\/1\.1 502 Bad Gateway\r\n/);

    await pollUntil(() => {
      const status = app.voiceProcess.status();
      return status.running === false && status.lastExitCode === 0 ? status : null;
    });
  } finally {
    client.socket.destroy();
    closeApp(app, server);
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('voice status reports the supervised process after a lazy start', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const upstream = createFakeVoiceUpstream();
  const upstreamPort = await listenOnFreePort(upstream);
  const config = createTestConfig({
    voiceEnabled: true,
    voicePort: upstreamPort,
    voiceCommand: 'node -e "setTimeout(()=>{},60000)"'
  });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);

  try {
    const before = await fetch(`http://127.0.0.1:${server.address().port}/voice/status`, {
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    assert.equal(before.status, 200);
    assert.equal((await before.json()).voice.running, false);

    await app.voiceProcess.ensureRunning();

    const after = await fetch(`http://127.0.0.1:${server.address().port}/voice/status`, {
      headers: { 'x-codex-bridge-token': TEST_TOKEN }
    });
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.equal(body.voice.enabled, true);
    assert.equal(body.voice.running, true);
    assert.ok(body.voice.pid > 0);
  } finally {
    closeApp(app, server);
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('voice supervisor restarts the voice server after an unexpected exit', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = TEST_TOKEN;
  const deadPort = await findDeadPort();
  const config = createTestConfig({
    voiceEnabled: true,
    voicePort: deadPort,
    voiceCommand: 'node -e "setInterval(()=>{},200)"',
    voiceReconnectDelayMs: 50
  });
  const app = createApp({ config, adapter: new MockCodexAdapter() });
  const server = app.server;
  await listenOnFreePort(server);

  try {
    const started = await app.voiceProcess.ensureRunning();
    const firstPid = started.pid;
    assert.ok(firstPid > 0);

    process.kill(firstPid);

    const restarted = await pollUntil(() => {
      const status = app.voiceProcess.status();
      return status.running && status.pid !== firstPid ? status : null;
    });
    assert.ok(restarted.restarts >= 1);
  } finally {
    closeApp(app, server);
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});
