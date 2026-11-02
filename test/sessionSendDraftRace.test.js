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
  'isSubmittedOutboxReceipt'].map(method).join('\n');
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
  let finishRequest, enterRequest;
  const requestEntered = new Promise(resolve => { enterRequest = resolve; });
  const response = new Promise(resolve => { finishRequest = resolve; });
  const requests = [];
  const bridgeSend = (...args) => { requests.push(args); enterRequest(); return response; };
  const context = vm.createContext({ BridgeClient: { sendCodexThreadMessage: bridgeSend, startCodexThread: bridgeSend } });
  vm.runInContext(stripTypeScriptTypes(`${service}\nclass Page { ${methods} }\nglobalThis.Page = Page;`), context);
  const page = new context.Page();
  Object.assign(page, {
    selectedSession: isNew ? null : { id: 'A', title: 'Session A', entries: [] }, isNewSessionDraft: isNew,
    navigation: { revision: 1, mode: isNew ? 'new' : 'session', sessionId: isNew ? '' : 'A' },
    selectedProjectId: 'project-A', sessionModel: '', sessionReasoningEffort: '', sessionServiceTier: '',
    bridgeToken: '', currentTask: null, optimisticSessionMessages: [], pendingSessionSendsByTaskId: {},
    tryRunSlashCommandFromComposer: () => false, canSendSessionMessage: () => true,
    readSessionNavigation() { return this.navigation; }, normalizedBridgeUrl: () => 'http://bridge',
    selectedSessionFingerprint: () => ({ filePath: 'C:/sessions/A.jsonl', entryCount: 0 }),
    hasRunningTaskForSession: () => false, submissionIdForRetry: () => 'submission-A',
    // These dependencies concern transport/UI effects; sends, optimistic ownership and attachment handling above are real.
    currentSessionDraftScope: () => null, async requiresDesktopLiveForSend() { return false; },
    async guard(_name, action) { await action(); return true; },
    async composeOutgoingSessionMessage(text, images, files) {
      return { text, uploadedImages: images, uploadedFiles: files, failedImages: [], failedFiles: [] };
    },
    clearLocalRunningOverride() {}, applyTaskExecutionContract() {}, rememberTaskForSession() {},
    markSessionRunning() {}, dismissSessionKeyboardAfterSend() {}, scrollSessionToBottom() {}, scrollSessionToBottomIfFollowing() {},
    startPolling() {}, syncSessionTaskMarkers() {}, reconcileVisibleSessionMessages() {},
    taskSessionId: task => task.codexSessionId || '', log() {},
    async settleSubmittedOutboxReceipt() { assert.fail('the response is an ordinary run, not an outbox receipt'); },
    rememberFailedSessionMessageAfterSendFailure() { assert.fail('successful Bridge response must not become send failure'); }
  });
  writeDraft(page, 'submitted-A');
  return { page, requests, requestEntered, finishRequest,
    send: () => isNew ? page.sendNewSessionMessage() : page.sendMessageToSelectedSession(),
    receivedTask: { id: 'run-A', status: 'running', codexSessionId: isNew ? 'created-A' : 'A', events: [] } };
}

test('late ordinary-run replies cannot replace B task state or erase B composer after navigation', async t => {
  for (const isNew of [false, true]) {
    await t.test(isNew ? 'new conversation send' : 'existing conversation send', async () => {
      const { page, send, requestEntered, finishRequest, receivedTask } = setup(isNew);
      const sending = send();
      await requestEntered;
      assert.deepEqual(composer(page), { text: '', images: [], files: [] }, 'optimistic send already cleared the submitted composer');
      page.navigation = { revision: 2, mode: 'session', sessionId: 'B' };
      page.selectedSession = { id: 'B', title: 'Session B', entries: [] };
      page.isNewSessionDraft = false;
      const taskB = { id: 'run-B', codexSessionId: 'B', status: 'running' };
      page.currentTask = taskB;
      writeDraft(page, 'B');
      const draftB = composer(page);
      finishRequest(receivedTask);
      assert.equal(await sending, true);
      assert.deepEqual(composer(page), draftB, 'A receipt must preserve all of B text and attachments');
      assert.equal(page.currentTask, taskB, 'A receipt must not replace B current task');
      assert.equal(page.selectedSession.id, 'B');
      assert.equal(page.optimisticSessionMessages[0].taskId, receivedTask.id, 'A receipt still acknowledges its own recoverable submission');
    });
  }
});

test('ordinary-run success preserves text and attachments typed after optimistic send cleared the composer', async t => {
  for (const isNew of [false, true]) {
    await t.test(isNew ? 'new conversation send' : 'existing conversation send', async () => {
      const { page, send, requestEntered, finishRequest, receivedTask } = setup(isNew);
      const sending = send();
      await requestEntered;
      assert.deepEqual(composer(page), { text: '', images: [], files: [] });
      writeDraft(page, 'next-message');
      const nextDraft = composer(page);
      finishRequest(receivedTask);
      assert.equal(await sending, true);
      assert.deepEqual(composer(page), nextDraft, 'the success response belongs to the earlier submitted input');
      assert.equal(page.currentTask.id, receivedTask.id);
      assert.equal(page.optimisticSessionMessages[0].text, 'submitted-A unsent text');
    });
  }
});

test('a late send acknowledgement cannot stop editing the next draft', async t => {
  for (const isNew of [false, true]) {
    await t.test(isNew ? 'new conversation send' : 'existing conversation send', async () => {
      const { page, send, requestEntered, finishRequest, receivedTask } = setup(isNew);
      let dismissals = 0;
      page.editingNextDraft = false;
      page.dismissSessionKeyboardAfterSend = () => {
        dismissals++;
        page.editingNextDraft = false;
      };
      const sending = send();
      await requestEntered;
      writeDraft(page, 'next-message');
      page.editingNextDraft = true;
      finishRequest(receivedTask);
      assert.equal(await sending, true);
      assert.equal(page.editingNextDraft, true, 'the earlier acknowledgement must not dismiss a newly focused composer');
      assert.equal(dismissals, 1, 'the original submit still dismisses its own keyboard once');
    });
  }
});
