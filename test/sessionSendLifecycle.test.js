import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = new URL('../HarmonyCodexRemote/entry/src/main/ets/', import.meta.url);
const index = fs.readFileSync(new URL('pages/Index.ets', root), 'utf8');
function method(name) {
  const start = index.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `real Index.ets method ${name} exists`);
  const end = index.indexOf('\n  }', start);
  assert.ok(end > start);
  return index.slice(start, end + '\n  }'.length);
}
const services = ['OptimisticMessageService', 'SessionDraftStore'].map(name =>
  fs.readFileSync(new URL(`services/${name}.ets`, root), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')).join('\n');
const methods = ['sendMessageToSelectedSession', 'sendNewSessionMessage', 'beginOptimisticSessionSend',
  'acknowledgeOptimisticSessionSend', 'restoreUnsentSessionAttachments', 'rememberPendingSessionSend', 'recordSessionInputAcknowledgements',
  'isSubmittedOutboxReceipt', 'rememberFailedSessionMessageAfterSendFailure', 'completeOptimisticSessionSend',
  'guard', 'recoverAfterGuardError', 'isBridgeRequestTimeout', 'isEndedTaskInterruptConflict',
  'adoptTaskAfterSendTimeout', 'composeOutgoingSessionMessage', 'currentSessionDraftScope',
  'preserveCurrentSessionDraft', 'restoreSessionDraft', 'restoreCurrentSessionDraft', 'selectComposerProject',
  'retryFailedSessionMessage', 'beginFailedSessionRetryAttempt', 'updateFailedSessionMessage',
  'isFailedSessionRetryCanceled', 'visibleFailedSessionMessages'].map(method).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const image = id => ({ id, uri: `file://${id}.png`, fileName: `${id}.png`, mimeType: 'image/png' });
const file = id => ({ id, uri: `file://${id}.md`, fileName: `${id}.md`, mimeType: 'text/markdown', bytes: 12 });
const composer = page => plain({ text: page.sessionMessage, images: page.pendingSessionImages, files: page.pendingSessionFiles });
function writeDraft(page, id) {
  page.sessionMessage = `${id} fixture text`;
  page.pendingSessionImages = [image(`${id}-ok`), image(`${id}-fail`)];
  page.pendingSessionFiles = [file(`${id}-ok`), file(`${id}-fail`)];
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(isNew, { partial = false, pauseCompose = false, recovered = null, pauseTaskRead = false, pauseFirstUpload = false } = {}) {
  const entered = deferred(), response = deferred(), composeEntered = deferred(), composeReleased = deferred(), taskRead = deferred(), taskReleased = deferred();
  const uploadEntered = deferred(), uploadReleased = deferred();
  const requests = [], taskRequests = [], scheduled = [], uploads = [];
  const receivedTask = { id: 'run-A', projectId: 'project-A', submissionId: 'submission-A', status: 'running',
    codexSessionId: isNew ? 'created-A' : 'A', events: [] };
  const recoveredTasks = recovered === 'old' ? [{ ...receivedTask, id: 'old-run-A', submissionId: 'old-submission' }]
    : recovered === 'wrong-session' ? [{ ...receivedTask, codexSessionId: 'other' }]
      : recovered ? [receivedTask] : [];
  const bridgeSend = (...args) => { requests.push(args); entered.resolve(); return response.promise; };
  const upload = async (...args) => {
    const [_url, name] = args;
    uploads.push(args);
    if (uploads.length === 1) { uploadEntered.resolve(); if (pauseFirstUpload) await uploadReleased.promise; }
    if (partial && name.includes('-fail.')) throw new Error('fixture upload failed');
    return { messageText: `[fixture](${name})`, filePath: name, bytes: 12, mimeType: 'application/octet-stream' };
  };
  const context = vm.createContext({ BridgeClient: {
    sendCodexThreadMessage: bridgeSend, startCodexThread: bridgeSend,
    uploadMobileImage: upload, uploadMobileFile: upload,
    listTasks: async () => recoveredTasks,
    async getCodexRun(_url, id) {
      taskRequests.push(id); taskRead.resolve();
      if (pauseTaskRead) await taskReleased.promise;
      return recovered === 'wrong-detail' ? { ...receivedTask, submissionId: 'another-submission' } : recoveredTasks.find(t => t.id === id);
    }
  }, AttachmentService: { readAsBase64: () => 'Zml4dHVyZQ==' } });
  vm.runInContext(stripTypeScriptTypes(`${services}\nclass Page { ${methods} }\nglobalThis.Page = Page; globalThis.Drafts = SessionDraftStore;`), context);
  const page = new context.Page();
  Object.assign(page, {
    selectedSession: isNew ? null : { id: 'A', title: 'Session A', entries: [] }, isNewSessionDraft: isNew,
    navigation: { revision: 1, mode: isNew ? 'new' : 'session', sessionId: isNew ? '' : 'A' },
    selectedProjectId: 'project-A', sessionModel: 'model-A', sessionReasoningEffort: 'effort-A', sessionServiceTier: 'tier-A',
    bridgeToken: '', fixtureBridgeUrl: 'http://fixture.invalid', companionSelected: false, sessionDraftStore: new context.Drafts(),
    currentTask: null, optimisticSessionMessages: [], pendingSessionSendsByTaskId: {}, failedSessionMessages: [],
    taskTerminalHandledIds: [], taskTerminalPreviousStatusById: {}, failedSessionAutoRetryLimit: 3,
    canceledFailedSessionRetryIds: [], isBusy: false,
    tryRunSlashCommandFromComposer: () => false, canSendSessionMessage: () => true,
    readSessionNavigation() { return this.navigation; }, normalizedBridgeUrl() { return this.fixtureBridgeUrl; },
    selectedSessionFingerprint: () => ({ filePath: 'C:/fixtures/A.jsonl', entryCount: 0 }),
    hasRunningTaskForSession: () => false,
    submissionIdForRetry(id) { return this.failedSessionMessages.find(message => message.id === id)?.submissionId || 'submission-A'; },
    createSessionSubmissionId: () => 'attachment-only-submission',
    async requiresDesktopLiveForSend() { return false; },
    readPendingImageAsBase64: () => 'Zml4dHVyZQ==', rawSessionMessage: value => value,
    clearLocalRunningOverride() {}, applyTaskExecutionContract() {}, rememberTaskForSession() {},
    markSessionRunning() {}, dismissSessionKeyboardAfterSend() {}, scrollSessionToBottom() {}, scrollSessionToBottomIfFollowing() {},
    startPolling() { this.polls = (this.polls || 0) + 1; }, syncSessionTaskMarkers() {}, reconcileVisibleSessionMessages() {},
    taskSessionId: task => task.codexSessionId || task.createdCodexSessionId || '', log() {}, errorText: e => String(e?.message || e),
    removeCanceledFailedSessionRetryId() {}, scheduleFailedSessionAutoRetry(id) { scheduled.push(id); },
    clearFailedSessionRetryTimer() {}, pruneResolvedFailedSessionMessages() {},
    reconcileSessionTaskMonitor() {}, latestTaskSummaryForSession: tasks => tasks[0] || null,
    taskUsesCodexRunApi: () => true, handoffPendingSessionSend() {}, activeTaskTitleFromSummary: () => 'Fixture task',
    isTaskTerminalStatus: () => false,
    async settleSubmittedOutboxReceipt() { assert.fail('ordinary run fixture'); }
  });
  const compose = page.composeOutgoingSessionMessage.bind(page);
  page.composeOutgoingSessionMessage = async (...args) => {
    composeEntered.resolve(); if (pauseCompose) await composeReleased.promise;
    return compose(...args);
  };
  writeDraft(page, 'submitted-A');
  return { page, entered, response, composeEntered, composeReleased, taskRead, taskReleased, requests, taskRequests, scheduled,
    uploads, uploadEntered, uploadReleased,
    receivedTask, submitted: composer(page), originalScope: plain(page.currentSessionDraftScope()),
    send: () => isNew ? page.sendNewSessionMessage() : page.sendMessageToSelectedSession() };
}
function addRetry(s, isNew) {
  const record = { id: 'failed-A', sessionId: isNew ? '__new_session__' : 'A', isNewSession: isNew,
    projectId: 'project-A', submissionId: 'submission-A', text: 'retry fixture A',
    images: [image('retry-A')], files: [file('retry-A')], error: 'fixture failure', createdAt: new Date().toISOString(),
    retrying: false, retryCount: 0, retryLimit: 3, autoRetryEnabled: false, nextRetryAt: '' };
  s.page.failedSessionMessages = [record];
  return record;
}
function switchToB(page) {
  assert.equal(page.preserveCurrentSessionDraft(), true);
  page.navigation = { revision: 2, mode: 'session', sessionId: 'B' };
  page.selectedSession = { id: 'B', title: 'Session B', entries: [] };
  page.isNewSessionDraft = false;
  page.selectedProjectId = 'project-B'; page.sessionModel = 'model-B';
  page.sessionReasoningEffort = 'effort-B'; page.sessionServiceTier = 'tier-B';
  page.restoreCurrentSessionDraft(); writeDraft(page, 'B');
  page.currentTask = { id: 'run-B', status: 'running', codexSessionId: 'B' };
}

test('a new-conversation acknowledgement cannot claim another project draft with the same navigation revision', async () => {
  const s = setup(true); const sending = s.send(); await s.entered.promise;
  writeDraft(s.page, 'next-A');
  s.page.selectComposerProject('project-B');
  writeDraft(s.page, 'new-project-B');
  const draftB = composer(s.page), taskB = { id: 'project-B-task' };
  s.page.currentTask = taskB;
  assert.equal(s.page.navigation.revision, 1, 'real project selection does not navigate away from the new composer');
  s.response.resolve(s.receivedTask);
  assert.equal(await sending, true);
  assert.equal(s.page.currentTask, taskB);
  assert.deepEqual(composer(s.page), draftB);
  assert.equal(s.page.selectedProjectId, 'project-B');
  assert.equal(s.page.polls || 0, 0);
  assert.equal(s.page.optimisticSessionMessages[0].state, 'submitted');
  assert.equal(s.page.pendingSessionSendsByTaskId['run-A'][0].projectId, 'project-A');
});

for (const isNew of [false, true]) {
  const label = isNew ? 'new conversation' : 'existing conversation';
  for (const navigate of [false, true]) {
    test(`${label}: real retry wrapper cannot restore over ${navigate ? 'B after navigation' : 'a newer composer'} on failure`, async () => {
      const s = setup(isNew), retry = addRetry(s, isNew), previous = composer(s.page);
      const retrying = s.page.retryFailedSessionMessage(retry, 'manual'); await s.entered.promise;
      if (navigate) switchToB(s.page); else writeDraft(s.page, 'new-during-retry');
      const next = composer(s.page);
      s.response.reject(new Error('fixture retry rejected')); await retrying;
      assert.deepEqual(composer(s.page), next);
      assert.deepEqual(plain(s.page.sessionDraftStore.load(s.originalScope)), previous, 'original user draft stays under its own scope');
    });
  }
  test(`${label}: successful real retry consumes only its temporary attachments and keeps the existing user draft`, async () => {
    const s = setup(isNew), retry = addRetry(s, isNew), previous = composer(s.page);
    const retrying = s.page.retryFailedSessionMessage(retry, 'manual'); await s.entered.promise;
    s.response.resolve(s.receivedTask); await retrying;
    assert.deepEqual(composer(s.page), previous);
    assert.equal(s.uploads.length, 2, 'only retry image and retry file are uploaded');
    assert.deepEqual(s.uploads.map(args => args[1]), ['retry-A.png', 'retry-A.md']);
  });
  test(`${label}: successful real retry preserves a same-text newer draft and its new attachments`, async () => {
    const s = setup(isNew), retry = addRetry(s, isNew);
    const retrying = s.page.retryFailedSessionMessage(retry, 'manual'); await s.entered.promise;
    writeDraft(s.page, 'new-during-retry'); s.page.sessionMessage = retry.text;
    const next = composer(s.page); s.response.resolve(s.receivedTask); await retrying;
    assert.deepEqual(composer(s.page), next);
  });
  test(`${label}: every image and file upload uses the bridge snapshot captured before the first await`, async () => {
    const s = setup(isNew, { pauseFirstUpload: true });
    const sending = s.send(); await s.uploadEntered.promise;
    s.page.fixtureBridgeUrl = 'http://other-fixture.invalid'; s.page.bridgeToken = 'fixture-new-credential';
    s.uploadReleased.resolve(); await s.entered.promise;
    s.response.resolve(s.receivedTask); assert.equal(await sending, true);
    assert.equal(s.uploads.length, 4);
    assert.ok(s.uploads.every(args => args[0] === 'http://fixture.invalid' && args[4] === ''), 'all upload destinations and credentials must remain original');
    assert.equal(s.requests[0][0], 'http://fixture.invalid');
  });
  test(`${label}: submission and failure keep the original project and model settings across upload awaits`, async () => {
    const s = setup(isNew, { pauseCompose: true });
    const sending = s.send(); await s.composeEntered.promise;
    switchToB(s.page); s.composeReleased.resolve(); await s.entered.promise;
    const args = s.requests[0];
    assert.equal(args[isNew ? 1 : 3], 'project-A');
    if (isNew) { assert.equal(args[4], 'effort-A'); assert.equal(args[5], 'model-A'); assert.equal(args[7], 'tier-A'); }
    s.response.reject(new Error('fixture rejected'));
    assert.equal(await sending, false);
    assert.equal(s.page.failedSessionMessages[0].projectId, 'project-A');
  });

  test(`${label}: matching timeout recovery acknowledges its own message while preserving B`, async () => {
    const s = setup(isNew, { recovered: true, pauseTaskRead: true });
    const sending = s.send(); await s.entered.promise;
    s.response.reject(new Error('fixture operation timeout')); await s.taskRead.promise;
    switchToB(s.page); const draftB = composer(s.page), taskB = s.page.currentTask;
    s.taskReleased.resolve();
    assert.equal(await sending, true);
    assert.deepEqual(composer(s.page), draftB); assert.equal(s.page.currentTask, taskB);
    assert.equal(s.page.failedSessionMessages.length, 0);
    assert.equal(s.page.optimisticSessionMessages[0].state, 'submitted');
    assert.equal(s.page.optimisticSessionMessages[0].taskId, 'run-A');
    assert.equal(s.page.pendingSessionSendsByTaskId['run-A'][0].projectId, 'project-A');
    assert.equal(s.page.polls || 0, 0, 'late recovery cannot start polling over B');
  });

  test(`${label}: matching timeout recovery on its original page continues normal polling`, async () => {
    const s = setup(isNew, { recovered: true });
    const sending = s.send(); await s.entered.promise;
    s.response.reject(new Error('fixture timeout'));
    assert.equal(await sending, true); assert.equal(s.page.currentTask.id, 'run-A');
    assert.equal(s.page.optimisticSessionMessages[0].state, 'submitted');
    assert.equal(s.page.polls, 1); assert.equal(s.page.failedSessionMessages.length, 0);
  });

  for (const recovered of ['old', 'wrong-detail', ...(!isNew ? ['wrong-session'] : [])]) {
    test(`${label}: timeout cannot claim ${recovered} task`, async () => {
      const s = setup(isNew, { recovered }); const sending = s.send(); await s.entered.promise;
      switchToB(s.page); const taskB = s.page.currentTask;
      s.response.reject(new Error('fixture timed out'));
      assert.equal(await sending, false); assert.equal(s.page.currentTask, taskB);
      assert.equal(s.page.failedSessionMessages.length, 1);
      assert.equal(s.page.failedSessionMessages[0].projectId, 'project-A');
      if (recovered === 'old' || recovered === 'wrong-session') assert.deepEqual(s.taskRequests, []);
    });
  }

  test(`${label}: late partial-upload success restores failed attachment URIs to the original draft`, async () => {
    const s = setup(isNew, { partial: true }); const sending = s.send(); await s.entered.promise;
    writeDraft(s.page, 'next-A'); const nextA = composer(s.page); switchToB(s.page); const draftB = composer(s.page);
    s.response.resolve(s.receivedTask); assert.equal(await sending, true);
    assert.deepEqual(composer(s.page), draftB);
    const restored = plain(s.page.sessionDraftStore.load(s.originalScope));
    assert.equal(restored.text, nextA.text);
    assert.deepEqual(restored.images, nextA.images.concat(s.submitted.images[1]));
    assert.deepEqual(restored.files, nextA.files.concat(s.submitted.files[1]));
    assert.equal(s.page.failedSessionMessages.length, 0);
    assert.equal(s.page.pendingSessionSendsByTaskId['run-A'][0].projectId, 'project-A');
  });

  test(`${label}: a full draft store keeps failed attachments for manual retry without repeating delivered text`, async () => {
    const s = setup(isNew, { partial: true }); const sending = s.send(); await s.entered.promise;
    switchToB(s.page); const draftB = composer(s.page);
    for (let i = 0; i < 64; i++) assert.equal(s.page.sessionDraftStore.save({ ...s.originalScope, sessionId: `filled-${i}` },
      { text: 'capacity fixture', images: [], files: [] }), true);
    s.response.resolve(s.receivedTask); assert.equal(await sending, true);
    assert.deepEqual(composer(s.page), draftB);
    assert.equal(s.page.failedSessionMessages.length, 1);
    const recovery = plain(s.page.failedSessionMessages[0]);
    assert.equal(recovery.text, ''); assert.equal(recovery.projectId, 'project-A');
    assert.equal(recovery.sessionId, isNew ? '__new_session__' : 'A');
    assert.equal(recovery.autoRetryEnabled, false); assert.notEqual(recovery.submissionId, 'submission-A');
    assert.deepEqual(recovery.images, [s.submitted.images[1]]); assert.deepEqual(recovery.files, [s.submitted.files[1]]);
    assert.deepEqual(s.scheduled, []); assert.equal(s.page.optimisticSessionMessages[0].state, 'submitted');
  });
}

test('new-project attachment fallback stays hidden and cannot be retried from another project', async () => {
  const s = setup(true); s.page.selectedProjectId = 'project-B'; writeDraft(s.page, 'new-project-B');
  for (let i = 0; i < 64; i++) assert.equal(s.page.sessionDraftStore.save({ ...s.originalScope, sessionId: `full-${i}` },
    { text: 'capacity fixture', images: [], files: [] }), true);
  s.page.restoreUnsentSessionAttachments([s.submitted.images[1]], [s.submitted.files[1]], s.originalScope,
    '__new_session__', true, 'project-A');
  const record = s.page.failedSessionMessages[0], draftB = composer(s.page);
  assert.equal(s.page.visibleFailedSessionMessages().length, 0, 'A recovery must be hidden on the B new-project page');
  await s.page.retryFailedSessionMessage(record, 'manual');
  assert.deepEqual(s.requests, []); assert.deepEqual(composer(s.page), draftB);
  assert.equal(s.page.selectedProjectId, 'project-B'); assert.equal(record.retryCount, 0);
  s.page.selectedProjectId = 'project-A';
  assert.equal(s.page.visibleFailedSessionMessages()[0].id, record.id);
});

test('a real attachment-only capacity fallback retries once in its own project without leaving sent attachments in the composer', async () => {
  const s = setup(true); s.page.selectedProjectId = 'project-B'; writeDraft(s.page, 'new-project-B');
  for (let i = 0; i < 64; i++) s.page.sessionDraftStore.save({ ...s.originalScope, sessionId: `full-${i}` },
    { text: 'capacity fixture', images: [], files: [] });
  s.page.restoreUnsentSessionAttachments([s.submitted.images[1]], [s.submitted.files[1]], s.originalScope,
    '__new_session__', true, 'project-A');
  const recovery = s.page.failedSessionMessages[0];
  s.page.sessionDraftStore.remove({ ...s.originalScope, sessionId: 'full-0' });
  s.page.selectComposerProject('project-A');
  assert.deepEqual(composer(s.page), { text: '', images: [], files: [] });
  const retrying = s.page.retryFailedSessionMessage(recovery, 'manual'); await s.entered.promise;
  assert.deepEqual(composer(s.page), { text: '', images: [], files: [] }, 'temporary retry attachments are released before waiting');
  assert.equal(s.requests[0][1], 'project-A'); assert.equal(s.requests[0][6], recovery.submissionId);
  assert.equal(s.uploads.length, 2);
  s.response.resolve(s.receivedTask); await retrying;
  assert.deepEqual(composer(s.page), { text: '', images: [], files: [] }, 'the next ordinary message must not repeat the sent attachments');
});

test('direct composition callers also freeze their default bridge credentials across upload awaits', async () => {
  const s = setup(false, { pauseFirstUpload: true });
  const composing = s.page.composeOutgoingSessionMessage('direct fixture', s.submitted.images, s.submitted.files);
  await s.uploadEntered.promise;
  s.page.fixtureBridgeUrl = 'http://other-fixture.invalid'; s.page.bridgeToken = 'fixture-new-credential';
  s.uploadReleased.resolve(); const composed = await composing;
  assert.equal(composed.uploadedImages.length, 2); assert.equal(composed.uploadedFiles.length, 2);
  assert.ok(s.uploads.every(args => args[0] === 'http://fixture.invalid' && args[4] === ''));
});

test('retry composer ownership tolerates reactive arrays wrapping assigned snapshots', async () => {
  const s = setup(false), retry = addRetry(s, false), previous = composer(s.page);
  for (const name of ['pendingSessionImages', 'pendingSessionFiles']) {
    let observed = s.page[name];
    Object.defineProperty(s.page, name, {
      get: () => observed, set: value => { observed = new Proxy(value, {}); }, configurable: true
    });
  }
  const retrying = s.page.retryFailedSessionMessage(retry, 'manual'); await s.entered.promise;
  assert.deepEqual(composer(s.page), previous, 'reactive array wrappers must not retain borrowed retry attachments');
  s.response.resolve(s.receivedTask); await retrying;
  assert.deepEqual(composer(s.page), previous);
});
