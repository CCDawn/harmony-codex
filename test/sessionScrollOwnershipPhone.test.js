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
const names = ['loadOlderSessionEntries', 'restoreHistoryScrollAnchor', 'scrollSessionToBottom',
  'readSessionNavigation', 'commitSessionNavigation', 'isSessionNavigationCurrent', 'refreshSessionEventHistory', 'stopSessionEventStream', 'sessionTimelineRows'];
const requests = [];
const context = vm.createContext({ BridgeClient: { getSessionHistoryPage(...args) {
  return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
}} });
const windowSource = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SessionRenderWindow.ets', 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
vm.runInContext(stripTypeScriptTypes(`${windowSource}\nclass Page { ${fields} ${names.map(method).join('\n')} }\nglobalThis.Page = Page;`), context);
const detail = (id, cursor = 'current', entries = [{ id: 'visible' }]) => ({ id, entries, sync: {
  cursorStart: cursor, cursorEnd: 'end', hasMoreBefore: true, hasMoreAfter: false, source: 'desktop-official'
} });
function setup() {
  requests.length = 0;
  const scrolls = [];
  const page = Object.assign(new context.Page(), {
    selectedSession: detail('A'), activeSessionId: 'A', sessionNavigationState: JSON.stringify({ revision: 1, mode: 'session', sessionId: 'A' }),
    bridgeUrl: 'http://one', bridgeToken: 'token', sessionStreamEntries: [], desktopInteractionRefreshSeq: 0,
    sessionAutoFollowBottom: false, sessionUserScrollActive: false, isLoadingOlderSessionEntries: false,
    historyScrollAnchorKey: '', sessionContentHeight: 500, message: '', sessionStreamRefreshing: false,
    sessionEventStreamKey: 'A', normalizedBridgeUrl() { return this.bridgeUrl; },
    stopTaskEventStream() {}, log() {}, errorText: e => e.message,
    sessionScroller: { scrollTo: value => scrolls.push(['to', value.yOffset]), scrollBy: (x, y) => scrolls.push(['by', x, y]) },
    visibleSessionEntries() { return this.selectedSession.entries; }, sessionEntryKey: entry => entry.id,
    allSessionTimelineRows() { return this.selectedSession.entries.map(entry => ({ key: entry.id, entry, kind: 'entry' })); },
    mergeSessionDetailPreservingHistory: (older, current) => ({ ...current, entries: [...older.entries, ...current.entries] }),
    sessionDetailWithEntries: (current, entries, sync) => ({ ...current, entries, sync })
  });
  return { page, scrolls };
}

for (const outcome of ['success', 'error']) {
  test(`old history ${outcome} cannot affect A after A -> B -> A navigation`, async () => {
    const { page, scrolls } = setup();
    const loading = page.loadOlderSessionEntries('test');
    page.commitSessionNavigation('session', 'B', 'test');
    page.selectedSession = detail('B');
    page.commitSessionNavigation('session', 'A', 'test');
    page.selectedSession = detail('A', 'fresh-cursor', [{ id: 'fresh' }]);
    page.message = 'fresh message';
    if (outcome === 'success') requests[0].resolve(detail('A', 'old-cursor', [{ id: 'old' }]));
    else requests[0].reject(new Error('old request failed'));
    await loading;
    page.restoreHistoryScrollAnchor('fresh', { position: { y: 0 } }, { position: { y: 20 } });
    assert.equal(page.selectedSession.sync.cursorStart, 'fresh-cursor');
    assert.deepEqual(Array.from(page.selectedSession.entries, e => e.id), ['fresh']);
    assert.equal(page.message, 'fresh message');
    assert.deepEqual(scrolls, []);
  });
}

test('returning to bottom during history load cannot apply a late scroll anchor', async () => {
  const { page, scrolls } = setup();
  const loading = page.loadOlderSessionEntries('test');
  page.scrollSessionToBottom();
  requests[0].resolve(detail('A', 'old-cursor', [{ id: 'old' }]));
  await loading;
  page.restoreHistoryScrollAnchor('visible', { position: { y: 0 } }, { position: { y: 50 } });
  assert.deepEqual(scrolls, [['to', 500]]);
  assert.equal(page.sessionAutoFollowBottom, true);
});

