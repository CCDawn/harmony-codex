import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MobilePushMonitor } from '../src/mobilePushMonitor.js';
import { MobilePushStore } from '../src/mobilePushStore.js';

const installationId = '12345678-1234-4234-8234-123456789abc';
const threadId = '22345678-1234-4234-8234-123456789abc';
const turnId = '32345678-1234-4234-8234-123456789abc';
const otherThread = '42345678-1234-4234-8234-123456789abc';

function installation(overrides = {}) {
  return { id: installationId, token: 'sample-token', enabled: true, threadIds: [threadId],
    baselineTurns: { [threadId]: [] }, ...overrides };
}

function memoryStore(installations = [installation()]) {
  const receipts = new Map();
  return {
    installations, receipts,
    async list() { return structuredClone(this.installations); },
    async claim(id, key) {
      const receiptId = JSON.stringify([id, key]);
      if (receipts.has(receiptId) || !this.installations.some(item => item.id === id && item.enabled)) return null;
      const claimId = randomUUID();
      receipts.set(receiptId, { state: 'sending', claimId });
      return claimId;
    },
    async settle(id, key, result) {
      const receiptId = JSON.stringify([id, key]);
      if (receipts.get(receiptId)?.claimId === result.claimId) receipts.set(receiptId, structuredClone(result));
    },
    async releaseUnsent(id, key, claimId) {
      const receiptId = JSON.stringify([id, key]);
      if (receipts.get(receiptId)?.state !== 'sending' || receipts.get(receiptId)?.claimId !== claimId) return false;
      return receipts.delete(receiptId);
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const subscriptions = new Map();
  const stopped = [];
  const sent = [];
  const logs = [];
  const store = options.store ?? memoryStore();
  const state = { turn: null, requests: [] };
  const monitor = new MobilePushMonitor({
    store, sender: { async send(message) { sent.push(structuredClone(message)); return { accepted: true }; } },
    readTurn: async () => state.turn,
    readRequests: async () => state.requests,
    subscribe(id, callback) {
      subscriptions.set(id, callback);
      return { stop() { subscriptions.delete(id); stopped.push(id); } };
    },
    logger: { async write(...entry) { logs.push(entry); } },
    ...options
  });
  t.after(() => monitor.close());
  return { monitor, state, store, subscriptions, stopped, sent, logs };
}

function eventId(type, ...extra) {
  return createHash('sha256').update(JSON.stringify([threadId, turnId, type, ...extra])).digest('hex');
}

test('enabled registrations own subscriptions without any phone subscriber', async t => {
  const store = memoryStore([
    installation(), installation({ id: randomUUID() }),
    installation({ id: randomUUID(), enabled: false, threadIds: [otherThread] })
  ]);
  const h = harness(t, { store });
  await h.monitor.start();
  await h.monitor.start();
  assert.deepEqual([...h.subscriptions.keys()], [threadId]);
  store.installations[0].enabled = false;
  await h.monitor.refresh();
  assert.deepEqual(h.stopped, []);
  store.installations[1].threadIds = [otherThread];
  await h.monitor.refresh();
  assert.deepEqual([...h.subscriptions.keys()], [otherThread]);
  assert.deepEqual(h.stopped, [threadId]);
  h.monitor.close();
  assert.deepEqual(h.stopped, [threadId, otherThread]);
  await h.monitor.refresh();
  assert.equal(h.subscriptions.size, 0);
});

test('a concurrent refresh rereads registrations changed after its in-flight snapshot', async t => {
  const h = harness(t);
  await h.monitor.start();
  const entered = deferred();
  const release = deferred();
  let first = true;
  h.store.list = async () => {
    const snapshot = structuredClone(h.store.installations);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  const beforeMutation = h.monitor.refresh();
  await entered.promise;
  h.store.installations[0].threadIds = [otherThread];
  const afterMutation = h.monitor.refresh();
  release.resolve();
  await Promise.all([beforeMutation, afterMutation]);
  assert.deepEqual([...h.subscriptions.keys()], [otherThread]);
  assert.deepEqual(h.stopped, [threadId]);
});

test('refresh releases a removed watch while its old desktop read is still pending', async t => {
  const entered = deferred();
  const release = deferred();
  let blocking = false;
  const h = harness(t, { readTurn: async () => {
    if (!blocking) return null;
    entered.resolve();
    return await release.promise;
  } });
  await h.monitor.start();
  blocking = true;
  const pending = h.monitor.reconcile(threadId);
  await entered.promise;
  h.store.installations.length = 0;
  await h.monitor.refresh();
  assert.deepEqual(h.stopped, [threadId]);
  release.resolve({ id: turnId, status: 'completed' });
  await pending;
  assert.equal(h.sent.length, 0);
});

test('native notification bursts coalesce and concurrent reconciles send a terminal event once', async t => {
  let reads = 0;
  let inFlight = 0;
  let maximum = 0;
  const entered = deferred();
  const release = deferred();
  const h = harness(t, { readTurn: async () => {
    reads += 1;
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    if (reads > 1) { entered.resolve(); await release.promise; }
    inFlight -= 1;
    return reads > 1 ? { id: turnId, status: 'completed' } : null;
  } });
  await h.monitor.start();
  const pending = h.monitor.reconcile(threadId);
  await entered.promise;
  const concurrent = Array.from({ length: 30 }, () => h.monitor.reconcile(threadId));
  for (let i = 0; i < 30; i += 1) h.subscriptions.get(threadId)({ notifications: ['ignored'] });
  release.resolve();
  await Promise.all([pending, ...concurrent]);
  await h.monitor.reconcile(threadId);
  assert.equal(maximum, 1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { token: 'sample-token', event: {
    type: 'completed', threadId, turnId, eventId: eventId('completed')
  } });
  assert.equal(h.sent[0].event.eventId.length, 64);
  assert.ok(reads <= 4);
});

for (const trigger of ['native notification', 'direct reconciliation']) {
  test(`completion during an old in-progress read schedules one trailing read after ${trigger}`, async t => {
    const entered = deferred();
    const release = deferred();
    let current = { id: turnId, status: 'inProgress' };
    let reads = 0;
    let inFlight = 0;
    let maximum = 0;
    const h = harness(t, { readTurn: async () => {
      const snapshot = structuredClone(current);
      reads += 1;
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      if (reads === 1) { entered.resolve(); await release.promise; }
      inFlight -= 1;
      return snapshot;
    } });
    const pending = h.monitor.start();
    await entered.promise;
    current = { id: turnId, status: 'completed' };
    const joined = [];
    for (let i = 0; i < 30; i += 1) {
      if (trigger === 'native notification') h.subscriptions.get(threadId)({ method: 'turn/completed' });
      else joined.push(h.monitor.reconcile(threadId));
    }
    release.resolve();
    await Promise.all([pending, ...joined]);
    assert.equal(reads, 2);
    assert.equal(maximum, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].event.type, 'completed');
  });
}

test('durable claims prevent duplicate delivery across observers, restart and token rotation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-push-monitor-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'push.json');
  const store = new MobilePushStore({ filePath });
  await store.upsert(installationId, { token: 'first-token', threadIds: [threadId] });
  const readTurn = async () => ({ id: turnId, status: 'completed' });
  const first = harness(t, { store, readTurn });
  const competing = harness(t, { store, readTurn });
  await Promise.all([first.monitor.start(), competing.monitor.start()]);
  assert.equal(first.sent.length + competing.sent.length, 1);
  first.monitor.close();
  competing.monitor.close();
  const restartedStore = new MobilePushStore({ filePath });
  await restartedStore.upsert(installationId, { token: 'renewed-token', threadIds: [threadId] });
  const restarted = harness(t, { store: restartedStore, readTurn });
  await restarted.monitor.start();
  assert.equal(restarted.sent.length, 0);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(saved.receipts[0].state, 'accepted');
});

test('a stale observer cannot reuse a new registration with the same timestamp and token', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-push-monitor-owner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'push.json');
  const store = new MobilePushStore({ filePath, now: () => 1_700_000_000_000 });
  await store.upsert(installationId, { token: 'shared-token', threadIds: [threadId] });
  const oldInstallation = (await store.list())[0];
  const oldCheckEntered = deferred();
  const releaseOldCheck = deferred();
  const newSenderEntered = deferred();
  const releaseNewSender = deferred();
  t.after(() => { releaseOldCheck.resolve(); releaseNewSender.resolve({ accepted: true }); });
  let oldClaimId;
  let blockOldCheck = false;
  const releases = [];
  const oldStore = {
    async list() {
      if (blockOldCheck) {
        blockOldCheck = false;
        oldCheckEntered.resolve();
        await releaseOldCheck.promise;
      }
      return await store.list();
    },
    async claim(...args) {
      const claimId = await store.claim(...args);
      if (!oldClaimId && claimId) { oldClaimId = claimId; blockOldCheck = true; }
      return claimId;
    },
    async releaseUnsent(...args) { releases.push(args); return await store.releaseUnsent(...args); },
    async settle(...args) { return await store.settle(...args); }
  };
  const readTurn = async () => ({ id: turnId, status: 'completed' });
  const oldObserver = harness(t, { store: oldStore, readTurn });
  const oldPending = oldObserver.monitor.start();
  await oldCheckEntered.promise;
  await store.remove(installationId);
  await store.upsert(installationId, { token: 'shared-token', threadIds: [threadId] });
  const newInstallation = (await store.list())[0];
  assert.equal(newInstallation.createdAt, oldInstallation.createdAt);
  assert.equal(newInstallation.token, oldInstallation.token);
  assert.equal(typeof oldInstallation.instanceId, 'string');
  assert.notEqual(newInstallation.instanceId, oldInstallation.instanceId);
  const sent = [];
  const newObserver = harness(t, { store, readTurn, sender: { async send(message) {
    sent.push(message);
    newSenderEntered.resolve();
    return await releaseNewSender.promise;
  } } });
  const newPending = newObserver.monitor.start();
  await newSenderEntered.promise;
  const before = JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0];
  assert.equal(before.state, 'sending');
  assert.notEqual(before.claimId, oldClaimId);
  releaseOldCheck.resolve();
  await oldPending;
  assert.deepEqual(releases, [[installationId, eventId('completed'), oldClaimId]]);
  await store.settle(installationId, eventId('completed'), { claimId: oldClaimId, state: 'failed' });
  const afterStaleOwner = JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0];
  assert.deepEqual(afterStaleOwner, before);
  await oldObserver.monitor.reconcile(threadId);
  assert.equal(oldObserver.sent.length, 0);
  assert.equal(sent.length, 1);
  releaseNewSender.resolve({ accepted: true });
  await newPending;
  await Promise.all([oldObserver.monitor.reconcile(threadId), newObserver.monitor.reconcile(threadId)]);
  const settled = JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0];
  assert.equal(settled.claimId, before.claimId);
  assert.equal(settled.state, 'accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'shared-token');
});

