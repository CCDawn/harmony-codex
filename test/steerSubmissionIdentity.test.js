import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/taskStore.js';

function setup(steer) {
  const store = new TaskStore({ projects: [{ id: 'project', root: '.' }],
    adapter: { run: async () => await new Promise(() => {}), steer }, eventBus: { publish() {} } });
  const original = store.createTask({ projectId: 'project', codexSessionId: 'thread', prompt: 'initial', submissionId: 'original' });
  return { store, original };
}
const body = (prompt = 'follow up') => ({ prompt, submissionId: 'submission' });
const createBody = prompt => ({ projectId: 'project', codexSessionId: 'thread', ...body(prompt) });

test('concurrent same identity and text share one send; createTask cannot create another turn', async () => {
  const gate = Promise.withResolvers(); let writes = 0;
  const { store, original } = setup(async () => { writes++; await gate.promise; return { turnId: 'turn' }; });
  const first = store.steerSessionTask('thread', body());
  const same = store.steerSessionTask('thread', body());
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(writes, 1);
    await assert.rejects(store.steerSessionTask('thread', body('different')), { statusCode: 409 });
    assert.throws(() => store.createTask(createBody('different')), { statusCode: 409 });
    assert.throws(() => store.createTask(createBody('follow up')), { statusCode: 409 });
  } finally { gate.resolve(); }
  assert.equal(await first, original); assert.equal(await same, original);
  assert.equal(await store.steerSessionTask('thread', body()), original);
  assert.equal(store.createTask(createBody('follow up')), original);
  assert.equal(writes, 1);
});

test('each prior submission keeps its own text even after a later steer changes the task prompt', async () => {
  let writes = 0;
  const { store } = setup(async () => { writes++; return {}; });
  await store.steerSessionTask('thread', body('one'));
  await store.steerSessionTask('thread', { prompt: 'two', submissionId: 'second' });
  await store.steerSessionTask('thread', body('one'));
  await assert.rejects(store.steerSessionTask('thread', body('two')), { statusCode: 409 });
  assert.throws(() => store.createTask(createBody('two')), { statusCode: 409 });
  assert.equal(writes, 2);
});

test('only explicit no-write failures permit retry; unknown outcomes stay blocked', async () => {
  for (const safe of [true, false]) {
    let writes = 0;
    const { store } = setup(async () => { writes++; if (writes === 1) throw Object.assign(new Error('failure'), safe ? { deliveryAttempted: false } : {}); return {}; });
    await assert.rejects(store.steerSessionTask('thread', body()));
    if (safe) {
      await assert.rejects(store.steerSessionTask('thread', body('different')), { statusCode: 409 });
      assert.throws(() => store.createTask(createBody('different')), { statusCode: 409 });
      await store.steerSessionTask('thread', body());
      assert.equal(writes, 2);
    } else {
      await assert.rejects(store.steerSessionTask('thread', body()), { deliveryUncertain: true });
      assert.throws(() => store.createTask(createBody('follow up')), { deliveryUncertain: true });
      assert.equal(writes, 1);
    }
  }
});

test('an uncertain error cannot inherit a fallback flag that would send again', async () => {
  let writes = 0;
  const { store } = setup(async () => { writes++; throw Object.assign(new Error('lost acknowledgement'), {
    safeToFallback: true, code: 'CODEX_STEER_NO_ACTIVE_TURN', deliveryUncertain: true
  }); });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(store.steerSessionTask('thread', body()), error => {
      assert.equal(error.deliveryUncertain, true);
      assert.equal(error.safeToFallback, undefined);
      assert.equal(error.code, 'CODEX_SUBMISSION_UNCERTAIN');
      return true;
    });
  }
  assert.equal(writes, 1);
});

test('a retry that cannot start still reserves the original submission content', async () => {
  const { store, original } = setup(async () => { throw Object.assign(new Error('not sent'), { deliveryAttempted: false }); });
  await assert.rejects(store.steerSessionTask('thread', body()));
  original.status = 'completed';
  await assert.rejects(store.steerSessionTask('thread', body()), { code: 'CODEX_STEER_NO_ACTIVE_TURN' });
  await assert.rejects(store.steerSessionTask('thread', body('different')), { statusCode: 409 });
});

test('a createTask submission retains its original text after steering changes its task', async () => {
  let writes = 0;
  const { store, original } = setup(async () => { writes++; return {}; });
  await store.steerSessionTask('thread', body('later'));
  assert.equal(store.createTask({ projectId: 'project', codexSessionId: 'thread', prompt: 'initial', submissionId: 'original' }), original);
  assert.throws(() => store.createTask({ projectId: 'project', codexSessionId: 'thread', prompt: 'later', submissionId: 'original' }), { statusCode: 409 });
  assert.equal(writes, 1);
});