test('local expansion reveals 40 rows with no HTTP read, preserves the server cursor and anchors optimistic/failed rows', async () => {
  for (const kind of ['entry', 'optimistic', 'failed']) {
    const { page, scrolls } = setup();
    const rows = Array.from({ length: 120 }, (_, index) => ({ key: `row-${index}`, kind,
      ...(kind === 'entry' ? { entry: { id: `item-${index}` } } : {}) }));
    page.allSessionTimelineRows = () => rows;
    page.sessionTimelineStartKey = 'row-80';
    const cursor = page.selectedSession.sync.cursorStart;
    await page.loadOlderSessionEntries('history_button');
    assert.equal(requests.length, 0);
    assert.equal(page.selectedSession.sync.cursorStart, cursor);
    assert.equal(page.sessionTimelineStartKey, 'row-40');
    assert.equal(page.sessionTimelineRows().length, 80);
    page.restoreHistoryScrollAnchor('row:row-80', { position: { y: 0 } }, { position: { y: 90 } });
    assert.deepEqual(scrolls, [['by', 0, 90]]);
    page.commitSessionNavigation('session', 'B', 'test');
    assert.equal(page.sessionTimelineStartKey, '', 'another conversation does not inherit the window');
    assert.equal(page.historyScrollAnchorKey, '');
  }
});

test('a new stream key starts its own history refresh while old key is in flight', async () => {
  const { page } = setup();
  const pending = [];
  page.refreshSelectedSessionDetail = () => new Promise(resolve => pending.push(resolve));
  const old = page.refreshSessionEventHistory('A');
  page.stopSessionEventStream();
  page.sessionEventStreamKey = 'B';
  const current = page.refreshSessionEventHistory('B');
  assert.equal(pending.length, 2);
  void page.refreshSessionEventHistory('B');
  pending[0]();
  await old;
  void page.refreshSessionEventHistory('B');
  assert.equal(pending.length, 2, 'old completion must not unlock the active B refresh');
  pending[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3, 'B invalidations coalesce into one trailing read');
  pending[2]();
  await current;
});

test('a second invalidation during one refresh causes a trailing history read', async () => {
  const { page } = setup();
  const pending = [];
  page.refreshSelectedSessionDetail = () => new Promise(resolve => pending.push(resolve));
  const first = page.refreshSessionEventHistory('A');
  void page.refreshSessionEventHistory('A');
  assert.equal(pending.length, 1);
  pending[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1]();
  await first;
});

test('an old history request cannot release the lock held by a newer navigation', async () => {
  const { page } = setup();
  const old = page.loadOlderSessionEntries('old');
  page.commitSessionNavigation('session', 'B', 'test');
  page.selectedSession = detail('B', 'b-cursor');
  const current = page.loadOlderSessionEntries('current');
  assert.equal(requests.length, 2);
  requests[0].resolve(detail('A', 'old-cursor', [{ id: 'old' }]));
  await old;
  const duplicate = page.loadOlderSessionEntries('duplicate');
  assert.equal(requests.length, 2);
  requests[1].resolve(detail('B', 'b-older', [{ id: 'b-old' }]));
  await Promise.all([current, duplicate]);
  assert.equal(page.selectedSession.sync.cursorStart, 'b-older');
});

for (const credential of ['bridgeUrl', 'bridgeToken']) {
  test(`old history cannot commit after ${credential} changes`, async () => {
    const { page } = setup();
    const loading = page.loadOlderSessionEntries('test');
    page[credential] += '-changed';
    requests[0].resolve(detail('A', 'old-cursor', [{ id: 'old' }]));
    await loading;
    assert.equal(page.selectedSession.sync.cursorStart, 'current');
    assert.deepEqual(Array.from(page.selectedSession.entries, e => e.id), ['visible']);
  });
}
