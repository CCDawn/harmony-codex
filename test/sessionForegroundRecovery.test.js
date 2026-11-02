import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function setup(read) {
  const logs = [];
  const context = vm.createContext({ BridgeClient: { getSession: read } });
  vm.runInContext(stripTypeScriptTypes(`class Page { ${['beginSessionDetailSnapshotRead',
    'refreshSelectedSessionDetail'].map(method).join('\n')} }\nglobalThis.Page=Page;`), context);
  const page = Object.assign(new context.Page(), { selectedSession: { id: 'thread-a', entryCount: 2,
    entries: [{ role: 'assistant', text: 'previous content' }] },
    bridgeToken: 'test', sessionDetailRefreshSeq: 0, sessionDetailSnapshotRevisions: new Map(),
    normalizedBridgeUrl: () => 'https://fixture.test', readSessionNavigation: () => ({ revision: 1 }),
    refreshDesktopInteractions: async () => {}, sessionBottomSignature: () => 'old',
    errorText: error => error.message, log: (level, event) => logs.push({ level, event }) });
  return { page, logs };
}

test('foreground history read failure is handled without losing the displayed conversation', async () => {
  const { page, logs } = setup(async () => { throw new Error('network unavailable after lock'); });
  const previous = page.selectedSession;
  await assert.doesNotReject(page.refreshSelectedSessionDetail());
  assert.equal(page.selectedSession, previous);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'session.detail.refresh_failed');
});

test('an old failed foreground read cannot change or report an error in the next conversation', async () => {
  const gate = Promise.withResolvers();
  const { page, logs } = setup(() => gate.promise);
  const pending = page.refreshSelectedSessionDetail();
  page.selectedSession = { id: 'thread-b', entries: [], entryCount: 0 };
  gate.reject(new Error('old connection timed out'));
  await assert.doesNotReject(pending);
  assert.equal(page.selectedSession.id, 'thread-b');
  assert.equal(logs.length, 0);
});
