import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';

test('active desktop thread preparation uses recent turns without loading full history', async () => {
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async request(method, params) {
      assert.equal(method, 'thread/read');
      assert.equal(params.includeTurns, false);
      return { thread: { id: 'target', status: { type: 'active' } } };
    },
    async readRecentThread(id) {
      assert.equal(id, 'target');
      return { thread: { id, turns: [{ id: 'old', status: 'completed' }, { id: 'current', status: 'inProgress' }] } };
    }
  } });
  const result = await adapter.prepareExistingThread({ codexSessionId: 'target' }, {}, () => {});
  assert.equal(result.activeTurnId, 'current');
  assert.equal(result.resumed, false);
  adapter.close();
});

for (const outcome of ['accepted', 'ended', 'transport_failed']) {
  test(`desktop-owned active turn is adopted without resume: ${outcome}`, async () => {
    const calls = [];
    const adapter = new CodexDesktopCdpAdapter({ client: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'active', activeFlags: [] },
          turns: params.includeTurns ? [{ id: 'desktop-turn', status: 'inProgress' }] : [] } };
        if (method === 'turn/steer') {
          if (outcome === 'ended') throw new Error('no active turn to steer');
          if (outcome === 'transport_failed') throw new Error('transport disconnected');
          return { turnId: 'desktop-turn' };
        }
        if (method === 'turn/start') return { turn: { id: 'new-turn', status: 'inProgress' } };
        assert.fail(`unexpected operation ${method}`);
      }
    } });
    adapter.captureSessionFileCursor = async () => null;
    adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
    adapter.startNotificationPolling = () => ({ stop() {} });
    adapter.waitForDesktopTurnCompletion = async ({ turnId }) => ({ turn: { id: turnId, status: 'completed' } });
    adapter.completeDesktopTurnResult = ({ completed }) => completed;
    const operation = adapter.run({ task: { id: 'task', codexSessionId: 'thread', prompt: '追加消息' }, project: {}, emit() {} });
    if (outcome === 'transport_failed') await assert.rejects(operation, /transport disconnected/);
    else assert.equal((await operation).turn.id, outcome === 'accepted' ? 'desktop-turn' : 'new-turn');
    assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, outcome === 'ended' ? 1 : 0);
    const steer = calls.find((call) => call.method === 'turn/steer');
    assert.equal(steer.params.expectedTurnId, 'desktop-turn');
    assert.equal(steer.params.input[0].text, '追加消息');
    adapter.close();
  });
}

test('interrupt during resume uses the pending turn/start acknowledgement without a history lookup', async () => {
  const prepared = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const calls = [];
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'turn/start') return { turn: { id: 'new-turn' } };
      if (method === 'turn/interrupt') return {};
      throw new Error('Full history lookup must not block a pending turn acknowledgement');
    }
  } });
  adapter.prepareExistingThread = () => prepared.promise;
  adapter.captureSessionFileCursor = async () => null;
  adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
  adapter.startNotificationPolling = () => ({ stop() {} });
  adapter.waitForDesktopTurnCompletion = () => completed.promise;
  adapter.completeDesktopTurnResult = ({ completed }) => completed;
  adapter.waitForTurnTerminalAfterInterrupt = async () => ({ status: 'interrupted' });
  const task = { id: 'pending-task', codexSessionId: 'thread', prompt: 'test' };
  const emit = (type, payload) => {
    if (type === 'codex.app_server.turn.started') task.activeCodexTurnId = payload.turn.id;
  };
  const run = adapter.run({ task, project: { root: '.' }, emit });
  const stop = adapter.interrupt({ task, emit });
  prepared.resolve({ thread: { id: 'thread' }, resumed: true });
  try {
    const result = await stop;
    assert.equal(result.confirmed, true);
    assert.deepEqual(calls.map(({ method }) => method), ['turn/start', 'turn/interrupt']);
    assert.deepEqual(calls[1].params, { threadId: 'thread', turnId: 'new-turn' });
  } finally {
    completed.resolve({ status: 'interrupted' });
    await run;
    adapter.close();
  }
});

test('CodexDesktopCdpAdapter exposes authoritative desktop thread runtime states', async () => {
  const requests = [];
  const adapter = new CodexDesktopCdpAdapter({
    client: {
      async request(method, params) {
        requests.push({ method, params });
        return {
          data: [{
            id: 'thread-running',
            status: { type: 'active', activeFlags: [] },
            updatedAt: 1785403428
          }, {
            id: 'thread-approval',
            status: { type: 'active', activeFlags: ['waitingForApproval'] },
            updatedAt: 1785403429
          }, {
            id: 'thread-idle',
            status: { type: 'notLoaded' },
            updatedAt: 1785403400
          }]
        };
      }
    }
  });

  const states = await adapter.listThreadRuntimeStates({ limit: 40 });

  assert.equal(requests[0].method, 'thread/list');
  assert.equal(requests[0].params.limit, 40);
  assert.deepEqual(states.map((state) => ({
    threadId: state.threadId,
    state: state.state
  })), [{
    threadId: 'thread-running',
    state: 'running'
  }, {
    threadId: 'thread-approval',
    state: 'waiting_approval'
  }, {
    threadId: 'thread-idle',
    state: 'idle'
  }]);
  assert.ok(states.every((state) => state.source === 'desktop-app-server'));
});

test('CodexDesktopCdpAdapter delegates explicit desktop thread opening to its CDP client', async () => {
  const opened = [];
  const adapter = new CodexDesktopCdpAdapter({
    client: {
      async openDesktopThread(sessionId) {
        opened.push(sessionId);
        return { ok: true, sessionId };
      }
    }
  });

  const result = await adapter.openDesktopThread('019e-open-target');

  assert.deepEqual(opened, ['019e-open-target']);
  assert.equal(result.sessionId, '019e-open-target');
});

test('CodexDesktopCdpAdapter archives a desktop thread through the native App Server protocol', async () => {
  const requests = [];
  const adapter = new CodexDesktopCdpAdapter({
    client: {
      async request(method, params) {
        requests.push({ method, params });
        return { ok: true };
      }
    }
  });

  await adapter.archiveThread('019e-archive-target');

  assert.deepEqual(requests, [{
    method: 'thread/archive',
    params: { threadId: '019e-archive-target' }
  }]);
});

