import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { DurableOutbox } from '../src/durableOutbox.js';

function fingerprint() {
  return {
    title: '持久队列测试',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    filePath: 'C:\\sessions\\thread-a.jsonl',
    entryCount: 2
  };
}

async function createFixture({ outboxPath, runs = [], onSend = null, threadServiceOverrides = {}, outboxReconciler,
  adapter = { async run() { return {}; } } }) {
  const threadService = {
    async listProjects() {
      return [{ id: 'probe', name: 'Probe', root: 'C:\\work' }];
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      return { id: 'thread-a', title: '持久队列测试', entries: [], activityStatus: 'idle' };
    },
    listRuns() {
      return runs;
    },
    getRun(id) {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) {
        const error = new Error('Unknown run');
        error.statusCode = 404;
        throw error;
      }
      return run;
    },
    async sendMessage(input) {
      if (onSend) {
        return await onSend(input);
      }
      const run = {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
      runs.push(run);
      return run;
    },
    runtimeHealth() {
      return { kind: 'app_server', enabled: true, state: 'ready' };
    },
    listApprovals() {
      return [];
    },
    ...threadServiceOverrides
  };
  const config = {
    repoRoot: path.dirname(outboxPath),
    outboxPath,
    outboxEnabled: true,
    outboxReconciler,
    outboxBlockedDelayMs: 250,
    appServerRuntimeMode: 'app-server-primary',
    threadService,
    sessions: {
      async verifySessionTarget(id) {
        return { id, ...fingerprint() };
      }
    },
    sessionSettings: {
      async getSessionSettings() {
        return { model: '', reasoningEffort: '' };
      },
      async updateSessionSettings() {
        return { model: '', reasoningEffort: '' };
      },
      async deleteSessionSettings() {
      }
    },
    defaultReasoningEffortProvider: async () => '',
    codexSettingsProvider: async () => ({ model: '', reasoningEffort: '', models: [] }),
    desktopLiveDiagnostics: false,
    logger: new DiagnosticLogger({
      root: path.join(os.tmpdir(), `codex-outbox-api-logs-${Date.now()}-${Math.random()}`)
    }),
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work', allowedCommands: [] }]
  };
  const app = createApp({ config, adapter });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    runs
  };
}

