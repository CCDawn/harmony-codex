import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function harness(conversation = { requests: [], turns: [] }, { legacy = true, modern = false } = {}) {
  const mounted = legacy || modern;
  const calls = [];
  let generation = 1;
  let opens = 0;
  let fetches = 0;
  let sharedSource = 'function read(){let r=local.appServerManagers;let s=q$?.appServerManagers};export{q$ as fN}';
  let confirmReplies = true;
  let emitResolution = true, listener = null, disposed = 0, subscribeHook = () => {}, breakRemote = () => {};
  let afterReply = () => {};
  const makeManager = () => {
    const current = generation;
    const assertCurrent = () => { if (current !== generation) throw new Error('retired'); };
    const manager = { getHostId() { return 'local'; },
      async getConversation(threadId) { assertCurrent(); assert.equal(threadId, 'thread-1'); return conversation; } };
    manager.subscribe = options => {
      assert.equal(options.type, 'notification');
      assert.equal(options.key.hostId, 'local');
      assert.equal(options.methods, 'serverRequest/resolved');
      listener = options.listener;
      const remote = { onRpcBroken(callback) { breakRemote = callback; }, [Symbol.dispose]() { disposed++; listener = null; } };
      const pending = Promise.resolve(remote);
      pending.onRpcBroken = () => {};
      pending[Symbol.dispose] = () => { disposed++; };
      subscribeHook(options);
      return pending;
    };
    for (const method of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
      'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) {
      manager[method] = async (...args) => {
        assertCurrent(); calls.push({ method, args });
        if (confirmReplies && method === 'sendFollowUpMessage') {
          conversation.turns.push({ turnId: 'follow-up', items: [{ type: 'userMessage', content: [{ type: 'text', text: args[1].prompt }] }] });
        } else if (confirmReplies) {
          conversation.requests = conversation.requests.filter(request => request.id !== args[1]);
          if (emitResolution) listener?.({ method: 'serverRequest/resolved', params: { threadId: args[0], requestId: args[1] } });
        }
        afterReply(method, args);
      };
    }
    return manager;
  };
  const runtime = { appServerManagers: mounted ? undefined : { async open(hostId) {
    assert.equal(hostId, 'local');
    opens += 1;
    return { status: 'ready', manager: makeManager() };
  } } };
  const window = {};
  const managerFamily = {};
  const questionStateFamily = {};
  let legacyManager = makeManager();
  const wrapped = { hostId: 'local', get rpc() { return legacyManager; } };
  const binding = { get: () => modern ? { status: 'ready', client: wrapped } : legacyManager };
  let owner = { familyBindings: new Map([[managerFamily, new Map([['local', { value: binding }]])]]) };
  const provider = { tag: 10, memoizedProps: { value: new Map([[Symbol('app'), owner]]) } };
  if (legacy && !modern) {
    sharedSource += ';class Registry{getForHostId(h){return this.scope.get(hosts).includes(h)?this.scope.get(family$,h):null}};export{family$ as liveFamily}';
    window.__codexRoot = { _internalRoot: { current: { child: provider } } };
  }
  if (modern) {
    sharedSource = 'import{liveFamily as family$}from"./app-initial-123abc.js";function publish(scope,host,rpc){scope.set(family$,host,{status:`ready`,client:{hostId:host,rpc:rpc}})}';
    window.__codexRoot = { _internalRoot: { current: { child: provider } } };
  }
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  const fetch = async url => {
    fetches += 1;
    return { text: async () => url.endsWith('index.js') ? (modern ? 'import "./renderer-app-server-managers-123abc.js";' : 'import "./app-shared-123abc.js";') : url.includes('app-initial-') ? 'export{family as liveFamily};' : sharedSource };
  };
  const client = { hostId: 'local', async ensureConnected() {}, async evaluate(expression) {
    const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto',
      'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
    return run(window, document, fetch, async () => ({ fN: runtime, liveFamily: managerFamily, questionState: questionStateFamily }), URL, { randomUUID });
  } };
  return { api: new DesktopInteractionClient(client), client, calls, conversation,
    retire() { generation += 1; if (mounted) legacyManager = makeManager(); },
    addMountedBinding(manager, hostId = 'local') {
      const otherClient = { hostId, rpc: manager };
      const otherOwner = { familyBindings: new Map([[managerFamily, new Map([[hostId, { value: { get: () => modern ? { status: 'ready', client: otherClient } : manager } }]])]]) };
      provider.memoizedProps.value.set(Symbol('other'), otherOwner);
    },
    addLargeMountedTree() {
      let fiber = provider;
      for (let index = 0; index < 100001; index++) fiber = fiber.sibling = {};
    },
    mountQuestionState(value) {
      sharedSource += ';function skip(){scope.set(questionFamily$,key,{...prior,isSkipped:!0})};export{questionFamily$ as questionState}';
      const scope = { hostId: 'local', threadId: 'thread-1', entityKey: 'turn:turn-1',
        itemId: JSON.stringify(['request_user_input_async', 'item-1', 0]) };
      owner.familyBindings.set(questionStateFamily, new Map([[JSON.stringify(scope), { value: { get: () => value } }]]));
    },
    removeLegacyFamily() { owner.familyBindings.clear(); },
    replaceLegacyProvider() {
      owner = { familyBindings: new Map([[managerFamily, new Map([['local', { value: binding }]])]]) };
      provider.memoizedProps.value = new Map([[Symbol('app'), owner]]);
    },
    set legacyManager(value) { legacyManager = value; },
    get legacyManager() { return legacyManager; },
    resetRenderer() { delete window.__codexHarmonyDesktopInteractions; },
    set sharedSource(value) { sharedSource = value; },
    set confirmReplies(value) { confirmReplies = value; },
    set afterReply(value) { afterReply = value; },
    set emitResolution(value) { emitResolution = value; },
    set subscribeHook(value) { subscribeHook = value; },
    notify(event) { listener?.(event); },
    breakRpc() { breakRemote(); },
    get disposed() { return disposed; },
    get fetches() { return fetches; }, get opens() { return opens; } };
}
function native(method, id = 17) {
  return { id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'Review this operation' } };
}

