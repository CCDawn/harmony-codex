import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { CodexSessionStore } from '../src/codexSessions.js';
import { desktopScriptBridge } from '../src/desktopScriptBridge.js';

function createTestConfig() {
  const sessionSettingsById = new Map();
  const config = {
    // Keep the desktop fixture explicit. Production also defaults to the
    // desktop-owned path; individual tests opt into compatibility modes
    // unless a case opts into another runtime mode below.
    appServerRuntimeMode: 'desktop',
    outboxEnabled: false,
    logger: new DiagnosticLogger({
      root: path.join(os.tmpdir(), `codex-app-test-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    }),
    desktopLiveRecovery: {
      shouldRecover() {
        return false;
      },
      async recover() {
        throw new Error('test recovery disabled');
      }
    },
    desktopLiveDiagnostics: false,
    async defaultReasoningEffortProvider() {
      return '';
    },
    sessionSettings: {
      async getSessionSettings(sessionId) {
        return sessionSettingsById.get(sessionId) ?? { model: '', reasoningEffort: '', updatedAt: '' };
      },
      async updateSessionSettings(sessionId, patch = {}) {
        const current = sessionSettingsById.get(sessionId) ?? { model: '', reasoningEffort: '', updatedAt: '' };
        const next = {
          model: Object.prototype.hasOwnProperty.call(patch, 'model') ? String(patch.model ?? '').trim() : current.model,
          reasoningEffort: Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort') ? String(patch.reasoningEffort ?? '').trim() : current.reasoningEffort,
          updatedAt: new Date().toISOString()
        };
        sessionSettingsById.set(sessionId, next);
        return next;
      },
      async deleteSessionSettings(sessionId) {
        sessionSettingsById.delete(sessionId);
      }
    },
    projects: [
      {
        id: 'probe',
        name: 'Probe Workspace',
        root: process.cwd(),
        allowedCommands: [/^npm\s+test$/]
      }
    ]
  };
  config.codexSettingsProvider = async () => ({
    model: 'gpt-test',
    reasoningEffort: await config.defaultReasoningEffortProvider(),
    models: [{
      id: 'gpt-test',
      model: 'gpt-test',
      displayName: 'GPT Test',
      description: 'Test default model',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
    }, {
      id: 'gpt-alt',
      model: 'gpt-alt',
      displayName: 'GPT Alt',
      description: 'Test alternate model',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium']
    }]
  });
  return config;
}

function testSessionFingerprint(overrides = {}) {
  return {
    title: '测试会话',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    filePath: 'C:\\sessions\\rollout.jsonl',
    entryCount: 2,
    ...overrides
  };
}

test('creates a task and exposes approval-driven lifecycle events', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: 'Fix the test failure'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const taskId = created.task.id;

    const approval = await waitForApproval(store, taskId);
    const approvalResponse = await fetch(`${baseUrl}/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    });
    assert.equal(approvalResponse.status, 200);

    const task = await waitForTaskStatus(store, taskId, 'completed');
    assert.equal(task.result.summary, 'Mock Codex task completed');
    assert.ok(task.events.some((event) => event.type === 'approval.required'));
    assert.ok(task.events.some((event) => event.type === 'task.completed'));
  } finally {
    server.close();
  }
});

test('lists task summaries', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: 'Fix the test failure'
      })
    });
    const created = await createResponse.json();
    await waitForApproval(store, created.task.id);

    const listResponse = await fetch(`${baseUrl}/tasks`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.task.id);
    assert.equal(listed.tasks[0].eventCount > 0, true);
  } finally {
    server.close();
  }
});

test('health negotiates the Bridge protocol and reports incompatible clients', async () => {
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const compatibleResponse = await fetch(`${baseUrl}/health?clientProtocol=1&clientVersion=1.0.11`);
    const compatible = await compatibleResponse.json();
    assert.equal(compatibleResponse.status, 200);
    assert.equal(compatible.runtime.protocol.protocolVersion, 1);
    assert.equal(compatible.runtime.protocol.minimumClientProtocol, 1);
    assert.equal(compatible.runtime.protocol.clientProtocol, 1);
    assert.equal(compatible.runtime.protocol.clientVersion, '1.0.11');
    assert.equal(compatible.runtime.protocol.compatible, true);
    assert.ok(compatible.runtime.protocol.capabilities.includes('event-cursor-v1'));
    assert.ok(compatible.runtime.protocol.capabilities.includes('outbox-reconcile-v1'));
    assert.ok(compatible.runtime.protocol.capabilities.includes('runtime-snapshot-v1'));

    const incompatibleResponse = await fetch(`${baseUrl}/health?clientProtocol=999&clientVersion=9.9.9`);
    const incompatible = await incompatibleResponse.json();
    assert.equal(incompatibleResponse.status, 200);
    assert.equal(incompatible.runtime.protocol.compatible, false);
    assert.equal(incompatible.runtime.protocol.reason, 'client_protocol_newer');
  } finally {
    server.close();
  }
});

test('task polling supports a forward-only event cursor without duplicates', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '事件游标测试'
      })
    });
    const created = await createResponse.json();
    for (let index = 0; index < 10; index += 1) {
      store.addEvent(created.task.id, `probe.event.${index}`);
    }

    const firstResponse = await fetch(`${baseUrl}/tasks/${created.task.id}?afterSeq=0&eventLimit=3`);
    const first = (await firstResponse.json()).task;
    assert.deepEqual(first.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(first.eventCursor, 3);
    assert.equal(first.hasMoreEvents, true);
    assert.equal(first.eventGap, false);

    const secondResponse = await fetch(`${baseUrl}/tasks/${created.task.id}?afterSeq=${first.eventCursor}&eventLimit=3`);
    const second = (await secondResponse.json()).task;
    assert.deepEqual(second.events.map((event) => event.seq), [4, 5, 6]);
    assert.equal(second.eventCursor, 6);
    assert.equal(second.hasMoreEvents, true);
    assert.equal(second.events.some((event) => first.events.some((previous) => previous.id === event.id)), false);
  } finally {
    server.close();
  }
});

test('interrupts a running desktop-backed task through the task API', async () => {
  const config = createTestConfig();
  const adapter = new InterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '长任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));
    const listResponse = await fetch(`${baseUrl}/tasks`);
    const listed = await listResponse.json();
    const listedTask = listed.tasks.find((task) => task.id === created.task.id);
    assert.equal(listedTask.activeCodexTurnId, 'turn-interrupt-1');
    assert.equal(listedTask.interruptReady, true);

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    assert.equal(interrupted.task.interruptDispatching, true);
    assert.equal(interrupted.task.interruptState, 'dispatching');
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.equal(adapter.interrupted.threadId, '019e-interrupt-thread');
    assert.equal(adapter.interrupted.turnId, 'turn-interrupt-1');
    assert.equal(adapter.interrupted.status, 'interrupted');
    assert.ok(store.getTask(created.task.id).events.some((event) => event.type === 'task.interrupted'));
  } finally {
    server.close();
  }
});

test('interrupts a running task by Codex session id', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '可中断会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-30T00:00:00.000Z'
      };
    }
  };
  const adapter = new InterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '长任务',
        codexSessionId: '019e-interrupt-thread',
        sessionFingerprint: testSessionFingerprint({ title: '可中断会话' })
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/api/codex/threads/019e-interrupt-thread/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.run.id, created.task.id);
    assert.equal(interrupted.run.status, 'running');
    assert.equal(interrupted.run.interruptRequested, true);
    assert.equal(interrupted.run.interruptDispatching, true);
    assert.equal(interrupted.run.interruptState, 'dispatching');
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.equal(adapter.interrupted.threadId, '019e-interrupt-thread');
    assert.equal(adapter.interrupted.turnId, 'turn-interrupt-1');
    assert.equal(adapter.interrupted.status, 'interrupted');
  } finally {
    server.close();
  }
});

test('acknowledges slow Codex interrupts before desktop dispatch finishes', async () => {
  const config = createTestConfig();
  const adapter = new SlowInterruptibleAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '慢中断任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptPromise = fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    const timeout = delay(100).then(() => 'timeout');
    const responseOrTimeout = await Promise.race([interruptPromise, timeout]);
    assert.notEqual(responseOrTimeout, 'timeout');

    const interruptResponse = responseOrTimeout;
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();
    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    assert.equal(interrupted.task.interruptDispatching, true);
    assert.equal(interrupted.task.interruptState, 'dispatching');
    await until(() => adapter.interruptStarted);
    assert.equal(adapter.interruptStarted, true);
    assert.equal(adapter.interrupted, null);

    adapter.releaseInterrupt();
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.error, '已中断当前会话');
    assert.equal(adapter.interrupted.threadId, '019e-interrupt-thread');
    assert.equal(adapter.interrupted.turnId, 'turn-interrupt-1');
    assert.equal(adapter.interrupted.status, 'interrupted');
  } finally {
    server.close();
  }
});

test('does not report a completed task as interrupted when desktop interrupt confirmation arrives late', async () => {
  const config = createTestConfig();
  const adapter = new CompletingBeforeInterruptAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '中断确认迟到任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1&confirmTimeoutMs=30`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();
    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptState, 'dispatching');
    await until(() => adapter.interruptStarted);

    adapter.releaseRun();
    const completed = await waitForTaskStatus(store, created.task.id, 'completed');
    assert.equal(completed.error, null);

    adapter.releaseInterrupt();
    await until(() => store.getTask(created.task.id).events.some((event) => event.type === 'task.interrupt.late_confirm_ignored'));
    const finalTask = store.getTask(created.task.id);
    assert.equal(finalTask.status, 'completed');
    assert.equal(finalTask.interruptDispatching, false);
    assert.equal(finalTask.interruptRequested, false);
  } finally {
    server.close();
  }
});

