import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const serviceUrl = new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceCallService.ets', import.meta.url);
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function load(createAudioCapturer, platform = {}) {
  const statuses = [], progress = [], transcripts = [];
  const source = fs.readFileSync(serviceUrl, 'utf8').replace(/^import\s+.*?;\s*$/gm, '').replace('export class VoiceCallService', 'class VoiceCallService');
  const audio = {
    AudioSamplingRate: { SAMPLE_RATE_16000: 16000 }, AudioChannel: { CHANNEL_1: 1 },
    AudioSampleFormat: { SAMPLE_FORMAT_S16LE: 1 }, AudioEncodingType: { ENCODING_TYPE_RAW: 1 },
    SourceType: { SOURCE_TYPE_VOICE_COMMUNICATION: 7 }, createAudioCapturer,
    InterruptHint: { INTERRUPT_HINT_STOP: 3, INTERRUPT_HINT_PAUSE: 2 }
  };
  const context = vm.createContext({ audio, setTimeout, clearTimeout, clearInterval, Date, console,
    VoiceBackgroundTaskService: { stop: async () => {} },
    VoiceTranscriptReducer: { normalizeHistory: x => x }, ...platform });
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.service = VoiceCallService;', context);
  const service = context.service;
  service.setCallbacks({ onStatus: (status, detail) => statuses.push({ status, detail }),
    onProgress: (stage, since, failure) => progress.push({ stage, since, failure }),
    onAssistantName() {}, onTranscript: (entry, identity) => transcripts.push({ entry, identity }),
    onHistory() {}, onSpeaking() {}, onClosed() {} });
  return { service, statuses, progress, transcripts };
}
function capturer(start = async () => {}) {
  return { starts: 0, releases: 0, stops: 0, on() {}, off() {},
    async start() { this.starts++; await start(); },
    async stop() { this.stops++; }, async release() { this.releases++; } };
}

test('system audio interruption ends current call, but ducking and stale callbacks do not', async () => {
  const { service, statuses } = load(async () => capturer());
  service.handleServerEvent('{"type":"ready"}'); await flush();
  const generation = service.generation;
  service.muted = true;
  service.handleAudioInterrupt({ hintType: 4 }, generation);
  assert.equal(service.phaseValue(), 'active');
  service.handleAudioInterrupt({ hintType: 3 }, generation - 1);
  assert.equal(service.phaseValue(), 'active');
  service.handleAudioInterrupt({ hintType: 2 }, generation);
  assert.equal(service.phaseValue(), 'error');
  assert.match(statuses.at(-1).detail, /系统音频打断/);
  assert.equal(service.muted, true);
  assert.equal(service.capturer, null);
  await service.stop();
});
test('ready waits for microphone startup and duplicate ready cannot create another capturer', async () => {
  const gate = deferred(), mic = capturer(() => gate.promise);
  let created = 0;
  const { service, statuses, progress } = load(async () => { created++; return mic; });
  service.handleServerEvent(JSON.stringify({ type: 'progress', stage: 'assistant' }));
  service.handleServerEvent(JSON.stringify({ type: 'progress', stage: 'media' }));
  service.handleServerEvent(JSON.stringify({ type: 'ready' }));
  service.handleServerEvent(JSON.stringify({ type: 'ready' }));
  await flush();
  assert.equal(service.phaseValue(), 'ready');
  assert.equal(created, 1);
  assert.equal(statuses.some(x => x.status === 'active'), false);
  gate.resolve(); await flush();
  assert.equal(service.phaseValue(), 'active');
  assert.deepEqual(progress.map(x => x.stage), ['assistant', 'media', 'mic', 'listening']);
  assert.equal(mic.starts, 1);
  await service.stop();
});
test('unknown, duplicate, regressive and late progress cannot reset the current stage clock', async () => {
  const { service, progress } = load(async () => capturer());
  for (const stage of ['media', 'bogus', 'assistant', 'media']) {
    service.handleServerEvent(JSON.stringify({ type: 'progress', stage }));
  }
  assert.deepEqual(progress.map(x => x.stage), ['media', 'media']);
  assert.equal(progress[0].since, progress[1].since);
  service.handleServerEvent('{"type":"ready"}'); await flush();
  service.handleServerEvent('{"type":"progress","stage":"assistant"}');
  assert.equal(service.phaseValue(), 'active');
  assert.equal(progress.at(-1).stage, 'listening');
  await service.stop();
});