test('current bundle with imported host facade and no registry getter reuses the unique mounted manager', async () => {
  const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] }, { modern: true });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.id, 17);
  assert.equal(h.opens, 0);
  assert.equal(h.calls.length, 0);
  const [same] = await h.api.listRequests('thread-1');
  assert.equal(same.__desktopGeneration, ticket.__desktopGeneration);
});

test('mounted fallback refuses ambiguity, wrong host and incomplete manager contracts', async () => {
  for (const change of [h => h.addMountedBinding({ ...h.legacyManager }),
    h => { h.legacyManager.getHostId = () => 'foreign'; },
    h => { delete h.legacyManager.replyWithPermissionsRequestApprovalResponse; }]) {
    const h = harness(undefined, { modern: true });
    change(h);
    await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503 });
    assert.equal(h.opens, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('mounted fallback ignores foreign host bindings and invalidates replaced owner generations', async () => {
  for (const replace of [h => h.retire(), h => h.replaceLegacyProvider()]) {
    const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] }, { modern: true });
    h.addMountedBinding({ ...h.legacyManager }, 'foreign');
    const [old] = await h.api.listRequests('thread-1');
    replace(h);
    await assert.rejects(h.api.respond('thread-1', old, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
    const [fresh] = await h.api.listRequests('thread-1');
    assert.notEqual(fresh.__desktopGeneration, old.__desktopGeneration);
    assert.equal(h.opens, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('current bundle fallback preserves the mounted desktop skip and submission state of async questions', async () => {
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Choose' }] }
  ] }] }, { modern: true });
  const official = { turnId: 'turn-1', isSkipped: true };
  h.mountQuestionState(official);
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  official.isSkipped = false;
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  official.lastSubmission = {};
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  assert.equal(h.opens, 0);
  assert.equal(h.calls.length, 0);
});

test('client failure stages are fixed metadata and never contain renderer or transport details', async () => {
  const h = harness(undefined, { modern: true });
  h.removeLegacyFamily();
  await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager' });
  h.client.evaluate = async () => ({ __desktopInteractionError: true, code: 'PRIVATE_BODY', stage: 'PRIVATE_SOURCE' });
  await assert.rejects(h.api.listRequests('thread-1'), error => {
    assert.equal(error.code, 'DESKTOP_INTERACTIONS_UNAVAILABLE');
    assert.equal(error.stage, 'renderer');
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
    return true;
  });
  h.client.ensureConnected = async () => { throw new Error('PRIVATE_TRANSPORT'); };
  await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'transport' });
});

test('mounted discovery checks uniqueness throughout a tree larger than 100000 nodes', async () => {
  const h = harness(undefined, { modern: true });
  h.addLargeMountedTree();
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  assert.equal(h.opens, 0);
  assert.equal(h.calls.length, 0);
});

