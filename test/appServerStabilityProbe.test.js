import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { runLiveAppServerProbe } from '../src/liveAppServerProbe.js';
import { runLiveAppServerTurnProbe } from '../src/liveAppServerTurnProbe.js';
import { ManagedCodexAppServerClient } from '../src/managedCodexAppServerClient.js';
import { CodexAppServerStabilityProbe } from '../src/codexAppServerStabilityProbe.js';

test('managed client distinguishes responses, notifications, and server approval requests', async () => {
  const child = new FakeAppServerProcess();
  const client = new ManagedCodexAppServerClient({
    spawnProcess: () => child,
    requestTimeoutMs: 2_000
  });

  const notificationPromise = once(client, 'notification');
  const serverRequestPromise = once(client, 'serverRequest');
  const listPromise = client.request('thread/list', { limit: 1 });

  await child.waitForMethod('thread/list');
  child.send({ method: 'thread/status/changed', params: { threadId: 'thr-1', status: { type: 'active' } } });
  child.send({
    id: 700,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr-1', turnId: 'turn-1', command: 'Write-Output ok' }
  });
  child.respondToMethod('thread/list', { data: [{ id: 'thr-1' }], nextCursor: null });

  const [notification] = await notificationPromise;
  const [serverRequest] = await serverRequestPromise;
  assert.equal(notification.method, 'thread/status/changed');
  assert.equal(serverRequest.method, 'item/commandExecution/requestApproval');
  assert.equal((await listPromise).data[0].id, 'thr-1');

  client.respond(serverRequest.id, { decision: 'accept' });
  await child.waitForResponse(700);
  assert.deepEqual(child.responses.get(700), { id: 700, result: { decision: 'accept' } });
  await client.close();
});

test('managed client starts a fresh initialized process after an unexpected disconnect', async () => {
  const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
  let spawnCount = 0;
  const client = new ManagedCodexAppServerClient({
    spawnProcess: () => children[spawnCount++],
    requestTimeoutMs: 2_000
  });

  const first = client.request('thread/list', { limit: 1 });
  await children[0].waitForMethod('thread/list');
  children[0].respondToMethod('thread/list', { data: [], nextCursor: null });
  await first;

  const disconnected = once(client, 'disconnected');
  children[0].disconnect(17);
  await disconnected;

  const second = client.request('thread/list', { limit: 1 });
  await children[1].waitForMethod('thread/list');
  children[1].respondToMethod('thread/list', { data: [{ id: 'thr-reconnected' }], nextCursor: null });
  assert.equal((await second).data[0].id, 'thr-reconnected');
  assert.equal(spawnCount, 2);
  assert.equal(children[0].methodCount('initialize'), 1);
  assert.equal(children[1].methodCount('initialize'), 1);
  await client.close();
});

test('managed client automatically reconnects after an unexpected disconnect and reports its generation', async () => {
  const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
  let spawnCount = 0;
  const client = new ManagedCodexAppServerClient({
    spawnProcess: () => children[spawnCount++],
    requestTimeoutMs: 2_000,
    reconnectDelayMs: 0
  });

  await client.ensureStarted();
  const reconnected = once(client, 'reconnected');
  children[0].disconnect(17);

  await children[1].waitForMethod('initialize');
  const [event] = await reconnected;
  assert.equal(event.generation, 2);
  assert.equal(client.health().state, 'ready');
  assert.equal(client.health().generation, 2);
  assert.equal(client.health().pendingRequests, 0);
  await client.close();
});

