import assert from 'node:assert/strict';
import fs from 'node:fs';
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
