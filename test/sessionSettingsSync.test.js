import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { SessionSettingsStore } from '../src/sessionSettingsStore.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';

const threadId = 'settings-sync-target';

async function waitForSent(state, count) {
  for (let i = 0; i < 300; i++) {
    if (state.sent.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for outbox dispatch');
}

async function fixture(t, initial = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-settings-sync-'));
  const filePath = path.join(root, 'settings.json');
  await fs.writeFile(filePath, JSON.stringify({ version: 1, sessions: { [threadId]: initial } }));
  const sessionSettings = new SessionSettingsStore({ filePath });
  const state = { thread: { id: threadId, model: 'gpt-desktop', reasoningEffort: 'high' }, failure: false, sent: [], reads: [] };
  state.defaults = { model: 'gpt-global', reasoningEffort: 'low', models: [] };
  const config = {
    repoRoot: root, outboxEnabled: false, desktopLiveDiagnostics: false,
    appServerRuntimeMode: 'app-server-primary', sessionSettings,
    deviceRegistryPath: path.join(root, 'devices.json'),
    logger: { async write() {} },
    desktopLiveRecovery: {},
    defaultReasoningEffortProvider: async () => 'low',
    codexSettingsProvider: async () => state.defaults,
    threadCodexSettingsProvider: async (id) => {
      state.reads.push(id);
      if (state.failure) throw new Error('offline');
      return { thread: state.thread, ...(state.threadSettings ? { threadSettings: state.threadSettings } : {}) };
    },
    sessions: {
      async getSessionModel() { return 'gpt-db-stale'; },
      async getSessionReasoningEffort() { return 'medium'; },
      async verifySessionTarget(id) { return { id }; }
    },
    projects: [{ id: 'probe', root, name: 'probe' }],
    threadService: {
      async sendMessage(args) { state.sent.push(args); return { id: 'fake-run', ...args }; }
    }
  };
  const adapter = new MockCodexAdapter();
  if (options.nativeProvider) {
    const read = config.threadCodexSettingsProvider;
    delete config.threadCodexSettingsProvider;
    adapter.cdpDesktopAdapter = { client: { async request(method, params) {
      assert.equal(method, 'thread/read');
      assert.deepEqual(params, { threadId, includeTurns: false });
      return read(params.threadId);
    } } };
  }
  if (options.outbox) {
    config.outboxEnabled = true;
    config.outboxPath = path.join(root, 'outbox.json');
    config.outboxReconciler = async () => null;
  }
  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/codex/threads/${threadId}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (suffix, body) => {
    const response = await fetch(url + suffix, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, suffix === '/messages' ? 202 : 200);
    return response.json();
  };
  return { state, sessionSettings, filePath, request,
    settings: async () => (await request('/settings')).settings,
    send: (extra = {}) => request('/messages', {
      projectId: 'probe', text: 'synthetic test only',
      sessionFingerprint: { title: 'test', projectRoot: root, projectLabel: 'probe' }, ...extra
    }) };
}

test('legacy phone pins retire against the verified target and cannot return after an offline dispatch', async (t) => {
  const f = await fixture(t, { model: 'gpt-legacy', reasoningEffort: 'xhigh', updatedAt: '2026-10-08' });
  const settings = await f.settings();
  assert.equal(settings.model, '');
  assert.equal(settings.effectiveModel, 'gpt-desktop');
  assert.equal(settings.reasoningEffort, '');
  assert.equal(settings.effectiveReasoningEffort, 'high');
  const persisted = await new SessionSettingsStore({ filePath: f.filePath }).getSessionSettings(threadId);
  assert.equal(persisted.model, '');
  f.state.failure = true;
  await f.send();
  assert.equal(f.state.sent[0].model, '');
  assert.equal(f.state.sent[0].reasoningEffort, '');
});

test('dispatch reconciles stale pins even when settings GET was never opened', async (t) => {
  const f = await fixture(t, { model: 'gpt-legacy', reasoningEffort: 'xhigh' });
  await f.send();
  assert.equal(f.state.sent[0].model, '');
  assert.equal(f.state.sent[0].reasoningEffort, '');
});

test('fresh per-field pins survive their baseline, then desktop adoption and overrides retire independently', async (t) => {
  const f = await fixture(t);
  const saved = (await f.request('/settings', { model: 'gpt-phone', reasoningEffort: 'xhigh' })).settings;
  assert.equal(saved.model, 'gpt-phone');
  assert.equal(saved.reasoningEffort, 'xhigh');
  await f.send();
  assert.equal(f.state.sent[0].model, 'gpt-phone');
  assert.equal(f.state.sent[0].reasoningEffort, 'xhigh');
  f.state.thread.model = 'gpt-phone';
  let settings = await f.settings();
  assert.equal(settings.model, '');
  assert.equal(settings.reasoningEffort, 'xhigh');
  f.state.thread.reasoningEffort = 'low';
  settings = await f.settings();
  assert.equal(settings.reasoningEffort, '');
  assert.equal(settings.effectiveReasoningEffort, 'low');
});

test('partial updates preserve the other baseline; reload preserves pending choices', async (t) => {
  const f = await fixture(t);
  await f.request('/settings', { model: 'gpt-phone', reasoningEffort: 'xhigh' });
  await f.request('/settings', { reasoningEffort: 'low' });
  const restored = await new SessionSettingsStore({ filePath: f.filePath }).getSessionSettings(threadId);
  assert.equal(restored.modelBaseline, 'gpt-desktop');
  assert.equal(restored.reasoningEffortBaseline, 'high');
  f.state.thread.model = 'gpt-desktop-new';
  const settings = await f.settings();
  assert.equal(settings.model, '');
  assert.equal(settings.reasoningEffort, 'low');
});

test('mismatched or failed live reads cannot retire pins using a global or stale database fallback', async (t) => {
  const f = await fixture(t, { model: 'gpt-legacy', reasoningEffort: 'xhigh' });
  f.state.thread.id = 'another-thread';
  assert.equal((await f.settings()).model, 'gpt-legacy');
  f.state.failure = true;
  await f.send();
  assert.equal(f.state.sent[0].model, 'gpt-legacy');
  assert.equal((await f.sessionSettings.getSessionSettings(threadId)).model, 'gpt-legacy');
});

test('a choice saved while the desktop is unknown stays pending until adopted; explicit message options remain supported', async (t) => {
  const f = await fixture(t);
  f.state.failure = true;
  await f.request('/settings', { model: 'gpt-phone' });
  f.state.failure = false;
  assert.equal((await f.settings()).model, 'gpt-phone');
  await f.send({ model: 'gpt-explicit', reasoningEffort: 'low' });
  assert.equal(f.state.sent[0].model, 'gpt-explicit');
  assert.equal(f.state.sent[0].reasoningEffort, 'low');
  f.state.thread.model = 'gpt-phone';
  assert.equal((await f.settings()).model, '');
});

test('serialized initial writes retain different sessions and independently changed fields', async (t) => {
  const f = await fixture(t);
  const fresh = new SessionSettingsStore({ filePath: path.join(path.dirname(f.filePath), 'fresh.json') });
  await Promise.all([
    fresh.updateSessionSettings('first', { model: 'gpt-first', modelBaseline: 'gpt-base' }),
    fresh.updateSessionSettings('second', { model: 'gpt-second' }),
    fresh.updateSessionSettings('first', { reasoningEffort: 'high', reasoningEffortBaseline: 'low' })
  ]);
  const reloaded = new SessionSettingsStore({ filePath: fresh.filePath });
  assert.equal((await reloaded.getSessionSettings('first')).model, 'gpt-first');
  assert.equal((await reloaded.getSessionSettings('first')).reasoningEffort, 'high');
  assert.equal((await reloaded.getSessionSettings('second')).model, 'gpt-second');
});

test('a stale reconciliation snapshot cannot consume a newer phone choice', async (t) => {
  const f = await fixture(t);
  await f.sessionSettings.updateSessionSettings(threadId, { model: 'gpt-old', modelBaseline: 'gpt-base' });
  const oldSnapshot = await f.sessionSettings.getSessionSettings(threadId);
  await f.sessionSettings.updateSessionSettings(threadId, { model: 'gpt-new', modelBaseline: 'gpt-other' });
  const result = await f.sessionSettings.reconcileSessionSettings(threadId, { model: 'gpt-base' }, oldSnapshot);
  assert.equal(result.model, 'gpt-new');
  assert.equal((await f.sessionSettings.getSessionSettings(threadId)).modelBaseline, 'gpt-other');
});

test('atomic persistence failure preserves old data and the write queue recovers', async (t) => {
  const f = await fixture(t);
  await f.sessionSettings.updateSessionSettings(threadId, { model: 'gpt-before' });
  const before = await fs.readFile(f.filePath, 'utf8');
  f.sessionSettings.filePath = path.dirname(f.filePath); // rename over a directory must fail.
  await assert.rejects(f.sessionSettings.updateSessionSettings(threadId, { model: 'gpt-failed' }));
  f.sessionSettings.filePath = f.filePath;
  assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
  assert.equal((await f.sessionSettings.getSessionSettings(threadId)).model, 'gpt-before');
  await f.sessionSettings.updateSessionSettings(threadId, { reasoningEffort: 'high' });
  assert.equal((await new SessionSettingsStore({ filePath: f.filePath }).getSessionSettings(threadId)).model, 'gpt-before');
});

test('outbox dispatch uses the same target-specific resolver through the existing desktop RPC client', async (t) => {
  const f = await fixture(t, { model: 'gpt-legacy', reasoningEffort: 'xhigh' }, { outbox: true, nativeProvider: true });
  await f.send({ submissionId: 'test-settings-outbox' });
  await waitForSent(f.state, 1);
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0].model, '');
  assert.equal(f.state.sent[0].reasoningEffort, '');
  assert.deepEqual(f.state.reads, [threadId]);
});

