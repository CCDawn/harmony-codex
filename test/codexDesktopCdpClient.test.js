import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import {
  buildDesktopCdpWebSocketOptions,
  CodexDesktopCdpClient,
  extractConversationIdFromDesktopThreadKey,
  extractConversationIdFromPath,
  isRetryableCdpTransportError,
  probeDesktopCdpLiveness,
  resolveDesktopCdpPort,
  resolveDesktopCdpPortCandidates,
  selectCodexDesktopCdpTarget
} from '../src/codexDesktopCdpClient.js';

function notificationHarness({ legacyCount = 0 } = {}) {
  const listeners = [];
  let window;
  function newRenderer() {
    listeners.length = 0;
    window = { addEventListener(_type, callback) { listeners.push(callback); } };
  }
  function push(index, hostId = 'local') {
    const data = { type: 'mcp-notification', hostId, method: 'item/agentMessage/delta',
      params: { threadId: 'synthetic-thread', itemId: 'synthetic-item', delta: String(index) } };
    for (const listener of listeners) listener({ data });
  }
  newRenderer();
  if (legacyCount) {
    // Simulate the collector already injected by the previous bridge version.
    window.__codexHramonyBridge = { notifications: [], installed: true };
    window.addEventListener('message', ({ data }) => {
      const buffer = window.__codexHramonyBridge.notifications;
      buffer.push({ at: Date.now(), hostId: data.hostId, method: data.method, params: data.params });
      if (buffer.length > 1000) buffer.splice(0, buffer.length - 1000);
    });
    for (let index = 0; index < legacyCount; index++) push(index);
  }
  function client(hostId = 'local') {
    const instance = new CodexDesktopCdpClient({ hostId });
    instance.ensureConnected = async () => {};
    instance.evaluate = async expression => structuredClone(new Function('window', `return (${expression});`)(window));
    return instance;
  }
  return { client, push, newRenderer };
}

test('desktop deltas keep arriving after the 1000-entry renderer cache saturates', async () => {
  const harness = notificationHarness();
  const client = harness.client();
  await client.installNotificationCollector();
  for (let index = 0; index < 1000; index++) harness.push(index);
  assert.equal((await client.drainNotifications()).length, 1000);
  harness.push(1000);
  assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['1000']);
  harness.push(1001);
  assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['1001']);
  assert.deepEqual(await client.drainNotifications(), []);
  // More than one full buffer can arrive between reads. Deliver the retained
  // suffix once, then keep following later deltas instead of freezing again.
  for (let index = 1002; index < 2502; index++) harness.push(index);
  const retained = await client.drainNotifications();
  assert.equal(retained.length, 1000);
  assert.equal(retained[0].params.delta, '1502');
  assert.equal(retained.at(-1).params.delta, '2501');
  harness.push(2502);
  assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['2502']);
});

test('session replay is non-consuming and shares stable identities with the live notification drain', async () => {
  const h = notificationHarness();
  const client = h.client();
  await client.installNotificationCollector();
  h.push('one'); h.push('two'); h.push('other-host', 'remote');
  const offset = client.notificationOffset;
  const first = await client.readRetainedNotifications('synthetic-thread');
  assert.equal(client.notificationOffset, offset);
  assert.equal(first.length, 2);
  assert.ok(first[0].notificationId);
  assert.notEqual(first[0].notificationId, first[1].notificationId);
  const live = await client.drainNotifications();
  assert.deepEqual(live.map(event => event.notificationId), first.map(event => event.notificationId));
  assert.deepEqual(await client.readRetainedNotifications('synthetic-thread'), first);
  assert.deepEqual(await client.drainNotifications(), []);
  assert.deepEqual(await client.readRetainedNotifications('another-thread'), []);
});

test('a legacy full cache is baselined without replay and remains readable by independent clients', async () => {
  const harness = notificationHarness({ legacyCount: 1000 });
  const first = harness.client();
  const second = harness.client();
  await first.installNotificationCollector();
  await second.installNotificationCollector();
  assert.deepEqual(await first.drainNotifications(), []);
  assert.deepEqual(await second.drainNotifications(), []);
  harness.push(1000);
  for (const client of [first, second]) {
    assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['1000']);
    assert.deepEqual(await client.drainNotifications(), []);
  }
});

