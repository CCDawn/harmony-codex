import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';
import { nativeContinueStatus } from '../src/nativeContinueEligibility.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const threadId = 'thread-1';
function fixture() {
  const calls = [], nativeWrites = [], family = {};
  let turn = { id: 'turn-1', status: 'interrupted', items: [{ text: 'PRIVATE_BODY' }] };
  let runtime = 'idle', goal = null, helper = true, disposed = false, followUpHook = () => {}, writeHook = null, liveTurn = null,
    conversationPresent = true, followUpPresent = true, goalError = null;
  const context = { writingBlocks: [{ turnId: 'old-turn', blockIds: ['block-1'] }],
    latestCollaborationMode: { mode: 'default' }, [Symbol.dispose]() { disposed = true; } };
  const manager = {
    getHostId() { return 'local'; },
    getConversation() { return conversationPresent ? { id: threadId, requests: [], turns: [], threadRuntimeStatus: { type: runtime },
      ...(liveTurn ? { turnHistory: { kind: 'canonical', history: {
        islands: [{ entries: [{ value: 'live' }] }], entitiesByKey: { live: liveTurn }
      } } } : {}) } : null; },
    async sendRequest(method, params) {
      calls.push({ method, params });
      assert.equal(params.threadId, threadId);
      if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: threadId, status: { type: runtime } } }; }
      if (method === 'thread/goal/get') { if (goalError) throw goalError; return { goal }; }
      if (method === 'thread/turns/list') { assert.equal(params.limit, 1); return { data: [turn] }; }
      assert.fail('Unexpected write or resume: ' + method);
    },
    async getFollowUpContext(id, writingBlocks) {
      assert.equal(id, threadId); assert.equal(writingBlocks, true); followUpHook(); return followUpPresent ? context : null;
    },
    async startEmptyTurn(id, options) {
      assert.equal(id, threadId); assert.equal(disposed, false, 'context must remain leased throughout the native write');
      nativeWrites.push(options);
      if (writeHook) return writeHook();
      turn = { id: 'turn-2', status: 'inProgress' }; runtime = 'active';
    }
  };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) manager[name] = () => assert.fail(name);
  let hostClient = { hostId: 'local', rpc: manager };
  const binding = { get: () => ({ status: 'ready', client: hostClient }) };
  const owner = { familyBindings: new Map([[family, new Map([['local', { value: binding }]])]]) };
  const window = { __codexRoot: { _internalRoot: { current: { tag: 10,
    memoizedProps: { value: new Map([['owner', owner]]) } } } } };
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] };
  const sources = {
    'index.js': 'import "./app-main-new.js";',
    'app-main-new.js': 'import "./renderer-app-server-managers-live.js";',
    'renderer-app-server-managers-live.js': 'import{host as hf}from"./app-initial-new.js";function publish(s,h,r){s.set(hf,h,{status:`ready`,client:{hostId:h,rpc:r}})}',
    'app-initial-new.js': '// codex-writing-block-deleted-thread-v1:\nfunction prepare(a,b,c){return b==null?c:blocks(a,b,v=>storage(v,void 0),c,!0)}export{hf as host,prepare as exportedContext};'
  };
  const transport = { hostId: 'local', async ensureConnected() {}, close() {},
    async evaluate(expression) {
      const run = new AsyncFunction('window', 'document', 'fetch', 'importModule', 'URL', 'crypto',
        'return ' + expression.replaceAll('await import(assetUrl)', 'await importModule(assetUrl)'));
      return run(window, document, async url => ({ text: async () => sources[new URL(url).pathname.split('/').at(-1)] ?? '' }),
        async () => ({ host: family, ...(helper ? { exportedContext(id, blocks, additional) {
          if (blocks === undefined) return additional;
          assert.equal(id, threadId); assert.equal(blocks, context.writingBlocks); assert.equal(additional, undefined);
          return { writing_block: 'prepared-native-context' };
        } } : {}) }), URL, { randomUUID });
    } };
  return { api: new DesktopInteractionClient(transport), nativeWrites, calls,
    get disposed() { return disposed; }, setRuntime(value) { runtime = value; }, setGoal(value) { goal = value; },
    setTurn(value) { turn = value; }, removeHelper() { helper = false; },
    setLiveTurn(value) { liveTurn = value; },
    setGoalError(error) { goalError = error; },
    unloadConversation() { conversationPresent = false; followUpPresent = false; runtime = 'notLoaded'; },
    onFollowUp(hook) { followUpHook = hook; }, onWrite(hook) { writeHook = hook; },
    replaceLease() { hostClient = { hostId: 'local', rpc: manager }; }
  };
}

