import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const question = (id = 'question-message') => ({ id, type: 'agentMessage',
  questions: [{ title: 'Fixture question', options: ['A', 'B'] }] });
const turn = (status = 'inProgress', id = 'turn-1') => ({ turnId: id, status, items: [question()] });
const questionId = JSON.stringify(['request_user_input_async', 'question-message', 0]);

function harness(conversation, options = {}) {
  const calls = [];
  let clockOffset = 0;
  const clock = { now: () => Date.now() + clockOffset };
  const manager = { getHostId: () => 'local', async getConversation() { return conversation; } };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) {
    manager[name] = async (...args) => { calls.push({ name, args }); };
  }
  const managerFamily = {}, questionStateFamily = {};
  const scopeType = { id: Symbol('scope') };
  questionStateFamily.scope = scopeType;
  const selectedFamily = {}, busyFamily = {};
  let groupSelection = null;
  const questionStates = new Map();
  const owner = { familyBindings: new Map([
    [managerFamily, new Map([['local', { value: { get: () => manager } }]])],
    [questionStateFamily, questionStates]
  ]) };
  const window = { __codexRoot: { _internalRoot: { current: {
    tag: 10, memoizedProps: { value: new Map([['scope', owner]]) }
  } } } };
  const chain = new Map([[scopeType.id, owner]]);
  const bindingFor = key => [...questionStates].find(([entry]) => {
    const parsed = JSON.parse(entry);
    return parsed.hostId === key.hostId && parsed.threadId === key.threadId
      && parsed.entityKey === key.entityKey && parsed.itemId === key.itemId;
  })?.[1].value;
  const scopeRef = { scope: scopeType, node: owner, chain,
    get(family, key) {
      if (family === selectedFamily) return groupSelection;
      if (family === questionStateFamily) return bindingFor(key)?.get();
      if (family === busyFamily) return [...questionStates].some(([entry, member]) => {
        const parsed = JSON.parse(entry);
        return parsed.hostId === key.hostId && parsed.threadId === key.threadId
          && parsed.entityKey === key.entityKey && member.value.get()?.isSubmitting === true;
      });
    },
    set(family, key, value) { if (family === questionStateFamily) bindingFor(key).set(value); }, watch() {} };
  if (!options.missingScope) {
    window.__codexRoot._internalRoot.current.memoizedState = { memoizedState: { current: scopeRef } };
    if (options.conflictingChain) window.__codexRoot._internalRoot.current.memoizedState.next = {
      memoizedState: { current: { ...scopeRef, chain: new Map([[scopeType.id, owner]]) } } };
    if (options.wrongChainNode) chain.set(scopeType.id, {});
    if (options.duplicateScope) window.__codexRoot._internalRoot.current.memoizedState.next = {
      memoizedState: { current: { ...scopeRef } } };
    if (options.conflictingScope) window.__codexRoot._internalRoot.current.memoizedState.next = {
      memoizedState: { current: { ...scopeRef, scope: { id: scopeType.id } } } };
  }
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  const helperSource =
    'function init(e,t,n){let{turnId:r,questions:i,answersByQuestionItemId:a}=n;Dc(e,()=>{let s=questionState.resolve(e.node,e.chain,t).get();e.set(questionState,t,s)})}' +
    'function skip(e,t){let n=e.get(questionState,t);n!=null&&e.set(questionState,t,{...n,isSkipped:!0})}' +
    'function changeDraft(e,t,n){let r=e.get(questionState,t);r!=null&&r.draft!==n&&e.set(questionState,t,{...r,draft:n})}' +
    'function select(e,t){let n=normalize(t),r=e.get(selected,n),i=e.get(questionState,t);r?.selectedQuestionKey.entityKey===t.entityKey&&r.questionIds.includes(t.itemId)&&i!=null&&Dc(e,()=>{TD(e,n,{...r,selectedQuestionKey:t})})}' +
    'function close(e,t){if(e.get(questionState,t)==null)return;let n=normalize(t),r=e.get(chosen,n);r?.entityKey===t.entityKey&&r.itemId===t.itemId&&TD(e,n,null)}' +
    'busy=K(Q,(e,{get:t})=>t(questions,e).some(n=>t(questionState,{...e,itemId:n})?.isSubmitting===!0))' +
    'function detail(e,t){return t.map((t,n)=>({id:qid(e,n),sourceItemId:e,questionIndex:n,title:t.title,options:t.options??[]}))}' +
    'function one(e){return isQuestion(e)?detail(e.id,e.questions):[]}' +
    'function flat(e){return e.flatMap(e=>isQuestion(e)?one(e):[])}' +
    'function replies(e){let t=new Set(e.flatMap(e=>[]));let s=`steeringUserMessage accepted`;return{answersByQuestionItemId:new Map(),replyItemIds:new Set()}}';
  const source = 'class Registry{getForHostId(h){return this.scope.get(hosts).includes(h)?this.scope.get(managerFamily,h):null}};'
    + helperSource + 'export{managerFamily as liveManager,questionState as liveQuestionState,'
    + 'init as initializer,flat as flattener,replies as answerReader,skip as nativeSkip,changeDraft as nativeDraft,'
    + 'select as nativeSelect,close as nativeClose,selected as selectedFamily,busy as busyFamily}';
  const nativeSkip = (scope, key) => { const value = scope.get(questionStateFamily, key);
    if (value != null) scope.set(questionStateFamily, key, { ...value, isSkipped: true }); };
  const nativeDraft = (scope, key, draft) => { const value = scope.get(questionStateFamily, key);
    if (value != null && value.draft !== draft) scope.set(questionStateFamily, key, { ...value, draft }); };
  const nativeSelect = (scope, key) => {
    if (groupSelection?.selectedQuestionKey.entityKey === key.entityKey && groupSelection.questionIds.includes(key.itemId)
      && scope.get(questionStateFamily, key) != null) groupSelection = { ...groupSelection, selectedQuestionKey: key };
  };
  const nativeClose = (scope, key) => {
    if (options.ignorePanelWrite) return;
    if (scope.get(questionStateFamily, key) != null && groupSelection?.selectedQuestionKey.entityKey === key.entityKey
      && groupSelection.selectedQuestionKey.itemId === key.itemId) groupSelection = null;
  };
  const flatten = items => items.flatMap(item => item.type === 'agentMessage' && Array.isArray(item.questions)
    ? item.questions.map((q, index) => ({ id: JSON.stringify(['request_user_input_async', item.id, index]),
      sourceItemId: item.id, questionIndex: index, title: q.title, options: q.options ?? [] })) : []);
  const answerReader = items => ({ answersByQuestionItemId: new Map(items.flatMap(item =>
    item.fixtureAnswer ? [[item.fixtureAnswer.questionItemId, item.fixtureAnswer.answer]] : [])) });
  const initializer = (scope, key, data) => {
    assert.equal(scope, scopeRef);
    calls.push({ name: 'nativeInitializer', key, data });
    for (const q of data.questions) {
      const serialized = JSON.stringify({ ...key, itemId: q.id });
      const existing = [...questionStates].find(([entry]) => {
        const current = JSON.parse(entry);
        return current.hostId === key.hostId && current.threadId === key.threadId
          && current.entityKey === key.entityKey && current.itemId === q.id;
      });
      if (existing?.[1].value.get() != null) continue;
      let value = { turnId: data.turnId, status: data.status, question: q, isSubmitting: false, isSkipped: false, draft: '',
        lastSubmission: data.answersByQuestionItemId.get(q.id) ?? null };
      if (existing) existing[1].value.set(value);
      else questionStates.set(serialized, { value: { get: () => value, set: next => { calls.push({ name: 'setQuestionState', next }); value = next; } } });
    }
  };
  let fetches = 0;
  const client = { hostId: 'local', async ensureConnected() {}, async evaluate(expression) {
    const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto', 'Date',
      'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
    return run(window, document, async url => {
      fetches++;
      return { text: async () => url.endsWith('index.js') ? 'import "./app-initial-123abc.js";' : source };
    }, async () => ({ liveManager: managerFamily, liveQuestionState: questionStateFamily,
      initializer: options.nativeInitializer ? initializer : undefined, flattener: flatten, answerReader,
      nativeSkip, nativeDraft, nativeSelect, nativeClose, selectedFamily, busyFamily }), URL, { randomUUID }, clock);
  } };
  return { api: new DesktopInteractionClient(client), calls, window, get fetches() { return fetches; },
    setSelection(entityKey, ids, selectedId = ids[0]) {
      groupSelection = { selectedQuestionKey: { hostId: 'local', threadId: 'thread-1', entityKey, itemId: selectedId }, questionIds: ids };
    },
    get selection() { return groupSelection; },
    expireQuestionScan() {
      questionStates[Symbol.iterator] = function* () {
        for (const entry of Map.prototype.entries.call(this)) { clockOffset = 10000; yield entry; }
      };
    },
    setQuestionState(value, scope = {}, options = {}) {
      // Match the official family's serialized scope keys, without depending on property order.
      const key = JSON.stringify({ entityKey: 'turn:turn-1', hostId: 'local', itemId: questionId,
        threadId: 'thread-1', ...scope });
      if (value && typeof value === 'object' && value.draft === undefined) value.draft = '';
      let current = value;
      const binding = { get: () => current };
      if (!options.setless) binding.set = next => {
        calls.push({ name: 'setQuestionState', next });
        if (!options.ignoreWrite) current = next;
      };
      questionStates.set(options.key ?? key, { value: binding });
      return binding;
    } };
}

