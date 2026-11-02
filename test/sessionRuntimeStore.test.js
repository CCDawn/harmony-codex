import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionRuntimeStore.ets', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '');
const { SessionRuntimeStore } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const runtime = (threadId, state = 'running') => ({
  threadId, title: 'cached title', updatedAt: '2026-10-18T00:00:00Z', stateUpdatedAt: '2026-10-18T00:00:00Z',
  state, source: 'desktop-app-server', activeTurnId: 'old-turn', canInterrupt: true, detailAvailable: true
});
const snapshot = (sessions, overrides = {}) => ({
  epoch: 'epoch-1', revision: 1, generatedAt: '2026-10-18T00:00:00Z', stale: false, sessions, ...overrides
});

test('stale runtime cannot replace successfully refreshed idle state, title, or timestamps', () => {
  const store = new SessionRuntimeStore();
  store.apply(snapshot([runtime('session-1')]));
  store.markStale();
  const fresh = { id: 'session-1', title: 'fresh title', updatedAt: '2026-10-19T01:00:00Z',
    activityStatus: 'idle', activityUpdatedAt: '2026-10-19T01:00:00Z', runtimeState: 'idle',
    runtimeUpdatedAt: '2026-10-19T01:00:00Z', activeTurnId: '', canInterrupt: false, detailAvailable: true };
  const merged = store.mergeSessions([fresh]);
  assert.deepEqual(merged, [fresh]);
  assert.equal(merged[0], fresh, 'the successful list record stays authoritative');
  assert.deepEqual(store.activeSessionIds(), []);
});

test('partial recovery keeps missing-session metadata as cache without reviving stale running activity', () => {
  const store = new SessionRuntimeStore();
  store.apply(snapshot([runtime('session-1'), runtime('cached-only')]));
  store.markStale();
  const fresh = { id: 'session-1', title: 'partial recovery', updatedAt: '2026-10-19T02:00:00Z', detailAvailable: true };
  const merged = store.mergeSessions([fresh]);
  assert.equal(merged.find(session => session.id === fresh.id), fresh, 'missing new activity is not permission to resurrect old state');
  const cached = merged.find(session => session.id === 'cached-only');
  assert.equal(cached.title, 'cached title');
  assert.equal(cached.updatedAt, '2026-10-18T00:00:00Z');
  assert.equal(SessionRuntimeStore.isActiveState(cached.runtimeState ?? cached.activityStatus ?? ''), false);
  assert.notEqual(cached.canInterrupt, true);
  assert.deepEqual(store.activeSessionIds(), []);
});

test('fresh runtime restores authority and same-revision newer timestamp clears staleness', () => {
  const store = new SessionRuntimeStore();
  store.apply(snapshot([runtime('session-1')]));
  store.markStale();
  assert.deepEqual(store.activeSessionIds(), []);
  assert.equal(store.apply(snapshot([runtime('session-1', 'waiting_input')], { generatedAt: '2026-10-19T03:00:00Z' })), true);
  assert.equal(store.snapshot().stale, false);
  assert.equal(store.snapshot().generatedAt, '2026-10-19T03:00:00Z');
  assert.deepEqual(store.activeSessionIds(), ['session-1']);
  assert.equal(store.mergeSessions([{ id: 'session-1', title: 'list', detailAvailable: true }])[0].runtimeState, 'waiting_input');
  assert.equal(store.apply(snapshot([], { generatedAt: '2026-10-17T00:00:00Z' })), false);
  assert.deepEqual(store.activeSessionIds(), ['session-1']);
});
