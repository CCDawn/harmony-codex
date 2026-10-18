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
const callHistoryPath = resolve(
  testDirectory,
  '../HarmonyCodexRemote/entry/src/main/ets/services/CompanionHistoryReducer.ets'
);
const callHistorySource = stripTypeScriptTypes(readFileSync(callHistoryPath, 'utf8'), { sourceUrl: callHistoryPath });
const callHistoryUrl = `data:text/javascript;base64,${Buffer.from(callHistorySource).toString('base64')}`;
const { CompanionHistoryReducer } = await import(callHistoryUrl);

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

test('final phone transcripts survive an official-history refresh that contains no matching transcript', () => {
  const official = VoiceTranscriptReducer.normalizeHistory([
    { itemId: 'room:message-1', role: 'user', text: '既有 Codex 消息', final: true }
  ]);
  const phoneFinal = {
    itemId: 'voice:call-7:item-2', role: 'assistant', text: '手机收到的最终语音回复', final: true,
    phoneTranscript: true, callId: 'call-7'
  };
  const withLocal = VoiceTranscriptReducer.append(official, phoneFinal);
  const refreshed = VoiceTranscriptReducer.replaceHistory(official, withLocal);
  const pageWithoutVoiceTranscript = VoiceTranscriptReducer.normalizeHistory([
    { itemId: 'room:message-1', role: 'user', text: '既有 Codex 消息', final: true }
  ]);
  const refreshedAgain = VoiceTranscriptReducer.replaceHistory(pageWithoutVoiceTranscript, refreshed);

  assert.deepEqual(refreshedAgain, [
    { itemId: 'room:message-1', role: 'user', text: '既有 Codex 消息', final: true },
    phoneFinal
  ]);
  assert.equal(refreshedAgain[1].phoneTranscript, true);
  assert.equal(refreshedAgain[1].callId, 'call-7');
});

test('transcript reducer preserves local provenance while partial text becomes final', () => {
  const partial = VoiceTranscriptReducer.append([], {
    itemId: 'voice:call-8:item-3', role: 'user', text: '七加', final: false,
    phoneTranscript: true, callId: 'call-8'
  });
  const final = VoiceTranscriptReducer.append(partial, {
    itemId: 'voice:call-8:item-3', role: 'user', text: '七加五等于几', final: true,
    phoneTranscript: true, callId: 'call-8'
  });

  assert.deepEqual(final, [{
    itemId: 'voice:call-8:item-3', role: 'user', text: '七加五等于几', final: true,
    phoneTranscript: true, callId: 'call-8'
  }]);
});

test('call-only records remain separate from messages and unknown transcript state is never called available', () => {
  const calls = CompanionHistoryReducer.mergeCalls([], [
    { messageId: 'message-1', callId: 'call-1', createdAt: '', endedAt: null, durationMs: null,
      outcome: 'completed', transcriptStatus: 'unavailable', summary: null },
    { messageId: 'message-1', callId: 'call-2', createdAt: '2026-10-08T11:00:00Z', endedAt: null,
      durationMs: 5000, outcome: 'completed', transcriptStatus: 'future_state', summary: null }
  ]);
  const updatedFirstCall = { ...calls[0], endedAt: '2026-10-08T11:10:00Z', durationMs: 42000 };
  const merged = CompanionHistoryReducer.mergeCalls(calls, [updatedFirstCall]);

  assert.equal(merged.length, 2);
  assert.equal(merged.find(call => call.callId === 'call-1').durationMs, 42000);
  assert.equal(CompanionHistoryReducer.transcriptStatusLabel('unavailable'), '官方转写不可用');
  assert.equal(CompanionHistoryReducer.transcriptStatusLabel('future_state'), '官方转写状态：future_state');
  assert.notEqual(CompanionHistoryReducer.transcriptStatusLabel('future_state'), '官方转写可用');
});
