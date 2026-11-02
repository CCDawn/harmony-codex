import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const presentation = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SessionControlPresentation.ets', 'utf8')
  .replace(/^import .*$/mg, '').replace(/export /g, '');
const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
function method(name) {
  const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4);
}
let requests = [];
const context = vm.createContext({ util: { generateRandomUUID: () => '11111111-1111-4111-8111-111111111111' },
  BridgeClient: { continueSession(...args) { return new Promise((resolve, reject) => requests.push({ args, resolve, reject })); } } });
const methods = ['canContinueSelectedSession', 'continueSelectedSession', 'applySessionControlStatus',
  'claimNativeTurnCompletion', 'publishNativeTurnCompletion'];
vm.runInContext(stripTypeScriptTypes(`${presentation}\nclass Page {${methods.map(method).join('\n')}}\nglobalThis.Page=Page;
globalThis.kind=sessionCompletionKind;globalThis.label=sessionControlStateLabel;`), context);
const status = (state = 'interrupted', turnId = 'old') => ({ threadId: 'A', turnId, state,
  canContinue: ['interrupted', 'failed'].includes(state), reason: state });
function setup() {
  requests = [];
  const page = Object.assign(new context.Page(), { selectedSession: { id: 'A' }, selectedSessionControl: status(),
    isNewSessionDraft: false, companionSelected: false, runtimeDesktopConnected: true,
    runtimeConnectionState: 'open', selectedControlStreamHealthy: true, sessionContinueBusyId: '',
    sessionContinueUncertainIds: [], continueUncertainTurnIds: {}, continueStatusRequestSequence: 0,
    notifiedNativeTurnIds: [], message: '', sessionMessage: '', navigation: 1, token: 'one',
    normalizedBridgeUrl: () => 'https://one', bridgeToken: 'token', hasSessionDraftContent() { return !!this.sessionMessage; },
    readSessionNavigation() { return { revision: this.navigation }; },
    refreshContinueStatus: async () => {}, refreshSelectedSessionDetail: async () => {},
    isSessionCurrentlyRead: () => false, markSessionUnreadCompleted() {},
    published: [], async publishBasicCompletionNotification(...args) { this.published.push(args); }
  });
  return page;
}

test('play requires authoritative interrupted/retryable evidence, empty draft and both live channels', () => {
  const page = setup(); assert.equal(page.canContinueSelectedSession(), true);
  for (const state of ['idle', 'completed', 'unknown', 'active']) {
    page.selectedSessionControl = { ...status(state), canContinue: true }; assert.equal(page.canContinueSelectedSession(), false);
  }
  page.selectedSessionControl = status(); page.sessionMessage = 'retain draft'; assert.equal(page.canContinueSelectedSession(), false);
  page.sessionMessage = ''; page.runtimeDesktopConnected = false; assert.equal(page.canContinueSelectedSession(), false);
  page.runtimeDesktopConnected = true; page.selectedControlStreamHealthy = false; assert.equal(page.canContinueSelectedSession(), false);
});

test('double tapping play issues one empty native operation without a user message', async () => {
  const page = setup(); const first = page.continueSelectedSession(); const second = page.continueSelectedSession();
  assert.equal(requests.length, 1); assert.equal(requests[0].args[1], 'A'); assert.equal(requests[0].args.at(-1), 'old');
  assert.equal(page.sessionMessage, '');
  requests[0].resolve({ state: 'confirmed', turnId: 'new', active: true, reason: '' });
  await Promise.all([first, second]); assert.equal(page.selectedSessionControl.state, 'active');
});

test('a late continue response cannot clear another conversation draft or overwrite its state', async () => {
  const page = setup(); const pending = page.continueSelectedSession();
  page.selectedSession = { id: 'B' }; page.selectedSessionControl = { ...status('completed', 'b'), threadId: 'B' };
  page.sessionMessage = 'B draft'; page.navigation++; page.message = 'B hint';
  requests[0].resolve({ state: 'confirmed', turnId: 'new', active: true, reason: '' }); await pending;
  assert.equal(page.selectedSessionControl.threadId, 'B'); assert.equal(page.sessionMessage, 'B draft'); assert.equal(page.message, 'B hint');
});

test('uncertain writes are not retried after reconnect until a different native turn is observed', async () => {
  const page = setup(); const pending = page.continueSelectedSession(); requests[0].reject(Error('lost response')); await pending;
  assert.equal(page.canContinueSelectedSession(), false); await page.continueSelectedSession(); assert.equal(requests.length, 1);
  page.applySessionControlStatus(status('interrupted', 'old')); assert.equal(page.canContinueSelectedSession(), false);
  page.applySessionControlStatus(status('interrupted', 'new')); assert.equal(page.canContinueSelectedSession(), true);
});

test('idle and interrupted never become successful completion alerts; explicit failures retain their kind', () => {
  assert.equal(context.kind('idle'), ''); assert.equal(context.kind('interrupted'), '');
  assert.equal(context.kind('failed'), 'failed'); assert.equal(context.kind('completed'), 'completed');
  assert.equal(context.label('waiting_input'), '等待回答'); assert.equal(context.label('unknown'), '状态待同步');
});

test('official desktop completion alerts have a stable turn identity across duplicate lifecycle frames', async () => {
  const page = setup(); await page.publishNativeTurnCompletion(status('completed', 't'));
  await page.publishNativeTurnCompletion(status('completed', 't'));
  await page.publishNativeTurnCompletion(status('interrupted', 'stop'));
  await page.publishNativeTurnCompletion(status('failed', 'failure'));
  assert.equal(page.published.length, 2); assert.equal(page.published[0][2], false); assert.equal(page.published[1][2], true);
});

test('an HTTP 409 native rejection remains rejected through the real phone transport and may recover on the same turn', async () => {
  const client = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets', 'utf8');
  const extract = name => {
    const start = client.search(new RegExp(`^  (?:private )?static (?:async )?${name}\\(`, 'm'));
    assert.ok(start >= 0, name); return client.slice(start, client.indexOf('\n  }', start) + 4);
  };
  let writes = 0;
  const c = vm.createContext({ util: { generateRandomUUID: () => '11111111-1111-4111-8111-111111111111' },
    TotpGenerator: { currentCode: async () => '' }, CredentialRuntime: { getRuntimeTotpSecret: () => '' },
    http: { RequestMethod: { POST: 'POST' }, createHttp: () => ({ destroy() {}, async request() {
      writes++; return { responseCode: 409, result: JSON.stringify({ operationId: '11111111-1111-4111-8111-111111111111',
        threadId: 'A', expectedTurnId: 'old', turnId: 'old', canContinue: false, active: false,
        state: 'rejected', reason: 'goal_present' }) };
    } }) } });
  vm.runInContext(stripTypeScriptTypes(`${presentation}\nclass BridgeClient {
    ${['request', 'requestOnce', 'continueSession'].map(extract).join('\n')}
    static isTransientBridgeError(){return false;}
  }\nclass Page {${methods.map(method).join('\n')}}\nglobalThis.Page=Page;`), c);
  const page = Object.assign(new c.Page(), setup());
  await page.continueSelectedSession(); assert.equal(writes, 1); assert.equal(page.sessionContinueUncertainIds.length, 0);
  page.applySessionControlStatus(status()); assert.equal(page.canContinueSelectedSession(), true);
});
