import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/HuaweiPushRegistrationService.ets', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export class', 'class');
const PHONE_ID = '11111111-2222-4333-8444-555555555555';
const THREAD_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const THREAD_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const READY = { version: 1, configured: true, setup: 'ready', registration: { id: PHONE_ID, registered: true, ready: true, threadCount: 1 } };
const fingerprint = (url, token) => createHash('sha256').update(JSON.stringify([url, token])).digest('hex');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(predicate(), 'expected asynchronous lifecycle checkpoint');
}
async function settle() { for (let attempt = 0; attempt < 15; attempt++) await new Promise(resolve => setImmediate(resolve)); }

function harness(options = {}) {
  const data = options.data || new Map();
  const events = [], registrations = [], removals = [], writes = [], listeners = new Set(), storage = new Map();
  let tokenCalls = 0, deleteCalls = 0, uuidCalls = 0, remoteReady = false, remoteThreads = [];
  const prefs = {
    async get(key, fallback) { if (options.read) await options.read(key); return data.has(key) ? data.get(key) : fallback; },
    async put(key, value) { writes.push([key, value]); data.set(key, value); }, async flush() {}
  };
  const sdk = {
    on(type, ability, listener) { assert.equal(type, 'tokenUpdate'); listeners.add(listener); events.push('on'); },
    off(type, listener) { assert.equal(type, 'tokenUpdate'); listeners.delete(listener); events.push('off'); },
    async getToken() { const call = ++tokenCalls; events.push('get:' + call); return options.getToken ? await options.getToken(call) : 'native-' + call; },
    async deleteToken() { deleteCalls++; events.push('native-delete'); if (options.deleteToken) await options.deleteToken(deleteCalls); }
  };
  const BridgeClient = {
    async registerMobilePush(url, auth, id, token, threads) {
      const entry = { url, auth, id, token, threads: Array.from(threads) }; registrations.push(entry); events.push('register:' + url);
      return options.register ? await options.register(entry, registrations.length) : READY;
    },
    async unregisterMobilePush(url, auth, id) {
      const entry = { url, auth, id }; removals.push(entry); events.push('remove:' + url);
      if (options.remove) await options.remove(entry, removals.length);
    }
  };
  const cryptoFramework = { createMd(algorithm) {
    assert.equal(algorithm, 'SHA256'); const hash = createHash('sha256');
    return { async update(blob) { hash.update(blob.data); }, async digest() { return { data: new Uint8Array(hash.digest()) }; } };
  } };
  class Encoder { encodeInto(value) { return new TextEncoder().encode(value); } }
  const context = vm.createContext({ pushService: sdk, preferences: { getPreferences: async () => prefs },
    util: { generateRandomUUID: () => { uuidCalls++; return PHONE_ID; }, TextEncoder: Encoder }, cryptoFramework, BridgeClient,
    AppStorage: { setOrCreate: (key, value) => storage.set(key, value) },
    AppNotificationService: { setRemotePushEnabled: (value, threadIds = []) => { remoteReady = value; remoteThreads = Array.from(threadIds); } } });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) + '\nglobalThis.service = HuaweiPushRegistrationService;', context);
  const ability = { context: {} };
  return { service: context.service, ability, data, events, registrations, removals, writes, listeners, storage,
    configure: (url = 'https://pc-a.example', auth = 'auth-a', threads = [THREAD_A]) => context.service.configure(url, auth, threads),
    emit(value) { for (const listener of [...listeners]) listener(value); },
    get tokenCalls() { return tokenCalls; }, get deleteCalls() { return deleteCalls; }, get uuidCalls() { return uuidCalls; },
    get remoteReady() { return remoteReady; }, get remoteThreads() { return remoteThreads; },
    get state() { return storage.get('codexRemotePushState'); } };
}

test('cold disabled attach installs the listener; later enable initializes UUID and registers once', async () => {
  const h = harness({ data: new Map([['enabled', false]]) }); h.configure();
  await h.service.attach(h.ability);
  assert.equal(h.state, 'disabled'); assert.equal(h.tokenCalls, 0); assert.equal(h.listeners.size, 1);
  await h.service.enable(h.ability.context); await settle();
  assert.equal(h.registrations.length, 1); assert.equal(h.registrations[0].id, PHONE_ID);
  assert.equal(h.data.get('enabled'), true); assert.equal(h.uuidCalls, 1); assert.equal(h.remoteReady, true);
});

