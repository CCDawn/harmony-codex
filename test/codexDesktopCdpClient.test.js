import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDesktopCdpWebSocketOptions,
  CodexDesktopCdpClient,
  extractConversationIdFromDesktopThreadKey,
  extractConversationIdFromPath,
  isRetryableCdpTransportError,
  resolveDesktopCdpPort,
  resolveDesktopCdpPortCandidates,
  selectCodexDesktopCdpTarget
} from '../src/codexDesktopCdpClient.js';

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

test('resolveDesktopCdpPort ignores non-injected desktop live status files', () => {
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
    }), 9229);
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