test('CodexDesktopCdpAdapter resumes verified existing sessions before starting a turn', async () => {
  const client = new FakeDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-existing',
      prompt: '你好',
      codexSessionId: '019e-existing-thread',
      model: 'gpt-alt',
      reasoningEffort: 'high'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '你好，我在当前桌面会话里。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.deepEqual(client.hostCalls, []);
  assert.equal(client.requests[0].method, 'thread/read');
  assert.equal(client.requests[0].params.includeTurns, false);
  assert.equal(client.requests[1].method, 'thread/resume');
  assert.equal(client.requests[1].params.threadId, '019e-existing-thread');
  assert.equal(client.requests[2].method, 'turn/start');
  assert.equal(client.requests[2].params.threadId, '019e-existing-thread');
  assert.deepEqual(client.requests[2].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(client.requests[1].params.model, 'gpt-alt');
  assert.equal(client.requests[2].params.model, 'gpt-alt');
  assert.equal(client.requests[2].params.effort, 'high');
  assert.equal(client.requests[2].params.input[0].text, '你好');
  assert.equal(result.summary, '你好，我在当前桌面会话里。');
  assert.equal(result.desktopSync.desktopLive, true);
  assert.ok(events.some((event) => event.type === 'codex.desktop_host.session.verified'));
  const resumed = events.find((event) => event.type === 'codex.app_server.thread.resumed');
  const read = events.find((event) => event.type === 'codex.app_server.thread.read');
  assert.equal(resumed.payload.thread.turns, undefined);
  assert.equal(read.payload.thread.turns, undefined);
  assert.equal(read.payload.thread.turnCount, 1);
});

test('CodexDesktopCdpAdapter does not resume an already verified current desktop session', async () => {
  const client = new FakeDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-current-session',
      prompt: '不要重载当前会话',
      codexSessionId: '019e-existing-thread',
      verifiedDesktopStatus: {
        desktopLive: true,
        currentSessionId: '019e-existing-thread',
        targetSessionId: '019e-existing-thread',
        sessionVerified: true,
        targetVerified: true
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-current', text: '当前会话未被重载。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(client.requests.some((request) => request.method === 'thread/resume'), false);
  assert.deepEqual(client.requests.slice(0, 2).map((request) => request.method), [
    'thread/read',
    'turn/start'
  ]);
  const skipped = events.find((event) => event.type === 'codex.app_server.thread.resume_skipped_current');
  assert.equal(skipped.payload.threadId, '019e-existing-thread');
});

test('CodexDesktopCdpAdapter does not treat current-session notification noise as a resume failure', async () => {
  const client = new ResumeReloadDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    postResumeCdpRecoveryTimeoutMs: 5,
    postResumeCdpRecoveryIntervalMs: 1,
    postResumeCdpStablePasses: 20
  });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-current-session-noise',
      prompt: '首发不要误报失败',
      codexSessionId: '019e-existing-thread',
      verifiedDesktopStatus: {
        desktopLive: true,
        currentSessionId: '019e-existing-thread',
        targetSessionId: '019e-existing-thread',
        sessionVerified: true,
        targetVerified: true
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-current-noise', text: '首发已成功。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.equal(client.requests.some((request) => request.method === 'thread/resume'), false);
  assert.equal(events.some((event) => event.type === 'codex.desktop_live.post_resume_recovery_started'), false);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.noise_clear_failed'));
});

test('CodexDesktopCdpAdapter steers the active desktop turn with text and local image input', async () => {
  const requests = [];
  const client = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'turn/steer') {
        return { turnId: params.expectedTurnId };
      }
      throw new Error(`Unexpected request ${method}`);
    }
  };
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];
  const imagePath = 'C:/work/mobile-images/guidance.png';

  const result = await adapter.steer({
    task: {
      id: 'task-running',
      codexSessionId: '019e-existing-thread',
      activeCodexTurnId: 'turn-running'
    },
    prompt: `先检查这个截图\n\n![手机端图片](${imagePath})`,
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.accepted, true);
  assert.equal(result.turnId, 'turn-running');
  assert.deepEqual(requests, [{
    method: 'turn/steer',
    params: {
      threadId: '019e-existing-thread',
      input: [{
        type: 'text',
        text: `先检查这个截图\n\n![手机端图片](${imagePath})`,
        text_elements: []
      }, {
        type: 'localImage',
        path: imagePath
      }],
      expectedTurnId: 'turn-running'
    }
  }]);
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.steered'));
});

test('CodexDesktopCdpAdapter waits for CDP stability after a resume reload before submitting', async () => {
  const client = new ResumeReloadDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    postResumeCdpRecoveryTimeoutMs: 100,
    postResumeCdpRecoveryIntervalMs: 1,
    postResumeCdpStablePasses: 2
  });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume-reload',
      prompt: '你好',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '你好，我在当前桌面会话里。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(client.turnStartDrainCount >= 3, true);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.post_resume_recovery_started'));
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.post_resume_recovered'));
});

test('CodexDesktopCdpAdapter keeps post-submit ack reconciliation open for delayed desktop persistence', () => {
  const adapter = new CodexDesktopCdpAdapter({ client: new FakeDesktopClient() });

  assert.equal(adapter.postSubmitAckReconcileMs, 30_000);
});

test('CodexDesktopCdpAdapter resumes host-manager-only historical sessions before starting a turn', async () => {
  const client = new HostManagerOnlyDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-historical',
      prompt: '继续历史会话',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-resumed-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '历史会话已恢复。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(client.requests[0].method, 'thread/read');
  assert.equal(client.hostCalls[0].command, 'load-recent-conversation-ids-for-host');
  assert.equal(client.requests[1].method, 'thread/resume');
  assert.equal(client.requests[2].method, 'turn/start');
  assert.equal(client.requests[2].params.threadId, '019e-existing-thread');
  assert.equal(result.summary, '历史会话已恢复。');
  const verified = events.find((event) => event.type === 'codex.desktop_host.session.verified');
  assert.equal(verified.payload.source, 'host_manager');
});

test('CodexDesktopCdpAdapter recovers from a desktop script resume timeout with thread/read before starting a turn', async () => {
  const client = new ResumeTimeoutDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume-timeout',
      prompt: '继续刚才的任务',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-timeout-recovered',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '已恢复并继续。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.summary, '已恢复并继续。');
  assert.deepEqual(client.requests.slice(0, 5).map((request) => request.method), [
    'thread/read',
    'thread/resume',
    'thread/read',
    'turn/start',
    'thread/read'
  ]);
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_timeout'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_recovered'));
});

