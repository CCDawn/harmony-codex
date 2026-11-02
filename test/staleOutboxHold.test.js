import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableOutbox, compactOutboxResult } from '../src/durableOutbox.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T06:00:00Z');
const iso = value => new Date(value).toISOString();

function item(id, age, overrides = {}) {
  return {
    id, kind: 'existing_thread', threadId: 'thread-a', projectId: 'probe',
    submissionId: `submission-${id}`, text: `正文 ${id}`, order: Number(id) || 1,
    payload: { text: `正文 ${id}`, attachments: [{ id: `attachment-${id}` }] },
    status: 'queued', createdAt: iso(NOW - age), updatedAt: iso(NOW - age),
    lastAttemptAt: '', nextAttemptAt: '', retryable: true,
    result: null, resultId: '', ...overrides
  };
}

async function fixture(t, items, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stale-outbox-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  await fs.writeFile(filePath, JSON.stringify({ version: 1, items }));
  const calls = [];
  const box = new DurableOutbox({ filePath, schedule: false, now: () => NOW,
    dispatch: async candidate => { calls.push(candidate); return { id: `run-${candidate.id}` }; },
    ...options });
  t.after(() => box.close());
  return { box, calls, filePath };
}

test('four historical entries are held while two recent entries dispatch in FIFO order', async t => {
  const historical = [
    item('1', 4 * DAY, { status: 'uncertain', lastAttemptAt: iso(NOW - 4 * DAY),
      updatedAt: iso(NOW), result: { run: { id: 'old-task' } }, resultId: 'old-task' }),
    ...['2', '3', '4'].map(id => item(id, 3 * DAY))
  ];
  const recent = [item('5', 60_000), item('6', 30_000)];
  const { box, calls, filePath } = await fixture(t, [...historical, ...recent]);
  await box.initialize();
  for (const original of historical) {
    const held = box.get(original.id);
    assert.equal(held.status, 'held');
    assert.match(held.error, /超过24小时.*暂停自动发送.*核对后重试/);
    for (const field of ['id', 'submissionId', 'text', 'payload', 'resultId']) {
      assert.deepEqual(held[field], original[field]);
    }
    assert.deepEqual(held.result, compactOutboxResult(original.result, original));
  }
  assert.equal(box.list({ includeTerminal: false }).length, 6);
  await box.dispatchReady();
  await box.dispatchReady();
  assert.deepEqual(calls.map(candidate => candidate.id), ['5', '6']);
  assert.deepEqual(calls.map(candidate => candidate.submissionId), recent.map(candidate => candidate.submissionId));
  const restored = new DurableOutbox({ filePath, schedule: false, now: () => NOW,
    dispatch: async candidate => { calls.push(candidate); return { id: 'manual-run' }; } });
  await restored.initialize();
  assert.deepEqual(historical.map(original => restored.get(original.id).status), Array(4).fill('held'));
  await assert.rejects(restored.update('1', { text: 'must not change uncertain identity' }), { statusCode: 409 });
  await restored.retry('1');
  await restored.dispatchReady();
  assert.equal(restored.get('1').status, 'submitted');
  assert.equal(calls.at(-1).submissionId, historical[0].submissionId);
  assert.deepEqual(calls.at(-1).payload, historical[0].payload);
  await restored.cancel('2');
  assert.equal(restored.get('2').status, 'canceled');
});

test('recent uncertain item retains FIFO blocking and no automatic resend', async t => {
  const { box, calls } = await fixture(t, [item('1', DAY - 1, { status: 'uncertain',
    lastAttemptAt: iso(NOW - DAY + 1) }), item('2', 1000)], {
    reconcile: async () => ({ status: 'uncertain', retryable: true })
  });
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'uncertain');
  assert.equal(box.get('2').blockedBy, '1');
  assert.equal(box.get('2').updatedAt, iso(NOW - 1000));
  assert.equal(calls.length, 0);
});

test('blocked polling cannot refresh queued age and invalid attempt time falls back to creation', async t => {
  let now = NOW;
  const { box, calls } = await fixture(t, [item('1', DAY - 50, { status: 'uncertain',
    lastAttemptAt: 'invalid' }), item('2', DAY - 50)], {
    now: () => now, blockedDelayMs: 250, canDispatch: async () => false,
    reconcile: async () => ({ status: 'uncertain' })
  });
  await box.dispatchReady();
  now += 100;
  await box.dispatchReady();
  assert.deepEqual(box.list().map(candidate => candidate.status), ['held', 'held']);
  assert.equal(calls.length, 0);
});

test('runtime blocking cannot postpone stale hold and manual update refreshes queued review time', async t => {
  let now = NOW;
  const { box, calls } = await fixture(t, [item('1', DAY - 50), item('2', 3 * DAY)], {
    now: () => now, canDispatch: async () => false
  });
  await box.initialize();
  await box.retry('2');
  await box.update('2', { text: '复核后的正文' });
  await box.dispatchReady();
  assert.equal(box.get('1').updatedAt, iso(NOW - DAY + 50));
  now += 100;
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'held');
  assert.equal(box.get('2').status, 'queued');
  box.canDispatch = async () => true;
  now += 2000;
  await box.dispatchReady();
  assert.deepEqual(calls.map(candidate => candidate.id), ['2']);
});

