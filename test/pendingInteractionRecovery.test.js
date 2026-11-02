import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');

function methodBody(name) {
  const match = new RegExp(`^\\s*(?:private\\s+)?(?:async\\s+)?${name}\\s*\\(`, 'm').exec(source);
  assert.ok(match, `missing method ${name}`);
  const start = source.indexOf('{', match.index);
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++;
    if (source[cursor] === '}' && --depth === 0) return source.slice(start + 1, cursor);
  }
  assert.fail(`unterminated method ${name}`);
}

function state(api = {}) {
  const bridge = { listDesktopInteractions: async () => [], ...api };
  const value = {
    selectedSession: { id: 'thread-a', activityStatus: 'running' }, isNewSessionDraft: false,
    navigation: { revision: 1, mode: 'session', sessionId: 'thread-a' },
    desktopInteractions: [], desktopInteractionRefreshSeq: 0, desktopInteractionError: '', interactionSubmitError: '',
    bridgeToken: '', task: null, legacyInput: null, approvalId: '', logs: [],
    normalizedBridgeUrl: () => 'https://bridge', errorText: error => error.message,
    readSessionNavigation() { return { ...this.navigation }; },
    isSessionNavigationCurrent(revision, id) {
      return this.navigation.revision === revision && this.navigation.mode === 'session' && this.navigation.sessionId === id;
    },
    selectedVisibleTask() { return this.task; }, pendingUserInput() { return this.legacyInput; },
    pendingApprovalId() { return this.approvalId; }, log(...args) { this.logs.push(args); }
  };
  for (const name of ['desktopInteractionSessionId', 'visibleDesktopInteractions', 'hasKnownPendingInteractions',
    'isWaitingForPendingInteraction', 'shouldShowPendingInteractions', 'pendingInteractionNotice', 'refreshDesktopInteractions']) {
    if (!new RegExp(`^\\s*private\\s+(?:async\\s+)?${name}\\s*\\(`, 'm').test(source)) continue;
    const async = name === 'refreshDesktopInteractions';
    const code = stripTypeScriptTypes(`${async ? 'async ' : ''}function run() {${methodBody(name)}}`);
    value[name] = new Function('BridgeClient', `${code}; return run;`)(bridge);
  }
  // Exercise the original builder guard as the baseline, so RED demonstrates
  // the unwanted visible panel rather than merely the absence of new helpers.
  if (!value.shouldShowPendingInteractions) {
    const guard = methodBody('SessionPendingInteractions').match(/if \(([\s\S]*?)\) \{/)[1];
    value.shouldShowPendingInteractions = new Function(`return (${guard});`);
  }
  if (!value.pendingInteractionNotice) value.pendingInteractionNotice = function () {
    return this.interactionSubmitError || this.desktopInteractionError;
  };
  return value;
}

const unavailable = () => { throw new Error('bridge HTTP 503'); };
const request = { id: 'r', threadId: 'thread-a', status: 'pending', kind: 'approval' };

test('a background read failure alone keeps diagnostics without opening the input-area panel', async () => {
  const value = state({ listDesktopInteractions: unavailable });
  await value.refreshDesktopInteractions();
  assert.match(value.desktopInteractionError, /503/);
  assert.equal(value.shouldShowPendingInteractions(), false);
  assert.equal(value.pendingInteractionNotice(), '');
  assert.equal(value.logs.length, 1);
  await value.refreshDesktopInteractions();
  assert.equal(value.logs.length, 1, 'repeated polling should not flood diagnostics');
});

test('current desktop requests, legacy questions and approvals stay visible during read failure', async () => {
  for (const mode of ['desktop', 'question', 'approval']) {
    const value = state({ listDesktopInteractions: unavailable });
    if (mode === 'desktop') value.desktopInteractions = [request];
    if (mode === 'question') value.legacyInput = { id: 'legacy' };
    if (mode === 'approval') value.approvalId = 'approval';
    await value.refreshDesktopInteractions();
    assert.equal(value.hasKnownPendingInteractions(), true, mode);
    assert.equal(value.shouldShowPendingInteractions(), true, mode);
    assert.ok(value.pendingInteractionNotice().length > 0, mode);
  }
});

test('an explicit waiting task or selected-session state exposes recovery even without a fetched request', async () => {
  for (const status of ['waiting_approval', 'waiting_input']) {
    for (const context of ['task', 'session']) {
      const value = state({ listDesktopInteractions: unavailable });
      if (context === 'task') value.task = { status };
      else value.selectedSession.activityStatus = status;
      assert.equal(value.shouldShowPendingInteractions(), true);
      assert.ok(value.pendingInteractionNotice().length > 0);
      await value.refreshDesktopInteractions();
      assert.equal(value.shouldShowPendingInteractions(), true);
      assert.ok(value.pendingInteractionNotice().length > 0);
    }
  }
});

test('a submission failure stays visible and takes precedence over a background read error', async () => {
  const value = state({ listDesktopInteractions: unavailable });
  value.interactionSubmitError = '审批提交失败：桌面没有确认结果';
  await value.refreshDesktopInteractions();
  assert.equal(value.shouldShowPendingInteractions(), true);
  assert.equal(value.pendingInteractionNotice(), value.interactionSubmitError);
});

test('a recovered list clears the read error without clearing submission errors or requests', async () => {
  let fail = true;
  const value = state({ listDesktopInteractions: async () => fail ? unavailable() : [request] });
  value.interactionSubmitError = 'submission failed';
  await value.refreshDesktopInteractions();
  fail = false;
  await value.refreshDesktopInteractions();
  assert.equal(value.desktopInteractionError, '');
  assert.equal(value.interactionSubmitError, 'submission failed');
  assert.deepEqual(value.visibleDesktopInteractions(), [request]);
});

test('foreign or settled requests and inactive-session waiting markers cannot create the panel', () => {
  const value = state();
  value.desktopInteractionError = 'background read failed';
  value.desktopInteractions = [{ ...request, threadId: 'thread-b' }, { ...request, status: 'resolved' }];
  assert.equal(value.shouldShowPendingInteractions(), false);
  value.selectedSession.activityStatus = 'waiting_input';
  value.navigation.sessionId = 'thread-b';
  assert.equal(value.isWaitingForPendingInteraction(), false);
  assert.equal(value.shouldShowPendingInteractions(), false);
});

test('the panel uses the visibility rule and a compact retry while retaining both request forms', () => {
  const body = methodBody('SessionPendingInteractions');
  assert.match(body, /if \(this\.shouldShowPendingInteractionFooter\(\)\)/);
  assert.match(body, /SessionDesktopInteractionView\(/);
  assert.match(methodBody('SessionDesktopInteractionView'), /SessionInteractionPanel\(/);
  assert.match(body, /this\.UserInputForm\(\)/);
  assert.match(body, /this\.pendingApprovalId\(\)/);
  assert.match(body, /Button\('重试'\)\.height\(32\)/);
  assert.doesNotMatch(body, /Button\('刷新待处理请求'\)/);
});