test('collector reinstall preserves unread deltas on the same renderer and baselines a replacement renderer', async () => {
  const harness = notificationHarness();
  const client = harness.client();
  await client.installNotificationCollector();
  harness.push('first');
  await client.drainNotifications();
  client.close();
  harness.push('during-disconnect');
  await client.installNotificationCollector();
  assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['during-disconnect']);
  harness.newRenderer();
  await client.installNotificationCollector();
  harness.push('new-renderer');
  assert.deepEqual((await client.drainNotifications()).map(item => item.params.delta), ['new-renderer']);
});

test('concurrent drains on one client deliver each notification once and keep other hosts isolated', async () => {
  const harness = notificationHarness();
  const client = harness.client();
  await client.installNotificationCollector();
  harness.push('local');
  harness.push('remote', 'other-host');
  const results = await Promise.all([client.drainNotifications(), client.drainNotifications()]);
  assert.deepEqual(results.flat().map(item => item.params.delta), ['local']);
  assert.deepEqual(await client.drainNotifications(), []);
});

test('current turn lookup uses bounded official pages in chronological order', async () => {
  const client = new CodexDesktopCdpClient();
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      return { thread: { id: 'target', status: { type: 'active' } } };
    }
    assert.equal(method, 'thread/turns/list');
    assert.deepEqual(params, { threadId: 'target', limit: 10, itemsView: 'summary' });
    return { data: [{ id: 'current', status: 'inProgress' }, { id: 'older', status: 'completed' }] };
  };
  const result = await client.readRecentThread('target');
  assert.deepEqual(result.thread.turns.map(turn => turn.id), ['older', 'current']);
  assert.equal(result.thread.status.type, 'active');
  assert.equal(calls.length, 2);
});

test('failed turn page never falls back to unbounded history', async () => {
  const client = new CodexDesktopCdpClient();
  client.request = async (method, params) => {
    assert.notEqual(params.includeTurns, true);
    if (method === 'thread/read') return { thread: { id: 'target' } };
    throw new Error('page unavailable');
  };
  await assert.rejects(client.readRecentThread('target'), /page unavailable/);
});

test('buildDesktopCdpWebSocketOptions sends the Electron CDP allow-listed Origin', () => {
  assert.deepEqual(buildDesktopCdpWebSocketOptions(9229, {}), {
    headers: {
      Origin: 'http://127.0.0.1:9229'
    }
  });
  assert.deepEqual(buildDesktopCdpWebSocketOptions(51413, {
    CODEX_DESKTOP_CDP_ORIGIN: 'http://localhost:51413/'
  }), {
    headers: {
      Origin: 'http://localhost:51413'
    }
  });
});

test('extractConversationIdFromPath reads Codex desktop conversation routes', () => {
  assert.equal(
    extractConversationIdFromPath('/local/019e6a12-1a79-7bf2-ad67-83aa7d7c39f7'),
    '019e6a12-1a79-7bf2-ad67-83aa7d7c39f7'
  );
  assert.equal(
    extractConversationIdFromPath('/remote/019e-remote?foo=bar'),
    '019e-remote'
  );
  assert.equal(
    extractConversationIdFromPath('/hotkey-window/thread/019e-hotkey'),
    '019e-hotkey'
  );
  assert.equal(extractConversationIdFromPath('/settings'), null);
});

test('extractConversationIdFromDesktopThreadKey reads the active sidebar thread id', () => {
  assert.equal(
    extractConversationIdFromDesktopThreadKey('local:019f8a33-68b5-7d33-ae86-477aa2239b22'),
    '019f8a33-68b5-7d33-ae86-477aa2239b22'
  );
  assert.equal(extractConversationIdFromDesktopThreadKey('remote:019e-remote'), '019e-remote');
  assert.equal(extractConversationIdFromDesktopThreadKey('invalid'), null);
});

