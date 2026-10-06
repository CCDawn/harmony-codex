import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOURCE = path.resolve(
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

async function flushMicrotasks(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeRenderer({ start, stop, events } = {}) {
  const handlers = new Map();
  return {
    startCalls: 0,
    stopCalls: 0,
    releaseCalls: 0,
    flushCalls: 0,
    on(event, handler) { handlers.set(event, handler); },
    off(event) { handlers.delete(event); },
    start() {
      this.startCalls += 1;
      if (events) events.push('start');
      return start ? start(this) : Promise.resolve();
    },
    stop() {
      this.stopCalls += 1;
      if (events) events.push('stop');
      return stop ? stop(this) : Promise.resolve();
    },
    release() {
      this.releaseCalls += 1;
      if (events) events.push('release');
      return Promise.resolve();
    },
    flush() {
      this.flushCalls += 1;
      return Promise.resolve();
    },
    setDefaultOutputDevice(deviceType) {
      this.defaultOutputDevice = deviceType;
      if (events) events.push('route');
      return Promise.resolve();
    }
  };
}

function loadService({ createAudioRenderer, createAudioCapturer, statuses = [] }) {
  const sourcePath = process.env.VOICE_SERVICE_SOURCE || DEFAULT_SOURCE;
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^import\s+.*?;\s*$/gm, '')
    .replace(/export\s+class\s+VoiceCallService/, 'class VoiceCallService');
  const executable = `${stripTypeScriptTypes(source, { mode: 'strip' })}\n` +
    'globalThis.VoiceCallService = VoiceCallService;';
  const audio = {
    AudioSamplingRate: { SAMPLE_RATE_16000: 16000, SAMPLE_RATE_24000: 24000 },
    AudioChannel: { CHANNEL_1: 1 },
    AudioSampleFormat: { SAMPLE_FORMAT_S16LE: 1 },
    AudioEncodingType: { ENCODING_TYPE_RAW: 1 },
    StreamUsage: { STREAM_USAGE_MUSIC: 1, STREAM_USAGE_VOICE_COMMUNICATION: 2 },
    SourceType: { SOURCE_TYPE_MIC: 0, SOURCE_TYPE_VOICE_COMMUNICATION: 7 },
    DeviceType: { SPEAKER: 2 },
    createAudioRenderer,
    createAudioCapturer
  };
  const context = vm.createContext({
    audio,
    webSocket: {},
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
    Promise,
    Error,
    Object,
    JSON,
    Math
  });
  vm.runInContext(executable, context, { filename: sourcePath });
  context.VoiceCallService.setCallbacks({
    onStatus(status, detail) { statuses.push({ status, detail }); },
    onTranscript() {},
    onSpeaking() {},
    onClosed() {}
  });
  return { service: context.VoiceCallService, statuses };
}

test('duplex call selects communication capture and playback with accessory-aware speaker default', async () => {
  let captureOptions;
  let playbackOptions;
  const events = [];
  const renderer = makeRenderer({ events });
  const capturer = { on() {}, start: async () => {}, stop: async () => {}, release: async () => {} };
  const { service } = loadService({
    createAudioCapturer: async options => { captureOptions = options; return capturer; },
    createAudioRenderer: async options => { playbackOptions = options; return renderer; }
  });
  try {
    await service.startCapturer();
    await service.ensureRenderer();
    assert.equal(captureOptions.capturerInfo.source, 7, 'ordinary MIC misses the communication capture path');
    assert.equal(playbackOptions.rendererInfo.usage, 2, 'music output must not be used for a duplex call');
    assert.equal(renderer.defaultOutputDevice, 2, 'preserve hands-free output through the renderer-local API');
    assert.deepEqual(events, ['route', 'start']);
  } finally { await service.stop(); }
});

test('concurrent downlink chunks create and start one renderer', async () => {
  let createCalls = 0;
  let startCalls = 0;
  const startGate = deferred();
  const renderers = [];
  const { service } = loadService({
    createAudioRenderer: async () => {
      createCalls += 1;
      const renderer = makeRenderer({
        start: () => {
          startCalls += 1;
          return startGate.promise;
        }
      });
      renderers.push(renderer);
      return renderer;
    }
  });

  for (let index = 0; index < 6; index += 1) {
    service.queuePlayback(new ArrayBuffer(320));
  }
  await flushMicrotasks();

  try {
    assert.equal(createCalls, 1, 'all chunks in one startup window must share createAudioRenderer');
    assert.equal(startCalls, 1, 'all chunks in one startup window must share renderer.start');
  } finally {
    startGate.resolve();
    await flushMicrotasks();
    await service.stop();
  }
});

test('renderer startup failure is reported once for the current call', async () => {
  let createCalls = 0;
  let startCalls = 0;
  const statuses = [];
  const { service } = loadService({
    statuses,
    createAudioRenderer: async () => {
      createCalls += 1;
      return makeRenderer({
        start: () => {
          startCalls += 1;
          return Promise.reject(new Error('illegal state'));
        }
      });
    }
  });

  for (let index = 0; index < 8; index += 1) {
    service.queuePlayback(new ArrayBuffer(160));
  }
  await flushMicrotasks();
  service.queuePlayback(new ArrayBuffer(160));
  await flushMicrotasks();

  const failures = statuses.filter((entry) => entry.status === 'error' && entry.detail.includes('illegal state'));
  assert.equal(failures.length, 1, 'a failed renderer must not emit one error per audio chunk');
  await service.stop();
});

test('an old pending create is released and cannot replace a new call renderer', async () => {
  const creates = [];
  const { service } = loadService({
    createAudioRenderer: () => {
      const pending = deferred();
      creates.push(pending);
      return pending.promise;
    }
  });

  service.queuePlayback(new ArrayBuffer(160));
  await flushMicrotasks(1);
  assert.equal(creates.length, 1, 'first call should have one pending renderer creation');

  service.setStatus('active', 'test call');
  await service.stop();
  // Model connect() opening the next call without requiring WebSocket mocks.
  service.generation += 1;
  service.stopping = false;
  service.rendererFailedGeneration = -1;
  service.setStatus('active', 'next test call');
  service.queuePlayback(new ArrayBuffer(160));
  await flushMicrotasks(1);
  assert.equal(creates.length, 2, 'new call should create its own renderer while old create is pending');

  const oldRenderer = makeRenderer();
  const newRenderer = makeRenderer();
  creates[1].resolve(newRenderer);
  await flushMicrotasks();
  creates[0].resolve(oldRenderer);
  await flushMicrotasks();

  assert.equal(service.renderer, newRenderer, 'late completion from the old generation must not overwrite the new renderer');
  assert.equal(oldRenderer.startCalls, 0, 'stale renderer must never start');
  assert.equal(oldRenderer.releaseCalls, 1, 'stale renderer must release its own instance');
  await service.stop();
});

test('teardown waits for stop before release and releases a renderer that never started', async () => {
  const events = [];
  const stopGate = deferred();
  const renderer = makeRenderer({
    events,
    stop: () => stopGate.promise
  });
  const { service } = loadService({ createAudioRenderer: async () => renderer });
  service.renderer = renderer;
  service.setStatus('active', 'test call');

  const stopping = service.stop();
  await flushMicrotasks(1);
  try {
    assert.equal(renderer.startCalls, 0, 'fixture represents a renderer that never started');
    assert.equal(renderer.stopCalls, 1, 'teardown should stop the renderer');
    assert.equal(renderer.releaseCalls, 0, 'release must wait until stop settles');
  } finally {
    stopGate.resolve();
  }
  await stopping;

  assert.equal(renderer.releaseCalls, 1, 'teardown must release even a renderer that never started');
  assert.deepEqual(events, ['stop', 'release']);
});
