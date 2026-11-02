import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { CodexSessionStore } from '../src/codexSessions.js';

const source = readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/OptimisticMessageService.ets', import.meta.url), 'utf8');
const module = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const { markOptimisticSessionSubmitted: mark, reconcileOptimisticSessionMessages: reconcile, stableCanonicalMessageKey: key } = module;
const start = '2026-10-19T10:00:00.500Z';
const later = '2026-10-19T10:00:01.000Z';
const optimistic = (id, overrides = {}) => ({ id, sessionId: 'session', isNewSession: false, projectId: 'project', submissionId: id, text: 'hello', images: [], files: [], createdAt: start, baselineEntryKeys: [], ...overrides });
const canonical = (id, overrides = {}) => ({ timestamp: later, type: 'response_item', role: 'user', text: 'hello', itemId: id, threadId: 'session', ...overrides });
const submit = (messages, id, overrides = {}) => mark(messages, id, { sessionId: 'session', taskId: `task-${id}`, text: 'hello', ...overrides });

test('two accepted sends remain visible throughout the canonical-history gap', () => {
  const first = optimistic('one', { images: [{ id: 'image', uri: 'image://one', fileName: 'one.png', mimeType: 'image/png' }] });
  const second = optimistic('two');
  let messages = submit([first, second], 'one', { turnId: 'turn-one' });
  messages = submit(messages, 'two', { turnId: 'turn-two' });
  const visible = reconcile(messages, 'session', []);
  assert.equal(visible.length, 2);
  assert.equal(visible[0].images[0].uri, 'image://one');
  assert.equal(visible[0].createdAt, start);
  assert.equal(visible[0].text, 'hello');
  assert.equal(visible[0].state, 'submitted');
  assert.equal(visible[1].taskId, 'task-two');
  assert.equal(first.state, undefined);
});

test('new-session acknowledgement retargets only the matching submission and retains attachments', () => {
  const first = optimistic('one', { sessionId: '__new_session__', isNewSession: true, files: [{ id: 'file', fileName: 'report.pdf' }] });
  const second = optimistic('two', { sessionId: 'elsewhere' });
  const result = submit([first, second], 'one', { sessionId: 'created-session', text: 'hello\n[report](file://remote/report.pdf)' });
  assert.equal(result[0].sessionId, 'created-session');
  assert.equal(result[0].isNewSession, false);
  assert.deepEqual(result[0].files, first.files);
  assert.equal(result[0].submittedText, 'hello\n[report](file://remote/report.pdf)');
  assert.equal(result[1], second);
  assert.equal(first.sessionId, '__new_session__');
});

test('official arrival removes only the matching turn and a live user echo never acknowledges', () => {
  const messages = [submit([optimistic('one')], 'one', { turnId: 'turn-one' })[0], submit([optimistic('two')], 'two', { turnId: 'turn-two' })[0]];
  assert.equal(reconcile(messages, 'session', [canonical('live', { type: 'live_user_message', turnId: 'turn-one' })]).length, 2);
  assert.deepEqual(reconcile(messages, 'session', [canonical('item-one', { turnId: 'turn-one' })]).map(value => value.id), ['two']);
});