test('stability probe observes send, stream, tool, approval, interrupt, and reconnect lanes', async () => {
  const client = new FakeProtocolClient();
  const probe = new CodexAppServerStabilityProbe({
    client,
    approvalDecision: async () => ({ decision: 'accept' })
  });
  probe.startObserving();

  const turn = await probe.sendTurn({
    threadId: 'thr-1',
    text: '执行稳定性验证'
  });
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-1', turnId: 'turn-1', delta: '处理中' }
  });
  client.emit('notification', {
    method: 'item/commandExecution/outputDelta',
    params: {
      threadId: 'thr-1',
      turnId: 'turn-1',
      item: { id: 'tool-1', type: 'commandExecution', command: 'Write-Output ok' },
      delta: 'ok'
    }
  });
  client.emit('serverRequest', {
    id: 701,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr-1', turnId: 'turn-1', command: 'Write-Output ok' }
  });
  await once(probe, 'approvalResponded');
  await probe.interruptTurn({ threadId: 'thr-1', turnId: turn.id });
  client.emit('reconnected', { generation: 2 });

  const report = probe.report();
  assert.equal(report.send.ok, true);
  assert.equal(report.stream.eventCount, 1);
  assert.equal(report.tools.eventCount, 1);
  assert.equal(report.approvals.requestCount, 1);
  assert.equal(report.approvals.responseCount, 1);
  assert.equal(report.interrupt.ok, true);
  assert.equal(report.reconnect.count, 1);
  assert.deepEqual(client.responses.get(701), {
    id: 701,
    result: { decision: 'accept' }
  });
  probe.stopObserving();
});

test('live probe reports read-only handshake, thread listing, and reconnect evidence without overstating turn coverage', async () => {
  const client = new FakeLiveProbeClient();
  const report = await runLiveAppServerProbe({ client });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'read-only');
  assert.equal(report.checks.initialize.ok, true);
  assert.equal(report.checks.threadList.ok, true);
  assert.equal(report.checks.threadList.itemCount, 1);
  assert.equal(report.checks.reconnect.ok, true);
  assert.equal(report.checks.reconnect.generation, 2);
  assert.equal(report.capabilityEvidence.send, 'contract-tested-not-live');
  assert.equal(report.capabilityEvidence.stream, 'contract-tested-not-live');
  assert.equal(client.closed, true);
});

test('live turn probe verifies streamed tool approval, interrupt, reconnect, and archives probe threads', async () => {
  const client = new FakeLiveTurnProbeClient();
  const report = await runLiveAppServerTurnProbe({
    client,
    cwd: 'C:\\probe',
    timeoutMs: 2_000
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'live-controlled');
  assert.equal(report.capabilityEvidence.send, 'live');
  assert.equal(report.capabilityEvidence.stream, 'live');
  assert.equal(report.capabilityEvidence.tools, 'live');
  assert.equal(report.capabilityEvidence.approvals, 'live-accepted-safe-command');
  assert.equal(report.capabilityEvidence.interrupt, 'live');
  assert.equal(report.capabilityEvidence.reconnect, 'live');
  assert.equal(report.checks.toolTurn.status, 'completed');
  assert.equal(report.checks.toolTurn.approvalRequests, 2);
  assert.equal(report.checks.toolTurn.approvalResponses, 1);
  assert.equal(report.checks.toolTurn.rejectedApprovalRequests, 1);
  assert.equal(report.checks.interruptTurn.status, 'interrupted');
  assert.equal(report.checks.reconnect.generation, 2);
  assert.deepEqual(client.archivedThreadIds.sort(), ['thr-interrupt', 'thr-tool']);
  assert.equal(client.closed, true);
});

class FakeProtocolClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.responses = new Map();
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      return {};
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  respond(id, result) {
    this.responses.set(id, { id, result });
  }
}

class FakeLiveProbeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 0;
    this.closed = false;
  }

  async ensureStarted() {
    this.generation = 1;
    return {
      generation: 1,
      initialize: { userAgent: 'fake-app-server' }
    };
  }

  async request(method) {
    assert.equal(method, 'thread/list');
    return {
      data: [{ id: `thr-${this.generation}` }],
      nextCursor: null
    };
  }

  async restart() {
    this.generation = 2;
    return {
      generation: 2,
      initialize: { userAgent: 'fake-app-server' }
    };
  }

  async close() {
    this.closed = true;
  }
}

class FakeLiveTurnProbeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 0;
    this.threadCount = 0;
    this.archivedThreadIds = [];
    this.closed = false;
  }

  async ensureStarted() {
    this.generation = 1;
    return {
      generation: 1,
      initialize: { userAgent: 'fake-app-server' }
    };
  }

  async request(method, params) {
    if (method === 'thread/start') {
      this.threadCount += 1;
      const id = this.threadCount === 1 ? 'thr-tool' : 'thr-interrupt';
      return { thread: { id, status: { type: 'idle' } } };
    }
    if (method === 'turn/start' && params.threadId === 'thr-tool') {
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thr-tool', turnId: 'turn-tool', delta: 'STREAM_OK' }
        });
        this.emit('notification', {
          method: 'item/started',
          params: {
            threadId: 'thr-tool',
            item: {
              id: 'item-tool',
              type: 'commandExecution',
              command: ['powershell.exe', '-Command', 'Write-Output CODEX_APP_SERVER_TOOL_OK']
            }
          }
        });
        this.emit('serverRequest', {
          id: 90,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thr-tool',
            turnId: 'turn-tool',
            itemId: 'item-unsafe',
            command: 'Write-Output CODEX_APP_SERVER_TOOL_OK; Remove-Item probe.txt'
          }
        });
        this.emit('serverRequest', {
          id: 91,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thr-tool',
            turnId: 'turn-tool',
            itemId: 'item-tool',
            command: [
              '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe',
              '\\pwsh.exe" -Command \'Write-Output CODEX_APP_SERVER_TOOL_OK\''
            ].join('')
          }
        });
      });
      return { turn: { id: 'turn-tool', status: 'inProgress' } };
    }
    if (method === 'turn/start' && params.threadId === 'thr-interrupt') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/started',
        params: {
          threadId: 'thr-interrupt',
          turn: { id: 'turn-interrupt', status: 'inProgress' }
        }
      }));
      return { turn: { id: 'turn-interrupt', status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: { id: params.turnId, status: 'interrupted' }
        }
      }));
      return {};
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          turns: [{
            id: 'turn-tool',
            status: 'completed',
            items: [{ type: 'agentMessage', text: 'CODEX_APP_SERVER_TURN_OK' }]
          }]
        }
      };
    }
    if (method === 'thread/archive') {
      this.archivedThreadIds.push(params.threadId);
      return {};
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  respond(id, result) {
    if (id === 90) {
      assert.deepEqual(result, { decision: 'decline' });
      return;
    }
    assert.equal(id, 91);
    assert.deepEqual(result, { decision: 'accept' });
    queueMicrotask(() => {
      this.emit('notification', {
        method: 'serverRequest/resolved',
        params: { threadId: 'thr-tool', requestId: 91 }
      });
      this.emit('notification', {
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thr-tool',
          turnId: 'turn-tool',
          itemId: 'item-tool',
          delta: 'CODEX_APP_SERVER_TOOL_OK'
        }
      });
      this.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: 'thr-tool',
          turn: { id: 'turn-tool', status: 'completed' }
        }
      });
    });
  }

  async restart() {
    this.generation = 2;
    return {
      generation: 2,
      initialize: { userAgent: 'fake-app-server' }
    };
  }

  async close() {
    this.closed = true;
  }
}

class FakeAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.responses = new Map();
    this.waiters = [];
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          this.receive(JSON.parse(line));
        }
        callback();
      }
    });
  }

  receive(message) {
    if (message.method) {
      this.requests.push(message);
      this.resolveWaiters();
      if (message.method === 'initialize') {
        queueMicrotask(() => this.send({
          id: message.id,
          result: { userAgent: 'fake-app-server' }
        }));
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.responses.set(message.id, message);
      this.resolveWaiters();
    }
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  respondToMethod(method, result) {
    const request = this.requests.findLast((item) => item.method === method);
    assert.ok(request, `Missing request for ${method}`);
    this.send({ id: request.id, result });
  }

  waitForMethod(method) {
    return this.waitFor(() => this.requests.some((item) => item.method === method));
  }

  waitForResponse(id) {
    return this.waitFor(() => this.responses.has(id));
  }

  methodCount(method) {
    return this.requests.filter((item) => item.method === method).length;
  }

  waitFor(predicate) {
    if (predicate()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fake app-server wait timed out')), 2_000);
      this.waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  resolveWaiters() {
    const ready = this.waiters.filter((waiter) => waiter.predicate());
    this.waiters = this.waiters.filter((waiter) => !waiter.predicate());
    ready.forEach((waiter) => waiter.resolve());
  }

  disconnect(exitCode) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', exitCode, null);
  }

  kill() {
    this.disconnect(0);
  }
}