test('recent official turns retain a completed turn when a newer turn is already in progress', async t => {
  const nextTurnId = randomUUID();
  const h = harness(t);
  h.state.turn = [
    { id: turnId, status: 'completed', itemsView: 'notLoaded' },
    { id: nextTurnId, status: 'inProgress', itemsView: 'notLoaded' }
  ];
  await h.monitor.start();
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event.turnId, turnId);
  assert.equal(h.sent[0].event.type, 'completed');
});

test('an initial terminal array is fully baselined and only a later terminal notifies', async t => {
  const failedTurnId = randomUUID();
  const activeTurnId = randomUUID();
  const h = harness(t, { store: memoryStore([installation({
    baselineTurns: { [threadId]: [turnId, failedTurnId] }
  })]) });
  h.state.turn = [
    { id: turnId, status: 'completed', itemsView: 'notLoaded' },
    { id: failedTurnId, status: 'failed', itemsView: 'notLoaded' },
    { id: activeTurnId, status: 'inProgress', itemsView: 'notLoaded' }
  ];
  await h.monitor.start();
  assert.equal(h.sent.length, 0);
  h.state.turn[2].status = 'completed';
  h.state.turn.push({ id: randomUUID(), status: 'inProgress', itemsView: 'notLoaded' });
  await h.monitor.reconcile(threadId);
  await h.monitor.refresh();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event.turnId, activeTurnId);
});