test('recovers a failed mobile interrupt when desktop later reports the same turn was aborted', async () => {
  const config = createTestConfig();
  let reconcileStatus = 'running';
  const reconcileCalls = [];
  config.interruptReconciler = async (request) => {
    reconcileCalls.push(request);
    return {
      status: reconcileStatus,
      reason: reconcileStatus === 'interrupted' ? 'turn_aborted' : 'desktop_in_progress',
      turnId: request.activeTurnId,
      observedAt: new Date().toISOString()
    };
  };
  config.interruptReconcileTimeoutMs = 1000;
  config.interruptReconcilePollMs = 25;
  const adapter = new FailingInterruptAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '无法中断的长任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    assert.equal(interrupted.task.interruptDispatching, false);
    assert.equal(interrupted.task.interruptState, 'reconciling');
    assert.equal(interrupted.task.interruptError, null);
    assert.equal(interrupted.task.error, null);
    assert.equal(interrupted.task.latestEvent.type, 'task.interrupt.reconcile_polled');

    const duplicateResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1`, {
      method: 'POST'
    });
    assert.equal(duplicateResponse.status, 200);
    assert.ok(store.getTask(created.task.id).events.some((event) => event.type === 'task.interrupt.duplicate_ignored'));

    reconcileStatus = 'interrupted';
    const finalTask = await waitForTaskStatus(store, created.task.id, 'interrupted');
    assert.equal(finalTask.interruptError, null);
    assert.equal(finalTask.lastInterruptFailure, null);
    assert.ok(reconcileCalls.some((call) => call.threadId === '019e-interrupt-thread' && call.activeTurnId === 'turn-interrupt-1'));
    assert.ok(finalTask.events.some((event) => event.type === 'task.interrupt.reconcile_confirmed'));
  } finally {
    server.close();
  }
});

test('does not confirm a failed interrupt from weak thread-level interrupted state', async () => {
  const config = createTestConfig();
  config.interruptReconciler = async () => ({
    status: 'interrupted',
    reason: 'desktop_session_interrupted',
    message: '2026-06-19T08:00:59.000Z'
  });
  config.interruptReconcileTimeoutMs = 40;
  config.interruptReconcilePollMs = 25;
  const adapter = new FailingInterruptAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '测试弱中断确认'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.notEqual(interrupted.task.interruptState, 'confirmed');
    assert.notEqual(interrupted.task.status, 'interrupted');
    await until(() => store.getTask(created.task.id).events.some((event) => event.type === 'task.interrupt.recoverable_failed'));
    const finalTask = store.getTask(created.task.id);
    assert.equal(finalTask.status, 'running');
    assert.equal(finalTask.interruptState, undefined);
    assert.ok(finalTask.events.some((event) => event.type === 'task.interrupt.weak_confirm_ignored'));
    assert.equal(finalTask.events.some((event) => event.type === 'task.interrupted'), false);
  } finally {
    server.close();
  }
});

test('keeps failed interrupt dispatch recoverable when no desktop reconciliation channel is available', async () => {
  const config = createTestConfig();
  config.interruptReconciler = false;
  const adapter = new FailingInterruptAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '无法中断的长任务'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await until(() => Boolean(store.getTask(created.task.id)?.activeCodexTurnId));

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt?confirm=1`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    const interrupted = await interruptResponse.json();

    assert.equal(interrupted.task.status, 'running');
    assert.equal(interrupted.task.interruptRequested, true);
    assert.equal(interrupted.task.interruptDispatching, false);
    assert.equal(interrupted.task.interruptState, 'recoverable_failed');
    assert.equal(interrupted.task.interruptError, null);
    assert.equal(interrupted.task.lastInterruptFailure, 'Codex 桌面 CDP 连接错误');
    assert.equal(interrupted.task.error, null);
    assert.equal(interrupted.task.latestEvent.type, 'task.interrupt.recoverable_failed');
  } finally {
    server.close();
  }
});

test('rejects interrupting an already completed task', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new FastAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '短任务'
      })
    });
    const created = await createResponse.json();
    await waitForTaskStatus(store, created.task.id, 'completed');

    const interruptResponse = await fetch(`${baseUrl}/tasks/${created.task.id}/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 409);
  } finally {
    server.close();
  }
});

test('uploads a phone image and returns a local Codex-readable path', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'screen.png',
        mimeType: 'image/png',
        base64: Buffer.from('fake-png').toString('base64')
      })
    });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    assert.equal(uploaded.image.mimeType, 'image/png');
    assert.equal(uploaded.image.bytes, 8);
    assert.ok(uploaded.image.filePath.endsWith('.png'));
    assert.equal(uploaded.image.messageText, `![手机端图片](${uploaded.image.filePath.replace(/\\/g, '/')})`);
    assert.equal(uploaded.image.messageText.includes('请查看并结合当前对话回复'), false);
    assert.equal(uploaded.image.messageText.includes('图片路径：'), false);
    assert.equal(await fs.readFile(uploaded.image.filePath, 'utf8'), 'fake-png');
  } finally {
    server.close();
  }
});

test('serves uploaded phone images for mobile preview', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-preview-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const imagePath = path.join(config.mobileImagesDir, 'preview.png');
    await fs.writeFile(imagePath, Buffer.from('fake-png'));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images/file?path=${encodeURIComponent(imagePath)}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), 'fake-png');
  } finally {
    server.close();
  }
});

test('rejects mobile image preview paths outside upload directory', async () => {
  const config = createTestConfig();
  config.mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-images-preview-'));
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const outsidePath = path.join(os.tmpdir(), 'outside-preview.png');
    await fs.writeFile(outsidePath, Buffer.from('fake-png'));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/mobile/images/file?path=${encodeURIComponent(outsidePath)}`);

    assert.equal(response.status, 403);
  } finally {
    server.close();
  }
});

test('creates a task from a short Chinese chat message', async () => {
  const config = createTestConfig();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '你好'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(store.getTask(created.task.id).prompt, '你好');
  } finally {
    server.close();
  }
});

test('creates a task for an existing Codex session', async () => {
  const config = createTestConfig();
  const sessions = {
    async verifySessionTarget(sessionId, fingerprint) {
      return {
        id: sessionId,
        title: fingerprint?.title ?? '测试会话',
        projectRoot: fingerprint?.projectRoot ?? 'C:\\work',
        projectLabel: fingerprint?.projectLabel ?? 'work',
        filePath: fingerprint?.filePath ?? 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  config.sessions = sessions;
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '019e-test-session',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.task.codexSessionId, '019e-test-session');

    const task = store.getTask(created.task.id);
    assert.equal(task.codexSessionId, '019e-test-session');
    assert.equal(task.events[0].payload.codexSessionId, '019e-test-session');
    assert.equal(task.verifiedSessionTarget.filePath, 'C:\\sessions\\rollout.jsonl');
  } finally {
    server.close();
  }
});

test('records the created Codex session id for new tasks', async () => {
  const config = createTestConfig();
  const adapter = {
    async run({ emit }) {
      emit('codex.exec.event', {
        type: 'thread.started',
        thread_id: '019e-new-session'
      });
      return {
        summary: '新会话已创建',
        changedFiles: [],
        tests: []
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '新建一个会话并分析项目'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    assert.equal(task.createdCodexSessionId, '019e-new-session');
    assert.equal(task.codexSessionId, '019e-new-session');

    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.createdCodexSessionId, '019e-new-session');
    assert.equal(fetched.task.codexSessionId, '019e-new-session');
  } finally {
    server.close();
  }
});

test('exposes desktop sync status for CLI-backed Codex tasks', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '测试会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  const desktopSync = {
    status: 'file_only',
    desktopLive: false,
    mode: 'resume',
    message: '已写入 Codex 本地会话文件；当前 Codex 桌面窗口不会自动实时刷新这条外部写入。',
    reason: '独立 CLI 进程不会通知桌面 app-server。'
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.desktop_sync', desktopSync);
      return {
        summary: '已发送到会话',
        changedFiles: [],
        tests: [],
        desktopSync
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '019e-test-session',
        sessionFingerprint: testSessionFingerprint()
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');
    assert.deepEqual(task.desktopSync, desktopSync);

    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.desktopSync.desktopLive, false);
    assert.equal(fetched.task.result.desktopSync.status, 'file_only');
    assert.ok(fetched.task.events.some((event) => event.type === 'codex.desktop_sync'));
  } finally {
    server.close();
  }
});

test('does not request desktop refresh for blocked existing-session tasks', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget(sessionId) {
      return {
        id: sessionId,
        title: '测试会话',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        filePath: 'C:\\sessions\\rollout.jsonl',
        entryCount: 2,
        verifiedAt: '2026-05-29T00:00:00.000Z'
      };
    }
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.desktop_sync', {
        status: 'desktop_live_required',
        desktopLive: false,
        mode: 'resume'
      });
      return {
        summary: '桌面官方通道未连接',
        changedFiles: [],
        tests: [],
        desktopSync: {
          status: 'desktop_live_required',
          desktopLive: false,
          mode: 'resume'
        }
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话',
        codexSessionId: '019e-test-session',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');
    const eventTypes = task.events.map((event) => event.type);

    assert.ok(eventTypes.includes('codex.desktop_sync'));
    assert.ok(!eventTypes.includes('codex.desktop_session.refresh_requested'));
    assert.ok(!eventTypes.includes('codex.desktop_session.refresh_failed'));
  } finally {
    server.close();
  }
});

test('exposes desktop live status without creating a task', async () => {
  const config = createTestConfig();
  const adapter = {
    checked: 0,
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      this.checked += 1;
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: `timeout=${timeoutMs}`,
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/status?sessionId=019e-test-session`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.desktop.desktopLive, false);
    assert.equal(body.desktop.reason, 'timeout=8000');
    assert.equal(body.desktop.targetSessionId, '019e-test-session');
    assert.equal(body.desktop.sessionVerified, false);
    assert.equal(adapter.checked, 1);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('classifies ordinary Codex without CDP as not mobile-recoverable', async () => {
  const config = createTestConfig();
  let recoverCalled = false;
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: true,
        cdpPort: 60568,
        lastInjectedCdpPort: 60568,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover() {
      recoverCalled = true;
      throw new Error('should not soft recover plain Codex');
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/status?sessionId=019e-test-session&recover=1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.desktop.desktopLive, false);
    assert.equal(body.desktop.failureClass, 'codex_plain_no_cdp');
    assert.equal(body.desktop.desktopProcessMode, 'plain');
    assert.equal(body.desktop.requiresDesktopCdp, true);
    assert.equal(body.desktop.mobileRecoverable, false);
    assert.match(body.desktop.recoveryHint, /普通启动态|CDP/);
    assert.equal(recoverCalled, false);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('captures primary desktop screenshot without exposing a file path', async () => {
  const config = createTestConfig();
  config.desktopScreenshotProvider = async () => ({
    mimeType: 'image/png',
    base64: Buffer.from('fake-screen').toString('base64'),
    bytes: 11,
    width: 1920,
    height: 1080,
    capturedAt: '2026-05-30T00:00:00.000Z',
    durationMs: 12
  });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/screenshot/primary`, {
      method: 'POST'
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.image.mimeType, 'image/png');
    assert.equal(body.image.base64, Buffer.from('fake-screen').toString('base64'));
    assert.equal(body.image.bytes, 11);
    assert.equal(body.image.width, 1920);
    assert.equal(body.image.height, 1080);
    assert.equal(body.image.filePath, undefined);

    await logger.flushAnalysis();
    const bridgeLog = await fs.readFile(path.join(config.logger.currentRunDir, 'bridge.jsonl'), 'utf8');
    assert.match(bridgeLog, /desktop\.screenshot\.captured/);
    assert.doesNotMatch(bridgeLog, /filePath/);
  } finally {
    server.close();
  }
});

