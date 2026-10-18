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

function makeRenderer({ start, stop, flush, events } = {}) {
  const handlers = new Map();
  return {
    handlers,
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
      return flush ? flush(this) : Promise.resolve();
    },
    setDefaultOutputDevice(deviceType) {
      this.defaultOutputDevice = deviceType;
      if (events) events.push('route');
      return Promise.resolve();
    }
  };
}

function loadService({ createAudioRenderer, createAudioCapturer, webSocketApi = {}, statuses = [], speaking = [] }) {
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
    webSocket: webSocketApi,
    CredentialRuntime: { getRuntimeTotpSecret() { return ''; } },
    TotpGenerator: { async currentCode() { return ''; } },
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
    onSpeaking(value) { speaking.push(value); },
    onClosed() {}
  });
  return { service: context.VoiceCallService, statuses };
}

test('actual websocket start frame opts into playback control version one', async () => {
  const handlers = new Map();
  const frames = [];
  const client = {
    on(event, handler) { handlers.set(event, handler); },
    off(event) { handlers.delete(event); },
    connect(_address, _options, callback) {
      callback(undefined);
      handlers.get('open')();
    },
    async send(payload) { frames.push(JSON.parse(payload)); return true; },
    async close() {}
  };
  const { service } = loadService({ webSocketApi: { createWebSocket() { return client; } } });
  try {
    await service.connectOnce('ws://voice-test.invalid/voice', '', service.generation);
    const start = frames.find(frame => frame.type === 'start');
    assert.ok(start, 'the real connection open handler must send a start frame');
    assert.equal(start.playbackControlVersion, 1);
    assert.equal(Number.isInteger(start.playbackControlVersion), true);
  } finally { await service.stop(); }
});

for (const negotiation of [{}, { playbackControlVersion: 1, bargeInAvailable: true }, { playbackControlVersion: 1, bargeInAvailable: false }]) {
  test(`ready remains compatible with negotiation ${JSON.stringify(negotiation)}`, async () => {
    let starts = 0;
    const capturer = { on() {}, off() {}, async start() { starts++; }, async stop() {}, async release() {} };
    const { service } = loadService({ createAudioCapturer: async () => capturer });
    const identity = { profileId: 'profile', roomId: 'room', callId: 'call' };
    service.expectedProfileId = identity.profileId;
    service.expectedRoomId = identity.roomId;
    service.setStatus('connecting', 'test call');
    service.handleServerEvent(JSON.stringify({ type: 'ready', ...identity, ...negotiation }));
    await flushMicrotasks();
    assert.equal(service.phaseValue(), 'active');
    assert.equal(service.capturer, capturer);
    assert.equal(starts, 1);
    assert.equal(service.playbackSuppressed(), false);
    await service.stop();
  });
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

  const failures = statuses.filter((entry) => entry.status === 'error');
  assert.equal(failures.length, 1, 'a failed renderer must not emit one error per audio chunk');
  assert.equal(failures[0].detail, '扬声器启动失败，请重试');
  assert.equal(failures[0].detail.includes('illegal state'), false, 'platform details stay out of the UI');
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

test('interrupt rejects incoming PCM and silences renderer callbacks until serialized flushes finish', async () => {
  const gates = [deferred(), deferred()];
  const speaking = [];
  const renderer = makeRenderer({ flush: current => gates[current.flushCalls - 1].promise });
  const { service } = loadService({ createAudioRenderer: async () => renderer, speaking });
  service.setStatus('active', 'test call');
  await service.ensureRenderer();
  const networkGeneration = service.generation;
  service.queuePlayback(new Uint8Array(480).fill(1).buffer);
  service.interrupt();
  assert.equal(speaking.at(-1), false);
  service.queuePlayback(new Uint8Array(480).fill(2).buffer);
  const output = new Uint8Array(480).fill(9);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 0), 'flush must not refill the old renderer with upstream PCM');
  assert.equal(service.voiceAudioDownlinkWriteConsumeBytes, 0);
  service.interrupt();
  await flushMicrotasks();
  assert.equal(renderer.flushCalls, 1, 'flush calls must not overlap');
  gates[0].resolve();
  await flushMicrotasks();
  assert.equal(renderer.flushCalls, 2);
  service.queuePlayback(new Uint8Array(480).fill(3).buffer);
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0);
  gates[1].resolve();
  await flushMicrotasks();
  service.queuePlayback(new Uint8Array(480).fill(4).buffer);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 4));
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 1440);
  assert.equal(service.generation, networkGeneration);
  await service.stop();
});

