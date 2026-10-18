import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
const methods = source.slice(source.indexOf('  private stopCompanionPolling(): void {'),
  source.indexOf('  private registerVoiceCallCallbacks(): void {'));

function setup() {
  let finishLatest;
  const latest = new Promise(resolve => { finishLatest = resolve; });
  const calls = [];
  const context = vm.createContext({ clearInterval, getContext: () => ({}),
    CompanionTextService: {
      partitionKey(partition) { return `${partition.bridgeUrl}|${partition.profileId}|${partition.roomId}`; },
      load() { return []; }, messages() { return []; }, reconcile() { return false; }
    },
    CompanionTranscriptStore: {
      partitionKey(partition) { return `${partition.bridgeUrl}|${partition.assistantId}|${partition.roomId}`; },
      async load() { return []; }
    },
    VoiceTranscriptReducer: { replaceHistory(existing) { return existing; } },
    CompanionHistoryReducer: { mergeCalls(existing, incoming) { return existing.concat(incoming); } },
    BridgeClient: {
    async getCompanionMessages(...args) {
      calls.push(args.at(-1));
      if (calls.length === 1) return latest;
      return { entries: [{ itemId: 'room:old', role: 'user', text: 'older', final: true }], nextCursor: null };
    }
  } });
  vm.runInContext(stripTypeScriptTypes(`class Harness { ${methods} } globalThis.Harness = Harness;`, { mode: 'strip' }), context);
  const page = new context.Harness();
  Object.assign(page, {
    companionSelected: true, companionInFlight: false, companionOlderPending: false,
    companionGeneration: 0, companionTimer: 0, companionEntries: [], companionNextCursor: null,
    companionCalls: [], companionTranscriptPartitionKey: '', companionTranscriptStorageError: '',
    companionTextPartitionKey: '', companionTextReady: false, companionTextDrafts: new Map(),
    companionTextMessages: [], companionTextDraft: '', companionTextError: '',
    companionProfile: { id: 'profile', roomId: 'room' }, activeTab: 'sessions', bridgeToken: '',
    normalizedBridgeUrl: () => 'http://bridge', async loadCompanionProfile() {}, log() {}
  });
  return { page, calls, finishLatest, context };
}

test('load earlier waits for an overlapping automatic sync and uses its returned cursor', async () => {
  const { page, calls, finishLatest } = setup();
  const syncing = page.refreshCompanionConversation(false);
  await new Promise(resolve => setImmediate(resolve));
  await page.refreshCompanionConversation(true);
  assert.equal(calls.length, 1);
  assert.equal(page.companionLoading, true);
  finishLatest({ entries: [{ itemId: 'room:new', role: 'assistant', text: 'new', final: true }], nextCursor: 'older-cursor' });
  await syncing;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['', 'older-cursor']);
  assert.deepEqual(Array.from(page.companionEntries, entry => entry.itemId), ['room:old', 'room:new']);
  assert.equal(page.companionLoading, false);
});

test('leaving the conversation cancels a queued older-page request and discards stale results', async () => {
  const { page, calls, finishLatest } = setup();
  const syncing = page.refreshCompanionConversation(false);
  await new Promise(resolve => setImmediate(resolve));
  await page.refreshCompanionConversation(true);
  page.leaveCompanionConversation();
  finishLatest({ entries: [{ itemId: 'room:new', role: 'assistant', text: 'new' }], nextCursor: 'older-cursor' });
  await syncing;
  assert.deepEqual(calls, ['']);
  assert.equal(page.companionEntries.length, 0);
  assert.equal(page.companionOlderPending, false);
});

test('a transient cache read failure retries on refresh and preserves live unsaved turns', async () => {
  const { page, context } = setup();
  let attempts = 0;
  const local = { itemId: 'voice:call:old', role: 'assistant', text: 'saved earlier', final: true,
    phoneTranscript: true, localStorageStatus: 'saved' };
  context.CompanionTranscriptStore.load = async () => {
    attempts += 1;
    if (attempts === 1) throw Error('temporary read failure');
    return [local];
  };
  page.errorText = error => error.message;
  const reducerSource = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceTranscriptReducer.ets', import.meta.url), 'utf8')
    .replace(/^import\s+.*?;\s*$/gm, '').replaceAll('export ', '');
  vm.runInContext(`${stripTypeScriptTypes(reducerSource)}\nglobalThis.VoiceTranscriptReducer = VoiceTranscriptReducer;`, context);
  await page.restoreCompanionTranscripts(page.companionProfile, 0);
  assert.equal(attempts, 1);
  assert.match(page.companionTranscriptStorageError, /temporary read failure/);
  page.companionEntries.push({ itemId: 'voice:call:new', role: 'user', text: 'not yet saved', final: true,
    phoneTranscript: true, localStorageStatus: 'failed' });
  await page.restoreCompanionTranscripts(page.companionProfile, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(Array.from(page.companionEntries, entry => entry.itemId), ['voice:call:new', 'voice:call:old']);
  await page.restoreCompanionTranscripts(page.companionProfile, 0);
  assert.equal(attempts, 2);
});
