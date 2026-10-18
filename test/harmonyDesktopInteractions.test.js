import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve('HarmonyCodexRemote/entry/src/main/ets');
const index = fs.readFileSync(path.join(root, 'pages/Index.ets'), 'utf8');
const client = fs.readFileSync(path.join(root, 'services/BridgeClient.ets'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'components/SessionInteractionPanel.ets'), 'utf8');

function methodBody(source, name) {
  const match = new RegExp(`^\\s*(?:private\\s+|static\\s+)?(?:async\\s+)?${name}\\s*\\(`, 'm').exec(source);
  assert.ok(match, `missing method ${name}`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}' && --depth === 0) return source.slice(open + 1, cursor);
  }
  assert.fail(`unterminated method ${name}`);
}

function compile(source, name, args = '', dependencies = {}, async = false) {
  const code = stripTypeScriptTypes(`${async ? 'async ' : ''}function run(${args}) {${methodBody(source, name)}}`);
  return new Function(...Object.keys(dependencies), `${code}; return run;`)(...Object.values(dependencies));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function interaction(id = 'request-1', kind = 'approval') {
  return { id, threadId: 'thread-a', kind, status: 'pending', title: id, detail: 'command + permissions',
    supportsResponse: true, questions: kind === 'user-input' ? [{ id: 'q', question: 'Choose?', options: null }] : [] };
}

function state(api = {}) {
  const bridge = { listDesktopInteractions: async () => [], respondDesktopInteraction: async () => {}, ...api };
  const value = {
    selectedSession: { id: 'thread-a' }, isNewSessionDraft: false, navigation: { revision: 1, mode: 'session', sessionId: 'thread-a' },
    desktopInteractions: [], desktopInteractionRefreshSeq: 0, desktopInteractionError: '', interactionSubmitError: '',
    interactionBusyKeys: [], userInputAnswers: {}, isBusy: true, message: 'untouched', bridgeToken: '',
    normalizedBridgeUrl: () => 'https://bridge', errorText: error => error.message,
    readSessionNavigation() { return { ...this.navigation }; },
    isSessionNavigationCurrent(revision, id) {
      return this.navigation.revision === revision && this.navigation.mode === 'session' && this.navigation.sessionId === id;
    },
    selectedVisibleTask: () => null, approvalContextTask: () => null, pendingUserInput: () => null, log() {}
  };
  for (const [name, args, async] of [
    ['desktopInteractionSessionId', ''], ['visibleDesktopInteractions', ''],
    ['refreshDesktopInteractions', '', true], ['respondDesktopInteraction', 'request, decision', true],
    ['isInteractionBusy', 'source, threadId, requestId'], ['setInteractionBusy', 'source, threadId, requestId, busy'],
    ['interactionAnswer', 'source, threadId, requestId, questionId'],
    ['setInteractionAnswer', 'source, threadId, requestId, questionId, value'],
    ['clearInteractionAnswers', 'source, threadId, requestId'],
    ['setDesktopInteractionAnswer', 'request, questionId, value'],
    ['userInputAnswer', 'questionId'], ['setUserInputAnswer', 'questionId, value'], ['canAnswerPendingUserInput', ''],
    ['answerPendingUserInput', '', true],
    ['refreshInteractionTask', 'task, navigationRevision', true]
  ]) {
    value[name] = compile(index, name, args, { BridgeClient: bridge }, async);
  }
  return value;
}

test('current conversation reaches both desktop interactions and legacy question form in a bounded scroll', () => {
  const conversation = methodBody(index, 'SessionConversationPanel');
  assert.equal((conversation.match(/this\.SessionPendingInteractions\(\)/g) ?? []).length, 2);
  const body = methodBody(index, 'SessionPendingInteractions');
  assert.match(body, /SessionInteractionPanel\(/);
  assert.match(body, /this\.UserInputForm\(\)/);
  assert.match(body, /Scroll\(\)/);
  assert.match(body, /constraintSize\(\{ maxHeight:/);
  assert.doesNotMatch(methodBody(index, 'SessionFloatingStatusPanel'), /Button\('同意'\)/);
  assert.doesNotMatch(panel, /maxLines|TextOverflow\.Ellipsis/);
  assert.match(methodBody(index, 'refreshDashboard'), /refreshDesktopInteractions\(\)/);
  assert.match(methodBody(index, 'refreshSelectedSessionDetail'), /refreshDesktopInteractions\(\)/);
  assert.match(methodBody(index, 'loadSessionDetail'), /refreshDesktopInteractions\(\)/);
});

test('desktop APIs encode thread and request IDs and require an explicit resolved receipt', async () => {
  const calls = [];
  let raw = '{"requests":[]}';
  const bridge = { request: async (...args) => { calls.push(args); return raw; } };
  const dependencies = { BridgeClient: bridge, http: { RequestMethod: { GET: 'GET', POST: 'POST' } } };
  const list = compile(client, 'listDesktopInteractions', 'baseUrl, threadId, token', dependencies, true);
  const respond = compile(client, 'respondDesktopInteraction', 'baseUrl, requestId, response, token', dependencies, true);
  assert.deepEqual(await list('https://bridge', 'thread /?&', 'token'), []);
  assert.equal(calls[0][1], 'https://bridge/api/desktop-interactions?threadId=thread%20%2F%3F%26');
  raw = '{}';
  await assert.rejects(list('https://bridge', 'thread', ''), /没有返回桌面待处理请求/);
  for (const invalid of ['{}', '{"resolved":false}', '{"resolved":"true"}']) {
    raw = invalid;
    await assert.rejects(respond('https://bridge', 'request /?', { threadId: 'thread', decision: 'denied' }, ''), /没有确认处理成功/);
  }
  raw = '{"resolved":true}';
  await respond('https://bridge', 'request /?', { threadId: 'thread', decision: 'approved' }, 'token');
  const call = calls.at(-1);
  assert.equal(call[1], 'https://bridge/api/desktop-interactions/request%20%2F%3F');
  assert.deepEqual(JSON.parse(call[2]), { threadId: 'thread', decision: 'approved' });
});

test('desktop list works without a bridge task and filters other threads and settled requests', async () => {
  const value = state({ listDesktopInteractions: async () => [
    interaction(), { ...interaction('foreign'), threadId: 'thread-b' }, { ...interaction('settled'), status: 'resolved' }
  ] });
  await value.refreshDesktopInteractions();
  assert.deepEqual(value.visibleDesktopInteractions().map(request => request.id), ['request-1']);
  value.navigation.sessionId = 'thread-b';
  assert.deepEqual(value.visibleDesktopInteractions(), []);
});

test('navigation revision rejects an old response even after switching away and back', async () => {
  const pending = deferred();
  const value = state({ listDesktopInteractions: () => pending.promise });
  const refresh = value.refreshDesktopInteractions();
  value.navigation.revision = 3;
  value.desktopInteractions = [interaction('current')];
  pending.resolve([interaction('old')]);
  await refresh;
  assert.equal(value.desktopInteractions[0].id, 'current');
});

test('newer poll wins over an older fetch and stale failures do not overwrite it', async () => {
  const first = deferred();
  let count = 0;
  const value = state({ listDesktopInteractions: () => ++count === 1 ? first.promise : Promise.resolve([interaction('fresh')]) });
  const old = value.refreshDesktopInteractions();
  await value.refreshDesktopInteractions();
  first.reject(new Error('old outage'));
  await old;
  assert.equal(value.desktopInteractions[0].id, 'fresh');
  assert.equal(value.desktopInteractionError, '');
});

test('answers are isolated by source, thread, request and question, including separator characters', () => {
  const value = state();
  for (const source of ['desktop', 'bridge']) {
    for (const id of ['r:1', 'r']) value.setInteractionAnswer(source, 'thread-a', id, 'q', source + id);
  }
  value.setInteractionAnswer('desktop', 'thread-b', 'r', 'q', 'other thread');
  value.setInteractionAnswer('desktop', 'thread-a', 'r', 'other', 'other question');
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'r:1', 'q'), 'desktopr:1');
  value.clearInteractionAnswers('desktop', 'thread-a', 'r');
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'r', 'q'), '');
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'r:1', 'q'), 'desktopr:1');
  assert.equal(value.interactionAnswer('bridge', 'thread-a', 'r', 'q'), 'bridger');
  assert.equal(value.interactionAnswer('desktop', 'thread-b', 'r', 'q'), 'other thread');
});