test('read-only native snapshot verifies official goal/runtime/latest turn without resuming and strips bodies', async () => {
  const h = fixture(); h.setRuntime('notLoaded');
  const result = await h.api.readContinueSnapshot(threadId);
  assert.equal(result.thread.status.type, 'notLoaded');
  assert.equal(result.thread.turns[0].id, 'turn-1');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY/);
  assert.equal(h.nativeWrites.length, 0);
  assert.equal(h.calls.length, 3);
});

test('an unopened existing thread with no cached conversation can be observed without resume and uses native empty continue', async () => {
  const h = fixture(); h.unloadConversation();
  const observed = await h.api.readContinueSnapshot(threadId);
  assert.equal(observed.thread.status.type, 'notLoaded');
  assert.equal(observed.thread.latestTurn, null);
  assert.equal(observed.thread.turns[0].id, 'turn-1');
  assert.equal(h.nativeWrites.length, 0, 'status read must not resume or start the conversation');
  const result = await h.api.continueTurn(threadId, 'turn-1', randomUUID());
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(h.nativeWrites, [{ turnTrigger: 'resume_interrupted_task', collaborationMode: null,
    writingBlockContextPrepared: false, additionalContext: undefined }]);
});

test('notLoaded goal endpoint thread-not-found preserves known turn status without inventing goal absence or writing', async () => {
  for (const status of ['completed', 'interrupted']) {
    const h = fixture(); h.unloadConversation();
    h.setTurn({ id: 'turn-1', status, startedAt: 1000 });
    h.setGoalError(new Error('thread not found: ' + threadId));
    const context = await h.api.readContinueContext(threadId);
    assert.equal(context.status.type, 'notLoaded');
    assert.equal(Object.hasOwn(context, 'goal'), false);
    const snapshot = await h.api.readContinueSnapshot(threadId);
    assert.deepEqual(nativeContinueStatus(snapshot, threadId), {
      threadId, turnId: 'turn-1', state: status, canContinue: false, reason: 'unavailable'
    });
    assert.equal(Object.hasOwn(snapshot.thread, 'goal'), false);
    const continued = await h.api.continueTurn(threadId, 'turn-1', randomUUID());
    assert.equal(continued.state, 'rejected'); assert.equal(continued.reason, 'unavailable');
    assert.equal(h.nativeWrites.length, 0);
  }
});

test('goal errors on loaded runtime and unrelated errors on notLoaded still fail closed', async () => {
  for (const [runtime, message] of [['idle', 'thread not found: ' + threadId],
    ['notLoaded', 'thread not found: other-thread'], ['notLoaded', 'goal temporarily unavailable']]) {
    const h = fixture(); h.setRuntime(runtime); h.setGoalError(new Error(message));
    await assert.rejects(h.api.readContinueSnapshot(threadId), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'renderer' });
    await assert.rejects(h.api.continueTurn(threadId, 'turn-1', randomUUID()), { continueWriteAttempted: false });
    assert.equal(h.nativeWrites.length, 0);
  }
});