for (const pendingStage of ['create', 'start']) {
  test(`interrupt during pending renderer ${pendingStage} flushes before playback resumes`, async () => {
    const stageGate = deferred();
    const flushGate = deferred();
    const renderer = makeRenderer({
      start: () => pendingStage === 'start' ? stageGate.promise : Promise.resolve(),
      flush: () => flushGate.promise
    });
    const { service } = loadService({
      createAudioRenderer: () => pendingStage === 'create' ? stageGate.promise : Promise.resolve(renderer)
    });
    service.setStatus('active', 'test call');
    service.queuePlayback(new Uint8Array(480).fill(1).buffer);
    await flushMicrotasks();
    service.interrupt();
    stageGate.resolve(pendingStage === 'create' ? renderer : undefined);
    await flushMicrotasks();
    assert.equal(renderer.flushCalls, 1, 'unpublished startup renderer must still be flushed');
    service.queuePlayback(new Uint8Array(480).fill(2).buffer);
    const output = new Uint8Array(480).fill(9);
    renderer.handlers.get('writeData')(output.buffer);
    assert.ok(output.every(value => value === 0));
    flushGate.resolve();
    await flushMicrotasks();
    service.queuePlayback(new Uint8Array(480).fill(3).buffer);
    renderer.handlers.get('writeData')(output.buffer);
    assert.ok(output.every(value => value === 3));
    await service.stop();
  });
}

test('flush failure isolates and rebuilds only the output while preserving microphone and websocket', async () => {
  const releaseGate = deferred();
  const statuses = [];
  const oldRenderer = makeRenderer({ flush: () => Promise.reject(new Error('platform flush failed')), stop: () => releaseGate.promise });
  const newRenderer = makeRenderer();
  let createCalls = 0;
  const { service } = loadService({ statuses, createAudioRenderer: async () => ++createCalls === 1 ? oldRenderer : newRenderer });
  service.setStatus('active', 'test call');
  await service.ensureRenderer();
  const lateWrite = oldRenderer.handlers.get('writeData');
  const capturer = { stopCalls: 0, releaseCalls: 0, off() {}, async stop() { this.stopCalls++; }, async release() { this.releaseCalls++; } };
  const ws = { async send() {}, async close() { throw new Error('must not close during output recovery'); }, off() {} };
  service.capturer = capturer;
  service.ws = ws;
  const generation = service.generation;
  service.interrupt();
  await flushMicrotasks();
  assert.equal(service.renderer, null, 'remove failed renderer before waiting for its release');
  const output = new Uint8Array(480).fill(9);
  lateWrite(output.buffer);
  assert.ok(output.every(value => value === 0));
  releaseGate.resolve();
  await flushMicrotasks();
  assert.equal(service.renderer, newRenderer);
  assert.equal(oldRenderer.releaseCalls, 1);
  assert.equal(service.capturer, capturer);
  assert.equal(service.ws, ws);
  assert.equal(service.generation, generation);
  assert.equal(capturer.stopCalls, 0);
  assert.equal(service.phaseValue(), 'active');
  assert.ok(statuses.some(entry => entry.detail.includes('恢复')));
  service.queuePlayback(new Uint8Array(480).fill(7).buffer);
  lateWrite(output.buffer);
  assert.ok(output.every(value => value === 0), 'late callback cannot consume new output PCM');
  newRenderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 7));
  service.ws = null;
  await service.stop();
});

test('explicit suppression tokens compose with interrupt flush and cannot be ended by a stale token', async () => {
  const gate = deferred();
  const renderer = makeRenderer({ flush: () => gate.promise });
  const { service } = loadService({ createAudioRenderer: async () => renderer });
  service.setStatus('active', 'test call');
  await service.ensureRenderer();
  const first = service.beginPlaybackSuppression();
  const second = service.beginPlaybackSuppression();
  service.endPlaybackSuppression(first);
  service.queuePlayback(new ArrayBuffer(480));
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0);
  service.interrupt();
  service.endPlaybackSuppression(second);
  service.queuePlayback(new ArrayBuffer(480));
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0, 'ending protocol suppression cannot end flush suppression');
  gate.resolve();
  await flushMicrotasks();
  const next = service.beginPlaybackSuppression();
  service.endPlaybackSuppression(first);
  service.queuePlayback(new ArrayBuffer(480));
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0);
  service.endPlaybackSuppression(next);
  service.queuePlayback(new ArrayBuffer(480));
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 480);
  await service.stop();
});

test('old flush completion cannot lift a new call suppression barrier', async () => {
  const oldGate = deferred();
  const newGate = deferred();
  const oldRenderer = makeRenderer({ flush: () => oldGate.promise });
  const newRenderer = makeRenderer({ flush: () => newGate.promise });
  let creates = 0;
  const { service } = loadService({ createAudioRenderer: async () => ++creates === 1 ? oldRenderer : newRenderer });
  service.setStatus('active', 'old call');
  await service.ensureRenderer();
  service.interrupt();
  await service.stop();
  service.generation += 1;
  service.stopping = false;
  service.rendererFailedGeneration = -1;
  service.setStatus('active', 'new call');
  await service.ensureRenderer();
  service.interrupt();
  oldGate.resolve();
  await flushMicrotasks();
  service.queuePlayback(new Uint8Array(480).fill(1).buffer);
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0);
  assert.equal(service.renderer, newRenderer);
  newGate.resolve();
  await flushMicrotasks();
  service.queuePlayback(new Uint8Array(480).fill(2).buffer);
  const output = new ArrayBuffer(480);
  newRenderer.handlers.get('writeData')(output);
  assert.ok(new Uint8Array(output).every(value => value === 2));
  await service.stop();
});