test('saving an already adopted choice consumes it durably without another GET', async (t) => {
  const f = await fixture(t);
  const saved = (await f.request('/settings', { model: 'gpt-desktop', reasoningEffort: 'high' })).settings;
  assert.equal(saved.model, '');
  assert.equal(saved.reasoningEffort, '');
  f.state.failure = true;
  await f.send();
  assert.equal(f.state.sent[0].model, '');
  assert.equal(f.state.sent[0].reasoningEffort, '');
});

test('an unavailable live field preserves only that pending field', async (t) => {
  const f = await fixture(t, { model: 'gpt-legacy', reasoningEffort: 'xhigh' });
  f.state.thread.model = 'invalid model';
  const settings = await f.settings();
  assert.equal(settings.model, 'gpt-legacy');
  assert.equal(settings.reasoningEffort, '');
  assert.equal(settings.effectiveReasoningEffort, 'high');
});


test('speed settings inherit the real global tier when thread/read has no tier; catalog retains official options', async (t) => {
  const f = await fixture(t);
  const tiers = [{ id: 'priority', name: 'Fast', description: 'Official fast tier', futureField: true }];
  f.state.defaults = { model: 'gpt-global', serviceTier: 'priority', models: [{ id: 'gpt-desktop', serviceTiers: tiers }] };
  let settings = await f.settings();
  assert.equal(settings.serviceTier, '');
  assert.equal(settings.effectiveServiceTier, 'priority');
  assert.equal(settings.serviceTierSource, 'desktop');
  assert.deepEqual(settings.serviceTierOptions, tiers);
  assert.deepEqual(settings.modelOptions.find((item) => item.id === 'gpt-desktop').serviceTiers, tiers);
  await f.send();
  assert.equal(f.state.sent[0].serviceTier, '');
  settings = (await f.request('/settings', { serviceTier: 'standard' })).settings;
  assert.equal(settings.serviceTier, 'default');
  assert.equal(settings.effectiveServiceTier, 'default');
  assert.equal(settings.serviceTierSource, 'session');
  await f.request('/settings', { reasoningEffort: 'xhigh' });
  await f.send();
  assert.equal(f.state.sent[1].serviceTier, 'default');
  assert.equal((await new SessionSettingsStore({ filePath: f.filePath }).getSessionSettings(threadId)).serviceTier, 'default');
  settings = (await f.request('/settings', { serviceTier: null })).settings;
  assert.equal(settings.serviceTier, '');
  assert.equal(settings.effectiveServiceTier, 'priority');
  await f.send();
  assert.equal(f.state.sent[2].serviceTier, '');
});