test('each request has independent busy state and duplicate clicks dispatch only once', async () => {
  const pending = deferred();
  const calls = [];
  const value = state({ respondDesktopInteraction: (...args) => { calls.push(args); return pending.promise; } });
  const a = interaction('a');
  const b = interaction('b');
  value.desktopInteractions = [a, b];
  const submit = value.respondDesktopInteraction(a, 'approved');
  assert.equal(value.isInteractionBusy('desktop', 'thread-a', 'a'), true);
  assert.equal(value.isInteractionBusy('desktop', 'thread-a', 'b'), false);
  await value.respondDesktopInteraction(a, 'denied');
  assert.equal(calls.length, 1);
  const second = value.respondDesktopInteraction(b, 'denied');
  assert.equal(calls.length, 2);
  assert.equal(value.message, 'untouched');
  pending.resolve();
  await Promise.all([submit, second]);
  assert.deepEqual(value.interactionBusyKeys, []);
});

test('failed submission retains answers, displays the error and rereads pending state', async () => {
  let polls = 0;
  const request = interaction('ask', 'user-input');
  const value = state({
    respondDesktopInteraction: async () => { throw new Error('desktop refused'); },
    listDesktopInteractions: async () => { polls++; return [request]; }
  });
  value.desktopInteractions = [request];
  value.setDesktopInteractionAnswer(request, 'q', 'answer');
  await value.respondDesktopInteraction(request, '');
  assert.match(value.interactionSubmitError, /desktop refused/);
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'ask', 'q'), 'answer');
  assert.equal(value.message, 'untouched');
  assert.equal(polls, 1);
  assert.equal(value.desktopInteractions.length, 1);
  assert.deepEqual(value.interactionBusyKeys, []);
});

