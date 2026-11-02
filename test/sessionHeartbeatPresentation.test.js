import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual ArkTS parsing helper, as in sessionUserReplyPresentation.test.js.
const source = fs.readFileSync(
  'HarmonyCodexRemote/entry/src/main/ets/services/SessionHeartbeatPresentation.ets', 'utf8'
).replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${source}\nglobalThis.parse = parseSessionHeartbeat;\nglobalThis.parseResult = parseSessionHeartbeatResult;`), context);
const parse = text => JSON.parse(JSON.stringify(context.parse(text)));
const parseResult = text => JSON.parse(JSON.stringify(context.parseResult(text)));

const wrap = (instructions = '检查任务状态。', id = 'task-123', time = '2026-10-28T01:02:03Z') =>
  `<heartbeat>\n<automation_id>${id}</automation_id>\n<current_time_iso>${time}</current_time_iso>\n<instructions>\n${instructions}\n</instructions>\n</heartbeat>`;

test('recognizes a complete heartbeat and exposes its readable summary and full instructions', () => {
  const instructions = '检查自动任务。\n  如果已完成，向用户汇报。';
  assert.deepEqual(parse(wrap(instructions)), {
    automationId: 'task-123', currentTimeIso: '2026-10-28T01:02:03Z',
    instructions, preview: '检查自动任务。 如果已完成，向用户汇报。'
  });
  // Surrounding whitespace is harmless, and no particular timestamp format is assumed.
  assert.equal(parse(` \r\n${wrap('继续检查', 'id', 'unknown-time')}\t`).currentTimeIso, 'unknown-time');
});

test('preserves multiline instructions and treats text and tags in them as literal data', () => {
  const instructions = '第一行\n\t第二行 <示例>\n请保留 <approval>与提问</approval>。';
  const result = parse(wrap(instructions));
  assert.equal(result.instructions, instructions);
  assert.equal(result.preview, '第一行 第二行 <示例> 请保留 <approval>与提问</approval>。');
});

test('preview collapses whitespace and truncates at 240 Unicode code points without changing instructions', () => {
  const instructions = `开始\n\t${'😀'.repeat(250)}\n结束`;
  const result = parse(wrap(instructions));
  assert.equal(result.instructions, instructions);
  assert.equal(result.preview, Array.from(`开始 ${'😀'.repeat(250)} 结束`).slice(0, 240).join(''));
  assert.equal(Array.from(result.preview).length, 240);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.preview));
});

test('ordinary messages, examples, other structures and actual mixed content fall back intact', () => {
  const valid = wrap();
  for (const text of [
    '', '普通用户消息', 'heartbeat 自动任务', '<heartbeat>普通文本</heartbeat>',
    `前言\n${valid}`, `${valid}\n用户补充内容`, `前言\n${valid}\n后记`,
    `\`\`\`xml\n${valid}\n\`\`\``, `<other>${valid}</other>`,
    `<send_user_message_question_reply>[{"question":"继续？","answer":"是"}]</send_user_message_question_reply>`,
    `<approval>请批准操作</approval>`, `${valid}\n<unknown>不能丢失</unknown>`,
    `${valid}\n${valid}`
  ]) assert.equal(parse(text), null, text);
});

test('incomplete, reordered, duplicate and unknown wrapper fields never produce a partial card', () => {
  const valid = wrap();
  for (const text of [
    '<heartbeat>', valid.slice(0, -'</heartbeat>'.length), valid.replace('</instructions>', ''),
    valid.replace('<automation_id>task-123</automation_id>\n<current_time_iso>2026-10-28T01:02:03Z</current_time_iso>',
      '<current_time_iso>2026-10-28T01:02:03Z</current_time_iso>\n<automation_id>task-123</automation_id>'),
    valid.replace('</automation_id>', '</automation_id>\n<automation_id>other</automation_id>'),
    valid.replace('</instructions>', '</instructions>\n<instructions>额外正文</instructions>'),
    valid.replace('</heartbeat>', '<unknown>不可吞掉</unknown>\n</heartbeat>'),
    valid.replace('<heartbeat>', '<HEARTBEAT>'), valid.replace('</heartbeat>', '</other>')
  ]) assert.equal(parse(text), null, text);
});

