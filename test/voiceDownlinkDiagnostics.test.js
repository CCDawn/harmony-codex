import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'HarmonyCodexRemote', 'entry', 'src', 'main', 'ets', 'services', 'VoiceCallService.ets');

function loadService() {
  const intervalCallbacks = new Map();
  const logs = [];
  let nextIntervalId = 1;
  let now = 1_800_000_000_000;
  class ClockDate extends Date {
    static now() { return now; }
  }

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
    Date: ClockDate,
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
    onHistory() {},
    onAssistantName() {},
    onSpeaking() {},
    onClosed() {}
  });
  service.ensureRenderer = () => Promise.resolve();
  return {
    service,
    logs,
    intervalCallbacks,
    setNow(value) { now = value; }
  };
}

test('downlink health separates received PCM, renderer consumption, silence, queue time, and callback gaps', () => {
  const { service, logs, intervalCallbacks, setNow } = loadService();
  service.resetVoiceAudioHealth();

  setNow(1_800_000_000_010);
  service.recordVoiceBinaryWebSocketCallback();
  setNow(1_800_000_000_060);
  service.recordVoiceBinaryWebSocketCallback();

  const first = new Uint8Array(480);
  first.fill(1);
  setNow(1_800_000_000_100);
  service.queuePlayback(first.buffer);
  setNow(1_800_000_000_110);
  service.queuePlayback(new ArrayBuffer(960));
  assert.equal(service.playbackQueueCurrentMs(), 30);

  setNow(1_800_000_000_200);
  service.handleWriteData(new ArrayBuffer(1920));
  setNow(1_800_000_000_225);
  service.handleWriteData(new ArrayBuffer(480));

  assert.equal(service.voiceAudioDownlinkReceivedBytes, 1440);
  assert.equal(service.voiceAudioDownlinkWriteConsumeBytes, 1440);
  assert.equal(service.voiceAudioDownlinkSilenceBytes, 960);
  assert.equal(service.voiceAudioDownlinkQueueHighWaterMs, 30);
  assert.equal(service.playbackQueueCurrentMs(), 0);
  assert.equal(service.voiceAudioWsCallbackGapMaxMs, 50);
  assert.equal(service.voiceAudioRendererCallbackGapMaxMs, 25);
  assert.equal(service.voiceAudioFirstBinaryEpochMs, 1_800_000_000_100);
  assert.equal(service.voiceAudioFirstNonzeroPlayEpochMs, 1_800_000_000_200);

  const timer = intervalCallbacks.get(service.voiceAudioHealthTimer);
  assert.equal(timer.delay, 5000);
  timer.callback();
  assert.equal(logs.length, 1);
  const prefix = '[VoiceAudioHealth] ';
  assert.ok(logs[0].startsWith(prefix));
  const report = JSON.parse(logs[0].slice(prefix.length));
  assert.equal(report.downlinkReceivedBytes, 1440);
  assert.equal(report.downlinkWriteConsumeBytes, 1440);
  assert.equal(report.downlinkSilenceBytes, 960);
  assert.equal(report.downlinkQueueHighWaterMs, 30);
  assert.equal(report.downlinkQueueCurrentMs, 0);
  assert.equal(report.wsCallbackGapMaxMs, 50);
  assert.equal(report.rendererCallbackGapMaxMs, 25);
  assert.equal(report.firstBinaryEpochMs, 1_800_000_000_100);
  assert.equal(report.firstNonzeroPlayEpochMs, 1_800_000_000_200);
  assert.ok(Object.values(report).every((value) => typeof value === 'number'));

  service.teardownAudio();
  assert.equal(intervalCallbacks.size, 0);
});

test('silent PCM is counted without being treated as a playback failure', () => {
  const { service, setNow } = loadService();
  const statusUpdates = [];
  service.setCallbacks({
    onStatus(status, detail) { statusUpdates.push({ status, detail }); },
    onTranscript() {},
    onHistory() {},
    onAssistantName() {},
    onSpeaking() {},
    onClosed() {}
  });
  service.resetVoiceAudioHealth();

  setNow(1_800_000_000_300);
  service.queuePlayback(new ArrayBuffer(480));
  service.handleWriteData(new ArrayBuffer(480));
  assert.equal(service.voiceAudioDownlinkWriteConsumeBytes, 480);
  assert.equal(service.voiceAudioDownlinkSilenceBytes, 0);
  assert.equal(service.voiceAudioFirstNonzeroPlayEpochMs, 0);
  assert.deepEqual(statusUpdates, []);

  const audiblePcm = new Uint8Array(480);
  audiblePcm[1] = 1;
  setNow(1_800_000_000_325);
  service.queuePlayback(audiblePcm.buffer);
  service.handleWriteData(new ArrayBuffer(480));
  assert.equal(service.voiceAudioFirstNonzeroPlayEpochMs, 1_800_000_000_325);
  assert.deepEqual(statusUpdates, []);
  service.teardownAudio();
});

test('queue overflow counts discarded PCM while retaining the configured queue limit', () => {
  const { service } = loadService();
  service.resetVoiceAudioHealth();

  for (let index = 0; index < 401; index += 1) {
    service.queuePlayback(new ArrayBuffer(4800));
  }

  assert.equal(service.voiceAudioDownlinkReceivedBytes, 401 * 4800);
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 4800);
  assert.equal(service.voiceAudioDownlinkQueueHighWaterMs, 40_000);
  assert.equal(service.playbackQueueCurrentMs(), 40_000);
  service.teardownAudio();
});

test('transcript health contains only role, character count, final flag, and epoch', () => {
  const { service, logs, setNow } = loadService();
  setNow(1_800_000_123_456);
  service.handleServerEvent(JSON.stringify({
    type: 'transcript',
    role: 'user',
    text: 'private spoken content',
    final: true
  }));

  assert.equal(logs.length, 1);
  const prefix = '[VoiceTranscriptHealth] ';
  assert.ok(logs[0].startsWith(prefix));
  const record = JSON.parse(logs[0].slice(prefix.length));
  assert.deepEqual(Object.keys(record), ['role', 'chars', 'final', 'epochMs']);
  assert.deepEqual(record, {
    role: 'user',
    chars: 22,
    final: true,
    epochMs: 1_800_000_123_456
  });
  assert.equal(logs[0].includes('private spoken content'), false);
});