test('successful question submission sends only its own answers and clears only that request', async () => {
  const calls = [];
  const request = interaction('ask', 'user-input');
  const value = state({ respondDesktopInteraction: async (...args) => { calls.push(args); } });
  value.desktopInteractions = [request];
  value.setDesktopInteractionAnswer(request, 'q', '  selected  ');
  value.setInteractionAnswer('desktop', 'thread-a', 'other', 'q', 'keep');
  value.setInteractionAnswer('bridge', 'thread-a', 'ask', 'q', 'keep legacy');
  await value.respondDesktopInteraction(request, '');
  assert.deepEqual(calls[0][2], { threadId: 'thread-a', answers: { q: ['selected'] } });
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'ask', 'q'), '');
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'other', 'q'), 'keep');
  assert.equal(value.interactionAnswer('bridge', 'thread-a', 'ask', 'q'), 'keep legacy');
});

test('unsupported, nonrespondable, empty, incomplete and no longer visible requests never submit', async () => {
  let calls = 0;
  const value = state({ respondDesktopInteraction: async () => { calls++; } });
  for (const request of [
    interaction('unsupported', 'unsupported'), { ...interaction('disabled'), supportsResponse: false },
    { ...interaction('empty', 'user-input'), questions: [] }, interaction('unanswered', 'user-input')
  ]) {
    value.desktopInteractions = [request];
    await value.respondDesktopInteraction(request, 'approved');
  }
  const expired = interaction('expired');
  value.desktopInteractions = [];
  await value.respondDesktopInteraction(expired, 'approved');
  assert.equal(calls, 0);
  assert.match(panel, /此请求需要在电脑处理/);
});

