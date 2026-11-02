import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the remote watchdog refuses foreign ownership and only retires its own parent after three failures', () => {
  const script = fileURLToPath(new URL('./voiceTunnelWatchdog.test.py', import.meta.url));
  const result = execFileSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-B', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result, '');
});

test('the SSH runner starts the bundled watchdog with a fixed identity and no arbitrary remote PID', () => {
  const runner = fs.readFileSync(new URL('../tools/harmony/run-voice-tunnel.ps1', import.meta.url), 'utf8');
  assert.match(runner, /IdentitiesOnly=yes/);
  for (const option of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no']) {
    assert.ok(runner.includes(`'-o','${option}'`), `the watchdog must own a dedicated SSH connection: ${option}`);
  }
  assert.doesNotMatch(runner, /['"]-F['"]|\b-Fnone\b/);
  assert.doesNotMatch(runner, /['"]-N['"]/);
  assert.match(runner, /voice_tunnel_watchdog\.py/);
  assert.match(runner, /exec python3 -u - --port/);
  assert.match(runner, /\$watchdog \| & \$sshExe/);
  assert.match(runner, /--port/);
  const watchdog = fs.readFileSync(new URL('../tools/harmony/voice_tunnel_watchdog.py', import.meta.url), 'utf8');
  assert.doesNotMatch(watchdog, /add_argument\(['"]--pid/);
  assert.doesNotMatch(watchdog, /SIGKILL|os\.kill\(/);
});

test('Windows PowerShell 5 sends the complete watchdog over native stdin and safely refuses unsupported pidfd', {
  skip: process.platform !== 'win32'
}, () => {
  const source = fileURLToPath(new URL('../tools/harmony/voice_tunnel_watchdog.py', import.meta.url));
  const python = process.env.PYTHON ?? 'python';
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText(${literal(source)});`
    + `$source | & ${literal(python)} -u - --port 38787;`
    + `if($LASTEXITCODE -ne 2){throw 'Expected unsupported-pidfd refusal on Windows'};exit 0`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000
  });
  assert.match(output, /voice-watchdog state=refused reason=pidfd_unavailable/);
  assert.doesNotMatch(output, /state=ready/);
});
