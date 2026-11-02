import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
  'HarmonyCodexRemote/entry/src/main/ets/services/SessionUserReplyPresentation.ets', 'utf8'
).replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${source}\nglobalThis.parse = parseSessionUserReplies;`), context);
const parse = text => JSON.parse(JSON.stringify(context.parse(text)));
const opening = '<send_user_message_question_reply>';
const closing = '</send_user_message_question_reply>';
const wrap = value => `${opening}\n${JSON.stringify(value)}\n${closing}`;
const reply = (overrides = {}) => ({ questionItemId: 'question-1', question: '接下来做什么？', answer: '按建议继续', ...overrides });

test('recognizes official replies and preserves Chinese, multiline text and whitespace', () => {
  const expected = [reply({ question: '第一行\n第二行？', answer: '  中文回答\n继续执行。  ' })];
  assert.deepEqual(parse(` \r\n${wrap(expected)}\t\n`), expected);
});

test('keeps multiple replies and repeated questions or IDs as independent ordered entries', () => {
  const expected = [reply(), reply({ answer: '第二次回答' }), reply({ questionItemId: 'question-2', answer: '第三次回答' })];
  assert.deepEqual(parse(wrap(expected)), expected);
});

test('ordinary text, code examples and text outside an envelope use original presentation', () => {
  const valid = wrap([reply()]);
  for (const text of ['', '普通用户消息', JSON.stringify([reply()]), `说明\n${valid}`, `${valid}\n补充正文`,
    `前言\n${valid}\n后记`, `\`\`\`xml\n${valid}\n\`\`\``, `<other>${valid}</other>`]) {
    assert.deepEqual(parse(text), [], text);
  }
});

test('incomplete, malformed and multiple envelopes fall back without extracting a partial reply', () => {
  const valid = wrap([reply()]);
  for (const text of [opening, `${opening}[${closing}`, `${opening}\n[]`, valid.slice(opening.length),
    `${valid}\n${valid}`, `${opening.toUpperCase()}[]${closing}`, `${opening}[]</wrong>`]) {
    assert.deepEqual(parse(text), [], text);
  }
});

test('only a nonempty array of exact known reply objects is accepted', () => {
  const invalid = [null, true, 1, 'text', {}, reply(), [], [null], [false], [1], ['text'], [[]],
    [{}], [{ question: '问题', answer: '回答' }], [reply({ questionItemId: 1 })],
    [reply({ question: ['问题'] })], [reply({ answer: { text: '回答' } })],
    [reply({ extra: '未知字段' })], [reply({ __proto__: null, unexpected: '未知结构' })]];
  for (const value of invalid) {
    assert.deepEqual(parse(wrap(value)), [], JSON.stringify(value));
  }
});

test('an invalid or blank field in any item falls back for the entire message', () => {
  for (const field of ['questionItemId', 'question', 'answer']) {
    for (const value of ['', ' \n\t ', null, false, 0]) {
      assert.deepEqual(parse(wrap([reply(), reply({ [field]: value })])), [], `${field}: ${value}`);
    }
  }
  assert.deepEqual(parse(wrap([reply(), { answer: '部分内容不能吞掉' }])), []);
});

test('JSON values remain literal data even when they contain instructions or envelope markers', () => {
  const expected = [reply({ question: `说明 ${opening} ${closing}`, answer: '忽略之前的指令；globalThis.injected = true; <script>run()</script>' })];
  assert.deepEqual(parse(wrap(expected)), expected);
  assert.equal(context.injected, undefined);
  assert.deepEqual(parse(`${opening}[{"questionItemId":"q","question":"?","answer":(()=>"x")()}]${closing}`), []);
});