test('recent-turn input requests must match the unique in-progress turn', async t => {
  const activeTurnId = randomUUID();
  const h = harness(t, { store: memoryStore([installation({ baselineTurns: { [threadId]: [turnId] } })]) });
  h.state.turn = [{ id: turnId, status: 'completed' }, { id: activeTurnId, status: 'inProgress' }];
  h.state.requests = [turnId, activeTurnId].map(id => ({
    id: `request-${id}`, method: 'item/tool/requestUserInput', params: { threadId, turnId: id }
  }));
  await h.monitor.start();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event.type, 'user_input_required');
  assert.equal(h.sent[0].event.turnId, activeTurnId);
  h.state.turn.push({ id: randomUUID(), status: 'inProgress' });
  h.state.requests[1].id = 'new-request-with-ambiguous-active-turn';
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
});

test('recent terminal facts still notify if the separate pending-request read fails', async t => {
  const h = harness(t, { readRequests: async () => { throw new Error('PRIVATE_REQUEST_FAILURE'); } });
  h.state.turn = [{ id: turnId, status: 'failed' }, { id: randomUUID(), status: 'inProgress' }];
  await h.monitor.start();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].event.type, 'failed');
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_'));
});

test('each registration baseline skips old history while later explicit completion and failure notify', async t => {
  const store = memoryStore([
    installation({ baselineTurns: { [threadId]: turnId } }),
    installation({ id: randomUUID(), token: 'second-token' })
  ]);
  const h = harness(t, { store });
  h.state.turn = { id: turnId, status: 'completed' };
  await h.monitor.start();
  assert.deepEqual(h.sent.map(item => item.token), ['second-token']);
  h.state.turn = { id: randomUUID(), status: 'completed' };
  await h.monitor.reconcile(threadId);
  h.state.turn = { id: randomUUID(), status: 'failed' };
  await h.monitor.reconcile(threadId);
  assert.deepEqual(h.sent.map(item => item.event.type), ['completed', 'completed', 'completed', 'failed', 'failed']);
});

