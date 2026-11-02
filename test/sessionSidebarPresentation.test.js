import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionSidebarPresentation.ets', import.meta.url), 'utf8')
  .replace(/^import\s+.*?;\s*$/gm, '');
const { reconcileSessionSidebar } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

const summary = (id, overrides = {}) => ({
  id,
  title: `${id} title`,
  updatedAt: '2026-10-24T10:00:00Z',
  activityStatus: 'idle',
  detailAvailable: true,
  ...overrides
});

test('unchanged complete summaries reuse rows and return the previous array', () => {
  const previous = [summary('a'), summary('b')];
  const latest = previous.map((session) => ({ ...session }));

  const result = reconcileSessionSidebar(previous, latest, true);

  assert.equal(result, previous);
  assert.equal(result[0], previous[0]);
  assert.equal(result[1], previous[1]);
});

test('keepOrder updates title, time, and activity while preserving existing row order', () => {
  const previous = [summary('a'), summary('b')];
  const latest = [
    summary('b', { title: 'new B', updatedAt: '2026-10-24T11:00:00Z', activityStatus: 'running' }),
    summary('a', { title: 'new A', updatedAt: '2026-10-24T12:00:00Z', activityStatus: 'waiting_input' })
  ];

  const result = reconcileSessionSidebar(previous, latest, true);

  assert.deepEqual(result.map((session) => session.id), ['a', 'b']);
  assert.equal(result[0].title, 'new A');
  assert.equal(result[0].updatedAt, '2026-10-24T12:00:00Z');
  assert.equal(result[0].activityStatus, 'waiting_input');
  assert.equal(result[1].title, 'new B');
  assert.equal(result[1].updatedAt, '2026-10-24T11:00:00Z');
  assert.equal(result[1].activityStatus, 'running');
  assert.equal(result[0], latest[1]);
  assert.equal(result[1], latest[0]);
});

test('keepOrder removes deleted sessions and appends new sessions in remote order', () => {
  const previous = [summary('a'), summary('b'), summary('c')];
  const latest = [summary('c'), summary('d'), summary('a'), summary('e')];

  const result = reconcileSessionSidebar(previous, latest, true);

  assert.deepEqual(result.map((session) => session.id), ['a', 'c', 'd', 'e']);
  assert.equal(result.some((session) => session.id === 'b'), false);
  assert.equal(result[2], latest[1]);
  assert.equal(result[3], latest[3]);
});

test('keepOrder false follows the latest remote ordering', () => {
  const previous = [summary('a'), summary('b')];
  const latest = [summary('b'), summary('a')];

  const result = reconcileSessionSidebar(previous, latest, false);

  assert.deepEqual(result.map((session) => session.id), ['b', 'a']);
  assert.equal(result[0], previous[1]);
  assert.equal(result[1], previous[0]);
});

test('changed fingerprint and backend metadata remain present on the latest row', () => {
  const previous = [summary('a', {
    backendFingerprint: { revision: 1, digest: 'old' },
    backendMetadata: { source: 'desktop', marker: 'keep-me' }
  })];
  const latest = [summary('a', {
    backendFingerprint: { revision: 2, digest: 'new' },
    backendMetadata: { source: 'desktop', marker: 'keep-me', updated: true }
  })];

  const result = reconcileSessionSidebar(previous, latest, true);

  assert.equal(result[0], latest[0]);
  assert.deepEqual(result[0].backendFingerprint, { revision: 2, digest: 'new' });
  assert.deepEqual(result[0].backendMetadata, { source: 'desktop', marker: 'keep-me', updated: true });
  assert.deepEqual(result[0], latest[0]);
});

test('reconciliation does not mutate either input array or any row data', () => {
  const previous = Object.freeze([
    Object.freeze(summary('a', { backendMetadata: Object.freeze({ region: 'local' }) })),
    Object.freeze(summary('b'))
  ]);
  const latest = Object.freeze([
    Object.freeze(summary('b', { activityStatus: 'running' })),
    Object.freeze(summary('c', { backendFingerprint: Object.freeze({ revision: 3 }) }))
  ]);
  const previousBefore = JSON.stringify(previous);
  const latestBefore = JSON.stringify(latest);

  reconcileSessionSidebar(previous, latest, true);

  assert.equal(JSON.stringify(previous), previousBefore);
  assert.equal(JSON.stringify(latest), latestBefore);
});