test('enable during pending preference read shares initialization and cannot lose installation identity', async () => {
  const gate = deferred(); let reading = false;
  const h = harness({ data: new Map([['enabled', false]]), read: async key => { if (key === 'enabled') { reading = true; await gate.promise; } } });
  h.configure(); const attached = h.service.attach(h.ability); await waitFor(() => reading);
  const enabled = h.service.enable(h.ability.context); gate.resolve(); await Promise.all([attached, enabled]); await settle();
  assert.equal(h.uuidCalls, 1); assert.equal(h.registrations.length, 1); assert.equal(h.registrations[0].id, PHONE_ID);
});

test('tokenUpdate wins over a slower getToken and registers only the latest native token', async () => {
  const gate = deferred(); const h = harness({ getToken: () => gate.promise }); h.configure();
  const attached = h.service.attach(h.ability); await waitFor(() => h.tokenCalls === 1); h.emit('new-token-B'); gate.resolve('old-token-A');
  await attached; await settle(); assert.deepEqual(h.registrations.map(value => value.token), ['new-token-B']);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_B]); await settle();
  assert.deepEqual(h.registrations.map(value => value.token), ['new-token-B', 'new-token-B']);
});

test('configure while getToken is pending retains its result for the latest target', async () => {
  const gate = deferred(); const h = harness({ getToken: () => gate.promise }); h.configure();
  const attached = h.service.attach(h.ability); await waitFor(() => h.tokenCalls === 1);
  h.configure('https://pc-b.example', 'auth-b', [THREAD_B]); gate.resolve('native-A'); await attached; await settle();
  assert.equal(h.registrations.length, 1); assert.equal(h.registrations[0].url, 'https://pc-b.example');
  assert.equal(h.registrations[0].token, 'native-A'); assert.equal(h.tokenCalls, 1);
});

test('disable waits for an in-flight registration, then removes it and revokes native delivery', async () => {
  const gate = deferred(); const h = harness({ register: () => gate.promise }); h.configure();
  const attached = h.service.attach(h.ability); await waitFor(() => h.registrations.length === 1);
  const disabled = h.service.disable(h.ability.context); assert.equal(h.remoteReady, false); assert.equal(h.removals.length, 0);
  gate.resolve(READY); await Promise.all([attached, disabled]); await settle();
  assert.equal(h.removals.length, 1); assert.equal(h.deleteCalls, 1); assert.equal(h.data.get('enabled'), false); assert.equal(h.state, 'disabled');
  h.configure(); h.emit('late-token'); await settle(); assert.equal(h.registrations.length, 1); assert.equal(h.remoteReady, false);
});

test('offline unregister cannot skip native token deletion or persisted disable intent', async () => {
  const h = harness({ remove: async () => { throw new Error('old PC unreachable'); } }); h.configure(); await h.service.attach(h.ability);
  await h.service.disable(h.ability.context).catch(() => {}); await settle();
  assert.equal(h.deleteCalls, 1); assert.equal(h.data.get('enabled'), false); assert.equal(h.state, 'disabled');
});

test('authority change removes old registration, rotates native token, and persists only non-secrets', async () => {
  const h = harness({ remove: async () => { throw new Error('old PC unreachable'); } }); h.configure(); await h.service.attach(h.ability);
  h.configure('https://pc-b.example/', 'auth-b', [THREAD_B]); await settle();
  assert.equal(h.removals.length, 1); assert.equal(h.removals[0].url, 'https://pc-a.example');
  assert.equal(h.deleteCalls, 1); assert.equal(h.tokenCalls, 2); assert.equal(h.registrations.length, 2);
  assert.equal(h.registrations[1].token, 'native-2'); assert.equal(h.data.get('authorityHash'), fingerprint('https://pc-b.example', 'auth-b'));
  assert.deepEqual([...new Set(h.writes.map(([key]) => key))].sort(), ['authorityHash', 'installationId']);
  assert.doesNotMatch(JSON.stringify([...h.data]), /auth-a|auth-b|native-/);
});

test('same URL with changed bridge credential is an authority change', async () => {
  const h = harness(); h.configure(); await h.service.attach(h.ability); h.configure('https://pc-a.example', 'auth-b'); await settle();
  assert.equal(h.deleteCalls, 1); assert.equal(h.removals[0].auth, 'auth-a'); assert.equal(h.registrations[1].auth, 'auth-b');
});