test('rejects blank fields and markup embedded in identifier or time', () => {
  for (const text of [
    wrap(''), wrap(' \n\t '), wrap('内容', ''), wrap('内容', ' \t '),
    wrap('内容', 'id', ''), wrap('内容', 'id', ' \t '),
    wrap('内容', 'task<unknown>'), wrap('内容', 'task>id'),
    wrap('内容', 'id', '<unknown>'), wrap('内容', 'id', 'now>later')
  ]) assert.equal(parse(text), null, text);
});

const wrapResult = (message = '任务已检查。', id = 'task-123', decision = 'notify') =>
  `<heartbeat>\n<automation_id>${id}</automation_id>\n<decision>${decision}</decision>\n<message>\n${message}\n</message>\n</heartbeat>`;

test('recognizes a complete heartbeat result and preserves the full natural-language message', () => {
  const message = '任务已检查。\n  保留 <说明> 和后续内容。';
  const result = parseResult(` \r\n${wrapResult(message)}\t`);
  assert.deepEqual(result, {
    automationId: 'task-123', decision: 'notify', message,
    preview: '任务已检查。 保留 <说明> 和后续内容。'
  });
});

test('result preview compresses whitespace and truncates at 240 Unicode code points without changing message', () => {
  const message = `结果\n\t${'😀'.repeat(250)}\n完成`;
  const result = parseResult(wrapResult(message));
  assert.equal(result.message, message);
  assert.equal(result.preview, Array.from(`结果 ${'😀'.repeat(250)} 完成`).slice(0, 240).join(''));
  assert.equal(Array.from(result.preview).length, 240);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.preview));
});

test('result rejects ordinary messages, request heartbeats, mixed text and other structures', () => {
  const valid = wrapResult();
  for (const text of [
    '', '普通助手消息', wrap(), '<heartbeat>自然文本</heartbeat>',
    `前言\n${valid}`, `${valid}\n补充正文`, `前言\n${valid}\n后记`,
    `\`\`\`xml\n${valid}\n\`\`\``, `<other>${valid}</other>`,
    `<approval>请批准操作</approval>`, `${valid}\n<unknown>不能丢失</unknown>`, `${valid}\n${valid}`
  ]) assert.equal(parseResult(text), null, text);
  assert.equal(parse(valid), null);
});

test('result rejects incomplete, reordered, duplicate, unknown and blank wrapper fields', () => {
  const valid = wrapResult();
  for (const text of [
    '<heartbeat>', valid.slice(0, -'</heartbeat>'.length), valid.replace('</message>', ''),
    valid.replace('<automation_id>task-123</automation_id>\n<decision>notify</decision>',
      '<decision>notify</decision>\n<automation_id>task-123</automation_id>'),
    valid.replace('</automation_id>', '</automation_id>\n<automation_id>other</automation_id>'),
    valid.replace('</decision>', '</decision>\n<decision>other</decision>'),
    valid.replace('</message>', '</message>\n<message>额外正文</message>'),
    valid.replace('</heartbeat>', '<unknown>不可吞掉</unknown>\n</heartbeat>'),
    valid.replace('<heartbeat>', '<HEARTBEAT>'), valid.replace('</heartbeat>', '</other>'),
    wrapResult(''), wrapResult(' \n\t '), wrapResult('内容', ''), wrapResult('内容', ' \t '),
    wrapResult('内容', 'id', ''), wrapResult('内容', 'id', ' \t '),
    wrapResult('内容', 'task<unknown>'), wrapResult('内容', 'task>id'),
    wrapResult('内容', 'id', '<unknown>'), wrapResult('内容', 'id', 'notify>later')
  ]) assert.equal(parseResult(text), null, text);
});