async function send(baseUrl, submissionId, text = '持久消息') {
  return await fetch(`${baseUrl}/api/codex/threads/thread-a/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'probe',
      text,
      submissionId,
      sessionFingerprint: fingerprint()
    })
  });
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for outbox state');
}

test('steer-capable dispatch skips a history read that cannot change its decision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-dispatch-metadata-'));
  let historyReads = 0, sends = 0;
  const fixture = await createFixture({ outboxPath: path.join(root, 'outbox.json'),
    adapter: { async run() { return {}; }, async steer() { return {}; } },
    threadServiceOverrides: { async getThread() { historyReads++; throw new Error('unnecessary read'); } },
    onSend: async input => { sends++; return { id: 'run-direct', threadId: input.threadId,
      submissionId: input.submissionId, status: 'running' }; } });
  t.after(async () => { fixture.server.closeAllConnections(); await new Promise(resolve => fixture.server.close(resolve));
    await fixture.outbox.dispatchPromise; await fixture.outbox.persistPromise;
    await fs.rm(root, { recursive: true, force: true }); });
  const sent = await (await send(fixture.baseUrl, 'metadata-fast')).json();
  await waitUntil(() => fixture.outbox.get(sent.outbox.id).status === 'submitted');
  assert.equal(sends, 1);
  assert.equal(historyReads, 0);
});

test('receipt acknowledgements wake outbox reconciliation without phone subscribers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-receipt-event-'));
  const fixture = await createFixture({ outboxPath: path.join(root, 'outbox.json') });
  t.after(async () => { fixture.server.closeAllConnections(); await new Promise(resolve => fixture.server.close(resolve));
    await fixture.outbox.persistPromise; await fs.rm(root, { recursive: true, force: true }); });
  let wakes = 0;
  fixture.outbox.requestReceiptReconciliation = () => { wakes++; };
  fixture.eventBus.publish('unsubscribed-task', { type: 'codex.delivery.attempted' });
  assert.equal(wakes, 0);
  fixture.eventBus.publish('unsubscribed-task', { type: 'codex.app_server.turn.started' });
  fixture.eventBus.publish('unsubscribed-task', { type: 'task.guidance.accepted' });
  assert.equal(wakes, 2);
});

for (const activity of ['running', 'idle', 'unavailable']) {
  test(`an adapter without steer preserves the ${activity} dispatch decision`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-dispatch-compat-'));
    let historyReads = 0, sends = 0;
    const fixture = await createFixture({ outboxPath: path.join(root, 'outbox.json'),
      threadServiceOverrides: { async getThread() { historyReads++;
        if (activity === 'unavailable') throw new Error('offline');
        return { activityStatus: activity }; } },
      onSend: async input => { sends++; return { id: 'run-compat', threadId: input.threadId,
        submissionId: input.submissionId, status: 'running' }; } });
    t.after(async () => { fixture.server.closeAllConnections(); await new Promise(resolve => fixture.server.close(resolve));
      await fixture.outbox.dispatchPromise; await fixture.outbox.persistPromise;
      await fs.rm(root, { recursive: true, force: true }); });
    const body = await (await send(fixture.baseUrl, 'compat-'+activity)).json();
    await fixture.outbox.dispatchReady();
    assert.ok(historyReads > 0);
    assert.equal(sends, activity === 'running' ? 0 : 1);
    assert.equal(fixture.outbox.get(body.outbox.id).status, activity === 'running' ? 'queued' : 'submitted');
  });
}

for (const kind of ['existing_thread', 'new_thread']) {
  test(`${kind} accepts two durable messages while the first native dispatch is blocked`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-nonblocking-'));
    const outboxPath = path.join(root, 'outbox.json');
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const dispatched = [];
    const dispatch = async input => {
      dispatched.push(input.submissionId);
      if (dispatched.length === 1) { started.resolve(); await gate.promise; }
      return { id: `run-${input.submissionId}`, status: 'running', submissionId: input.submissionId };
    };
    const fixture = await createFixture({ outboxPath, onSend: dispatch,
      threadServiceOverrides: { startThread: async input => ({ run: await dispatch(input) }) } });
    t.after(async () => { gate.resolve(); fixture.server.close(); await fs.rm(root, { recursive: true, force: true }); });
    const post = async submissionId => fetch(`${fixture.baseUrl}${kind === 'existing_thread'
      ? '/api/codex/threads/thread-a/messages' : '/api/codex/threads'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(1500),
      body: JSON.stringify({ projectId: 'probe', submissionId, text: submissionId,
        ...(kind === 'existing_thread' ? { sessionFingerprint: fingerprint() } : {}) })
    });
    const response1 = await post('first');
    assert.equal(response1.status, 202);
    const first = await response1.json();
    assert.equal(first.run.status, 'queued');
    await started.promise;
    const response2 = await post('second');
    assert.equal(response2.status, 202);
    const second = await response2.json();
    assert.equal(second.run.status, 'queued');
    const persisted = JSON.parse(await fs.readFile(outboxPath, 'utf8'));
    assert.deepEqual(persisted.items.map(item => item.submissionId), ['first', 'second']);
    assert.deepEqual(dispatched, ['first']);
    gate.resolve();
    await waitUntil(() => fixture.outbox.get(second.outbox.id)?.status === 'submitted');
    assert.deepEqual(dispatched, ['first', 'second']);
    assert.equal(fixture.outbox.get(first.outbox.id).status, 'submitted');
  });
}

