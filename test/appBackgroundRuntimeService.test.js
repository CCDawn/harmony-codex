import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

function verifyNativeDataTransferRequest(request) {
  // API 24 enum values; the native mode/submode correspondence only permits
  // MODE_DATA_TRANSFER (1) with SUBMODE_LIVE_VIEW_NOTIFICATION (3).
  // https://github.com/openharmony/resourceschedule_background_task_mgr/blob/master/interfaces/innerkits/src/background_task_mode.cpp
  const modes = Array.from(request.backgroundTaskModes ?? []);
  const submodes = Array.from(request.backgroundTaskSubmodes ?? []);
  if (modes.length !== 1 || modes[0] !== 1 || submodes.length !== 1 || submodes[0] !== 3) {
    throw Object.assign(new Error('Continuous Task verification failed. The sequence of backgroundTaskModes does not match the backgroundTaskSubmodes.'),
      { code: 9800005 });
  }
}

function harness(options = {}) {
  const requests = [], listeners = new Set(), storage = new Map([['codexRemoteAppForeground', true]]);
  let tasks = [], queryCount = 0;
  class ContinuousTaskRequest { isModeSupported() { return options.supported !== false; } }
  const manager = {
    ContinuousTaskRequest,
    BackgroundTaskMode: { MODE_DATA_TRANSFER: 1 },
    BackgroundTaskSubmode: { SUBMODE_NORMAL_NOTIFICATION: 2, SUBMODE_LIVE_VIEW_NOTIFICATION: 3 },
    on(type, listener) { assert.equal(type, 'continuousTaskCancel'); listeners.add(listener); },
    off(type, listener) { listeners.delete(listener); },
    async getAllContinuousTasks(context, includeSuspended) {
      assert.equal(includeSuspended, true);
      queryCount++;
      if (options.query) return options.query({ tasks, queryCount });
      return tasks.map(item => ({ ...item, backgroundModes: [...item.backgroundModes] }));
    },
    async startBackgroundRunning(context, request) {
      requests.push(request);
      verifyNativeDataTransferRequest(request);
      const id = options.start ? await options.start({ emit, request, requests }) : 100 + requests.length;
      if (options.addOnStart !== false) tasks.push({ abilityName: 'EntryAbility', bundleName: 'com.codex.remote.app',
        continuousTaskId: id, suspendState: false, backgroundModes: ['dataTransfer'] });
      return { continuousTaskId: id };
    }
  };
  const AppStorage = { get(key) { return storage.get(key); }, setOrCreate(key, value) { storage.set(key, value); } };
  const wantAgent = { OperationType: { START_ABILITY: 1 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 1 },
    getWantAgent: async () => ({}) };
  const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/AppBackgroundRuntimeService.ets', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export class', 'class').replace('export interface', 'interface');
  const context = vm.createContext({ backgroundTaskManager: manager, AppStorage, wantAgent });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) + '\nglobalThis.service=AppBackgroundRuntimeService;', context);
  function emit(info) { for (const listener of [...listeners]) listener(info); }
  return { service: context.service, requests, storage, listeners, emit,
    task: () => tasks[0], addTask: task => tasks.push(task), clearTasks: () => { tasks = []; },
    get queries() { return queryCount; } };
}

test('API 24 rejects normal notification for data transfer and accepts the service request', async () => {
  assert.throws(() => verifyNativeDataTransferRequest({ backgroundTaskModes: [1], backgroundTaskSubmodes: [2] }),
    { code: 9800005, message: /The sequence of backgroundTaskModes does not match the backgroundTaskSubmodes/ });
  const h = harness();
  const state = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(state.running, true);
  assert.equal(state.mode, 'dataTransfer');
  assert.equal(h.requests.length, 1);
});

test('concurrent ensure shares query and allocates only one verified data-transfer task', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 8 }, () => h.service.ensureRunning({}, 'ability_foreground')));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Array.from(h.requests[0].backgroundTaskModes), [1]);
  assert.deepEqual(Array.from(h.requests[0].backgroundTaskSubmodes), [3]);
  assert.ok(results.every(result => result.running));
  assert.equal(results[0].taskId, 101); assert.equal(results[0].mode, 'dataTransfer');
  assert.equal(results[0].suspended, false);
  assert.equal(h.queries, 2);
  assert.equal(h.storage.get('codexRemoteBackgroundRuntimeState'), 'running');
  await h.service.ensureRunning({}, 'ability_background');
  assert.equal(h.requests.length, 1);
  assert.equal(h.queries, 3);
});