test('exposes live Codex session snapshot from completed tasks', async () => {
  const config = createTestConfig();
  const liveSession = {
    id: '019e-live-session',
    title: '手机测试会话',
    updatedAt: '2026-05-28T10:00:00.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    pinned: false,
    detailAvailable: true,
    filePath: '',
    entries: [
      {
        timestamp: '2026-05-28T10:00:00.000Z',
        type: 'userMessage',
        role: 'user',
        text: '你好'
      },
      {
        timestamp: '2026-05-28T10:00:01.000Z',
        type: 'agentMessage',
        role: 'assistant',
        text: '你好，我已开始工作。'
      }
    ],
    entryCount: 2
  };
  const adapter = {
    async run({ emit }) {
      emit('codex.app_server.thread.ready', {
        threadId: liveSession.id,
        sessionId: liveSession.id
      });
      return {
        summary: '你好，我已开始工作。',
        changedFiles: [],
        tests: [],
        session: liveSession
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '你好'
      })
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    assert.equal(task.createdCodexSessionId, liveSession.id);
    const taskResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const fetched = await taskResponse.json();
    assert.equal(fetched.task.session.id, liveSession.id);
    assert.deepEqual(fetched.task.session.entries.map((entry) => entry.text), ['你好', '你好，我已开始工作。']);
  } finally {
    server.close();
  }
});

test('returns lightweight task payloads by default and preserves full debug payloads', async () => {
  const config = createTestConfig();
  const largeText = 'x'.repeat(1200);
  const adapter = {
    async run({ emit }) {
      emit('codex.app_server.thread.read', {
        thread: {
          id: '019e-large-thread',
          turns: Array.from({ length: 60 }, (_, index) => ({
            id: `turn-${index}`,
            status: 'completed',
            items: [{ type: 'agentMessage', text: `${index}:${largeText}` }]
          }))
        }
      });
      for (let index = 0; index < 80; index += 1) {
        emit('codex.session_file.turn.waiting_terminal', {
          threadId: '019e-large-thread',
          message: `waiting ${index}`,
          blob: largeText
        });
      }
      return {
        summary: largeText,
        changedFiles: [],
        tests: [],
        exitCode: 0,
        session: {
          id: '019e-large-thread',
          title: '大响应测试',
          updatedAt: '2026-06-12T00:00:00.000Z',
          detailAvailable: true,
          entries: Array.from({ length: 120 }, (_, index) => ({
            timestamp: '2026-06-12T00:00:00.000Z',
            type: index % 2 === 0 ? 'userMessage' : 'agentMessage',
            role: index % 2 === 0 ? 'user' : 'assistant',
            text: largeText
          })),
          entryCount: 120
        }
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '触发大响应'
      })
    });
    const created = await createResponse.json();
    const task = await waitForTaskStatus(store, created.task.id, 'completed');

    const lightResponse = await fetch(`${baseUrl}/tasks/${task.id}`);
    const lightText = await lightResponse.text();
    assert.equal(lightResponse.status, 200);
    assert.ok(Buffer.byteLength(lightText) < 20 * 1024, `light payload was ${Buffer.byteLength(lightText)} bytes`);
    const light = JSON.parse(lightText);
    assert.equal(light.task.session.entries, undefined);
    assert.equal(light.task.session.latestEntry.text.length < largeText.length, true);
    assert.equal(light.task.events.length <= 8, true);
    assert.equal(light.task.events.some((event) => event.payload?.truncated === true), true);
    assert.equal(light.task.result, undefined);
    assert.equal(light.task.resultSummary.summary.length < largeText.length, true);

    const fullResponse = await fetch(`${baseUrl}/tasks/${task.id}?full=1`);
    const full = await fullResponse.json();
    assert.equal(full.task.session.entries.length, 120);
    assert.equal(full.task.events.length > light.task.events.length, true);
    assert.equal(full.task.result.session.entries.length, 120);
  } finally {
    server.close();
  }
});

test('deletes Codex threads through mobile POST alias', async () => {
  const deletedIds = [];
  const config = createTestConfig();
  config.threadService = {
    async deleteThread(threadId) {
      deletedIds.push(threadId);
      return {
        id: threadId,
        deletedFiles: ['rollout.jsonl'],
        archivedThreadCount: 1,
        removedIndexRecords: 1,
        removedGlobalStateEntries: 1
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-delete-session/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(deletedIds, ['019e-delete-session']);
    assert.equal(body.deleted.id, '019e-delete-session');
    assert.equal(body.deleted.archivedThreadCount, 1);
  } finally {
    server.close();
  }
});

test('deletes legacy Codex sessions through POST alias', async () => {
  const deletedIds = [];
  const config = createTestConfig();
  config.threadService = {
    async deleteThread(threadId) {
      deletedIds.push(threadId);
      return {
        id: threadId,
        deletedFiles: [],
        archivedThreadCount: 1,
        removedIndexRecords: 1,
        removedGlobalStateEntries: 0
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/codex/sessions/019e-delete-legacy/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(deletedIds, ['019e-delete-legacy']);
    assert.equal(body.deleted.id, '019e-delete-legacy');
    assert.equal(body.deleted.removedIndexRecords, 1);
  } finally {
    server.close();
  }
});

test('opens a legacy Codex session with the configured safe desktop opener', async () => {
  const openedIds = [];
  const config = createTestConfig();
  config.desktopOpener = async (threadId) => {
    openedIds.push(threadId);
    return {
      ok: true,
      sessionId: threadId,
      transport: 'cdp'
    };
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/codex/sessions/019e-open-session/open`, {
      method: 'POST'
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.deepEqual(openedIds, ['019e-open-session']);
    assert.equal(body.desktop.sessionId, '019e-open-session');
    assert.equal(body.desktop.transport, 'cdp');
  } finally {
    server.close();
  }
});

test('rejects invalid Codex session ids', async () => {
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话并检查项目',
        codexSessionId: '../bad'
      })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid Codex session id');
  } finally {
    server.close();
  }
});

test('rejects stale session fingerprints before sending to Codex', async () => {
  const config = createTestConfig();
  config.sessions = {
    async verifySessionTarget() {
      const error = new Error('手机端会话文件指纹已过期，已阻止发送。请重新打开这个会话后再发送。');
      error.statusCode = 409;
      throw error;
    }
  };
  const adapter = {
    async run() {
      throw new Error('should not run Codex for stale targets');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        prompt: '继续这个会话',
        codexSessionId: '019e-test-session',
        sessionFingerprint: {
          filePath: 'C:\\old\\rollout.jsonl'
        }
      })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.error, /会话文件指纹已过期/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('CodexSessionStore filters internal context from session details', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
    id: '019e-visible-session',
    thread_name: '可见会话',
    updated_at: '2026-05-28T00:00:00.000Z'
  })}\n`);
  await fs.writeFile(path.join(sessionDir, 'rollout-019e-visible-session.jsonl'), [
    JSON.stringify({
      timestamp: '2026-05-28T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: '<permissions instructions>\nsecret'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<environment_context>\nsecret'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '你好'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '你好，我会用中文继续。' }]
      }
    })
  ].join('\n'));

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession('019e-visible-session', { tail: 20 });
  assert.deepEqual(detail.entries.map((entry) => entry.text), ['你好', '你好，我会用中文继续。']);
});

test('projects endpoint returns the app-server-discovered project catalog', async () => {
  const config = createTestConfig();
  config.threadService = {
    async listProjects() {
      return [{
        id: 'codex-vibelution',
        name: 'Vibelution',
        root: 'C:\\projects\\Vibelution'
      }];
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/projects`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      projects: [{
        id: 'codex-vibelution',
        name: 'Vibelution',
        root: 'C:\\projects\\Vibelution'
      }]
    });
  } finally {
    server.close();
  }
});

test('uploads a permitted phone document and rejects sensitive or oversized files', async () => {
  const config = createTestConfig();
  config.mobileFilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-files-'));
  config.mobileFileMaxBytes = 12;
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const allowed = await fetch(`${baseUrl}/mobile/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'bridge.log',
        mimeType: 'text/plain',
        base64: Buffer.from('safe-log').toString('base64')
      })
    });
    assert.equal(allowed.status, 201);
    const uploaded = (await allowed.json()).file;
    assert.equal(uploaded.fileName.endsWith('-bridge.log'), true);
    assert.equal(uploaded.bytes, 8);
    assert.match(uploaded.messageText, /手机端文件/);
    assert.equal(await fs.readFile(uploaded.filePath, 'utf8'), 'safe-log');

    const sensitive = await fetch(`${baseUrl}/mobile/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: '.env',
        mimeType: 'text/plain',
        base64: Buffer.from('TOKEN=secret').toString('base64')
      })
    });
    assert.equal(sensitive.status, 415);

    const oversized = await fetch(`${baseUrl}/mobile/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'large.log',
        mimeType: 'text/plain',
        base64: Buffer.from('this-is-larger-than-twelve').toString('base64')
      })
    });
    assert.equal(oversized.status, 413);
  } finally {
    server.close();
  }
});

test('lists and answers structured App Server user input requests over HTTP', async () => {
  const config = createTestConfig();
  let receivedAnswers = null;
  config.threadService = {
    listUserInputs() {
      return [{
        id: 'input-1',
        runId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        status: 'pending',
        questions: [{
          id: 'choice',
          header: '选择',
          question: '是否继续？',
          isOther: false,
          isSecret: false,
          options: [{ label: '继续', description: '继续执行' }]
        }],
        autoResolutionMs: null,
        createdAt: '2026-07-29T00:00:00.000Z'
      }];
    },
    getUserInput(id) {
      return id === 'input-1' ? this.listUserInputs()[0] : null;
    },
    answerUserInput(id, answers) {
      receivedAnswers = answers;
      return { ...this.getUserInput(id), status: 'answered', answeredAt: '2026-07-29T00:00:01.000Z' };
    },
    runtimeHealth() {
      return { state: 'ready' };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const listResponse = await fetch(`${baseUrl}/user-inputs`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).userInputs[0].questions[0].id, 'choice');

    const answerResponse = await fetch(`${baseUrl}/user-inputs/input-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { choice: ['继续'] } })
    });
    assert.equal(answerResponse.status, 200);
    assert.deepEqual(receivedAnswers, { choice: ['继续'] });
    assert.equal((await answerResponse.json()).userInput.status, 'answered');
  } finally {
    server.close();
  }
});

test('requires token when CODEX_BRIDGE_TOKEN is set', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  const config = createTestConfig();
  config.threadService = {
    async listProjects() {
      return config.projects;
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rejected = await fetch(`${baseUrl}/projects`);
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${baseUrl}/projects`, {
      headers: { 'x-codex-bridge-token': 'secret-token' }
    });
    assert.equal(accepted.status, 200);
  } finally {
    server.close();
    if (previous === undefined) {
      delete process.env.CODEX_BRIDGE_TOKEN;
    } else {
      process.env.CODEX_BRIDGE_TOKEN = previous;
    }
  }
});

