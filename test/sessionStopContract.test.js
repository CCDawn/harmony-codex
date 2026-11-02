import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`\\n  private(?: async)? ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start + 1);
  const end = tail.slice(3).search(/\n  (?:private |@Builder|build\()/) + 3;
  assert.ok(end > 3, name);
  return tail.slice(0, end).replace(/private /, '');
}

function setup() {
  let release, reject;
  const calls = [];
  const pending = new Promise((resolve, no) => { release = resolve; reject = no; });
  const context = vm.createContext({ BridgeClient: {
    interruptCodexThread(...args) { calls.push(args); return pending; },
    interruptTask() { assert.fail('the conversation button must target its thread'); }
  }, ScrollSource: { SCROLLER: 6, SCROLLER_ANIMATION: 7, EDGE_EFFECT: 2 }, Edge: { Top: 1, Bottom: 2 } });
  vm.runInContext(stripTypeScriptTypes(`class Page { ${['interruptSelectedSessionTask', 'taskLiveEntries',
    'handleSessionWillScroll', 'handleSessionScrollEdge'].map(method).join('\n')} } globalThis.Page=Page;`), context);
  const page = new context.Page();
  Object.assign(page, { currentTask: { id: 'old-A' }, selectedSession: { id: 'A' }, activeSessionTaskId: 'old-A', revision: 1,
    taskStatusById: {}, taskSessionById: {}, starts: 0, stops: 0, sessionAutoFollowBottom: false,
    sessionUserScrollActive: false, atEnd: true, loads: 0, canInterruptSelectedSessionTask: () => true,
    selectedSessionInterruptTaskId: () => 'old-A', readSessionNavigation: () => ({ revision: page.revision }),
    normalizedBridgeUrl: () => 'http://fixture', bridgeToken: 'fixture', guard: async (_, work) => work(),
    isSelectedSessionActivityRunning: () => true, isTaskTerminalStatus: status => ['interrupted', 'completed', 'failed'].includes(status),
    syncSessionTaskMarkers() {}, isSyntheticInterruptFailure: () => false, log() {}, interruptResultMessage: () => 'stopping',
    errorText: error => error.message, isEndedTaskInterruptConflict: message => message.includes('HTTP 409'),
    clearSelectedSessionRunningAfterEndedInterruptConflict: async () => { page.recovered = true; },
    startPolling() { page.starts++; }, stopPolling() { page.stops++; }, markSessionRunningLocallyCleared() {},
    refreshSessions: async () => {}, refreshSelectedSessionDetail: async () => {},
    sessionScroller: { isAtEnd: () => page.atEnd }, loadOlderSessionEntries() { page.loads++; } });
  return { page, calls, release, reject, context };
}

test('stop targets the selected conversation even when an older bridge task is cached', async () => {
  const { page, calls, release } = setup();
  const stopping = page.interruptSelectedSessionTask();
  assert.deepEqual(calls, [['http://fixture', 'A', 'fixture']]);
  release({ id: 'stop-A', codexSessionId: 'A', syntheticInterrupt: true, status: 'running' });
  await stopping;
  assert.equal(page.currentTask.id, 'stop-A');
  assert.equal(page.starts, 1);
  assert.equal(page.taskLiveEntries(page.currentTask).length, 0);
});

test('a late stop response for A does not replace B, its polling or its current task', async () => {
  const { page, release } = setup();
  const stopping = page.interruptSelectedSessionTask();
  page.revision = 2; page.selectedSession = { id: 'B' }; page.currentTask = { id: 'new-B' }; page.activeSessionTaskId = 'new-B';
  release({ id: 'stop-A', codexSessionId: 'A', syntheticInterrupt: true, status: 'interrupted' });
  await stopping;
  assert.equal(page.currentTask.id, 'new-B');
  assert.equal(page.activeSessionTaskId, 'new-B');
  assert.equal(page.starts + page.stops, 0);
});

for (const message of ['Operation timeout', 'HTTP 409 任务已经结束，不能中断']) {
  test(`a late stop failure after switching conversations cannot alter the selected conversation: ${message}`, async () => {
    const { page, reject } = setup();
    const stopping = page.interruptSelectedSessionTask();
    page.revision = 2; page.selectedSession = { id: 'B' }; page.currentTask = { id: 'new-B' };
    page.message = 'B remains active';
    reject(new Error(message));
    await stopping;
    assert.equal(page.message, 'B remains active');
    assert.equal(page.currentTask.id, 'new-B');
    assert.equal(page.recovered, undefined);
    assert.equal(page.starts + page.stops, 0);
  });
}

test('a current stop conflict retains existing ended-task recovery', async () => {
  const { page, reject } = setup();
  const stopping = page.interruptSelectedSessionTask();
  reject(new Error('HTTP 409 任务已经结束，不能中断'));
  await stopping;
  assert.equal(page.recovered, true);
});

test('programmatic layout and overscroll edges cannot reattach a reader to the bottom or keep loading history', () => {
  const { page, context } = setup();
  page.handleSessionWillScroll(10, context.ScrollSource.EDGE_EFFECT);
  page.handleSessionScrollEdge(context.Edge.Bottom);
  assert.equal(page.sessionAutoFollowBottom, false);
  page.handleSessionWillScroll(10, 0);
  page.handleSessionScrollEdge(context.Edge.Top);
  page.handleSessionScrollEdge(context.Edge.Top);
  assert.equal(page.loads, 1);
  page.handleSessionWillScroll(10, 0);
  page.handleSessionScrollEdge(context.Edge.Bottom);
  assert.equal(page.sessionAutoFollowBottom, true);
});