test('cold restart with a different persisted authority revokes its unknown old registration token once', async () => {
  const data = new Map([['installationId', PHONE_ID], ['authorityHash', fingerprint('https://old.example', 'old-auth')]]);
  const h = harness({ data, register: async () => { throw new Error('new PC unavailable'); } }); h.configure(); await h.service.attach(h.ability);
  for (let i = 0; i < 5; i++) { h.configure(); await settle(); }
  assert.equal(h.deleteCalls, 1); assert.equal(h.uuidCalls, 0); assert.equal(data.get('authorityHash'), fingerprint('https://pc-a.example', 'auth-a'));
  assert.ok(h.registrations.every(entry => entry.token === 'native-2')); assert.equal(h.tokenCalls, 2);
});

test('native activation and profile failures retry only on explicit enable, never dashboard configure', async () => {
  for (const [code, state] of [[1000900012, 'activation_required'], [1000900010, 'profile_required']]) {
    const h = harness({ getToken: async call => { if (call === 1) throw { code }; return 'fixed-token'; } }); h.configure(); await h.service.attach(h.ability);
    assert.equal(h.state, state); for (let i = 0; i < 5; i++) h.configure(); await settle();
    assert.equal(h.tokenCalls, 1); assert.equal(h.state, state); assert.equal(h.registrations.length, 0);
    await h.service.enable(h.ability.context); assert.equal(h.registrations.length, 1); assert.equal(h.state, 'ready');
  }
});

test('first trusted configuration arriving after native activation failure preserves the actionable failure state', async () => {
  const h = harness({ getToken: async () => { throw { code: 1000900012 }; } });
  await h.service.attach(h.ability); assert.equal(h.state, 'activation_required');
  h.configure(); await settle(); assert.equal(h.state, 'activation_required'); assert.equal(h.tokenCalls, 1); assert.equal(h.registrations.length, 0);
});

test('cached token and normalized thread IDs make unchanged dashboard configuration idempotent', async () => {
  const h = harness(); h.configure('https://pc-a.example/', 'auth-a', [THREAD_B, 'bad', THREAD_A, THREAD_B]); await h.service.attach(h.ability);
  for (let i = 0; i < 8; i++) h.configure('https://pc-a.example', 'auth-a', [THREAD_A, THREAD_B]); await settle();
  assert.equal(h.registrations.length, 1); assert.equal(h.tokenCalls, 1); assert.deepEqual(h.registrations[0].threads, [THREAD_A, THREAD_B]);
});

test('same authority transient update failure preserves cloud notification suppression until readiness is disproved', async () => {
  const h = harness({ register: async (_, call) => { if (call === 2) throw new Error('temporary network failure'); return READY; } });
  h.configure(); await h.service.attach(h.ability); h.configure('https://pc-a.example', 'auth-a', [THREAD_B]); await settle();
  assert.equal(h.state, 'reconnecting'); assert.equal(h.remoteReady, true);
  h.configure('https://pc-b.example', 'auth-b'); assert.equal(h.remoteReady, false); await settle();
});

test('a failed watch update preserves only acknowledged coverage until a ready registration replaces it', async () => {
  const h = harness({ register: async (_, call) => {
    if (call === 2) throw new Error('update did not reach bridge');
    return READY;
  } });
  h.configure(); await h.service.attach(h.ability);
  assert.deepEqual(h.remoteThreads, [THREAD_A]);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_A, THREAD_B]); await settle();
  assert.equal(h.state, 'reconnecting'); assert.equal(h.remoteReady, true);
  assert.deepEqual(h.remoteThreads, [THREAD_A]);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_A, THREAD_B]); await settle();
  assert.deepEqual(h.remoteThreads, [THREAD_A, THREAD_B]);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_B]); await settle();
  assert.deepEqual(h.remoteThreads, [THREAD_B]);
  await h.service.disable(h.ability.context);
  assert.deepEqual(h.remoteThreads, []);
});

test('removing a watch clears its suppression before an uncertain replacement finishes', async () => {
  const gate = deferred();
  const h = harness({ register: async (_, call) => call === 2 ? await gate.promise : READY });
  h.configure(); await h.service.attach(h.ability);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_B]);
  assert.deepEqual(h.remoteThreads, []);
  await waitFor(() => h.registrations.length === 2);
  gate.reject(new Error('bridge may have accepted the new watch list')); await settle();
  assert.deepEqual(h.remoteThreads, []);
  h.configure('https://pc-a.example', 'auth-a', [THREAD_A, THREAD_B]);
  assert.deepEqual(h.remoteThreads, []);
  await settle(); assert.deepEqual(h.remoteThreads, [THREAD_A, THREAD_B]);
});

