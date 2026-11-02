import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = new URL('../HarmonyCodexRemote/entry/src/main/ets/', import.meta.url);
const index = fs.readFileSync(new URL('pages/Index.ets', root), 'utf8');
function method(name) {
  const start = index.search(new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `real Index.ets method ${name} exists`);
  const end = index.indexOf('\n  }', start);
  assert.ok(end > start, `real Index.ets method ${name} has a body`);
  return index.slice(start, end + '\n  }'.length);
}
const services = ['SessionDraftStore.ets', 'OptimisticMessageService.ets'].map(name =>
  fs.readFileSync(new URL(`services/${name}`, root), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')).join('\n');
const methods = ['currentSessionDraftScope', 'preserveCurrentSessionDraft', 'restoreSessionDraft',
  'restoreCurrentSessionDraft', 'selectComposerProject', 'openSession', 'returnToSessionHome',
  'startNewSessionDraft', 'readSessionNavigation', 'commitSessionNavigation', 'isSessionNavigationCurrent', 'normalizedBridgeUrl',
  'normalizedProjectRoot', 'onBackPress', 'closeAccountUsagePanel', 'beginOptimisticSessionSend',
  'refreshTask', 'applyTaskSessionSnapshot'].map(method).join('\n');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${services}\nclass Page { ${methods} }\nglobalThis.Page = Page; globalThis.Store = SessionDraftStore;`), context);

const plain = value => JSON.parse(JSON.stringify(value));
const image = { id: 'image-A', uri: 'file://A.png', fileName: 'A.png', mimeType: 'image/png' };
const file = { id: 'file-A', uri: 'file://A.md', fileName: 'A.md', mimeType: 'text/markdown', bytes: 234 };
const session = id => ({ id, entries: [], projectRoot: 'C:/project-A' });
const scope = (page, sessionId, projectId = '') => ({ bridgeUrl: page.normalizedBridgeUrl(),
  bridgeToken: page.bridgeToken, sessionId, projectId });
function composer(page) {
  return plain({ text: page.sessionMessage, images: page.pendingSessionImages, files: page.pendingSessionFiles });
}
function setComposer(page, text = 'A draft', images = [image], files = [file]) {
  page.sessionMessage = text;
  page.pendingSessionImages = plain(images);
  page.pendingSessionFiles = plain(files);
}
function setup() {
  const page = new context.Page();
  Object.assign(page, {
    bridgeUrl: 'http://bridge-one/', bridgeToken: 'pair-one', sessionDraftStore: new context.Store(),
    activeTab: 'sessions', activeSessionId: 'A', sessionNavigationState: JSON.stringify({ revision: 1, mode: 'session', sessionId: 'A' }),
    selectedSession: session('A'), selectedProjectId: 'project-A', isNewSessionDraft: false,
    sessionMessage: '', pendingSessionImages: [], pendingSessionFiles: [], optimisticSessionMessages: [],
    projects: [{ id: 'project-A', root: 'C:/project-A' }, { id: 'project-B', root: 'C:/project-B' }],
    companionSelected: false, companionComputerVisible: false, sessionDetailRequestSeq: 0,
    desktopInteractionRefreshSeq: 0, newSessionTaskId: '', sessionSidebarCollapsed: true,
    accountUsagePanelVisible: false, accountUsagePanelOpenedAt: 0, reasoningEffortMenuVisible: false,
    homeActionMenuVisible: false, composerActionMenuExpanded: false, slashCommandPanelVisible: false,
    markdownReaderDocument: null, outboxPanelVisible: false, voiceCallVisible: false, desktopMonitorVisible: false,
    tasks: [], message: '', log() {}, hasRunningSessionTask: () => false, hasOpenImagePreview: () => false,
    // Network and unrelated presentation effects are stubbed; draft and navigation methods above are real.
    leaveCompanionConversation() { this.companionSelected = false; }, closeSessionSwipe() {},
    applySessionActivitySnapshot() {}, async loadSessionDetail(id) { this.selectedSession = session(id); },
    async adoptSelectedSessionTaskFromSummaries() {}, syncTaskEventStream() {}, stopSessionEventStream() {}, stopTaskEventStream() {},
    async loadDesktopReasoningDefaults() {}, scrollSessionToBottom() {},
    errorText: error => error.message
  });
  return page;
}

test('real openSession restores text, images and files on A -> B -> A and through home', async () => {
  const page = setup();
  setComposer(page);
  const draftA = composer(page);
  await page.openSession(session('B'));
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  assert.equal(page.selectedSession.id, 'B');
  setComposer(page, 'B draft', [{ ...image, id: 'image-B' }], [{ ...file, id: 'file-B' }]);
  const draftB = composer(page);
  await page.openSession(session('A'));
  assert.deepEqual(composer(page), draftA);
  assert.equal(page.returnToSessionHome('test-home'), true);
  assert.equal(page.readSessionNavigation().mode, 'home');
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  await page.openSession(session('B'));
  assert.deepEqual(composer(page), draftB);
  await page.openSession(session('A'));
  assert.deepEqual(composer(page), draftA);
});

test('real new-session project selection restores each project draft independently', async () => {
  const page = setup();
  setComposer(page, 'existing A');
  page.startNewSessionDraft();
  assert.equal(page.selectedProjectId, 'project-A');
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  setComposer(page, 'new project A');
  const draftA = composer(page);
  page.selectComposerProject('project-B');
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  setComposer(page, 'new project B', [], [file]);
  const draftB = composer(page);
  page.selectComposerProject('project-A');
  assert.deepEqual(composer(page), draftA);
  page.selectComposerProject('project-B');
  assert.deepEqual(composer(page), draftB);
  assert.equal(page.returnToSessionHome('test-new-home'), true);
  page.startNewSessionDraft();
  assert.deepEqual(composer(page), draftB);
  await page.openSession(session('A'));
  assert.equal(page.sessionMessage, 'existing A');
});

test('new thread completion without a session snapshot promotes navigation and preserves the next draft', async () => {
  const page=setup();page.startNewSessionDraft();
  const task={id:'new-task',status:'completed',createdCodexSessionId:'created-thread',codexSessionId:'created-thread',events:[]};
  context.BridgeClient={getTask:async()=>task};
  Object.assign(page,{
    currentTask:{id:'new-task',status:'running',events:[]},taskTerminalPreviousStatusById:{},taskTerminalHandledIds:[],
    taskSessionId:t=>t.codexSessionId||t.createdCodexSessionId||'',currentTaskEventCursor:()=>0,
    taskUsesCodexRunApi:()=>false,handoffPendingSessionSend(){},isSubmittedOutboxReceipt:()=>false,
    mergeTaskEventPage:(_,next)=>next,currentTaskEventCount:()=>0,applyTaskExecutionContract(){},syncSessionTaskMarkers(){},
    statusLabel:s=>s,currentTaskSummaryText:()=>'',updateTaskPollCadence(){},
    isTaskTerminalStatus:s=>s==='completed',stopPolling(){},markSessionRunningLocallyCleared(){},
    async handleTaskTerminalForSession(){},async refreshSessions(){},async publishTaskAttentionNotification(){}
  });
  setComposer(page,'next message while first is completing',[],[]);
  await page.refreshTask();
  assert.equal(page.readSessionNavigation().mode,'session');
  assert.equal(page.readSessionNavigation().sessionId,'created-thread');
  assert.equal(page.currentSessionDraftScope().sessionId,'created-thread');
  assert.equal(page.isNewSessionDraft,false);
  assert.equal(page.returnToSessionHome('test-completed-home'),true);
  await page.openSession(session('created-thread'));
  assert.equal(page.sessionMessage,'next message while first is completing');
});

for (const overlay of ['accountUsagePanelVisible', 'reasoningEffortMenuVisible']) {
  test(`system back closes ${overlay} while preserving the selected session and its composer`, async () => {
    const page = setup();
    setComposer(page);
    const draftA = composer(page), selected = page.selectedSession, navigation = page.sessionNavigationState;
    page[overlay] = true;
    assert.equal(page.onBackPress(), true);
    assert.equal(page[overlay], false);
    assert.equal(page.selectedSession, selected);
    assert.equal(page.sessionNavigationState, navigation);
    assert.deepEqual(composer(page), draftA);
    // A later actual navigation still saves the untouched draft.
    await page.openSession(session('B'));
    await page.openSession(session('A'));
    assert.deepEqual(composer(page), draftA);
  });
}

for (const destination of ['session', 'home', 'new', 'project']) {
  test(`64 stored drafts refuse ${destination} navigation without losing the current unsaved composer`, async () => {
    const page = setup();
    if (destination === 'project') {
      page.selectedSession = null;
      page.isNewSessionDraft = true;
      page.commitSessionNavigation('new', '', 'test-initial-new');
    }
    for (let index = 0; index < 64; index++) {
      assert.equal(page.sessionDraftStore.save(scope(page, `stored-${index}`), { text: `stored-${index}`, images: [], files: [] }), true);
    }
    setComposer(page, 'unsaved at capacity');
    const before = composer(page), selected = page.selectedSession, navigation = page.sessionNavigationState;
    if (destination === 'session') await page.openSession(session('B'));
    if (destination === 'home') assert.equal(page.returnToSessionHome('capacity'), false);
    if (destination === 'new') page.startNewSessionDraft();
    if (destination === 'project') page.selectComposerProject('project-B');
    assert.equal(page.selectedSession, selected);
    assert.equal(page.sessionNavigationState, navigation);
    assert.equal(page.selectedProjectId, 'project-A');
    assert.deepEqual(composer(page), before);
    assert.match(page.message, /保存上限/);
    assert.equal(page.sessionDraftStore.load(scope(page, 'stored-0')).text, 'stored-0');
    assert.equal(page.sessionDraftStore.load(scope(page, 'stored-63')).text, 'stored-63');
  });
}

test('real optimistic/outbox handoff removes saved composer ownership and does not revive the draft on return', async () => {
  const page = setup();
  setComposer(page, 'send exactly once');
  const submitted = composer(page), target = page.currentSessionDraftScope();
  assert.equal(page.preserveCurrentSessionDraft(), true);
  assert.equal(page.sessionDraftStore.has(target), true);
  page.beginOptimisticSessionSend('A', false, 'project-A', 'submission-A', submitted.text,
    page.pendingSessionImages, page.pendingSessionFiles, '');
  assert.equal(page.sessionDraftStore.has(target), false);
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  await page.openSession(session('B'));
  await page.openSession(session('A'));
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  assert.equal(page.optimisticSessionMessages.length, 1);
  const pending = page.optimisticSessionMessages[0];
  assert.equal(pending.submissionId, 'submission-A');
  assert.equal(pending.sessionId, 'A');
  assert.equal(pending.text, submitted.text);
  assert.deepEqual(plain(pending.images), submitted.images);
  assert.deepEqual(plain(pending.files), submitted.files.map(({ id, fileName }) => ({ id, fileName })));
});

test('real page scopes restore the original pairing without exposing its draft to another token or URL', () => {
  const page = setup();
  setComposer(page);
  const original = composer(page);
  assert.equal(page.preserveCurrentSessionDraft(), true);
  page.bridgeToken = 'pair-two';
  page.restoreCurrentSessionDraft();
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  setComposer(page, 'second pairing');
  assert.equal(page.preserveCurrentSessionDraft(), true);
  page.bridgeUrl = 'http://bridge-two';
  page.restoreCurrentSessionDraft();
  assert.deepEqual(composer(page), { text: '', images: [], files: [] });
  page.bridgeUrl = 'http://bridge-one/';
  page.bridgeToken = 'pair-one';
  page.restoreCurrentSessionDraft();
  assert.deepEqual(composer(page), original);
});