test('old baseline text and prior timestamps cannot acknowledge a repeated send', () => {
  const old = canonical('old', { timestamp: later });
  const messages = submit([optimistic('one', { baselineEntryKeys: [key(old)] })], 'one');
  assert.equal(reconcile(messages, 'session', [old]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('early', { timestamp: '2026-10-19T09:57:00.000Z' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('invalid-time', { timestamp: '' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('new')]).length, 0);
});

test('a canonical user record acknowledges at most one repeated text send across repeated polls', () => {
  const messages = submit(submit([optimistic('one'), optimistic('two')], 'one'), 'two');
  const official = canonical('first');
  const remaining = reconcile(messages, 'session', [official]);
  assert.deepEqual(remaining.map(value => value.id), ['two']);
  assert.equal(reconcile(remaining, 'session', [official]).length, 1);
  assert.equal(reconcile(remaining, 'session', [official, canonical('second')]).length, 0);
  assert.deepEqual(messages[1].baselineEntryKeys, []);
});

test('full submitted text preserves mismatched attachment URLs and internal spacing', () => {
  const full = 'hello\r\n![photo](https://files.example/one.png)';
  const messages = submit([optimistic('one')], 'one', { text: full });
  assert.equal(reconcile(messages, 'session', [canonical('wrong-url', { text: 'hello\n![photo](https://files.example/two.png)' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('body-only', { text: 'hello' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('extra-space', { text: full.replace('hello', 'hel lo') })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('exact', { text: full.replaceAll('\r\n', '\n') })]).length, 0);
});

async function realVisibleUserEntry(t, raw, recordType = 'response_item') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'optimistic-projection-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'optimistic-projection-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'sessions', '2026', '10', '19');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id: 'session', thread_name: 'Projection', updated_at: later }) + '\n');
  const payload = recordType === 'response_item'
    ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }] }
    : { type: 'user_message', message: raw };
  await fs.writeFile(path.join(directory, 'rollout-2026-10-19T10-00-00-session.jsonl'), JSON.stringify({ timestamp: later, type: recordType, payload }) + '\n');
  const detail = await new CodexSessionStore({ codexHome: root }).getSession('session');
  assert.equal(detail.entries.length, 1);
  return detail.entries[0];
}

for (const recordType of ['response_item', 'event_msg']) {
  test(`real ${recordType} sanitize output confirms the deterministic visible submission projection`, async t => {
    const raw = '  $briefbound-bug-review\r\n\r\n请检查\n\n\n\n这条消息。  \n';
    const entry = await realVisibleUserEntry(t, raw, recordType);
    assert.equal(entry.text, '请检查\n\n这条消息。');
    const messages = submit([optimistic('one')], 'one', { text: raw });
    assert.equal(reconcile(messages, 'session', [entry]).length, 0);
  });
}

test('visible projection still enforces old baseline, turn, time and one-to-one polling', async t => {
  const raw = '$review  hello\n\n\nworld  ';
  const entry = await realVisibleUserEntry(t, raw);
  const messages = submit(submit([optimistic('one'), optimistic('two')], 'one', { text: raw }), 'two', { text: raw });
  const remaining = reconcile(messages, 'session', [entry]);
  assert.equal(remaining.length, 1);
  assert.equal(reconcile(remaining, 'session', [entry]).length, 1);
  const baseline = submit([optimistic('baseline', { baselineEntryKeys: [key(entry)] })], 'baseline', { text: raw });
  assert.equal(reconcile(baseline, 'session', [entry]).length, 1);
  assert.equal(reconcile(messages, 'session', [{ ...entry, timestamp: '2026-10-19T09:57:00.000Z' }]).length, 2);
  const wrongTurn = submit([optimistic('turn')], 'turn', { text: raw, turnId: 'one' });
  assert.equal(reconcile(wrongTurn, 'session', [{ ...entry, turnId: 'two' }]).length, 1);
});

test('real sanitize output never hides a different Markdown attachment identity during confirmation', async t => {
  const raw = '$review\nhello\n\n\n![photo](https://files.example/one.png)  ';
  const correct = await realVisibleUserEntry(t, raw);
  const different = await realVisibleUserEntry(t, raw.replace('/one.png', '/two.png'));
  const messages = submit([optimistic('one')], 'one', { text: raw });
  assert.equal(reconcile(messages, 'session', [different]).length, 1);
  assert.equal(reconcile(messages, 'session', [correct]).length, 0);
  assert.equal(reconcile(messages, 'session', [{ ...correct, text: 'hello' }]).length, 1);
});

test('real sanitizer internal blocks, placeholders, directives and AGENTS suffix have a deterministic projection', async t => {
  const raw = ' $review hello\n<environment_context>hidden environment</environment_context>\n<image></image>\n::archive{\nreason="done"\n}\n\n\nworld\n# AGENTS.md instructions\nhidden guidance';
  const entry = await realVisibleUserEntry(t, raw);
  assert.equal(entry.text, 'hello\n\nworld');
  const messages = submit([optimistic('one')], 'one', { text: raw });
  assert.equal(reconcile(messages, 'session', [entry]).length, 0);
});

