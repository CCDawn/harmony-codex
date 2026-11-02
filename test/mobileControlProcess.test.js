import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runMobileControlProcess } from '../src/mobileControlProcess.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-control-process-test-'));
const children = new Set();
const fixtureFiles = new Set();
after(async () => {
  // PIDs are read only from this test's spawned Node parent. No name lookup,
  // process-tree kill, taskkill, or interaction with any real bridge service.
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  // Windows releases a killed process's working directory asynchronously.
  for (let attempt = 0; attempt < 40; attempt++) {
    const alive = [...children].some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const file of fixtureFiles) await fs.unlink(file).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    try { await fs.rmdir(root); break; }
    catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});
const run = (source, options = {}) => runMobileControlProcess(process.execPath, ['-e', source],
  { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...options });
async function assertGenericFailure(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, 'Mobile control process did not complete');
    assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
}
test('controller exit returns complete JSON quickly despite a descendant inheriting both stdio files', async () => {
  const record = path.join(root, 'inherited-child.json'); fixtureFiles.add(record);
  const before = performance.now();
  const result = await run(`
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true, windowsHide: true });
    fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: child.pid }));
    child.unref();
    fs.writeSync(1, JSON.stringify({ ok: true, childPid: child.pid, marker: 'complete-json' }));
    fs.writeSync(2, 'controller-stderr');
    process.exit(0);
  `);
  const elapsed = performance.now() - before;
  const ownChild = JSON.parse(await fs.readFile(record, 'utf8')).pid;
  children.add(ownChild);
  assert.equal(JSON.parse(result.stdout).childPid, ownChild);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, childPid: ownChild, marker: 'complete-json' });
  assert.equal(result.stderr, 'controller-stderr');
  assert.ok(elapsed < 2500, `Controller took ${Math.round(elapsed)}ms despite already exiting`);
  assert.doesNotThrow(() => process.kill(ownChild, 0), 'Background child must remain alive after runner cleanup');
});
test('cwd and text encoding options are preserved', async () => {
  const result = await run("require('node:fs').writeSync(1, Buffer.from(process.cwd(), 'utf16le'));", { encoding: 'utf16le' });
  assert.equal(result.stdout, root); assert.equal(result.stderr, '');
});
test('buffer encoding returns raw bytes without text conversion', async () => {
  const result = await run("require('node:fs').writeSync(1, Buffer.from([0, 255, 10]));", { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(result.stdout)); assert.deepEqual(result.stdout, Buffer.from([0, 255, 10]));
});
test('nonzero exit rejects without propagating command output', async () => {
  await assertGenericFailure(run("process.stdout.write('sensitive stdout'); process.stderr.write('sensitive stderr'); process.exitCode = 7;"));
});
test('spawn failure rejects with a fixed error', async () => {
  await assertGenericFailure(runMobileControlProcess(path.join(root, 'sensitive-missing-executable'), [], { timeout: 500, cwd: root }));
});
test('timeout kills only its controller and rejects promptly', async () => {
  const record = path.join(root, 'timeout-pids.json'); fixtureFiles.add(record);
  const before = performance.now();
  const pending = run(`
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true, windowsHide: true });
    fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: child.pid, parent: process.pid }));
    child.unref();
    setInterval(() => {}, 1000);
  `, { timeout: 1000 });
  await assertGenericFailure(pending);
  const owned = JSON.parse(await fs.readFile(record, 'utf8')); children.add(owned.pid);
  assert.ok(performance.now() - before < 3500);
  assert.throws(() => process.kill(owned.parent, 0), 'Timed-out controller must have exited');
  assert.doesNotThrow(() => process.kill(owned.pid, 0), 'Independent child must not be tree-killed');
});
test('stdout and stderr output limits reject even if the controller exits zero', async () => {
  for (const descriptor of [1, 2]) {
    await assertGenericFailure(run(`require('node:fs').writeSync(${descriptor}, Buffer.alloc(2048, 65));`, { maxBuffer: 1024 }));
  }
});
test('growing output is stopped before the controller timeout', async () => {
  const before = performance.now();
  await assertGenericFailure(run("require('node:fs').writeSync(1, Buffer.alloc(2048, 65)); setInterval(() => {}, 1000);",
    { maxBuffer: 1024, timeout: 5000 }));
  assert.ok(performance.now() - before < 2500);
});
test('runner source uses file descriptors and exact cleanup rather than descendant-sensitive pipes', async () => {
  const source = await fs.readFile(new URL('../src/mobileControlProcess.js', import.meta.url), 'utf8');
  assert.match(source, /stdio: \['ignore', stdout.fd, stderr.fd\]/);
  assert.match(source, /'wx\+', 0o600/);
  assert.match(source, /child.once\('exit'/);
  assert.doesNotMatch(source, /child.once\('close'|recursive|console\./);
  assert.match(source, /fs.unlink/); assert.match(source, /fs.rmdir/);
});
