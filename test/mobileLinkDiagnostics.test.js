import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectMobileLink, summarizeMobileLink } from '../tools/windows/mobile-link-diagnostics.mjs';

const profile = { id: 'bear', roomId: 'room' };
test('refreshes probe credentials for follow-up reads after a time-window change', async () => {
  let window = 1;
  const captured = [];
  const base = server();
  await inspectMobileLink({
    baseUrl: 'http://127.0.0.1:1234',
    headers: { 'X-Codex-Bridge-OTP': 'window-1' },
    getHeaders: () => ({ 'X-Codex-Bridge-OTP': 'window-' + window }),
    fetchImpl: async (url, options) => {
      captured.push({ url, otp: options.headers['X-Codex-Bridge-OTP'] });
      const response = await base(url, options);
      if (url.endsWith('/companion/profile')) window = 2;
      return response;
    }
  });
  const followUps = captured.filter(call => call.url.includes('/companion/messages')
    || call.url.includes('/companion/computer/status'));
  assert.equal(followUps.length, 2);
  assert.ok(followUps.every(call => call.otp === 'window-2'));
});
test('CLI failure remains a complete unknown status without exposing input or error text', () => {
  const script = new URL('../tools/windows/mobile-link-diagnostics.mjs', import.meta.url);
  const child = spawnSync(process.execPath, [fileURLToPath(script), '--port', 'private-sentinel'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.severity, 'unknown');
  assert.equal(result.nextAction, 'check_logs');
  assert.equal(result.failureStage, 'arguments');
  assert.equal(result.checks[0].state, 'unknown');
  assert.equal((child.stdout + child.stderr).includes('private-sentinel'), false);
  assert.equal((child.stdout + child.stderr).includes('Invalid bridge port'), false);
});
function server(overrides = {}, calls = []) {
  const replies = {
    '/health': { ok: true, runtime: { mode: 'desktop' } },
    '/desktop/live/status': { desktop: { desktopLive: true } },
    '/codex/sessions?limit=1': { sessions: [] },
    '/companion/profile': { profile },
    '/companion/messages?profileId=bear&roomId=room': { entries: [] },
    '/companion/computer/status?assistantId=bear&roomId=room': {
      assistantId: 'bear', roomId: 'room', ready: true, threadId: 'thread', environmentId: 'cloud'
    }, ...overrides
  };
  return async (url, options) => {
    const route = url.replace('http://127.0.0.1:1234', '');
    calls.push({ route, method: options.method || 'GET' });
    const body = replies[route];
    if (body instanceof Error) throw body;
    const status = typeof body === 'number' ? body : 200;
    return { ok: status === 200, status, json: async () => body };
  };
}
async function inspect(overrides = {}, calls = []) {
  return inspectMobileLink({ baseUrl: 'http://127.0.0.1:1234', fetchImpl: server(overrides, calls) });
}
function summarize(diagnostics, overrides = {}) {
  return summarizeMobileLink({ paused: false, checks: diagnostics.checks,
    voiceTunnel: { configured: true, running: true }, ...overrides });
}

test('read-only diagnostics cannot declare send, speech or desktop control verified', async () => {
  const calls = [];
  const result = summarize(await inspect({}, calls));
  assert.equal(result.severity, 'unverified');
  assert.match(result.summary, /仍需验证/);
  assert.equal(result.checks.find(c => c.id === 'voice').state, 'unverified');
  assert.match(result.checks.find(c => c.id === 'computer').message, /进入后验证/);
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.ok(calls.every(c => !c.route.includes('/sessions') || c.route.startsWith('/codex/')));
});

test('healthy bridge cannot conceal missing desktop port and failed business reads', async () => {
  const result = summarize(await inspect({
    '/desktop/live/status': { desktop: { desktopLive: false, failureClass: 'codex_plain_no_cdp' } },
    '/codex/sessions?limit=1': 500, '/companion/profile': 502
  }));
  assert.equal(result.severity, 'degraded');
  assert.equal(result.nextAction, 'desktop_restart_required');
  assert.match(result.summary, /Codex 桌面连接.*普通会话.*个人助手/);
  assert.equal(result.checks.find(c => c.id === 'bridge').state, 'ready');
  assert.match(result.checks.find(c => c.id === 'sessions').message, /本机 Codex 远程接口未就绪/);
  assert.match(result.checks.find(c => c.id === 'companion').message, /本机 Codex 远程接口未就绪/);
});

test('business failures do not invent a local desktop outage when desktop is connected', async () => {
  const result = await inspect({ '/codex/sessions?limit=1': 500, '/companion/profile': 502 });
  assert.equal(result.checks.find(c => c.id === 'sessions').message, '请求失败（HTTP 500）');
  assert.equal(result.checks.find(c => c.id === 'companion').message, '请求失败（HTTP 502）');
});

test('assistant probes have a longer timeout budget while local probes stay fast', async () => {
  const calls = [];
  const baseFetch = server();
  const slowRoutes = new Set(['/health', '/companion/profile',
    '/companion/messages?profileId=bear&roomId=room',
    '/companion/computer/status?assistantId=bear&roomId=room']);
  const fetchImpl = async (url, options) => {
    const route = url.replace('http://127.0.0.1:1234', '');
    calls.push(route);
    if (slowRoutes.has(route)) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        const abort = () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return baseFetch(url, options);
  };
  const result = await inspectMobileLink({ baseUrl: 'http://127.0.0.1:1234', fetchImpl,
    timeoutMs: 8, assistantTimeoutMs: 80 });

  assert.equal(result.checks.find(c => c.id === 'bridge').state, 'error');
  assert.equal(result.checks.find(c => c.id === 'bridge').message, '请求超时');
  assert.equal(result.checks.find(c => c.id === 'companion').state, 'ready');
  assert.equal(result.checks.find(c => c.id === 'computer').state, 'ready');
  assert.ok(calls.includes('/health'));
  assert.ok(calls.includes('/companion/profile'));
  assert.ok(calls.includes('/companion/messages?profileId=bear&roomId=room'));
  assert.ok(calls.includes('/companion/computer/status?assistantId=bear&roomId=room'));
});

test('diagnostics distinguish timeouts from request exceptions without exposing raw errors', async () => {
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';
  const result = await inspect({ '/companion/profile': timeout, '/codex/sessions?limit=1': Error('private network detail') });
  assert.equal(result.checks.find(c => c.id === 'companion').message, '请求超时');
  assert.equal(result.checks.find(c => c.id === 'sessions').message, '请求异常');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result.restartRequired, false);
});