test('synchronous flush error and failed output rebuild keep the call connected and report recovery failure', async () => {
  const renderer = makeRenderer({ flush: () => { throw new Error('sync platform failure'); } });
  const statuses = [];
  let creates = 0;
  const { service } = loadService({ statuses, createAudioRenderer: async () => {
    if (++creates === 1) return renderer;
    throw new Error('output unavailable');
  } });
  service.setStatus('active', 'call');
  await service.ensureRenderer();
  const capturer = { off() {}, async stop() {}, async release() {} };
  const ws = { async send() {}, async close() { throw new Error('must keep connection'); }, off() {} };
  service.capturer = capturer;
  service.ws = ws;
  const generation = service.generation;
  service.interrupt();
  await flushMicrotasks();
  assert.equal(service.phaseValue(), 'active');
  assert.equal(service.generation, generation);
  assert.equal(service.capturer, capturer);
  assert.equal(service.ws, ws);
  assert.equal(service.renderer, null);
  assert.ok(statuses.some(entry => entry.detail === '扬声器恢复失败，请重新接通'));
  assert.ok(statuses.every(entry => !entry.detail.includes('platform')));
  service.queuePlayback(new ArrayBuffer(480));
  await flushMicrotasks();
  assert.equal(creates, 2, 'do not retry failed output creation for every PCM chunk');
  service.ws = null;
  await service.stop();
});

test('server resumed cannot bypass a pending local interrupt flush', async () => {
  const gate = deferred();
  const renderer = makeRenderer({ flush: () => gate.promise });
  const speaking = [];
  const { service } = loadService({ createAudioRenderer: async () => renderer, speaking });
  service.setStatus('active', 'call');
  service.ready = true;
  const identity = { profileId: 'profile', roomId: 'room', callId: 'call' };
  service.boundTranscriptIdentity = identity;
  await service.ensureRenderer();
  const event = (state, revision) => service.handleServerEvent(JSON.stringify({ type: 'playback', state, revision, ...identity }));
  event('blocked', 0);
  service.interrupt();
  event('resumed', 1);
  service.queuePlayback(new Uint8Array(480).fill(1).buffer);
  service.handleServerEvent(JSON.stringify({ type: 'speaking', state: 'start' }));
  assert.equal(speaking.at(-1), false);
  const output = new Uint8Array(480).fill(9);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 0));
  gate.resolve();
  await flushMicrotasks();
  service.queuePlayback(new Uint8Array(480).fill(2).buffer);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 2));
  await service.stop();
});

test('automatic server blocked flushes platform PCM without echo and resumed waits for all flushes', async () => {
  const gates = [deferred(), deferred()];
  const renderer = makeRenderer({ flush: current => gates[current.flushCalls - 1].promise });
  const { service } = loadService({ createAudioRenderer: async () => renderer });
  service.setStatus('active', 'call');
  service.ready = true;
  const identity = { profileId: 'profile', roomId: 'room', callId: 'call' };
  service.boundTranscriptIdentity = identity;
  let sentFrames = 0;
  service.ws = { async send() { sentFrames++; } };
  await service.ensureRenderer();
  const event = (state, revision) => service.handleServerEvent(JSON.stringify({ type: 'playback', state, revision, source: 'user_speech', ...identity }));
  service.queuePlayback(new Uint8Array(480).fill(1).buffer);
  event('blocked', 0);
  assert.equal(renderer.flushCalls, 1, 'automatic speech detection clears platform PCM without a manual interrupt');
  event('blocked', 0);
  assert.equal(renderer.flushCalls, 1, 'duplicate revision must not trigger another flush');
  event('resumed', 1);
  event('blocked', 2);
  event('resumed', 3);
  service.queuePlayback(new Uint8Array(480).fill(2).buffer);
  const output = new Uint8Array(480).fill(9);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 0));
  assert.equal(renderer.flushCalls, 1, 'consecutive automatic blocks serialize platform operations');
  gates[0].resolve();
  await flushMicrotasks();
  assert.equal(renderer.flushCalls, 2);
  service.queuePlayback(new Uint8Array(480).fill(3).buffer);
  assert.equal(service.voiceAudioDownlinkQueuedBytes, 0);
  gates[1].resolve();
  await flushMicrotasks();
  assert.equal(sentFrames, 0, 'server control cannot send an interrupt echo');
  service.queuePlayback(new Uint8Array(480).fill(4).buffer);
  renderer.handlers.get('writeData')(output.buffer);
  assert.ok(output.every(value => value === 4));
  assert.equal(service.voiceAudioDownlinkDroppedBytes, 1440);
  service.ws = null;
  await service.stop();
});
