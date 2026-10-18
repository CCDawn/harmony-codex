import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const question = (id = 'question-message') => ({ id, type: 'agentMessage',
  questions: [{ title: 'Fixture question', options: ['A', 'B'] }] });
const turn = (status = 'inProgress', id = 'turn-1') => ({ turnId: id, status, items: [question()] });
const questionId = JSON.stringify(['request_user_input_async', 'question-message', 0]);

function harness(conversation) {
  const calls = [];
  const manager = { getHostId: () => 'local', async getConversation() { return conversation; } };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) {
    manager[name] = async (...args) => { calls.push({ name, args }); };
  }
  const managerFamily = {}, questionStateFamily = {};
  const questionStates = new Map();
  const owner = { familyBindings: new Map([
    [managerFamily, new Map([['local', { value: { get: () => manager } }]])],
    [questionStateFamily, questionStates]
  ]) };
  const window = { __codexRoot: { _internalRoot: { current: {
    tag: 10, memoizedProps: { value: new Map([['scope', owner]]) }
  } } } };
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  const source = 'class Registry{getForHostId(h){return this.scope.get(hosts).includes(h)?this.scope.get(managerFamily,h):null}};'
    + 'function skip(e,t){let n=e.get(questionState,t);e.set(questionState,t,{...n,isSkipped:!0})};'
    + 'export{managerFamily as liveManager,questionState as liveQuestionState}';
  let fetches = 0;
  const client = { hostId: 'local', async ensureConnected() {}, async evaluate(expression) {
    const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto',
      'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
    return run(window, document, async url => {
      fetches++;
      return { text: async () => url.endsWith('index.js') ? 'import "./app-initial-123abc.js";' : source };
    }, async () => ({ liveManager: managerFamily, liveQuestionState: questionStateFamily }), URL, { randomUUID });
  } };
  return { api: new DesktopInteractionClient(client), calls, window, get fetches() { return fetches; },
    setQuestionState(value, scope = {}) {
      // Match the official family's serialized scope keys, without depending on property order.
      const key = JSON.stringify({ entityKey: 'turn:turn-1', hostId: 'local', itemId: questionId,
        threadId: 'thread-1', ...scope });
      questionStates.set(key, { value: { get: () => value } });
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