test('CodexDesktopCdpAdapter does not wait for a hanging thread/resume acknowledgement before starting a turn', async () => {
  const client = new HangingResumeAckDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client, resumeAckTimeoutMs: 5 });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume-ack-hang',
      prompt: '这是手机消息，你看一下是否正确',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-after-resume-ack-timeout',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '手机消息已进入目标会话。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.summary, '手机消息已进入目标会话。');
  assert.equal(client.turnStartedBeforeResumeSettled, true);
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_timeout'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_recovered'));
});

test('CodexDesktopCdpAdapter submits to a verified session when resume and fallback read both time out', async () => {
  const client = new ResumeAndFallbackReadTimeoutDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume-read-timeout',
      prompt: '继续',
      codexSessionId: '019e-existing-thread',
      verifiedSessionTarget: {
        title: '对话模式开发',
        projectRoot: 'C:\\Users\\agent\\Desktop\\ExampleProject',
        filePath: 'C:\\Users\\agent\\.codex\\sessions\\2026\\06\\08\\rollout-019e-existing-thread.jsonl'
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-assumed-thread',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '已在对话模式开发继续。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.summary, '已在对话模式开发继续。');
  assert.deepEqual(client.requests.slice(0, 5).map((request) => request.method), [
    'thread/read',
    'thread/resume',
    'thread/read',
    'turn/start',
    'thread/read'
  ]);
  assert.equal(client.requests[3].params.threadId, '019e-existing-thread');
  assert.equal(client.requests[3].params.input[0].text, '继续');
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_read_timeout'));
  const assumed = events.find((event) => event.type === 'codex.app_server.thread.resume_assumed_from_verified_target');
  assert.equal(assumed.payload.thread.id, '019e-existing-thread');
  assert.equal(assumed.payload.thread.cwd, 'C:\\Users\\agent\\Desktop\\ExampleProject');
});

test('CodexDesktopCdpAdapter submits to a verified session when resume and fallback read hit transient CDP errors', async () => {
  const client = new ResumeAndFallbackReadCdpErrorDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({ client });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-resume-cdp-error',
      prompt: '那这样有效果吗',
      codexSessionId: '019e-agent-center-thread',
      verifiedSessionTarget: {
        title: 'Agent中心完善',
        projectRoot: 'C:\\Users\\agent\\Desktop\\ExampleProject',
        filePath: 'C:\\Users\\agent\\.codex\\sessions\\2026\\05\\28\\rollout-019e-agent-center-thread.jsonl'
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-agent-center-thread',
      turn: {
        id: 'turn-agent-center',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: 'Agent中心已收到。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.summary, 'Agent中心已收到。');
  assert.deepEqual(client.requests.slice(0, 5).map((request) => request.method), [
    'thread/read',
    'thread/resume',
    'thread/read',
    'turn/start',
    'thread/read'
  ]);
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_recoverable_error'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_read_recoverable_error'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.resume_assumed_from_verified_target'));
});

test('CodexDesktopCdpAdapter completes existing session tasks from rollout file when CDP read stalls', async () => {
  const client = new FileBackedDesktopClient();
  const sessions = new FakeSessionStore();
  const adapter = new CodexDesktopCdpAdapter({ client, sessions });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-existing-file',
      prompt: '链路验证四：请只回复“状态回传正常”。',
      codexSessionId: '019e-existing-thread',
      verifiedSessionTarget: {
        filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl'
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  const result = await resultPromise;

  assert.equal(result.summary, '状态回传正常');
  assert.equal(result.session.filePath, 'C:\\sessions\\rollout-019e-existing-thread.jsonl');
  assert.equal(result.session.entries.at(-1).text, '状态回传正常');
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.completed'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.thread.final_read_failed'));
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 1);
});

test('CodexDesktopCdpAdapter prefers desktop sidebar session snapshots for existing sessions', async () => {
  const client = new FakeDesktopClient();
  const sessions = new FakeSessionStore();
  const adapter = new CodexDesktopCdpAdapter({ client, sessions });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-existing-desktop-snapshot',
      prompt: '你好',
      codexSessionId: '019e-existing-thread',
      verifiedSessionTarget: {
        filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl'
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequest('turn/start');
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '你好，我在当前桌面会话里。' }]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.session.source, 'desktop-sidebar');
  assert.equal(result.session.projectRoot, 'C:\\work');
  assert.equal(result.session.filePath, 'C:\\sessions\\rollout-019e-existing-thread.jsonl');
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.final_session_file_preferred'));
});

test('CodexDesktopCdpAdapter suppresses single notification poll failures', async () => {
  const client = new RecoveringPollFailureDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    notificationPollIntervalMs: 10,
    notificationPollBaseBackoffMs: 10,
    notificationPollMaxBackoffMs: 10
  });
  const events = [];

  const polling = adapter.startNotificationPolling(
    '019e-existing-thread',
    [],
    (type, payload) => events.push({ type, payload })
  );

  await sleep(50);
  polling.stop();

  const failures = events.filter((event) => event.type === 'codex.desktop_live.poll_failed');
  assert.equal(failures.length, 0);
  assert.equal(client.drainCount >= 2, true);
});

test('CodexDesktopCdpAdapter reports shared notification poll failures after a threshold', async () => {
  const client = new PollFailureDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    notificationPollFailureReportThreshold: 2,
    notificationPollBaseBackoffMs: 10,
    notificationPollMaxBackoffMs: 10
  });
  const events = [];

  const polling = adapter.startNotificationPolling(
    '019e-existing-thread',
    [],
    (type, payload) => events.push({ type, payload })
  );

  await sleep(45);
  polling.stop();

  const failures = events.filter((event) => event.type === 'codex.desktop_live.poll_failed');
  assert.equal(failures.length >= 1, true);
  assert.equal(failures[0].payload.diagnosticOnly, true);
  assert.equal(failures[0].payload.shared, true);
  assert.equal(failures[0].payload.failures, 2);
});