test('official thread settings notifications reconcile only that target and preserve missing-field choices', async (t) => {
  const f = await fixture(t);
  f.state.defaults.serviceTier = 'priority';
  await f.request('/settings', { serviceTier: 'default' });
  // A global change is not authoritative thread-level adoption.
  f.state.defaults.serviceTier = 'default';
  assert.equal((await f.settings()).serviceTier, 'default');
  f.state.threadSettings = { serviceTier: null };
  let settings = await f.settings();
  assert.equal(settings.serviceTier, '');
  assert.equal(settings.effectiveServiceTier, 'default');
  assert.equal(settings.serviceTierSource, 'thread');
  await f.request('/settings', { serviceTier: 'priority' });
  assert.equal((await f.settings()).serviceTier, 'priority');
  f.state.threadSettings = { serviceTier: 'priority' };
  settings = await f.settings();
  assert.equal(settings.serviceTier, '');
  assert.equal(settings.effectiveServiceTier, 'priority');
  assert.equal(settings.serviceTierSource, 'thread');
  f.state.threadSettings = {};
  await f.request('/settings', { serviceTier: 'default' });
  assert.equal((await f.settings()).serviceTier, 'default');
  f.state.thread.id = 'unrelated-thread';
  f.state.threadSettings = { serviceTier: 'default' };
  assert.equal((await f.settings()).serviceTier, 'default');
});

test('queued outbox dispatch resolves the saved speed at dispatch time', async (t) => {
  const f = await fixture(t, {}, { outbox: true, nativeProvider: true });
  await f.request('/settings', { serviceTier: 'priority' });
  await f.send({ submissionId: 'tier-outbox' });
  await waitForSent(f.state, 1);
  assert.equal(f.state.sent[0].serviceTier, 'priority');
  await f.request('/settings', { serviceTier: '' });
  await f.send({ submissionId: 'tier-outbox-inherit' });
  await waitForSent(f.state, 2);
  assert.equal(f.state.sent[1].serviceTier, '');
});