test('desktop script status exposes bridge token auth diagnostics', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    desktopScriptBridge.reset();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rejected = await fetch(`${baseUrl}/desktop/script/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'tokenless-script',
        currentSessionId: '019e-test-session'
      })
    });
    assert.equal(rejected.status, 401);

    const status = await fetch(`${baseUrl}/desktop/script/status`, {
      headers: { 'x-codex-bridge-token': 'secret-token' }
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.bridge.scriptAuth.required, true);
    assert.equal(body.bridge.scriptAuth.healthy, false);
    assert.equal(body.bridge.scriptAuth.unauthorizedCount, 1);
    assert.equal(body.bridge.scriptAuth.lastUnauthorizedRoute, '/desktop/script/connect');
  } finally {
    desktopScriptBridge.reset();
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('system link status degrades when desktop script bridge auth is failing but CDP is ready', async () => {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  const config = createTestConfig();
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({
    ok: true,
    severity: 'ok',
    message: 'relay ok'
  });
  config.linkHdcProbeProvider = async () => ({
    ok: true,
    severity: 'ok',
    message: 'hdc ok'
  });
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: sessionId ? 'verified' : 'ready',
        currentSessionId: sessionId || null,
        targetSessionId: sessionId,
        sessionVerified: Boolean(sessionId),
        transport: 'cdp',
        message: 'CDP ready'
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    desktopScriptBridge.reset();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rejected = await fetch(`${baseUrl}/desktop/script/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'tokenless-script' })
    });
    assert.equal(rejected.status, 401);

    const status = await fetch(`${baseUrl}/system/link/status?sessionId=019e-test-session`, {
      headers: { 'x-codex-bridge-token': 'secret-token' }
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.link.desktop.desktopLive, true);
    assert.equal(body.link.desktop.sessionVerified, true);
    assert.equal(body.link.severity, 'degraded');
    assert.equal(body.link.recommendedAction, 'reconnect_desktop_script');
    assert.equal(body.link.script.scriptAuth.healthy, false);
    assert.match(body.link.message, /脚本桥认证异常/);
  } finally {
    desktopScriptBridge.reset();
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previous);
  }
});

test('redacts query tokens from bridge request logs', async () => {
  const previousToken = process.env.CODEX_BRIDGE_TOKEN;
  const previousLogDir = process.env.CODEX_BRIDGE_LOG_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-logs-'));
  process.env.CODEX_BRIDGE_TOKEN = 'secret-token';
  process.env.CODEX_BRIDGE_LOG_DIR = root;
  const config = createTestConfig();
  config.threadService = {
    async listProjects() {
      return config.projects;
    }
  };
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/projects?token=secret-token`);
    assert.equal(response.status, 200);
    await logger.flushAnalysis();

    const bridgeLog = await fs.readFile(path.join(root, 'current-run', 'bridge.jsonl'), 'utf8');
    assert.match(bridgeLog, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
    assert.doesNotMatch(bridgeLog, /secret-token/);
  } finally {
    server.close();
    restoreEnv('CODEX_BRIDGE_TOKEN', previousToken);
    restoreEnv('CODEX_BRIDGE_LOG_DIR', previousLogDir);
  }
});

test('accepts batched mobile logs while keeping single log compatibility', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-batch-logs-'));
  const config = createTestConfig();
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const batchResponse = await fetch(`${baseUrl}/logs/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        logs: [
          { source: 'harmony-app', level: 'info', event: 'traffic.batch.one', data: 'first' },
          { source: 'harmony-app', level: 'warn', event: 'traffic.batch.two', data: { second: true } }
        ]
      })
    });
    assert.equal(batchResponse.status, 202);
    const batch = await batchResponse.json();
    assert.equal(batch.count, 2);

    const singleResponse = await fetch(`${baseUrl}/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'harmony-app', level: 'info', event: 'traffic.single', data: 'single' })
    });
    assert.equal(singleResponse.status, 202);
    await logger.flushAnalysis();

    const appLog = await fs.readFile(path.join(root, 'current-run', 'harmony-app.jsonl'), 'utf8');
    assert.match(appLog, /traffic\.batch\.one/);
    assert.match(appLog, /traffic\.batch\.two/);
    assert.match(appLog, /traffic\.single/);
  } finally {
    server.close();
  }
});

test('records actual HTTP response byte counts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-response-bytes-'));
  const config = createTestConfig();
  config.threadService = {
    async listProjects() {
      return config.projects;
    }
  };
  config.logger = new DiagnosticLogger({ root });
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/projects`);
    assert.equal(response.status, 200);
    await response.text();
    await logger.flushAnalysis();

    const bridgeLog = await fs.readFile(path.join(root, 'current-run', 'bridge.jsonl'), 'utf8');
    const completed = bridgeLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'http.request.completed' && entry.data.url === '/projects');
    assert.equal(completed.data.responseBytes > 0, true);
    assert.equal(completed.data.trafficClass, 'small');
  } finally {
    server.close();
  }
});

test('does not access-log desktop script bridge heartbeats', async () => {
  const config = createTestConfig();
  const { server, logger } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    desktopScriptBridge.reset();
    desktopScriptBridge.connect({
      scriptId: 'script-test',
      currentSessionId: '019e-test-session'
    }, { replace: true });
    const pending = desktopScriptBridge.request('thread/list', { limit: 1 });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/script/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'script-test',
        currentSessionId: '019e-test-session'
      })
    });
    assert.equal(response.status, 200);
    const polled = await response.json();
    assert.equal(polled.commands.length, 1);

    const messagesResponse = await fetch(`${baseUrl}/desktop/script/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
      scriptId: 'script-test',
      currentSessionId: '019e-test-session',
      messages: [{
        type: 'mcp-response',
        message: {
          id: polled.commands[0].request.id,
          result: { ok: true }
        }
      }]
      })
    });
    assert.equal(messagesResponse.status, 202);
    assert.deepEqual(await pending, { ok: true });

    await logger.flushAnalysis();
    const bridgeLog = await fs.readFile(path.join(config.logger.currentRunDir, 'bridge.jsonl'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    assert.doesNotMatch(bridgeLog, /http\.request\.completed.*desktop\/script\/poll/);
    assert.doesNotMatch(bridgeLog, /http\.request\.completed.*desktop\/script\/messages/);
  } finally {
    desktopScriptBridge.reset();
    server.close();
  }
});

test('rejects non-object JSON bodies with a 400', async () => {
  const config = createTestConfig();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(null)
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Request body must be a JSON object');
  } finally {
    server.close();
  }
});

test('creates new phone conversations through the strict desktop-backed task path by default', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/api/codex/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '你好',
        model: 'gpt-alt',
        reasoningEffort: 'medium',
        submissionId: 'strict-new-1'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.run.prompt, '你好');
    assert.equal(created.run.model, 'gpt-alt');
    assert.equal(created.run.reasoningEffort, 'medium');
    assert.equal(created.run.submissionId, 'strict-new-1');
    assert.equal(config.threadService.run, null);
    assert.equal(store.listTasks().length, 1);

    const task = await waitForTaskStatus(store, created.run.id, 'completed');
    assert.equal(task.createdCodexSessionId, '019e-new-desktop-session');
    assert.equal(task.codexSessionId, '019e-new-desktop-session');
    assert.equal(adapter.runs.length, 1);
    assert.equal(adapter.runs[0].codexSessionId, null);
    assert.equal(adapter.runs[0].model, 'gpt-alt');
    assert.equal(adapter.runs[0].reasoningEffort, 'medium');
  } finally {
    server.close();
  }
});

test('keeps App Server new-thread creation behind the explicit app-server-new-only mode', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-new-only';
  config.threadService = new FakeThreadService();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/api/codex/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '独立 App Server 新会话',
        model: 'gpt-alt',
        reasoningEffort: 'medium',
        submissionId: 'new-only-1'
      })
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.thread.id, 'thread-1');
    assert.equal(created.run.codexSessionId, 'thread-1');
    assert.equal(created.run.submissionId, 'new-only-1');
    assert.equal(config.threadService.run.model, 'gpt-alt');
    assert.equal(config.threadService.run.reasoningEffort, 'medium');
    assert.equal((await config.sessionSettings.getSessionSettings('thread-1')).model, 'gpt-alt');
    assert.equal((await config.sessionSettings.getSessionSettings('thread-1')).reasoningEffort, 'medium');
  } finally {
    server.close();
  }
});

test('rejects strict desktop new-thread creation immediately when CDP is offline', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  const adapter = {
    runs: 0,
    async getDesktopLiveStatus() {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: '',
        sessionVerified: false,
        transport: 'cdp',
        message: '桌面 CDP 离线'
      };
    },
    async run() {
      this.runs += 1;
      throw new Error('offline desktop must not start a task');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const createResponse = await fetch(`${baseUrl}/api/codex/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'probe', text: '不应旁路发送' })
    });
    const body = await createResponse.json();

    assert.equal(createResponse.status, 503);
    assert.match(body.error, /桌面实时通道不可用.*已阻止新建会话/);
    assert.equal(body.desktop.required, 'desktop_live');
    assert.equal(config.threadService.run, null);
    assert.equal(store.listTasks().length, 0);
    assert.equal(adapter.runs, 0);
  } finally {
    server.close();
  }
});