test('only owned cancellation changes state and it never auto-restarts in background', async () => {
  const h = harness(); await h.service.ensureRunning({}, 'ability_foreground');
  h.emit({ id: 801, reason: 1 });
  assert.equal(h.service.snapshot().running, true);
  h.clearTasks(); h.emit({ id: 101, reason: 1 });
  assert.equal(h.service.snapshot().running, false);
  assert.equal(h.storage.get('codexRemoteBackgroundRuntimeState'), 'stopped');
  h.storage.set('codexRemoteAppForeground', false);
  assert.equal((await h.service.ensureRunning({}, 'ability_background')).running, false);
  assert.equal(h.requests.length, 1);
  h.storage.set('codexRemoteAppForeground', true);
  assert.equal((await h.service.ensureRunning({}, 'index_relay')).running, false);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.service.ensureRunning({}, 'ability_foreground')).running, true);
  assert.equal(h.requests.length, 2);
});

test('cancellation during pending start is matched to returned id and never reports running', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ addOnStart: false, start: async () => await gate });
  const operation = h.service.ensureRunning({}, 'ability_foreground');
  while (h.requests.length === 0) await Promise.resolve();
  h.emit({ id: 801, reason: 1 });
  h.emit({ id: 222, reason: 1 });
  finish(222);
  const result = await operation;
  assert.equal(result.running, false);
  assert.equal(result.detail, 'continuous_task_cancelled');
  assert.equal(h.storage.get('codexRemoteBackgroundRuntimeState'), 'stopped');
  assert.equal(h.requests.length, 1);
});

test('a missing cached task is never treated as active and only a new foreground event may recreate it', async () => {
  const h = harness(); await h.service.ensureRunning({}, 'ability_foreground');
  h.clearTasks();
  assert.equal((await h.service.ensureRunning({}, 'index_relay')).running, false);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.service.ensureRunning({}, 'ability_foreground')).running, true);
  assert.equal(h.requests.length, 2);
});

test('a suspended task is reported stopped without creating a duplicate', async () => {
  const h = harness(); await h.service.ensureRunning({}, 'ability_foreground');
  h.task().suspendState = true;
  const suspended = await h.service.ensureRunning({}, 'ability_background');
  assert.equal(suspended.running, false); assert.equal(suspended.detail, 'continuous_task_suspended');
  assert.equal(suspended.taskId, 101); assert.equal(suspended.mode, 'dataTransfer');
  assert.equal(suspended.suspended, true);
  assert.equal(h.requests.length, 1);
  h.task().suspendState = false;
  assert.equal((await h.service.ensureRunning({}, 'ability_foreground')).running, true);
  assert.equal(h.requests.length, 1);
});

test('failed system query never reports cached running and never starts another task', async () => {
  let fail = false;
  const h = harness({ query: ({ tasks }) => { if (fail) throw new Error('query failed'); return tasks; } });
  await h.service.ensureRunning({}, 'ability_foreground'); fail = true;
  await assert.rejects(h.service.ensureRunning({}, 'ability_background'), /query failed/);
  assert.equal(h.service.snapshot().running, false); assert.equal(h.requests.length, 1);
  assert.equal(h.service.snapshot().taskId, 101); assert.equal(h.service.snapshot().mode, '');
  assert.equal(h.service.snapshot().suspended, null);
  fail = false; assert.equal((await h.service.ensureRunning({}, 'ability_foreground')).running, true);
  assert.equal(h.requests.length, 1);
});

test('unconfirmed initial allocation retains ownership rather than duplicating it', async () => {
  const h = harness({ addOnStart: false });
  const result = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(result.running, false); assert.equal(result.detail, 'continuous_task_unconfirmed');
  h.storage.set('codexRemoteAppForeground', false);
  await h.service.ensureRunning({}, 'ability_background');
  assert.equal(h.requests.length, 1);
});

test('unsupported mode is surfaced without allocating any task', async () => {
  const h = harness({ supported: false });
  await assert.rejects(h.service.ensureRunning({}, 'ability_foreground'), /data_transfer_unsupported/);
  assert.equal(h.requests.length, 0); assert.equal(h.service.snapshot().running, false);
});


test('cancellation during a system query wins over a stale active response', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ query: async ({ tasks, queryCount }) => {
    const snapshot = tasks.map(task => ({ ...task }));
    if (queryCount === 3) await gate;
    return snapshot;
  } });
  await h.service.ensureRunning({}, 'ability_foreground');
  const pending = h.service.ensureRunning({}, 'ability_background');
  while (h.queries < 3) await Promise.resolve();
  h.clearTasks(); h.emit({ id: 101, reason: 1 }); finish();
  assert.equal((await pending).running, false);
  assert.equal(h.service.snapshot().detail, 'continuous_task_cancelled');
});

