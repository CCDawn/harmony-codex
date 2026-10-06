import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'voice_zombie_harness.py');
// 允许用 VOICE_TEST_PYTHON 指定带 av/aiortc 的解释器；默认用系统 python——
// 垫片会 stub 掉重依赖，只导入纯函数部分。
const PYTHON = process.env.VOICE_TEST_PYTHON || 'python';

// voice_server.py 是 Python 服务端，node --test 无法直接 import；由垫片进程跑
// 全部用例并回传 JSON，这里只做断言。断言值与 voice/voice_server.py 的
// ZOMBIE_WINDOW_BYTES(144000=72000样本×2) / OUT_CHUNK_BYTES(4800) 对齐。
const h = JSON.parse((await execFileP(PYTHON, [HARNESS], {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
})).stdout);

test('voice zombie 判定纯函数：全零/瓦片/真实语音三种输入给出三种判定', () => {
  assert.equal(h.judge_pure.zero, 'zero');
  assert.equal(h.judge_pure.tile, 'tile');
  assert.equal(h.judge_pure.speech, 'clean');
});

test('voice zombie：正常通话静音不挂断，且继续观测后续异常音频', () => {
  assert.deepEqual(h.zero_window.hitOffsets, []);
  assert.equal(h.zero_window.disabled, false);
});

test('voice zombie：长静音后仍可识别有声重复瓦片，近零底噪不挂断', () => {
  assert.deepEqual(h.silence_then_tile.silenceHits, []);
  assert.equal(h.silence_then_tile.tileHits.length, 1);
  assert.deepEqual(h.quiet_tile.hitOffsets, []);
});

test('voice zombie：1024/1088/1152 周期瓦片均在窗口补满时判僵尸', () => {
  for (const period of ['1024', '1088', '1152']) {
    assert.deepEqual(h.tile_window[period].hitOffsets, [144000 - 4800], `period=${period}`);
    assert.equal(h.tile_window[period].disabled, false, `period=${period}`);
  }
});

test('voice zombie：真实包络语音经相邻秒 RMS 提前永久解除，不判僵尸', () => {
  assert.deepEqual(h.speech_escapes_via_envelope.hitOffsets, []);
  assert.equal(h.speech_escapes_via_envelope.disabled, true);
});

test('voice zombie：稳态非周期噪声走窗口判定解除（包络不触发）', () => {
  assert.deepEqual(h.steady_noise_escapes_via_window.hitOffsets, []);
  assert.equal(h.steady_noise_escapes_via_window.disabled, true);
});

test('voice zombie：出现过真语音后，后续纯零下行永久免疫', () => {
  assert.equal(h.real_voice_then_silence_immune.disabledAfterSpeech, true);
  assert.equal(h.real_voice_then_silence_immune.disabled, true);
});

test('voice zombie：窗口未满（1.5s 全零）不做任何判定', () => {
  assert.deepEqual(h.partial_window_no_verdict.hitOffsets, []);
  assert.equal(h.partial_window_no_verdict.disabled, false);
  assert.equal(h.partial_window_no_verdict.bufLen, 72000); // 1.5s=36000样本 只累计不判定
});

test('voice resolve_codex：跳过 <1MB 更新器残骸，两分支 + 兜底报错', () => {
  assert.equal(h.resolve_codex_skips_small.skipsSmallPicksOlderBig, true);
  assert.equal(h.resolve_codex_skips_small.picksNewestWhenBig, true);
  assert.equal(h.resolve_codex_skips_small.fallsBackToStore, true);
  assert.equal(h.resolve_codex_skips_small.raisesWhenAllSmall, true);
});