test('undefined native service uses the existing legacy UI manager without opening a host', async () => {
  const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] }, { legacy: true });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.id, 17);
  await h.api.respond('thread-1', ticket, { decision: 'accept' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.opens, 0);
});

test('legacy family absent, wrong host, and incomplete methods fail closed', async () => {
  for (const change of [h => h.removeLegacyFamily(),
    h => { h.legacyManager.getHostId = () => 'other'; },
    h => { delete h.legacyManager.replyWithUserInputResponse; }]) {
    const h = harness(undefined, { legacy: true });
    change(h);
    await assert.rejects(h.api.listRequests('thread-1'),
      { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503 });
    assert.equal(h.opens, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('legacy manager replacement and provider rebuild invalidate prior tickets', async () => {
  for (const replace of [h => h.retire(), h => h.replaceLegacyProvider()]) {
    const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] }, { legacy: true });
    const [old] = await h.api.listRequests('thread-1');
    replace(h);
    await assert.rejects(h.api.respond('thread-1', old, { decision: 'accept' }),
      { code: 'DESKTOP_REQUEST_STALE', statusCode: 409 });
    const [fresh] = await h.api.listRequests('thread-1');
    assert.notEqual(fresh.__desktopGeneration, old.__desktopGeneration);
    assert.equal(h.calls.length, 0);
  }
});

test('legacy replacement during a conversation read cannot return an old ticket', async () => {
  const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] }, { legacy: true });
  const original = h.legacyManager.getConversation;
  h.legacyManager.getConversation = async threadId => {
    const result = await original(threadId);
    h.retire();
    return result;
  };
  await assert.rejects(h.api.listRequests('thread-1'),
    { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503 });
  assert.equal(h.calls.length, 0);
});

test('native requests are projected without conversation text and replies unpack only command/file decisions', async () => {
  const requests = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'item/tool/requestUserInput'].map((method, i) => native(method, i));
  const h = harness({ requests, turns: [{ turnId: 'turn-1', items: [
    { type: 'agentMessage', id: 'private', text: 'PRIVATE_CHAT_BODY' },
    { type: 'fileChange', id: 'item-1', changes: [{ path: '/repo/a.js', diff: '+safe content' }] }
  ] }] });
  const snapshot = await h.api.listRequests('thread-1');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_CHAT_BODY'), false);
  assert.deepEqual(snapshot[1].__fileChanges, h.conversation.turns[0].items[1].changes);
  const results = [{ decision: 'accept' }, { decision: 'decline' },
    { permissions: { fileSystem: { write: ['/repo'] } }, scope: 'turn' }, { answers: { question: { answers: ['A'] } } }];
  for (let i = 0; i < snapshot.length; i += 1) await h.api.respond('thread-1', snapshot[i], results[i]);
  assert.deepEqual(h.calls.map(call => call.args[2]), ['accept', 'decline', results[2], results[3]]);
  assert.equal(h.opens, 0);
});

test('native response requires the matching server resolution event, not optimistic request removal', async () => {
  const h = harness({ requests: [native('item/tool/requestUserInput')], turns: [] });
  h.emitResolution = false;
  h.afterReply = (_method, args) => {
    h.notify({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: args[1] } });
    h.notify({ method: 'serverRequest/resolved', params: { threadId: args[0], requestId: String(args[1]) } });
  };
  const [ticket] = await h.api.listRequests('thread-1');
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: {} }), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.conversation.requests.length, 0);
  assert.equal(h.disposed, 2);
});

test('a broken native subscription cannot report success or replay a submitted answer', async () => {
  const h = harness({ requests: [native('item/tool/requestUserInput')], turns: [] });
  h.emitResolution = false;
  h.afterReply = () => h.breakRpc();
  const [ticket] = await h.api.listRequests('thread-1');
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: {} }), { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.disposed, 2);
});

test('a request changed during subscription handshake cannot be written', async () => {
  const h = harness({ requests: [native('item/tool/requestUserInput')], turns: [] });
  h.subscribeHook = () => { h.conversation.requests[0].params.reason = 'changed'; };
  const [ticket] = structuredClone(await h.api.listRequests('thread-1'));
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: {} }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.disposed, 2);
});

test('native resolution matches method, exact thread and typed request id, and disposes the subscription', async () => {
  const h = harness({ requests: [native('item/tool/requestUserInput')], turns: [] });
  h.confirmReplies = false;
  h.afterReply = (_method, args) => {
    h.notify({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: args[1] } });
    h.notify({ method: 'serverRequest/resolved', params: { threadId: args[0], requestId: String(args[1]) } });
    h.notify({ method: 'other', params: { threadId: args[0], requestId: args[1] } });
    h.notify({ method: 'serverRequest/resolved', params: { threadId: args[0], requestId: args[1] } });
  };
  const [ticket] = await h.api.listRequests('thread-1');
  assert.deepEqual(await h.api.respond('thread-1', ticket, { answers: {} }), { ok: true, requestId: 17 });
  assert.equal(h.disposed, 2);
});

