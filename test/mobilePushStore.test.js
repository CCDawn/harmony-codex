import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MobilePushStore } from '../src/mobilePushStore.js';

const installationId = '12345678-1234-4234-8234-123456789abc';
const threadId = '22345678-1234-4234-8234-123456789abc';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-push-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'push.json');
  return { filePath, store: new MobilePushStore({ filePath, ...options }) };
}

test('registration persists deduplicated UUID watches and returns isolated internal snapshots', async t => {
  const { store, filePath } = await fixture(t, { now: () => 1_700_000_000_000 });
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId, threadId.toUpperCase()] });
  const listed = await store.list();
  assert.equal(listed[0].id, installationId);
  assert.equal(listed[0].token, 'sample-token');
  assert.equal(listed[0].enabled, true);
  assert.deepEqual(listed[0].threadIds, [threadId]);
  listed[0].threadIds.length = 0;
  listed[0].token = 'changed';
  const reloaded = new MobilePushStore({ filePath });
  assert.equal((await reloaded.list())[0].token, 'sample-token');
  assert.deepEqual((await store.list())[0].threadIds, [threadId]);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).schemaVersion, 1);
});

test('installation instance identity survives token rotation and changes on re-registration with a fixed clock', async t => {
  const now = () => 1_700_000_000_000;
  const { store, filePath } = await fixture(t, { now });
  const original = await store.upsert(installationId, { token: 'old-token', threadIds: [threadId] });
  assert.equal(typeof original.instanceId, 'string');
  const rotated = await store.upsert(installationId, { token: 'rotated-token', threadIds: [threadId] });
  assert.equal(rotated.instanceId, original.instanceId);
  assert.equal((await new MobilePushStore({ filePath, now }).list())[0].instanceId, original.instanceId);
  await store.remove(installationId);
  const replacement = await store.upsert(installationId, { token: 'rotated-token', threadIds: [threadId] });
  assert.equal(replacement.createdAt, original.createdAt, 'the clock cannot distinguish these registrations');
  assert.notEqual(replacement.instanceId, original.instanceId);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).installations[0].instanceId, replacement.instanceId);
  assert.equal((await new MobilePushStore({ filePath, now }).list())[0].instanceId, replacement.instanceId);
});

test('legacy installations use a stable installation ID fallback for instance identity', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'old-token', threadIds: [threadId] });
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  delete persisted.installations[0].instanceId;
  await fs.writeFile(filePath, JSON.stringify(persisted));
  const first = new MobilePushStore({ filePath });
  const second = new MobilePushStore({ filePath });
  assert.equal((await first.list())[0].instanceId, installationId);
  assert.equal((await second.list())[0].instanceId, installationId);
  const rotated = await first.upsert(installationId, { token: 'rotated-token', threadIds: [threadId] });
  assert.equal(rotated.instanceId, installationId);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).installations[0].instanceId, installationId);
});

test('concurrent claim allows exactly one sender only after durable sending receipt', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId] });
  const claims = await Promise.all(Array.from({ length: 30 }, () => store.claim(installationId, 'event-one')));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(typeof claims.find(Boolean), 'string');
  assert.equal(claims.filter(value => value === null).length, 29);
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(persisted.receipts.length, 1);
  assert.equal(persisted.receipts[0].state, 'sending');
  assert.equal(persisted.receipts[0].eventKey, 'event-one');
  assert.equal(persisted.receipts[0].claimId, claims.find(Boolean));
});

test('an old owner cannot release or settle a new claim after removal and registration', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'old-token', threadIds: [threadId] });
  const oldClaimId = await store.claim(installationId, 'same-event');
  assert.equal(typeof oldClaimId, 'string');
  await store.remove(installationId);
  await store.upsert(installationId, { token: 'new-token', threadIds: [threadId] });
  const newClaimId = await store.claim(installationId, 'same-event');
  assert.equal(typeof newClaimId, 'string');
  assert.notEqual(newClaimId, oldClaimId);
  assert.equal(await store.releaseUnsent(installationId, 'same-event', oldClaimId), false);
  assert.equal(await store.settle(installationId, 'same-event', { claimId: oldClaimId, state: 'failed' }), null);
  assert.equal(await store.claim(installationId, 'same-event'), null);
  const receipt = await store.settle(installationId, 'same-event', { claimId: newClaimId, state: 'accepted' });
  assert.equal(receipt.claimId, newClaimId);
  assert.equal(receipt.state, 'accepted');
  assert.equal(await new MobilePushStore({ filePath }).claim(installationId, 'same-event'), null);
});