test('CodexDesktopCdpAdapter suppresses a transient thread/read poll failure', async () => {
  const client = new RecoveringThreadReadFailureDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    threadPollFailureReportThreshold: 2,
    idleTimeoutMs: 1000
  });
  const notifications = [];
  const events = [];

  const waiting = adapter.waitForDesktopTurnCompletion({
    notifications,
    threadId: '019e-existing-thread',
    turnId: 'turn-transient-read-failure',
    prompt: '手机消息',
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 1000
  });

  setTimeout(() => {
    notifications.push({
      method: 'turn/completed',
      params: {
        threadId: '019e-existing-thread',
        turn: {
          id: 'turn-transient-read-failure',
          status: 'completed',
          items: [{ type: 'agentMessage', text: '已完成' }]
        }
      }
    });
  }, 30);

  const completed = await waiting;
  assert.equal(completed.turn.status, 'completed');
  assert.equal(client.threadReadCount, 1);
  assert.equal(events.some((event) => event.type === 'codex.desktop_live.thread_poll_failed'), false);
});

test('CodexDesktopCdpAdapter waits briefly for an active turn before interrupting', async () => {
  const client = new DelayedActiveTurnInterruptClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    interruptTurnLookupTimeoutMs: 500,
    interruptTurnLookupIntervalMs: 10,
    interruptConfirmationTimeoutMs: 80,
    interruptConfirmationIntervalMs: 10
  });
  const events = [];

  const result = await adapter.interrupt({
    task: {
      id: 'task-wait-interrupt',
      codexSessionId: '019e-wait-thread'
    },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(client.interrupted, {
    threadId: '019e-wait-thread',
    turnId: 'turn-delayed-active'
  });
  assert.equal(client.activeLookupCount >= 3, true);
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.waiting_active_for_interrupt'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.active_found_for_interrupt'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.interrupt_confirmed'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.interrupted'));
});

test('CodexDesktopCdpAdapter interrupts a running thread even when active turn ack was lost', async () => {
  const client = new SnapshotActiveTurnInterruptClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    interruptConfirmationTimeoutMs: 80,
    interruptConfirmationIntervalMs: 10
  });
  const events = [];

  const result = await adapter.interrupt({
    task: {
      id: 'task-ackless-interrupt',
      codexSessionId: '019e-ackless-thread',
      activeCodexTurnId: ''
    },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(client.interrupted, {
    threadId: '019e-ackless-thread',
    turnId: 'turn-from-thread-read'
  });
  assert.ok(events.some((event) => {
    return event.type === 'codex.app_server.turn.active_found_for_interrupt'
      && event.payload.source === 'thread_read_snapshot';
  }));
});

test('CodexDesktopCdpAdapter leaves interrupt pending when accepted turn stays in progress', async () => {
  const client = new PendingInterruptConfirmationClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    interruptConfirmationTimeoutMs: 30,
    interruptConfirmationIntervalMs: 10
  });
  const events = [];

  const result = await adapter.interrupt({
    task: {
      id: 'task-pending-interrupt',
      codexSessionId: '019e-pending-thread',
      activeCodexTurnId: 'turn-still-running'
    },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, false);
  assert.deepEqual(client.interrupted, {
    threadId: '019e-pending-thread',
    turnId: 'turn-still-running'
  });
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.interrupt_accepted'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.interrupt_pending'));
  assert.equal(events.some((event) => event.type === 'codex.app_server.turn.interrupted'), false);
});

test('CodexDesktopCdpAdapter shares one notification drain loop across thread subscriptions', async () => {
  const client = new SharedNotificationDesktopClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    notificationPollIntervalMs: 1000
  });
  const firstNotifications = [];
  const secondNotifications = [];
  const firstEvents = [];
  const secondEvents = [];

  const first = adapter.startNotificationPolling(
    'thread-a',
    firstNotifications,
    (type, payload) => firstEvents.push({ type, payload })
  );
  const second = adapter.startNotificationPolling(
    'thread-b',
    secondNotifications,
    (type, payload) => secondEvents.push({ type, payload })
  );

  await sleep(30);
  first.stop();
  second.stop();

  assert.equal(client.drainCount, 1);
  assert.equal(firstNotifications.length, 1);
  assert.equal(firstNotifications[0].params.threadId, 'thread-a');
  assert.equal(secondNotifications.length, 1);
  assert.equal(secondNotifications[0].params.threadId, 'thread-b');
  assert.equal(firstEvents.length, 1);
  assert.equal(secondEvents.length, 1);
});

test('CodexDesktopCdpAdapter keeps rollout-backed tasks running until task_complete arrives', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new IncrementalOnlySessionStore(),
    softCompleteAfterAssistantStableMs: 10 * 60 * 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-file-1',
    prompt: '请继续优化',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed, null);
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.completed'), false);
});

test('CodexDesktopCdpAdapter soft-completes stable rollout assistant replies without task_complete', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new StableAssistantOnlySessionStore(),
    softCompleteAfterAssistantStableMs: 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-file-1',
    prompt: '请继续优化',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items.at(-1).text, '已经完成优化。');
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.soft_completed'));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'), false);
});

test('CodexDesktopCdpAdapter blocks session-file soft completion while official turn is still running', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new StableAssistantOnlySessionStore(),
    softCompleteAfterAssistantStableMs: 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-file-1',
    prompt: '请继续优化',
    officialTurnStatus: 'inProgress',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed, null);
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.soft_completed'), false);
  assert.ok(events.some((event) => {
    return event.type === 'codex.session_file.turn.waiting_terminal'
      && event.payload.reason === 'official_turn_in_progress';
  }));
});

test('CodexDesktopCdpAdapter completes rollout turns anchored by response_item user messages', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new ResponseItemUserMessageSessionStore(),
    softCompleteAfterAssistantStableMs: 10 * 60 * 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-response-item-user',
    prompt: '继续',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items[0].content[0].text, '继续');
  assert.equal(completed.turn.items.at(-1).text, '已完成继续任务。');
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.completed'));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'), false);
});

test('CodexDesktopCdpAdapter completes rollout turns when task_complete has no assistant text', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new TerminalOnlySessionStore(),
    softCompleteAfterAssistantStableMs: 10 * 60 * 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-terminal-only-thread',
      filePath: 'C:\\sessions\\rollout-019e-terminal-only-thread.jsonl',
      offset: 100
    },
    threadId: '019e-terminal-only-thread',
    turnId: 'turn-terminal-only',
    prompt: '继续',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items[0].content[0].text, '继续');
  assert.match(completed.turn.items.at(-1).text, /Codex 已完成本轮任务/);
  assert.ok(events.some((event) => {
    return event.type === 'codex.session_file.turn.completed'
      && event.payload.source === 'task_complete';
  }));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'), false);
});