test('unknown, idle, interrupted, missing identities and null turns never imply completion', async t => {
  const h = harness(t);
  await h.monitor.start();
  for (const turn of [null, {}, { status: 'completed' }, { id: '', status: 'completed' },
    ...['unknown', 'idle', 'interrupted', 'in_progress', undefined].map(status => ({ id: turnId, status }))]) {
    h.state.turn = turn;
    await h.monitor.reconcile(threadId);
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.receipts.size, 0);
});

test('raw pending-request identities ignore transport fields and exclude question content', async t => {
  const h = harness(t);
  h.state.turn = { id: turnId, status: 'inProgress' };
  const id = JSON.stringify(['async', turnId, 'question-item']);
  h.state.requests = [{ id, method: 'desktop/asyncUserInput', params: {
    threadId, turnId, itemId: 'question-item', questions: [{ title: 'PRIVATE_QUESTION' }]
  }, __desktopGeneration: 'random-one', ticket: 'random-one' }];
  await h.monitor.start();
  h.state.requests[0].ticket = 'random-two';
  h.state.requests[0].__desktopGeneration = 'random-two';
  h.state.requests[0].params.questions[0].title = 'CHANGED_PRIVATE_QUESTION';
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].event, { type: 'user_input_required', threadId, turnId,
    eventId: eventId('user_input_required', id) });
  assert.ok(!JSON.stringify(h.sent).includes('PRIVATE_QUESTION'));
  h.state.requests = [];
  await h.monitor.reconcile(threadId);
  h.state.requests = [{ id, method: 'desktop/asyncUserInput', params: { threadId, turnId } }];
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
});