for (const status of ['completed', 'interrupted', 'failed', null]) {
  test(`${status} questions followed by user activity never become current pending requests`, async () => {
    const historical = turn(status);
    const h = harness({ requests: [], turns: [historical,
      { turnId: 'turn-2', status: 'inProgress', items: [{ id: 'user-2', type: 'userMessage', content: [] }] }] });
    assert.deepEqual(await h.api.listRequests('thread-1'), []);
    assert.equal(h.calls.length, 0);
  });
}

test('only the latest inProgress turn exposes its unanswered questions', async () => {
  const old = turn('inProgress', 'old-turn'); old.items = [question('old-question')];
  const h = harness({ requests: [], turns: [old, turn()] });
  const requests = await h.api.listRequests('thread-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.turnId, 'turn-1');
  assert.equal(requests[0].params.questions[0].id, questionId);
});

for (const questionState of [
  { turnId: 'turn-1', isSkipped: true, lastSubmission: null },
  { turnId: 'turn-1', isSkipped: false, lastSubmission: 'Fixture accepted answer' }
]) {
  test(`official question state suppresses ${questionState.isSkipped ? 'skipped' : 'submitted'} active questions`, async () => {
    const h = harness({ requests: [], turns: [turn()] });
    h.setQuestionState(questionState);
    assert.deepEqual(await h.api.listRequests('thread-1'), []);
    assert.equal(h.calls.length, 0);
  });
}

test('desktop submission in flight cannot be submitted again, and failed submission restores the question', async () => {
  const active = turn();
  active.items.push(question('another-question-message'));
  const h = harness({ requests: [], turns: [active] });
  const state = { turnId: 'turn-1', isSkipped: false, isSubmitting: false, lastSubmission: null };
  h.setQuestionState(state);
  const [ticket] = await h.api.listRequests('thread-1');
  state.isSubmitting = true;
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  await assert.rejects(h.api.respond('thread-1', ticket, { answers: { [questionId]: { answers: ['A'] } } }),
    { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
  state.isSubmitting = false;
  assert.equal((await h.api.listRequests('thread-1')).length, 2);
});

test('an unrelated old question state cannot block the current turn question group', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: true }, { itemId: 'orphan' });
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
});

