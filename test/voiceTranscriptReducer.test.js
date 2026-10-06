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
