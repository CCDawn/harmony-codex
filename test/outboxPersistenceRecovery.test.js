import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableOutbox } from '../src/durableOutbox.js';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-lock-regression-'));
  const outbox = new DurableOutbox({ filePath: path.join(dir, 'queue.json'), dispatch: async () => ({}), schedule: false, ...options });
  await outbox.initialize();
  await outbox.persist();
  t.after(async () => { outbox.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return outbox;
}

test('temporary Windows rename lock is retried without replacing the target non-atomically', async t => {
  const outbox = await fixture(t);
  const originalRename = fs.rename;
  let calls = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('sharing lock'), { code: 'EPERM' });
    return originalRename(...args);
  });
  await outbox.persist();
  assert.equal(calls, 3);
  assert.equal(JSON.parse(await fs.readFile(outbox.filePath, 'utf8')).version, 1);
});

test('exhausted rename retries reject but preserve the file and allow a later persist', async t => {
  const outbox = await fixture(t);
  const before = await fs.readFile(outbox.filePath, 'utf8');
  let attempts = 0;
  const rename = t.mock.method(fs, 'rename', async () => {
    attempts += 1;
    throw Object.assign(new Error('sharing lock'), { code: 'EPERM' });
  });
  await assert.rejects(outbox.persist(), { code: 'EPERM' });
  assert.ok(attempts > 1 && attempts <= 6);
  assert.equal(await fs.readFile(outbox.filePath, 'utf8'), before);
  rename.mock.restore();
  await outbox.persist();
});

test('unrelated filesystem errors fail immediately and do not poison subsequent writes', async t => {
  const outbox = await fixture(t);
  let calls = 0;
  const rename = t.mock.method(fs, 'rename', async () => {
    calls += 1;
    throw Object.assign(new Error('invalid operation'), { code: 'EINVAL' });
  });
  await assert.rejects(outbox.persist(), { code: 'EINVAL' });
  assert.equal(calls, 1);
  rename.mock.restore();
  await outbox.persist();
});

test('a scheduled dispatch failure is caught and logged instead of killing the bridge', async t => {
  let logged;
  const observed = new Promise(resolve => { logged = resolve; });
  const outbox = await fixture(t, { logger: { write: async (...args) => { logged(args); } } });
  t.mock.method(outbox, 'dispatchReady', async () => { throw Object.assign(new Error('sharing lock'), { code: 'EPERM' }); });
  outbox.scheduleEnabled = true;
  outbox.scheduleNext(0);
  const result = await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error('no dispatch error log')), 500))]);
  assert.equal(result[2], 'outbox.dispatch.failed');
  assert.equal(result[3].code, 'EPERM');
});
