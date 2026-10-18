import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/agent/doctor.ps1', import.meta.url));

async function doctor(t, { coreOnline, desktopLive }) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/desktop/live/status') {
      response.end(JSON.stringify({ desktop: { desktopLive, status: desktopLive ? 'ready' : 'offline' } }));
    } else if (!coreOnline) {
      response.writeHead(503).end('{}');
    } else if (request.url.startsWith('/codex/sessions')) {
      response.end('{"sessions":[]}');
    } else {
      response.end('{"ok":true}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-BridgeUrl', `http://127.0.0.1:${server.address().port}`, '-BridgeToken', 'doctor-fixture',
    '-HdcPath', '<unset>', '-ConfigPath', `${script}.missing-fixture`, '-Json'], { timeout: 20000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

test('doctor cannot report success while bridge and sessions are unavailable', { skip: process.platform !== 'win32' }, async t => {
  const result = await doctor(t, { coreOnline: false, desktopLive: false });
  assert.equal(result.ok, false);
});

test('a reachable desktop status endpoint with an offline body is a warning', { skip: process.platform !== 'win32' }, async t => {
  const result = await doctor(t, { coreOnline: true, desktopLive: false });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find(check => check.id === 'cdp').status, 'warn');
});

test('doctor accepts a healthy core and an explicitly ready desktop channel', { skip: process.platform !== 'win32' }, async t => {
  const result = await doctor(t, { coreOnline: true, desktopLive: true });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find(check => check.id === 'cdp').status, 'ok');
});
