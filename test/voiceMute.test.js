import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

function load() {
  const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceCallService.ets', import.meta.url), 'utf8')
    .replace(/^import\s+.*?;\s*$/gm, '').replace('export class VoiceCallService', 'class VoiceCallService');
  const states = [], statuses = [], sent = [];
  const context = vm.createContext({ Date, console, setTimeout, clearTimeout, clearInterval,
    VoiceBackgroundTaskService: { start: async () => 1, stop: async () => {} },
    VoiceRouteConfig: { voiceHttpsBaseUrl: '' } });
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.service = VoiceCallService;', context);
  const service = context.service;
  service.setCallbacks({ onMutedChanged: value => states.push(value),
    onStatus: (status, detail) => statuses.push({status, detail}),
    onTranscript() {}, onHistory() {}, onAssistantName() {}, onSpeaking() {}, onClosed() {} });
  service.recordVoiceAudioInput = () => {};
  service.resetVoiceAudioHealth = () => {};
  service.clearVoiceAudioHealth = () => {};
  service.connectOnce = async () => {};
  service.resolveVoiceWebSocketUrl = () => 'ws://isolated.invalid';
  service.abilityContext = {};
  service.ws = {send: async payload => { sent.push(new Uint8Array(payload).slice()); return true; }};
  service.phase = 'active';
  return {service, states, statuses, sent};
}

test('retry preserves mute and continues blocking new microphone frames', async () => {
  const {service, states, sent} = load();
  service.setMuted(true);
  service.phase = 'idle';
  await service.connect('https://isolated.invalid', '');
  service.phase = 'active';
  service.handleMicData(new Uint8Array(3200).fill(7).buffer);
  assert.equal(service.mutedValue(), true);
  assert.equal(states.at(-1), true);
  assert.equal(sent.length, 0);
});

test('mute discards partial audio and unmute sends only newly captured audio', () => {
  const {service, sent} = load();
  service.handleMicData(new Uint8Array(640).fill(1).buffer);
  service.setMuted(true);
  assert.equal(service.micQueue.length, 0);
  service.handleMicData(new Uint8Array(3200).fill(2).buffer);
  assert.equal(sent.length, 0);
  service.setMuted(false);
  service.handleMicData(new Uint8Array(2560).fill(3).buffer);
  assert.equal(sent.length, 0);
  service.handleMicData(new Uint8Array(640).fill(3).buffer);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].every(value => value === 3));
});

test('send boundary also rejects audio while muted or ending', async () => {
  const {service, sent} = load();
  service.setMuted(true);
  await service.sendBinary(new ArrayBuffer(3200));
  assert.equal(sent.length, 0);
  service.setMuted(false);
  service.stopping = true;
  await service.sendBinary(new ArrayBuffer(3200));
  assert.equal(sent.length, 0);
});

test('reattached page receives current mute state and subsequent status changes', () => {
  const {service, statuses} = load();
  service.setMuted(true);
  let displayedMute = false;
  service.setCallbacks({...service.callbacks, onMutedChanged: value => { displayedMute = value; }});
  assert.equal(displayedMute, true);
  service.setMuted(false);
  assert.equal(displayedMute, false);
  assert.match(statuses.at(-1).detail, /正在聆听/);
  service.setMuted(true);
  assert.match(statuses.at(-1).detail, /已静音/);
});

test('muting does not cancel assistant playback or resend an already submitted frame', async () => {
  const {service, sent} = load();
  const playQueue = [new ArrayBuffer(10)];
  service.playQueue = playQueue;
  service.handleMicData(new ArrayBuffer(3200));
  assert.equal(sent.length, 1);
  service.setMuted(true);
  service.handleMicData(new ArrayBuffer(3200));
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(service.playQueue, playQueue);
});
