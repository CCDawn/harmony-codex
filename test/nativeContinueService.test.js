import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NativeContinueService, NativeContinueJournal } from '../src/nativeContinueService.js';
import { nativeContinueStatus } from '../src/nativeContinueEligibility.js';

const threadId = 'thread-1', expectedTurnId = 'turn-1';
const snapshot = (status = 'interrupted', error = null, extra = {}) => ({ thread: {
  id: threadId, status: { type: 'idle' }, goal: null,
  turns: [{ id: expectedTurnId, status, error }], ...extra
} });

test('eligibility mirrors native interrupted/retryable errors and blocks active, goals and quota errors', () => {
  assert.deepEqual(nativeContinueStatus(snapshot(), threadId), {
    threadId, turnId: expectedTurnId, canContinue: true, reason: 'interrupted', state: 'interrupted'
  });
  for (const info of ['serverOverloaded', 'internalServerError', { httpConnectionFailed: {} },
    { responseStreamConnectionFailed: {} }, { responseStreamDisconnected: {} }, { responseTooManyFailedAttempts: {} }]) {
    assert.equal(nativeContinueStatus(snapshot('failed', { codexErrorInfo: info }), threadId).canContinue, true);
  }
  for (const message of ['Model is temporarily unavailable', "stream disconnected before completion: we're currently processing too many requests"]) {
    assert.equal(nativeContinueStatus(snapshot('failed', { codexErrorInfo: 'other', message }), threadId).canContinue, true);
  }
  for (const message of ['Model is temporarily unavailable: quota exhausted', 'stream disconnected', 'billing credits exhausted']) {
    assert.equal(nativeContinueStatus(snapshot('failed', { codexErrorInfo: 'other', message }), threadId).canContinue, false);
  }
  assert.equal(nativeContinueStatus(snapshot('interrupted', null, { status: { type: 'active' } }), threadId).reason, 'active');
  assert.equal(nativeContinueStatus(snapshot('interrupted', null, { goal: { status: 'paused' } }), threadId).reason, 'goal_present');
  assert.equal(nativeContinueStatus(snapshot('inProgress'), threadId).reason, 'active');
  assert.equal(nativeContinueStatus(snapshot('completed'), threadId).canContinue, false);
  assert.equal(nativeContinueStatus(snapshot('interrupted', null, { id: 'wrong' }), threadId).canContinue, false);
});

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-continue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reads = 0, writes = 0, current = snapshot();
  const client = {
    async readContinueSnapshot(id) { assert.equal(id, threadId); reads++; return current; },
    async continueTurn(id, turn) { assert.equal(id, threadId); assert.equal(turn, expectedTurnId); writes++;
      return { threadId, turnId: 'turn-2', canContinue: false, reason: 'active', state: 'active', active: true }; }, ...overrides
  };
  const journal = new NativeContinueJournal(path.join(root, 'operations.json'));
  const service = new NativeContinueService({ client, journal });
  return { service, journal, client, root, setSnapshot(value) { current = value; },
    get reads() { return reads; }, get writes() { return writes; } };
}

test('parallel same-operation requests join once and persisted results survive service recreation', async t => {
  const h = await fixture(t), operationId = randomUUID();
  const input = { operationId, expectedTurnId };
  const results = await Promise.all(Array.from({ length: 8 }, () => h.service.continue(threadId, input)));
  assert.equal(h.writes, 1);
  assert.ok(results.every(value => value.state === 'confirmed' && value.turnId === 'turn-2' && value.active));
  const recovered = new NativeContinueService({ client: h.client, journal: new NativeContinueJournal(h.journal.filePath) });
  assert.deepEqual(await recovered.continue(threadId, input), results[0]);
  assert.equal(h.writes, 1);
});

test('stale expected turn, goal and active state reject without native writes', async t => {
  const h = await fixture(t);
  for (const value of [snapshot('interrupted', null, { turns: [{ id: 'new-turn', status: 'interrupted' }] }),
    snapshot('interrupted', null, { goal: { status: 'active' } }), snapshot('inProgress')]) {
    h.setSnapshot(value);
    const result = await h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId });
    assert.equal(result.state, 'rejected');
  }
  assert.equal(h.writes, 0);
});

test('a confirmed newer turn prevents another operation against the same base even if a later snapshot lags', async t => {
  const h = await fixture(t);
  assert.equal((await h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId })).state, 'confirmed');
  const second = await h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId });
  assert.equal(second.state, 'rejected'); assert.equal(second.reason, 'stale_turn');
  assert.equal(second.turnId, 'turn-2'); assert.equal(h.writes, 1);
  assert.equal((await h.service.getStatus(threadId)).canContinue, false);
});