test('exposes Codex thread sync API with file cursors', async () => {
  const config = createTestConfig();
  const seen = {};
  config.threadService = {
    async listThreads() {
      return [];
    },
    async syncThread(threadId, params) {
      seen.threadId = threadId;
      seen.params = params;
      return {
        id: threadId,
        title: '同步会话',
        updatedAt: '2026-06-16T00:00:00Z',
        detailAvailable: true,
        filePath: 'C:\\sessions\\rollout.jsonl',
        entries: [{
          timestamp: '2026-06-16T00:00:01Z',
          type: 'event_msg',
          role: 'assistant',
          text: '增量回复',
          syncId: '10:20:assistant:event_msg:0',
          syncStartOffset: 10,
          syncEndOffset: 20
        }],
        entryCount: 1,
        sync: {
          mode: 'after',
          source: 'session-file',
          filePath: 'C:\\sessions\\rollout.jsonl',
          fileSize: 20,
          fileUpdatedAt: '2026-06-16T00:00:01Z',
          cursorStart: '10',
          cursorEnd: '20',
          hasMoreBefore: true,
          hasMoreAfter: false,
          entryCount: 1
        }
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-sync-thread/sync?limit=40&after=123`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(seen.threadId, '019e-sync-thread');
    assert.deepEqual(seen.params, { limit: '40', after: '123', before: '' });
    assert.equal(body.session.sync.cursorEnd, '20');
    assert.equal(body.session.entries[0].text, '增量回复');
  } finally {
    server.close();
  }
});

test('exposes the canonical Codex runtime snapshot API without changing legacy thread routes', async () => {
  const config = createTestConfig();
  config.threadService = {
    async listThreads() {
      return [{
        id: 'thread-runtime',
        title: '统一状态',
        updatedAt: '2026-07-30T09:00:00.000Z',
        activityStatus: 'running',
        detailAvailable: true
      }];
    },
    async getRuntimeSnapshot() {
      return {
        schemaVersion: 1,
        epoch: 'epoch-api',
        revision: 7,
        generatedAt: '2026-07-30T09:00:00.000Z',
        stale: false,
        sessions: [{
          threadId: 'thread-runtime',
          title: '统一状态',
          projectRoot: '',
          projectLabel: 'Codex',
          updatedAt: '2026-07-30T09:00:00.000Z',
          relativeTime: '刚刚',
          state: 'running',
          stateUpdatedAt: '2026-07-30T09:00:00.000Z',
          source: 'session-file',
          activeTurnId: 'turn-runtime',
          canInterrupt: true,
          terminalReason: '',
          lastVisibleRole: 'assistant',
          detailAvailable: true
        }]
      };
    }
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const runtimeResponse = await fetch(`${baseUrl}/api/codex/runtime-snapshot`);
    const runtime = await runtimeResponse.json();
    const legacyResponse = await fetch(`${baseUrl}/api/codex/threads?limit=10`);
    const legacy = await legacyResponse.json();

    assert.equal(runtimeResponse.status, 200);
    assert.equal(runtime.epoch, 'epoch-api');
    assert.equal(runtime.revision, 7);
    assert.equal(runtime.sessions[0].activeTurnId, 'turn-runtime');
    assert.equal(legacyResponse.status, 200);
    assert.equal(legacy.threads[0].id, 'thread-runtime');
  } finally {
    server.close();
  }
});

test('persists per-session reasoning effort settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'xhigh';
  config.threadService = new FakeThreadService();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const updateResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-alt', reasoningEffort: 'high' })
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.settings.model, 'gpt-alt');
    assert.equal(updated.settings.defaultModel, 'gpt-test');
    assert.equal(updated.settings.effectiveModel, 'gpt-alt');
    assert.equal(updated.settings.modelSource, 'session');
    assert.equal(updated.settings.modelOptions.length, 2);
    assert.equal(updated.settings.reasoningEffort, 'high');
    assert.equal(updated.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(updated.settings.effectiveReasoningEffort, 'high');
    assert.equal(updated.settings.reasoningEffortSource, 'session');

    const getResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const fetched = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(fetched.settings.model, 'gpt-alt');
    assert.equal(fetched.settings.defaultModel, 'gpt-test');
    assert.equal(fetched.settings.effectiveModel, 'gpt-alt');
    assert.equal(fetched.settings.reasoningEffort, 'high');
    assert.equal(fetched.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(fetched.settings.effectiveReasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('exposes desktop default reasoning effort for automatic session settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'xhigh';
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const globalResponse = await fetch(`${baseUrl}/api/codex/settings`);
    const globalBody = await globalResponse.json();
    assert.equal(globalResponse.status, 200);
    assert.equal(globalBody.settings.model, '');
    assert.equal(globalBody.settings.defaultModel, 'gpt-test');
    assert.equal(globalBody.settings.effectiveModel, 'gpt-test');
    assert.equal(globalBody.settings.modelSource, 'desktop');
    assert.equal(globalBody.settings.modelOptions.length, 2);
    assert.equal(globalBody.settings.reasoningEffort, '');
    assert.equal(globalBody.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(globalBody.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(globalBody.settings.reasoningEffortSource, 'desktop');

    const sessionResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionBody.settings.model, '');
    assert.equal(sessionBody.settings.defaultModel, 'gpt-test');
    assert.equal(sessionBody.settings.effectiveModel, 'gpt-test');
    assert.equal(sessionBody.settings.reasoningEffort, '');
    assert.equal(sessionBody.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(sessionBody.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(sessionBody.settings.reasoningEffortSource, 'desktop');
  } finally {
    server.close();
  }
});

test('default settings endpoint reads the managed App Server model catalog before CDP fallback', async () => {
  const config = createTestConfig();
  delete config.codexSettingsProvider;
  const threadService = new FakeThreadService();
  const calls = [];
  threadService.requestAppServer = async (method) => {
    calls.push(method);
    if (method === 'config/read') {
      return { config: { model: 'gpt-5.6-terra', model_reasoning_effort: 'high' } };
    }
    if (method === 'model/list') {
      return {
        data: [
          { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
          { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }
        ]
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  config.threadService = threadService;
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/settings`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.settings.modelCatalogSource, 'app_server');
    assert.equal(body.settings.defaultModel, 'gpt-5.6-terra');
    assert.deepEqual(body.settings.modelOptions.map((model) => model.id), [
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-5.6-luna'
    ]);
    assert.deepEqual(calls, ['config/read', 'model/list']);
  } finally {
    server.close();
  }
});

test('exposes Codex account usage from the configured usage provider', async () => {
  const config = createTestConfig();
  let called = false;
  config.accountUsageProvider = async () => {
    called = true;
    return {
      ok: true,
      status: 'available',
      source: 'test_provider',
      checkedAt: '2026-06-14T00:00:00.000Z',
      planName: 'Pro',
      usageText: '本月已用 12%',
      balanceText: '剩余额度 88%',
      items: [{
        kind: 'plan',
        label: '套餐',
        value: 'Pro'
      }]
    };
  };
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/account/usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.equal(body.usage.ok, true);
    assert.equal(body.usage.source, 'test_provider');
    assert.equal(body.usage.planName, 'Pro');
    assert.equal(body.usage.items[0].label, '套餐');
  } finally {
    server.close();
  }
});

test('sends existing phone thread messages through the desktop-backed task path', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let desktopOpenCalled = false;
  config.desktopOpener = async () => {
    desktopOpenCalled = true;
    throw new Error('should not open desktop thread during phone send');
  };
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        },
        model: 'gpt-alt',
        reasoningEffort: 'high'
      })
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(body.run.prompt, '继续');
    assert.equal(store.listTasks().length, 1);
    assert.equal(config.threadService.sentMessages.length, 0);
    assert.equal(desktopOpenCalled, false);
    assert.equal(adapter.runs.length, 1);
    assert.equal(adapter.runs[0].codexSessionId, '019e-test-session');
    assert.equal(adapter.runs[0].model, 'gpt-alt');

    const task = await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(task.result.desktopSync.status, 'desktop_live');

    const runResponse = await fetch(`${baseUrl}/api/codex/runs/${body.run.id}`);
    const runBody = await runResponse.json();
    assert.equal(runResponse.status, 200);
    assert.equal(runBody.run.id, body.run.id);
    assert.equal(runBody.run.status, 'completed');
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'high');
    assert.equal(adapter.runs[0].reasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('deduplicates strict desktop phone retries by submission id', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const send = () => fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '只发送一次',
        submissionId: 'strict-existing-1',
        sessionFingerprint: testSessionFingerprint()
      })
    });

    const firstResponse = await send();
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 202);
    await waitForTaskStatus(store, first.run.id, 'completed');

    const secondResponse = await send();
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 202);
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.run.submissionId, 'strict-existing-1');
    assert.equal(store.listTasks().length, 1);
    assert.equal(adapter.runs.length, 1);
    assert.equal(
      store.getTask(first.run.id).events.some((event) => event.type === 'task.duplicate_submission_ignored'),
      true
    );
  } finally {
    server.close();
  }
});

test('steers a running desktop task immediately instead of leaving guidance stuck in the outbox', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-outbox-steer-'));
  const config = createTestConfig();
  config.outboxEnabled = true;
  config.outboxPath = path.join(root, 'outbox.json');
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const steered = [];
  let finishRun = () => {};
  const adapter = {
    async run({ task, emit }) {
      emit('codex.app_server.turn.started', {
        threadId: task.codexSessionId,
        turn: { id: 'turn-running', status: 'inProgress' }
      });
      return await new Promise((resolve) => {
        finishRun = () => resolve({
          summary: 'done',
          changedFiles: [],
          tests: [],
          session: { id: task.codexSessionId, entries: [] },
          desktopSync: { status: 'desktop_live', desktopLive: true },
          exitCode: 0
        });
      });
    },
    async steer({ task, prompt, emit }) {
      steered.push({ taskId: task.id, prompt });
      emit('codex.app_server.turn.steered', {
        threadId: task.codexSessionId,
        turnId: task.activeCodexTurnId
      });
      return {
        accepted: true,
        threadId: task.codexSessionId,
        turnId: task.activeCodexTurnId
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const running = store.createTask({
      projectId: 'probe',
      prompt: '第一条消息仍在处理',
      codexSessionId: '019e-test-session',
      sessionFingerprint: testSessionFingerprint(),
      verifiedSessionTarget: testSessionFingerprint()
    });
    await until(() => store.getTask(running.id)?.activeCodexTurnId === 'turn-running');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '这是运行中的引导消息',
        submissionId: 'desktop-guidance-1',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.id, running.id);
    assert.equal(body.run.status, 'running');
    assert.deepEqual(steered, [{
      taskId: running.id,
      prompt: '这是运行中的引导消息'
    }]);
    assert.equal(store.listTasks().length, 1);
    assert.equal(body.outbox.status, 'submitted');
    assert.equal(body.outbox.resultId, running.id);
    finishRun();
    await waitForTaskStatus(store, running.id, 'completed');
    finishRun = () => {};
  } finally {
    finishRun();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries a safely failed strict desktop outbox submission with the same id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-outbox-retry-'));
  const config = createTestConfig();
  config.outboxEnabled = true;
  config.outboxPath = path.join(root, 'outbox.json');
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const originalRun = adapter.run.bind(adapter);
  adapter.run = async (context) => {
    if (adapter.runs.length === 0) {
      adapter.runs.push({
        id: context.task.id,
        codexSessionId: context.task.codexSessionId,
        prompt: context.task.prompt
      });
      throw new Error('Codex 桌面恢复会话后 CDP 未稳定：Codex 桌面 CDP 连接错误');
    }
    return await originalRun(context);
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const send = () => fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '失败前未创建 turn，可以安全重试',
        submissionId: 'strict-existing-safe-retry-1',
        sessionFingerprint: testSessionFingerprint()
      })
    });

    const firstResponse = await send();
    const first = await firstResponse.json();
    await waitForTaskStatus(store, first.run.id, 'failed');

    const secondResponse = await send();
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 202);
    assert.notEqual(second.run.id, first.run.id);
    await waitForTaskStatus(store, second.run.id, 'completed');
    assert.equal(adapter.runs.length, 2);
    assert.equal(store.listTasks().length, 2);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('routes an App Server primary phone message without a desktop CDP preflight', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-primary';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = {
    checked: 0,
    async getDesktopLiveStatus() {
      this.checked += 1;
      throw new Error('primary App Server path must not check CDP');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '直接交给 App Server',
        model: 'gpt-alt',
        reasoningEffort: 'high',
        submissionId: 'primary-send-1',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.runtime.kind, 'app_server');
    assert.equal(body.run.submissionId, 'primary-send-1');
    assert.equal(config.threadService.sentMessages.length, 1);
    assert.deepEqual(config.threadService.sentMessages[0], {
      threadId: '019e-test-session',
      text: '直接交给 App Server',
      model: 'gpt-alt',
      reasoningEffort: 'high',
      submissionId: 'primary-send-1'
    });
    assert.equal(store.listTasks().length, 0);
    assert.equal(adapter.checked, 0);
  } finally {
    server.close();
  }
});

