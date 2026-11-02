import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, `Index.ets method ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
// Preserve the real class defaults for primitive ownership counters and flags, including
// fields introduced by later implementations, without naming private implementation details.
const fields = source.split('\n').flatMap(line => {
  const match = line.match(/^  (?:@State )?(?:private )?([A-Za-z_$][\w$]*):\s*([^=]+?)\s*=\s*(.+);\s*$/);
  if (!match) return [];
  const value = match[3].trim();
  if (!/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|''|""|\[\]|\{\}|new (?:Map|Set)(?:<[^;]+>)?\(\))$/.test(value)) return [];
  return [`${match[1]}: ${match[2]} = ${value};`];
}).join('\n');
const names = ['openSession', 'startNewSessionDraft', 'readSessionNavigation', 'commitSessionNavigation', 'isSessionNavigationCurrent',
  'loadSessionDetail', 'isSessionDetailPending', 'beginSessionDetailSnapshotRead', 'normalizedProjectRoot', 'adoptSelectedSessionTaskFromSummaries',
  'adoptRunningTaskFromSummaries'];
const requests = [];
const context = vm.createContext({ earlierSessionRenderStartKey: rows => rows.length > 40 ? rows.at(-40).key : '', BridgeClient: { getSessionHistoryPage(...args) {
  return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
}, getTask(...args) {
  return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
}, getCodexRun(...args) {
  return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
}} });
vm.runInContext(stripTypeScriptTypes(`class Page { ${fields} ${names.map(method).join('\n')} }\nglobalThis.Page = Page;`), context);
const session = id => ({ id, title: id, projectRoot: '', entries: [], entryCount: 0 });
function setup() {
  requests.length = 0;
  return Object.assign(new context.Page(), {
    selectedSession: session('A'), activeSessionId: 'A', sessionNavigationState: JSON.stringify({ revision: 1, mode: 'session', sessionId: 'A' }),
    bridgeUrl: 'http://one', bridgeToken: 'token-one', sessionDetailRequestSeq: 0, sessionDetailSnapshotRevisions: new Map(),
    desktopInteractionRefreshSeq: 0, sessionStreamEntries: [], isNewSessionDraft: false, projects: [], tasks: [], currentTask: null,
    message: '', normalizedBridgeUrl() { return this.bridgeUrl; }, preserveCurrentSessionDraft: () => true,
    restoreSessionDraft() {}, restoreCurrentSessionDraft() {}, leaveCompanionConversation() {}, closeSessionSwipe() {},
    stopTaskEventStream() {}, stopSessionEventStream() {}, syncTaskEventStream() {}, syncSessionEventStream() {},
    applySessionActivitySnapshot() {}, reconcileVisibleSessionMessages() {}, markSessionRead() {}, scrollSessionToBottomIfFollowing() {},
    allSessionTimelineRows() { return this.selectedSession.entries.map((entry, index) => ({ key: `row-${index}`, entry })); },
    mergeSessionDetailPreservingHistory: (_, next) => next, async loadOutbox() {}, async refreshDesktopInteractions() {},
    async loadSessionReasoningEffort() {}, async adoptSelectedSessionTaskFromSummaries() {}, hasRunningSessionTask: () => false,
    async loadDesktopReasoningDefaults() {}, log() {}, errorText: error => error.message
  });
}

function adoptionSetup() {
  const page = setup();
  delete page.adoptSelectedSessionTaskFromSummaries;
  return Object.assign(page, {
    latestTaskIdBySessionId: {},
    latestTaskSummaryForSession: tasks => tasks[0] ?? null,
    isSubmittedOutboxReceipt: () => false, submittedReceiptHasVisibleUserEntry: () => false,
    taskSessionId: task => task.codexSessionId, isTaskRunningStatus: status => status === 'running',
    isTaskNewerThanSummary: () => false, shouldShowTaskPanelForStatus: () => true,
    taskUsesCodexRunApi: () => false, failedTaskHasCanonicalCompletion: () => false,
    handoffPendingSessionSend() {}, syncSessionTaskMarkers() {}, startPolling() {},
    activeTaskTitleFromSummary: summary => summary.id
  });
}
const summary = id => ({ id, codexSessionId: 'A', status: 'running' });

test('home task adoption cannot overwrite A after entering A while the request is pending', async () => {
  const page = adoptionSetup();
  page.selectedSession = null;
  page.sessionNavigationState = JSON.stringify({ revision: 1, mode: 'home', sessionId: '' });
  page.latestRunningTaskSummary = tasks => tasks[0] ?? null;
  const adopting = page.adoptRunningTaskFromSummaries([summary('home-old')]);
  assert.equal(requests.length, 1);
  page.commitSessionNavigation('session', 'A', 'test');
  page.selectedSession = session('A');
  const taskA = summary('A-current');
  page.currentTask = taskA;
  page.activeSessionTaskId = taskA.id;
  requests[0].resolve(summary('home-old'));
  await adopting;
  assert.equal(page.currentTask, taskA);
  assert.equal(page.activeSessionTaskId, taskA.id);
});

test('switching highlights B immediately, hides A controls, then commits the complete latest turn', async () => {
  const page = setup();
  const loading = page.openSession(session('B'));
  assert.equal(page.activeSessionId, 'B');
  assert.equal(page.selectedSession.id, 'A');
  assert.equal(page.isSessionDetailPending(), true, 'old composer and stop controls must be hidden while B is loading');
  assert.equal(requests[0].args[3], 1, 'only the latest full turn is requested initially');
  const entries = Array.from({ length: 200 }, (_, index) => ({ itemId: `item-${index}` }));
  requests[0].resolve({ ...session('B'), entries, entryCount: entries.length });
  await loading;
  assert.equal(page.isSessionDetailPending(), false);
  assert.equal(page.selectedSession.entries.length, 200, 'canonical entries remain complete');
  assert.equal(page.sessionTimelineStartKey, 'row-160', 'only recent display rows mount');
  assert.equal(page.pendingSessionLoadError, '');
});

test('returning to retained A before B finishes keeps the recent render window bounded', async () => {
  const page = setup();
  const entries = Array.from({ length: 200 }, (_, index) => ({ itemId: `a-${index}` }));
  page.selectedSession = { ...session('A'), entries, entryCount: entries.length };
  page.sessionTimelineStartKey = 'row-160';
  const loadingB = page.openSession(session('B'));
  const loadingA = page.openSession(session('A'));
  assert.equal(page.activeSessionId, 'A');
  assert.equal(page.isSessionDetailPending(), false);
  assert.equal(page.sessionTimelineStartKey, 'row-160');
  requests[1].resolve({ ...session('A'), entries, entryCount: entries.length });
  await loadingA;
  requests[0].resolve(session('B'));
  await loadingB;
  assert.equal(page.selectedSession.id, 'A');
  assert.equal(page.sessionTimelineStartKey, 'row-160');
});

test('task adoption ignores old A response after A-B-A navigation', async () => {
  const page = adoptionSetup();
  const adopting = page.adoptSelectedSessionTaskFromSummaries([summary('old')]);
  page.commitSessionNavigation('session', 'B');
  page.selectedSession = session('B');
  page.commitSessionNavigation('session', 'A');
  page.selectedSession = session('A');
  requests[0].resolve(summary('old'));
  await adopting;
  assert.equal(page.currentTask, null);
});

for (const credential of ['bridgeUrl', 'bridgeToken']) {
  test(`task adoption ignores response after ${credential} changes`, async () => {
    const page = adoptionSetup();
    const adopting = page.adoptSelectedSessionTaskFromSummaries([summary('old')]);
    page[credential] += '-changed';
    requests[0].resolve(summary('old'));
    await adopting;
    assert.equal(page.currentTask, null);
  });
}

test('older task adoption cannot overwrite a newer task adopted in the same navigation', async () => {
  const page = adoptionSetup();
  const old = page.adoptSelectedSessionTaskFromSummaries([summary('old')]);
  const newer = page.adoptSelectedSessionTaskFromSummaries([summary('new')]);
  requests[1].resolve(summary('new'));
  await newer;
  assert.equal(page.currentTask.id, 'new');
  requests[0].resolve(summary('old'));
  await old;
  assert.equal(page.currentTask.id, 'new');
  assert.equal(page.activeSessionTaskId, 'new');
});

test('task adoption cannot overwrite a different task set while the read is pending', async () => {
  const page = adoptionSetup();
  const adopting = page.adoptSelectedSessionTaskFromSummaries([summary('old')]);
  page.currentTask = summary('new');
  requests[0].resolve(summary('old'));
  await adopting;
  assert.equal(page.currentTask.id, 'new');
});

test('selecting displayed A while opening B cancels B navigation even if B arrives last', async () => {
  const page = setup();
  const openingB = page.openSession(session('B'));
  assert.equal(requests.length, 1);
  const openingA = page.openSession(session('A'));
  if (requests.length > 1) requests[1].resolve(session('A'));
  await openingA;
  requests[0].resolve(session('B'));
  await openingB;
  assert.equal(page.readSessionNavigation().sessionId, 'A');
  assert.equal(page.selectedSession.id, 'A');
});

for (const outcome of ['success', 'error']) {
  test(`late session load ${outcome} cannot change new draft`, async () => {
    const page = setup();
    const openingB = page.openSession(session('B'));
    page.startNewSessionDraft();
    const draftMessage = page.message;
    if (outcome === 'success') requests[0].resolve(session('B'));
    else requests[0].reject(new Error('old load failed'));
    await openingB;
    assert.equal(page.readSessionNavigation().mode, 'new');
    assert.equal(page.selectedSession, null);
    assert.equal(page.isNewSessionDraft, true);
    assert.equal(page.message, draftMessage);
  });
}

for (const credential of ['bridgeUrl', 'bridgeToken']) {
  for (const outcome of ['success', 'error']) {
    test(`late load ${outcome} cannot commit after ${credential} changes`, async () => {
      const page = setup();
      const loading = page.loadSessionDetail('A');
      page[credential] += '-changed';
      if (outcome === 'success') requests[0].resolve({ ...session('A'), title: 'old identity' });
      else requests[0].reject(new Error('old identity failed'));
      await loading;
      assert.equal(page.selectedSession.title, 'A');
      assert.equal(page.message, '');
    });
  }
}
