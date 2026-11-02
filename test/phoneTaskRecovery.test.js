import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
function method(name) {
  const start = source.indexOf(`  private ${name}(`) >= 0
    ? source.indexOf(`  private ${name}(`) : source.indexOf(`  private async ${name}(`);
  assert.ok(start >= 0, `real Index.ets method ${name} exists`);
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  return source.slice(start, end);
}
const methods = ['refreshTask', 'adoptTaskAfterSendTimeout', 'startPolling', 'scheduleNextTaskPoll', 'refreshTaskFromTimer',
  'stopPolling', 'currentTaskEventCount', 'currentTaskEventCursor', 'mergeTaskEventPage', 'recordSessionInputAcknowledgements', 'updateTaskPollCadence',
  'isLocallyClearedSessionActivity', 'isSelectedSessionActivityRunning', 'sessionActivityUpdatedAt',
  'canInterruptSelectedSessionTask', 'shouldUseSessionInterruptAction']
  .map(method).join('\n');
const task = (status = 'running', cursor = 0, count = cursor, more = false) => ({
  id: 'task-1', codexSessionId: 'session-1', status, eventCursor: cursor, eventCount: count,
  events: [], hasMoreEvents: more
});
function pageHarness(getTask) {
  const timers = new Map();
  const requests = [];
  const completions = [];
  const details = [];
  let timerId = 0;
  const context = vm.createContext({
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    BridgeClient: {
      async listTasks() { return [{ id: 'task-1' }]; },
      async getTask(...args) { requests.push(args[3]); return getTask(args[3], args[1]); }
    }
  });
  vm.runInContext(stripTypeScriptTypes(`class Page { ${methods} } globalThis.Page = Page;`), context);
  const page = new context.Page();
  Object.assign(page, {
    currentTask: task(), selectedSession: { id: 'session-1' }, pendingSessionSendsByTaskId: {}, pollTimer: -1,
    taskPollStartedAt: Date.now(), taskPollLastStatus: 'running', taskPollLastEventCount: 0,
    taskPollDelayMs: 2000, taskTerminalPreviousStatusById: {}, taskTerminalHandledIds: [],
    taskEventStreamHealthy: false, syncTaskEventStream() {}, stopTaskEventStream() {},
    isNewSessionDraft: false, bridgeToken: '',
    taskSessionId: value => value.codexSessionId ?? '', taskUsesCodexRunApi: () => false,
    normalizedBridgeUrl: () => 'http://bridge', readSessionNavigation: () => ({ revision: page.navigationRevision }),
    navigationRevision: 1, log() {}, handoffPendingSessionSend() {}, isSubmittedOutboxReceipt: () => false,
    commitSessionNavigation() { this.navigationRevision++; },
    applyTaskExecutionContract() {}, syncSessionTaskMarkers() {}, statusLabel: status => status,
    currentTaskSummaryText: () => '', scrollSessionToBottomIfFollowing() {}, taskUsesAppServer: () => true,
    publishTaskAttentionNotification() {}, isTaskRunningStatus: status => ['running', 'queued'].includes(status),
    isTaskTerminalStatus: status => ['completed', 'failed', 'interrupted'].includes(status),
    markSessionRunningLocallyCleared() {},
    async handleTaskTerminalForSession(value, previousStatus) { completions.push([value.events.length, previousStatus]); },
    applyTaskSessionSnapshot: () => false, async loadSessionDetail(id) { details.push(id); },
    async refreshSessions() {}, errorText: error => error.message,
    reconcileSessionTaskMonitor() {}, latestTaskSummaryForSession: tasks => tasks[0],
    activeTaskTitleFromSummary: () => 'recovered task'
  });
  return { page, requests, completions, details, timers, bridge: context.BridgeClient, async tick() {
    assert.equal(timers.size, 1, 'exactly one next-page timer');
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
    await new Promise(resolve => setImmediate(resolve));
    return timer.delay;
  } };
}

function runningNativeSession(page) {
  const timestamp = '2026-11-01T08:26:50.000Z';
  Object.assign(page, {
    selectedSession: { id: 'session-1', activityStatus: 'running', activityUpdatedAt: timestamp, updatedAt: timestamp },
    sessionActivityStatusById: { 'session-1': 'running' }, sessionUpdatedAtById: { 'session-1': timestamp },
    locallyClearedRunningSessionIds: [], clearedRunningSessionUpdatedAtById: {},
    normalizedSessionActivityStatus: status => status,
    isSendingCurrentSessionMessage: () => false, isInterruptingSelectedSessionTask: () => false,
    selectedSessionInterruptTaskId: () => '', hasSessionDraftContent: () => false,
    markSessionRunningLocallyCleared(id) {
      this.locallyClearedRunningSessionIds = [id];
      this.clearedRunningSessionUpdatedAtById[id] = this.sessionUpdatedAtById[id];
    }
  });
}

