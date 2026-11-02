import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const source = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const reconciliation = fs.readFileSync(root + 'services/SessionSidebarPresentation.ets', 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
function setup(visible = true) {
  const streams = [];
  const context = vm.createContext({ BridgeEventStream: class {
    constructor(options) { streams.push(options); } start() {} isRunning() { return true; }
  } });
  vm.runInContext(stripTypeScriptTypes(`${reconciliation}\nclass Page {
    ${method('syncRuntimeEventStream')}
    ${method('shouldFreezeSessionList')}
  } globalThis.Page = Page;`), context);
  let snapshot;
  const page = Object.assign(new context.Page(), {
    bridgeToken: 'test-token', runtimeEventStreamKey: '', activeTab: 'sessions',
    sessions: [{ id: 'root', title: 'root', activityStatus: 'running' }, { id: 'peer', title: 'peer', activityStatus: 'idle' }],
    normalizedBridgeUrl: () => 'http://example.test', isSessionSidebarVisible: () => visible,
    stopRuntimeEventStream() { this.runtimeEventStreamKey = ''; }, reconcileSessionActivityMonitor() {},
    sessionRuntimeStore: { apply(value) { snapshot = value; return true; }, snapshot() { return snapshot; },
      mergeSessions() { return snapshot.sessions; } }
  });
  page.syncRuntimeEventStream();
  return { page, emit(sessions) { streams[0].onFrame({ event: 'runtime.snapshot', data: JSON.stringify({
    desktop: { connected: true }, snapshot: { schemaVersion: 1, epoch: 'test', revision: 1,
      generatedAt: '2026-11-02T03:00:00Z', stale: false, sessions }
  }) }); } };
}

test('runtime snapshots keep visible sidebar targets in place while updating live state and adding new sessions', () => {
  const h = setup();
  h.emit([{ id: 'peer', title: 'peer', activityStatus: 'running' },
    { id: 'root', title: 'root updated', activityStatus: 'waiting_input' },
    { id: 'new', title: 'new', activityStatus: 'idle' }]);
  assert.deepEqual(Array.from(h.page.sessions, s => s.id), ['root', 'peer', 'new']);
  assert.equal(h.page.sessions[0].title, 'root updated');
  assert.equal(h.page.sessions[0].activityStatus, 'waiting_input');
  assert.equal(h.page.sessions[1].activityStatus, 'running');
  h.emit([{ id: 'new', title: 'new', activityStatus: 'running' }, { id: 'root', title: 'root', activityStatus: 'idle' }]);
  assert.deepEqual(Array.from(h.page.sessions, s => s.id), ['root', 'new'], 'removed targets disappear without reordering survivors');
});

test('runtime snapshots can adopt desktop order when the sidebar is hidden', () => {
  const h = setup(false);
  h.emit([{ id: 'peer', title: 'peer', activityStatus: 'running' }, { id: 'root', title: 'root', activityStatus: 'idle' }]);
  assert.deepEqual(Array.from(h.page.sessions, s => s.id), ['peer', 'root']);
});
