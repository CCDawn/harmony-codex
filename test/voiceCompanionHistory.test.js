import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const reducerPath = resolve(
  testDirectory,
  '../HarmonyCodexRemote/entry/src/main/ets/services/VoiceTranscriptReducer.ets'
);
const javascriptSource = stripTypeScriptTypes(readFileSync(reducerPath, 'utf8'), { sourceUrl: reducerPath });
const sourceUrl = `data:text/javascript;base64,${Buffer.from(javascriptSource).toString('base64')}`;
const { VoiceTranscriptReducer } = await import(sourceUrl);

test('mock companion history is normalized and remains mergeable with live transcript events', () => {
  const historyFrame = {
    type: 'history',
    entries: [
      { itemId: 'room:user-1', role: 'user', text: '合成历史用户消息', final: true },
      { itemId: 'room:assistant-1', role: 'assistant', text: '合成历史助手回复', final: true },
      { itemId: 'ignored-tool-1', role: 'tool', text: '不展示工具项', final: true }
    ]
  };
  const normalized = VoiceTranscriptReducer.normalizeHistory(historyFrame.entries);
  const liveBeforeHistory = [
    { itemId: 'voice:assistant-1', role: 'assistant', text: '实时片段', final: false },
    { itemId: 'room:stale-1', role: 'user', text: '已从新历史移除的旧条目', final: true }
  ];
  const merged = VoiceTranscriptReducer.replaceHistory(normalized, liveBeforeHistory);
  const nextHistory = VoiceTranscriptReducer.normalizeHistory([
    { itemId: 'room:user-1', role: 'user', text: '合成历史用户消息', final: true },
    { itemId: 'room:assistant-1', role: 'assistant', text: '合成历史助手回复', final: true },
    { itemId: 'room:user-2', role: 'user', text: '新一轮合成历史消息', final: true }
  ]);
  const refreshed = VoiceTranscriptReducer.replaceHistory(nextHistory, merged);
  const updated = VoiceTranscriptReducer.append(refreshed, {
    itemId: 'voice:assistant-1',
    role: 'assistant',
    text: '熊大实时完整回复',
    final: true
  });

  assert.deepEqual(normalized, [
    { itemId: 'room:user-1', role: 'user', text: '合成历史用户消息', final: true },
    { itemId: 'room:assistant-1', role: 'assistant', text: '合成历史助手回复', final: true }
  ]);
  assert.deepEqual(updated, [
    { itemId: 'room:user-1', role: 'user', text: '合成历史用户消息', final: true },
    { itemId: 'room:assistant-1', role: 'assistant', text: '合成历史助手回复', final: true },
    { itemId: 'room:user-2', role: 'user', text: '新一轮合成历史消息', final: true },
    { itemId: 'voice:assistant-1', role: 'assistant', text: '熊大实时完整回复', final: true }
  ]);
});