test('successful HTTP replies with missing payloads remain failures', async () => {
  const result = summarize(await inspect({ '/codex/sessions?limit=1': { ok: true },
    '/companion/messages?profileId=bear&roomId=room': { ok: true } }));
  assert.equal(result.severity, 'degraded');
  assert.equal(result.checks.find(c => c.id === 'sessions').state, 'error');
  assert.equal(result.checks.find(c => c.id === 'companion').state, 'error');
});

test('failed profile prevents follow-up requests with an invalid assistant binding', async () => {
  const calls = [];
  const result = await inspect({ '/companion/profile': 502 }, calls);
  assert.equal(calls.length, 4);
  assert.equal(result.checks.find(c => c.id === 'computer').state, 'unknown');
});

test('cloud computer must belong to the requested assistant and room', async () => {
  const result = await inspect({ '/companion/computer/status?assistantId=bear&roomId=room': {
    assistantId: 'other-assistant', roomId: 'room', ready: true, threadId: 'thread', environmentId: 'cloud'
  } });
  assert.equal(result.checks.find(c => c.id === 'computer').state, 'error');
});

test('a stopped link is reported as stopped even when the voice task is intentionally off', async () => {
  const result = summarize(await inspect(), { paused: true, voiceTunnel: { configured: true, running: false } });
  assert.equal(result.severity, 'stopped');
  assert.equal(result.nextAction, 'start');
});

