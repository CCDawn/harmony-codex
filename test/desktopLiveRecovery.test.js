import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopLiveRecovery } from '../src/desktopLiveRecovery.js';

test('both recovery modes use the compatible host and preserve their script arguments', async () => {
  for (const mode of ['soft', 'hard']) {
    let dispatched;
    const recovery = new DesktopLiveRecovery({
      powershell: 'pwsh.exe', bridgeToken: 'fixture-only',
      runProcess: async (command, args, options) => {
        dispatched = { command, args, options };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    await recovery.recover({ mode, sessionId: 'thread-1', refusePlain: true });
    assert.equal(dispatched.command, 'pwsh.exe');
    assert.ok(dispatched.args.includes(mode === 'hard' ? recovery.hardScriptPath : recovery.scriptPath));
    assert.ok(dispatched.args.includes('thread-1'));
    assert.equal(dispatched.args.includes('-RefusePlainCodex'), mode === 'hard');
  }
});

test('BOM-less UTF-8 recovery script with Chinese literals executes successfully', {
  skip: process.platform !== 'win32'
}, async () => {
  const taskTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-recovery-utf8-'));
  try {
    const scriptPath = path.join(taskTemp, 'recovery.ps1');
    await fs.writeFile(scriptPath, "param([string]$BridgeUrl,[string]$BridgeToken)\nif ('恢复脚本解析成功'.Length -ne 8) { exit 1 }\nWrite-Output 'utf8-script-ok'\n", 'utf8');
    const recovery = new DesktopLiveRecovery({
      repoRoot: taskTemp, scriptPath, bridgeToken: '', powershell: 'pwsh.exe'
    });
    const result = await recovery.recover();
    assert.equal(result.exitCode, 0);
    assert.match(result.stdoutTail, /utf8-script-ok/);
  } finally { await fs.rm(taskTemp, { recursive: true, force: true }); }
});

test('a refused or failed recovery is not reported as connected', async () => {
  for (const exitCode of [1, 11]) {
    const recovery = new DesktopLiveRecovery({
      runProcess: async () => ({ exitCode, stdout: '', stderr: '' })
    });
    await assert.rejects(recovery.recover({ mode: 'hard' }));
  }
});