test('CodexDesktopCdpClient opens a desktop thread through the rendered sidebar', async () => {
  const client = new CodexDesktopCdpClient({ timeoutMs: 3210 });
  let expression = '';
  let timeoutMs = 0;
  client.ensureConnected = async () => {};
  client.evaluate = async (value, timeout) => {
    expression = value;
    timeoutMs = timeout;
    return {
      ok: true,
      sessionId: '019f8a33-68b5-7d33-ae86-477aa2239b22',
      desktopThreadKey: 'local:019f8a33-68b5-7d33-ae86-477aa2239b22'
    };
  };

  const result = await client.openDesktopThread('019f8a33-68b5-7d33-ae86-477aa2239b22');

  assert.equal(result.ok, true);
  assert.equal(timeoutMs, 8000);
  assert.match(expression, /data-app-action-sidebar-thread-id/);
  assert.match(expression, /const sessionId = "019f8a33-68b5-7d33-ae86-477aa2239b22"/);
  assert.match(expression, /\['local:' \+ sessionId, 'remote:' \+ sessionId\]/);
  assert.match(expression, /scrollIntoView/);
  assert.match(expression, /\.click\(\)/);
  assert.match(expression, /data-app-action-sidebar-thread-active/);
});

test('CodexDesktopCdpClient rejects unsafe desktop thread ids before evaluating DOM code', async () => {
  const client = new CodexDesktopCdpClient();
  client.ensureConnected = async () => {
    throw new Error('must not connect');
  };

  await assert.rejects(
    client.openDesktopThread('../bad'),
    /Invalid Codex desktop thread id/
  );
});

test('selectCodexDesktopCdpTarget ignores the avatar overlay renderer', () => {
  const selected = selectCodexDesktopCdpTarget([
    {
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html?initialRoute=%2Favatar-overlay',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/avatar'
    },
    {
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/main'
    }
  ]);

  assert.equal(selected.webSocketDebuggerUrl, 'ws://127.0.0.1:9229/devtools/page/main');
});

test('selectCodexDesktopCdpTarget identifies the application independently of its title', () => {
  const webpage = { type: 'page', title: 'Codex', url: 'http://localhost/teams', webSocketDebuggerUrl: 'ws://web' };
  const overlay = { type: 'page', title: 'ChatGPT', url: 'app://-/index.html?initialRoute=%2Favatar-overlay', webSocketDebuggerUrl: 'ws://overlay' };
  const main = { type: 'page', title: 'ChatGPT', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://main' };
  assert.equal(selectCodexDesktopCdpTarget([webpage, overlay, main]), main);
  assert.equal(selectCodexDesktopCdpTarget([webpage, overlay]), null);
});

test('resolveDesktopCdpPort prefers explicit environment value', () => {
  assert.equal(resolveDesktopCdpPort({ CODEX_DESKTOP_CDP_PORT: '51413' }), 51413);
});

test('resolveDesktopCdpPortCandidates keeps stale desktop live status ports as fallbacks', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 61418,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    }));

    assert.deepEqual(resolveDesktopCdpPortCandidates({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), [61418, 9229]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveDesktopCdpPort accepts fresh desktop live status files', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51414,
      updatedAt: new Date().toISOString()
    }));

    assert.equal(resolveDesktopCdpPort({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), 51414);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveDesktopCdpPort probes the selected port while desktop injection is starting', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({
      status: 'starting',
      cdpPort: 51415,
      updatedAt: new Date().toISOString()
    }));

    assert.equal(resolveDesktopCdpPort({
      CODEX_DESKTOP_CDP_STATUS_PATH: statusPath,
      CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS: '600000'
    }), 51415);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveDesktopCdpPort ignores failed desktop live status files', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  try {
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    writeFileSync(statusPath, JSON.stringify({ status: 'failed', cdpPort: 51415,
      updatedAt: new Date().toISOString() }));
    assert.deepEqual(resolveDesktopCdpPortCandidates({ CODEX_DESKTOP_CDP_STATUS_PATH: statusPath }), [9229]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CodexDesktopCdpClient refreshes the CDP port from the live status file', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'codex-cdp-status-'));
  const previousPort = process.env.CODEX_DESKTOP_CDP_PORT;
  const previousStatusPath = process.env.CODEX_DESKTOP_CDP_STATUS_PATH;
  const previousMaxAge = process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS;
  try {
    delete process.env.CODEX_DESKTOP_CDP_PORT;
    const statusPath = path.join(tempRoot, 'desktop-live-status.json');
    process.env.CODEX_DESKTOP_CDP_STATUS_PATH = statusPath;
    process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS = '600000';
    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51416,
      updatedAt: new Date().toISOString()
    }));
    const client = new CodexDesktopCdpClient();
    assert.equal(client.port, 51416);

    writeFileSync(statusPath, JSON.stringify({
      status: 'injected',
      cdpPort: 51417,
      updatedAt: new Date().toISOString()
    }));
    assert.equal(client.refreshPort(), 51417);
  } finally {
    if (previousPort === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_PORT;
    } else {
      process.env.CODEX_DESKTOP_CDP_PORT = previousPort;
    }
    if (previousStatusPath === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_STATUS_PATH;
    } else {
      process.env.CODEX_DESKTOP_CDP_STATUS_PATH = previousStatusPath;
    }
    if (previousMaxAge === undefined) {
      delete process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS;
    } else {
      process.env.CODEX_DESKTOP_CDP_STATUS_MAX_AGE_MS = previousMaxAge;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CDP disconnect closes the underlying socket and rejects pending calls', async () => {
  const client = new CodexDesktopCdpClient();
  let closed = 0;
  const socket = {
    close() {
      closed += 1;
    }
  };
  const pending = new Promise((resolve, reject) => {
    client.pending.set(1, {
      resolve,
      reject,
      timeout: setTimeout(() => {}, 10000)
    });
  });
  client.socket = socket;

  client.markDisconnected(socket, new Error('boom'));

  await assert.rejects(pending, /boom/);
  assert.equal(closed, 1);
  assert.equal(client.socket, null);
  assert.equal(client.connected, null);
  assert.equal(client.pending.size, 0);
});

