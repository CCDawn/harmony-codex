import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelPath = path.resolve(
  __dirname,
  '..',
  'HarmonyCodexRemote',
  'entry',
  'src',
  'main',
  'ets',
  'components',
  'VoiceCallPanel.ets'
);

function loadEmptyHintTitle() {
  const source = fs.readFileSync(panelPath, 'utf8');
  const match = source.match(/function voiceCallEmptyHintTitle\([^)]*\): string \{([\s\S]*?)\n\}/);
  assert.ok(match, 'VoiceCallPanel must define the pure empty-hint title function');
  assert.match(
    source,
    /private emptyHintTitle\(\): string \{\s*return voiceCallEmptyHintTitle\(this\.status, this\.statusDetail, this\.muted\);\s*\}/,
    'VoiceCallPanel must use the tested title function'
  );

  return new Function('status', 'statusDetail', 'muted', match[1]);
}

test('voice call empty hint reflects connected, muted, connecting and terminal states', () => {
  const title = loadEmptyHintTitle();

  assert.equal(title('active', '', false), '已接通，可以开始说话');
  assert.notEqual(title('active', '', false), '正在等待接通');
  assert.equal(title('active', '', true), '已接通，麦克风已静音');
  assert.equal(title('connecting', '正在连接语音通道', false), '正在等待接通');
  assert.equal(title('ready', 'Codex 正忙，请稍后再试', false), '正在等待接通');
  assert.equal(title('error', '麦克风启动失败', false), '通话未能开始');
  assert.equal(title('idle', '通话已结束', false), '通话已结束');
});