test('desktop-primary falls back to App Server only when desktop preflight is unavailable', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'desktop-primary';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = {
    checkedSessionId: '',
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      this.checkedSessionId = sessionId;
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        targetSessionId: sessionId,
        currentSessionId: null,
        sessionVerified: false,
        transport: 'cdp',
        message: '桌面实时通道未连接'
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '桌面不在线时的受控兜底',
        submissionId: 'desktop-primary-fallback-1',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.runtime.kind, 'app_server');
    assert.equal(config.threadService.sentMessages.length, 1);
    assert.deepEqual(config.threadService.sentMessages[0], {
      threadId: '019e-test-session',
      text: '桌面不在线时的受控兜底',
      model: 'gpt-test',
      reasoningEffort: '',
      submissionId: 'desktop-primary-fallback-1'
    });
    assert.deepEqual(config.threadService.deliveryModes, ['desktop_fallback']);
    assert.equal(adapter.checkedSessionId, '019e-test-session');
    assert.equal(store.listTasks().length, 0);

    const interruptResponse = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/interrupt`, {
      method: 'POST'
    });
    assert.equal(interruptResponse.status, 200);
    assert.deepEqual(config.threadService.interruptedThreads, ['019e-test-session']);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('reports the selected App Server execution contract and active run through health and tasks', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-primary';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await config.threadService.sendMessage({
      threadId: '019e-test-session',
      text: '正在恢复的运行',
      submissionId: 'health-run-1'
    });
    const healthResponse = await fetch(`${baseUrl}/health?threadId=019e-test-session`);
    const health = await healthResponse.json();
    const tasksResponse = await fetch(`${baseUrl}/tasks`);
    const tasks = await tasksResponse.json();

    assert.equal(healthResponse.status, 200);
    assert.equal(health.runtime.mode, 'app-server-primary');
    assert.equal(health.runtime.existingThreadExecution, 'app_server');
    assert.equal(health.runtime.appServer.kind, 'app_server');
    assert.equal(tasksResponse.status, 200);
    assert.equal(tasks.tasks.some((task) => task.id === 'run-2' && task.runtime?.kind === 'app_server'), true);
  } finally {
    server.close();
  }
});

test('strict desktop runtime disables the internally constructed independent App Server service', () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'desktop';

  const { threadService } = createApp({ config, adapter: new MockCodexAdapter() });

  assert.deepEqual(threadService.runtimeHealth(), {
    kind: 'app_server',
    enabled: false,
    state: 'disabled',
    reason: 'strict_desktop_mode',
    generation: 0,
    pendingRequests: 0,
    reconnectAttempts: 0,
    reconnectScheduled: false,
    recoveredRuns: 0,
    pendingApprovals: 0,
    pendingUserInputs: 0
  });
});

test('uses only configured existing threads in App Server canary mode', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-canary';
  config.appServerCanaryThreadIds = ['019e-canary-session'];
  config.threadService = new FakeThreadService();
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const selectedResponse = await fetch(`${baseUrl}/health?threadId=019e-canary-session`);
    const otherResponse = await fetch(`${baseUrl}/health?threadId=019e-other-session`);
    const selected = await selectedResponse.json();
    const other = await otherResponse.json();

    assert.equal(selected.runtime.existingThreadExecution, 'app_server');
    assert.equal(other.runtime.existingThreadExecution, 'canary');
  } finally {
    server.close();
  }
});

test('interrupts the active primary App Server run by its thread without falling back to the desktop task store', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-primary';
  config.threadService = new FakeThreadService();
  const { server, store } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await config.threadService.sendMessage({ threadId: '019e-test-session', text: '中断我' });
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/interrupt`, {
      method: 'POST'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.run.status, 'interrupted');
    assert.deepEqual(config.threadService.interruptedThreads, ['019e-test-session']);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('uses stored reasoning effort when a phone thread message omits it', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  await config.sessionSettings.updateSessionSettings('019e-test-session', { model: 'gpt-alt', reasoningEffort: 'xhigh' });
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'xhigh');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-alt');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'xhigh');
  } finally {
    server.close();
  }
});

test('uses desktop default reasoning effort when phone thread message is automatic', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        reasoningEffort: '',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-test');
    assert.equal(body.run.reasoningEffort, 'high');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-test');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'high');
  } finally {
    server.close();
  }
});