test('an interrupted live canonical turn wins a persisted latest page that still ends at an older completed turn', async () => {
  const h = fixture();
  h.setTurn({ id: 'persisted-old', status: 'completed', startedAt: 1793526701, items: [{ text: 'PRIVATE_OLD' }] });
  h.setLiveTurn({ turnId: 'fixture-new', status: 'interrupted', turnStartedAtMs: 1793551290288,
    items: [{ text: 'PRIVATE_LIVE' }] });
  const result = await h.api.readContinueSnapshot(threadId);
  assert.equal(result.thread.turns[0].id, 'fixture-new');
  assert.equal(result.thread.turns[0].status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(h.nativeWrites.length, 0);
  assert.equal(h.calls.length, 3, 'live metadata reuses the existing lease read without another history request');
});

test('a stale loaded live turn cannot replace a newer persisted turn, and ambiguous ordering fails closed', async () => {
  const h = fixture();
  h.setTurn({ id: 'persisted-new', status: 'completed', startedAt: 2000 });
  h.setLiveTurn({ turnId: 'loaded-old', status: 'interrupted', turnStartedAtMs: 1000000 });
  assert.equal((await h.api.readContinueSnapshot(threadId)).thread.turns[0].id, 'persisted-new');
  h.setTurn({ id: 'persisted-new', status: 'completed' });
  const ambiguous = await h.api.continueTurn(threadId, 'loaded-old', randomUUID());
  assert.equal(ambiguous.state, 'rejected');
  assert.equal(h.nativeWrites.length, 0);
});

test('native continue uses getFollowUpContext(true), native writing context and startEmptyTurn with no input text', async () => {
  const h = fixture();
  const result = await h.api.continueTurn(threadId, 'turn-1', randomUUID());
  assert.equal(result.state, 'confirmed'); assert.equal(result.turnId, 'turn-2'); assert.equal(result.active, true);
  assert.deepEqual(h.nativeWrites, [{ turnTrigger: 'resume_interrupted_task',
    collaborationMode: { mode: 'default' }, writingBlockContextPrepared: true,
    additionalContext: { writing_block: 'prepared-native-context' } }]);
  assert.equal(h.disposed, true);
});

test('renderer refuses stale turns, active runtime and goals before any native write', async () => {
  for (const mutate of [h => h.setTurn({ id: 'new-turn', status: 'interrupted' }),
    h => h.setRuntime('active'), h => h.setGoal({ status: 'active' }), h => h.setTurn({ id: 'turn-1', status: 'completed' })]) {
    const h = fixture(); mutate(h);
    assert.equal((await h.api.continueTurn(threadId, 'turn-1', randomUUID())).state, 'rejected');
    assert.equal(h.nativeWrites.length, 0);
  }
});

test('canonical state and lease are revalidated after asynchronous follow-up preparation', async () => {
  const stale = fixture(); stale.onFollowUp(() => stale.setTurn({ id: 'other-turn', status: 'interrupted' }));
  assert.equal((await stale.api.continueTurn(threadId, 'turn-1', randomUUID())).reason, 'stale_turn');
  assert.equal(stale.nativeWrites.length, 0);
  const active = fixture(); active.onFollowUp(() => active.setRuntime('active'));
  assert.equal((await active.api.continueTurn(threadId, 'turn-1', randomUUID())).reason, 'active');
  assert.equal(active.nativeWrites.length, 0);
  const replaced = fixture(); replaced.onFollowUp(() => replaced.replaceLease());
  await assert.rejects(replaced.api.continueTurn(threadId, 'turn-1', randomUUID()), { continueWriteAttempted: false });
  assert.equal(replaced.nativeWrites.length, 0);
});

test('missing discovered writing helper fails closed without writing', async () => {
  const h = fixture(); h.removeHelper();
  await assert.rejects(h.api.continueTurn(threadId, 'turn-1', randomUUID()), {
    code: 'NATIVE_CONTINUE_UNAVAILABLE', continueWriteAttempted: false
  });
  assert.equal(h.nativeWrites.length, 0);
});

test('native exception after dispatch remains uncertain; an unchanged void result cannot confirm a new turn', async () => {
  const broken = fixture(); broken.onWrite(() => { throw Error('PRIVATE_WRITE_FAILURE'); });
  await assert.rejects(broken.api.continueTurn(threadId, 'turn-1', randomUUID()), {
    continueWriteAttempted: true, message: 'DESKTOP_INTERACTIONS_UNAVAILABLE'
  });
  assert.equal(broken.nativeWrites.length, 1); assert.equal(broken.disposed, true);
  const silent = fixture(); silent.onWrite(() => {});
  assert.equal((await silent.api.continueTurn(threadId, 'turn-1', randomUUID())).state, 'uncertain');
  assert.equal(silent.nativeWrites.length, 1);
});