test('losing a bridge task cannot disable stop for the same native running turn and timestamp', async () => {
  const { page } = pageHarness(() => { throw new Error('HTTP 404 Unknown task'); });
  runningNativeSession(page);
  let reread = false;
  page.refreshAfterMissingTask = async () => {
    reread = true;
    page.selectedSession = { ...page.selectedSession, activityStatus: 'running' };
  };
  await page.refreshTask();
  assert.equal(reread, true);
  assert.equal(page.currentTask, null);
  assert.equal(page.isSelectedSessionActivityRunning(), true);
  assert.equal(page.shouldUseSessionInterruptAction(), true);
  assert.deepEqual(page.locallyClearedRunningSessionIds, []);
});

test('a confirmed native terminal receipt still suppresses an old running snapshot at the same timestamp', async () => {
  const { page } = pageHarness(() => task('interrupted'));
  runningNativeSession(page);
  await page.refreshTask();
  assert.equal(page.isSelectedSessionActivityRunning(), false);
  assert.equal(page.shouldUseSessionInterruptAction(), false);
  assert.equal(page.locallyClearedRunningSessionIds[0], 'session-1');
});

test('completed task drains 250 events before one terminal cleanup, including repeated completed responses', async () => {
  const harness = pageHarness(after => {
    const end = Math.min(after + 100, 250);
    return { ...task('completed', end, 250, end < 250),
      events: Array.from({ length: end - after }, (_, index) => ({ id: `event-${after + index + 1}`, seq: after + index + 1 })) };
  });
  const { page, requests, completions, details, timers } = harness;
  await page.refreshTaskFromTimer();
  assert.equal(page.currentTask.events.length, 100);
  assert.deepEqual(completions, [], 'terminal side effects wait for the final event page');
  assert.equal(await harness.tick(), 50);
  assert.equal(page.currentTask.events.length, 200);
  assert.deepEqual(completions, []);
  assert.equal(await harness.tick(), 50);
  assert.equal(page.currentTask.events.length, 250);
  assert.deepEqual(requests, [0, 100, 200]);
  assert.deepEqual(completions, [[250, 'running']]);
  assert.deepEqual(details, ['session-1']);
  assert.equal(timers.size, 0);
  await page.refreshTask();
  assert.deepEqual(completions, [[250, 'running']], 'duplicate terminal refresh never repeats cleanup');
  assert.deepEqual(details, ['session-1']);
});

test('an unadvanced terminal event cursor retries at normal cadence and can recover', async () => {
  let attempts = 0;
  const harness = pageHarness(() => ++attempts === 1 ? task('completed', 0, 1, true)
    : { ...task('completed', 1, 1), events: [{ id: 'event-1', seq: 1 }] });
  await harness.page.refreshTaskFromTimer();
  assert.deepEqual(harness.completions, []);
  const [timer] = harness.timers.values();
  assert.ok(timer && timer.delay >= 2000, 'no 50ms loop for a non-advancing cursor');
  await harness.tick();
  assert.deepEqual(harness.requests, [0, 0]);
  assert.deepEqual(harness.completions, [[1, 'running']]);
});

test('terminal response after switching sessions cannot overwrite the new task or finish the old one', async () => {
  let finish;
  const harness = pageHarness(() => new Promise(resolve => { finish = resolve; }));
  const pending = harness.page.refreshTask();
  harness.page.currentTask = { ...task(), id: 'task-2', codexSessionId: 'session-2' };
  harness.page.selectedSession = { id: 'session-2' };
  harness.page.navigationRevision++;
  finish(task('completed', 100, 250, true));
  await pending;
  assert.equal(harness.page.currentTask.id, 'task-2');
  assert.deepEqual(harness.completions, []);
  assert.deepEqual(harness.details, []);
});

for (const status of ['failed', 'interrupted']) {
  test(`${status} also drains events before terminal cleanup`, async () => {
    const harness = pageHarness(after => ({ ...task(status, after + 1, 2, after === 0),
      events: [{ id: `event-${after + 1}`, seq: after + 1 }] }));
    await harness.page.refreshTaskFromTimer();
    assert.deepEqual(harness.completions, []);
    await harness.tick();
    assert.deepEqual(harness.completions, [[2, 'running']]);
  });
}

test('regressed page cursors preserve the last cursor and deduplicate events', async () => {
  const harness = pageHarness(() => ({ ...task('completed', 5, 20, true), events: [{ id: 'event-10', seq: 10 }] }));
  harness.page.currentTask = { ...task('running', 10, 10), events: [{ id: 'event-10', seq: 10 }] };
  await harness.page.refreshTaskFromTimer();
  assert.equal(harness.page.currentTask.eventCursor, 10);
  assert.equal(harness.page.currentTask.events.length, 1);
  assert.deepEqual(harness.requests, [10]);
  assert.ok(harness.timers.values().next().value.delay >= 2000);
});

test('a transient failure while draining backs off before retrying the same cursor', async () => {
  let attempts = 0;
  const harness = pageHarness(after => {
    if (++attempts === 2) throw Error('temporary disconnect');
    return { ...task('completed', after + 1, 2, after === 0), events: [{ id: `event-${after + 1}`, seq: after + 1 }] };
  });
  await harness.page.refreshTaskFromTimer();
  await harness.tick();
  assert.deepEqual(harness.completions, []);
  assert.ok(harness.timers.values().next().value.delay >= 2000);
  await harness.tick();
  assert.deepEqual(harness.requests, [0, 1, 1]);
  assert.deepEqual(harness.completions, [[2, 'running']]);
});

