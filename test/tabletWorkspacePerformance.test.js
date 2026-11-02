import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const source = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n  }', start) + 4);
}
function builder(name) {
  const start = source.indexOf(`  ${name}(`);
  assert.ok(start >= 0, `real builder ${name} exists`);
  return source.slice(start, source.indexOf('\n  @Builder', start));
}
function setup() {
  const ignored = new Set(['log', 'syncNotificationBadge', 'applySessionActivitySnapshot']);
  const methods = new Map();
  function include(name) {
    if (ignored.has(name) || methods.has(name)) return;
    const body = method(name);
    if (!body) return;
    methods.set(name, body);
    for (const match of body.matchAll(/this\.(\w+)\(/g)) include(match[1]);
  }
  ['shouldFreezeSessionList', 'isSessionSidebarVisible', 'applyLatestSessions', 'sessionSidebarItemKey',
    'sessionTimeLabel', 'canDeleteSession', 'canDisplaySessionDelete', 'isSidebarSessionRunning',
    'refreshSessionSidebarSnapshot', 'currentTaskSidebarChanged', 'sidebarRuntimeInputsChanged'].forEach(include);
  const services = ['SessionRuntimeStore.ets', 'SessionSidebarPresentation.ets'].map(file => {
    const path = root + 'services/' + file;
    return fs.existsSync(path) ? fs.readFileSync(path, 'utf8').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '') : '';
  }).join('\n');
  const context = vm.createContext({ px2vp: value => value });
  vm.runInContext(stripTypeScriptTypes(services + '\nclass Page {' + [...methods.values()].join('\n') + '}\nglobalThis.Page=Page;'), context);
  const summary = (id, extra = {}) => ({ id, title: `Conversation ${id}`, updatedAt: '2026-10-24T00:00:00Z',
    relativeTime: '1分钟前', activityStatus: 'completed', ...extra });
  const page = Object.assign(new context.Page(), {
    activeTab: 'sessions', sessionWindowWidth: 1280, sessionWindowHeight: 800,
    sessionSidebarCollapsed: true, sessionSidebarUserCollapsed: false,
    selectedSession: null, isNewSessionDraft: false, companionSelected: false,
    sessions: [summary('a'), summary('b'), summary('c')], lastGoodSessionCount: 3,
    deletingSessionId: '', runningSessionIds: [], locallyClearedRunningSessionIds: [], unreadCompletedSessionIds: [],
    sessionMonitorRevision: 1, sidebarRunningSessionIds: [], sidebarTaskSignature: '',
    sessionActivityStatusById: { a: 'completed', b: 'completed', c: 'completed' },
    sessionUpdatedAtById: { a: '2026-10-24T00:00:00Z', b: '2026-10-24T00:00:00Z', c: '2026-10-24T00:00:00Z' },
    taskStatusById: {}, taskSessionById: {}, latestTaskIdBySessionId: {}, clearedRunningSessionUpdatedAtById: {},
    log() {}, syncNotificationBadge() {}, applySessionActivitySnapshot() {}
  });
  const reads = { currentTask: 0, tasks: 0, body: 0 };
  let activeTask = null, taskSummaries = [];
  Object.defineProperty(page, 'currentTask', { get() { reads.currentTask++; return activeTask; }, set(value) { activeTask = value; } });
  Object.defineProperty(page, 'tasks', { get() { reads.tasks++; return taskSummaries; }, set(value) { taskSummaries = value; } });
  const task = (extra = {}) => ({ id: 'task-a', status: 'running', codexSessionId: 'a', createdAt: '2026-10-24T01:00:00Z',
    updatedAt: '2026-10-24T01:00:00Z', get events() { reads.body++; return []; }, ...extra });
  const resetReads = () => { reads.currentTask = 0; reads.tasks = 0; reads.body = 0; };
  const refresh = () => { if (typeof page.refreshSessionSidebarSnapshot === 'function') page.refreshSessionSidebarSnapshot(); };
  return { page, summary, task, reads, resetReads, refresh };
}

test('visible tablet split sidebar protects dashboard order even when the portrait collapse flag is true', () => {
  const { page } = setup();
  assert.equal(page.isSessionSidebarVisible(), true);
  assert.equal(page.shouldFreezeSessionList(3), true);
  page.sessionSidebarUserCollapsed = true;
  assert.equal(page.isSessionSidebarVisible(), false);
  assert.equal(page.shouldFreezeSessionList(3), false);
  page.sessionWindowWidth = 400; page.sessionWindowHeight = 800; page.sessionSidebarCollapsed = false;
  assert.equal(page.isSessionSidebarVisible(), true);
  assert.equal(page.shouldFreezeSessionList(3), true);
});

test('tablet order protection still merges fresh titles, times, additions and removals', () => {
  const { page, summary } = setup();
  const latest = [summary('b', { title: 'Renamed B', relativeTime: '刚刚' }), summary('a'), summary('new')];
  page.applyLatestSessions(latest, 'dashboard');
  assert.deepEqual(Array.from(page.sessions, row => row.id), ['a', 'b', 'new']);
  assert.equal(page.sessions[1].title, 'Renamed B');
  assert.equal(page.sessionTimeLabel(page.sessions[1]), '刚刚');
});

test('equivalent dashboard snapshots reuse the sidebar array and row identities', () => {
  const { page } = setup(); const before = page.sessions;
  page.applyLatestSessions(before.map(row => ({ ...row })), 'dashboard');
  assert.equal(page.sessions, before);
  assert.equal(page.sessions[0], before[0]);
});

