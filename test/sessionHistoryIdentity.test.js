import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
const start = source.indexOf('  private mergeSessionEntryPages(');
const end = source.indexOf('\n  }', start) + 4;
const method = source.slice(start, end).replace('private ', '');
const merge = new Function(`${stripTypeScriptTypes(`class Page { ${method} }`)}; return new Page().mergeSessionEntryPages.bind(new Page());`)();
const timestamp = '2026-10-21T14:27:05.466Z';
const entry = (role, text, syncId, extra = {}) => ({ timestamp, type: 'response_item', role, text, syncId, ...extra });
const file = (offset, role = 'user', text = 'one send', extra = {}) => entry(role, text, `${offset}:${offset + 50}:${role}:response_item:0`, extra);
const full = (id = '0123456789abcdef', role = 'user', text = 'one send', extra = {}) => entry(role, text, `entry:${id}`, extra);

test('file sync and full detail aliases render user and assistant records once in either arrival order', () => {
  const paged = [file(100), file(200, 'assistant', 'one answer')];
  const detail = [full(), full('fedcba9876543210', 'assistant', 'one answer')];
  for (const [older, newer] of [[paged, detail], [detail, paged]]) {
    const result = merge(older, newer);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(e => e.syncId), paged.map(e => e.syncId));
  }
});

test('a later refresh repairs aliases already retained by the old merger', () => {
  const old = [file(100), full(), file(200, 'assistant', 'one answer'), full('fedcba9876543210', 'assistant', 'one answer')];
  const result = merge(old, [file(300, 'assistant', 'next answer')]);
  assert.equal(result.length, 3);
  assert.equal(result.filter(e => e.text === 'one send').length, 1);
  assert.equal(result.filter(e => e.text === 'one answer').length, 1);
});

test('distinct file records with identical text and timestamps remain separate real sends', () => {
  const first = file(100), second = file(200);
  assert.deepEqual(merge([first, second], [full()]).map(e => e.syncId), [first.syncId, second.syncId]);
  assert.equal(merge([first], [second]).length, 2);
  assert.equal(merge([full()], [file(200, 'user', 'one send', { timestamp: '2026-10-21T14:27:06.466Z' })]).length, 2);
});

test('conflicting item or turn identities and unfamiliar sync schemes never collapse by equal content', () => {
  for (const field of ['itemId', 'turnId', 'threadId']) {
    assert.equal(merge([file(100, 'user', 'one send', { [field]: 'a' })], [full(undefined, 'user', 'one send', { [field]: 'b' })]).length, 2);
  }
  assert.equal(merge([file(100)], [entry('user', 'one send', 'other:identity')]).length, 2);
});

test('alternating full and paginated refreshes cannot grow the visible history', () => {
  const paged = [file(100), file(200, 'assistant', 'one answer')];
  const detail = [full(), full('fedcba9876543210', 'assistant', 'one answer')];
  let result = paged;
  for (let index = 0; index < 10; index++) {
    result = merge(result, index % 2 ? paged : detail);
    assert.equal(result.length, 2);
  }
});