test('a large mounted desktop tree retains the official skipped question state', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSkipped: true, lastSubmission: null });
  let root = h.window.__codexRoot._internalRoot.current;
  for (let i = 0; i < 28000; i++) root = { child: root };
  h.window.__codexRoot._internalRoot.current = root;
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
});

test('question state traversal times out without exposing partially read questions', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSkipped: true, lastSubmission: null });
  h.expireQuestionScan();
  await assert.rejects(h.api.listRequests('thread-1'), {
    code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-scan-timeout'
  });
});

test('fresh active questions remain visible; state from another scope or turn cannot suppress them', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  const skipped = { turnId: 'turn-1', isSkipped: true, lastSubmission: null };
  h.setQuestionState(skipped, { threadId: 'other-thread' });
  h.setQuestionState(skipped, { hostId: 'other-host' });
  h.setQuestionState(skipped, { entityKey: 'turn:other-turn' });
  h.setQuestionState({ ...skipped, turnId: 'other-turn' });
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  h.setQuestionState({ turnId: 'turn-1', isSkipped: false, lastSubmission: null });
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
});

for (const action of ['complete', 'skip']) {
  test(`a ticket becomes stale when the desktop ${action === 'skip' ? 'skips the question' : 'completes the turn'}`, async () => {
    const active = turn();
    const h = harness({ requests: [], turns: [active] });
    const [ticket] = await h.api.listRequests('thread-1');
    if (action === 'complete') active.status = 'completed';
    else h.setQuestionState({ turnId: 'turn-1', isSkipped: true, lastSubmission: null });
    await assert.rejects(h.api.respond('thread-1', ticket, { answers: { [questionId]: { answers: ['A'] } } }),
      { code: 'DESKTOP_REQUEST_STALE', statusCode: 409 });
    assert.equal(h.calls.length, 0);
  });
}

