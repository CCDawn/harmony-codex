import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InterruptJournal } from '../src/interruptJournal.js';

test('unresolved stops survive restart, concurrent writes and removal without persisting conversation data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-journal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'stops.json');
  const journal = new InterruptJournal(file);
  const record = { operationId: 'one', threadId: 'thread', turnId: '', state: 'requested', requestedAt: new Date().toISOString(), prompt: 'private text' };
  await Promise.all([journal.load(), journal.put(record), journal.put({ ...record, operationId: 'two' })]);
  await journal.put({ ...record, turnId: 'turn', state: 'writing' });
  const restored = await new InterruptJournal(file).load();
  assert.equal(restored.length, 2);
  assert.equal(restored.find(entry => entry.operationId === 'one').turnId, 'turn');
  assert.equal((await fs.readFile(file, 'utf8')).includes('private text'), false);
  await journal.remove('one');
  assert.deepEqual((await new InterruptJournal(file).load()).map(entry => entry.operationId), ['two']);
});

test('corrupt or incompatible stop journals fail recovery instead of losing pending intent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-journal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'stops.json');
  await fs.writeFile(file, '{bad json');
  await assert.rejects(new InterruptJournal(file).load());
  await fs.writeFile(file, JSON.stringify({ version: 9, records: [] }));
  await assert.rejects(new InterruptJournal(file).load(), /Invalid stop journal/);
});
