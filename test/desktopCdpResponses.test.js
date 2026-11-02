import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDesktopCdpResponse, desktopCdpResponseChunk, releaseDesktopCdpResponse,
  stageDesktopCdpResponse } from '../src/desktopCdpResponses.js';

const read = window => async expression => new Function('window', `return (${expression});`)(window);

test('small desktop results stay inline and large Unicode results cross bounded frames intact', async () => {
  const window = {};
  const small = { text: 'small' };
  assert.equal(stageDesktopCdpResponse(window, small), small);
  const value = { text: '中😀'.repeat(90000), nested: [{ value: 'tail' }] };
  const staged = stageDesktopCdpResponse(window, value);
  let frames = 0;
  const evaluate = async expression => {
    const chunk = await read(window)(expression);
    if (chunk?.text) { frames++; assert.ok(chunk.text.length <= 65536); }
    return chunk;
  };
  assert.deepEqual(await collectDesktopCdpResponse(staged, evaluate, 1000), value);
  assert.ok(frames > 1);
  assert.equal(window.__codexHarmonyCdpResponses.size, 0);
});

test('parallel response transfers preserve request identity and release both buffers', async () => {
  const window = {};
  const values = [{ text: 'a'.repeat(150000) }, { text: 'b'.repeat(180000) }];
  const staged = values.map(value => stageDesktopCdpResponse(window, value));
  assert.deepEqual(await Promise.all(staged.map(value => collectDesktopCdpResponse(value, read(window), 1000))), values);
  assert.equal(window.__codexHarmonyCdpResponses.size, 0);
});

test('a mismatched chunk fails without returning partial data and still releases its buffer', async () => {
  const window = {};
  const staged = stageDesktopCdpResponse(window, { text: 'x'.repeat(70000) });
  const evaluate = async expression => expression.includes('desktopCdpResponseChunk')
    ? { id: 'wrong-transfer', offset: 0, text: 'incorrect' } : read(window)(expression);
  await assert.rejects(collectDesktopCdpResponse(staged, evaluate, 1000), /Invalid.*chunk/);
  assert.equal(window.__codexHarmonyCdpResponses.size, 0);
});

test('an abandoned response expires without requiring another bridge request', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = {};
  const staged = stageDesktopCdpResponse(window, { text: 'x'.repeat(70000) });
  context.mock.timers.tick(60000);
  assert.equal(window.__codexHarmonyCdpResponses.size, 0);
  assert.throws(() => desktopCdpResponseChunk(window, staged.__codexHarmonyCdpResponse.id, 0), /expired/);
});

test('response transfer deadline is bounded and cleanup does not mask the original failure', async () => {
  const window = {};
  const staged = stageDesktopCdpResponse(window, { text: 'x'.repeat(70000) });
  await assert.rejects(collectDesktopCdpResponse(staged, read(window), 0), /timed out/);
  assert.equal(window.__codexHarmonyCdpResponses.size, 0);
});

test('a full renderer transfer pool rejects admission and keeps existing transfers intact', () => {
  const window = {};
  const staged = [];
  try {
    for (let index = 0; index < 16; index++) staged.push(stageDesktopCdpResponse(window, { text: 'x'.repeat(70000) }));
    assert.throws(() => stageDesktopCdpResponse(window, { text: 'x'.repeat(70000) }), /busy/);
    assert.equal(window.__codexHarmonyCdpResponses.size, 16);
  } finally {
    for (const value of staged) releaseDesktopCdpResponse(window, value.__codexHarmonyCdpResponse.id);
  }
});
