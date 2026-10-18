import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const bridgeClient = fs.readFileSync(
  new URL('../HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets', import.meta.url),
  'utf8'
);

function methodSource(startMarker, endMarker) {
  const start = bridgeClient.indexOf(startMarker);
  assert.notEqual(start, -1, 'method exists: ' + startMarker);
  const end = bridgeClient.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'method boundary exists: ' + endMarker);
  return bridgeClient.slice(start, end);
}

test('Companion profile read uses the dedicated GET endpoint and normalizes the real avatar field', () => {
  const source = methodSource('static async getCompanionProfile(', 'static async getCompanionMessages(');
  assert.match(source, /http\.RequestMethod\.GET/);
  assert.match(source, /\$\{baseUrl\}\/companion\/profile/);
  assert.match(source, /parsed\.profile/);
  assert.match(source, /profile\.avatarUrl/);
  assert.match(source, /profile\.roomId/);
  assert.doesNotMatch(source, /RequestMethod\.POST/);
});

test('Companion history read scopes by profile and room, supports before cursors, and returns voice transcript entries', () => {
  const source = methodSource('static async getCompanionMessages(', 'static async deleteSession(');
  assert.match(source, /http\.RequestMethod\.GET/);
  assert.match(source, /profileId=\$\{encodeURIComponent\(profileId\.trim\(\)\)\}/);
  assert.match(source, /roomId=\$\{encodeURIComponent\(roomId\.trim\(\)\)\}/);
  assert.match(source, /before=\$\{encodeURIComponent\(beforeCursor\.trim\(\)\)\}/);
  assert.match(source, /final: entry\.final === true/);
  assert.match(source, /nextCursor:/);
  assert.doesNotMatch(source, /RequestMethod\.POST/);
});

test('Companion history preserves call-only records and normalizes an older response without calls to an empty list', async () => {
  const method = methodSource('static async getCompanionMessages(', 'static async deleteSession(');
  const rawResponse = { value: '' };
  const context = vm.createContext({
    http: { RequestMethod: { GET: 'GET' } },
    JSON, Array, String, Number, Promise, encodeURIComponent
  });
  const executable = `class BridgeClient {
    static async request() { return globalThis.rawResponse.value; }
    ${method}
  }
  globalThis.BridgeClient = BridgeClient;`;
  vm.runInContext(stripTypeScriptTypes(executable, { mode: 'strip' }), context);
  context.rawResponse = rawResponse;

  rawResponse.value = JSON.stringify({ entries: [], nextCursor: null, calls: [{
    messageId: 'official-message-1', callId: 'official-call-1', createdAt: '',
    endedAt: null, durationMs: null, outcome: 'completed', transcriptStatus: 'unavailable', summary: null
  }] });
  const callOnly = await context.BridgeClient.getCompanionMessages('https://bridge.example', 'assistant-a', 'room-a');
  assert.equal(callOnly.entries.length, 0);
  assert.equal(callOnly.calls.length, 1);
  assert.equal(callOnly.calls[0].transcriptStatus, 'unavailable');
  assert.equal(callOnly.calls[0].endedAt, null);
  assert.equal(callOnly.calls[0].durationMs, null);
  assert.equal(callOnly.calls[0].createdAt, '');

  rawResponse.value = JSON.stringify({ entries: [], nextCursor: null });
  const legacy = await context.BridgeClient.getCompanionMessages('https://bridge.example', 'assistant-a', 'room-a');
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.calls)), []);
});