test('native pending input and approvals remain authoritative regardless of turn lifecycle', async () => {
  const requests = ['item/tool/requestUserInput', 'item/commandExecution/requestApproval'].map((method, id) => ({
    id, method, params: { threadId: 'thread-1', turnId: 'turn-1' }
  }));
  const h = harness({ requests, turns: [turn('completed')] });
  const result = await h.api.listRequests('thread-1');
  assert.deepEqual(result.map(r => r.method), requests.map(r => r.method));
});

test('a renderer discovery cache from the previous adapter version is refreshed', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.window.__codexHarmonyDesktopInteractionRuntime = { entryUrl: 'app://-/assets/index.js',
    promise: Promise.resolve({ module: {}, nativeExports: [], managerFamily: {} }) };
  assert.equal((await h.api.listRequests('thread-1')).length, 1);
  assert.equal(h.fetches, 2);
});


test('native skip writes only the selected question and leaves the other question pending', async () => {
  const active = turn();
  active.items[0].questions.push({ title: 'Second question', options: ['C'] });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  const h = harness({ requests: [], turns: [active] });
  const original = { turnId: 'turn-1', isSkipped: false, isSubmitting: false, lastSubmission: null, draft: 'preserve' };
  const first = h.setQuestionState(original);
  const second = h.setQuestionState({ ...original }, { itemId: secondId });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.__skipBindings.length, 2);
  assert.deepEqual(await h.api.respond('thread-1', ticket, { skipQuestionId: questionId }),
    { ok: true, requestId: ticket.id });
  assert.deepEqual(first.get(), { ...original, isSkipped: true, draft: '' });
  assert.equal(second.get().isSkipped, false);
  assert.deepEqual(h.calls.map(call => call.name), ['setQuestionState', 'setQuestionState']);
  const [remaining] = await h.api.listRequests('thread-1');
  assert.deepEqual(remaining.params.questions.map(q => q.id), [secondId]);
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: secondId }), { code: 'DESKTOP_REQUEST_STALE' });
});