test('CodexDesktopCdpAdapter treats rollout turn_aborted after a phone prompt as interrupted', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new AbortedAfterPromptSessionStore(),
    softCompleteAfterAssistantStableMs: 10 * 60 * 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-aborted-file',
    prompt: '继续修复打断',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed.turn.status, 'interrupted');
  assert.equal(completed.turn.items.at(-1).text, '本轮已在 Codex 桌面端中断。');
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.interrupted'));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'), false);
});

test('CodexDesktopCdpAdapter does not soft-complete when tool activity follows assistant progress', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new AssistantThenToolSessionStore(),
    softCompleteAfterAssistantStableMs: 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-file-1',
    prompt: '继续审查链路',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed, null);
  assert.ok(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'));
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.soft_completed'), false);
});

test('CodexDesktopCdpAdapter soft-completes after post-assistant tool activity is stable', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    sessions: new StableAssistantThenToolSessionStore(),
    softCompleteAfterAssistantStableMs: 1000
  });
  const events = [];

  const completed = await adapter.readCompletedTurnFromSessionFile({
    cursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    threadId: '019e-existing-thread',
    turnId: 'turn-file-1',
    prompt: '这是手机信息',
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items.at(-1).text, '我已经看到了这条手机消息。');
  assert.ok(events.some((event) => {
    return event.type === 'codex.session_file.turn.soft_completed'
      && event.payload.latestActivityRole === 'tool';
  }));
});

test('CodexDesktopCdpAdapter extends turn wait while desktop notifications keep arriving', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    idleTimeoutMs: 120
  });
  const notifications = [];
  const events = [];

  const waiting = adapter.waitForDesktopTurnCompletion({
    notifications,
    threadId: '019e-existing-thread',
    turnId: 'turn-activity',
    prompt: '继续',
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 40
  });

  await sleep(30);
  notifications.push({
    method: 'item/commandExecution/outputDelta',
    params: {
      threadId: '019e-existing-thread',
      turnId: 'turn-activity',
      delta: 'still working'
    }
  });
  await sleep(70);
  notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-activity',
        status: 'completed',
        items: [{ type: 'agentMessage', text: '完成' }]
      }
    }
  });

  const completed = await waiting;
  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items[0].text, '完成');
});

test('CodexDesktopCdpAdapter surfaces desktop context window exhaustion notices', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    idleTimeoutMs: 120
  });
  const notifications = [];
  const events = [];

  const waiting = adapter.waitForDesktopTurnCompletion({
    notifications,
    threadId: '019e-existing-thread',
    turnId: 'turn-context-limit',
    prompt: '继续',
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 1000
  });

  notifications.push({
    method: 'error',
    params: {
      threadId: '019e-existing-thread',
      turnId: 'turn-context-limit',
      message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    }
  });

  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'CODEX_CLIENT_NOTICE');
    assert.equal(error.notice.kind, 'context_limit');
    assert.equal(error.notice.severity, 'error');
    assert.match(error.message, /上下文窗口已满/);
    return true;
  });

  const notice = events.find((event) => event.type === 'codex.desktop_live.client_error');
  assert.equal(notice.payload.notice.kind, 'context_limit');
  assert.match(notice.payload.notice.detail, /ran out of room/);
});

test('CodexDesktopCdpAdapter extends turn wait while rollout file keeps receiving activity', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new InProgressDesktopClient(),
    sessions: new ActiveThenTerminalSessionStore(),
    idleTimeoutMs: 1000
  });
  const events = [];

  const completed = await adapter.waitForDesktopTurnCompletion({
    notifications: [],
    threadId: '019e-existing-thread',
    turnId: 'turn-file-active',
    prompt: '继续',
    sessionFileCursor: {
      sessionId: '019e-existing-thread',
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      offset: 100
    },
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 20
  });

  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.turn.items.at(-1).text, '已经完成长任务。');
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.waiting_terminal'), true);
  assert.equal(events.some((event) => event.type === 'codex.session_file.turn.completed'), true);
});

test('CodexDesktopCdpAdapter emits when the phone user message is persisted', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new FakeDesktopClient(),
    idleTimeoutMs: 120
  });
  const notifications = [];
  const events = [];

  const waiting = adapter.waitForDesktopTurnCompletion({
    notifications,
    threadId: '019e-existing-thread',
    turnId: 'turn-persisted',
    prompt: '手机发来的消息',
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 1000
  });

  notifications.push({
    method: 'item/completed',
    params: {
      threadId: '019e-existing-thread',
      turnId: 'turn-persisted',
      item: {
        type: 'userMessage',
        id: 'user-phone',
        clientId: 'phone-client-message',
        content: [{ type: 'text', text: '手机发来的消息', text_elements: [] }]
      }
    }
  });
  notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-persisted',
        status: 'completed',
        items: []
      }
    }
  });

  await waiting;
  const persisted = events.find((event) => event.type === 'codex.app_server.user_message.persisted');
  assert.equal(persisted.payload.source, 'notification');
  assert.equal(persisted.payload.itemId, 'user-phone');
});

test('CodexDesktopCdpAdapter fails interrupted turns that never persisted the phone message', async () => {
  const adapter = new CodexDesktopCdpAdapter({
    client: new EmptyInterruptedTurnClient(),
    idleTimeoutMs: 120
  });
  const events = [];

  await assert.rejects(adapter.waitForDesktopTurnCompletion({
    notifications: [],
    threadId: '019e-existing-thread',
    turnId: 'turn-empty',
    prompt: '手机发来的消息',
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 1000
  }), (error) => {
    assert.equal(error.code, 'CODEX_PHONE_MESSAGE_NOT_PERSISTED');
    assert.match(error.message, /手机消息没有写入官方会话/);
    return true;
  });

  const missing = events.find((event) => event.type === 'codex.app_server.user_message.missing');
  assert.equal(missing.payload.status, 'interrupted');
  assert.match(missing.payload.message, /没有在 Codex 官方会话中看到手机消息/);
});