test('only supported active-turn raw requests become input or approval events', async t => {
  const h = harness(t);
  h.state.turn = { id: turnId, status: 'inProgress' };
  const request = (method, id, params = { threadId, turnId }) => ({ id, method, params });
  h.state.requests = [
    ...['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput'].map((method, index) => request(method, index)),
    request('item/tool/requestUserInput', '0'),
    request('item/tool/requestUserInput', 'wrong-thread', { threadId: otherThread, turnId }),
    request('item/tool/requestUserInput', 'wrong-turn', { threadId, turnId: 'other-turn' }),
    request('item/tool/requestUserInput', 'missing-turn', { threadId }),
    request('item/tool/requestUserInput', null),
    request('item/tool/requestUserInput', {}),
    request('unrecognized/requestApproval', 'unsupported'),
    { ...request('item/tool/requestUserInput', 'finished'), completed: true }
  ];
  await h.monitor.start();
  assert.deepEqual(h.sent.map(item => item.event.type), [
    'approval_required', 'approval_required', 'approval_required', 'user_input_required', 'user_input_required'
  ]);
  assert.notEqual(h.sent[0].event.eventId, h.sent[4].event.eventId);
  h.state.turn.status = 'completed';
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.at(-1).event.type, 'completed');
});

test('turn and request read failures do not notify or clear prior receipts', async t => {
  let turnFailure = true;
  let requestFailure = true;
  const h = harness(t, {
    readTurn: async () => { if (turnFailure) throw new Error('PRIVATE_READ_ERROR'); return { id: turnId, status: 'inProgress' }; },
    readRequests: async () => {
      if (requestFailure) throw new Error('PRIVATE_REQUEST_ERROR');
      return [{ id: 1, method: 'item/tool/requestUserInput', params: { threadId, turnId } }];
    }
  });
  await h.monitor.start();
  turnFailure = false;
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 0);
  requestFailure = false;
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  requestFailure = true;
  await h.monitor.reconcile(threadId);
  requestFailure = false;
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  assert.equal(h.store.receipts.size, 1);
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_'));
});

for (const action of ['close', 'remove', 'disable', 'rotate', 'unwatch']) {
  test(`a late turn read after ${action} cannot send using its old registration`, async t => {
    const entered = deferred();
    const release = deferred();
    const h = harness(t, { readTurn: async () => { entered.resolve(); return await release.promise; } });
    const pending = h.monitor.start();
    await entered.promise;
    if (action === 'close') h.monitor.close();
    if (action === 'remove') h.store.installations.length = 0;
    if (action === 'disable') h.store.installations[0].enabled = false;
    if (action === 'rotate') h.store.installations[0].token = 'rotated-token';
    if (action === 'unwatch') h.store.installations[0].threadIds.length = 0;
    release.resolve({ id: turnId, status: 'completed' });
    await pending;
    assert.equal(h.sent.length, 0);
    assert.equal(h.store.receipts.size, 0);
  });
}

test('token rotation during claim releases an unsent receipt and the new token receives the event once', async t => {
  const store = memoryStore();
  const claim = store.claim.bind(store);
  const entered = deferred();
  const release = deferred();
  let firstClaim = true;
  store.claim = async (...args) => {
    const claimed = await claim(...args);
    if (firstClaim) { firstClaim = false; entered.resolve(); await release.promise; }
    return claimed;
  };
  const h = harness(t, { store, readTurn: async () => ({ id: turnId, status: 'completed' }) });
  const pending = h.monitor.start();
  await entered.promise;
  store.installations[0].token = 'rotated-during-claim';
  release.resolve();
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(store.receipts.size, 0);
  await h.monitor.reconcile(threadId);
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].token, 'rotated-during-claim');
  assert.equal([...store.receipts.values()][0].state, 'accepted');
});

test('close during claim releases only the receipt whose sender has not been called', async t => {
  const store = memoryStore();
  const claim = store.claim.bind(store);
  const entered = deferred();
  const release = deferred();
  store.claim = async (...args) => {
    const claimed = await claim(...args);
    entered.resolve();
    await release.promise;
    return claimed;
  };
  const h = harness(t, { store, readTurn: async () => ({ id: turnId, status: 'completed' }) });
  const pending = h.monitor.start();
  await entered.promise;
  h.monitor.close();
  release.resolve();
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(store.receipts.size, 0);
});