test('server-stripped image paths and hidden attachments cannot become prose-only acknowledgements', async t => {
  for (const raw of [
    'hello\n<image path="C:/uploads/one.png"></image>',
    'hello\n<environment_context>![photo](https://files.example/one.png)</environment_context>',
    'hello\n::archive{file="C:/uploads/one.png"}'
  ]) {
    const entry = await realVisibleUserEntry(t, raw);
    assert.equal(entry.text, 'hello');
    const messages = submit([optimistic('one')], 'one', { text: raw });
    assert.equal(reconcile(messages, 'session', [entry]).length, 1);
  }
});

test('projection applies the leading skill rule once and never equates truncated or collapsed prose', async t => {
  const raw = '$first $second hello';
  const entry = await realVisibleUserEntry(t, raw);
  assert.equal(entry.text, '$second hello');
  const messages = submit([optimistic('one')], 'one', { text: raw });
  assert.equal(reconcile(messages, 'session', [entry]).length, 0);
  assert.equal(reconcile(messages, 'session', [{ ...entry, text: 'hello' }]).length, 1);
  const long = '$first ' + 'a'.repeat(20001);
  const truncated = await realVisibleUserEntry(t, long);
  assert.equal(truncated.text.length, 20003);
  assert.equal(reconcile(submit([optimistic('long')], 'long', { text: long }), 'session', [truncated]).length, 1);
});

test('cross-session, assistant, live-kind, and unsubmitted records never acknowledge', () => {
  const messages = submit([optimistic('one')], 'one');
  assert.equal(reconcile(messages, 'other-session', [canonical('item')]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('item', { threadId: 'other-session' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('item', { role: 'assistant' })]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('item', { liveKind: 'live_user' })]).length, 1);
  assert.equal(reconcile([optimistic('one')], 'session', [canonical('item')]).length, 1);
});

test('exact item identity is authoritative and conflicting item identities cannot fall back to text', () => {
  const messages = submit([optimistic('one')], 'one', { itemId: 'expected-item' });
  assert.equal(reconcile(messages, 'session', [canonical('different-item')]).length, 1);
  assert.equal(reconcile(messages, 'session', [canonical('expected-item', { text: 'official format', timestamp: '' })]).length, 0);
});

test('canonical baseline keys are stable for item/sync identity and full fallback content', () => {
  assert.equal(key(canonical('item')), key(canonical('item', { text: 'updated', timestamp: start })));
  assert.equal(key(canonical(undefined, { syncId: 'sync-one' })), key(canonical(undefined, { syncId: 'sync-one', timestamp: start })));
  assert.notEqual(key(canonical(undefined, { text: 'first' })), key(canonical(undefined, { text: 'second' })));
  assert.notEqual(key(canonical('same', { threadId: 'session' })), key(canonical('same', { threadId: 'other-session' })));
});

test('precise item ownership wins before an earlier identical-text fallback candidate', () => {
  const messages = submit(submit([optimistic('fallback'), optimistic('precise')], 'fallback'), 'precise', { itemId: 'precise-item' });
  const remaining = reconcile(messages, 'session', [canonical('precise-item')]);
  assert.deepEqual(remaining.map(value => value.id), ['fallback']);
  assert.equal(reconcile(remaining, 'session', [canonical('precise-item')]).length, 1);
});

test('consumed canonical keys also follow a still-sending bubble through later acknowledgement', () => {
  const sending = optimistic('sending', { state: 'sending' });
  const elsewhere = optimistic('elsewhere', { sessionId: 'elsewhere' });
  const first = submit([optimistic('submitted'), sending, elsewhere], 'submitted');
  const official = canonical('first');
  const remaining = reconcile(first, 'session', [official]);
  assert.equal(remaining[0].state, 'sending');
  assert.ok(remaining[0].baselineEntryKeys.includes(key(official)));
  assert.deepEqual(remaining[1].baselineEntryKeys, []);
  const acknowledged = submit(remaining, 'sending');
  assert.equal(reconcile(acknowledged, 'session', [official]).length, 2);
});