test('CodexDesktopCdpAdapter retries after compaction interrupts before the phone message persists', async () => {
  const client = new RetryAfterMissingPromptClient();
  const adapter = new CodexDesktopCdpAdapter({
    client,
    idleTimeoutMs: 120,
    promptMissingRetryCount: 2,
    promptMissingRetryDelayMs: 10
  });
  const events = [];

  const resultPromise = adapter.run({
    task: {
      id: 'task-retry-missing-prompt',
      prompt: '压缩期间发送的手机消息',
      codexSessionId: '019e-existing-thread'
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  await client.waitForRequestCount('turn/start', 1);
  await client.waitForRequestCount('turn/start', 2);
  client.notifications.push({
    method: 'item/completed',
    params: {
      threadId: '019e-existing-thread',
      turnId: 'turn-retry-2',
      item: {
        type: 'userMessage',
        id: 'user-phone-retry',
        content: [{ type: 'text', text: '压缩期间发送的手机消息', text_elements: [] }]
      }
    }
  });
  client.notifications.push({
    method: 'turn/completed',
    params: {
      threadId: '019e-existing-thread',
      turn: {
        id: 'turn-retry-2',
        status: 'completed',
        items: [
          { type: 'userMessage', id: 'user-phone-retry', content: [{ type: 'text', text: '压缩期间发送的手机消息', text_elements: [] }] },
          { type: 'agentMessage', id: 'agent-retry', text: '压缩完成后已经继续处理。' }
        ]
      }
    }
  });

  const result = await resultPromise;
  assert.equal(result.summary, '压缩完成后已经继续处理。');
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 2);
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.retry_after_compaction'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.compaction.waiting'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.user_message.persisted'));
});

test('CodexDesktopCdpAdapter reconciles turn/start ack loss after prompt persisted to session file', async () => {
  const client = new TurnStartAckLossDesktopClient();
  const sessions = new PromptPersistedSessionStore({
    prompt: '现在应该可以了，开始直接工作。',
    assistant: '已经开始工作。'
  });
  const adapter = new CodexDesktopCdpAdapter({
    client,
    sessions,
    idleTimeoutMs: 120,
    postSubmitAckReconcileMs: 800
  });
  const events = [];

  const result = await adapter.run({
    task: {
      id: 'task-ack-loss',
      prompt: '现在应该可以了，开始直接工作。',
      codexSessionId: '019eb49c-623e-7812-83af-4ad970423570',
      verifiedSessionTarget: {
        filePath: 'C:\\sessions\\rollout-019eb49c-623e-7812-83af-4ad970423570.jsonl'
      }
    },
    project: { root: 'C:\\work' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, '已经开始工作。');
  assert.equal(client.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.ok(events.some((event) => event.type === 'codex.app_server.turn.accepted_without_ack'));
  assert.ok(events.some((event) => event.type === 'codex.app_server.user_message.persisted'));
});

class FakeDesktopClient {
  constructor() {
    this.hostCalls = [];
    this.requests = [];
    this.notifications = [];
    this.waiters = [];
  }

  async fetchFromHost(command, params) {
    this.hostCalls.push({ command, params });
    this.resolveWaiters(command);
    if (command === 'load-recent-conversation-ids-for-host') {
      return ['019e-existing-thread'];
    }
    if (command === 'send-follow-up-message') {
      return {};
    }
    throw new Error(`Unexpected host command ${command}`);
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-1',
            status: 'completed',
            startedAt: 1779926400,
            completedAt: 1779926401,
            items: [{
              type: 'userMessage',
              id: 'user-1',
              content: [{ type: 'text', text: '你好', text_elements: [] }]
            }, {
              type: 'agentMessage',
              id: 'msg-1',
              text: '你好，我在当前桌面会话里。'
            }]
          }]
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd ?? null,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          items: []
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }

  async drainNotifications() {
    return this.notifications.splice(0);
  }

  waitForHostCommand(command) {
    if (this.hostCalls.some((call) => call.command === command)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ command, resolve });
    });
  }

  waitForRequest(method) {
    if (this.requests.some((call) => call.method === method)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ command: method, resolve });
    });
  }

  waitForRequestCount(method, count) {
    if (this.requests.filter((call) => call.method === method).length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ command: `${method}:${count}`, resolve });
    });
  }

  resolveWaiters(command) {
    const ready = this.waiters.filter((waiter) => waiter.command === command);
    const countReady = this.waiters.filter((waiter) => {
      const [method, rawCount] = String(waiter.command).split(':');
      const count = Number.parseInt(rawCount, 10);
      return method === command
        && Number.isFinite(count)
        && this.requests.filter((call) => call.method === command).length >= count;
    });
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter) && !countReady.includes(waiter));
    ready.forEach((waiter) => waiter.resolve());
    countReady.forEach((waiter) => waiter.resolve());
  }
}

class ResumeReloadDesktopClient extends FakeDesktopClient {
  constructor() {
    super();
    this.drainCount = 0;
    this.turnStartDrainCount = 0;
  }

  async request(method, params) {
    if (method === 'turn/start') {
      this.turnStartDrainCount = this.drainCount;
    }
    return super.request(method, params);
  }

  async drainNotifications() {
    this.drainCount += 1;
    if (this.drainCount === 1) {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    return super.drainNotifications();
  }
}

class DelayedActiveTurnInterruptClient {
  constructor() {
    this.requests = [];
    this.activeLookupCount = 0;
    this.interrupted = null;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === true) {
      this.activeLookupCount += 1;
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: this.interrupted
            ? [{ id: 'turn-delayed-active', status: 'interrupted', items: [] }]
            : this.activeLookupCount >= 3
            ? [{ id: 'turn-delayed-active', status: 'inProgress', items: [] }]
            : []
        }
      };
    }
    if (method === 'turn/interrupt') {
      this.interrupted = params;
      return { ok: true };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class SnapshotActiveTurnInterruptClient {
  constructor() {
    this.requests = [];
    this.interrupted = null;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-from-thread-read',
            status: this.interrupted ? 'interrupted' : 'inProgress',
            items: []
          }]
        }
      };
    }
    if (method === 'turn/interrupt') {
      this.interrupted = params;
      return { ok: true };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class PendingInterruptConfirmationClient {
  constructor() {
    this.requests = [];
    this.interrupted = null;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'turn/interrupt') {
      this.interrupted = params;
      return { ok: true };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{ id: 'turn-still-running', status: 'inProgress', items: [] }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class EmptyInterruptedTurnClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-empty',
            status: 'interrupted',
            items: []
          }]
        }
      };
    }
    return super.request(method, params);
  }
}