test('foreground transition concurrent with a background query can restore a cancelled task', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ query: async ({ tasks, queryCount }) => {
    if (queryCount === 3) await gate;
    return tasks;
  } });
  await h.service.ensureRunning({}, 'ability_foreground');
  h.clearTasks(); h.emit({ id: 101, reason: 1 });
  h.storage.set('codexRemoteAppForeground', false);
  const background = h.service.ensureRunning({}, 'ability_background');
  while (h.queries < 3) await Promise.resolve();
  h.storage.set('codexRemoteAppForeground', true);
  const foreground = h.service.ensureRunning({}, 'ability_foreground');
  finish();
  const [a, b] = await Promise.all([background, foreground]);
  assert.equal(a.running, true); assert.equal(b.running, true); assert.equal(h.requests.length, 2);
});

test('foreground recovery is retained when cancellation invalidates an in-flight background query', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ query: async ({ tasks, queryCount }) => {
    const snapshot = tasks.map(task => ({ ...task }));
    if (queryCount === 3) await gate;
    return snapshot;
  } });
  await h.service.ensureRunning({}, 'ability_foreground');
  h.storage.set('codexRemoteAppForeground', false);
  const background = h.service.ensureRunning({}, 'ability_background');
  while (h.queries < 3) await Promise.resolve();
  h.clearTasks(); h.emit({ id: 101, reason: 1 });
  h.storage.set('codexRemoteAppForeground', true);
  const foreground = h.service.ensureRunning({}, 'ability_foreground');
  finish();
  const results = await Promise.all([background, foreground]);
  assert.ok(results.every(result => result.running));
  assert.equal(h.requests.length, 2);
  assert.equal(h.service.snapshot().taskId, 102);
});

test('a cancellation before task-id delivery retains its original foreground epoch', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ start: async ({ requests }) => requests.length === 1 ? await gate : 222,
    query: ({ tasks }) => tasks.filter(task => task.continuousTaskId !== 111) });
  const first = h.service.ensureRunning({}, 'ability_foreground');
  while (h.requests.length === 0) await Promise.resolve();
  h.storage.set('codexRemoteAppForeground', false);
  h.emit({ id: 111, reason: 1 });
  h.storage.set('codexRemoteAppForeground', true);
  const foreground = h.service.ensureRunning({}, 'ability_foreground');
  // Simulate the cancelled native allocation: it never appears in task queries.
  h.clearTasks();
  finish(111);
  await Promise.all([first, foreground]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.service.snapshot().running, true);
  assert.equal(h.service.snapshot().taskId, 222);
});

test('a separate voice task does not prevent or replace the owned data-transfer task', async () => {
  const h = harness();
  h.addTask({ abilityName: 'EntryAbility', bundleName: 'com.codex.remote.app', continuousTaskId: 801,
    backgroundModes: ['avPlaybackAndRecord'], suspendState: false });
  assert.equal((await h.service.ensureRunning({}, 'ability_foreground')).running, true);
  assert.equal(h.requests.length, 1); h.emit({ id: 801, reason: 1 });
  assert.equal(h.service.snapshot().running, true);
});

test('an unowned matching task is never adopted or duplicated', async () => {
  const h = harness();
  h.addTask({ abilityName: 'EntryAbility', bundleName: 'com.codex.remote.app', continuousTaskId: 901,
    backgroundModes: ['dataTransfer'], suspendState: false });
  const state = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(state.running, false); assert.equal(state.detail, 'unowned_continuous_task');
  assert.equal(h.requests.length, 0);
});


test('unrecognized metadata for the owned id remains unconfirmed without allocating another task', async () => {
  const h = harness(); await h.service.ensureRunning({}, 'ability_foreground');
  h.task().backgroundModes = ['MODE_DATA_TRANSFER'];
  const result = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(result.running, false); assert.equal(result.taskId, 101);
  assert.equal(result.mode, ''); assert.equal(result.suspended, null);
  assert.equal(result.detail, 'continuous_task_identity_unconfirmed');
  assert.equal(h.requests.length, 1);
});


test('an unconfirmed allocation never creates another task during the same foreground epoch', async () => {
  const h = harness({ addOnStart: false });
  const first = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(first.running, false); assert.equal(first.detail, 'continuous_task_unconfirmed');
  const second = await h.service.ensureRunning({}, 'index_relay');
  assert.equal(second.running, false); assert.equal(h.requests.length, 1);
  const afterForeground = await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(afterForeground.running, false); assert.equal(h.requests.length, 2);
});

test('an allocation remains single during the same foreground epoch after a failed verification query', async () => {
  let failVerification = true;
  const h = harness({ addOnStart: false, query: ({ tasks, queryCount }) => {
    if (queryCount === 2 && failVerification) throw new Error('verification failed');
    return tasks;
  } });
  await assert.rejects(h.service.ensureRunning({}, 'ability_foreground'), /verification failed/);
  assert.equal(h.service.snapshot().taskId, 101);
  failVerification = false;
  assert.equal((await h.service.ensureRunning({}, 'index_relay')).running, false);
  assert.equal(h.requests.length, 1);
  await h.service.ensureRunning({}, 'ability_foreground');
  assert.equal(h.requests.length, 2);
});