test('concurrent CDP connection attempts share one in-flight socket setup', async () => {
  const client = new CodexDesktopCdpClient();
  let connects = 0;
  let release = () => {};
  const connected = new Promise((resolve) => {
    release = resolve;
  });
  client.connect = async () => {
    connects += 1;
    await connected;
    client.socket = {
      readyState: WebSocket.OPEN,
      close() {}
    };
  };

  const first = client.ensureConnected();
  const second = client.ensureConnected();
  await Promise.resolve();

  assert.equal(connects, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(connects, 1);
  assert.equal(client.connected, null);
});

test('CodexDesktopCdpClient retries retryable desktop read requests after a CDP transport error', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let attempts = 0;
  client.ensureConnected = async () => {};
  client.evaluate = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    return { thread: { id: '019e-target' } };
  };

  const result = await client.request('thread/read', { threadId: '019e-target' });

  assert.equal(attempts, 2);
  assert.equal(result.thread.id, '019e-target');
});

test('a stale retryable failure does not close a newer concurrent CDP socket', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let attempts = 0;
  let closed = 0;
  const newerSocket = {
    readyState: WebSocket.OPEN,
    close() {
      closed += 1;
    }
  };

  const result = await client.withCdpReconnectRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      client.socket = newerSocket;
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    assert.equal(client.socket, newerSocket);
    return 'recovered';
  }, { retries: 1 });

  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(closed, 0);
});

test('a failed connection attempt does not close a newer concurrent CDP socket', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let connectCalls = 0;
  let failFirstConnection = null;
  let newerSocketClosed = 0;
  const firstSocket = {
    readyState: WebSocket.CONNECTING,
    close() {}
  };
  const newerSocket = {
    readyState: WebSocket.OPEN,
    close() {
      newerSocketClosed += 1;
    }
  };

  client.connect = async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      client.socket = firstSocket;
      await new Promise((resolve, reject) => {
        failFirstConnection = () => {
          const error = new Error('连接 Codex 桌面 CDP 失败');
          client.markDisconnected(firstSocket, error);
          reject(error);
        };
      });
      return;
    }
    client.socket = newerSocket;
  };

  const firstConnection = client.ensureConnected().catch((error) => error);
  while (!failFirstConnection) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  failFirstConnection();
  const secondConnection = client.ensureConnected().catch((error) => error);

  const [firstError, secondError] = await Promise.all([firstConnection, secondConnection]);
  assert.match(firstError.message, /连接 Codex 桌面 CDP 失败/);
  assert.match(secondError.message, /连接 Codex 桌面 CDP 失败/);
  assert.equal(connectCalls, 1);

  await client.ensureConnected();
  assert.equal(connectCalls, 2);
  assert.equal(client.socket, newerSocket);
  assert.equal(newerSocketClosed, 0);
});

