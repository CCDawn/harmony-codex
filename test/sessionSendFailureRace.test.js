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
  assert.ok(end > start, `${name} has a body`);
  return index.slice(start, end + '\n  }'.length);
}
const service = fs.readFileSync(new URL('services/OptimisticMessageService.ets', root), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
const methods = ['sendMessageToSelectedSession', 'sendNewSessionMessage', 'beginOptimisticSessionSend',
  'acknowledgeOptimisticSessionSend', 'restoreUnsentSessionAttachments', 'rememberPendingSessionSend', 'recordSessionInputAcknowledgements',
  'isSubmittedOutboxReceipt', 'guard', 'rememberFailedSessionMessageAfterSendFailure',
  'completeOptimisticSessionSend', 'isFailedSessionRetryCanceled', 'isBridgeRequestTimeout'].map(method).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const image = id => ({ id, uri: `file://${id}.png`, fileName: `${id}.png`, mimeType: 'image/png' });
const file = id => ({ id, uri: `file://${id}.md`, fileName: `${id}.md`, mimeType: 'text/markdown', bytes: 12 });
const composer = page => plain({ text: page.sessionMessage, images: page.pendingSessionImages, files: page.pendingSessionFiles });
function writeDraft(page, id) {
  page.sessionMessage = `${id} unsent text`;
  page.pendingSessionImages = [image(id)];
  page.pendingSessionFiles = [file(id)];
}

function setup(isNew) {
  let rejectRequest, enterRequest;
  const requestEntered = new Promise(resolve => { enterRequest = resolve; });
  const response = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const bridgeSend = () => { enterRequest(); return response; };
  const context = vm.createContext({ BridgeClient: { sendCodexThreadMessage: bridgeSend, startCodexThread: bridgeSend } });
  vm.runInContext(stripTypeScriptTypes(`${service}\nclass Page { ${methods} }\nglobalThis.Page = Page;`), context);
  const page = new context.Page();
  const effects = { retryScheduled: [], clearedRetryTimers: [] };
  Object.assign(page, {
    selectedSession: isNew ? null : { id: 'A', title: 'Session A', entries: [] }, isNewSessionDraft: isNew,
    navigation: { revision: 1, mode: isNew ? 'new' : 'session', sessionId: isNew ? '' : 'A' },
    selectedProjectId: 'project-A', sessionModel: '', sessionReasoningEffort: '', sessionServiceTier: '',
    bridgeToken: '', currentTask: null, optimisticSessionMessages: [], pendingSessionSendsByTaskId: {},
    failedSessionMessages: [], canceledFailedSessionRetryIds: [], failedSessionAutoRetryLimit: 3,
    tryRunSlashCommandFromComposer: () => false, canSendSessionMessage: () => true,
    readSessionNavigation() { return this.navigation; }, normalizedBridgeUrl: () => 'http://bridge',
    selectedSessionFingerprint: () => ({ filePath: 'C:/sessions/A.jsonl', entryCount: 0 }),
    hasRunningTaskForSession: () => false, submissionIdForRetry: () => 'submission-A',
    // Guard and failure recording above are real; isolate transport, upload and UI effects.
    currentSessionDraftScope: () => null, async requiresDesktopLiveForSend() { return false; },
    async recoverAfterGuardError() { return false; }, errorText: error => error.message,
    async composeOutgoingSessionMessage(text, images, files) {
      return { text, uploadedImages: images, uploadedFiles: files, failedImages: [], failedFiles: [] };
    },
    clearLocalRunningOverride() {}, applyTaskExecutionContract() {}, rememberTaskForSession() {},
    markSessionRunning() {}, dismissSessionKeyboardAfterSend() {}, scrollSessionToBottom() {}, scrollSessionToBottomIfFollowing() {},
    startPolling() {}, syncSessionTaskMarkers() {}, reconcileVisibleSessionMessages() {},
    taskSessionId: task => task.codexSessionId || '', log() {}, removeCanceledFailedSessionRetryId() {},
    scheduleFailedSessionAutoRetry(id) { effects.retryScheduled.push(id); },
    clearFailedSessionRetryTimer(id) { effects.clearedRetryTimers.push(id); },
    updateFailedSessionMessage() { assert.fail('initial failures and canceled retries must not update another failure'); },
    async settleSubmittedOutboxReceipt() { assert.fail('rejected requests have no submitted receipt'); }
  });
  writeDraft(page, 'submitted-A');
  return { page, effects, requestEntered, rejectRequest,
    send: () => isNew ? page.sendNewSessionMessage() : page.sendMessageToSelectedSession() };
}

test('late send rejection preserves the current composer and retains only the submitted message for retry', async t => {
  for (const isNew of [false, true]) {
    for (const navigate of [false, true]) {
      await t.test(`${isNew ? 'new' : 'existing'} conversation; ${navigate ? 'switched to B' : 'next draft in same composer'}`, async () => {
        const { page, effects, send, requestEntered, rejectRequest } = setup(isNew);
        const submitted = composer(page);
        const sending = send();
        await requestEntered;
        assert.deepEqual(composer(page), { text: '', images: [], files: [] }, 'optimistic send already consumed the original input');
        if (navigate) {
          page.navigation = { revision: 2, mode: 'session', sessionId: 'B' };
          page.selectedSession = { id: 'B', title: 'Session B', entries: [] };
          page.isNewSessionDraft = false;
          page.currentTask = { id: 'run-B', codexSessionId: 'B', status: 'running' };
        }
        writeDraft(page, navigate ? 'B' : 'next-message');
        const nextDraft = composer(page);
        const nextTask = page.currentTask;
        rejectRequest(new Error('fixture transport failure'));
        assert.equal(await sending, false);
        assert.deepEqual(composer(page), nextDraft, 'the failed earlier submission must preserve all later text and attachments');
        assert.equal(page.currentTask, nextTask, 'an earlier send failure must preserve the visible task');
        assert.equal(page.failedSessionMessages.length, 1);
        const failed = plain(page.failedSessionMessages[0]);
        assert.equal(failed.sessionId, isNew ? '__new_session__' : 'A');
        assert.equal(failed.isNewSession, isNew);
        assert.equal(failed.projectId, 'project-A');
        assert.equal(failed.submissionId, 'submission-A');
        assert.equal(failed.text, submitted.text);
        assert.deepEqual(failed.images, submitted.images);
        assert.deepEqual(failed.files, submitted.files);
        assert.equal(failed.error, 'fixture transport failure');
        assert.equal(page.optimisticSessionMessages.length, 0, 'failure takes ownership from the earlier optimistic bubble');
        assert.deepEqual(effects.retryScheduled, [failed.id], 'only the failed earlier message is scheduled for retry');
      });
    }
  }
});

test('a canceled retry ignores its late failure without touching the current composer or scheduling another attempt', () => {
  const { page, effects } = setup(false);
  writeDraft(page, 'B');
  const nextDraft = composer(page);
  const failed = { id: 'failed-A', sessionId: 'A', retrying: false };
  page.failedSessionMessages = [failed];
  page.canceledFailedSessionRetryIds = [failed.id];
  page.rememberFailedSessionMessageAfterSendFailure({
    failedId: failed.id, sessionId: 'A', isNewSession: false, projectId: 'project-A',
    submissionId: 'submission-A', text: 'submitted fixture', images: [image('submitted-A')],
    files: [file('submitted-A')], error: 'fixture late retry failure'
  });
  assert.deepEqual(composer(page), nextDraft);
  assert.equal(page.failedSessionMessages.length, 1);
  assert.equal(page.failedSessionMessages[0], failed);
  assert.deepEqual(effects.retryScheduled, []);
  assert.deepEqual(effects.clearedRetryTimers, [failed.id]);
});