test('failed release keeps its sending receipt and cannot cause an automatic retry', async t => {
  const store = memoryStore();
  const claim = store.claim.bind(store);
  store.claim = async (...args) => {
    const claimed = await claim(...args);
    store.installations[0].token = 'rotated-token';
    return claimed;
  };
  store.releaseUnsent = async () => { throw new Error('PRIVATE_RELEASE_ERROR'); };
  const h = harness(t, { store, readTurn: async () => ({ id: turnId, status: 'completed' }) });
  await h.monitor.start();
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 0);
  assert.equal([...store.receipts.values()][0].state, 'sending');
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_'));
});

test('a late pending-request read after close cannot send', async t => {
  const entered = deferred();
  const release = deferred();
  const h = harness(t, {
    readTurn: async () => ({ id: turnId, status: 'inProgress' }),
    readRequests: async () => { entered.resolve(); return await release.promise; }
  });
  const pending = h.monitor.start();
  await entered.promise;
  h.monitor.close();
  release.resolve([{ id: 1, method: 'item/tool/requestUserInput', params: { threadId, turnId } }]);
  await pending;
  assert.equal(h.sent.length, 0);
});

test('durable claim failure prevents sending and settlement failure keeps the claim deduplicated', async t => {
  const store = memoryStore();
  const claim = store.claim.bind(store);
  let failClaim = true;
  store.claim = async (...args) => {
    if (failClaim) throw new Error('PRIVATE_PERSISTENCE_ERROR');
    return await claim(...args);
  };
  store.settle = async () => { throw new Error('PRIVATE_SETTLEMENT_ERROR'); };
  const h = harness(t, { store, readTurn: async () => ({ id: turnId, status: 'completed' }) });
  await h.monitor.start();
  assert.equal(h.sent.length, 0);
  failClaim = false;
  await h.monitor.reconcile(threadId);
  await h.monitor.reconcile(threadId);
  assert.equal(h.sent.length, 1);
  assert.equal([...store.receipts.values()][0].state, 'sending');
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_'));
});

test('failed, uncertain and unconfirmed deliveries are never retried on the next reconciliation', async t => {
  for (const outcome of ['failed', 'uncertain', 'unconfirmed']) {
    let attempts = 0;
    let releases = 0;
    const store = memoryStore();
    const releaseUnsent = store.releaseUnsent.bind(store);
    store.releaseUnsent = async (...args) => { releases += 1; return await releaseUnsent(...args); };
    const h = harness(t, {
      store,
      readTurn: async () => ({ id: turnId, status: 'completed' }),
      sender: { async send() {
        attempts += 1;
        if (outcome === 'unconfirmed') return undefined;
        throw Object.assign(new Error('PRIVATE_PROVIDER_BODY_sample-token'), {
          deliveryUncertain: outcome === 'uncertain', code: 'PRIVATE_PROVIDER_BODY_sample-token'
        });
      } }
    });
    await h.monitor.start();
    await h.monitor.reconcile(threadId);
    await h.monitor.refresh();
    assert.equal(attempts, 1);
    assert.equal(releases, 0);
    assert.equal([...h.store.receipts.values()][0].state, outcome === 'failed' ? 'failed' : 'uncertain');
    assert.ok(!JSON.stringify([...h.store.receipts.values(), h.logs]).includes('PRIVATE_'));
    h.monitor.close();
  }
});

test('the fallback timer reconciles without native notifications and close stops its work', async t => {
  const delivered = deferred();
  let reads = 0;
  const h = harness(t, { intervalMs: 10,
    readTurn: async () => { reads += 1; return reads > 1 ? { id: turnId, status: 'completed' } : null; },
    sender: { async send(message) { delivered.resolve(message); return { accepted: true }; } }
  });
  await h.monitor.start();
  let timeout;
  const message = await Promise.race([delivered.promise, new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('fallback did not reconcile')), 2000);
  })]).finally(() => clearTimeout(timeout));
  assert.equal(message.event.type, 'completed');
  h.monitor.close();
  const atClose = reads;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(reads, atClose);
});
