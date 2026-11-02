import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n  }', start) + 4);
}
const names = ['toggleSessionEntryFold', 'toggleSessionToolItem', 'toggleSessionToolGroup', 'toggleSessionMarkdownBlock',
  'beginSessionContentRead', 'handleSessionContentAreaChange', 'scrollSessionToBottomIfFollowing',
  'handleSessionWillScroll', 'handleSessionScrollEdge', 'scrollSessionToBottom'];
const context = vm.createContext({ ScrollSource: { SCROLLER: 0, SCROLLER_ANIMATION: 1, EDGE_EFFECT: 2 }, Edge: { Top: 0, Bottom: 1 } });
vm.runInContext(stripTypeScriptTypes(`class Page { ${names.map(method).join('\n')} } globalThis.Page = Page;`), context);
function setup() {
  const scrolls = [];
  const page = Object.assign(new context.Page(), { sessionAutoFollowBottom: true, sessionUserScrollActive: true,
    historyScrollAnchorKey: 'old-history-anchor', sessionContentHeight: 500, isLoadingOlderSessionEntries: false,
    sessionScroller: { scrollTo(value) { scrolls.push(value.yOffset); }, isAtEnd: () => true }, log() {},
    sessionEntryFoldKey: () => 'fold::item', sessionToolItemKey: () => 'tool::item', sessionToolGroupKey: () => 'group::item',
    sessionMarkdownBlockKey: () => 'markdown::item' });
  let expanded = [];
  Object.defineProperty(page, 'expandedSessionEntries', { get: () => expanded, set(value) {
    expanded = value;
    // Simulate the native layout observer as soon as the visible content changes.
    page.handleSessionContentAreaChange(value.length ? 5000 : 500);
  } });
  return { page, scrolls };
}

for (const [action, key] of [['toggleSessionEntryFold', 'fold::item'], ['toggleSessionToolItem', 'tool::item'],
  ['toggleSessionToolGroup', 'group::item'], ['toggleSessionMarkdownBlock', 'markdown::item']]) {
  test(`${action}: expanding at the live bottom preserves the reading position through layout and incoming text`, () => {
    const { page, scrolls } = setup();
    page[action]({ itemId: 'item' }, { id: 'block', kind: 'code', language: 'text' });
    assert.equal(page.expandedSessionEntries.includes(key), true);
    assert.equal(page.sessionAutoFollowBottom, false);
    assert.equal(page.sessionUserScrollActive, false);
    page.handleSessionContentAreaChange(5100);
    page.scrollSessionToBottomIfFollowing('incoming_text');
    page.handleSessionScrollEdge(1);
    assert.deepEqual(scrolls, [], 'layout, new text and programmatic bottom edges must not move the reader');
    assert.equal(page.sessionAutoFollowBottom, false);
    page[action]({ itemId: 'item' }, { id: 'block', kind: 'code', language: 'text' });
    assert.equal(page.expandedSessionEntries.includes(key), false);
    assert.deepEqual(scrolls, []);
  });
}

test('manual scrolling to the bottom or pressing return-to-bottom explicitly restores live following', () => {
  const { page, scrolls } = setup();
  page.toggleSessionEntryFold({ itemId: 'item' });
  page.handleSessionWillScroll(20, 3);
  page.handleSessionScrollEdge(1);
  assert.equal(page.sessionAutoFollowBottom, true);
  page.scrollSessionToBottomIfFollowing('incoming_text');
  assert.deepEqual(scrolls, [5000]);
  page.toggleSessionEntryFold({ itemId: 'item' });
  assert.equal(page.sessionAutoFollowBottom, false);
  page.scrollSessionToBottom();
  assert.equal(page.sessionAutoFollowBottom, true);
  assert.deepEqual(scrolls, [5000, 500]);
});