for (const action of ['token rotation', 'authority change', 'unconfigure', 'disable']) {
  test(`${action} clears acknowledged push coverage before a pending replacement can finish`, async () => {
    const gate = deferred();
    const h = harness({ register: async (_, call) => call === 1 ? READY : await gate.promise });
    h.configure(); await h.service.attach(h.ability);
    assert.deepEqual(h.remoteThreads, [THREAD_A]);
    let disabling;
    if (action === 'token rotation') h.emit('rotated-token');
    if (action === 'authority change') h.configure('https://pc-b.example', 'auth-b', [THREAD_B]);
    if (action === 'unconfigure') h.configure('', '', []);
    if (action === 'disable') disabling = h.service.disable(h.ability.context);
    assert.equal(h.remoteReady, false); assert.deepEqual(h.remoteThreads, []);
    await settle();
    assert.deepEqual(h.remoteThreads, []);
    gate.resolve(READY); if (disabling) await disabling; await settle();
    const expectedThreads = action === 'token rotation' ? [THREAD_A]
      : action === 'authority change' ? [THREAD_B] : [];
    assert.deepEqual(h.remoteThreads, expectedThreads);
  });
}

test('server setup is required before local background notifications are suppressed', async () => {
  const h = harness({ register: async () => ({ ...READY, configured: false, registration: { ...READY.registration, ready: false } }) });
  h.configure(); await h.service.attach(h.ability); assert.equal(h.state, 'server_setup_required'); assert.equal(h.remoteReady, false);
});

for (const refresh of ['dashboard', 'explicit enable']) {
  test(`server setup recovery with an unchanged cached token succeeds after ${refresh}`, async () => {
    let configured = false;
    const h = harness({ register: async () => ({ ...READY, configured,
      registration: { ...READY.registration, ready: configured } }) });
    h.configure(); await h.service.attach(h.ability);
    assert.equal(h.state, 'server_setup_required'); assert.equal(h.remoteReady, false);
    configured = true;
    if (refresh === 'dashboard') h.configure();
    else await h.service.enable(h.ability.context);
    await settle();
    assert.equal(h.registrations.length, 2); assert.equal(h.tokenCalls, 1);
    assert.equal(h.state, 'ready'); assert.equal(h.remoteReady, true);
    for (let attempt = 0; attempt < 5; attempt++) h.configure();
    await settle(); assert.equal(h.registrations.length, 2);
  });
}

test('explicit enable refreshes a cached ready registration and observes changed server configuration', async () => {
  let configured = true;
  const h = harness({ register: async () => ({ ...READY, configured,
    registration: { ...READY.registration, ready: configured } }) });
  h.configure(); await h.service.attach(h.ability);
  configured = false;
  await h.service.enable(h.ability.context);
  assert.equal(h.registrations.length, 2); assert.equal(h.tokenCalls, 1);
  assert.equal(h.state, 'server_setup_required'); assert.equal(h.remoteReady, false); assert.deepEqual(h.remoteThreads, []);
  configured = true;
  await h.service.enable(h.ability.context);
  assert.equal(h.registrations.length, 3); assert.equal(h.tokenCalls, 1);
  assert.equal(h.state, 'ready'); assert.equal(h.remoteReady, true);
});

test('disable during server setup recovery remains final after the recovery POST completes', async () => {
  const gate = deferred();
  const h = harness({ register: async (_, call) => call === 1
    ? { ...READY, configured: false, registration: { ...READY.registration, ready: false } }
    : await gate.promise });
  h.configure(); await h.service.attach(h.ability);
  const enabling = h.service.enable(h.ability.context);
  await waitFor(() => h.registrations.length === 2);
  const disabling = h.service.disable(h.ability.context);
  assert.equal(h.remoteReady, false); assert.equal(h.removals.length, 0);
  gate.resolve(READY); await Promise.all([enabling, disabling]); await settle();
  assert.equal(h.state, 'disabled'); assert.equal(h.remoteReady, false);
  assert.equal(h.removals.length, 1); assert.equal(h.deleteCalls, 1);
});

test('detach only removes listener and preserves cloud registration across process destruction', async () => {
  const h = harness(); h.configure(); await h.service.attach(h.ability); h.service.detach(); await settle();
  assert.equal(h.listeners.size, 0); assert.equal(h.removals.length, 0); assert.equal(h.deleteCalls, 0); assert.equal(h.data.get('enabled'), undefined);
  await h.service.attach(h.ability); assert.equal(h.listeners.size, 1); assert.equal(h.tokenCalls, 1); assert.equal(h.registrations.length, 1);
});