test('persisted claim ownership survives restart and rejects mismatched owners', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId] });
  const claimId = await store.claim(installationId, 'owned-event');
  assert.equal(typeof claimId, 'string');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0].claimId, claimId);
  const restarted = new MobilePushStore({ filePath });
  assert.equal(await restarted.claim(installationId, 'owned-event'), null);
  assert.equal(await restarted.releaseUnsent(installationId, 'owned-event', randomUUID()), false);
  assert.equal(await restarted.settle(installationId, 'owned-event', { claimId: randomUUID(), state: 'accepted' }), null);
  const receipt = await restarted.settle(installationId, 'owned-event', { claimId, state: 'uncertain' });
  assert.equal(receipt.claimId, claimId);
  assert.equal(receipt.state, 'uncertain');
  assert.equal(await restarted.releaseUnsent(installationId, 'owned-event', claimId), false);
});

test('legacy receipts without claim IDs stay consumed and cannot be released or settled', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId] });
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const at = new Date().toISOString();
  persisted.receipts = ['sending', 'accepted', 'failed', 'uncertain'].map(state => ({
    installationId, eventKey: `legacy-${state}`, state, createdAt: at, updatedAt: at
  }));
  await fs.writeFile(filePath, JSON.stringify(persisted));
  const restarted = new MobilePushStore({ filePath });
  for (const state of ['sending', 'accepted', 'failed', 'uncertain']) {
    const eventKey = `legacy-${state}`;
    assert.equal(await restarted.claim(installationId, eventKey), null);
    assert.equal(await restarted.releaseUnsent(installationId, eventKey, randomUUID()), false);
    assert.equal(await restarted.settle(installationId, eventKey, { claimId: randomUUID(), state: 'accepted' }), null);
  }
  await restarted.upsert(installationId, { token: 'rotated-token', threadIds: [threadId] });
  const after = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(after.receipts.map(({ state }) => state), ['sending', 'accepted', 'failed', 'uncertain']);
  assert.equal(await new MobilePushStore({ filePath }).claim(installationId, 'legacy-sending'), null);
});

test('multiple terminal baselines normalize legacy strings and keep every existing terminal ID', async t => {
  const { store, filePath } = await fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  const future = randomUUID();
  await store.upsert(installationId, { token: 'first-token', threadIds: [threadId],
    baselineTurns: { [threadId]: [first, second, first.toUpperCase()] } });
  assert.deepEqual((await store.list())[0].baselineTurns[threadId], [first, second]);
  const restarted = new MobilePushStore({ filePath });
  await restarted.upsert(installationId, { token: 'renewed-token', threadIds: [threadId],
    baselineTurns: { [threadId]: [future] } });
  assert.deepEqual((await restarted.list())[0].baselineTurns[threadId], [first, second]);
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  persisted.installations[0].baselineTurns[threadId] = first;
  await fs.writeFile(filePath, JSON.stringify(persisted));
  assert.deepEqual((await new MobilePushStore({ filePath }).list())[0].baselineTurns[threadId], [first]);
  persisted.installations[0].baselineTurns[threadId] = '';
  await fs.writeFile(filePath, JSON.stringify(persisted));
  assert.deepEqual((await new MobilePushStore({ filePath }).list())[0].baselineTurns[threadId], []);
  await assert.rejects(store.upsert(installationId, { token: 'sample-token', threadIds: [threadId],
    baselineTurns: { [threadId]: Array.from({ length: 101 }, randomUUID) } }), { statusCode: 400 });
});

test('an unsent claim is released durably so a rotated token can claim after restart', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'old-token', threadIds: [threadId] });
  const claimId = await store.claim(installationId, 'unsent-event');
  assert.equal(typeof claimId, 'string');
  await store.upsert(installationId, { token: 'new-token', threadIds: [threadId] });
  assert.equal(await store.releaseUnsent(installationId, 'unsent-event', claimId), true);
  assert.equal(await store.releaseUnsent(installationId, 'unsent-event', claimId), false);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')).receipts, []);
  const restarted = new MobilePushStore({ filePath });
  assert.equal((await restarted.list())[0].token, 'new-token');
  const newClaimId = await restarted.claim(installationId, 'unsent-event');
  assert.equal(typeof newClaimId, 'string');
  assert.notEqual(newClaimId, claimId);
  assert.equal(await new MobilePushStore({ filePath }).claim(installationId, 'unsent-event'), null);
});