test('transcripts received before ready are released only after the same assistant room and call identity is confirmed', async () => {
  const { service, transcripts } = load(async () => capturer());
  service.expectedProfileId = 'assistant-a';
  service.expectedRoomId = 'room-a';
  service.handleServerEvent(JSON.stringify({ type: 'transcript', itemId: 'item-1', role: 'user', text: '你好', final: true,
    profileId: 'assistant-a', roomId: 'room-a', callId: 'call-1' }));
  assert.equal(service.pendingIdentityTranscripts.length, 1);
  assert.equal(transcripts.length, 0);

  service.handleServerEvent(JSON.stringify({ type: 'ready', profileId: 'assistant-a', roomId: 'room-a', callId: 'call-1' }));
  await flush();
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].entry.text, '你好');
  assert.equal(transcripts[0].identity.profileId, 'assistant-a');
  assert.equal(transcripts[0].identity.roomId, 'room-a');
  assert.equal(transcripts[0].identity.callId, 'call-1');
  await service.stop();
});

test('mismatched profile, room or call identity is discarded with a visible status detail', async () => {
  const { service, statuses, transcripts } = load(async () => capturer());
  service.expectedProfileId = 'assistant-a';
  service.expectedRoomId = 'room-a';
  service.handleServerEvent(JSON.stringify({ type: 'ready', profileId: 'assistant-a', roomId: 'room-a', callId: 'call-1' }));
  await flush();
  service.handleServerEvent(JSON.stringify({ type: 'transcript', itemId: 'item-2', role: 'assistant', text: '不应串入', final: true,
    profileId: 'assistant-a', roomId: 'room-a', callId: 'call-other' }));
  assert.equal(transcripts.length, 0);
  assert.match(statuses.at(-1).detail, /通话标识发生变化/);
  await service.stop();
});
test('old pending microphone completion releases only its own resource after a new call starts', async () => {
  const gate = deferred(), oldMic = capturer(() => gate.promise), newMic = capturer();
  let created = 0;
  const { service } = load(async () => ++created === 1 ? oldMic : newMic);
  service.handleServerEvent('{"type":"ready"}'); await flush();
  await service.stop();
  service.handleServerEvent('{"type":"ready"}'); await flush();
  gate.resolve(); await flush();
  assert.equal(service.capturer, newMic);
  assert.equal(service.phaseValue(), 'active');
  assert.equal(oldMic.releases, 1);
  assert.equal(newMic.releases, 0);
  await service.stop();
});
test('microphone failure cleans resources and reports an actionable stage', async () => {
  const mic = capturer(async () => { throw new Error('private platform detail'); });
  const { service, statuses, progress } = load(async () => mic);
  service.handleServerEvent('{"type":"ready"}'); await flush();
  assert.equal(service.phaseValue(), 'error');
  assert.equal(service.capturer, null);
  assert.equal(mic.releases, 1);
  assert.equal(progress.at(-1).failure, 'mic');
  assert.equal(statuses.at(-1).detail.includes('private'), false);
  await service.stop();
});
test('a media error keeps the failed stage and does not start capture', () => {
  let created = 0;
  const { service, progress } = load(async () => { created++; return capturer(); });
  service.handleServerEvent('{"type":"progress","stage":"media"}');
  service.handleServerEvent('{"type":"error","failureStage":"media"}');
  assert.equal(service.phaseValue(), 'error');
  assert.equal(progress.at(-1).failure, 'media');
  assert.equal(created, 0);
});
test('normal startup uses system permission request and recovery opens system permission settings', async () => {
  let requests = 0, settings = 0;
  const { service } = load(async () => capturer(), { abilityAccessCtrl: { createAtManager: () => ({
    async requestPermissionsFromUser() { requests++; return { authResults: [0] }; },
    async requestPermissionOnSetting() { settings++; return [0]; }
  }) } });
  assert.equal(await service.requestMicPermission({}), true);
  assert.equal(await service.requestMicPermission({}, true), true);
  assert.equal(requests, 1);
  assert.equal(settings, 1);
});
test('an established call error is not presented as assistant preparation failure', async () => {
  const { service, statuses, progress } = load(async () => capturer());
  service.handleServerEvent('{"type":"ready"}'); await flush();
  service.handleServerEvent('{"type":"error","message":"private detail"}');
  assert.equal(service.phaseValue(), 'error');
  assert.equal(statuses.at(-1).detail, '语音服务异常，通话已结束，请重试');
  assert.equal(progress.at(-1).failure, '');
  await service.stop();
});

test('upstream HTTP failures are classified without displaying private error bodies', async () => {
  for (const [httpStatus, expected] of [[502,'Codex 语音服务暂时不可用'],[503,'Codex 语音服务暂时不可用'],[504,'Codex 语音服务暂时不可用'],[401,'Codex 语音访问被拒绝'],[403,'Codex 语音访问被拒绝'],[429,'Codex 语音请求受限'],[undefined,'个人助手准备失败']]) {
    const { service, statuses } = load(async () => capturer());
    service.handleServerEvent(JSON.stringify({type:'error',failureStage:'assistant',httpStatus,message:'private token'}));
    await flush();
    assert.ok(statuses.some(x => x.status === 'error' && x.detail.includes(expected)));
    assert.ok(statuses.every(x => !x.detail?.includes('private')));
  }
});