test('late submit completion cannot change another session or erase its drafts', async () => {
  const pending = deferred();
  let polls = 0;
  const request = interaction('ask', 'user-input');
  const value = state({
    respondDesktopInteraction: () => pending.promise,
    listDesktopInteractions: async () => { polls++; return []; }
  });
  value.desktopInteractions = [request];
  value.setDesktopInteractionAnswer(request, 'q', 'draft');
  const submit = value.respondDesktopInteraction(request, '');
  value.navigation = { revision: 2, mode: 'session', sessionId: 'thread-b' };
  value.selectedSession = { id: 'thread-b' };
  value.message = 'new session';
  pending.resolve();
  await submit;
  assert.equal(value.message, 'new session');
  assert.equal(value.interactionAnswer('desktop', 'thread-a', 'ask', 'q'), 'draft');
  assert.equal(polls, 0);
  assert.deepEqual(value.interactionBusyKeys, []);
});

test('legacy answers remain usable while unrelated global work is busy and cannot leak across requests', () => {
  const value = state();
  let request = { ...interaction('legacy-one', 'user-input'), threadId: 'thread-a' };
  value.pendingUserInput = () => request;
  value.setUserInputAnswer('q', 'one');
  assert.equal(value.isBusy, true);
  assert.equal(value.canAnswerPendingUserInput(), true);
  request = { ...request, id: 'legacy-two' };
  assert.equal(value.userInputAnswer('q'), '');
  assert.equal(value.canAnswerPendingUserInput(), false);
  value.setUserInputAnswer('q', 'two');
  value.setInteractionBusy('desktop', 'thread-a', 'something', true);
  assert.equal(value.canAnswerPendingUserInput(), true);
  value.setInteractionBusy('bridge', 'thread-a', 'legacy-two', true);
  assert.equal(value.canAnswerPendingUserInput(), false);
});

test('legacy submission uses scoped busy state and ignores a late result after navigation', async () => {
  const pending = deferred();
  const calls = [];
  const value = state({ answerUserInput: (...args) => { calls.push(args); return pending.promise; } });
  const request = { ...interaction('legacy', 'user-input'), threadId: 'thread-a' };
  value.pendingUserInput = () => request;
  value.setUserInputAnswer('q', 'draft');
  const submit = value.answerPendingUserInput();
  assert.equal(value.isInteractionBusy('bridge', 'thread-a', request.id), true);
  assert.deepEqual(calls[0][2], { q: ['draft'] });
  value.navigation.revision += 1;
  pending.resolve();
  await submit;
  assert.equal(value.message, 'untouched');
  assert.equal(value.userInputAnswer('q'), 'draft');
  assert.deepEqual(value.interactionBusyKeys, []);
});

test('legacy task reread cannot update state when navigation changes during that reread', async () => {
  const pending = deferred();
  const task = { id: 'run-1', status: 'waiting_input' };
  const value = state({ getCodexRun: () => pending.promise });
  value.currentTask = task;
  value.taskUsesCodexRunApi = () => true;
  value.currentTaskEventCursor = () => 0;
  value.mergeTaskEventPage = (old, next) => next;
  value.syncSessionTaskMarkers = () => assert.fail('stale task markers must not apply');
  value.startPolling = () => assert.fail('stale result must not restart polling');
  const refresh = value.refreshInteractionTask(task, 1);
  value.navigation.revision = 2;
  pending.resolve({ id: 'run-1', status: 'running' });
  await refresh;
  assert.equal(value.currentTask, task);
});

test('question panel reads the exact scoped answers produced by Index and independently gates submission', () => {
  const value = state();
  const request = interaction('ask', 'user-input');
  value.setInteractionAnswer('desktop', 'thread-a', 'ask', 'q', 'selected');
  const component = {
    request, answers: value.userInputAnswers, busy: false,
    answer: compile(panel, 'answer', 'questionId'),
    canRespond: compile(panel, 'canRespond'),
    canSubmitAnswers: compile(panel, 'canSubmitAnswers')
  };
  assert.equal(component.canSubmitAnswers(), true);
  component.busy = true;
  assert.equal(component.canSubmitAnswers(), false);
  component.busy = false;
  component.request = { ...request, id: 'another' };
  assert.equal(component.answer('q'), '');
  assert.equal(component.canSubmitAnswers(), false);
  component.request = { ...request, supportsResponse: false };
  assert.equal(component.canSubmitAnswers(), false);
});
