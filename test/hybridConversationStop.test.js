import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridCodexAdapter } from '../src/hybridCodexAdapter.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { readRecentDesktopThread } from '../src/desktopRecentThread.js';
import { TaskStore } from '../src/taskStore.js';

test('current-conversation stop survives temporary empty metadata after native turn/start', async () => {
  const requests = [];
  const journal = new Map();
  let reads = 0;
  let stopped = false;
  const client = {
    readRecentThread(threadId, options) { return readRecentDesktopThread(this, threadId, options); },
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/read') {
        if (++reads === 1) throw new Error('failed to read session metadata: rollout is empty');
        return { thread: { id: 'selected-thread' } };
      }
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'active-turn', status: stopped ? 'interrupted' : 'inProgress' }] };
      }
      if (method === 'turn/interrupt') {
        assert.deepEqual(params, { threadId: 'selected-thread', turnId: 'active-turn' });
        assert.equal([...journal.values()][0]?.state, 'writing');
        stopped = true;
        return {};
      }
      throw new Error(`send preflight must not run while stopping: ${method}`);
    }
  };
  const cdp = new CodexDesktopCdpAdapter({ client, interruptTurnLookupIntervalMs: 100 });
  cdp.getCurrentConversationId = async () => { throw new Error('visible conversation is unrelated'); };
  const adapter = new HybridCodexAdapter({
    cdpDesktopAdapter: cdp,
    scriptDesktopAdapter: { async interrupt() { throw new Error('stop must not switch owners'); } }
  });
  const store = new TaskStore({
    projects: [{ id: 'p', root: '.' }], adapter, eventBus: { publish() {} },
    interruptJournal: {
      async load() { return []; },
      async put(record) { journal.set(record.operationId, record); },
      async remove(id) { journal.delete(id); }
    }
  });
  try {
    const operation = store.interruptSessionTask('selected-thread');
    const deadline = Date.now() + 2000;
    while (operation.interruptDispatching && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(operation.status, 'interrupted');
    assert.equal(operation.activeCodexTurnId, 'active-turn');
    assert.equal(requests.filter(request => request.method === 'turn/interrupt').length, 1);
    assert.equal(journal.size, 0);
  } finally {
    store.close();
  }
});

test('stop passes pending start identity and journal callbacks to the official desktop owner', async () => {
  const context = {
    task: { codexSessionId: 'selected-thread' }, interruptScope: 'thread', pendingTaskId: 'pending-start',
    beforeInterruptWrite() {}, onPendingStartResolved() {}, emit() {}
  };
  let calls = 0;
  const adapter = new HybridCodexAdapter({
    cdpDesktopAdapter: { async interrupt(received) { calls += 1; assert.equal(received, context); return 'stopped'; } },
    scriptDesktopAdapter: { async interrupt() { throw new Error('wrong owner'); } }
  });
  adapter.desktopAdapter = adapter.scriptDesktopAdapter;
  assert.equal(await adapter.interrupt(context), 'stopped');
  assert.equal(calls, 1);
});

test('an in-flight script start keeps its acknowledgement owner during conversation stop', async () => {
  const writes = [];
  const script = new CodexDesktopCdpAdapter({ client: {
    async request(method, params) {
      assert.equal(method, 'turn/interrupt');
      writes.push(params);
      return {};
    }
  } });
  script.pendingTurnStarts.set('script-start', Promise.resolve('ack-turn'));
  script.pendingTurnThreadIds.set('script-start', 'selected-thread');
  script.readRecentThread = async () => ({ thread: { id: 'selected-thread', turns: [] } });
  script.waitForTurnTerminalAfterInterrupt = async () => ({ id: 'ack-turn', status: 'interrupted' });
  const adapter = new HybridCodexAdapter({ scriptDesktopAdapter: script,
    cdpDesktopAdapter: { async interrupt() { throw new Error('pending start belongs to the script transport'); } } });
  let acknowledged = false;
  const result = await adapter.interrupt({ task: { id: 'stop', codexSessionId: 'selected-thread' },
    interruptScope: 'thread', pendingTaskId: 'script-start', emit() {},
    async onPendingStartResolved({ threadId, turnId }) {
      acknowledged = threadId === 'selected-thread' && turnId === 'ack-turn';
    },
    async beforeInterruptWrite() { assert.equal(acknowledged, true); }
  });
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(writes, [{ threadId: 'selected-thread', turnId: 'ack-turn' }]);
});