test('single-question native skip succeeds without sending a follow-up message', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null });
  const [ticket] = await h.api.listRequests('thread-1');
  await h.api.respond('thread-1', ticket, { skipQuestionId: questionId });
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  assert.deepEqual(h.calls.map(call => call.name), ['setQuestionState']);
});

for (const kind of ['missing', 'setless', 'ambiguous']) {
  test(`native skip fails closed for ${kind} binding`, async () => {
    const h = harness({ requests: [], turns: [turn()] });
    const value = { turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null };
    if (kind !== 'missing') h.setQuestionState(value, {}, { setless: kind === 'setless' });
    if (kind === 'ambiguous') h.setQuestionState({ ...value }, {}, { key: JSON.stringify({
      threadId: 'thread-1', itemId: questionId, hostId: 'local', entityKey: 'turn:turn-1' }) });
    const [ticket] = await h.api.listRequests('thread-1');
    assert.equal(ticket.__skipBindings, null);
    await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
    assert.equal(h.calls.length, 0);
  });
}

test('binding replacement, submitted state and active-turn changes invalidate a skip without writing', async () => {
  for (const change of ['replace', 'submitting', 'answered', 'skipped', 'turn']) {
    const active = turn();
    const h = harness({ requests: [], turns: [active] });
    const value = { turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null };
    h.setQuestionState(value);
    const [ticket] = await h.api.listRequests('thread-1');
    if (change === 'replace') h.setQuestionState({ ...value });
    if (change === 'submitting') value.isSubmitting = true;
    if (change === 'answered') value.lastSubmission = 'A';
    if (change === 'skipped') value.isSkipped = true;
    if (change === 'turn') active.status = 'completed';
    await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
    assert.equal(h.calls.length, 0, change);
  }
});

test('native skip requires positive readback and is never retried or sent as a message', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null }, {}, { ignoreWrite: true });
  const [ticket] = await h.api.listRequests('thread-1');
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }),
    { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
  assert.deepEqual(h.calls.map(call => call.name), ['setQuestionState']);
});


test('accepted desktop answer invalidates a skip ticket without writing', async () => {
  const active = turn();
  const h = harness({ requests: [], turns: [active] });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null });
  const [ticket] = await h.api.listRequests('thread-1');
  const answer = JSON.stringify({ questionItemId: questionId, question: 'Fixture question', answer: 'A' });
  active.items.push({ type: 'userMessage', content: [{ type: 'text', text:
    '<send_user_message_question_reply>' + answer + '</send_user_message_question_reply>' }] });
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
});


test('background push inspection reads questions without initializing desktop UI state', async () => {
  const conversation = { requests: [], turns: [turn()] };
  const before = structuredClone(conversation);
  const h = harness(conversation, { nativeInitializer: true });
  const requests = await h.api.listRequests('thread-1', { readOnly: true });
  assert.equal(requests.length, 1);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(conversation, before);
  await h.api.listRequests('thread-1');
  assert.equal(h.calls.filter(call => call.name === 'nativeInitializer').length, 1);
});

test('native initializer receives complete turn, accepted answers, and real mounted scope once for missing state', async () => {
  const active = turn();
  active.items[0].questions.push({ title: 'Second', options: ['C'] });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  active.items.push({ id: 'answer', type: 'userMessage', content: [],
    fixtureAnswer: { questionItemId: questionId, answer: 'A' } });
  const h = harness({ requests: [], turns: [active] }, { nativeInitializer: true });
  const existing = h.setQuestionState({ turnId: 'turn-1', isSkipped: false, isSubmitting: false,
    lastSubmission: 'A', draft: 'keep' });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(h.calls[0].name, 'nativeInitializer');
  assert.deepEqual(h.calls[0].key, { hostId: 'local', threadId: 'thread-1', entityKey: 'turn:turn-1' });
  assert.deepEqual(h.calls[0].data.questions.map(q => q.id), [questionId, secondId]);
  assert.equal(h.calls[0].data.answersByQuestionItemId.get(questionId), 'A');
  assert.equal(existing.get().draft, 'keep');
  assert.deepEqual(ticket.params.questions.map(q => q.id), [secondId]);
  assert.equal(ticket.__skipBindings.length, 1);
  await h.api.listRequests('thread-1');
  assert.equal(h.calls.filter(call => call.name === 'nativeInitializer').length, 1);
  await h.api.respond('thread-1', ticket, { skipQuestionId: secondId });
  assert.deepEqual(h.calls.map(call => call.name), ['nativeInitializer', 'setQuestionState']);
});

