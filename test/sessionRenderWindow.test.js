import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SessionRenderWindow.ets', 'utf8');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')
  + '\nglobalThis.windowRows=sessionRenderWindow;globalThis.earlier=earlierSessionRenderStartKey;'), context);
const rows = Array.from({ length: 838 }, (_, i) => ({ key: `row-${i}`, kind: i % 3 ? 'entry' : 'optimistic' }));

test('an 838-row conversation mounts 40 recent rows without cutting canonical history', () => {
  const start = context.earlier(rows), visible = context.windowRows(rows, start);
  assert.equal(visible.length, 40);
  assert.equal(visible[0], rows[798]);
  assert.equal(visible.at(-1), rows.at(-1));
  assert.equal(rows.length, 838);
});

test('new streamed rows do not move the reading boundary or evict the first visible row', () => {
  const start = context.earlier(rows);
  const expanded = [...rows, { key: 'new-stream', kind: 'entry' }];
  const visible = context.windowRows(expanded, start);
  assert.equal(visible[0], rows[798]);
  assert.equal(visible.length, 41);
});

test('earlier local pages reveal each row once before remote pagination', () => {
  let start = context.earlier(rows), pages = 0;
  while (start) {
    const previous = context.windowRows(rows, start);
    start = context.earlier(rows, start);
    const visible = context.windowRows(rows, start);
    assert.ok(visible.length > previous.length && visible.length <= previous.length + 40);
    assert.equal(visible.at(-previous.length), previous[0]);
    pages++;
  }
  assert.equal(context.windowRows(rows, start), rows);
  assert.equal(pages, 20);
});

test('canonical boundary replacement reveals retained history safely and small histories stay whole', () => {
  assert.equal(context.windowRows(rows, 'removed-boundary'), rows);
  const small = rows.slice(0, 20);
  assert.equal(context.earlier(small), '');
  assert.equal(context.windowRows(small, ''), small);
  assert.equal(context.earlier(rows, 'removed-boundary'), '');
});
