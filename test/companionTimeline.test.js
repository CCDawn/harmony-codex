import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/CompanionTimeline.ets', import.meta.url), 'utf8')
  .replace(/^import\s+.*?;\s*$/gm, '');
const executable = stripTypeScriptTypes(source, { mode: 'strip' });
const { mergeCompanionHistory: merge, composeCompanionTimeline: compose, companionTimelineRenderKey: renderKey } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
const entry = (itemId, createdAt, overrides = {}) => ({ itemId, role: 'user', text: itemId, final: true, ...(createdAt === undefined ? {} : { createdAt }), ...overrides });
const text = (requestId, createdAt, overrides = {}) => ({ requestId, createdAt, text: requestId, state: 'pending', itemId: null, detail: '', ...overrides });
const ids = entries => entries.map(value => value.itemId);
const acceptedRequest = '11111111-1111-4111-8111-111111111111';

test('1518 legacy phone turns survive repeated refreshes before newer official records', () => {
  const cached = Array.from({ length: 1518 }, (_, index) => entry(`voice:${index}`, undefined, { phoneTranscript: true, localStorageStatus: 'saved' }));
  const fresh = entry('room:new', 2000);
  const merged = merge(cached, [fresh], false);
  assert.equal(merged.length, 1519);
  assert.equal(merged.at(-1).itemId, fresh.itemId);
  assert.deepEqual(ids(merged.slice(0, -1)), ids(cached));
  assert.equal(merged[0].phoneTranscript, true);
  assert.equal(merged[0].createdAt, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(merge(merged, [fresh], false))), JSON.parse(JSON.stringify(merged)));
  assert.equal(compose(merged, [text('pending', 1900)]).at(-1).entry.itemId, 'room:new');
});

test('refresh retains older pages and applies a fetched older-page update by role/itemId', () => {
  const current = [entry('room:middle', 200), entry('room:latest', 300)];
  const paged = merge(current, [entry('room:oldest', 100), entry('room:middle', 200, { text: 'corrected' })], true);
  assert.deepEqual(ids(paged), ['room:oldest', 'room:middle', 'room:latest']);
  assert.equal(paged[1].text, 'corrected');
  const refreshed = merge(paged, [entry('room:latest', 300, { text: 'latest update' }), entry('room:new', 400)], false);
  assert.deepEqual(ids(refreshed), ['room:oldest', 'room:middle', 'room:latest', 'room:new']);
  assert.equal(current[0].text, 'room:middle');
});

test('out-of-order timestamps sort reliably and unknown/invalid times keep stable legacy order', () => {
  const entries = [entry('room:3', 300), entry('voice:legacy', undefined), entry('room:1', 100), entry('invalid', NaN), entry('room:2', 100)];
  assert.deepEqual(ids(merge([], entries, false)), ['voice:legacy', 'invalid', 'room:1', 'room:2', 'room:3']);
  assert.deepEqual(ids(merge([entry('later-legacy')], [entry('older-legacy')], true)), ['older-legacy', 'later-legacy']);
  const composed = compose(entries, [text('text:2', 200), text('text:0', 50)]);
  assert.deepEqual(composed.map(value => value.entry?.itemId ?? value.message.requestId), ['voice:legacy', 'invalid', 'text:0', 'room:1', 'room:2', 'text:2', 'room:3']);
  assert.equal(new Set(composed.map(value => value.key)).size, composed.length);
});

test('role is part of stable identity and identical text never establishes identity', () => {
  const entries = [entry('room:same', 100, { text: 'same' }), entry('room:same', 100, { role: 'assistant', text: 'same' }), entry(undefined, undefined, { text: 'same' }), entry(undefined, undefined, { text: 'same' })];
  assert.equal(merge([], entries, false).length, 4);
  const composed = compose(entries, [text('one', 200, { text: 'same' }), text('two', 201, { text: 'same' })]);
  assert.equal(composed.length, 6);
  assert.equal(new Set(composed.map(value => value.key)).size, 6);
});

test('a precise official user requestId or itemId folds an outbox copy without hiding other text', () => {
  const entries = [entry('room:accepted', 100, { requestId: acceptedRequest, text: 'accepted' }), entry('room:assistant', 200, { role: 'assistant', requestId: 'assistant-request' }), entry('voice:local', 300, { phoneTranscript: true, requestId: 'local-request' })];
  const messages = [text(acceptedRequest, 90, { text: 'accepted' }), text('by-item', 95, { itemId: 'room:accepted' }), text('assistant-request', 190), text('local-request', 290), text('same-content', 400, { text: 'accepted' })];
  const result = compose(entries, messages);
  assert.deepEqual(result.filter(value => value.message !== null).map(value => value.message.requestId), ['assistant-request', 'local-request', 'same-content']);
  assert.equal(messages.length, 5);
});