for (const flag of ['missingScope', 'conflictingChain', 'wrongChainNode', 'conflictingScope']) {
  test(`native initializer refuses ${flag} and never fabricates a binding`, async () => {
    const h = harness({ requests: [], turns: [turn()] }, { nativeInitializer: true, [flag]: true });
    const [ticket] = await h.api.listRequests('thread-1');
    assert.equal(ticket.__skipBindings, null);
    assert.equal(h.calls.length, 0);
  });
}

test('native initializer refuses to overwrite an existing answer not confirmed by desktop history', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const h = harness({ requests: [], turns: [active] }, { nativeInitializer: true });
  const state = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, lastSubmission: 'kept', draft: 'kept' });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.__skipBindings, null);
  assert.equal(state.get().lastSubmission, 'kept');
  assert.equal(h.calls.length, 0);
});

test('native initializer never runs for historical turns or when desktop submission is in progress', async () => {
  const inactive = harness({ requests: [], turns: [turn('completed')] }, { nativeInitializer: true });
  assert.deepEqual(await inactive.api.listRequests('thread-1'), []);
  assert.equal(inactive.calls.length, 0);
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const h = harness({ requests: [], turns: [active] }, { nativeInitializer: true });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: true, lastSubmission: null });
  assert.deepEqual(await h.api.listRequests('thread-1'), []);
  assert.equal(h.calls.length, 0);
});


test('equivalent mounted refs allow initialization and preserve an existing skipped state and draft', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const h = harness({ requests: [], turns: [active] }, { nativeInitializer: true, duplicateScope: true });
  const existing = h.setQuestionState({ turnId: 'turn-1', isSkipped: true, isSubmitting: false,
    lastSubmission: null, draft: 'keep draft' });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.deepEqual(existing.get(), { turnId: 'turn-1', isSkipped: true, isSubmitting: false,
    lastSubmission: null, draft: 'keep draft' });
  assert.equal(ticket.params.questions.length, 1);
  assert.equal(ticket.__skipBindings.length, 1);
  assert.deepEqual(h.calls.map(call => call.name), ['nativeInitializer']);
});

test('initializer reads accepted answer evidence in later turns', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const later = { turnId: 'turn-2', status: 'completed', items: [{ type: 'userMessage', content: [],
    fixtureAnswer: { questionItemId: questionId, answer: 'A' } }] };
  const h = harness({ requests: [], turns: [active, later] }, { nativeInitializer: true });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, lastSubmission: 'A' });
  await h.api.listRequests('thread-1');
  assert.equal(h.calls[0].data.answersByQuestionItemId.get(questionId), 'A');
});


test('native initializer can restore an existing binding whose native state is null', async () => {
  const h = harness({ requests: [], turns: [turn()] }, { nativeInitializer: true });
  h.setQuestionState(null);
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.__skipBindings.length, 1);
  assert.equal(h.calls[0].name, 'nativeInitializer');
});


test('a skipped turn alias cannot hide a still-pending desktop tail alias', async () => {
  const h = harness({ requests: [], turns: [turn()] });
  h.setQuestionState({ turnId: 'turn-1', isSkipped: true, isSubmitting: false, lastSubmission: null });
  h.setQuestionState({ turnId: 'turn-1', isSkipped: false, isSubmitting: false, lastSubmission: null },
    { entityKey: 'tail:local:current' });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.params.questions[0].id, questionId);
});


