import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('voice repair rechecks the fault and preserves unrelated live services', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./guardianVoiceRepair.test.ps1', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const result = JSON.parse(output.trim());
  assert.equal(result.passed, 11);
  assert.equal(result.healthyCallPreserved, true);
  assert.equal(result.tunnelScopeIsolated, true);
});