class RetryAfterMissingPromptClient extends FakeDesktopClient {
  constructor() {
    super();
    this.turnStartCount = 0;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd ?? null,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'turn/start') {
      this.turnStartCount += 1;
      const turnId = `turn-retry-${this.turnStartCount}`;
      this.resolveWaiters(method);
      return {
        turn: {
          id: turnId,
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      if (this.turnStartCount <= 1) {
        return {
          thread: {
            id: params.threadId,
            sessionId: params.threadId,
            turns: [{
              id: 'turn-retry-1',
              status: 'interrupted',
              items: []
            }]
          }
        };
      }
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-retry-2',
            status: 'completed',
            items: [
              { type: 'userMessage', id: 'user-phone-retry', content: [{ type: 'text', text: '压缩期间发送的手机消息', text_elements: [] }] },
              { type: 'agentMessage', id: 'agent-retry', text: '压缩完成后已经继续处理。' }
            ]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class TurnStartAckLossDesktopClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: []
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd ?? null,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class HostManagerOnlyDesktopClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      throw new Error('thread not found: ' + params.threadId);
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd ?? null,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-resumed-1',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-resumed-1',
            status: 'completed',
            startedAt: 1779926400,
            completedAt: 1779926401,
            items: [{
              type: 'agentMessage',
              id: 'msg-1',
              text: '历史会话已恢复。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class ResumeTimeoutDesktopClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'thread/resume') {
      const error = new Error('等待桌面脚本桥 app-server 响应超时：thread/resume');
      error.code = 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT';
      error.method = 'thread/resume';
      throw error;
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-timeout-recovered',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-timeout-recovered',
            status: 'completed',
            items: [{
              type: 'agentMessage',
              id: 'msg-1',
              text: '已恢复并继续。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class HangingResumeAckDesktopClient extends FakeDesktopClient {
  constructor() {
    super();
    this.resumeSettled = false;
    this.turnStartedBeforeResumeSettled = false;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'thread/resume') {
      return new Promise(() => {});
    }
    if (method === 'turn/start') {
      this.turnStartedBeforeResumeSettled = !this.resumeSettled;
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-after-resume-ack-timeout',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-after-resume-ack-timeout',
            status: 'completed',
            items: [{
              type: 'agentMessage',
              id: 'msg-1',
              text: '手机消息已进入目标会话。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class ResumeAndFallbackReadTimeoutDesktopClient extends FakeDesktopClient {
  constructor() {
    super();
    this.readWithoutTurnsCount = 0;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      this.readWithoutTurnsCount += 1;
      if (this.readWithoutTurnsCount === 1) {
        return {
          thread: {
            id: params.threadId,
            sessionId: params.threadId,
            status: { type: 'ready' }
          }
        };
      }
      const error = new Error('等待桌面脚本桥 app-server 响应超时：thread/read');
      error.code = 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT';
      error.method = 'thread/read';
      throw error;
    }
    if (method === 'thread/resume') {
      const error = new Error('等待桌面脚本桥 app-server 响应超时：thread/resume');
      error.code = 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT';
      error.method = 'thread/resume';
      throw error;
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-assumed-thread',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-assumed-thread',
            status: 'completed',
            items: [{
              type: 'agentMessage',
              id: 'msg-1',
              text: '已在对话模式开发继续。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class ResumeAndFallbackReadCdpErrorDesktopClient extends FakeDesktopClient {
  constructor() {
    super();
    this.readWithoutTurnsCount = 0;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      this.readWithoutTurnsCount += 1;
      if (this.readWithoutTurnsCount === 1) {
        return {
          thread: {
            id: params.threadId,
            sessionId: params.threadId,
            status: { type: 'ready' }
          }
        };
      }
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    if (method === 'thread/resume') {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-agent-center',
          status: 'inProgress',
          items: []
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-agent-center',
            status: 'completed',
            items: [{
              type: 'agentMessage',
              id: 'msg-1',
              text: 'Agent中心已收到。'
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class FileBackedDesktopClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' && params.includeTurns === false) {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          cwd: params.cwd ?? null,
          status: { type: 'ready' }
        }
      };
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    if (method === 'turn/start') {
      this.resolveWaiters(method);
      return {
        turn: {
          id: 'turn-file-1',
          status: 'inProgress',
          items: []
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class PollFailureDesktopClient {
  constructor() {
    this.drainCount = 0;
  }

  async drainNotifications() {
    this.drainCount += 1;
    throw new Error('Codex 桌面 CDP 连接错误');
  }
}

class RecoveringPollFailureDesktopClient {
  constructor() {
    this.drainCount = 0;
  }

  async drainNotifications() {
    this.drainCount += 1;
    if (this.drainCount === 1) {
      throw new Error('Codex 桌面 CDP 连接错误');
    }
    return [];
  }
}

class RecoveringThreadReadFailureDesktopClient {
  constructor() {
    this.threadReadCount = 0;
  }

  async request(method) {
    if (method !== 'thread/read') {
      throw new Error(`Unexpected request ${method}`);
    }
    this.threadReadCount += 1;
    throw new Error('Codex 桌面 CDP 连接错误');
  }
}

class SharedNotificationDesktopClient {
  constructor() {
    this.drainCount = 0;
  }

  async drainNotifications() {
    this.drainCount += 1;
    if (this.drainCount > 1) {
      return [];
    }
    return [
      {
        method: 'turn/update',
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a'
        }
      },
      {
        method: 'turn/update',
        params: {
          threadId: 'thread-b',
          turnId: 'turn-b'
        }
      }
    ];
  }
}

class InProgressDesktopClient extends FakeDesktopClient {
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          sessionId: params.threadId,
          turns: [{
            id: 'turn-file-active',
            status: 'inProgress',
            items: [{
              type: 'userMessage',
              id: 'user-file-active',
              content: [{ type: 'text', text: '继续', text_elements: [] }]
            }]
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

class PromptPersistedSessionStore {
  constructor({ prompt, assistant }) {
    this.prompt = prompt;
    this.assistant = assistant;
  }

  async getSessionFileCursor(sessionId, filePath) {
    return {
      sessionId,
      filePath,
      offset: 100,
      updatedAtMs: Date.now()
    };
  }

  async readSessionRecordsAfterCursor() {
    return [{
      timestamp: '2026-06-16T14:37:21.842Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: this.prompt }]
      }
    }, {
      timestamp: '2026-06-16T14:37:35.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: this.assistant }]
      }
    }, {
      timestamp: '2026-06-16T14:37:36.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-ack-loss-file',
        last_agent_message: this.assistant
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }

  async getSession(sessionId) {
    return {
      id: sessionId,
      title: '监督进化',
      updatedAt: '2026-06-16T14:37:36.000Z',
      relativeTime: '刚刚',
      projectRoot: 'C:\\work',
      projectLabel: 'work',
      source: 'desktop-sidebar',
      pinned: false,
      detailAvailable: true,
      filePath: 'C:\\sessions\\rollout-019eb49c-623e-7812-83af-4ad970423570.jsonl',
      entries: [{
        timestamp: '2026-06-16T14:37:21.842Z',
        type: 'response_item',
        role: 'user',
        text: this.prompt
      }, {
        timestamp: '2026-06-16T14:37:35.000Z',
        type: 'response_item',
        role: 'assistant',
        text: this.assistant
      }],
      entryCount: 2
    };
  }
}

class FakeSessionStore {
  async getSessionFileCursor(sessionId, filePath) {
    return {
      sessionId,
      filePath,
      offset: 100,
      updatedAtMs: Date.now()
    };
  }

  async readSessionEntriesAfterCursor() {
    return visibleEntriesForFileBackedCompletion();
  }

  async readSessionRecordsAfterCursor() {
    return [{
      timestamp: '2026-05-29T15:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '链路验证四：请只回复“状态回传正常”。'
      }
    }, {
      timestamp: '2026-05-29T15:00:01Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '状态回传正常'
      }
    }, {
      timestamp: '2026-05-29T15:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-file-1',
        last_agent_message: '状态回传正常'
      }
    }];
  }

  async getSession(sessionId) {
    return {
      id: sessionId,
      title: '规划鸿蒙远程 Codex 操作',
      updatedAt: '2026-05-29T15:00:01Z',
      relativeTime: '刚刚',
      projectRoot: 'C:\\work',
      projectLabel: 'work',
      source: 'desktop-sidebar',
      pinned: false,
      detailAvailable: true,
      filePath: 'C:\\sessions\\rollout-019e-existing-thread.jsonl',
      entries: visibleEntriesForFileBackedCompletion(),
      entryCount: 2
    };
  }
}

class ActiveThenTerminalSessionStore {
  constructor() {
    this.reads = 0;
  }

  async readSessionRecordsAfterCursor() {
    this.reads += 1;
    const now = new Date().toISOString();
    const records = [{
      timestamp: now,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续' }]
      }
    }, {
      timestamp: now,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '正在继续处理。' }]
      }
    }, {
      timestamp: now,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'still running'
      }
    }];
    if (this.reads >= 3) {
      records.push({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-file-active',
          last_agent_message: '已经完成长任务。'
        }
      });
    }
    return records;
  }
}

class IncrementalOnlySessionStore {
  async readSessionRecordsAfterCursor() {
    const freshTimestamp = new Date().toISOString();
    return [{
      timestamp: freshTimestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '请继续优化'
      }
    }, {
      timestamp: freshTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '我正在处理，先看一下代码。' }]
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    const freshTimestamp = new Date().toISOString();
    return [{
      timestamp: freshTimestamp,
      type: 'event_msg',
      role: 'user',
      text: '请继续优化'
    }, {
      timestamp: freshTimestamp,
      type: 'response_item',
      role: 'assistant',
      text: '我正在处理，先看一下代码。'
    }];
  }
}

class ResponseItemUserMessageSessionStore {
  async readSessionRecordsAfterCursor() {
    return [{
      timestamp: '2026-06-09T14:33:31.593Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续' }]
      }
    }, {
      timestamp: '2026-06-09T14:33:45.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '已完成继续任务。'
      }
    }, {
      timestamp: '2026-06-09T14:33:46.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-response-item-user',
        last_agent_message: '已完成继续任务。'
      }
    }];
  }
}

class TerminalOnlySessionStore {
  async readSessionRecordsAfterCursor() {
    return [{
      timestamp: '2026-06-09T15:32:28.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续' }]
      }
    }, {
      timestamp: '2026-06-09T15:37:35.857Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-terminal-only',
        last_agent_message: null,
        duration_ms: 307020
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }
}

class AbortedAfterPromptSessionStore {
  async readSessionRecordsAfterCursor() {
    const userTimestamp = new Date(Date.now() - 70 * 1000).toISOString();
    const assistantTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    const abortedTimestamp = new Date(Date.now() - 5 * 1000).toISOString();
    return [{
      timestamp: userTimestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '继续修复打断'
      }
    }, {
      timestamp: assistantTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '我正在处理打断链路。' }]
      }
    }, {
      timestamp: abortedTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }]
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }
}

class StableAssistantOnlySessionStore {
  async readSessionRecordsAfterCursor() {
    const oldTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    return [{
      timestamp: oldTimestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '请继续优化'
      }
    }, {
      timestamp: oldTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '已经完成优化。' }]
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }
}

