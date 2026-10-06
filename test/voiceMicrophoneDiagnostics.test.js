import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(
  __dirname,
  '..',
  'HarmonyCodexRemote',
  'entry',
  'src',
  'main',
  'ets',
  'services',
  'VoiceCallService.ets'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function loadService() {
  const intervalCallbacks = new Map();
  const logs = [];
  let nextIntervalId = 1;
  const source = fs.readFileSync(SOURCE_PATH, 'utf8')
    .replace(/^import\s+.*?;\s*$/gm, '')
    .replace(/export\s+class\s+VoiceCallService/, 'class VoiceCallService');
  const executable = `${stripTypeScriptTypes(source, { mode: 'strip' })}\n` +
    'globalThis.VoiceCallService = VoiceCallService;';
  const audio = {
    AudioSamplingRate: { SAMPLE_RATE_16000: 16000, SAMPLE_RATE_24000: 24000 },
    AudioChannel: { CHANNEL_1: 1 },
    AudioSampleFormat: { SAMPLE_FORMAT_S16LE: 1 },
    AudioEncodingType: { ENCODING_TYPE_RAW: 1 },
    StreamUsage: { STREAM_USAGE_MUSIC: 1 }
  };
  const context = vm.createContext({
    audio,
    webSocket: {},
    setTimeout,
    clearTimeout,
    setInterval(callback, delay) {
      const id = nextIntervalId++;
      intervalCallbacks.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervalCallbacks.delete(id); },
    console: { info(message) { logs.push(message); } },
    Uint8Array,
    ArrayBuffer,
    Promise,
    Error,
    Object,
    JSON,
    Math
  });
  vm.runInContext(executable, context, { filename: SOURCE_PATH });
  const service = context.VoiceCallService;
  service.setCallbacks({
    onStatus() {},
    onTranscript() {},
    onSpeaking() {},
    onClosed() {}
  });
  return { service, logs, intervalCallbacks };
}

test('microphone health counts frames and bytes, detects buffer reuse, and logs numeric fields only', () => {
  const { service, logs, intervalCallbacks } = loadService();
  service.resetVoiceAudioHealth();

  const sharedBuffer = new ArrayBuffer(4);
  const samples = new DataView(sharedBuffer);
  samples.setInt16(0, 1000, true);
  samples.setInt16(2, -1000, true);
  service.handleMicData(sharedBuffer);

  samples.setInt16(0, -2000, true);
  samples.setInt16(2, -2000, true);
  service.handleMicData(sharedBuffer);

  assert.equal(service.voiceAudioReadCallbacks, 2);
  assert.equal(service.voiceAudioInputBytes, 8);
  assert.equal(service.voiceAudioMaxRms, 2000);
  assert.equal(service.voiceAudioBufferMutations, 1);

  const timer = intervalCallbacks.get(service.voiceAudioHealthTimer);
  assert.ok(timer, 'active call should schedule a health report');
  assert.equal(timer.delay, 5000);
  timer.callback();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith('[VoiceAudioHealth] '));
  const report = JSON.parse(logs[0].slice('[VoiceAudioHealth] '.length));
  assert.deepEqual(Object.keys(report), [
    'readCallbacks',
    'inputBytes',
    'maxPcmRms',
    'bufferMutations',
    'sendFalse',
    'sendRejected',
    'sendMaxMs',
    'sendInFlight',
    'sendMaxInFlight',
    'downlinkReceivedBytes',
    'downlinkDroppedBytes',
    'downlinkWriteConsumeBytes',
    'downlinkSilenceBytes',
    'downlinkQueueHighWaterMs',
    'downlinkQueueCurrentMs',
    'wsCallbackGapMaxMs',
    'rendererCallbackGapMaxMs',
    'firstBinaryEpochMs',
    'firstNonzeroPlayEpochMs'
  ]);
  assert.ok(Object.values(report).every((value) => typeof value === 'number'));
  assert.equal(report.readCallbacks, 2);
  assert.equal(report.maxPcmRms, 2000);
  assert.equal(report.bufferMutations, 1);

  service.teardownAudio();
  assert.equal(intervalCallbacks.size, 0, 'teardown should clear the diagnostic timer');
  assert.equal(service.voiceAudioPreviousBuffer, null);
  assert.equal(service.voiceAudioPreviousSnapshot, null);
});

test('five reused 640-byte microphone callbacks retain each chunk in the 3200-byte send', async () => {
  const { service } = loadService();
  service.resetVoiceAudioHealth();
  const reusedBuffer = new ArrayBuffer(640);
  const reusedBytes = new Uint8Array(reusedBuffer);
  const expectedBytes = new Uint8Array(3200);
  const sentPayloads = [];
  service.ws = {
    send(payload) {
      sentPayloads.push(payload);
      return Promise.resolve(true);
    }
  };

  for (let callbackIndex = 0; callbackIndex < 5; callbackIndex += 1) {
    const chunk = Uint8Array.from(
      { length: reusedBytes.length },
      (_, byteIndex) => (callbackIndex * 53 + byteIndex * 7) & 0xff
    );
    reusedBytes.set(chunk);
    expectedBytes.set(chunk, callbackIndex * chunk.length);
    service.handleMicData(reusedBuffer);
  }
  await flushMicrotasks();

  assert.equal(sentPayloads.length, 1, 'five 640-byte callbacks should produce one microphone batch');
  assert.equal(sentPayloads[0].byteLength, 3200);
  assert.deepEqual(
    Array.from(new Uint8Array(sentPayloads[0])),
    Array.from(expectedBytes),
    'each queued frame must preserve the content observed during its callback'
  );
  assert.equal(service.voiceAudioReadCallbacks, 5);
  assert.equal(service.voiceAudioBufferMutations, 4);
  service.teardownAudio();
});

test('binary sends preserve PCM bytes and count false, rejected, and concurrent sends', async () => {
  const { service } = loadService();
  service.resetVoiceAudioHealth();

  const firstBytes = Uint8Array.from({ length: 3200 }, (_, index) => (index * 17) % 256);
  const secondBytes = Uint8Array.from({ length: 3200 }, (_, index) => (255 - index * 13) & 0xff);
  const expectedFirst = firstBytes.slice();
  const expectedSecond = secondBytes.slice();
  const gates = [deferred(), deferred()];
  const sentPayloads = [];
  service.ws = {
    send(payload) {
      sentPayloads.push(payload);
      return gates[sentPayloads.length - 1].promise;
    }
  };

  service.handleMicData(firstBytes.buffer);
  service.handleMicData(secondBytes.buffer);
  await flushMicrotasks(1);

  assert.equal(sentPayloads.length, 2);
  assert.deepEqual(Array.from(new Uint8Array(sentPayloads[0])), Array.from(expectedFirst));
  assert.deepEqual(Array.from(new Uint8Array(sentPayloads[1])), Array.from(expectedSecond));
  assert.equal(service.voiceAudioSendInFlight, 2);
  assert.equal(service.voiceAudioSendMaxInFlight, 2);

  gates[0].resolve(false);
  gates[1].reject(new Error('test send failure'));
  await flushMicrotasks();

  assert.equal(service.voiceAudioSendInFlight, 0);
  assert.equal(service.voiceAudioSendFalse, 1);
  assert.equal(service.voiceAudioSendRejected, 1);
  assert.deepEqual(Array.from(firstBytes), Array.from(expectedFirst), 'diagnostics must not mutate the captured microphone buffer');
  assert.deepEqual(Array.from(secondBytes), Array.from(expectedSecond), 'diagnostics must not mutate the captured microphone buffer');
  service.teardownAudio();
});