test('voice task failure degrades status while a dormant cloud environment remains waiting', async () => {
  const result = summarize(await inspect({ '/companion/computer/status?assistantId=bear&roomId=room': {
    assistantId: 'bear', roomId: 'room', ready: false
  } }), { voiceTunnel: { configured: true, running: false } });
  assert.equal(result.severity, 'degraded');
  assert.match(result.summary, /语音/);
  assert.equal(result.checks.find(c => c.id === 'computer').state, 'waiting');
});

test('running task with a remote forwarding failure is reported as a tunnel failure', async () => {
  const result = summarize(await inspect(), { voiceTunnel: {
    configured: true, running: false, taskRunning: true, state: 'forward-failed'
  } });
  const voice = result.checks.find(c => c.id === 'voice');
  assert.equal(result.severity, 'degraded');
  assert.equal(result.nextAction, 'check_logs');
  assert.equal(voice.state, 'error');
  assert.match(voice.message, /远端端口转发被拒绝/);
});

test('diagnostics CLI preserves the concrete voice tunnel state from its argument', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const configDirectory = path.join(root, 'HarmonyCodexRemote/entry/src/main/ets/config');
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.mkdir(path.join(root, 'tools/windows'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(configDirectory, 'BridgeConfig.ets'),
    "export const DEFAULT_BRIDGE_TOKEN: string = 'mock-diagnostics-token';\n");
  await fs.copyFile(new URL('../tools/windows/mobile-link-diagnostics.mjs', import.meta.url), path.join(root, 'tools/windows/mobile-link-diagnostics.mjs'));
  await fs.copyFile(new URL('../src/totp.js', import.meta.url), path.join(root, 'src/totp.js'));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = url.pathname === '/health' ? { ok: true, runtime: { mode: 'desktop' } }
      : url.pathname === '/desktop/live/status' ? { desktop: { desktopLive: true } }
        : url.pathname === '/codex/sessions' ? { sessions: [] }
          : url.pathname === '/companion/profile' ? { profile }
            : url.pathname === '/companion/messages' ? { entries: [] }
              : url.pathname === '/companion/computer/status' ? {
                assistantId: 'bear', roomId: 'room', ready: false
              } : {};
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const script = path.join(root, 'tools/windows/mobile-link-diagnostics.mjs');
    const port = String(server.address().port);
    const child = spawn(process.execPath, [script, '--port', port, '--voice-state', 'forward-failed'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout);
    const voice = result.checks.find(check => check.id === 'voice');
    assert.equal(voice.state, 'error');
    assert.match(voice.message, /远端端口转发被拒绝/);
    assert.equal(result.nextAction, 'check_logs');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a running task without enough evidence to verify forwarding remains unknown', async () => {
  const result = summarize(await inspect(), { voiceTunnel: {
    configured: true, running: false, taskRunning: true, state: 'unverified'
  } });
  const voice = result.checks.find(c => c.id === 'voice');
  assert.equal(result.severity, 'unknown');
  assert.equal(voice.state, 'unknown');
  assert.match(voice.message, /无法确认 SSH 转发/);
});

test('exceptions and server bodies cannot expose secrets in diagnostic output', async () => {
  const secret = 'sensitive-master-token';
  const result = await inspect({ '/health': Error(`Failed token=${secret}`),
    '/companion/profile': { error: secret }, '/codex/sessions?limit=1': 401 });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.checks.find(c => c.id === 'sessions').message, '请求失败（HTTP 401）');
});

test('health checks require the expected runtime mode instead of any successful HTTP response', async () => {
  const result = await inspect({ '/health': { ok: true, runtime: { mode: 'app-server-primary' } } });
  assert.equal(result.checks.find(c => c.id === 'bridge').state, 'error');
});