test('held entries survive pruning and submitted history is never held', async t => {
  const history = Array.from({ length: 51 }, (_, index) => item(String(index + 1), 3 * DAY));
  const { box, calls } = await fixture(t, [...history, item('100', 9 * DAY, { status: 'submitted' })], { maxItems: 50 });
  await box.initialize();
  assert.equal(box.list().filter(candidate => candidate.status === 'held').length, 51);
  assert.equal(calls.length, 0);
  const submitted = await fixture(t, [item('1', 9 * DAY, { status: 'submitted' })]);
  await submitted.box.initialize();
  assert.equal(submitted.box.get('1').status, 'submitted');
});

test('held receipts settle only on submitted and explicit retry checks receipt before sending', async t => {
  let receipt = { status: 'uncertain', error: 'still unknown' };
  const { box, calls } = await fixture(t, [item('1', 4 * DAY, { status: 'uncertain' })], {
    reconcile: async () => receipt
  });
  await box.initialize();
  assert.equal(box.get('1').status, 'held');
  receipt = { status: 'submitted', result: { id: 'official-receipt' } };
  await box.retry('1');
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'submitted');
  assert.equal(box.get('1').resultId, 'official-receipt');
  assert.equal(calls.length, 0);
});

test('stale reconcile cannot overwrite a hold or a same-clock retry and fresh uncertain result', async t => {
  let now = NOW;
  const { box } = await fixture(t, [item('1', 1000, { status: 'uncertain' })], {
    now: () => now, staleAfterMs: 2000,
    dispatch: async () => { throw Object.assign(new Error('new uncertain delivery'), { deliveryUncertain: true }); }
  });
  await box.initialize();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  box.reconcile = async () => { started.resolve(); return reply.promise; };
  const pending = box.reconcileUncertainItems();
  await started.promise;
  box.reconcile = null;
  now += 3000;
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'held');
  await box.retry('1');
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'uncertain');
  reply.resolve({ status: 'submitted', result: { id: 'stale-receipt' } });
  await pending;
  assert.equal(box.get('1').status, 'uncertain');
  assert.equal(box.get('1').error, 'new uncertain delivery');
});

test('same-clock ABA retry invalidates an in-flight uncertain reconciliation', async t => {
  const { box } = await fixture(t, [item('1', 0, { status: 'uncertain', lastAttemptAt: iso(NOW) })], {
    dispatch: async () => { throw Object.assign(new Error('fresh uncertain'), { deliveryUncertain: true }); }
  });
  await box.initialize();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  box.reconcile = async () => { started.resolve(); return reply.promise; };
  const pending = box.reconcileUncertainItems();
  await started.promise;
  box.reconcile = null;
  await box.retry('1');
  await box.dispatchReady();
  reply.resolve({ status: 'submitted', result: { id: 'old' } });
  await pending;
  assert.equal(box.get('1').status, 'uncertain');
  assert.equal(box.get('1').error, 'fresh uncertain');
});

test('cancel invalidates an in-flight held retry receipt read', async t => {
  const { box, calls } = await fixture(t, [item('1', 3 * DAY)]);
  await box.initialize();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  box.reconcile = async () => { started.resolve(); return reply.promise; };
  const retrying = box.retry('1');
  await started.promise;
  await box.cancel('1');
  reply.resolve({ status: 'submitted', result: { id: 'late' } });
  await retrying;
  await box.dispatchReady();
  assert.equal(box.get('1').status, 'canceled');
  assert.equal(calls.length, 0);
});

test('cancel during canDispatch does not resurrect or send queued item', async t => {
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const { box, calls } = await fixture(t, [item('1', 0)], {
    canDispatch: async () => { started.resolve(); return reply.promise; }
  });
  const pending = box.dispatchReady();
  await started.promise;
  await box.cancel('1');
  reply.resolve(true);
  await pending;
  assert.equal(box.get('1').status, 'canceled');
  assert.equal(calls.length, 0);
});

test('canceling a later held item while an earlier receipt is loading skips the canceled item', async t => {
  const { box } = await fixture(t, [item('1', 3 * DAY), item('2', 3 * DAY)]);
  await box.initialize();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const reads = [];
  box.reconcile = async candidate => {
    reads.push(candidate.id);
    started.resolve();
    return reply.promise;
  };
  const pending = box.reconcileUncertainItems();
  await started.promise;
  await box.cancel('2');
  reply.resolve({ status: 'submitted', result: { id: 'first-receipt' } });
  await pending;
  assert.deepEqual(reads, ['1']);
  assert.equal(box.get('2').status, 'canceled');
});