function canonicalConversation(active, key = 'tail:0:local:fixture') {
  return { requests: [], turns: [], turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ value: key }] }], entitiesByKey: { [key]: active }
  } } };
}

test('canonical initializer uses the actual history entity key, never a fabricated turn alias', async () => {
  const h = harness(canonicalConversation(turn()), { nativeInitializer: true });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(h.calls[0].key.entityKey, 'tail:0:local:fixture');
  assert.equal(ticket.__skipBindings.length, 1);
  assert.equal(ticket.__skipBindings[0][0][0], 'tail:0:local:fixture');
});

test('ambiguous canonical entity keys never trigger a synthetic initialization', async () => {
  const active = turn(); const conversation = canonicalConversation(active);
  conversation.turnHistory.history.islands[0].entries.push({ value: 'tail:second' });
  conversation.turnHistory.history.entitiesByKey['tail:second'] = { ...active };
  const h = harness(conversation, { nativeInitializer: true });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.__skipBindings, null);
  assert.equal(h.calls.length, 0);
});

test('skip synchronizes old and current aliases, closes selected desktop panel, and preserves other drafts', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second', options: ['C'] });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  const h = harness(canonicalConversation(active));
  const legacy = h.setQuestionState({ turnId: 'turn-1', isSkipped: true, isSubmitting: false, lastSubmission: null, draft: '' });
  const current = h.setQuestionState({ turnId: 'turn-1', isSkipped: false, isSubmitting: false, lastSubmission: null, draft: 'discard target' },
    { entityKey: 'tail:0:local:fixture' });
  const other = h.setQuestionState({ turnId: 'turn-1', isSkipped: false, isSubmitting: false, lastSubmission: null, draft: 'keep other' },
    { entityKey: 'tail:0:local:fixture', itemId: secondId });
  h.setSelection('tail:0:local:fixture', [questionId]);
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.params.questions.length, 2);
  assert.equal(ticket.__skipBindings[0].length, 2);
  await h.api.respond('thread-1', ticket, { skipQuestionId: questionId });
  assert.equal(legacy.get().isSkipped, true);
  assert.equal(current.get().isSkipped, true);
  assert.equal(current.get().draft, '');
  assert.equal(other.get().draft, 'keep other');
  assert.equal(other.get().isSkipped, false);
  assert.equal(h.selection, null);
  assert.deepEqual(h.calls.map(call => call.name), ['setQuestionState', 'setQuestionState']);
  const [remaining] = await h.api.listRequests('thread-1');
  assert.deepEqual(remaining.params.questions.map(q => q.id), [secondId]);
});

test('skipping the last selected question returns to another draft without submitting it', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  const h = harness(canonicalConversation(active));
  const first = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null, draft: 'explicit user draft' },
    { entityKey: 'tail:0:local:fixture' });
  const second = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null, draft: 'skip me' },
    { entityKey: 'tail:0:local:fixture', itemId: secondId });
  h.setSelection('tail:0:local:fixture', [questionId, secondId], secondId);
  const [ticket] = await h.api.listRequests('thread-1');
  await h.api.respond('thread-1', ticket, { skipQuestionId: secondId });
  assert.equal(h.selection.selectedQuestionKey.itemId, questionId);
  assert.equal(first.get().draft, 'explicit user draft');
  assert.equal(second.get().draft, '');
  assert.equal(second.get().isSkipped, true);
  assert.equal(h.calls.some(call => call.name === 'sendFollowUpMessage'), false);
});

test('skipping selected question advances to next available group question', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  const h = harness(canonicalConversation(active));
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:0:local:fixture' });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null, draft: 'keep' },
    { entityKey: 'tail:0:local:fixture', itemId: secondId });
  h.setSelection('tail:0:local:fixture', [questionId, secondId]);
  const [ticket] = await h.api.listRequests('thread-1');
  await h.api.respond('thread-1', ticket, { skipQuestionId: questionId });
  assert.equal(h.selection.selectedQuestionKey.itemId, secondId);
});