test('a resolution seen before dispatch makes the ticket stale without writing', async () => {
  const h = harness({ requests: [native('item/tool/requestUserInput')], turns: [] });
  h.subscribeHook = options => options.listener({ method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 17 } });
  const [ticket] = await h.api.listRequests('thread-1');
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: {} }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.disposed, 2);
});

test('removed, changed, completed and differently typed request ids cannot authorize a reply', async () => {
  for (const change of [request => { request.params.reason = 'changed'; }, request => { request.completed = true; },
    request => { request.id = '17'; }, (_request, conversation) => { conversation.requests = []; }]) {
    const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] });
    const [ticket] = structuredClone(await h.api.listRequests('thread-1'));
    change(h.conversation.requests[0], h.conversation);
    await assert.rejects(h.api.respond('thread-1', ticket, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE', statusCode: 409 });
    assert.equal(h.calls.length, 0);
  }
});

test('file changes are part of the identity reconfirmed before approval', async () => {
  const h = harness({ requests: [native('item/fileChange/requestApproval')],
    turns: [{ turnId: 'turn-1', items: [{ id: 'item-1', type: 'fileChange', changes: [{ diff: '+before' }] }] }] });
  const [ticket] = structuredClone(await h.api.listRequests('thread-1'));
  h.conversation.turns[0].items[0].changes[0].diff = '+different';
  await assert.rejects(h.api.respond('thread-1', ticket, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
});

test('host generation and renderer reload invalidate identical recycled protocol request ids', async () => {
  const h = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] });
  const [old] = await h.api.listRequests('thread-1');
  h.retire();
  await assert.rejects(h.api.respond('thread-1', old, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
  const [fresh] = await h.api.listRequests('thread-1');
  assert.notEqual(fresh.__desktopGeneration, old.__desktopGeneration);
  await assert.rejects(h.api.respond('thread-1', old, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
  h.resetRenderer();
  await assert.rejects(h.api.respond('thread-1', fresh, { decision: 'accept' }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
});

test('active-turn async questions use the official follow-up entrypoint in the same thread', async () => {
  const turn = { turnId: 'active-turn', status: 'inProgress', items: [{ id: 'question-message', type: 'agentMessage',
    text: 'PRIVATE_CHAT_BODY', questions: [{ title: 'Which route?', options: ['A', 'B'] }] }] };
  const h = harness({ requests: [], turns: [], turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ value: 'turn:active-turn' }] }], entitiesByKey: { 'turn:active-turn': turn } } } });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.method, 'desktop/asyncUserInput');
  const questionId = ticket.params.questions[0].id;
  assert.equal(questionId, JSON.stringify(['request_user_input_async', 'question-message', 0]));
  await h.api.respond('thread-1', ticket, { answers: { [questionId]: { answers: ['A'] } } });
  assert.equal(h.calls[0].method, 'sendFollowUpMessage');
  assert.equal(h.calls[0].args[0], 'thread-1');
  assert.equal(h.calls[0].args[1].turnTrigger, 'send_user_message_async_question');
  assert.equal(h.calls[0].args[1].prompt, '<send_user_message_question_reply>\n'
    + JSON.stringify([{ questionItemId: questionId, question: 'Which route?', answer: 'A' }]) + '\n</send_user_message_question_reply>');
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
});

test('accepted async answer receipts suppress questions while failed steering does not', async () => {
  const questionId = JSON.stringify(['request_user_input_async', 'item-1', 0]);
  const input = [{ type: 'text', text: '<send_user_message_question_reply>\n'
    + JSON.stringify([{ questionItemId: questionId, question: 'Choose', answer: 'A' }]) + '\n</send_user_message_question_reply>' }];
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Choose', options: ['A'] }] },
    { type: 'steeringUserMessage', status: 'failed', input }
  ] }] });
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  h.conversation.turns[0].items[1].status = 'accepted';
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
});