test('retry returns after persisting even when native dispatch is blocked', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-retry-'));
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let calls = 0;
  const fixture = await createFixture({ outboxPath: path.join(root, 'outbox.json'),
    outboxReconciler: async () => ({ status: 'unknown' }),
    onSend: async input => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('bad request'), { statusCode: 400 });
      started.resolve();
      await gate.promise;
      return { id: `run-${input.submissionId}`, status: 'running' };
    } });
  t.after(async () => { gate.resolve(); fixture.server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const response = await send(fixture.baseUrl, 'retry-nonblocking');
  const accepted = await response.json();
  await waitUntil(() => fixture.outbox.get(accepted.outbox.id)?.status === 'failed');
  const retry = await fetch(`${fixture.baseUrl}/api/outbox/${accepted.outbox.id}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000)
  });
  assert.equal(retry.status, 200);
  assert.ok(['queued', 'dispatching'].includes((await retry.json()).item.status));
  await started.promise;
  gate.resolve();
  await waitUntil(() => fixture.outbox.get(accepted.outbox.id)?.status === 'submitted');
});

test('thread message outbox deduplicates after restart without reviving an unloaded run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-api-'));
  const outboxPath = path.join(root, 'outbox.json');
  let firstDispatches = 0;
  const liveRuns = [];
  const first = await createFixture({
    outboxPath,
    runs: liveRuns,
    onSend: async (input) => {
      firstDispatches += 1;
      const run = {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
      liveRuns.push(run);
      return run;
    }
  });
  try {
    const response = await send(first.baseUrl, 'restart-safe-1');
    assert.equal(response.status, 202);
    const accepted = await response.json();
    let body;
    await waitUntil(async () => {
      body = await (await fetch(`${first.baseUrl}/api/codex/runs/${accepted.outbox.id}`)).json();
      return body.outbox.status === 'submitted';
    });
    assert.equal(body.run.id, 'run-restart-safe-1');
    assert.equal(firstDispatches, 1);
    await waitUntil(async () => JSON.parse(await fs.readFile(outboxPath, 'utf8'))
      .items.find(item => item.id === accepted.outbox.id)?.status === 'submitted');
  } finally {
    first.server.close();
  }

  let secondDispatches = 0;
  const second = await createFixture({
    outboxPath,
    onSend: async () => {
      secondDispatches += 1;
      throw new Error('duplicate dispatch');
    }
  });
  try {
    const response = await send(second.baseUrl, 'restart-safe-1');
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.run.id, body.outbox.id);
    assert.equal(body.run.status, 'submitted');
    assert.equal(body.outbox.resultId, 'run-restart-safe-1');
    assert.equal(body.outbox.status, 'submitted');
    assert.equal(secondDispatches, 0);
  } finally {
    second.server.close();
  }
});

test('thread message API rejects a conflicting submission without dispatching it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-api-'));
  let dispatches = 0;
  const fixture = await createFixture({ outboxPath: path.join(root, 'outbox.json'),
    onSend: async () => { dispatches++; return { id: 'first-run', status: 'running' }; } });
  try {
    assert.equal((await send(fixture.baseUrl, 'same-id', '第一条')).status, 202);
    await waitUntil(() => dispatches === 1);
    const response = await send(fixture.baseUrl, 'same-id', '不同正文');
    assert.equal(response.status, 409);
    assert.equal(dispatches, 1);
  } finally {
    fixture.server.close();
  }
});

test('outbox API edits, reorders, and cancels queued thread messages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-api-'));
  const outboxPath = path.join(root, 'outbox.json');
  const activeRun = {
    id: 'busy-run',
    threadId: 'thread-a',
    codexSessionId: 'thread-a',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  };
  const fixture = await createFixture({ outboxPath, runs: [activeRun] });
  try {
    const first = await (await send(fixture.baseUrl, 'queued-1', '第一条')).json();
    const second = await (await send(fixture.baseUrl, 'queued-2', '第二条')).json();
    assert.equal(first.outbox.status, 'queued');
    assert.equal(second.outbox.status, 'queued');

    const edit = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '修改后的第二条' })
    });
    assert.equal(edit.status, 200);

    const harmonyEdit = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Harmony 修改后的第二条' })
    });
    assert.equal(harmonyEdit.status, 200);

    const move = await fetch(`${fixture.baseUrl}/api/outbox/${second.outbox.id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'up' })
    });
    assert.equal(move.status, 200);

    const cancel = await fetch(`${fixture.baseUrl}/api/outbox/${first.outbox.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(cancel.status, 200);

    const listed = await (await fetch(`${fixture.baseUrl}/api/outbox?threadId=thread-a`)).json();
    assert.equal(listed.items[0].id, second.outbox.id);
    assert.equal(listed.items[0].text, 'Harmony 修改后的第二条');
    assert.equal(listed.items.find((item) => item.id === first.outbox.id).status, 'canceled');
  } finally {
    fixture.server.close();
  }
});

test('queued message text remains complete in send and polling responses before official delivery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-visible-message-'));
  const fixture = await createFixture({
    outboxPath: path.join(root, 'outbox.json'),
    runs: [{ id: 'busy-run', threadId: 'thread-a', codexSessionId: 'thread-a',
      status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] }]
  });
  const text = '这条消息在等待官方确认时也必须完整可见。'.repeat(20);
  try {
    const response = await send(fixture.baseUrl, 'visible-queued', text);
    const accepted = await response.json();
    assert.equal(response.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.outbox.status, 'queued');
    assert.equal(accepted.run.prompt, text, 'the phone replaces its optimistic bubble with this run');
    const polled = await (await fetch(`${fixture.baseUrl}/api/codex/runs/${accepted.run.id}`)).json();
    assert.equal(polled.run.prompt, text, 'polling must not erase or shorten the pending user message');
    assert.equal(polled.run.submissionId, 'visible-queued');
  } finally {
    fixture.server.close();
  }
});

for (const scenario of ['existing_thread', 'new_thread', 'steered_thread']) {
test(`confirmed ${scenario} delivery returns a stable receipt run without claiming model completion or resending`, async t => {
  const kind = scenario === 'steered_thread' ? 'existing_thread' : scenario;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-receipt-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outboxPath = path.join(root, 'outbox.json');
  const text = '重启后已确认送达的消息仍然可见';
  const payload = kind === 'existing_thread'
    ? { projectId: 'probe', text, submissionId: 'restored-receipt', sessionFingerprint: fingerprint() }
    : { projectId: 'probe', submissionId: 'restored-receipt', prompt: text };
  const first = new DurableOutbox({ filePath: outboxPath, schedule: false,
    dispatch: async () => ({ run: { id: 'old-memory-task', status: 'running' }, deliveryPending: true }) });
  const queued = await first.enqueue({ kind, threadId: kind === 'existing_thread' ? 'thread-a' : '',
    projectId: 'probe', submissionId: 'restored-receipt', text, payload });
  await first.dispatchReady();
  first.close();
  let redispatches = 0;
  const fixture = await createFixture({ outboxPath,
    onSend: async () => { redispatches++; throw new Error('must not send again'); },
    outboxReconciler: async () => ({ status: 'submitted', result: scenario === 'steered_thread' ? {
      run: { id: 'old-memory-task', codexSessionId: 'thread-a', status: 'running', prompt: '前一条消息', events: [] },
      deliveryPending: false
    } : {
      id: 'session-receipt:thread-a:observed', threadId: 'thread-a',
      submissionId: 'restored-receipt', observedAt: new Date().toISOString(), deliveryPending: false
    } })
  });
  try {
    await fixture.outbox.initialize();
    for (const response of [
      await fetch(`${fixture.baseUrl}/api/codex/runs/${queued.id}`),
      kind === 'existing_thread' ? await send(fixture.baseUrl, 'restored-receipt', text)
        : await fetch(`${fixture.baseUrl}/api/codex/threads`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: 'probe', submissionId: 'restored-receipt', prompt: text }) })
    ]) {
      const body = await response.json();
      assert.equal(body.outbox.status, 'submitted');
      assert.ok(body.run, 'phone run envelope must remain present after receipt-only recovery');
      assert.equal(body.run.id, queued.id);
      assert.equal(body.run.prompt, text);
      assert.equal(body.run.codexSessionId, 'thread-a', 'receipt keeps the official session created before restart');
      assert.equal(body.run.status, 'submitted', 'delivery confirmation is not model completion');
      assert.equal(body.run.runtime.kind, 'durable_outbox');
      assert.equal(body.run.runtime.state, 'submitted');
      assert.equal(body.run.interruptReady, false);
    }
    assert.equal(redispatches, 0);
  } finally {
    fixture.server.close();
  }
});
}

test('outbox never steers a message into a turn whose interrupt is still pending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-interrupt-barrier-'));
  const outboxPath = path.join(root, 'outbox.json');
  const runs = [{
    id: 'run-interrupting',
    threadId: 'thread-a',
    codexSessionId: 'thread-a',
    status: 'running',
    interruptRequested: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  }];
  const steered = [];
  const dispatched = [];
  const fixture = await createFixture({
    outboxPath,
    runs,
    onSend: async (input) => {
      dispatched.push(input.submissionId);
      return {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        interruptRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
    },
    threadServiceOverrides: {
      canSteerThread() {
        return runs[0].status === 'running';
      },
      async steerMessage(input) {
        steered.push(input.text);
        return runs[0];
      }
    }
  });

  try {
    const response = await send(fixture.baseUrl, 'after-interrupt-1', '继续');
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.outbox.status, 'queued');
    assert.deepEqual(steered, []);
    assert.deepEqual(dispatched, []);

    runs[0].status = 'interrupted';
    runs[0].interruptRequested = false;
    await new Promise((resolve) => setTimeout(resolve, 275));
    await fixture.outbox.dispatchReady();

    const released = fixture.outbox.get(body.outbox.id);
    assert.equal(released.status, 'submitted');
    assert.deepEqual(steered, []);
    assert.deepEqual(dispatched, ['after-interrupt-1']);
  } finally {
    fixture.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('outbox reconciles a restored run before deciding whether the lane is busy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-outbox-recovering-'));
  const outboxPath = path.join(root, 'outbox.json');
  const runs = [{
    id: 'run-recovering',
    threadId: 'thread-a',
    codexSessionId: 'thread-a',
    status: 'recovering',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  }];
  const dispatched = [];
  let reconciliations = 0;
  const fixture = await createFixture({
    outboxPath,
    runs,
    onSend: async (input) => {
      dispatched.push(input.submissionId);
      return {
        id: `run-${input.submissionId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        codexSessionId: input.threadId,
        submissionId: input.submissionId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
    },
    threadServiceOverrides: {
      async reconcilePersistedRun(run) {
        reconciliations += 1;
        run.status = 'interrupted';
        return run;
      },
      canSteerThread() {
        return false;
      }
    }
  });

  try {
    const response = await send(fixture.baseUrl, 'recovering-release-1', '继续');
    const body = await response.json();
    assert.equal(response.status, 202);
    await waitUntil(() => fixture.outbox.get(body.outbox.id)?.status === 'submitted');
    assert.equal(reconciliations, 1);
    assert.deepEqual(dispatched, ['recovering-release-1']);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    await fixture.outbox.dispatchPromise;
    fixture.outbox.close();
    await fixture.outbox.persistPromise;
    await fs.rm(root, { recursive: true, force: true });
  }
});
