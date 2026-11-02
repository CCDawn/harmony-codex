import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const index = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets'), 'utf8');
function method(name, parameters = '', dependencies = {}) {
  const start = index.search(new RegExp(`^\\s*(?:private )?(?:async )?${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  const open = index.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < index.length; end++) {
    if (index[end] === '{') depth++;
    if (index[end] === '}') depth--;
  }
  const async = index.slice(start, open).includes('async ');
  const code = stripTypeScriptTypes(`${async ? 'async ' : ''}function run(${parameters}) {${index.slice(open + 1, end - 1)}}`);
  return new Function(...Object.keys(dependencies), `${code}; return run;`)(...Object.values(dependencies));
}

function state(overrides = {}) {
  return {
    activeTab: 'sessions', homeActionMenuVisible: true, homeActionMenuSource: 'sidebar_header',
    bridgeUrl: 'https://old.example', bridgeToken: 'old-token',
    pairingDraftUrl: '', pairingDraftToken: '', pairingBusy: false, pairingChecking: false,
    pairingCheckGeneration: 0, pairingConnectionFailed: false,
    sessionMessage: '未发送草稿', selectedSession: { id: 'thread-A' }, scrollOffset: 730,
    voiceCallStatus: 'active', voiceCallMuted: true, checks: 0,
    normalizedBridgeUrl() { return this.bridgeUrl; },
    // These tests isolate configuration ordering; real draft navigation is covered separately.
    preserveCurrentSessionDraft: () => true, restoreCurrentSessionDraft() {},
    stopSessionEventStream() {}, syncSessionEventStream() {},
    refreshPairingUiState() {}, checkPairingConnection() { this.checks++; },
    ...overrides
  };
}

test('a discovered rename updates labels without replacing the assistant conversation', async () => {
  const history = [{ itemId: 'room:message', role: 'assistant', text: 'existing' }];
  const s = state({ companionProfileLoading: false, companionProfileCheckedAt: 0,
    companionProfile: { id: 'assistant', roomId: 'room', name: 'old name' },
    companionGeneration: 3, companionEntries: history, companionNextCursor: 'older',
    companionSelected: true, voiceCallVisible: true, voiceCallAssistantName: 'old name' });
  const load = method('loadCompanionProfile', 'force = false', { BridgeClient: {
    async getCompanionProfile() { return { id: 'assistant', roomId: 'room', name: 'renamed assistant' }; }
  } });
  await load.call(s, true);
  assert.equal(s.companionProfile.name, 'renamed assistant');
  assert.equal(s.voiceCallAssistantName, 'renamed assistant');
  assert.equal(s.companionEntries, history);
  assert.equal(s.companionGeneration, 3);
  assert.equal(s.companionNextCursor, 'older');
});

test('verified final transcript from the original call is persisted after current assistant selection changes', () => {
  const persisted = [];
  const reducer = { append(entries, entry) { return entries.concat(entry); } };
  const store = { partitionKey(partition) {
    const origin = partition.bridgeUrl.replace(/\/$/, '').toLowerCase();
    return `${origin}|${partition.assistantId}|${partition.roomId}`;
  } };
  const append = method('appendVoiceTranscript', 'entry, identity', {
    VoiceTranscriptReducer: reducer,
    CompanionTranscriptStore: store
  });
  const s = state({
    companionProfile: { id: 'assistant-new', roomId: 'room-new' },
    companionSelected: true,
    companionEntries: [],
    voiceCallTranscripts: [],
    companionTranscriptPartitionKey: 'https://bridge.example|assistant-new|room-new',
    voiceCallBridgeUrlSnapshot: 'https://bridge.example',
    normalizedBridgeUrl() { return 'https://bridge.example'; },
    preparePhoneTranscriptEntry(entry, identity) {
      return { ...entry, itemId: `voice:${identity.callId}:${entry.itemId}`, phoneTranscript: true,
        localStorageStatus: 'pending', localBridgeOrigin: 'https://bridge.example',
        localAssistantId: identity.profileId, localRoomId: identity.roomId, callId: identity.callId };
    },
    persistPhoneTranscript(entry, identity) { persisted.push({ entry, identity }); },
    log() {}
  });

  append.call(s, { itemId: 'turn-1', role: 'assistant', text: 'final from the old call', final: true },
    { profileId: 'assistant-old', roomId: 'room-old', callId: 'call-old' });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].identity.profileId, 'assistant-old');
  assert.equal(persisted[0].identity.roomId, 'room-old');
  assert.equal(persisted[0].entry.localBridgeOrigin, 'https://bridge.example');
  assert.equal(s.companionEntries.length, 0);
  assert.equal(s.voiceCallTranscripts[0].text, 'final from the old call');
});

test('switching assistant identity cannot relabel an existing call', async () => {
  const s = state({ companionProfileLoading: false, companionProfileCheckedAt: 0,
    companionProfile: { id: 'old', roomId: 'old-room', name: 'original' },
    companionGeneration: 3, companionEntries: [{ text: 'old' }], companionNextCursor: 'older',
    companionSelected: true, voiceCallVisible: true, voiceCallAssistantName: 'original' });
  const load = method('loadCompanionProfile', 'force = false', { BridgeClient: {
    async getCompanionProfile() { return { id: 'new', roomId: 'new-room', name: 'another assistant' }; }
  } });
  await load.call(s, true);
  assert.equal(s.companionProfile.name, 'another assistant');
  assert.equal(s.voiceCallAssistantName, 'original');
  assert.equal(s.companionGeneration, 4);
  assert.deepEqual(s.companionEntries, []);
});

test('periodic discovery reuses the profile cache instead of querying on every message poll', async () => {
  let reads = 0;
  const s = state({ companionProfileLoading: false, companionProfileCheckedAt: 0,
    companionProfile: null, companionGeneration: 0, companionEntries: [], companionNextCursor: null,
    voiceCallVisible: false });
  const load = method('loadCompanionProfile', 'force = false', { BridgeClient: {
    async getCompanionProfile() { reads++; return { id: 'assistant', roomId: 'room', name: 'current name' }; }
  } });
  await load.call(s);
  await load.call(s);
  assert.equal(reads, 1);
  s.companionProfileCheckedAt = Date.now() - 61000;
  await load.call(s);
  assert.equal(reads, 2);
});

test('pairing navigation preserves the current conversation, draft, scroll and mute state', () => {
  const calls = [];
  const s = state({ stopSessionEventStream() { calls.push('stop'); }, syncSessionEventStream() { calls.push('sync'); } });
  const selected = s.selectedSession;
  method('openConfigurationPage', 'page').call(s, 'pairing');
  assert.equal(s.activeTab, 'pairing');
  assert.equal(s.homeActionMenuVisible, false);
  assert.equal(s.pairingDraftUrl, s.bridgeUrl);
  assert.equal(s.checks, 1);
  s.pairingDraftUrl = 'https://unsaved.example';
  s.pairingDraftToken = 'unsaved-token';
  method('closeConfigurationPage').call(s);
  assert.deepEqual(calls, ['stop', 'sync']);
  assert.equal(s.activeTab, 'sessions');
  assert.equal(s.bridgeUrl, 'https://old.example');
  assert.equal(s.bridgeToken, 'old-token');
  assert.equal(s.selectedSession, selected);
  assert.equal(s.sessionMessage, '未发送草稿');
  assert.equal(s.scrollOffset, 730);
  assert.equal(s.voiceCallMuted, true);
  assert.equal(s.voiceCallStatus, 'active');
});

test('advanced tool pages return through settings without altering the conversation', () => {
  for (const activeTab of ['overview', 'tasks']) {
    const s = state({ activeTab });
    method('closeConfigurationPage').call(s);
    assert.equal(s.activeTab, 'settings');
    method('closeConfigurationPage').call(s);
    assert.equal(s.activeTab, 'sessions');
    assert.equal(s.selectedSession.id, 'thread-A');
  }
});

test('system back leaves configuration first and preserves the underlying cloud computer', () => {
  const s = state({ activeTab: 'settings', homeActionMenuVisible: false,
    companionComputerVisible: true, companionSelected: true, hasOpenImagePreview: () => false,
    markdownReaderDocument: null, outboxPanelVisible: false, voiceCallVisible: false,
    desktopMonitorVisible: false
  });
  s.closeConfigurationPage = method('closeConfigurationPage');
  assert.equal(method('onBackPress').call(s), true);
  assert.equal(s.activeTab, 'sessions');
  assert.equal(s.companionComputerVisible, true);
  assert.equal(s.companionSelected, true);
});

test('paired configuration saves to secure storage before applying runtime parameters', async () => {
  const current = { deviceId: 'device', deviceName: 'phone', totpSecret: 'secret', pairedAt: 'date' };
  const events = [];
  const s = state({ pairingDraftUrl: 'https://new.example', pairingDraftToken: ' new-token ',
    applyRuntimeCredential(credential) {
      events.push('apply'); this.bridgeUrl = credential.bridgeUrl; this.bridgeToken = credential.token;
    }, checkPairingConnection() { events.push('check'); }
  });
  await method('savePairingDraft', '', {
    BridgePairingService: { normalizeBaseUrl: value => value.trim() },
    CredentialRuntime: { getRuntimeCredential: () => current }, getContext: () => ({}),
    BridgeCredentialStore: { async saveCredential(_, credential) {
      events.push('save'); assert.equal(s.bridgeUrl, 'https://old.example');
      assert.equal(credential.totpSecret, current.totpSecret);
    } }
  }).call(s);
  assert.deepEqual(events, ['save', 'apply', 'check']);
  assert.equal(s.bridgeUrl, 'https://new.example');
  assert.equal(s.bridgeToken, 'new-token');
  assert.equal(s.pairingBusy, false);
});

test('a rejected secure save or invalid address leaves the current connection intact', async () => {
  for (const url of ['not-a-url', 'https://new.example']) {
    const s = state({ pairingDraftUrl: url, pairingDraftToken: 'new-token' });
    await method('savePairingDraft', '', {
      BridgePairingService: { normalizeBaseUrl: value => value },
      CredentialRuntime: { getRuntimeCredential: () => ({ deviceId: 'device', totpSecret: 'secret' }) },
      getContext: () => ({}), BridgeCredentialStore: { async saveCredential() { throw Error('storage'); } }
    }).call(s);
    assert.equal(s.bridgeUrl, 'https://old.example');
    assert.equal(s.bridgeToken, 'old-token');
    assert.equal(s.checks, 0);
    assert.equal(s.pairingBusy, false);
  }
});

test('channel checks distinguish readable messages from a cloud environment that is not ready', async () => {
  const profile = { id: 'bear', roomId: 'room' };
  const client = {
    async getCompanionProfile() { return profile; }, async getCompanionMessages() { return { entries: [] }; },
    async getCompanionComputerStatus() { return JSON.stringify({ ...profile, assistantId: 'bear', ready: false }); }
  };
  const s = state();
  s.checkPairingMessages = method('checkPairingMessages', 'url, token, profile, generation', { BridgeClient: client });
  s.checkPairingComputer = method('checkPairingComputer', 'url, token, profile, generation', { BridgeClient: client });
  await method('checkPairingConnection', '', { BridgeClient: client }).call(s);
  assert.match(s.pairingMessageStatus, /读取正常/);
  assert.equal(s.pairingComputerStatus, '云环境尚未就绪');
  assert.equal(s.pairingConnectionFailed, false);
  assert.equal(s.pairingChecking, false);
});

test('a failed channel enables retry and a later successful check removes that state', async () => {
  let fail = true;
  const profile = { id: 'bear', roomId: 'room' };
  const client = {
    async getCompanionProfile() { return profile; },
    async getCompanionMessages() { if (fail) throw Error('offline'); return { entries: [] }; },
    async getCompanionComputerStatus() {
      return JSON.stringify({ ready: true, assistantId: 'bear', roomId: 'room', threadId: 'thread', environmentId: 'cloud' });
    }
  };
  const s = state();
  s.checkPairingMessages = method('checkPairingMessages', 'url, token, profile, generation', { BridgeClient: client });
  s.checkPairingComputer = method('checkPairingComputer', 'url, token, profile, generation', { BridgeClient: client });
  const check = method('checkPairingConnection', '', { BridgeClient: client });
  await check.call(s);
  assert.equal(s.pairingConnectionFailed, true);
  fail = false;
  await check.call(s);
  assert.equal(s.pairingConnectionFailed, false);
  assert.match(s.pairingComputerStatus, /云环境已就绪/);
});

test('late status responses after leaving pairing cannot overwrite a newer check', async () => {
  let finish;
  const s = state({ activeTab: 'pairing', pairingCheckGeneration: 4 });
  const check = method('checkPairingComputer', 'url, token, profile, generation', {
    BridgeClient: { getCompanionComputerStatus: () => new Promise(resolve => { finish = resolve; }) }
  });
  const pending = check.call(s, s.bridgeUrl, s.bridgeToken, { id: 'bear', roomId: 'room' }, 4);
  method('closeConfigurationPage').call(s);
  s.pairingComputerStatus = 'newer-result';
  finish(JSON.stringify({ ready: true, assistantId: 'bear', roomId: 'room', threadId: 'thread', environmentId: 'cloud' }));
  await pending;
  assert.equal(s.pairingComputerStatus, 'newer-result');
});

test('voice availability requires actual call state, rather than a successful pairing check', () => {
  const voice = method('pairingVoiceStatus');
  assert.equal(voice.call(state({ voiceCallStatus: 'idle' })), '未检测，通话时验证');
  assert.equal(voice.call(state({ voiceCallStatus: 'active', voiceCallMuted: true })), '通话已接通，麦克风静音');
  assert.match(voice.call(state({ voiceCallStatus: 'error' })), /失败/);
});

test('returning to a connecting or active call reveals it without dialing or clearing transcript', () => {
  for (const phase of ['connecting', 'ready', 'active']) {
    let starts = 0;
    const transcripts = [{ role: 'assistant', text: 'current call' }];
    const s = state({ voiceCallStatus: phase, voiceCallVisible: false,
      desktopMonitorVisible: false, voiceCallTranscripts: transcripts,
      startVoiceCallSession() { starts++; } });
    assert.equal(method('canRunHomeAction', 'action').call(s, 'voice_call'), true);
    method('openVoiceCall', 'source', { VoiceCallService: { phaseValue: () => phase } }).call(s, 'companion_conversation');
    assert.equal(s.voiceCallVisible, true);
    assert.equal(s.voiceCallTranscripts, transcripts);
    assert.equal(s.voiceCallMuted, true);
    assert.equal(starts, 0);
  }
});

test('conversation search matches title or project without changing canonical session order', () => {
  const sessions = [
    { id: 'a', title: 'Fix voice', projectLabel: 'Codex' },
    { id: 'b', title: '整理想法', projectLabel: '个人项目' },
    { id: 'c', title: 'Voice UI', projectLabel: undefined }
  ];
  const find = method('searchSessionResults');
  assert.deepEqual(find.call({ sessions, sessionSearchQuery: ' VOICE ' }).map(x => x.id), ['a', 'c']);
  assert.deepEqual(find.call({ sessions, sessionSearchQuery: '个人' }).map(x => x.id), ['b']);
  assert.deepEqual(find.call({ sessions, sessionSearchQuery: 'missing' }), []);
  assert.deepEqual(sessions.map(x => x.id), ['a', 'b', 'c']);
});

test('composer grows for multiline drafts and caps its height without shrinking for large text', () => {
  const height = method('sessionComposerTextAreaHeight');
  const state = { sessionMessage: '', scaledLineHeight: value => value, scaledFontSize: value => value,
    isLandscapeSessionLayout: () => false, sessionWindowWidthVp: () => 420, sessionSidebarUserCollapsed: true };
  const compact = height.call(state);
  assert.equal(compact, 44);
  state.sessionMessage = '单行长消息'.repeat(20);
  assert.ok(height.call(state) > compact, 'wrapped text also grows');
  state.sessionMessage = 'one\ntwo\nthree';
  assert.ok(height.call(state) > compact);
  state.sessionMessage = 'a\nb\nc\nd';
  const capped = height.call(state);
  state.sessionMessage += '\ne\nf';
  assert.equal(height.call(state), capped);
  state.scaledLineHeight = value => value * 1.3;
  assert.ok(height.call(state) > capped);
});

test('startup connection negotiation failure displays an error instead of an empty conversation list', async () => {
  const failure = '连接不上服务器';
  const refresh = method('refreshDashboard', 'force = false', {
    BridgeClient: { async getRuntimeStatus() { throw new Error(failure); } }
  });
  const s = state({ isRefreshingDashboard: false, refreshDesktopInteractions: async () => {},
    lastRuntimeContractRefreshAt: 0, isNewSessionDraft: false, selectedSession: null,
    normalizedBridgeUrl: () => 'https://bridge.example', sessions: [], sessionsLoadError: '',
    sessionsFailureDiagnosticsAvailable: true, sessionsFailureDetailsExpanded: true,
    dashboardFailureCount: 0, errorText: err => err.message, log() {},
    publishConnectionNotification: async () => {},
    sessionConnectionFailure: () => ({ title: '无法读取会话' }) });
  await refresh.call(s);
  assert.equal(s.sessionsLoadError, failure);
  assert.equal(s.sessionsFailureDiagnosticsAvailable, false);
  assert.equal(s.sessionsFailureDetailsExpanded, false);
  assert.equal(s.message, '无法读取会话');
  assert.equal(s.isRefreshingDashboard, false);
});

test('a failed dashboard negotiation preserves loaded conversations and specific session diagnostics', async () => {
  const refresh = method('refreshDashboard', 'force = false', {
    BridgeClient: { async getRuntimeStatus() { throw new Error('temporary network failure'); } }
  });
  for (const sessions of [[], [{ id: 'retained' }]]) {
    const s = state({ isRefreshingDashboard: false, refreshDesktopInteractions: async () => {},
      lastRuntimeContractRefreshAt: 0, isNewSessionDraft: false, selectedSession: null,
      normalizedBridgeUrl: () => 'https://bridge.example', sessions,
      sessionsLoadError: 'specific session diagnostic', sessionsFailureDiagnosticsAvailable: true,
      dashboardFailureCount: 0, errorText: err => err.message, log() {},
      publishConnectionNotification: async () => {} });
    await refresh.call(s);
    assert.equal(s.sessions, sessions);
    assert.equal(s.sessionsLoadError, 'specific session diagnostic');
    assert.equal(s.sessionsFailureDiagnosticsAvailable, true);
  }
});


test('phone transcript identity and first timestamp survive finalization, storage status and retry', async () => {
  const prepare = method('preparePhoneTranscriptEntry', 'entry, identity', {
    CompanionTranscriptStore: { normalizeBridgeOrigin: value => value }
  });
  const s = state({ voiceCallTranscripts: [], companionEntries: [], pendingVoiceTranscriptIds: {},
    nextPhoneTranscriptSequence: 0, voiceCallBridgeUrlSnapshot: 'https://bridge.example' });
  const identity = { profileId: 'profile', roomId: 'room', callId: 'call' };
  const first = prepare.call(s, { itemId: 'turn', role: 'user', text: '说话', final: false }, identity);
  assert.ok(Number.isFinite(first.createdAt));
  s.voiceCallTranscripts = [{ ...first, createdAt: 1234 }];
  const final = prepare.call(s, { itemId: 'turn', role: 'user', text: '说话完成', final: true }, identity);
  assert.equal(final.createdAt, 1234);
  const status = method('phoneTranscriptWithStatus', 'entry, status');
  assert.equal(status.call(s, final, 'saved').createdAt, 1234);
  const retry = method('retryPhoneTranscriptSave', 'entry');
  s.updatePhoneTranscriptStorageStatus = () => {};
  s.persistPhoneTranscript = async entry => { assert.equal(entry.createdAt, 1234); };
  await retry.call(s, final);
});
