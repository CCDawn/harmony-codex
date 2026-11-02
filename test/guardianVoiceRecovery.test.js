import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoiceTunnelFault, summarizeMobileLink } from '../tools/windows/mobile-link-diagnostics.mjs';
import { decideGuardian } from '../tools/windows/mobile-link-guardian-policy.mjs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ready = [{ id: 'voice_transport', state: 'ready' }, { id: 'voice_public', state: 'ready' }];

test('a reachable public voice route overrides a stopped scheduler snapshot', () => {
  for (const state of ['Ready', 'Disabled', 'forward-failed', 'connection-failed']) {
    assert.deepEqual(classifyVoiceTunnelFault({ voiceState: state, checks: ready }), []);
    const summary = summarizeMobileLink({ paused: false, checks: ready,
      voiceTunnel: { configured: true, running: false, state } });
    assert.equal(summary.checks.find(c => c.id === 'voice').state, 'ready');
    assert.notEqual(summary.nextAction, 'safe_repair');
  }
});

test('a failed tunnel can only authorize tunnel recovery, never media-process termination', () => {
  const faults = classifyVoiceTunnelFault({ voiceState: 'Ready', checks: [] });
  assert.deepEqual(faults, [{ id: 'voice_tunnel', kind: 'transport', repairable: true, component: 'voice_tunnel' }]);
  const result = decideGuardian({ config: { enabled: true, allowForceRestart: true },
    state: { failures: 2, attempts: 2 }, diagnostics: { guardianSignals: { faults } } });
  assert.deepEqual(result.action, { stage: 'restart_services', components: ['voice_tunnel'] });
});

test('unknown ownership and unknown scheduler states never authorize destructive recovery', () => {
  for (const voiceState of ['binding-error', 'Missing', 'unexpected-state']) {
    const faults = classifyVoiceTunnelFault({ voiceState, checks: [] });
    assert.equal(faults[0].repairable, false);
    const result = decideGuardian({ config: { enabled: true }, state: { failures: 2 },
      diagnostics: { guardianSignals: { faults } } });
    assert.equal(result.action, null);
    assert.equal(result.status.phase, 'needs_attention');
  }
  for (const voiceState of ['', 'Running', 'unverified', 'not-configured']) {
    assert.deepEqual(classifyVoiceTunnelFault({ voiceState, checks: [] }), []);
  }
});

test('real execution-time CLI performs probes and does not repair a reachable route', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-voice-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const directory of ['src', 'tools/windows', 'HarmonyCodexRemote/entry/src/main/ets/config']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.copyFile(new URL('../tools/windows/mobile-link-diagnostics.mjs', import.meta.url), path.join(root, 'tools/windows/mobile-link-diagnostics.mjs'));
  await fs.copyFile(new URL('../src/totp.js', import.meta.url), path.join(root, 'src/totp.js'));
  let upgrades = 0;
  let rejectVoice = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/voice/status' ? { voice: { enabled: true } } : { sessions: [] }));
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    upgrades++;
    socket.on('error', () => {});
    if (rejectVoice) { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', () => socket.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await fs.writeFile(path.join(root, 'HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets'),
      `export const DEFAULT_BRIDGE_URL: string = 'http://127.0.0.1:${port}';\n`);
    const run = async () => {
      const { stdout } = await promisify(execFile)(process.execPath,
        [path.join(root, 'tools/windows/mobile-link-diagnostics.mjs'), '--port', String(port), '--voice-repair-json', '--voice-state', 'Ready'],
        { windowsHide: true, timeout: 10000 });
      return JSON.parse(stdout);
    };
    const healthy = await run();
    assert.equal(upgrades, 2);
    assert.deepEqual(healthy.guardianSignals.faults, []);
    assert.ok(healthy.checks.some(c => c.id === 'voice_public' && c.state === 'ready'));
    rejectVoice = true;
    const failed = await run();
    assert.ok(failed.guardianSignals.faults.some(f => f.id === 'voice_transport' && f.component === 'voice' && f.repairable));
    assert.ok(failed.guardianSignals.faults.some(f => f.id === 'voice_tunnel' && f.component === 'voice_tunnel'));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