test('releaseUnsent only removes sending and preserves every settled receipt across restart', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId] });
  const claimIds = new Map();
  for (const state of ['sending', 'accepted', 'failed', 'uncertain']) {
    const claimId = await store.claim(installationId, `event-${state}`);
    assert.equal(typeof claimId, 'string');
    claimIds.set(state, claimId);
    if (state !== 'sending') await store.settle(installationId, `event-${state}`, { claimId, state });
  }
  for (const state of ['accepted', 'failed', 'uncertain']) {
    assert.equal(await store.releaseUnsent(installationId, `event-${state}`, claimIds.get(state)), false);
  }
  assert.equal(await store.releaseUnsent(randomUUID(), 'event-sending', claimIds.get('sending')), false);
  assert.equal(await store.releaseUnsent(installationId, 'missing-event', claimIds.get('sending')), false);
  const released = await Promise.all(Array.from({ length: 10 }, () => store.releaseUnsent(installationId, 'event-sending', claimIds.get('sending'))));
  assert.equal(released.filter(Boolean).length, 1);
  const restarted = new MobilePushStore({ filePath });
  for (const state of ['accepted', 'failed', 'uncertain']) {
    assert.equal(await restarted.claim(installationId, `event-${state}`), null);
  }
  assert.equal(typeof await restarted.claim(installationId, 'event-sending'), 'string');
});

test('an unsuccessful unsent release keeps the claim and allows later persistence recovery', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [threadId] });
  const claimId = await store.claim(installationId, 'unsent-event');
  assert.equal(typeof claimId, 'string');
  await fs.rm(filePath);
  await fs.mkdir(filePath);
  await assert.rejects(store.releaseUnsent(installationId, 'unsent-event', claimId));
  assert.equal(await store.claim(installationId, 'unsent-event'), null);
  await fs.rmdir(filePath);
  assert.equal(await store.releaseUnsent(installationId, 'unsent-event', claimId), true);
  assert.equal(typeof await new MobilePushStore({ filePath }).claim(installationId, 'unsent-event'), 'string');
});

test('baseline turns persist atomically only for new watches and survive token renewal', async t => {
  const { store, filePath } = await fixture(t);
  const secondThread = randomUUID();
  const baseline = randomUUID();
  const laterTurn = randomUUID();
  await store.upsert(installationId, { token: 'first-token', threadIds: [threadId], baselineTurns: { [threadId]: baseline } });
  let persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(persisted.installations[0].baselineTurns, { [threadId]: [baseline] });
  const restarted = new MobilePushStore({ filePath });
  await restarted.upsert(installationId, { token: 'renewed-token', threadIds: [threadId, secondThread],
    baselineTurns: { [threadId]: laterTurn, [secondThread]: '' } });
  assert.deepEqual((await restarted.list())[0].baselineTurns, { [threadId]: [baseline], [secondThread]: [] });
  await restarted.upsert(installationId, { token: 'renewed-token', threadIds: [secondThread] });
  persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(persisted.installations[0].baselineTurns, { [secondThread]: [] });
  await assert.rejects(restarted.upsert(installationId, { token: 'renewed-token', threadIds: [threadId],
    baselineTurns: { [threadId]: 'invalid-turn-id' } }), { statusCode: 400 });
  assert.deepEqual((await restarted.list())[0].threadIds, [secondThread]);
});

test('restart and token rotation preserve sending, uncertain, accepted and failed dedupe receipts', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'old-token', threadIds: [threadId] });
  for (const state of ['sending', 'uncertain', 'accepted', 'failed']) {
    const claimId = await store.claim(installationId, `event-${state}`);
    assert.equal(typeof claimId, 'string');
    if (state !== 'sending') await store.settle(installationId, `event-${state}`, { claimId, state, code: '80000000' });
  }
  const restarted = new MobilePushStore({ filePath });
  await restarted.upsert(installationId, { token: 'rotated-token', threadIds: [threadId] });
  for (const state of ['sending', 'uncertain', 'accepted', 'failed']) {
    assert.equal(await restarted.claim(installationId, `event-${state}`), null);
  }
  assert.equal((await restarted.list())[0].token, 'rotated-token');
  assert.equal(typeof await restarted.claim(installationId, 'new-event'), 'string');
});

test('disabled and removed installations cannot claim and late settlement cannot resurrect them', async t => {
  const { store, filePath } = await fixture(t);
  assert.equal(await store.claim(installationId, 'missing'), null);
  await store.upsert(installationId, { token: 'private-removable-token', threadIds: [threadId] });
  const claimId = await store.claim(installationId, 'in-flight');
  assert.equal(typeof claimId, 'string');
  await store.upsert(installationId, { token: 'private-removable-token', threadIds: [threadId], enabled: false });
  assert.equal(await store.claim(installationId, 'disabled'), null);
  assert.deepEqual(await store.remove(installationId), { changed: true });
  assert.deepEqual(await store.remove(installationId), { changed: false });
  assert.equal(await store.settle(installationId, 'in-flight', { claimId, state: 'accepted' }), null);
  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readFile(filePath, 'utf8')).includes('private-removable-token'), false);
});