test('one conversation changing unread or running state does not change unrelated row keys', () => {
  const h = setup(); h.refresh(); const [a, b] = h.page.sessions;
  const aKey = h.page.sessionSidebarItemKey(a), bKey = h.page.sessionSidebarItemKey(b);
  h.page.unreadCompletedSessionIds = ['b']; h.page.sessionMonitorRevision++;
  assert.equal(h.page.sessionSidebarItemKey(a), aKey, 'global unread revision must not remount A');
  assert.notEqual(h.page.sessionSidebarItemKey(b), bKey, 'B unread state still updates');
  const unreadKey = h.page.sessionSidebarItemKey(b);
  h.page.sessionActivityStatusById.b = 'running'; h.page.sessionMonitorRevision++; h.refresh();
  assert.equal(h.page.sessionSidebarItemKey(a), aKey);
  assert.notEqual(h.page.sessionSidebarItemKey(b), unreadKey, 'B running state still updates');
});

test('each row key reflects its own title and displayed time changes', () => {
  const h = setup(); h.refresh(); const row = h.page.sessions[1];
  const before = h.page.sessionSidebarItemKey(row);
  assert.notEqual(h.page.sessionSidebarItemKey({ ...row, title: 'Renamed title' }), before);
  assert.notEqual(h.page.sessionSidebarItemKey({ ...row, relativeTime: '刚刚' }), before);
  assert.equal(h.page.sessionTimeLabel({ ...row, relativeTime: '刚刚' }), '刚刚');
});

test('sidebar key, badge, time color and delete display use the stable running snapshot', () => {
  const h = setup();
  assert.equal(typeof h.page.refreshSessionSidebarSnapshot, 'function', 'snapshot refresh entry exists');
  assert.equal(typeof h.page.isSidebarSessionRunning, 'function', 'sidebar running presentation is isolated');
  assert.equal(typeof h.page.canDisplaySessionDelete, 'function', 'delete display has a presentation-only predicate');
  h.page.currentTask = h.task(); h.page.tasks = [h.task({ id: 'task-b', codexSessionId: 'b' })]; h.refresh();
  h.resetReads();
  for (let pass = 0; pass < 20; pass++) {
    for (const row of h.page.sessions) {
      h.page.sessionSidebarItemKey(row);
      h.page.isSidebarSessionRunning(row.id);
      h.page.canDisplaySessionDelete(row);
      h.page.sessionTimeLabel(row);
    }
  }
  assert.deepEqual(h.reads, { currentTask: 0, tasks: 0, body: 0 });
  const item = builder('SessionSidebarItem'), badge = builder('SessionActivityBadge');
  assert.match(item, /\.enabled\(this\.canDisplaySessionDelete\(session\)\)/);
  assert.match(item, /\.fontColor\(this\.isSidebarSessionRunning\(session\.id\)/);
  assert.doesNotMatch(item, /this\.(?:isSessionRunning|canDeleteSession)\(/);
  assert.match(badge, /this\.isSidebarSessionRunning\(session\.id\)/);
  assert.doesNotMatch(badge, /this\.isSessionRunning\(/);
});

test('body-only currentTask replacements do not refresh sidebar state or inspect task history', () => {
  const h = setup();
  assert.equal(typeof h.page.currentTaskSidebarChanged, 'function');
  h.page.currentTask = h.task(); h.page.currentTaskSidebarChanged();
  const actualRefresh = h.page.refreshSessionSidebarSnapshot.bind(h.page);
  let refreshes = 0;
  h.page.refreshSessionSidebarSnapshot = () => { refreshes++; actualRefresh(); };
  h.resetReads();
  for (let delta = 0; delta < 100; delta++) {
    h.page.currentTask = h.task({ updatedAt: `delta-${delta}`, eventCursor: delta + 1 });
    h.page.currentTaskSidebarChanged();
  }
  assert.equal(refreshes, 0);
  assert.equal(h.reads.tasks, 0);
  assert.equal(h.reads.body, 0);
  h.page.currentTask = h.task({ status: 'completed' }); h.page.currentTaskSidebarChanged(); assert.equal(refreshes, 1);
  h.page.currentTask = h.task({ status: 'completed', codexSessionId: 'b' }); h.page.currentTaskSidebarChanged(); assert.equal(refreshes, 2);
  h.page.currentTask = h.task({ status: 'completed', codexSessionId: 'b', createdAt: '2026-10-24T02:00:00Z' });
  h.page.currentTaskSidebarChanged(); assert.equal(refreshes, 3);
});

test('low frequency task summaries refresh the sidebar running snapshot', () => {
  const h = setup();
  assert.equal(typeof h.page.sidebarRuntimeInputsChanged, 'function');
  h.refresh(); assert.equal(h.page.isSidebarSessionRunning('b'), false);
  h.page.tasks = [h.task({ id: 'task-b', codexSessionId: 'b' })]; h.page.sidebarRuntimeInputsChanged();
  assert.equal(h.page.isSidebarSessionRunning('b'), true);
});

test('delete action retains authoritative running validation even before the display snapshot refreshes', () => {
  const h = setup(); h.refresh(); const b = h.page.sessions[1];
  h.page.sessionActivityStatusById.b = 'running';
  assert.equal(h.page.canDeleteSession(b), false);
});