test('reports desktop per-thread reasoning effort for automatic session settings', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.sessions = new FakeSessionVerifier({
    modelBySessionId: new Map([['019e-test-session', 'gpt-alt']]),
    reasoningEffortBySessionId: new Map([['019e-test-session', 'xhigh']])
  });
  const { server } = createApp({ config, adapter: new MockCodexAdapter() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/settings`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.settings.reasoningEffort, '');
    assert.equal(body.settings.defaultModel, 'gpt-alt');
    assert.equal(body.settings.effectiveModel, 'gpt-alt');
    assert.equal(body.settings.modelSource, 'desktop');
    assert.equal(body.settings.defaultReasoningEffort, 'xhigh');
    assert.equal(body.settings.effectiveReasoningEffort, 'xhigh');
    assert.equal(body.settings.reasoningEffortSource, 'desktop');
  } finally {
    server.close();
  }
});

test('uses desktop per-thread reasoning effort when automatic phone thread message is sent', async () => {
  const config = createTestConfig();
  config.defaultReasoningEffortProvider = async () => 'high';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier({
    modelBySessionId: new Map([['019e-test-session', 'gpt-alt']]),
    reasoningEffortBySessionId: new Map([['019e-test-session', 'xhigh']])
  });
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        reasoningEffort: '',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.model, 'gpt-alt');
    assert.equal(body.run.reasoningEffort, 'xhigh');
    await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(adapter.runs[0]?.model, 'gpt-alt');
    assert.equal(adapter.runs[0]?.reasoningEffort, 'xhigh');
  } finally {
    server.close();
  }
});

test('rejects existing phone thread messages without a session fingerprint', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = new DesktopVerifiedAdapter();
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'probe', text: '继续' })
    });

    const body = await response.json();
    assert.equal(response.status, 409);
    assert.match(body.error, /缺少会话指纹/);
    assert.equal(store.listTasks().length, 0);
    assert.equal(adapter.runs.length, 0);
  } finally {
    server.close();
  }
});

test('rejects existing phone thread messages before creating a task when desktop is not verified', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      this.checkedSessionId = sessionId;
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run({ task, emit }) {
      throw new Error('should not reach adapter run without verified desktop live');
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error, /桌面 App Server 未确认手机选择的目标会话/);
    assert.equal(body.desktop.targetSessionId, '019e-test-session');
    assert.equal(body.desktop.required, 'desktop_live_verified_target');
    assert.equal(body.preflight.canSend, false);
    assert.equal(body.preflight.recommendedAction, 'soft_recover_live_host');
    assert.equal(store.listTasks().length, 0);
    assert.equal(config.threadService.sentMessages.length, 0);
    assert.equal(adapter.checkedSessionId, '019e-test-session');
  } finally {
    server.close();
  }
});

test('sends an existing phone thread through the desktop app-server while desktop shows another session', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let runCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: 'target_ready',
        message: '桌面 App Server 已确认目标会话；桌面当前页面无需切换。',
        currentSessionId: '019e-other-session',
        targetSessionId: sessionId,
        sessionVerified: false,
        targetVerified: true,
        transport: 'cdp'
      };
    },
    async run({ task, emit }) {
      runCalled = true;
      emit('codex.app_server.thread.ready', {
        threadId: task.codexSessionId,
        sessionId: task.codexSessionId
      });
      return {
        summary: 'desktop app-server completed target thread',
        changedFiles: [],
        tests: [],
        session: { id: task.codexSessionId, entries: [] },
        desktopSync: { status: 'desktop_live', desktopLive: true },
        exitCode: 0
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    const completed = await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(completed.verifiedDesktopStatus.status, 'target_ready');
    assert.equal(completed.verifiedDesktopStatus.sessionVerified, false);
    assert.equal(completed.verifiedDesktopStatus.targetVerified, true);
    assert.equal(completed.verifiedDesktopStatus.preflight.recommendedAction, 'none');
    assert.equal(completed.verifiedDesktopStatus.preflight.currentSessionId, '019e-other-session');
    assert.equal(completed.verifiedDesktopStatus.preflight.targetSessionId, '019e-test-session');
    assert.equal(runCalled, true);
    assert.equal(config.threadService.sentMessages.length, 0);
  } finally {
    server.close();
  }
});

test('waits for desktop verification before creating an existing phone thread task', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let releaseVerification;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      await new Promise((resolve) => {
        releaseVerification = resolve;
      });
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '慢校验后已确认当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      };
    },
    async run({ task, emit }) {
      emit('codex.desktop_sync', {
        status: 'desktop_live',
        desktopLive: true,
        mode: 'resume'
      });
      return {
        summary: 'done',
        changedFiles: [],
        tests: [],
        session: { id: task.codexSessionId, entries: [] },
        desktopSync: { status: 'desktop_live', desktopLive: true },
        exitCode: 0
      };
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let resolved = false;
    const responsePromise = fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    }).then((response) => {
      resolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false);
    assert.equal(store.listTasks().length, 0);
    releaseVerification();
    const response = await responsePromise;
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.match(store.getTask(body.run.id).status, /^(running|completed)$/);
    await waitForTaskStatus(store, body.run.id, 'completed');
  } finally {
    server.close();
  }
});

test('soft-recovers desktop live before sending an existing phone thread task', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-shadow';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let recoverCalled = false;
  let recovered = false;
  let runCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return recovered ? {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '软恢复后已校验当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      } : {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run({ task, emit }) {
      runCalled = true;
      emit('codex.desktop_sync', {
        status: 'desktop_live',
        desktopLive: true,
        mode: 'resume'
      });
      return {
        summary: 'done',
        changedFiles: [],
        tests: [],
        session: { id: task.codexSessionId, entries: [] },
        desktopSync: { status: 'desktop_live', desktopLive: true },
        exitCode: 0
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId }) {
      assert.equal(sessionId, '019e-test-session');
      recoverCalled = true;
      recovered = true;
      return { attempted: true, ok: true };
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: {
          title: '测试会话',
          projectRoot: 'C:\\work',
          projectLabel: 'work',
          filePath: 'C:\\sessions\\rollout.jsonl',
          entryCount: 2
        }
      })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.run.codexSessionId, '019e-test-session');
    assert.equal(store.listTasks().length, 1);
    const task = await waitForTaskStatus(store, body.run.id, 'completed');
    assert.equal(task.verifiedDesktopStatus.recoveryAttempted, true);
    assert.equal(task.verifiedDesktopStatus.recoveryOk, true);
    assert.equal(recoverCalled, true);
    assert.equal(runCalled, true);
  } finally {
    server.close();
  }
});

test('strict desktop mode reports an existing-thread CDP failure without auto recovery', async () => {
  const config = createTestConfig();
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let recoverCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面 CDP 离线',
        targetSessionId: sessionId,
        sessionVerified: false,
        transport: 'cdp'
      };
    },
    async run() {
      throw new Error('strict offline request must not run');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recoverCalled = true;
    }
  };
  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '不要降级或恢复',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /桌面 App Server 未确认手机选择的目标会话/);
    assert.equal(recoverCalled, false);
    assert.equal(store.listTasks().length, 0);
    assert.equal(config.threadService.sentMessages.length, 0);
  } finally {
    server.close();
  }
});

test('reports soft recovery failure without running an existing phone thread task', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-shadow';
  config.threadService = new FakeThreadService();
  config.sessions = new FakeSessionVerifier();
  let recoverCalled = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not reach adapter run after failed soft recovery');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId }) {
      assert.equal(sessionId, '019e-test-session');
      recoverCalled = true;
      throw new Error('未找到现有 Codex CDP 端口，软恢复已停止');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/codex/threads/019e-test-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'probe',
        text: '继续',
        sessionFingerprint: testSessionFingerprint()
      })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /桌面 App Server 未确认手机选择的目标会话/);
    assert.equal(body.preflight.recommendedAction, 'desktop_cdp_restart_required');
    assert.equal(body.preflight.requiresHardRecovery, true);
    assert.match(body.preflight.recoveryError, /软恢复已停止/);
    assert.equal(store.listTasks().length, 0);
    assert.equal(recoverCalled, true);
  } finally {
    server.close();
  }
});

for (const scenario of [
  { name: 'confirmed hard restart runs while online', mode: 'hard', confirmed: true, result: { attempted: true, ok: true, mode: 'hard' }, calls: 1, repaired: true },
  { name: 'unconfirmed hard restart stays blocked while online', mode: 'hard', confirmed: false, calls: 0, repaired: false },
  { name: 'soft repair keeps an online desktop running', mode: 'soft', confirmed: false, calls: 0, repaired: false },
  { name: 'cooldown is not reported as a completed hard restart', mode: 'hard', confirmed: true, result: { attempted: false, skipped: true, reason: 'cooldown' }, calls: 1, repaired: false },
  { name: 'inflight soft recovery is not reported as a hard restart', mode: 'hard', confirmed: true, result: { attempted: true, ok: true, mode: 'soft' }, calls: 1, repaired: false }
]) {
  test(`system repair ${scenario.name}`, async () => {
    const config = createTestConfig();
    let calls = 0;
    config.desktopLiveRecovery = { async recover() { calls++; return scenario.result; } };
    const adapter = { async getDesktopLiveStatus() {
      return { ok: true, desktopLive: true, status: 'verified', sessionVerified: true };
    } };
    const { server } = createApp({ config, adapter });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/system/repair/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: scenario.mode, confirmHardRestart: scenario.confirmed })
      });
      const { system } = await response.json();
      assert.equal(response.status, 200);
      assert.equal(calls, scenario.calls);
      assert.equal(system.repaired, scenario.repaired);
    } finally { server.close(); }
  });
}

test('manually recovers desktop live from explicit recover endpoint', async () => {
  const config = createTestConfig();
  let recovered = false;
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return recovered ? {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '手动恢复后已校验当前会话',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      } : {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover({ sessionId, reason }) {
      assert.equal(sessionId, '019e-test-session');
      assert.match(reason, /manual:mobile_button/);
      recovered = true;
      return { attempted: true, ok: true };
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, true);
    assert.equal(body.desktop.desktopLive, true);
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, true);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('returns manual desktop recovery errors without creating a task', async () => {
  const config = createTestConfig();
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面脚本桥未连接',
        reason: 'desktop script heartbeat timeout',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover(status) {
      return status.desktopLive === false;
    },
    async recover() {
      throw new Error('恢复脚本失败');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, false);
    assert.match(body.desktop.reason, /手动恢复失败/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop recovery skips soft script when Codex lacks CDP', async () => {
  const config = createTestConfig();
  let recoverCalled = false;
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recoverCalled = true;
      throw new Error('should not run recovery script');
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recoverCalled, false);
    assert.equal(body.desktop.recoveryAttempted, false);
    assert.equal(body.desktop.recoveryOk, false);
    assert.equal(body.desktop.requiresDesktopCdp, true);
    assert.equal(body.desktop.mobileRecoverable, false);
    assert.equal(body.desktop.failureClass, 'codex_plain_no_cdp');
    assert.match(body.desktop.recoveryError, /手机端软恢复无法接入|CDP/);
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop recovery can hard-restart CDP when requested by the phone', async () => {
  const config = createTestConfig();
  let recovered = false;
  let recoveryMode = '';
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return {
          failureClass: 'none',
          desktopProcessMode: 'cdp',
          requiresDesktopCdp: false,
          mobileRecoverable: true,
          cdpPort: 9229
        };
      }
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover(input) {
      recoveryMode = input.mode;
      recovered = true;
      return { attempted: true, ok: true, mode: input.mode };
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      if (recovered) {
        return {
          ok: true,
          desktopLive: true,
          status: 'ready',
          message: '桌面实时通道已连接',
          currentSessionId: sessionId,
          targetSessionId: sessionId,
          sessionVerified: true
        };
      }
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server, store } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: '019e-test-session',
        reason: 'mobile_button',
        mode: 'hard',
        confirmHardRestart: true
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recoveryMode, 'hard');
    assert.equal(body.desktop.recoveryAttempted, true);
    assert.equal(body.desktop.recoveryOk, true);
    assert.equal(body.desktop.desktopLive, true);
    assert.equal(body.desktop.sessionVerified, true);
    assert.equal(body.desktop.failureClass, 'none');
    assert.equal(store.listTasks().length, 0);
  } finally {
    server.close();
  }
});

test('manual desktop hard recovery is blocked without explicit confirmation', async () => {
  const config = createTestConfig();
  let recovered = false;
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return { failureClass: 'none', desktopProcessMode: 'cdp', requiresDesktopCdp: false, mobileRecoverable: true };
      }
      return { failureClass: 'codex_plain_no_cdp', desktopProcessMode: 'plain', requiresDesktopCdp: true, mobileRecoverable: false };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/desktop/live/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', reason: 'mobile_button', mode: 'hard' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(body.desktop.recoveryAttempted, false);
    assert.equal(body.desktop.recoveryOk, false);
    assert.match(body.desktop.recoveryError, /缺少明确确认/);
  } finally {
    server.close();
  }
});

test('system repair status blocks phone hard recovery when Codex lacks CDP', async () => {
  const config = createTestConfig();
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        codexProcessId: 45284,
        codexProcessCount: 1,
        liveHostRunning: false,
        cdpPort: null,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'connect ECONNREFUSED 127.0.0.1:9229',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/repair/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.system.desktop.failureClass, 'codex_plain_no_cdp');
    assert.equal(body.system.recommendedAction, 'desktop_cdp_restart_required');
    assert.equal(body.system.recoverableFromPhone, false);
    assert.equal(body.system.sessions.ok, true);
  } finally {
    server.close();
  }
});

test('system repair run does not choose hard recovery automatically for missing CDP', async () => {
  const config = createTestConfig();
  let recovered = false;
  let recoveryMode = '';
  config.desktopLiveDiagnostics = {
    async inspect(status) {
      if (status.desktopLive === true) {
        return {
          failureClass: 'none',
          desktopProcessMode: 'cdp',
          requiresDesktopCdp: false,
          mobileRecoverable: true,
          cdpPort: 9229
        };
      }
      return {
        failureClass: 'codex_not_running',
        desktopProcessMode: 'missing',
        codexProcessCount: 0,
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover(input) {
      recoveryMode = input.mode;
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      if (recovered) {
        return {
          ok: true,
          desktopLive: true,
          status: 'ready',
          message: '桌面实时通道已连接',
          currentSessionId: sessionId,
          targetSessionId: sessionId,
          sessionVerified: true
        };
      }
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: 'no Codex process',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/repair/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', mode: 'auto' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(recoveryMode, '');
    assert.equal(body.system.repaired, false);
    assert.equal(body.system.repairMode, 'none');
    assert.equal(body.system.hardRecoveryRequired, true);
    assert.equal(body.system.desktop.desktopLive, false);
    assert.equal(body.system.recommendedAction, 'desktop_cdp_restart_required');
  } finally {
    server.close();
  }
});

test('system link status reports HDC degradation without blocking desktop sessions', async () => {
  const config = createTestConfig();
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({
    ok: true,
    bridgeOnline: true,
    hdcActive: false,
    message: '公网 bridge 正常，无线 HDC 未配对'
  });
  config.linkHdcProbeProvider = async () => ({
    ok: false,
    proxyListening: true,
    connected: false,
    shellReady: false,
    message: 'HDC proxy 正在监听，但 hdc target 未连接'
  });
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '桌面实时通道已连接',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.link.desktop.desktopLive, true);
    assert.equal(body.link.desktop.sessionVerified, true);
    assert.equal(body.link.relay.ok, true);
    assert.equal(body.link.hdc.ok, false);
    assert.equal(body.link.severity, 'degraded');
    assert.equal(body.link.ok, true);
    assert.equal(body.link.recommendedAction, 'reconnect_hdc');
  } finally {
    server.close();
  }
});

test('system link status does not require desktop CDP for an app-server primary session', async () => {
  const config = createTestConfig();
  config.appServerRuntimeMode = 'app-server-primary';
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({
    ok: true,
    bridgeOnline: true,
    message: 'relay ok'
  });
  config.linkHdcProbeProvider = async () => ({
    ok: true,
    proxyListening: true,
    connected: true,
    shellReady: true,
    message: 'hdc ok'
  });
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: '普通启动态，没有 CDP',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.link.executionMode, 'app_server');
    assert.equal(body.link.desktopRequired, false);
    assert.equal(body.link.desktop.desktopLive, false);
    assert.equal(body.link.severity, 'ok');
    assert.equal(body.link.ok, true);
    assert.equal(body.link.recommendedAction, 'none');
  } finally {
    server.close();
  }
});

test('system link status treats local HDC shell readiness as usable even when public relay pairing is idle', async () => {
  const config = createTestConfig();
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({
    ok: true,
    bridgeOnline: true,
    hdcActive: false,
    phoneWaiting: false,
    pcWaiting: false,
    message: '公网 bridge 正常，无线 HDC 未配对'
  });
  config.linkHdcProbeProvider = async () => ({
    ok: true,
    proxyListening: true,
    connected: true,
    shellReady: true,
    message: 'HDC proxy 已连接且 shell 可用'
  });
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        message: '桌面实时通道已连接',
        currentSessionId: sessionId,
        targetSessionId: sessionId,
        sessionVerified: true
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/status?sessionId=019e-test-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.link.severity, 'ok');
    assert.equal(body.link.ok, true);
    assert.equal(body.link.recommendedAction, 'none');
    assert.equal(body.link.hdc.localHdcUsable, true);
    assert.equal(body.link.relay.publicRelayPaired, false);
    assert.equal(body.link.relay.publicRelayRecoverable, true);
  } finally {
    server.close();
  }
});

test('system link recover refuses to auto-restart Codex when CDP requires hard recovery', async () => {
  const config = createTestConfig();
  let recovered = false;
  config.sessions = {
    async listSessions() {
      return [{ id: '019e-test-session', title: 'Test Session' }];
    }
  };
  config.linkRelayProbeProvider = async () => ({ ok: true, bridgeOnline: true, message: 'relay ok' });
  config.linkHdcProbeProvider = async () => ({ ok: true, proxyListening: true, connected: true, shellReady: true, message: 'hdc ok' });
  config.desktopLiveDiagnostics = {
    async inspect() {
      return {
        failureClass: 'codex_plain_no_cdp',
        desktopProcessMode: 'plain',
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
  };
  config.desktopLiveRecovery = {
    shouldRecover() {
      return true;
    },
    async recover() {
      recovered = true;
    }
  };
  const adapter = {
    async getDesktopLiveStatus(timeoutMs, sessionId) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        message: '桌面实时通道未连接',
        reason: '普通启动态，没有 CDP',
        targetSessionId: sessionId,
        sessionVerified: false
      };
    },
    async run() {
      throw new Error('should not create task');
    }
  };

  const { server } = createApp({ config, adapter });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/system/link/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '019e-test-session', mode: 'auto' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(recovered, false);
    assert.equal(body.link.repaired, false);
    assert.equal(body.link.repairMode, 'blocked');
    assert.equal(body.link.recommendedAction, 'desktop_cdp_restart_required');
    assert.equal(body.link.recoverableFromPhone, false);
  } finally {
    server.close();
  }
});

async function waitForApproval(store, taskId) {
  for (let i = 0; i < 100; i += 1) {
    const approval = [...store.approvals.values()].find((candidate) => {
      return candidate.taskId === taskId && candidate.status === 'pending';
    });
    if (approval) {
      return approval;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for approval');
}

async function waitForTaskStatus(store, taskId, status) {
  for (let i = 0; i < 100; i += 1) {
    const task = store.getTask(taskId);
    if (task?.status === status) {
      return task;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for task status ${status}`);
}

class FakeThreadService {
  constructor() {
    this.run = null;
    this.sentMessages = [];
    this.deliveryModes = [];
  }

  async listThreads() {
    return [{
      id: 'thread-1',
      title: '测试线程',
      updatedAt: new Date().toISOString(),
      detailAvailable: true
    }];
  }

  async getThread(threadId) {
    return {
      id: threadId,
      title: '测试线程',
      updatedAt: new Date().toISOString(),
      detailAvailable: true,
      filePath: '',
      entries: [],
      entryCount: 0
    };
  }

  async startThread({ prompt, model = '', reasoningEffort = '', submissionId = '' }) {
    const thread = await this.getThread('thread-1');
    this.run = this.buildRun({ id: 'run-1', threadId: thread.id, prompt, model, reasoningEffort, submissionId });
    return { thread, run: this.run };
  }

  async sendMessage({ threadId, text, model = '', reasoningEffort = '', submissionId = '', deliveryMode = 'app_server' }) {
    this.sentMessages.push({ threadId, text, model, reasoningEffort, submissionId });
    this.deliveryModes.push(deliveryMode);
    this.run = this.buildRun({ id: 'run-2', threadId, prompt: text, model, reasoningEffort, submissionId });
    return this.run;
  }

  getRun() {
    return this.run;
  }

  async interruptRun() {
    this.run.status = 'interrupted';
    return this.run;
  }

  async interruptThread(threadId) {
    this.interruptedThreads = [...(this.interruptedThreads ?? []), threadId];
    if (this.run) {
      this.run.status = 'interrupted';
    }
    return this.run;
  }

  listRuns() {
    return this.run ? [this.run] : [];
  }

  runtimeHealth() {
    return {
      kind: 'app_server',
      state: 'ready',
      generation: 3,
      pendingApprovals: 0
    };
  }

  buildRun({ id, threadId, prompt, model = '', reasoningEffort = '', submissionId = '' }) {
    return {
      id,
      projectId: 'probe',
      prompt,
      codexSessionId: threadId,
      model,
      reasoningEffort,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      submissionId,
      runtime: { kind: 'app_server', state: 'running', generation: 3, canInterrupt: true },
      desktopSync: { status: 'app_server_official', desktopLive: false },
      session: null,
      events: [],
      eventCount: 0,
      latestEvent: null,
      error: ''
    };
  }
}

class FakeSessionVerifier {
  constructor(options = {}) {
    this.modelBySessionId = options.modelBySessionId ?? new Map();
    this.reasoningEffortBySessionId = options.reasoningEffortBySessionId ?? new Map();
  }

  async getSessionModel(sessionId) {
    return this.modelBySessionId.get(sessionId) ?? '';
  }

  async getSessionReasoningEffort(sessionId) {
    return this.reasoningEffortBySessionId.get(sessionId) ?? '';
  }

  async verifySessionTarget(sessionId, fingerprint = {}) {
    return {
      id: sessionId,
      title: fingerprint?.title ?? '测试会话',
      projectRoot: fingerprint?.projectRoot ?? 'C:\\work',
      projectLabel: fingerprint?.projectLabel ?? 'work',
      filePath: fingerprint?.filePath ?? 'C:\\sessions\\rollout.jsonl',
      entryCount: 2,
      verifiedAt: '2026-06-07T00:00:00.000Z'
    };
  }
}

class InterruptibleAdapter {
  constructor() {
    this.interrupted = null;
    this.releaseRun = null;
  }

  async run({ emit }) {
    emit('codex.app_server.thread.ready', {
      threadId: '019e-interrupt-thread'
    });
    emit('codex.app_server.turn.started', {
      turn: {
        id: 'turn-interrupt-1'
      }
    });
    await new Promise((resolve) => {
      this.releaseRun = resolve;
    });
    throw new Error('interrupted by test');
  }

  async interrupt({ task, emit }) {
    this.interrupted = {
      threadId: task.codexSessionId,
      turnId: task.activeCodexTurnId,
      status: 'interrupted',
      observedAt: new Date().toISOString()
    };
    emit('codex.app_server.turn.interrupted', this.interrupted);
    this.releaseRun?.();
    return { ok: true };
  }
}

class SlowInterruptibleAdapter extends InterruptibleAdapter {
  constructor() {
    super();
    this.interruptStarted = false;
    this.releaseInterrupt = null;
  }

  async interrupt({ task, emit }) {
    this.interruptStarted = true;
    await new Promise((resolve) => {
      this.releaseInterrupt = resolve;
    });
    return super.interrupt({ task, emit });
  }
}

class CompletingBeforeInterruptAdapter extends InterruptibleAdapter {
  constructor() {
    super();
    this.interruptStarted = false;
    this.releaseInterrupt = null;
    this.releaseRun = null;
  }

  async run({ emit }) {
    emit('codex.app_server.thread.ready', {
      threadId: '019e-interrupt-thread'
    });
    emit('codex.app_server.turn.started', {
      turn: {
        id: 'turn-interrupt-1'
      }
    });
    await new Promise((resolve) => {
      this.releaseRun = resolve;
    });
    return {
      summary: 'completed before late interrupt confirmation',
      changedFiles: [],
      tests: [],
      exitCode: 0
    };
  }

  async interrupt({ task, emit }) {
    this.interruptStarted = true;
    await new Promise((resolve) => {
      this.releaseInterrupt = resolve;
    });
    this.interrupted = {
      threadId: task.codexSessionId,
      turnId: task.activeCodexTurnId,
      status: 'interrupted',
      observedAt: new Date().toISOString()
    };
    emit('codex.app_server.turn.interrupted', this.interrupted);
    return { ok: true };
  }
}

class FailingInterruptAdapter extends InterruptibleAdapter {
  async interrupt() {
    throw new Error('Codex 桌面 CDP 连接错误');
  }
}

class FastAdapter {
  async run() {
    return {
      summary: 'done',
      changedFiles: [],
      tests: [],
      exitCode: 0
    };
  }

  async interrupt() {
    throw new Error('should not interrupt completed task');
  }
}

class DesktopVerifiedAdapter {
  constructor() {
    this.runs = [];
  }

  async getDesktopLiveStatus(timeoutMs, sessionId) {
    if (!sessionId) {
      return {
        ok: true,
        desktopLive: true,
        status: 'ready',
        message: '桌面 CDP 已连接',
        currentSessionId: null,
        targetSessionId: '',
        sessionVerified: false,
        transport: 'cdp'
      };
    }
    return {
      ok: true,
      desktopLive: true,
      status: 'verified',
      message: '已校验当前会话',
      currentSessionId: sessionId,
      targetSessionId: sessionId,
      sessionVerified: true
    };
  }

  async run({ task, emit }) {
    const sessionId = task.codexSessionId || '019e-new-desktop-session';
    this.runs.push({
      id: task.id,
      codexSessionId: task.codexSessionId,
      prompt: task.prompt,
      model: task.model,
      reasoningEffort: task.reasoningEffort
    });
    emit('codex.desktop_sync', {
      status: 'desktop_live',
      desktopLive: true,
      mode: task.codexSessionId ? 'resume' : 'new'
    });
    emit('codex.app_server.thread.ready', {
      threadId: sessionId,
      sessionId
    });
    return {
      summary: 'done',
      changedFiles: [],
      tests: [],
      session: { id: sessionId, entries: [] },
      desktopSync: {
        status: 'desktop_live',
        desktopLive: true
      },
      exitCode: 0
    };
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out');
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
