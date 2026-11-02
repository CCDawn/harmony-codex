import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`\\n  private(?: async)? ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start + 1), end = tail.slice(3).search(/\n  (?:private |@Builder|build\()/) + 3;
  return tail.slice(0, end).replace('private ', '');
}
function harness(list, runtime = {}) {
  const calls = [];
  const context = vm.createContext({ HuaweiPushRegistrationService: { configure(...args) { calls.push(args); } },
    BridgeClient: { listSessions: list, async getRuntimeSnapshot() { return runtime; }, async getSystemLinkStatus() { return {}; } } });
  vm.runInContext(stripTypeScriptTypes(`class Page { ${method('syncPushRegistration')} ${method('loadCanonicalSessionSummaries')} } globalThis.Page=Page;`, { mode: 'strip' }), context);
  const page = Object.assign(new context.Page(), { bridgeToken: 'AUTH_A', bridgeUrl: 'https://bridge-a.example',
    pushSessionSnapshotKey: '', pushThreadIds: [], sessionRuntimeStore: { mergeSessions(items) { return items; } },
    normalizedBridgeUrl() { return this.bridgeUrl; }, async loadCompanionProfile() {},
    async applyRuntimeSnapshotOutcome(promise) { await promise; }, applySystemLinkStatus() {}, log() {}, errorText(error) { return error.message; } });
  return { page, calls };
}

test('startup empty UI state never replaces stored push watches', () => {
  const h = harness(async () => []);
  h.page.syncPushRegistration();
  assert.equal(h.calls.length, 0);
});
test('a trusted matching snapshot configures push and failed refresh retains that snapshot', async () => {
  let fail = false;
  const h = harness(async () => { if (fail) throw new Error('offline'); return [{ id: 'thread-a' }]; });
  await h.page.loadCanonicalSessionSummaries('fixture');
  assert.deepEqual(Array.from(h.calls[0][2]), ['thread-a']);
  fail = true;
  await assert.rejects(h.page.loadCanonicalSessionSummaries('failed'), /offline/);
  h.page.syncPushRegistration();
  assert.deepEqual(Array.from(h.calls.at(-1)[2]), ['thread-a']);
});
test('a late snapshot from another credential cannot register old thread ids', async () => {
  const gate = Promise.withResolvers();
  const h = harness(() => gate.promise);
  const pending = h.page.loadCanonicalSessionSummaries('old');
  h.page.bridgeUrl = 'https://bridge-b.example'; h.page.bridgeToken = 'AUTH_B';
  gate.resolve([{ id: 'old-thread' }]); await pending;
  h.page.syncPushRegistration();
  assert.equal(h.calls.length, 0);
});
test('a successful authoritative empty list may clear watches', async () => {
  const h = harness(async () => []);
  await h.page.loadCanonicalSessionSummaries('empty');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][2].length, 0);
});

test('older running threads outside the first 50 and prior partial watches remain registered', async () => {
  const recent = Array.from({ length: 50 }, (_, index) => ({ id: `recent-${index}` }));
  const runtime = { stale: false, sessions: [{ threadId: 'older-running', state: 'running' }] };
  const h = harness(async () => recent, runtime);
  await h.page.loadCanonicalSessionSummaries('first');
  assert.ok(Array.from(h.calls.at(-1)[2]).includes('older-running'));
  runtime.sessions = [];
  await h.page.loadCanonicalSessionSummaries('partial');
  assert.ok(Array.from(h.calls.at(-1)[2]).includes('older-running'));
});