class AssistantThenToolSessionStore {
  async readSessionRecordsAfterCursor() {
    const assistantTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    const toolTimestamp = new Date().toISOString();
    return [{
      timestamp: assistantTimestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '继续审查链路'
      }
    }, {
      timestamp: assistantTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '我先看一下链路状态。' }]
      }
    }, {
      timestamp: toolTimestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        arguments: '{"command":"rg status"}'
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }
}

class StableAssistantThenToolSessionStore {
  async readSessionRecordsAfterCursor() {
    const userTimestamp = new Date(Date.now() - 70 * 1000).toISOString();
    const assistantTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
    const toolTimestamp = new Date(Date.now() - 55 * 1000).toISOString();
    return [{
      timestamp: userTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '这是手机信息' }]
      }
    }, {
      timestamp: assistantTimestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '我已经看到了这条手机消息。'
      }
    }, {
      timestamp: assistantTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '我已经看到了这条手机消息。' }]
      }
    }, {
      timestamp: toolTimestamp,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_status_probe',
        output: 'ok'
      }
    }];
  }

  async readSessionEntriesAfterCursor() {
    return [];
  }
}

function visibleEntriesForFileBackedCompletion() {
  return [{
      timestamp: '2026-05-29T15:00:00Z',
      type: 'event_msg',
      role: 'user',
      text: '链路验证四：请只回复“状态回传正常”。'
    }, {
      timestamp: '2026-05-29T15:00:01Z',
      type: 'event_msg',
      role: 'assistant',
      text: '状态回传正常'
    }];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
