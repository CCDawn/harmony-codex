import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/taskStore.js';

async function failure({ written = false, replaceIntent = false } = {}) {
  const gate = Promise.withResolvers();
  const store = new TaskStore({ projects: [{ id: 'project', root: '.' }], eventBus: { publish() {} },
    adapter: { run: async () => await new Promise(() => {}), steer: async () => ({}),
      async interrupt({ beforeInterruptWrite }) {
        if (written) await beforeInterruptWrite({ threadId: 'thread', turnId: 'turn' });
        await gate.promise;
        throw new Error('failure');
      } } });
  const task = store.createTask({ projectId: 'project', codexSessionId: 'thread', prompt: 'running' });
  const stop = store.interruptSessionTask('thread');
  await new Promise(resolve => setTimeout(resolve, 10));
  if (replaceIntent) task.stopIntentOperationId = 'newer-operation';
  gate.resolve();
  for (let i = 0; i < 100 && stop.interruptDispatching; i++) await new Promise(resolve => setTimeout(resolve, 2));
  return { store, task, stop };
}

test('definite failure before interrupt write releases only that stop intent', async () => {
  const h = await failure();
  try {
    assert.equal(h.stop.status, 'failed');
    assert.equal(h.task.stopIntentOperationId, undefined);
    assert.equal(h.store.findRunningTaskForSession('thread'), h.task);
    assert.equal(h.store.canSteerSessionTask('thread'), true);
  } finally { h.store.close(); }
});

test('uncertain interrupt or a newer stop operation keeps the barrier', async () => {
  for (const option of [{ written: true }, { replaceIntent: true }]) {
    const h = await failure(option);
    try {
      assert.ok(h.task.stopIntentOperationId);
      if (option.replaceIntent) assert.equal(h.task.stopIntentOperationId, 'newer-operation');
      assert.equal(h.store.findRunningTaskForSession('thread'), null);
    } finally { h.store.close(); }
  }
});