test('CodexDesktopCdpClient does not retry non-idempotent turn starts', async () => {
  const client = new CodexDesktopCdpClient({ port: 51418 });
  let attempts = 0;
  client.ensureConnected = async () => {};
  client.evaluate = async () => {
    attempts += 1;
    throw new Error('Codex 桌面 CDP 连接错误');
  };

  await assert.rejects(
    () => client.request('turn/start', { threadId: '019e-target', prompt: '继续' }),
    /Codex 桌面 CDP 连接错误/
  );
  assert.equal(attempts, 1);
});

test('isRetryableCdpTransportError only matches CDP transport failures', () => {
  assert.equal(isRetryableCdpTransportError(new Error('Codex 桌面 CDP 连接错误')), true);
  assert.equal(isRetryableCdpTransportError(new Error('Codex 桌面 app-server 请求失败')), false);
});

// —— 桌面在线判定的地面真相：CDP DevTools 入口必须真实应答 ——
// 复现 2026-10-19 事故：半死桌面外壳占住监听 socket，TCP 可达但 CDP 无应答。

function startSilentPortHolder() {
  // 只接受 TCP 连接、永不回字节——等价于半死外壳占住的 9229 监听 socket。
  const server = net.createServer(() => {});
  server.listen(0, '127.0.0.1');
  return server;
}

function startHealthyCdpEndpoint() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      Browser: 'Codex/26.721.4979.0',
      'Protocol-Version': '1.3',
      'User-Agent': 'Codex',
      'V8-Version': '13.0'
    }));
  });
  server.listen(0, '127.0.0.1');
  return server;
}

async function serverPort(server) {
  if (!server.listening) {
    await once(server, 'listening');
  }
  return server.address().port;
}

test('CDP liveness marks a silent port holder as not alive', async () => {
  const server = startSilentPortHolder();
  try {
    const port = await serverPort(server);
    const startedAt = Date.now();
    const result = await probeDesktopCdpLiveness({ ports: [port], timeoutMs: 400 });
    assert.equal(result.checked, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ports, [port]);
    assert.match(result.reason, /无真实应答/);
    // 短超时必须真的生效：半死 socket 不能把判定拖成无限等待。
    assert.ok(Date.now() - startedAt < 5000, `liveness probe took ${Date.now() - startedAt}ms`);
  } finally {
    server.close();
  }
});

test('CDP liveness accepts an endpoint that truly answers /json/version', async () => {
  const server = startHealthyCdpEndpoint();
  try {
    const port = await serverPort(server);
    const result = await probeDesktopCdpLiveness({ ports: [port], timeoutMs: 2000 });
    assert.equal(result.checked, true);
    assert.equal(result.ok, true);
    assert.equal(result.port, port);
    assert.equal(result.browser, 'Codex/26.721.4979.0');
  } finally {
    server.close();
  }
});

test('CDP liveness marks connection-refused ports as not alive', async () => {
  // 先占用再释放，得到一个确定没有监听者的端口。
  const placeholder = startSilentPortHolder();
  const port = await serverPort(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));

  const result = await probeDesktopCdpLiveness({ ports: [port], timeoutMs: 2000 });
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /无真实应答/);
});

test('CDP liveness falls through dead candidates to a live one and reports no ports', async () => {
  const silent = startSilentPortHolder();
  const healthy = startHealthyCdpEndpoint();
  try {
    const deadPort = await serverPort(silent);
    const livePort = await serverPort(healthy);
    const recovered = await probeDesktopCdpLiveness({ ports: [deadPort, livePort], timeoutMs: 400 });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.port, livePort);

    const none = await probeDesktopCdpLiveness({ ports: [], timeoutMs: 400 });
    assert.equal(none.ok, false);
    assert.equal(none.checked, true);
    assert.match(none.reason, /没有可探测的 CDP 候选端口/);
  } finally {
    silent.close();
    healthy.close();
  }
});

test('CDP liveness rejects endpoints that answer with non-JSON bytes', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>not chrome devtools</html>');
  });
  server.listen(0, '127.0.0.1');
  try {
    const port = await serverPort(server);
    const result = await probeDesktopCdpLiveness({ ports: [port], timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /无法识别|无真实应答/);
  } finally {
    server.close();
  }
});