test('late overlapping pages cannot roll back a cursor or overwrite merged events', async () => {
  const replies = [];
  const harness = pageHarness(() => new Promise(resolve => replies.push(resolve)));
  const first = harness.page.refreshTask();
  const overlapping = harness.page.refreshTask();
  replies[0]({ ...task('completed', 1, 2, true), events: [{ id: 'event-1', seq: 1 }] });
  await first;
  replies[1](task('completed', 0, 2, true));
  await overlapping;
  assert.equal(harness.page.currentTask.eventCursor, 1);
  assert.equal(harness.page.currentTask.events.length, 1);
  assert.deepEqual(harness.completions, []);
});

test('navigation away and back still discards a response for the same task id', async () => {
  let finish;
  const harness = pageHarness(() => new Promise(resolve => { finish = resolve; }));
  const pending = harness.page.refreshTask();
  harness.page.navigationRevision += 2;
  finish(task('completed', 100, 250, true));
  await pending;
  assert.equal(harness.page.currentTask.status, 'running');
  assert.equal(harness.page.currentTask.eventCursor, 0);
  assert.deepEqual(harness.completions, []);
});

test('switching sessions during event-gap detail loading discards the old task page', async () => {
  let finishDetail;
  const harness = pageHarness(() => ({ ...task('completed', 100, 250, true), eventGap: true }));
  harness.page.loadSessionDetail = () => new Promise(resolve => { finishDetail = resolve; });
  const pending = harness.page.refreshTask();
  await new Promise(resolve => setImmediate(resolve));
  harness.page.currentTask = { ...task(), id: 'task-2', codexSessionId: 'session-2' };
  harness.page.selectedSession = { id: 'session-2' };
  harness.page.navigationRevision++;
  finishDetail();
  await pending;
  assert.equal(harness.page.currentTask.id, 'task-2');
  assert.deepEqual(harness.completions, []);
});

test('new-session terminal cleanup opens its final session once after all pages', async () => {
  const harness = pageHarness(after => ({ ...task('completed', after + 1, 2, after === 0),
    codexSessionId: '', createdCodexSessionId: 'created-session', events: [{ id: `event-${after + 1}`, seq: after + 1 }] }));
  harness.page.isNewSessionDraft = true;
  await harness.page.refreshTaskFromTimer();
  assert.deepEqual(harness.details, []);
  await harness.tick();
  assert.equal(harness.page.isNewSessionDraft, false);
  assert.deepEqual(harness.details, ['created-session']);
  await harness.page.refreshTask();
  assert.deepEqual(harness.details, ['created-session']);
  assert.deepEqual(harness.completions, [[2, 'running']]);
});

test('returning to a pending terminal task preserves its original running-to-terminal transition', async () => {
  const harness = pageHarness((after, id) => ({ ...task('completed', after + 1, 2, after === 0), id,
    events: [{ id: `${id}-event-${after + 1}`, seq: after + 1 }] }));
  await harness.page.refreshTask();
  const first = harness.page.currentTask;
  harness.page.currentTask = { ...task(), id: 'task-2' };
  await harness.page.refreshTask();
  harness.page.currentTask = first;
  await harness.page.refreshTask();
  assert.deepEqual(harness.completions, [[2, 'running']]);
});

test('send-timeout lookup stays read-only before its recovered 250-event task drains through shared polling once', async () => {
  const harness = pageHarness((after = 0) => {
    const end = Math.min(after + 100, 250);
    return { ...task('completed', end, 250, end < 250), submissionId: 'submission-1',
      events: Array.from({ length: end - after }, (_, index) => ({ id: `event-${after + index + 1}`, seq: after + index + 1 })) };
  });
  harness.bridge.listTasks = async () => [{ id: 'task-1', codexSessionId: 'session-1', submissionId: 'submission-1' }];
  const previousTask = harness.page.currentTask;
  const recovered = await harness.page.adoptTaskAfterSendTimeout('session-1', 'sendSessionMessage', 'submission-1');
  assert.equal(recovered.id, 'task-1');
  assert.equal(harness.page.currentTask, previousTask, 'lookup cannot claim the visible page');
  assert.equal(harness.timers.size, 0, 'lookup cannot start polling on its own');
  harness.page.currentTask = recovered;
  harness.page.startPolling();
  assert.equal(harness.page.currentTask.events.length, 100);
  assert.deepEqual(harness.completions, []);
  assert.deepEqual(harness.details, []);
  await harness.tick();
  assert.equal(harness.page.currentTask.events.length, 200);
  assert.deepEqual(harness.completions, []);
  await harness.tick();
  assert.deepEqual(harness.requests, [undefined, 100, 200]);
  assert.deepEqual(harness.completions, [[250, 'completed']]);
  assert.deepEqual(harness.details, ['session-1']);
  await harness.page.refreshTask();
  assert.deepEqual(harness.completions, [[250, 'completed']]);
  assert.deepEqual(harness.details, ['session-1']);
});
