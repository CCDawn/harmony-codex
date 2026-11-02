import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const service = fs.readFileSync(root + 'services/SessionPresentationService.ets', 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
const index = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
const start = index.indexOf('  private mergeSessionEntryPages(');
assert.ok(start >= 0);
const end = index.indexOf('\n  }', start) + 4;
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(service + '\nclass Page {' + index.slice(start, end) +
  '}\nglobalThis.api={compactAdjacentSessionToolEntries,sessionToolPresentationItems,Page};'), context);
const { compactAdjacentSessionToolEntries: compact, sessionToolPresentationItems: items, Page } = context.api;
const tool = (id, status, extra = {}) => ({ id, name: 'request_user_input_async', verb: 'Calling',
  target: 'request_user_input_async', detail: '', status, ...extra });
const entry = (item, extra = {}) => ({ role: 'tool', type: item.status === 'running' ? 'tool_call' : 'tool_result',
  timestamp: '2026-10-23T01:52:24.063Z', text: 'tool fixture', toolItems: [item], ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('the same real call id advances from running to completed once and keeps its metadata', () => {
  const running = entry(tool('call_one', 'running', { args: 'question args', taskName: 'fixture', agents: [{ id: 'agent' }] }));
  const completed = entry(tool('call_one', 'completed', { verb: 'Called', detail: '{"accepted":true}' }));
  const rows = compact([running, completed]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'tool_result');
  assert.equal(items(rows[0]).length, 1);
  assert.deepEqual(plain(items(rows[0])[0]), {
    ...running.toolItems[0], verb: 'Called', detail: '{"accepted":true}', status: 'completed'
  });
  assert.equal(running.toolItems[0].status, 'running');
});

for (const status of ['completed', 'failed', 'stopped']) {
  test(`a late running snapshot cannot replace the same call's ${status} state`, () => {
    const terminal = tool('call_one', status, { detail: 'terminal detail' });
    const rows = compact([entry(terminal), entry(tool('call_one', 'running', { detail: 'late partial' }))]);
    assert.equal(items(rows[0]).length, 1);
    assert.equal(items(rows[0])[0].status, status);
    assert.equal(items(rows[0])[0].detail, 'terminal detail');
    assert.equal(rows[0].type, 'tool_result');
  });
}

test('different real call ids remain separate even when tool, target and text are identical', () => {
  for (const firstStatus of ['running', 'completed', 'failed', 'stopped']) {
    const rows = compact([entry(tool('call_first', firstStatus)), entry(tool('call_second', 'completed'))]);
    assert.deepEqual(Array.from(items(rows[0]), item => item.id), ['call_first', 'call_second']);
    assert.equal(items(rows[0])[0].status, firstStatus);
    assert.equal(items(rows[0])[1].retryCount, undefined);
  }
});

test('a corrected terminal snapshot for the same real id is an update rather than an inferred retry', () => {
  const rows = compact([entry(tool('call_one', 'failed', { detail: 'old error' })),
    entry(tool('call_one', 'completed', { detail: 'confirmed result' }))]);
  assert.equal(items(rows[0]).length, 1);
  assert.equal(items(rows[0])[0].status, 'completed');
  assert.equal(items(rows[0])[0].retryCount, undefined);
  assert.equal(items(rows[0])[0].detail, 'confirmed result');
});

test('legacy retries still fold by tool and target when no real call ids are available', () => {
  const rows = compact([entry(tool('legacy-tool', 'failed', { detail: 'first failure' })),
    entry(tool('legacy-tool', 'completed', { detail: 'retry success' }))]);
  assert.equal(items(rows[0]).length, 1);
  assert.equal(items(rows[0])[0].retryCount, 1);
  assert.match(items(rows[0])[0].detail, /first failure/);
  assert.match(items(rows[0])[0].detail, /retry success/);
});

test('matching call ids in different threads or turns never merge across those boundaries', () => {
  for (const [first, second] of [
    [{ threadId: 'thread-one' }, { threadId: 'thread-two' }],
    [{ threadId: 'thread', turnId: 'turn-one' }, { threadId: 'thread', turnId: 'turn-two' }]
  ]) {
    assert.equal(compact([entry(tool('call_one', 'running'), first), entry(tool('call_one', 'completed'), second)]).length, 2);
  }
});

test('production page merge followed by compaction settles the changing file-range tool snapshot', () => {
  const running = entry(tool('call_dc82277bf57c442292156fa0aed14caf', 'running'), {
    syncId: '684575:685164:tool:tool_call:0', syncStartOffset: 684575, syncEndOffset: 685164
  });
  const completed = entry(tool('call_dc82277bf57c442292156fa0aed14caf', 'completed', { detail: '{"accepted":true}' }), {
    timestamp: '2026-10-23T01:52:24.299Z', syncId: '684575:687068:tool:tool_result:0',
    syncStartOffset: 684575, syncEndOffset: 687068
  });
  const merged = new Page().mergeSessionEntryPages([running], [completed]);
  const rows = compact(merged);
  assert.equal(rows.length, 1);
  assert.equal(items(rows[0]).length, 1);
  assert.equal(items(rows[0])[0].status, 'completed');
  const repeated = compact(new Page().mergeSessionEntryPages(merged, [completed]));
  assert.equal(items(repeated[0]).length, 1);
});

test('terminal updates are processed even when the displayed tool group already contains fifty calls', () => {
  const previous = Array.from({ length: 50 }, (_, n) => tool(`call_${n}`, 'running'));
  const rows = compact([{ ...entry(previous[0]), toolItems: previous }, entry(tool('call_0', 'completed'))]);
  assert.equal(items(rows[0]).length, 50);
  assert.equal(items(rows[0])[0].status, 'completed');
});
