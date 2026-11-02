import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';

function fixture() {
  const files = new Map();
  const modules = new Map();
  const fetched = [];
  const imported = [];
  const fetchFailures = new Map();
  const document = { scripts: [{ type: 'module', src: 'https://desktop.invalid/assets/index-a.js' }] };
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  const scopeId = Symbol('scope');
  const scope = { id: scopeId };
  const account = { scope, resolve() { return 'account'; } };
  const user = { scope, resolve() { return 'user'; } };
  const chain = new Map([[scopeId, { store: { get: value => value } }]]);
  const window = { __codexRoot: { _internalRoot: { current: { memoizedProps: { value: chain } } } } };
  let retained = 0;
  const topic = { onMessage() { return () => {}; }, onDisconnect() { return () => {}; },
    onPotentialMissedMessages() { return () => {}; }, onSubscribed() { return () => {}; },
    retainSubscription() { retained++; return () => { retained--; }; } };
  const profile = { id: 'profile', messaging_room_id: 'room', aeon_kind: 'orbit', status: 'active' };
  const api = { safeGet: async () => ({ profile }), postResponse() { throw Error('unexpected write'); } };
  const apiSource = "client.safeGet('/tbo/primary');export{client as apiX}";
  const topicSource = 'factory(c??(s===`all`?`calpico-chatgpt-messaging-all`:`calpico-chatgpt-messaging`));' +
    'n.scope.get(accountAtom)!==n.access.accountId||n.scope.get(userAtom)!==n.access.userId;' +
    'export{factory as factoryX,accountAtom as accountX,userAtom as userX}';
  modules.set('app-initial-b2.js', { apiX: api });
  modules.set('app-primary-c3.js', { factoryX: () => topic, accountX: account, userX: user });
  files.set('index-a.js', 'import "./app-shared-a1.js";');
  files.set('app-shared-a1.js', 'import {x} from "./app-initial-b2.js";');
  files.set('app-initial-b2.js', 'import("./app-primary-c3.js");import "./app-shared-a1.js";' + apiSource);
  files.set('app-primary-c3.js', topicSource);
  const fetch = async url => {
    const name = new URL(url).pathname.split('/').at(-1);
    fetched.push(name);
    const failures = fetchFailures.get(name) ?? 0;
    if (failures > 0) { fetchFailures.set(name, failures - 1); throw new Error('temporary fetch failure'); }
    if (!files.has(name)) throw new Error('fixture fetch failed');
    return { ok: true, text: async () => files.get(name) };
  };
  const importModule = async url => {
    const name = new URL(url).pathname.split('/').at(-1);
    imported.push(name);
    if (!modules.has(name)) throw new Error('fixture import failed');
    return modules.get(name);
  };
  const transport = { socket, async ensureConnected() {}, close() {},
    async call(method, params) { if (method === 'Runtime.addBinding') window[params.name] = () => {}; },
    async evaluate(expression) {
      return new Function('document', 'window', 'fetch', 'importModule',
        `return ${expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)')}`)(document, window, fetch, importModule);
    } };
  return { client: new CompanionDesktopClient(transport), files, modules, document, fetched, imported, fetchFailures, apiSource, topicSource,
    get retained() { return retained; } };
}

test('indirect active modules feed API and topic discovery once, including a cycle', async () => {
  const h = fixture();
  h.client.discover = async () => ({ id: 'profile', roomId: 'room' });
  h.client.getRoomMetadata = async () => ({ authors: [] });
  const stop = await h.client.subscribeMessages({ profileId: 'profile', roomId: 'room' });
  assert.equal(h.retained, 1);
  assert.deepEqual(h.fetched, ['index-a.js', 'app-shared-a1.js', 'app-initial-b2.js', 'app-primary-c3.js']);
  assert.deepEqual(h.imported, ['app-initial-b2.js', 'app-primary-c3.js']);
  await stop();
  assert.equal(h.retained, 0);
});

test('new entry hashes and a failed fetch are retried without caching a failed graph', async () => {
  const h = fixture();
  h.files.delete('app-initial-b2.js');
  await assert.rejects(h.client.discover(), error => error.failureClass === 'api_compatibility');
  h.files.set('app-initial-b2.js', h.apiSource);
  assert.equal((await h.client.discover()).id, 'profile');
  h.document.scripts[0].src = 'https://desktop.invalid/assets/index-b.js';
  h.files.set('index-b.js', 'import "./app-main-dd_44.js";');
  h.files.set('app-main-dd_44.js', 'export {x} from "./app-initial-ee-55.js";');
  h.files.set('app-initial-ee-55.js', h.apiSource);
  h.modules.set('app-initial-ee-55.js', { apiX: { ...h.modules.get('app-initial-b2.js').apiX } });
  await h.client.discover();
  assert.ok(h.imported.includes('app-initial-ee-55.js'));
  assert.equal(h.fetched.filter(value => value === 'app-initial-b2.js').length, 2);
});

test('ignores comments, quoted imports and other origins while following real static and dynamic imports', async () => {
  const h = fixture();
  h.files.set('index-a.js', [
    '// import "./app-shared-f00.js";',
    'const decoy = \'import "./app-shared-f01.js"\';',
    'import "https://other.invalid/assets/app-shared-f02.js";',
    'import "./subdir/app-shared-f03.js";',
    'import "./app-shared-a1.js";'
  ].join('\n'));
  assert.equal((await h.client.discover()).id, 'profile');
  assert.deepEqual(h.fetched, ['index-a.js', 'app-shared-a1.js', 'app-initial-b2.js']);
});

test('does not cache a failed module import', async () => {
  const h = fixture();
  const original = h.modules.get('app-initial-b2.js');
  h.modules.delete('app-initial-b2.js');
  await assert.rejects(h.client.discover());
  h.modules.set('app-initial-b2.js', original);
  assert.equal((await h.client.discover()).id, 'profile');
  assert.equal(h.imported.filter(name => name === 'app-initial-b2.js').length, 2);
});

test('topic discovery retries an asset that failed during API discovery in the same evaluation', async () => {
  const h = fixture();
  h.client.discover = async () => ({ id: 'profile', roomId: 'room' });
  h.client.getRoomMetadata = async () => ({ authors: [] });
  h.files.set('app-shared-a1.js', 'import/*fixture*/ "./app-initial-b2.js";import(/*fixture*/ "./app-primary-c3.js");');
  h.files.set('app-initial-b2.js', h.topicSource);
  h.files.set('app-primary-c3.js', h.apiSource);
  const api = h.modules.get('app-initial-b2.js');
  const topic = h.modules.get('app-primary-c3.js');
  h.modules.set('app-initial-b2.js', topic);
  h.modules.set('app-primary-c3.js', api);
  h.fetchFailures.set('app-initial-b2.js', 1);
  const stop = await h.client.subscribeMessages({ profileId: 'profile', roomId: 'room' });
  assert.equal(h.fetched.filter(name => name === 'app-initial-b2.js').length, 2);
  assert.equal(h.retained, 1);
  await stop();
});

test('module discovery is bounded even when the active entry references many assets', async () => {
  const h = fixture();
  const names = Array.from({ length: 65 }, (_, i) => `app-shared-${i.toString(16)}.js`);
  h.files.set('index-a.js', names.map(name => `import "./${name}";`).join('\n'));
  for (const name of names) h.files.set(name, 'export {};');
  await assert.rejects(h.client.discover(), error => error.failureClass === 'api_compatibility');
  assert.equal(h.fetched.length, 65, 'one entry plus at most 64 assets');
  assert.ok(!h.fetched.includes(names.at(-1)));
});
