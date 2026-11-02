import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexAppServerAdapter } from '../src/codexAppServerAdapter.js';

test('CodexAppServerAdapter starts a desktop-protocol thread and turn for new sessions', async () => {
  const client = new FakeAppServerClient();
  const adapter = new CodexAppServerAdapter({
    client,
    sandbox: 'workspace-write',
    approvalPolicy: 'never'
  });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-new',
      prompt: '你好',
      model: 'gpt-alt',
      codexSessionId: null
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-app-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '你好，我已开始处理。' }]
      }
    }
  });
  const result = await resultPromise;

  assert.equal(client.calls[0].method, 'thread/start');
  assert.equal(client.calls[0].params.cwd, 'C:\\work');
  assert.equal(client.calls[0].params.model, 'gpt-alt');
  assert.equal(client.calls[1].method, 'turn/start');
  assert.equal(client.calls[1].params.threadId, '019e-app-thread');
  assert.equal(client.calls[1].params.model, 'gpt-alt');
  assert.equal(client.calls[1].params.input[0].text, '你好');
  assert.equal(client.calls[2].method, 'thread/read');
  assert.equal(client.calls[2].params.includeTurns, true);
  assert.equal(result.summary, '你好，我已开始处理。');
  assert.equal(result.session.id, '019e-app-thread');
  assert.deepEqual(result.session.entries.map((entry) => `${entry.role}:${entry.text}`), [
    'user:你好',
    'assistant:你好，我已开始处理。'
  ]);
  assert.equal(result.desktopSync.desktopLive, false);
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.ready'));
  const threadStarted = events.find((event) => event.type === 'codex.app_server.thread.started');
  const threadRead = events.find((event) => event.type === 'codex.app_server.thread.read');
  assert.equal(threadStarted.payload.thread.turns, undefined);
  assert.equal(threadRead.payload.thread.turns, undefined);
  assert.equal(threadRead.payload.thread.turnCount, 1);
});

test('CodexAppServerAdapter resumes an existing desktop-protocol thread before sending a turn', async () => {
  const client = new FakeAppServerClient();
  const adapter = new CodexAppServerAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume',
      prompt: '继续',
      model: 'gpt-alt',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      turn: {
        id: 'turn-1',
        thread_id: '019e-existing-thread',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '继续完成。' }]
      }
    }
  });
  const result = await resultPromise;

  assert.equal(client.calls[0].method, 'thread/resume');
  assert.equal(client.calls[0].params.threadId, '019e-existing-thread');
  assert.equal(client.calls[0].params.cwd, null);
  assert.equal(client.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(client.calls[0].params.model, 'gpt-alt');
  assert.equal(client.calls[1].method, 'turn/start');
  assert.equal(client.calls[1].params.threadId, '019e-existing-thread');
  assert.equal(client.calls[1].params.model, 'gpt-alt');
  assert.deepEqual(client.calls[1].params.input, [{
    type: 'text',
    text: '继续',
    text_elements: []
  }]);
  assert.equal(client.calls[2].method, 'thread/read');
  assert.equal(result.summary, '继续完成。');
  const resumed = events.find((event) => event.type === 'codex.app_server.thread.resumed');
  const read = events.find((event) => event.type === 'codex.app_server.thread.read');
  assert.equal(resumed.payload.thread.turns, undefined);
  assert.equal(read.payload.thread.turns, undefined);
  assert.equal(read.payload.thread.turnCount, 1);
});

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.waiters = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    this.resolveWaiters(method);
    if (method === 'thread/start') {
      return {
        thread: {
          id: '019e-app-thread',
          sessionId: '019e-app-thread',
          cwd: params.cwd,
          status: { type: 'idle' }
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd,
          status: { type: 'idle' }
        }
      };
    }
    if (method === 'turn/start') {
      return {
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          turns: [{
            id: 'turn-1',
            status: 'completed',
            startedAt: 1779926400,
            completedAt: 1779926401,
            items: [{
              type: 'userMessage',
              id: 'user-1',
              content: [{
                type: 'text',
                text: params.threadId === '019e-existing-thread' ? '继续' : '你好',
                text_elements: []
              }]
            }, {
              type: 'agentMessage',
              id: 'msg-1',
              text: params.threadId === '019e-existing-thread' ? '继续完成。' : '你好，我已开始处理。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }

  waitForRequest(method) {
    if (this.calls.some((call) => call.method === method)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ method, resolve });
    });
  }

  resolveWaiters(method) {
    const ready = this.waiters.filter((waiter) => waiter.method === method);
    this.waiters = this.waiters.filter((waiter) => waiter.method !== method);
    ready.forEach((waiter) => waiter.resolve());
  }
}


for (const serviceTier of ['', 'default', 'priority']) {
  for (const existing of [false, true]) {
    test(`App Server fallback carries speed through ${existing ? 'resume' : 'start'} and turn: ${serviceTier || 'inherit'}`, async () => {
      const client = new FakeAppServerClient();
      const adapter = new CodexAppServerAdapter({ client });
      const threadId = existing ? '019e-existing-thread' : '019e-app-thread';
      const pending = adapter.run({ task: { id: 'speed', prompt: 'synthetic only', serviceTier,
        codexSessionId: existing ? threadId : null }, project: { root: process.cwd() }, emit() {} });
      await client.waitForRequest('turn/start');
      client.emit('notification', { method: 'turn/completed', params: { threadId,
        turn: { id: 'turn-1', status: 'completed', items: [] } } });
      await pending;
      const writes = client.calls.filter(({ method }) => method !== 'thread/read');
      assert.deepEqual(writes.map(({ method }) => method), [existing ? 'thread/resume' : 'thread/start', 'turn/start']);
      for (const { params } of writes) {
        assert.equal(Object.hasOwn(params, 'serviceTier'), Boolean(serviceTier));
        if (serviceTier) assert.equal(params.serviceTier, serviceTier);
      }
    });
  }
}