test('request confirmation requires a valid UUID and exact original text, while item identity is sufficient', () => {
  const entries = [entry('room:valid', 100, { requestId: acceptedRequest, text: 'original' }), entry('room:invalid', 200, { requestId: 'not-a-uuid', text: 'same' })];
  const messages = [text(acceptedRequest, 90, { text: 'different' }), text('not-a-uuid', 190, { text: 'same' }), text('item-only', 300, { itemId: 'room:valid', text: 'different' })];
  const result = compose(entries, messages);
  assert.deepEqual(result.filter(value => value.message !== null).map(value => value.message.requestId), [acceptedRequest, 'not-a-uuid']);
  assert.equal(new Set(result.map(value => value.key)).size, result.length);
});

test('confirmed official text keeps the pending bubble key across handoff', () => {
  const message = text(acceptedRequest, 100, { text: 'original' });
  const pending = compose([], [message]);
  const official = compose([entry('room:valid', 200, { requestId: acceptedRequest, text: 'original' })], [message]);
  assert.equal(official.length, 1);
  assert.equal(official[0].key, pending[0].key);
  assert.equal(official[0].message, null);
});

test('UUID matching and handoff keys use lowercase and voice items never acknowledge text', () => {
  const requestId = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
  const message = text(requestId, 100, { text: 'original' });
  const pending = compose([], [message]);
  const confirmed = compose([entry('room:valid', 200, { requestId: requestId.toLowerCase(), text: 'original' })], [message]);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].key, pending[0].key);
  assert.equal(confirmed[0].key, `text:${requestId.toLowerCase()}`);
  const voiceOnly = compose([entry('voice:unmarked', 200, { requestId, text: 'original' })], [message]);
  assert.equal(voiceOnly.length, 2);
  assert.equal(new Set(voiceOnly.map(value => value.key)).size, 2);
  const duplicateOutbox = compose([], [message, { ...message, requestId: requestId.toLowerCase(), state: 'uncertain' }]);
  assert.equal(duplicateOutbox.length, 1);
  assert.equal(duplicateOutbox[0].message.state, 'uncertain');
});

test('same requestId keeps latest outbox state at its first creation time and keeps distinct requests', () => {
  const messages = [text('one', 100), text('two', 200, { text: 'same' }), text('one', 300, { text: 'same', state: 'uncertain', detail: 'check history' })];
  const result = compose([], messages);
  assert.equal(result.length, 2);
  assert.equal(result[0].message.state, 'uncertain');
  assert.equal(result[0].message.createdAt, 100);
  assert.equal(result[0].key, 'text:one');
  assert.equal(messages[2].createdAt, 300);
});

test('a page update preserves local recovery metadata and a known time when absent from the page', () => {
  const local = entry('voice:one', 100, { phoneTranscript: true, callId: 'call', localStorageStatus: 'saved', requestId: 'request' });
  const merged = merge([local], [entry('voice:one', undefined, { text: 'updated' })], false);
  assert.equal(merged[0].createdAt, 100);
  assert.equal(merged[0].requestId, 'request');
  assert.equal(merged[0].phoneTranscript, true);
  assert.equal(merged[0].localStorageStatus, 'saved');
  assert.equal(local.text, 'voice:one');
});


test('ArkUI render identity changes for visible state, official handoff, streaming and save updates', () => {
  const pending = compose([], [text(acceptedRequest, 100, { text: 'hello' })])[0];
  const uncertain = compose([], [text(acceptedRequest, 100, { text: 'hello', state: 'uncertain', detail: '核对中' })])[0];
  const official = compose([entry('room:ok', 100, { text: 'hello', requestId: acceptedRequest })], [text(acceptedRequest, 100, { text: 'hello' })])[0];
  assert.equal(pending.key, official.key);
  assert.notEqual(renderKey(pending), renderKey(uncertain));
  assert.notEqual(renderKey(uncertain), renderKey(official));
  assert.equal(renderKey(official), renderKey(compose([official.entry], [])[0]));
  const streaming = compose([entry('voice:turn', 200, { text: '片段', final: false, phoneTranscript: true })], [])[0];
  const final = { ...streaming, entry: { ...streaming.entry, text: '片段结束', final: true } };
  assert.notEqual(renderKey(streaming), renderKey(final));
  assert.notEqual(renderKey(final), renderKey({ ...final, entry: { ...final.entry, localStorageStatus: 'saved' } }));
});