test('unpair followed by a cold launch remains disabled and retains its stable non-secret installation ID', async () => {
  const first = harness(); first.configure(); await first.service.attach(first.ability); await first.service.disable(first.ability.context); first.service.detach();
  const second = harness({ data: first.data }); second.configure(); await second.service.attach(second.ability); await settle();
  assert.equal(second.state, 'disabled'); assert.equal(second.tokenCalls, 0); assert.equal(second.registrations.length, 0); assert.equal(second.uuidCalls, 0);
  assert.equal(second.data.get('installationId'), PHONE_ID);
});

test('cold startup waits for a trusted configuration without revoking an unchanged authority', async () => {
  const data = new Map([['installationId', PHONE_ID], ['authorityHash', fingerprint('https://pc-a.example', 'auth-a')]]);
  const h = harness({ data }); await h.service.attach(h.ability); await settle();
  assert.equal(h.deleteCalls, 0); assert.equal(h.registrations.length, 0); assert.equal(h.tokenCalls, 1);
  h.configure(); await settle(); assert.equal(h.deleteCalls, 0); assert.equal(h.tokenCalls, 1); assert.equal(h.registrations.length, 1);
});

test('clearing a configured authority removes ownership without disabling preference, then refreshes once for its replacement', async () => {
  const h = harness(); h.configure(); await h.service.attach(h.ability);
  h.configure('', '', []); await settle();
  assert.equal(h.removals.length, 1); assert.equal(h.deleteCalls, 1); assert.equal(h.tokenCalls, 1); assert.equal(h.data.get('enabled'), undefined);
  assert.equal(h.data.get('authorityHash'), ''); assert.equal(h.remoteReady, false);
  h.configure('https://pc-b.example', 'auth-b', [THREAD_B]); await settle();
  assert.equal(h.registrations.length, 2); assert.equal(h.registrations[1].url, 'https://pc-b.example');
  assert.equal(h.registrations[1].token, 'native-2'); assert.equal(h.tokenCalls, 2); assert.equal(h.deleteCalls, 1);
});

test('authority switch waits for the old in-flight POST before DELETE and native rotation', async () => {
  const gate = deferred(); const h = harness({ register: async (_, call) => call === 1 ? await gate.promise : READY }); h.configure();
  const attached = h.service.attach(h.ability); await waitFor(() => h.registrations.length === 1);
  h.configure('https://pc-b.example', 'auth-b'); await settle(); assert.equal(h.removals.length, 0);
  gate.resolve(READY); await attached; await settle();
  assert.deepEqual(h.events.filter(value => /register:|remove:|native-delete/.test(value)), [
    'register:https://pc-a.example', 'remove:https://pc-a.example', 'native-delete', 'register:https://pc-b.example'
  ]);
  assert.equal(h.state, 'ready'); assert.equal(h.registrations[1].token, 'native-2');
});

test('failed native revocation blocks replacement registration without dashboard delete loops', async () => {
  const h = harness({ deleteToken: async call => { if (call === 1) throw new Error('native unavailable'); } });
  h.configure(); await h.service.attach(h.ability); const oldHash = h.data.get('authorityHash');
  h.configure('https://pc-b.example', 'auth-b'); await settle();
  assert.equal(h.state, 'unavailable'); assert.equal(h.remoteReady, false); assert.equal(h.data.get('authorityHash'), oldHash);
  for (let i = 0; i < 5; i++) h.configure('https://pc-b.example', 'auth-b'); await settle();
  assert.equal(h.deleteCalls, 1); assert.equal(h.registrations.length, 1);
  await h.service.enable(h.ability.context); await settle();
  assert.equal(h.deleteCalls, 2); assert.equal(h.registrations.length, 2); assert.equal(h.state, 'ready');
});

test('registration failure still retains the attempted target for later unpair cleanup', async () => {
  const h = harness({ register: async () => { throw new Error('response lost after server accepted POST'); } });
  h.configure(); await h.service.attach(h.ability); assert.equal(h.state, 'reconnecting');
  await h.service.disable(h.ability.context); assert.equal(h.removals.length, 1); assert.equal(h.deleteCalls, 1);
});

test('native error after tokenUpdate cannot overwrite the already renewed native token', async () => {
  const gate = deferred(); const h = harness({ getToken: () => gate.promise }); h.configure();
  const attached = h.service.attach(h.ability); await waitFor(() => h.tokenCalls === 1); h.emit('renewed-token'); gate.reject({ code: 1000900012 });
  await attached; await settle(); assert.equal(h.registrations.length, 1); assert.equal(h.registrations[0].token, 'renewed-token'); assert.equal(h.state, 'ready');
});
