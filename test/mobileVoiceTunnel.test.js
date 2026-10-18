import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('voice tunnel recovery respects termination, persistent stop and task ownership', {
  skip: process.platform !== 'win32'
}, () => {
  const script = fileURLToPath(new URL('./mobileVoiceTunnel.test.ps1', import.meta.url));
  const result = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000
  }).trim());
  assert.equal(result.passed, 27);
  assert.equal(result.terminationRecovery, true);
  assert.equal(result.pauseResume, true);
  assert.equal(result.foreignTaskProtected, true);
  assert.equal(result.forwardHealthVerified, true);
});
