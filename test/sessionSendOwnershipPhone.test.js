import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = new URL('../HarmonyCodexRemote/entry/src/main/ets/', import.meta.url);
const index = fs.readFileSync(new URL('pages/Index.ets', root), 'utf8');
function method(name) {
  const start = index.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `Index.ets method ${name}`);
  return index.slice(start, index.indexOf('\n  }', start) + 4);
}
const fields = index.split('\n').flatMap(line => {
  const m = line.match(/^  (?:@State )?(?:private )?([A-Za-z_$][\w$]*):\s*([^=]+?)\s*=\s*(.+);\s*$/);
  if (!m || !/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|''|""|\[\]|\{\}|new (?:Map|Set)(?:<[^;]+>)?\(\))$/.test(m[3].trim())) return [];
  return [`${m[1]}: ${m[2]} = ${m[3]};`];
}).join('\n');
const services = ['OptimisticMessageService', 'SessionDraftStore'].map(name =>
  fs.readFileSync(new URL(`services/${name}.ets`, root), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')).join('\n');
const names = ['sendMessageToSelectedSession', 'guard', 'beginOptimisticSessionSend', 'acknowledgeOptimisticSessionSend',
  'completeOptimisticSessionSend', 'rememberFailedSessionMessageAfterSendFailure', 'rememberPendingSessionSend',
  'handoffPendingSessionSend', 'clearPendingSessionSend', 'isSubmittedOutboxReceipt', 'isBridgeRequestTimeout',
  'settleSubmittedOutboxReceipt', 'rememberFailedSessionMessageForTerminalTask', 'taskFailureMessage', 'mergeTaskEventPage'];
if (/^  private (?:async )?recordSessionInputAcknowledgements\(/m.test(index)) names.push('recordSessionInputAcknowledgements');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const detail = (id, title = id) => ({ id, title, entries: [], sync: { filePath: `C:/${id}.jsonl` }, entryCount: 0 });
function setup() {
  const send = deferred(), read = deferred(), entered = deferred(), readEntered = deferred();
  const requests = [], scrolls = [];
  const context = vm.createContext({ BridgeClient: {
    getSession(...args) { readEntered.resolve(); return read.promise; },
    sendCodexThreadMessage(...args) { requests.push(args); entered.resolve(); return send.promise; }
  } });
  vm.runInContext(stripTypeScriptTypes(`${services}\nclass Page { ${fields} ${names.map(method).join('\n')} }\nglobalThis.Page=Page; globalThis.Drafts=SessionDraftStore;`), context);
  const page = Object.assign(new context.Page(), {
    selectedSession: detail('A'), isNewSessionDraft: false,
    navigation: { revision: 1, mode: 'session', sessionId: 'A' }, selectedProjectId: 'project-A',
    sessionMessage: 'send A', pendingSessionImages: [], pendingSessionFiles: [], optimisticSessionMessages: [],
    pendingSessionSendsByTaskId: {}, failedSessionMessages: [], sessionDraftStore: new context.Drafts(),
    sessionAutoFollowBottom: true, message: 'initial', currentTask: null, bridgeToken: 'token',
    readSessionNavigation() { return this.navigation; }, normalizedBridgeUrl: () => 'http://fixture.invalid',
    currentSessionDraftScope: () => ({ bridgeUrl: 'http://fixture.invalid', bridgeToken: 'token', sessionId: 'A', projectId: '' }),
    selectedSessionFingerprint: () => ({ filePath: 'C:/A.jsonl', entryCount: 0 }),
    sessionFingerprintFromDetail: value => ({ filePath: value.sync.filePath, entryCount: value.entryCount }),
    tryRunSlashCommandFromComposer: () => false, canSendSessionMessage: () => true, hasRunningTaskForSession: () => false,
    submissionIdForRetry: () => 'submission-A', createSessionSubmissionId: () => 'generated',
    async requiresDesktopLiveForSend() { assert.fail('send must not run runtime preflight'); },
    async ensureDesktopLiveReadyForSend() { assert.fail('send must not wait for desktop recovery'); },
    async composeOutgoingSessionMessage(text) { return { text, uploadedImages: [], uploadedFiles: [], failedImages: [], failedFiles: [] }; },
    async recoverAfterGuardError() { return false; }, restoreUnsentSessionAttachments() {},
    reconcileVisibleSessionMessages() {}, dismissSessionKeyboardAfterSend() {}, clearLocalRunningOverride() {},
    applyTaskExecutionContract() {}, rememberTaskForSession() {}, markSessionRunning() {}, startPolling() {},
    removeCanceledFailedSessionRetryId() {}, scheduleFailedSessionAutoRetry() {}, log() {}, errorText: error => error.message,
    taskSessionId: task => task.codexSessionId || '',
    scrollSessionToBottom() { this.sessionAutoFollowBottom = true; scrolls.push('bottom'); },
    scrollSessionToBottomIfFollowing() { if (this.sessionAutoFollowBottom) scrolls.push('following'); }
  });
  return { page, send, read, entered, readEntered, requests, scrolls };
}
const task = (id = 'task-A', submissionId = 'submission-A') => ({ id, submissionId, codexSessionId: 'A', status: 'running', prompt: 'send A', events: [] });
const switchToB = page => { page.navigation = { revision: 2, mode: 'session', sessionId: 'B' }; page.selectedSession = detail('B'); page.message = 'B message'; };

test('send acknowledgement preserves manual scroll detachment', async () => {
  const h = setup(), sending = h.page.sendMessageToSelectedSession();
  await h.entered.promise;
  assert.deepEqual(h.scrolls, ['bottom']);
  h.page.sessionAutoFollowBottom = false;
  h.send.resolve(task());
  assert.equal(await sending, true);
  assert.equal(h.page.sessionAutoFollowBottom, false);
  assert.deepEqual(h.scrolls, ['bottom']);
});

test('send failure after switching to B retains A failure without changing B message or scroll', async () => {
  const h = setup(), sending = h.page.sendMessageToSelectedSession();
  await h.entered.promise;
  switchToB(h.page);
  h.scrolls.length = 0;
  h.send.reject(new Error('A send failed'));
  assert.equal(await sending, false);
  assert.equal(h.page.message, 'B message');
  assert.deepEqual(h.scrolls, []);
  assert.equal(h.page.failedSessionMessages.length, 1);
  assert.equal(h.page.failedSessionMessages[0].sessionId, 'A');
  assert.equal(h.page.failedSessionMessages[0].text, 'send A');
  assert.match(h.page.failedSessionMessages[0].error, /A send failed/);
});

for (const change of ['same-session update', 'A-B-A navigation']) {
  test(`fingerprint verification cannot overwrite ${change} and submission still targets A`, async () => {
    const h = setup(); h.page.selectedSessionFingerprint = () => null;
    const sending = h.page.sendMessageToSelectedSession();
    await h.readEntered.promise;
    if (change === 'A-B-A navigation') {
      switchToB(h.page);
      h.page.navigation = { revision: 3, mode: 'session', sessionId: 'A' };
    }
    const latest = detail('A', 'newer visible A'); latest.entries = [{ role: 'assistant', text: 'newer history' }];
    h.page.selectedSession = latest;
    h.read.resolve(detail('A', 'stale verification'));
    await h.entered.promise;
    assert.equal(h.requests[0][1], 'A');
    assert.equal(h.page.selectedSession, latest);
    h.send.resolve(task());
    assert.equal(await sending, true);
    assert.equal(h.page.selectedSession, latest);
    assert.equal(h.page.selectedSession.entries[0].text, 'newer history');
  });
}

test('fingerprint read after switching to B still submits captured A without changing B', async () => {
  const h = setup();
  const retries = [];
  h.page.selectedSessionFingerprint = () => null;
  h.page.scheduleFailedSessionAutoRetry = id => retries.push(id);
  const sending = h.page.sendMessageToSelectedSession();
  await h.readEntered.promise;
  switchToB(h.page);
  const visibleB = detail('B', 'visible B');
  visibleB.entries = [{ role: 'assistant', text: 'B history' }];
  h.page.selectedSession = visibleB;
  h.page.sessionMessage = 'B draft';
  const taskB = { ...task('task-B'), codexSessionId: 'B' };
  h.page.currentTask = taskB;
  h.read.resolve(detail('A', 'fingerprint read'));
  const reachedQueue = await Promise.race([h.entered.promise.then(() => true), sending.then(() => false)]);
  assert.equal(reachedQueue, true, 'the captured A submission must reach the queue');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1], 'A');
  assert.equal(h.requests[0][2], 'send A');
  assert.deepEqual(h.requests[0][5], { filePath: 'C:/A.jsonl', entryCount: 0 });
  assert.equal(h.requests[0][8], 'submission-A');
  h.send.resolve(task());
  assert.equal(await sending, true);
  assert.equal(h.page.selectedSession, visibleB);
  assert.equal(h.page.selectedSession.entries[0].text, 'B history');
  assert.equal(h.page.message, 'B message');
  assert.equal(h.page.sessionMessage, 'B draft');
  assert.equal(h.page.currentTask, taskB);
  assert.equal(h.page.failedSessionMessages.length, 0);
  assert.deepEqual(retries, []);
});

test('two outbox handoffs to the same live task retain and clear only their own submissions', () => {
  const { page } = setup();
  const pending = submissionId => ({ sessionId: 'A', isNewSession: false, projectId: 'project-A', submissionId,
    text: submissionId, images: [], files: [], retryFailedMessageId: '' });
  for (const id of ['one', 'two']) {
    page.beginOptimisticSessionSend('A', false, 'project-A', id, id, [], [], '');
    page.acknowledgeOptimisticSessionSend(id, task(`outbox-${id}`, id), id);
    page.rememberPendingSessionSend(`outbox-${id}`, pending(id));
    page.handoffPendingSessionSend(`outbox-${id}`, task('shared-live', id));
  }
  const submissions = () => {
    const value = page.pendingSessionSendsByTaskId['shared-live'];
    return (Array.isArray(value) ? value : value ? [value] : []).map(item => item.submissionId).sort();
  };
  assert.deepEqual(Array.from(submissions()), ['one', 'two']);
  page.clearPendingSessionSend('shared-live', 'one');
  assert.deepEqual(Array.from(submissions()), ['two']);
  page.clearPendingSessionSend('shared-live', 'two');
  assert.deepEqual(Array.from(submissions()), []);
});


test('a submitted receipt clears only its own shared-task context', async () => {
  const { page } = setup();
  const removed = [];
  page.removeFailedSessionMessage = id => removed.push(id);
  for (const id of ['one', 'two']) page.rememberPendingSessionSend('shared-live', {
    sessionId: 'A', isNewSession: false, projectId: 'project-A', submissionId: id,
    text: id, images: [], files: [], retryFailedMessageId: `failed-${id}`
  });
  await page.settleSubmittedOutboxReceipt({ ...task('shared-live', 'one'), status: 'submitted',
    runtime: { kind: 'durable_outbox', state: 'submitted' } });
  const value = page.pendingSessionSendsByTaskId['shared-live'];
  const remaining = (Array.isArray(value) ? value : value ? [value] : []).map(item => item.submissionId);
  assert.deepEqual(Array.from(remaining), ['two']);
  assert.deepEqual(removed, ['failed-one']);
});

test('failure after delivery to a running task does not restore confirmed input for automatic resend', () => {
  const { page } = setup();
  const scheduled = [];
  page.scheduleFailedSessionAutoRetry = id => scheduled.push(id);
  page.isFailedSessionRetryCanceled = () => false;
  page.failedSessionMessageHasCanonicalEntry = () => false;
  page.beginOptimisticSessionSend('A', false, 'project-A', 'one', 'delivered', [], [], '');
  page.acknowledgeOptimisticSessionSend('one', task('outbox-one', 'one'), 'delivered');
  page.rememberPendingSessionSend('outbox-one', { sessionId: 'A', isNewSession: false, projectId: 'project-A',
    submissionId: 'one', text: 'delivered', images: [], files: [], retryFailedMessageId: '' });
  page.handoffPendingSessionSend('outbox-one', task('live', 'one'));
  page.rememberFailedSessionMessageForTerminalTask({ ...task('live', 'one'), status: 'failed', events: [{ type: 'task.guidance.accepted', payload: { submissionId: 'one', turnId: 't' } }],
    createdAt: new Date().toISOString() });
  assert.equal(page.failedSessionMessages.length, 0);
  assert.deepEqual(scheduled, []);
});


test('a prior submission ACK does not confirm a later unacknowledged submission', () => {
  const { page } = setup();
  const scheduled = [];
  page.scheduleFailedSessionAutoRetry = id => scheduled.push(id);
  page.isFailedSessionRetryCanceled = () => false;
  page.failedSessionMessageHasCanonicalEntry = () => false;
  page.beginOptimisticSessionSend('A', false, 'project-A', 'two', 'later input', [], [], '');
  page.acknowledgeOptimisticSessionSend('two', task('outbox-two', 'two'), 'later input');
  page.rememberPendingSessionSend('outbox-two', { sessionId: 'A', isNewSession: false, projectId: 'project-A',
    submissionId: 'two', text: 'later input', images: [], files: [], retryFailedMessageId: '' });
  page.handoffPendingSessionSend('outbox-two', task('live', 'two'));
  page.rememberFailedSessionMessageForTerminalTask({ ...task('live', 'two'), status: 'failed',
    events: [{ type: 'task.guidance.accepted', payload: { submissionId: 'one', turnId: 't' } }],
    createdAt: new Date().toISOString() });
  assert.equal(page.failedSessionMessages.length, 0);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(Array.from(page.pendingSessionSendsByTaskId.live ?? [], item => item.submissionId), ['two']);
});


const nativeAck = submissionId => ({ id: `ack-${submissionId}`, type: 'task.guidance.accepted', taskId: 'live',
  payload: { submissionId, turnId: 't' } });
const pendingInput = id => ({ sessionId: 'A', isNewSession: false, projectId: 'project-A', submissionId: id,
  text: `input-${id}`, images: [], files: [], retryFailedMessageId: '' });

test('a native ACK survives an event gap and prevents a confirmed input from being resent', () => {
  const { page } = setup();
  const scheduled = [];
  page.scheduleFailedSessionAutoRetry = id => scheduled.push(id);
  page.isFailedSessionRetryCanceled = () => false;
  page.failedSessionMessageHasCanonicalEntry = () => false;
  page.rememberPendingSessionSend('live', pendingInput('one'));
  const before = { ...task('live', 'origin'), events: [nativeAck('one')] };
  const next = { ...task('live', 'origin'), status: 'failed', deliveryAttempted: true, eventGap: true,
    events: [{ id: 'failed', taskId: 'live', type: 'task.failed', payload: { message: 'generation failed' } }],
    createdAt: new Date().toISOString() };
  const merged = page.mergeTaskEventPage(before, next);
  assert.equal(merged.events.some(event => event.type === 'task.guidance.accepted'), false, 'fixture must actually lose the older event');
  page.rememberFailedSessionMessageForTerminalTask(merged);
  assert.equal(page.failedSessionMessages.length, 0);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(Array.from(page.pendingSessionSendsByTaskId.live ?? []), [], 'the known accepted submission can be released');
});

test('completion of a shared task clears accepted A but retains unconfirmed B', () => {
  const { page } = setup();
  const scheduled = [];
  page.scheduleFailedSessionAutoRetry = id => scheduled.push(id);
  page.isFailedSessionRetryCanceled = () => false;
  page.failedSessionMessageHasCanonicalEntry = () => false;
  page.rememberPendingSessionSend('live', pendingInput('one'));
  page.rememberPendingSessionSend('live', pendingInput('two'));
  const completed = { ...task('live', 'origin'), status: 'completed', deliveryAttempted: true,
    events: [nativeAck('one')], createdAt: new Date().toISOString() };
  page.rememberFailedSessionMessageForTerminalTask(completed);
  assert.deepEqual(Array.from(page.pendingSessionSendsByTaskId.live ?? [], item => item.submissionId), ['two']);
  assert.equal(page.failedSessionMessages.length, 0);
  assert.deepEqual(scheduled, []);
});

test('an explicit no-delivery failure can retain the input for safe automatic retry', () => {
  const { page } = setup();
  const scheduled = [];
  page.scheduleFailedSessionAutoRetry = id => scheduled.push(id);
  page.isFailedSessionRetryCanceled = () => false;
  page.failedSessionMessageHasCanonicalEntry = () => false;
  page.rememberPendingSessionSend('live', pendingInput('one'));
  page.rememberFailedSessionMessageForTerminalTask({ ...task('live', 'origin'), status: 'failed',
    deliveryAttempted: false, events: [], createdAt: new Date().toISOString() });
  assert.equal(page.failedSessionMessages.length, 1);
  assert.equal(page.failedSessionMessages[0].submissionId, 'one');
  assert.equal(scheduled.length, 1);
});


test('existing-session send reaches the queue with its captured target, fingerprint and submission identity', async () => {
  const h = setup();
  const sending = h.page.sendMessageToSelectedSession();
  await h.entered.promise;
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], 'http://fixture.invalid');
  assert.equal(h.requests[0][1], 'A');
  assert.deepEqual(h.requests[0][5], { filePath: 'C:/A.jsonl', entryCount: 0 });
  assert.equal(h.requests[0][8], 'submission-A');
  h.send.resolve({ ...task('outbox-A'), status: 'queued', runtime: { kind: 'durable_outbox', state: 'queued' } });
  assert.equal(await sending, true);
  assert.equal(h.page.currentTask.id, 'outbox-A');
});
