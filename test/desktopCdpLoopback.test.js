import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as cdp from '../src/codexDesktopCdpClient.js';

async function endpoint(t, host, handler, port = 0) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only: host === '::1' }, resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('liveness finds a CDP endpoint listening only on IPv6 loopback', async t => {
  const port = await endpoint(t, '::1', (request, response) => {
    assert.equal(request.url, '/json/version');
    json(response, { Browser: 'synthetic-ipv6-cdp' });
  });
  const result = await cdp.probeDesktopCdpLiveness({ ports: [port], timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.port, port);
  assert.equal(result.browser, 'synthetic-ipv6-cdp');
});

test('target discovery falls back to IPv6 and /json/list without changing target selection or Origin', async t => {
  let port;
  const paths = [];
  port = await endpoint(t, '::1', (request, response) => {
    paths.push(request.url);
    if (request.url === '/json') return json(response, { unavailable: true });
    json(response, [
      { type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay', webSocketDebuggerUrl: 'ws://overlay' },
      { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://[::1]:${port}/devtools/page/main` }
    ]);
  });
  const targets = await cdp.getCdpTargets(port, 500);
  assert.match(cdp.selectCodexDesktopCdpTarget(targets).webSocketDebuggerUrl, /\[::1\]/);
  assert.deepEqual(paths, ['/json', '/json/list']);
  assert.equal(cdp.buildDesktopCdpWebSocketOptions(port, {}).headers.Origin, `http://127.0.0.1:${port}`);
});

test('the desktop client connects through an IPv6-only target while retaining its Origin', async t => {
  let port;
  port = await endpoint(t, '::1', (_request, response) => json(response, [
    { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://[::1]:${port}/devtools/page/main` }
  ]));
  const NativeWebSocket = globalThis.WebSocket;
  let connection;
  globalThis.WebSocket = class {
    constructor(url, protocols, options) {
      connection = { url, options };
      queueMicrotask(() => this.onopen());
    }
    close() {}
  };
  t.after(() => { globalThis.WebSocket = NativeWebSocket; });
  const client = new cdp.CodexDesktopCdpClient({ port, timeoutMs: 500 });
  client.enableRuntimeIfAvailable = async () => {};
  client.installNotificationCollector = async () => {};
  await client.connect();
  t.after(() => client.close());
  assert.equal(connection.url, `ws://[::1]:${port}/devtools/page/main`);
  assert.equal(connection.options.headers.Origin, `http://127.0.0.1:${port}`);
  assert.equal(client.port, port);
});

test('IPv4 remains preferred when both loopbacks answer on the configured port', async t => {
  let ipv6Requests = 0;
  const port = await endpoint(t, '::1', (_request, response) => {
    ipv6Requests++;
    json(response, { Browser: 'ipv6' });
  });
  await endpoint(t, '127.0.0.1', (_request, response) => json(response, { Browser: 'ipv4' }), port);
  const result = await cdp.probeDesktopCdpLiveness({ ports: [port], timeoutMs: 500 });
  assert.equal(result.browser, 'ipv4');
  assert.equal(ipv6Requests, 0);
});

test('a stalled IPv4 listener leaves time for IPv6 within the same liveness budget', async t => {
  const port = await endpoint(t, '::1', (_request, response) => json(response, { Browser: 'ipv6' }));
  await endpoint(t, '127.0.0.1', () => {}, port);
  const started = Date.now();
  const result = await cdp.probeDesktopCdpLiveness({ ports: [port], timeoutMs: 400 });
  assert.equal(result.ok, true);
  assert.equal(result.browser, 'ipv6');
  assert.ok(Date.now() - started < 750, 'loopback fallback must share the existing timeout budget');
});

test('PowerShell soft recovery discovers an isolated IPv6-only main target and preserves process ownership',
  { skip: process.platform !== 'win32' }, async t => {
    let port;
    port = await endpoint(t, '::1', (_request, response) => json(response, [
      { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://[::1]:${port}/devtools/page/main` }
    ]));
    const scriptPath = fileURLToPath(new URL('./desktopCdpSoftRecovery.test.ps1', import.meta.url));
    const { stdout } = await promisify(execFile)(process.env.CODEX_TEST_POWERSHELL ?? 'powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-CdpPort', String(port)
    ], { timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    assert.ok(result.passed >= 11);
    assert.equal(result.realServicesTouched, false);
  });