test('missing steering status and partially malformed answer wrappers cannot hide async questions', async () => {
  const questionId = JSON.stringify(['request_user_input_async', 'item-1', 0]);
  const answer = { questionItemId: questionId, question: 'Choose', answer: 'A' };
  const wrap = value => [{ type: 'text', text: '<send_user_message_question_reply>\n'
    + JSON.stringify(value) + '\n</send_user_message_question_reply>' }];
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Choose' }] },
    { type: 'steeringUserMessage', input: wrap(answer) }
  ] }] });
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  h.conversation.turns[0].items[1].status = 'accepted';
  h.conversation.turns[0].items[1].input = wrap([answer, null]);
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  h.conversation.turns[0].items[1].input = wrap([answer, { questionItemId: 'bad', question: 'Bad' }]);
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  h.conversation.turns[0].items[1].input = wrap(answer);
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
});

test('question edits invalidate the async reply and unsupported old desktop fails closed', async () => {
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Original' }] }
  ] }] });
  const [ticket] = await h.api.listRequests('thread-1');
  h.conversation.turns[0].items[0].questions[0].title = 'Changed';
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: {} }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
  h.client.evaluate = async () => ({ __desktopInteractionError: true, code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', statusCode: 503 });
});

test('validated runtime parsing is cached and failed parsing can recover', async () => {
  const h = harness();
  h.sharedSource = 'function oldDesktop(){}';
  await assert.rejects(h.api.listRequests('thread-1'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
  h.sharedSource = 'class Registry{getForHostId(h){return this.scope.get(hosts).includes(h)?this.scope.get(family$,h):null}};export{family$ as liveFamily}';
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  const fetches = h.fetches;
  await Promise.all([h.api.listRequests('thread-1'), h.api.listRequests('thread-1')]);
  assert.equal(h.fetches, fetches);
  assert.equal(h.opens, 0);
});

test('async tickets remain stable when another message adds questions to the same turn', async () => {
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'first', type: 'agentMessage', questions: [{ title: 'First' }] }
  ] }] });
  const [ticket] = structuredClone(await h.api.listRequests('thread-1'));
  h.conversation.turns[0].items.push({ id: 'second', type: 'agentMessage', questions: [{ title: 'Second' }] });
  const requests = await h.api.listRequests('thread-1');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], ticket);
  await h.api.respond('thread-1', ticket, { answers: { [ticket.params.questions[0].id]: { answers: ['Yes'] } } });
  assert.equal(h.calls.length, 1);
});

test('the optimistic version of a canonical item determines the current review context', async () => {
  const old = { turnId: 'turn-1', status: 'inProgress', items: [{ id: 'item-1', type: 'agentMessage', questions: [{ title: 'Old' }] }] };
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Current' }] }
  ] }], turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'turn:turn-1' }] }],
    entitiesByKey: { 'turn:turn-1': old } } } });
  const requests = await h.api.listRequests('thread-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.questions[0].question, 'Current');
});

test('void native replies and async sends without a receipt remain unconfirmed and are never replayed', async () => {
  const nativeHarness = harness({ requests: [native('item/commandExecution/requestApproval')], turns: [] });
  const asyncHarness = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Choose' }] }
  ] }] });
  await Promise.all([nativeHarness, asyncHarness].map(async h => {
    h.confirmReplies = false;
    const [request] = await h.api.listRequests('thread-1');
    await assert.rejects(h.api.respond('thread-1', request, request.method === 'desktop/asyncUserInput'
      ? { answers: { [request.params.questions[0].id]: { answers: ['A'] } } } : { decision: 'accept' }),
    { code: 'DESKTOP_RESPONSE_UNCONFIRMED', statusCode: 503 });
    assert.equal(h.calls.length, 1);
    assert.equal((await h.api.listRequests('thread-1')).length, 1);
  }));
});

test('a conflicting accepted desktop answer wins over a matching mobile receipt during confirmation', async () => {
  const h = harness({ requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items: [
    { id: 'item-1', type: 'agentMessage', questions: [{ title: 'Choose', options: ['A', 'B'] }] }
  ] }] });
  const [ticket] = await h.api.listRequests('thread-1');
  const id = ticket.params.questions[0].id;
  h.afterReply = () => {
    h.conversation.turns.push({ turnId: 'desktop-follow-up', items: [{ type: 'steeringUserMessage', status: 'accepted',
      input: [{ type: 'text', text: '<send_user_message_question_reply>\n'
        + JSON.stringify([{ questionItemId: id, question: 'Choose', answer: 'B' }]) + '\n</send_user_message_question_reply>' }] }] });
  };
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: { [id]: { answers: ['A'] } } }),
    { code: 'DESKTOP_ASYNC_ANSWER_CONFLICT', statusCode: 409 });
  assert.equal(h.calls.length, 1);
});
