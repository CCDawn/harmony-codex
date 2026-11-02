import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const reducerPath = resolve(
  testDirectory,
  '../HarmonyCodexRemote/entry/src/main/ets/services/VoiceTranscriptReducer.ets'
);

const arkTsSource = readFileSync(reducerPath, 'utf8').replace(/^import\s+.*?;\s*$/gm, '');
const javascriptSource = stripTypeScriptTypes(arkTsSource, { sourceUrl: reducerPath });
const sourceUrl = `data:text/javascript;base64,${Buffer.from(javascriptSource).toString('base64')}`;
const { VoiceTranscriptReducer } = await import(sourceUrl);
const reduce = VoiceTranscriptReducer.append;

test('itemId deltas append and final transcript replaces the accumulated draft', () => {
  const first = reduce([], { role: 'user', text: '合成', final: false, itemId: 'item-user-1' });
  const second = reduce(first, { role: 'user', text: '语音', final: false, itemId: 'item-user-1' });
  const final = reduce(second, { role: 'user', text: '合成语音输入', final: true, itemId: 'item-user-1' });

  assert.deepEqual(final, [{ role: 'user', text: '合成语音输入', final: true, itemId: 'item-user-1' }]);
  assert.equal(first[0].text, '合成');
});

test('itemId keeps interleaved user and assistant transcripts separate', () => {
  const afterUser = reduce([], { role: 'user', text: '用户片段', final: false, itemId: 'u1' });
  const afterAssistant = reduce(afterUser, { role: 'assistant', text: '助手片段', final: false, itemId: 'a1' });
  const afterUserFinal = reduce(afterAssistant, { role: 'user', text: '用户完整文本', final: true, itemId: 'u1' });

  assert.deepEqual(afterUserFinal, [
    { role: 'user', text: '用户完整文本', final: true, itemId: 'u1' },
    { role: 'assistant', text: '助手片段', final: false, itemId: 'a1' }
  ]);
});

test('late delta cannot reopen an item already finalized', () => {
  const finalized = reduce([], { role: 'assistant', text: '完整回复', final: true, itemId: 'a1' });
  const afterLateDelta = reduce(finalized, { role: 'assistant', text: '迟到片段', final: false, itemId: 'a1' });

  assert.deepEqual(afterLateDelta, finalized);
  assert.notEqual(afterLateDelta, finalized);
});

test('legacy events without itemId update only the latest unfinished entry for that role', () => {
  const entries = [
    { role: 'user', text: '上一句', final: true },
    { role: 'assistant', text: '回复中', final: false },
    { role: 'user', text: '当前用户', final: false }
  ];
  const afterDelta = reduce(entries, { role: 'user', text: '补充', final: false });
  const afterFinal = reduce(afterDelta, { role: 'user', text: '当前用户完整文本', final: true });

  assert.equal(afterDelta[2].text, '当前用户补充');
  assert.equal(afterDelta[1].text, '回复中');
  assert.equal(afterFinal[2].text, '当前用户完整文本');
  assert.equal(afterFinal[2].final, true);
});

test('a legacy final event creates a completed entry when no draft exists', () => {
  assert.deepEqual(reduce([], { role: 'assistant', text: '旧服务端回复', final: true }), [
    { role: 'assistant', text: '旧服务端回复', final: true, itemId: undefined }
  ]);
});

test('new phone transcript receives its first timestamp and updates retain it and request identity', () => {
  const before = Date.now();
  const draft = reduce([], { role: 'user', text: 'draft', final: false, itemId: 'voice:one', phoneTranscript: true, requestId: 'request' });
  const after = Date.now();
  assert.ok(draft[0].createdAt >= before && draft[0].createdAt <= after);
  const final = reduce(draft, { role: 'user', text: 'complete', final: true, itemId: 'voice:one', phoneTranscript: true, createdAt: after + 1000 });
  assert.equal(final[0].createdAt, draft[0].createdAt);
  assert.equal(final[0].requestId, 'request');
  assert.equal(draft[0].text, 'draft');
});

test('provided timestamps and metadata survive append and history normalization without dating legacy records', () => {
  const event = { role: 'user', text: 'complete', final: true, itemId: 'voice:one', phoneTranscript: true, createdAt: 100, requestId: 'request', callId: 'call', localStorageStatus: 'saved', localBridgeOrigin: 'https://bridge.example', localAssistantId: 'assistant', localRoomId: 'room' };
  assert.deepEqual(reduce([], event), [event]);
  assert.deepEqual(VoiceTranscriptReducer.normalizeHistory([event]), [event]);
  assert.equal(VoiceTranscriptReducer.normalizeHistory([{ role: 'user', text: 'legacy', final: true }])[0].createdAt, undefined);
});

test('reused itemId cannot merge distinct roles', () => {
  const entries = reduce([], { role: 'user', text: 'user', final: true, itemId: 'same' });
  const result = reduce(entries, { role: 'assistant', text: 'assistant', final: true, itemId: 'same' });
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'user');
});
