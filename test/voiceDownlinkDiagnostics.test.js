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
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 391 * 4800);
  assert.equal(service.voiceAudioDownlinkQueueHighWaterMs, 1000);
  assert.equal(service.playbackQueueCurrentMs(), 1000);
  service.teardownAudio();
});

test('byte limit drops the oldest cursor samples and keeps the newest oversized PCM tail', () => {
  const { service } = loadService();
  const old = new Uint8Array(48000).fill(1);
  service.queuePlayback(old.buffer);
  service.handleWriteData(new ArrayBuffer(4800));
  service.queuePlayback(new Uint8Array(9600).fill(2).buffer);
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 48000);
  assert.equal(service.playCursorOffset, 9600, 'discard oldest remaining cursor before newer queued PCM');
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 4800);
  service.queuePlayback(new Uint8Array(60001).fill(3).buffer);
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 48000);
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 64801);
  const output = new ArrayBuffer(48000);
  service.handleWriteData(output);
  assert.ok(new Uint8Array(output).every(value => value === 3));
  assert.equal(service.voiceAudioDownlinkWriteConsumeBytes, 52800);
  assert.equal(service.playbackQueueCurrentMs(), 0);
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

const PLAYBACK_IDENTITY = { profileId: 'profile-one', roomId: 'room-one', callId: 'call-one' };

function playbackEvent(service, state, revision, fields = {}) {
  service.handleServerEvent(JSON.stringify({ type: 'playback', state, revision, ...PLAYBACK_IDENTITY, ...fields }));
}

test('playback control requires ready, exact identity and a safe monotonic revision', () => {
  const { service } = loadService();
  service.boundTranscriptIdentity = PLAYBACK_IDENTITY;
  playbackEvent(service, 'blocked', 0);
  assert.equal(service.playbackSuppressed(), false, 'pre-ready control is ignored');
  service.ready = true;
  for (const fields of [
    { profileId: 'other' }, { roomId: 'other' }, { callId: 'other' }, { callId: '' },
    { profileId: undefined }, { source: 'unknown' }
  ]) {
    playbackEvent(service, 'blocked', 0, fields);
    assert.equal(service.playbackSuppressed(), false);
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
    playbackEvent(service, 'blocked', revision);
    assert.equal(service.playbackSuppressed(), false);
  }
  playbackEvent(service, 'unknown', 100);
  playbackEvent(service, 'blocked', 0, { source: 'user_speech' });
  assert.equal(service.playbackSuppressed(), true, 'invalid messages must not advance revision');
  playbackEvent(service, 'resumed', 0);
  assert.equal(service.playbackSuppressed(), true, 'same revision is ignored');
  playbackEvent(service, 'resumed', 2, { source: 'assistant_turn' });
  assert.equal(service.playbackSuppressed(), false);
  playbackEvent(service, 'blocked', 1);
  playbackEvent(service, 'blocked', 2);
  assert.equal(service.playbackSuppressed(), false, 'older and duplicate messages cannot re-block');
  service.teardownAudio();
});

test('server blocked drops old PCM, suppresses speaking and composes with an external token', () => {
  const { service } = loadService();
  const speaking = [];
  service.callbacks.onSpeaking = value => speaking.push(value);
  service.ready = true;
  service.boundTranscriptIdentity = PLAYBACK_IDENTITY;
  service.queuePlayback(new Uint8Array(480).fill(1).buffer);
  playbackEvent(service, 'blocked', 0);
  assert.equal(speaking.at(-1), false);
  service.queuePlayback(new Uint8Array(480).fill(2).buffer);
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 960);
  const output = new Uint8Array(480).fill(9);
  service.handleWriteData(output.buffer);
  assert.ok(output.every(value => value === 0));
  service.handleServerEvent(JSON.stringify({ type: 'speaking', state: 'start' }));
  assert.equal(speaking.at(-1), false);
  const external = service.beginPlaybackSuppression();
  playbackEvent(service, 'blocked', 1);
  playbackEvent(service, 'resumed', 2);
  assert.equal(service.playbackSuppressed(), true, 'server resumed only releases its own token');
  service.endPlaybackSuppression(external);
  assert.equal(service.playbackSuppressed(), false, 'repeated blocked must not leak tokens');
  service.queuePlayback(new Uint8Array(480).fill(3).buffer);
  service.handleWriteData(output.buffer);
  assert.ok(output.every(value => value === 3));
  service.handleServerEvent(JSON.stringify({ type: 'speaking', state: 'start' }));
  assert.equal(speaking.at(-1), true);
  service.teardownAudio();
});

test('new call resets server revision and an old call cannot release its suppression', () => {
  const { service } = loadService();
  service.ready = true;
  service.boundTranscriptIdentity = PLAYBACK_IDENTITY;
  playbackEvent(service, 'blocked', 50);
  const oldToken = service.serverPlaybackSuppressionToken;
  service.teardownAudio();
  service.boundTranscriptIdentity = { ...PLAYBACK_IDENTITY, callId: 'call-two' };
  playbackEvent(service, 'blocked', 0, { callId: 'call-two' });
  assert.equal(service.playbackSuppressed(), true, 'new call revision zero is valid');
  playbackEvent(service, 'resumed', 51);
  service.endPlaybackSuppression(oldToken);
  assert.equal(service.playbackSuppressed(), true, 'old identity and token cannot resume a new call');
  playbackEvent(service, 'resumed', 1, { callId: 'call-two' });
  assert.equal(service.playbackSuppressed(), false);
  service.teardownAudio();
});