test('same-entity duplicate aliases refuse skip but distinct entity aliases are allowed', async () => {
  const h = harness(canonicalConversation(turn()));
  const value = { turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null };
  h.setQuestionState({ ...value }, { entityKey: 'tail:0:local:fixture' });
  h.setQuestionState({ ...value }, {}, { key: JSON.stringify({ threadId: 'thread-1', itemId: questionId,
    hostId: 'local', entityKey: 'tail:0:local:fixture' }) });
  const [ticket] = await h.api.listRequests('thread-1');
  assert.equal(ticket.__skipBindings, null);
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
});

test('new or replaced alias invalidates an old ticket without writing', async () => {
  for (const kind of ['new', 'replacement']) {
    const h = harness(canonicalConversation(turn()));
    const value = { turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null };
    h.setQuestionState({ ...value }, { entityKey: 'tail:0:local:fixture' });
    const [ticket] = await h.api.listRequests('thread-1');
    h.setQuestionState({ ...value }, { entityKey: kind === 'new' ? 'turn:turn-1' : 'tail:0:local:fixture' });
    await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
    assert.equal(h.calls.length, 0);
  }
});


test('unrelated hosts and other turn states are never changed by alias skip', async () => {
  const h = harness(canonicalConversation(turn()));
  const current = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:0:local:fixture' });
  const otherHost = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { hostId: 'foreign', entityKey: 'tail:0:local:fixture' });
  const otherTurn = h.setQuestionState({ turnId: 'turn-previous', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:old' });
  const [ticket] = await h.api.listRequests('thread-1');
  await h.api.respond('thread-1', ticket, { skipQuestionId: questionId });
  assert.equal(current.get().isSkipped, true);
  assert.equal(otherHost.get().isSkipped, false);
  assert.equal(otherTurn.get().isSkipped, false);
});

test('native group busy state blocks every alias write even for an unlisted submitting question', async () => {
  const h = harness(canonicalConversation(turn()));
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:0:local:fixture' });
  const [ticket] = await h.api.listRequests('thread-1');
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: true, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:0:local:fixture', itemId: 'unlisted-native-group-member' });
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }), { code: 'DESKTOP_REQUEST_STALE' });
  assert.equal(h.calls.length, 0);
});

test('panel transition without readback is unconfirmed and is never retried', async () => {
  const h = harness(canonicalConversation(turn()), { ignorePanelWrite: true });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false, lastSubmission: null },
    { entityKey: 'tail:0:local:fixture' });
  h.setSelection('tail:0:local:fixture', [questionId]);
  const [ticket] = await h.api.listRequests('thread-1');
  await assert.rejects(h.api.respond('thread-1', ticket, { skipQuestionId: questionId }),
    { code: 'DESKTOP_RESPONSE_UNCONFIRMED' });
  assert.equal(h.calls.filter(call => call.name === 'setQuestionState').length, 1);
  assert.notEqual(h.selection, null);
});


test('an already submitted unchanged prior answer is not selected as an unsent draft', async () => {
  const active = turn(); active.items[0].questions.push({ title: 'Second' });
  const secondId = JSON.stringify(['request_user_input_async', 'question-message', 1]);
  const h = harness(canonicalConversation(active));
  const first = h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false,
    lastSubmission: 'previous', draft: 'previous' }, { entityKey: 'tail:0:local:fixture' });
  h.setQuestionState({ turnId: 'turn-1', isSubmitting: false, isSkipped: false,
    lastSubmission: null }, { entityKey: 'tail:0:local:fixture', itemId: secondId });
  h.setSelection('tail:0:local:fixture', [questionId, secondId], secondId);
  const [ticket] = await h.api.listRequests('thread-1');
  await h.api.respond('thread-1', ticket, { skipQuestionId: secondId });
  assert.equal(h.selection, null);
  assert.equal(first.get().draft, 'previous');
  assert.equal(h.calls.some(call => call.name === 'sendFollowUpMessage'), false);
});