test('lost write acknowledgement persists uncertainty and neither repeated nor new IDs blindly resend', async t => {
  let writes = 0;
  const h = await fixture(t, { async continueTurn() { writes++; throw Object.assign(new Error('transport'), { continueWriteAttempted: true }); } });
  const operationId = randomUUID();
  assert.equal((await h.service.continue(threadId, { operationId, expectedTurnId })).state, 'uncertain');
  assert.equal((await h.service.continue(threadId, { operationId, expectedTurnId })).state, 'uncertain');
  const recovered = new NativeContinueService({ client: h.client, journal: new NativeContinueJournal(h.journal.filePath) });
  assert.equal((await recovered.continue(threadId, { operationId, expectedTurnId })).state, 'uncertain');
  const blocked = await recovered.continue(threadId, { operationId: randomUUID(), expectedTurnId });
  assert.equal(blocked.reason, 'uncertain_operation');
  assert.equal(writes, 1);
});

test('crash writing record is uncertain and operation identity cannot be reused for another turn', async t => {
  const h = await fixture(t), operationId = randomUUID();
  await h.journal.put({ operationId, threadId, expectedTurnId, requestedAt: new Date().toISOString(), state: 'writing' });
  assert.equal((await h.service.continue(threadId, { operationId, expectedTurnId })).state, 'uncertain');
  await assert.rejects(h.service.continue(threadId, { operationId, expectedTurnId: 'other' }), { statusCode: 409 });
  assert.equal(h.writes, 0);
});

test('different operations for one thread serialize and revalidate after the previous native start', async t => {
  let writes = 0, h;
  const hold = Promise.withResolvers();
  h = await fixture(t, { async continueTurn() { writes++; await hold.promise;
    h.setSnapshot(snapshot('inProgress', null, { turns: [{ id: 'turn-2', status: 'inProgress' }] }));
    return { turnId: 'turn-2', active: true, reason: 'active', canContinue: false }; } });
  const first = h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId });
  while (!writes) await new Promise(resolve => setImmediate(resolve));
  const second = h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId });
  hold.resolve();
  assert.equal((await first).state, 'confirmed');
  assert.equal((await second).state, 'rejected');
  assert.equal(writes, 1);
});

test('invalid operation IDs are rejected and an atomic journal write failure prevents dispatch', async t => {
  const h = await fixture(t);
  await assert.rejects(h.service.continue(threadId, { operationId: 'bad', expectedTurnId }), { statusCode: 400 });
  h.journal.put = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(h.service.continue(threadId, { operationId: randomUUID(), expectedTurnId }));
  assert.equal(h.writes, 0);
});

test('a transient replaced lease retries only the read, while a persistent read failure remains unavailable', async t => {
  let reads = 0, contexts = 0;
  const unavailable = () => Object.assign(new Error('DESKTOP_INTERACTIONS_UNAVAILABLE'), {
    code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503, stage: 'mounted-manager'
  });
  const h = await fixture(t, { async readContinueSnapshot() { if (++reads === 1) throw unavailable(); return snapshot(); },
    async readContinueContext() { if (++contexts === 1) throw unavailable(); return { id: threadId, goal: null }; } });
  assert.equal((await h.service.getStatus(threadId)).canContinue, true);
  assert.equal(reads, 2); assert.equal(h.writes, 0);
  assert.equal((await h.service.readContext(threadId)).id, threadId);
  assert.equal(contexts, 2); assert.equal(h.writes, 0);
  let failures = 0;
  h.client.readContinueSnapshot = async () => { failures++; throw unavailable(); };
  await assert.rejects(h.service.getStatus(threadId), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503, stage: 'mounted-manager' });
  assert.equal(failures, 2);
});

test('compatibility or ambiguous-host errors are not retried and uncertain writes remain single dispatch', async t => {
  for (const stage of ['renderer', 'mounted-manager-ambiguous', 'mounted-manager-scan-timeout']) {
    let attempts = 0;
    const h = await fixture(t, { async readContinueSnapshot() { attempts++; throw Object.assign(new Error('unavailable'), {
      code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage
    }); } });
    await assert.rejects(h.service.getStatus(threadId));
    assert.equal(attempts, 1); assert.equal(h.writes, 0);
  }
});