test('validations reject invalid UUIDs, controls, huge tokens and too many watches without reflecting input', async t => {
  const { store } = await fixture(t);
  const invalid = [
    ['not-a-uuid', { token: 'sample', threadIds: [threadId] }],
    [installationId, { token: '', threadIds: [threadId] }],
    [installationId, { token: '   ', threadIds: [threadId] }],
    [installationId, { token: 'sensitive\nvalue', threadIds: [threadId] }],
    [installationId, { token: 'sensitive\u0085value', threadIds: [threadId] }],
    [installationId, { token: 's'.repeat(8193), threadIds: [threadId] }],
    [installationId, { token: 'sensitive-value', threadIds: ['not-a-thread'] }],
    [installationId, { token: 'sample', threadIds: Array.from({ length: 101 }, randomUUID) }],
    [installationId, { token: 'sample', threadIds: [threadId], enabled: 'false' }]
  ];
  for (const [id, input] of invalid) {
    await assert.rejects(store.upsert(id, input), error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    });
  }
  await store.upsert(installationId, { token: 's'.repeat(8192), threadIds: [] });
  assert.equal((await store.list())[0].token.length, 8192);
  await assert.rejects(store.claim(installationId, 'event\nkey'), { statusCode: 400 });
  await assert.rejects(store.settle(installationId, 'event', { state: 'sending' }), { statusCode: 400 });
});

test('settlement requires a claimed event and cannot downgrade a definitive receipt', async t => {
  const { store } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [] });
  assert.equal(await store.settle(installationId, 'missing', { claimId: randomUUID(), state: 'accepted' }), null);
  const claimId = await store.claim(installationId, 'event');
  const accepted = await store.settle(installationId, 'event', { claimId, state: 'accepted', code: '80000000' });
  assert.equal(accepted.state, 'accepted');
  assert.equal((await store.settle(installationId, 'event', { claimId, state: 'uncertain' })).state, 'accepted');
});

test('failed writes reject, keep committed memory and allow subsequent operations to recover', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'committed-token', threadIds: [threadId] });
  // The destination directory makes atomic rename fail on all supported platforms.
  await fs.rm(filePath);
  await fs.mkdir(filePath);
  await assert.rejects(store.upsert(installationId, { token: 'uncommitted-token', threadIds: [] }));
  assert.equal((await store.list())[0].token, 'committed-token');
  await assert.rejects(store.claim(installationId, 'event-write-failed'));
  await fs.rmdir(filePath);
  assert.equal(typeof await store.claim(installationId, 'event-write-failed'), 'string');
  const restarted = new MobilePushStore({ filePath });
  assert.equal(await restarted.claim(installationId, 'event-write-failed'), null);
});

test('corrupt or unknown-schema stores fail closed instead of losing dedupe history', async t => {
  const { filePath } = await fixture(t);
  for (const raw of ['{"secret":"invalid-json', '{"schemaVersion":2,"installations":[],"receipts":[]}',
    '{"schemaVersion":1,"installations":[],"receipts":[{"state":"unknown"}]}']) {
    await fs.writeFile(filePath, raw);
    const store = new MobilePushStore({ filePath });
    await assert.rejects(store.list(), error => {
      assert.equal(error.code, 'MOBILE_PUSH_STORE_INVALID');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});

test('receipt retention stays bounded while preserving in-flight and uncertain claims', async t => {
  const { store, filePath } = await fixture(t);
  await store.upsert(installationId, { token: 'sample-token', threadIds: [] });
  const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  data.receipts = Array.from({ length: 1000 }, (_, index) => ({
    installationId, eventKey: `old-${index}`, state: index === 0 ? 'sending' : index === 1 ? 'uncertain' : 'accepted',
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index).toISOString()
  }));
  await fs.writeFile(filePath, JSON.stringify(data));
  const restarted = new MobilePushStore({ filePath });
  assert.equal(typeof await restarted.claim(installationId, 'new-event'), 'string');
  const updated = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(updated.receipts.length, 1000);
  assert.equal(updated.receipts.some(item => item.eventKey === 'old-0'), true);
  assert.equal(updated.receipts.some(item => item.eventKey === 'old-1'), true);
  assert.equal(updated.receipts.some(item => item.eventKey === 'old-2'), false);
  updated.receipts.forEach(item => { item.state = 'sending'; });
  await fs.writeFile(filePath, JSON.stringify(updated));
  const full = new MobilePushStore({ filePath });
  assert.equal(await full.claim(installationId, 'cannot-evict-active'), null);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).receipts.length, 1000);
});
