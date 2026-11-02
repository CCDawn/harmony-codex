import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fixture() {
  const family = {}, wrongFamily = {};
  const clock = { now: () => Date.now() };
  let calls = 0, writes = 0, host = 'local', status = 'ready';
  let hold = null, hostHold = null;
  const manager = { async getHostId() { if (hostHold) await hostHold.promise; return host; }, async getConversation() {
    calls++; if (hold) await hold.promise;
    return { requests: [{ id: 42, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1' } }], turns: [] };
  } };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) {
    manager[name] = async () => { writes++; };
  }
  let client = { hostId: 'local', rpc: manager };
  const binding = { get: () => ({ status, client }) };
  const owner = { familyBindings: new Map([[family, new Map([['local', { value: binding }]])]]) };
  const provider = { tag: 10, memoizedProps: { value: new Map([['owner', owner]]) } };
  const window = { __codexRoot: { _internalRoot: { current: { child: provider } } } };
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  const sources = {
    'index.js': 'import "./app-main-aa.js";',
    'app-main-aa.js': 'import "./app-runtime-bb.js";',
    'app-runtime-bb.js': 'import "./renderer-app-server-managers-cc.js";',
    'renderer-app-server-managers-cc.js': 'import{nativeFamily as localFamily}from"./app-initial-dd.js";' +
      'function publish(scope,host,rpc){scope.set(localFamily,host,{status:`ready`,client:{hostId:host,rpc:rpc}})}',
    'app-initial-dd.js': 'export{family as nativeFamily};'
  };
  const fetch = async url => ({ text: async () => sources[new URL(url).pathname.split('/').at(-1)] ?? '' });
  const imports = [];
  const transport = { hostId: 'local', async ensureConnected() {}, close() {},
    async evaluate(expression) {
      const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto', 'Date',
        'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
      return run(window, document, fetch, async url => { imports.push(url); return { nativeFamily: family }; }, URL, { randomUUID }, clock);
    } };
  return { api: new DesktopInteractionClient(transport), manager, owner, provider, wrongFamily, imports,
    setHost(value) { host = value; }, setStatus(value) { status = value; },
    setClientHost(value) { client.hostId = value; }, replaceClient() { client = { hostId: 'local', rpc: manager }; },
    removePublisher() { sources['renderer-app-server-managers-cc.js'] = 'export{};'; },
    holdRead() { hold = Promise.withResolvers(); return hold; },
    holdHost() { hostHold = Promise.withResolvers(); return hostHold; },
    prependFibers(count) { let current = window.__codexRoot._internalRoot.current.child;
      for (let i = 0; i < count; i++) current = { child: current };
      window.__codexRoot._internalRoot.current.child = current; },
    expireScan() { let count = 0; clock.now = () => count++ === 0 ? 0 : 3001; },
    makeCycle() { provider.child = provider; },
    addOtherFamily() { owner.familyBindings.set(wrongFamily, new Map([['local', { value: binding }]])); },
    addOtherOwner() { const otherClient = { hostId: 'local', rpc: manager };
      const second = { familyBindings: new Map([[family, new Map([['local', { value: { get: () => ({ status: 'ready', client: otherClient }) } }]])]]) };
      provider.memoizedProps.value.set('second', second); },
    addOtherOwnerAfter(count) { const otherClient = { hostId: 'local', rpc: manager };
      const second = { familyBindings: new Map([[family, new Map([['local', { value: { get: () => ({ status: 'ready', client: otherClient }) } }]])]]) };
      let fiber = provider;
      for (let i = 0; i < count; i++) fiber = fiber.sibling = {};
      fiber.sibling = { tag: 10, memoizedProps: { value: new Map([['second', second]]) } }; },
    get calls() { return calls; }, get writes() { return writes; } };
}

test('a large mounted desktop tree still finds the verified connection', async () => {
  const h = fixture();
  h.prependFibers(28000);
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.id, 42);
  assert.equal(h.calls, 1);
  assert.equal(h.writes, 0);
});

test('mounted traversal detects cycles and fails explicitly on its time budget', async () => {
  const cyclic = fixture(); cyclic.makeCycle();
  assert.equal((await cyclic.api.listRequests('thread-1')).length, 1);
  const expired = fixture(); expired.expireScan();
  await assert.rejects(expired.api.listRequests('thread-1'), {
    code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-scan-timeout'
  });
  assert.equal(expired.calls, 0);
});

test('a large tree still checks all matching owners for ambiguity', async () => {
  const h = fixture(); h.addOtherOwnerAfter(28000);
  await assert.rejects(h.api.listRequests('thread-1'), {
    code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-ambiguous'
  });
  assert.equal(h.calls, 0);
});

test('reads the verified ready connection through the imported family and async host identity', async () => {
  const h = fixture();
  h.addOtherFamily();
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.id, 42);
  assert.ok(ticket.__desktopGeneration);
  assert.equal(h.calls, 1);
  assert.ok(h.imports.some(value => value.endsWith('/app-initial-dd.js')));
  assert.equal(h.writes, 0);
});

test('ready state and both connection host identities must match', async () => {
  for (const mutate of [h => h.setStatus('disconnected'), h => h.setClientHost('other'), h => h.setHost('other')]) {
    const h = fixture(); mutate(h);
    await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
    assert.equal(h.calls, 0);
    assert.equal(h.writes, 0);
  }
});

test('unproven families and a connection replaced during host lookup fail closed', async () => {
  const unknown = fixture(); unknown.removePublisher();
  await assert.rejects(unknown.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  assert.equal(unknown.calls, 0);
  const h = fixture(), held = h.holdHost();
  const read = h.api.listRequests('thread-1');
  await new Promise(resolve => setImmediate(resolve));
  h.replaceClient(); held.resolve();
  await assert.rejects(read, { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  assert.equal(h.calls, 0);
});

test('multiple matching mounted owners fail closed and replaced clients invalidate old tickets', async () => {
  const ambiguous = fixture(); ambiguous.addOtherOwner();
  await assert.rejects(ambiguous.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-ambiguous' });
  assert.equal(ambiguous.calls, 0);
  const h = fixture();
  const [ticket] = await h.api.listRequests('thread-1');
  h.replaceClient();
  await assert.rejects(h.api.respond('thread-1', ticket, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.writes, 0);
  const [fresh] = await h.api.listRequests('thread-1');
  assert.notEqual(fresh.__desktopGeneration, ticket.__desktopGeneration);
});

test('overlapping list reads use one in-flight conversation read', async () => {
  const h = fixture(), hold = h.holdRead();
  const first = h.api.listRequests('thread-1'), second = h.api.listRequests('thread-1');
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(h.calls, 1); } finally { hold.resolve(); }
  assert.deepEqual(await first, await second);
});
