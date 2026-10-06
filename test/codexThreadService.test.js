import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexThreadService } from '../src/codexThreadService.js';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';

test('desktop project catalog exposes empty and nested saved projects to the shared task store', async () => {
  const root = process.cwd();
  const child = path.join(root, 'src');
  const projects = [{ id: 'parent', name: 'Parent', root }];
  const service = new CodexThreadService({
    projects, allowIndependentAppServer: false, runStatePath: null,
    sessions: { async listDesktopProjects() { return [{ root: child, name: 'Empty nested' }]; } },
    desktopThreadListProvider: async () => ({ data: [] })
  });
  const listed = await service.listProjects();
  assert.equal(listed.length, 2);
  assert.equal(listed[1].root, child);
  assert.equal(listed[1].name, 'Empty nested');
  assert.equal(projects[1].id, listed[1].id);
  assert.equal(service.resolveProject(listed[1].id).root, child);
  const calls = [];
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async request(method, params) {
      calls.push({ method, params });
      return { thread: { id: 'selected-project-thread', cwd: params.cwd } };
    }
  } });
  await adapter.startThread({ model: '' }, service.resolveProject(listed[1].id), () => {});
  assert.equal(calls[0].method, 'thread/start');
  assert.equal(calls[0].params.cwd, child);
});

test('CodexThreadService starts a thread, sends a turn, and exposes live session state', async () => {
  const client = new FakeAppServerClient();
  const desktopOpens = [];
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    sandbox: 'danger-full-access',
    autoOpenDesktop: true,
    desktopOpener: async (threadId) => {
      desktopOpens.push(threadId);
      return { ok: true, threadId };
    }
  });

  const result = await service.startThread({
    projectId: 'probe',
    prompt: '你好',
    model: 'gpt-alt',
    reasoningEffort: 'xhigh',
    submissionId: 'phone-receipt-1'
  });
  assert.equal(result.run.status, 'running');
  assert.equal(service.findRunBySubmission({
    kind: 'new_thread',
    projectId: 'probe',
    submissionId: 'phone-receipt-1'
  })?.id, result.run.id);
  assert.equal(service.findRunBySubmission({
    kind: 'existing_thread',
    threadId: '019e-thread',
    submissionId: 'phone-receipt-1'
  })?.id, result.run.id);
  await client.waitForRequest('turn/start');

  const running = service.getRun(result.run.id);
  assert.equal(running.status, 'running');
  await until(() => desktopOpens.length >= 1);
  assert.equal(desktopOpens[0], '019e-thread');
  const turnStartCall = client.calls.find((call) => call.method === 'turn/start');
  assert.deepEqual(turnStartCall.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turnStartCall.params.model, 'gpt-alt');
  assert.equal(turnStartCall.params.effort, 'xhigh');
  assert.equal(running.model, 'gpt-alt');
  assert.equal(running.codexSessionId, '019e-thread');
  assert.deepEqual(running.session.entries.map((entry) => `${entry.role}:${entry.text}`), [
    'user:你好'
  ]);

  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: '019e-thread',
      itemId: 'assistant-1',
      delta: '你好，'
    }
  });
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: '019e-thread',
      itemId: 'assistant-1',
      delta: '我正在处理。'
    }
  });
  const streamingSession = await service.getThread('019e-thread');
  assert.deepEqual(streamingSession.entries.map((entry) => `${entry.type}:${entry.text}`), [
    'userMessage:你好',
    'live_activity:正在返回内容'
  ]);
  assert.equal(streamingSession.entries.at(-1).liveKind, 'assistant');

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-thread',
      turn: {
        id: 'turn-1',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');
  const completed = service.getRun(result.run.id);

  assert.equal(completed.status, 'completed');
  await until(() => desktopOpens.length >= 2);
  assert.deepEqual(desktopOpens, ['019e-thread', '019e-thread']);
  assert.equal(completed.session.id, '019e-thread');
  assert.deepEqual(completed.session.entries.map((entry) => `${entry.role}:${entry.text}`), [
    'user:你好',
    'assistant:你好，我正在处理。'
  ]);
});

test('CodexThreadService steers an active turn without creating a second run', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    runStatePath: ''
  });
  const started = await service.startThread({
    projectId: 'probe',
    prompt: '先检查当前实现',
    submissionId: 'initial-message'
  });
  await client.waitForRequest('turn/start');

  const steered = await service.steerMessage({
    threadId: '019e-thread',
    text: '补充检查移动端截图',
    submissionId: 'guidance-message'
  });

  assert.equal(steered.id, started.run.id);
  assert.equal(steered.prompt, '补充检查移动端截图');
  assert.equal(service.listRuns().length, 1);
  assert.equal(service.findRunBySubmission({
    kind: 'existing_thread',
    threadId: '019e-thread',
    submissionId: 'guidance-message'
  })?.id, started.run.id);
  const steerCall = client.calls.find((call) => call.method === 'turn/steer');
  assert.deepEqual(steerCall.params, {
    threadId: '019e-thread',
    input: [{ type: 'text', text: '补充检查移动端截图' }],
    expectedTurnId: 'turn-1'
  });
  const session = await service.getThread('019e-thread');
  assert.deepEqual(session.entries.filter((entry) => entry.role === 'user').map((entry) => entry.text), [
    '先检查当前实现',
    '补充检查移动端截图'
  ]);
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-thread',
      turn: {
        id: 'turn-1',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(started.run.id).status === 'completed');
});

test('CodexThreadService does not auto-open desktop deeplinks by default', async () => {
  let opened = 0;
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    desktopOpener: async () => {
      opened += 1;
    }
  });

  const result = await service.startThread({
    cwd: process.cwd(),
    prompt: 'hello'
  });

  assert.equal(result.run.status, 'running');
  assert.equal(client.calls[0].params.cwd, 'C:\\work');
  assert.equal(opened, 0);
});

test('CodexThreadService ignores phone supplied cwd and uses configured project root for new threads', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }]
  });

  const result = await service.startThread({
    projectId: 'probe',
    cwd: pathJoinTemp('phone-supplied'),
    prompt: ''
  });

  assert.equal(result.run, null);
  assert.equal(client.calls[0].method, 'thread/start');
  assert.equal(client.calls[0].params.cwd, 'C:\\work');
});

test('CodexThreadService blocks new threads when configured project root is temporary', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: pathJoinTemp('codex-phone-bad-root') }]
  });

  await assert.rejects(
    () => service.startThread({ projectId: 'probe', prompt: '你好' }),
    /临时目录/
  );
  assert.equal(client.calls.length, 0);
});

test('CodexThreadService lists app-server threads as phone sessions', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({ client });

  const sessions = await service.listThreads({ limit: 10 });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, '019e-thread');
  assert.equal(sessions[0].title, '测试会话');
  assert.equal(sessions[0].sidebarSection, 'recent');
  assert.equal(sessions[0].detailAvailable, true);
});

test('CodexThreadService exposes a versioned runtime snapshot keyed by the active turn', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-runtime-thread',
        title: '统一状态',
        updatedAt: '2026-07-30T09:00:00.000Z',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        runtimeState: 'completed',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-07-30T08:59:50.000Z',
        terminalReason: 'completed',
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({
    client,
    sessions,
    allowIndependentAppServer: false,
    runtimeSnapshotEpoch: 'snapshot-epoch',
    desktopThreadListProvider: async () => ({ data: [{ id: '019e-runtime-thread', updatedAt: 1785392400, status: { type: 'idle' } }] })
  });
  service.runs.set('run-active', {
    id: 'run-active',
    threadId: '019e-runtime-thread',
    turnId: 'turn-new',
    status: 'waiting_approval',
    createdAt: '2026-07-30T09:00:01.000Z',
    updatedAt: '2026-07-30T09:00:02.000Z'
  });
  service.activeRunsByThreadId.set('019e-runtime-thread', 'run-active');

  const first = await service.getRuntimeSnapshot();
  const second = await service.getRuntimeSnapshot();

  assert.equal(first.epoch, 'snapshot-epoch');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(first.sessions[0].threadId, '019e-runtime-thread');
  assert.equal(first.sessions[0].activeTurnId, 'turn-new');
  assert.equal(first.sessions[0].state, 'waiting_approval');
  assert.equal(first.sessions[0].source, 'app-server-run');
});

test('CodexThreadService marks runtime snapshots stale when desktop runtime enrichment is unavailable', async () => {
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-stale-runtime',
        title: '旧文件状态',
        updatedAt: '2026-07-30T09:00:00.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        detailAvailable: true
      }];
    }
  };
  const official = new CodexThreadService({
    sessions,
    allowIndependentAppServer: false,
    desktopThreadListProvider: async () => ({ data: [{ id: '019e-stale-runtime', status: { type: 'active' } }] }),
    runtimeStateProvider: async () => [{
      threadId: '019e-stale-runtime',
      state: 'idle',
      source: 'desktop-app-server'
    }]
  });
  const unavailable = new CodexThreadService({
    sessions,
    allowIndependentAppServer: false,
    desktopThreadListProvider: async () => ({ data: [{ id: '019e-stale-runtime', status: { type: 'active' } }] }),
    runtimeStateProvider: async () => {
      throw new Error('desktop app-server offline');
    }
  });

  const freshSnapshot = await official.getRuntimeSnapshot();
  const staleSnapshot = await unavailable.getRuntimeSnapshot();

  assert.equal(freshSnapshot.stale, false);
  assert.equal(freshSnapshot.sessions[0].state, 'idle');
  assert.equal(staleSnapshot.stale, true);
  assert.equal(staleSnapshot.sessions[0].state, 'running');
  assert.equal(staleSnapshot.sessions[0].source, 'app-server-thread-list');
});

test('CodexThreadService reconciles App Server active state without hiding unverified desktop work', async () => {
  const client = new FakeAppServerClient();
  client.threadListStatus = { type: 'idle' };
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-thread',
        title: '桌面已结束但文件仍显示运行',
        updatedAt: '2026-07-30T09:00:00.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-07-30T09:00:00.000Z',
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({
    client,
    sessions,
    runtimeStateProvider: async () => {
      throw new Error('desktop CDP unavailable');
    }
  });

  const snapshot = await service.getRuntimeSnapshot();

  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.sessions[0].state, 'running');
  assert.equal(snapshot.sessions[0].source, 'session-file');
  assert.equal(
    client.calls.some((call) => call.method === 'thread/read'),
    false
  );

  const activeClient = new FakeAppServerClient();
  activeClient.threadListStatus = {
    type: 'active',
    activeFlags: ['approval']
  };
  const appServerOfficial = new CodexThreadService({
    client: activeClient,
    sessions,
    runtimeStateProvider: async () => {
      throw new Error('desktop CDP unavailable');
    }
  });
  const appServerSnapshot = await appServerOfficial.getRuntimeSnapshot();
  assert.equal(appServerSnapshot.stale, false);
  assert.equal(appServerSnapshot.sessions[0].state, 'waiting_approval');
  assert.equal(appServerSnapshot.sessions[0].source, 'app-server-thread-list');

  const desktopOfficial = new CodexThreadService({
    client: new FakeAppServerClient(),
    sessions,
    runtimeStateProvider: async () => [{
      threadId: '019e-thread',
      state: 'running',
      activeTurnId: 'desktop-turn',
      updatedAt: '2026-07-30T09:01:00.000Z',
      source: 'desktop-app-server',
      canInterrupt: true
    }]
  });
  const desktopSnapshot = await desktopOfficial.getRuntimeSnapshot();
  assert.equal(desktopSnapshot.stale, false);
  assert.equal(desktopSnapshot.sessions[0].state, 'running');
  assert.equal(desktopSnapshot.sessions[0].source, 'desktop-app-server');
  assert.equal(desktopSnapshot.sessions[0].activeTurnId, 'desktop-turn');
});

test('CodexThreadService strict desktop mode never starts or requests the independent app-server', async () => {
  const client = new FakeAppServerClient();
  let initialized = 0;
  client.initialize = async () => {
    initialized += 1;
  };
  const desktopSession = {
    id: '019e-desktop-thread',
    title: '桌面严格会话',
    updatedAt: '2026-07-29T00:00:00.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'desktop-sidebar',
    activitySource: 'session-file',
    activityStatus: 'running',
    runtimeState: 'running',
    detailAvailable: true,
    entries: [{
      timestamp: '2026-07-29T00:00:00.000Z',
      type: 'event_msg',
      role: 'assistant',
      text: '桌面会话内容'
    }],
    entryCount: 1
  };
  const sessions = {
    async listSessions() {
      return [desktopSession];
    },
    async getSession() {
      return desktopSession;
    }
  };
  const service = new CodexThreadService({
    client,
    sessions,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    allowIndependentAppServer: false,
    projectHistoryPath: null,
    desktopThreadListProvider: async () => ({ data: [{ id: desktopSession.id, name: desktopSession.title, cwd: desktopSession.projectRoot }] }),
    runStatePath: null
  });

  const health = await service.initialize();
  const listed = await service.listThreads({ limit: 10 });
  const projects = await service.listProjects();
  const detail = await service.getThread('019e-desktop-thread');

  assert.deepEqual(health, {
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
  assert.equal(initialized, 0);
  assert.equal(client.calls.length, 0);
  assert.equal(listed[0].id, '019e-desktop-thread');
  assert.equal(projects.some((project) => project.id === 'probe'), true);
  assert.equal(detail.entries[0].text, '桌面会话内容');
  await assert.rejects(
    () => service.startThread({ projectId: 'probe', prompt: '不允许分叉' }),
    /严格桌面模式已禁用独立 App Server/
  );
  await assert.rejects(
    () => service.sendMessage({ threadId: '019e-desktop-thread', text: '不允许旁路' }),
    /严格桌面模式已禁用独立 App Server/
  );
  assert.equal(client.calls.length, 0);
});

test('CodexThreadService merges app-server projects even when desktop sidebar sessions are available', async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'thread/list') {
      return {
        data: [{
          id: '019e-desktop-thread',
          name: 'Boss app-server 会话',
          cwd: 'C:\\projects\\BossAi-All',
          updatedAt: 1785114000
        }, {
          id: '019e-vibe-thread',
          name: 'Vibelution 会话',
          cwd: 'C:\\projects\\Vibelution',
          updatedAt: 1785117600
        }]
      };
    }
    throw new Error(`Unexpected request ${method}`);
  };
  const desktopSessions = [{
    id: '019e-desktop-thread',
    title: '桌面侧栏会话',
    updatedAt: '2026-05-29T08:00:00.000Z',
    relativeTime: '1 小时前',
    projectRoot: 'C:\\projects\\BossAi-All',
    projectLabel: 'BossAi-All',
    sidebarSection: 'recent',
    source: 'desktop-sidebar',
    activitySource: 'session-file',
    pinned: true,
    detailAvailable: true
  }];
  const sessions = {
    async listSessions({ limit, query }) {
      assert.equal(limit, 10);
      assert.equal(query, '');
      return desktopSessions;
    }
  };
  const service = new CodexThreadService({
    client,
    sessions,
    projects: [{
      id: 'boss',
      name: 'BossAi-All',
      root: 'C:\\projects\\BossAi-All'
    }, {
      id: 'vibe',
      name: 'Vibelution',
      root: 'C:\\projects\\Vibelution'
    }]
  });

  const listed = await service.listThreads({ limit: 10 });

  assert.equal(client.calls.some((call) => call.method === 'thread/list'), true);
  assert.deepEqual(new Set(listed.map((session) => session.id)), new Set([
    '019e-desktop-thread',
    '019e-vibe-thread'
  ]));
  assert.equal(listed.find((session) => session.id === '019e-desktop-thread').pinned, true);
  assert.equal(listed.find((session) => session.id === '019e-desktop-thread').title, '桌面侧栏会话');
  assert.equal(listed.find((session) => session.id === '019e-desktop-thread').projectLabel, 'BossAi-All');
  assert.equal(listed.find((session) => session.id === '019e-desktop-thread').sidebarSection, 'recent');
  assert.equal(listed.find((session) => session.id === '019e-vibe-thread').projectLabel, 'Vibelution');
});

test('CodexThreadService falls back to desktop sessions when app-server thread listing fails', async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    throw new Error('app-server unavailable');
  };
  const desktopSession = {
    id: '019e-local-thread',
    title: '本地回退会话',
    updatedAt: '2026-07-27T08:00:00.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\projects\\LocalOnly',
    projectLabel: 'LocalOnly',
    source: 'desktop-sidebar',
    activitySource: 'session-file',
    pinned: false,
    detailAvailable: true
  };
  const service = new CodexThreadService({
    client,
    sessions: {
      async listSessions() {
        return [desktopSession];
      }
    }
  });

  const listed = await service.listThreads({ limit: 10 });

  assert.deepEqual(listed, [desktopSession]);
  assert.equal(client.calls.some((call) => call.method === 'thread/list'), true);
});

test('CodexThreadService discovers and persists projects from paginated app-server cwd values', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-project-catalog-'));
  const historyPath = path.join(tempRoot, 'projects.json');
  const projects = [];
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method !== 'thread/list') {
      throw new Error(`Unexpected request ${method}`);
    }
    if (!params.cursor) {
      return {
        data: [{
          id: '019e-boss-thread',
          name: 'Boss 会话',
          cwd: 'C:\\projects\\BossAi-All',
          updatedAt: 1785114000
        }],
        nextCursor: 'page-2'
      };
    }
    assert.equal(params.cursor, 'page-2');
    return {
      data: [{
        id: '019e-vibe-thread',
        name: 'Vibelution 会话',
        cwd: 'C:\\projects\\Vibelution',
        updatedAt: 1785117600
      }],
      nextCursor: null
    };
  };
  try {
    const service = new CodexThreadService({
      client,
      projects,
      projectHistoryPath: historyPath
    });

    const listedProjects = await service.listProjects({ limit: 200 });

    assert.deepEqual(listedProjects.map((project) => project.name).sort(), ['BossAi-All', 'Vibelution']);
    assert.equal(client.calls.filter((call) => call.method === 'thread/list').length, 2);
    assert.equal(client.calls[1].params.cursor, 'page-2');
    assert.equal(projects.length, 2);

    const saved = JSON.parse(await fs.readFile(historyPath, 'utf8'));
    assert.deepEqual(saved.projects.map((project) => project.root).sort(), [
      'C:\\projects\\BossAi-All',
      'C:\\projects\\Vibelution'
    ]);

    const offlineClient = new FakeAppServerClient();
    offlineClient.request = async () => {
      throw new Error('offline');
    };
    const restored = await new CodexThreadService({
      client: offlineClient,
      projects: [],
      projectHistoryPath: historyPath
    }).listProjects({ limit: 200 });
    assert.deepEqual(restored.map((project) => project.name).sort(), ['BossAi-All', 'Vibelution']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('CodexThreadService preserves desktop running status when live snapshot is idle', async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          name: '设置',
          cwd: 'C:\\work',
          turns: [{
            id: 'turn-1',
            status: 'inProgress'
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  };
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-thread',
        title: '设置',
        updatedAt: '2026-05-30T08:24:09.016Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-05-30T08:24:09.016Z',
        terminalReason: 'interrupted',
        pinned: false,
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '设置',
    updatedAt: '2026-05-30T08:24:10.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    activitySource: 'app-server-live',
    activityStatus: 'idle',
    activityUpdatedAt: '',
    terminalReason: 'interrupted',
    detailAvailable: true,
    entries: [],
    entryCount: 0
  });

  const listed = await service.listThreads({ limit: 10 });

  assert.equal(listed[0].id, '019e-thread');
  assert.equal(listed[0].activityStatus, 'running');
  assert.equal(listed[0].activityUpdatedAt, '2026-05-30T08:24:09.016Z');
  assert.equal(listed[0].terminalReason, '');
});

test('CodexThreadService lets completed live task state override stale desktop running snapshot', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-thread',
        title: '设置',
        updatedAt: '2026-06-16T18:24:36.949Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-06-16T18:24:36.949Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-06-16T18:24:36.949Z',
        canInterrupt: true,
        pinned: false,
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '设置',
    updatedAt: '2026-06-16T18:24:37.200Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    activitySource: 'app-server-live',
    activityStatus: 'completed',
    activityUpdatedAt: '2026-06-16T18:24:37.200Z',
    runtimeState: 'completed',
    runtimeSource: 'app-server-live',
    runtimeUpdatedAt: '2026-06-16T18:24:37.200Z',
    canInterrupt: false,
    detailAvailable: true,
    entries: [],
    entryCount: 0
  });

  const listed = await service.listThreads({ limit: 10 });

  assert.equal(listed[0].id, '019e-thread');
  assert.equal(listed[0].activityStatus, 'completed');
  assert.equal(listed[0].runtimeState, 'completed');
  assert.equal(listed[0].canInterrupt, false);
  assert.equal(listed[0].terminalReason, 'completed');
});

test('CodexThreadService does not hydrate full thread history while listing local running sessions', async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'thread/read') {
      throw new Error('full history read must not happen during thread listing');
    }
    throw new Error(`Unexpected request ${method}`);
  };
  const sessions = {
    async listSessions() {
      return [{
        id: '019e-thread',
        title: '设置',
        updatedAt: '2026-06-19T14:40:38.000Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-06-19T14:40:38.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-06-19T14:40:38.000Z',
        canInterrupt: true,
        pinned: false,
        detailAvailable: true
      }];
    }
  };
  const service = new CodexThreadService({ client, sessions });

  const listed = await service.listThreads({ limit: 10 });

  assert.equal(client.calls.some((call) => call.method === 'thread/read'), false);
  assert.equal(listed[0].id, '019e-thread');
  assert.equal(listed[0].activityStatus, 'running');
  assert.equal(listed[0].runtimeState, 'running');
  assert.equal(listed[0].canInterrupt, true);
  assert.equal(listed[0].activitySource, 'session-file');
});

test('CodexThreadService reads existing thread detail from local rollout before stale app-server snapshot', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async getSession(threadId, { tail }) {
      assert.equal(threadId, '019e-thread');
      assert.equal(String(tail), '160');
      return {
        id: threadId,
        title: '测试会话',
        updatedAt: '2026-05-29T16:33:14.018Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        detailAvailable: true,
        filePath: 'C:\\Users\\agent\\.codex\\sessions\\rollout.jsonl',
        entries: [{
          timestamp: '2026-05-29T16:33:02.593Z',
          type: 'response_item',
          role: 'user',
          text: '手机发给你的消息，看看正确进入对话了吗'
        }, {
          timestamp: '2026-05-29T16:33:14.018Z',
          type: 'event_msg',
          role: 'assistant',
          text: '我来按日志链路查，不靠猜'
        }],
        entryCount: 2
      };
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '测试会话',
    updatedAt: '2026-05-29T16:28:28.000Z',
    relativeTime: '刚刚',
    projectRoot: 'C:\\work',
    projectLabel: 'work',
    source: 'app-server-live',
    detailAvailable: true,
    entries: [{
      timestamp: '2026-05-29T16:28:28.000Z',
      type: 'agentMessage',
      role: 'assistant',
      text: '旧快照'
    }],
    entryCount: 1
  });

  const detail = await service.getThread('019e-thread', { tail: 160 });

  assert.equal(detail.source, 'desktop-sidebar');
  assert.deepEqual(detail.entries.map((entry) => entry.text), [
    '手机发给你的消息，看看正确进入对话了吗',
    '我来按日志链路查，不靠猜'
  ]);
  assert.equal(client.calls.some((call) => call.method === 'thread/read'), false);
});

test('CodexThreadService overlays live terminal state on stale local running detail', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async getSession() {
      return {
        id: '019e-thread',
        title: '测试会话',
        updatedAt: '2026-06-19T07:47:59.000Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-06-19T07:47:59.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-06-19T07:47:59.000Z',
        canInterrupt: true,
        detailAvailable: true,
        filePath: 'C:\\Users\\agent\\.codex\\sessions\\rollout.jsonl',
        entries: [{
          timestamp: '2026-06-19T07:47:59.000Z',
          type: 'live_activity',
          role: 'system',
          text: '正在返回内容'
        }],
        entryCount: 1
      };
    },
    async getSessionSync() {
      return {
        id: '019e-thread',
        title: '测试会话',
        updatedAt: '2026-06-19T07:47:59.000Z',
        source: 'desktop-sidebar',
        activityStatus: 'running',
        runtimeState: 'running',
        canInterrupt: true,
        detailAvailable: true,
        entries: [{
          timestamp: '2026-06-19T07:47:59.000Z',
          type: 'live_activity',
          role: 'system',
          text: '正在返回内容'
        }],
        sync: { mode: 'recent', source: 'session-file' }
      };
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '测试会话',
    updatedAt: '2026-06-19T07:48:00.000Z',
    source: 'app-server-live',
    activitySource: 'app-server-live',
    activityStatus: 'interrupted',
    activityUpdatedAt: '2026-06-19T07:48:00.000Z',
    runtimeState: 'interrupted',
    runtimeSource: 'app-server-live',
    runtimeUpdatedAt: '2026-06-19T07:48:00.000Z',
    canInterrupt: false,
    terminalReason: 'interrupted',
    entries: []
  });

  const detail = await service.getThread('019e-thread', { tail: 20 });
  const sync = await service.syncThread('019e-thread', { limit: 20 });

  for (const view of [detail, sync]) {
    assert.equal(view.activityStatus, 'interrupted');
    assert.equal(view.runtimeState, 'interrupted');
    assert.equal(view.canInterrupt, false);
    assert.equal(view.terminalReason, 'interrupted');
    assert.equal(view.entries.some((entry) => entry.type === 'live_activity'), false);
  }
});

test('CodexThreadService keeps newer local running state over stale live terminal snapshot', async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          name: '测试会话',
          cwd: 'C:\\work',
          turns: [{
            id: 'turn-1',
            status: 'inProgress'
          }]
        }
      };
    }
    throw new Error(`Unexpected request ${method}`);
  };
  const sessions = {
    async getSession() {
      return {
        id: '019e-thread',
        title: '测试会话',
        updatedAt: '2026-06-19T09:07:10.000Z',
        relativeTime: '刚刚',
        projectRoot: 'C:\\work',
        projectLabel: 'work',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-06-19T09:07:10.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-06-19T09:07:10.000Z',
        canInterrupt: true,
        detailAvailable: true,
        entries: [{
          timestamp: '2026-06-19T09:07:10.000Z',
          type: 'live_activity',
          role: 'system',
          text: '正在返回内容'
        }],
        entryCount: 1
      };
    }
  };
  const service = new CodexThreadService({ client, sessions });
  service.liveSessions.set('019e-thread', {
    id: '019e-thread',
    title: '测试会话',
    updatedAt: '2026-06-19T08:34:18.000Z',
    source: 'app-server-live',
    activitySource: 'app-server-live',
    activityStatus: 'interrupted',
    activityUpdatedAt: '2026-06-19T08:34:18.000Z',
    runtimeState: 'interrupted',
    runtimeSource: 'app-server-live',
    runtimeUpdatedAt: '2026-06-19T08:34:18.000Z',
    canInterrupt: false,
    terminalReason: 'interrupted',
    entries: []
  });

  const detail = await service.getThread('019e-thread', { tail: 20 });

  assert.equal(detail.activityStatus, 'running');
  assert.equal(detail.runtimeState, 'running');
  assert.equal(detail.canInterrupt, true);
  assert.equal(detail.entries.at(-1).type, 'live_activity');
});

test('CodexThreadService refreshes desktop terminal state when local rollout is still running after bridge restart', async () => {
  const client = new FakeAppServerClient();
  const sessions = {
    async getSession() {
      return {
        id: '019e-thread',
        title: '测试会话',
        updatedAt: '2026-06-19T07:47:59.000Z',
        source: 'desktop-sidebar',
        activitySource: 'session-file',
        activityStatus: 'running',
        activityUpdatedAt: '2026-06-19T07:47:59.000Z',
        runtimeState: 'running',
        runtimeSource: 'session-file',
        runtimeUpdatedAt: '2026-06-19T07:47:59.000Z',
        canInterrupt: true,
        detailAvailable: true,
        entries: [{
          timestamp: '2026-06-19T07:47:59.000Z',
          type: 'live_activity',
          role: 'system',
          text: '正在返回内容'
        }],
        entryCount: 1
      };
    }
  };
  const service = new CodexThreadService({ client, sessions });

  const detail = await service.getThread('019e-thread', { tail: 20 });

  assert.equal(detail.activityStatus, 'completed');
  assert.equal(detail.runtimeState, 'completed');
  assert.equal(detail.canInterrupt, false);
  assert.equal(detail.terminalReason, 'completed');
  assert.equal(detail.entries.some((entry) => entry.type === 'live_activity'), false);
  assert.equal(client.calls.some((call) => call.method === 'thread/read'), true);
});

test('CodexThreadService accepts nested app-server notification ids and generic reasoning deltas', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: false
  });

  const result = await service.startThread({ projectId: 'probe', prompt: '分析一下' });
  await client.waitForRequest('turn/start');

  client.emit('notification', {
    method: 'item/started',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        threadId: '019e-thread',
        turnId: 'turn-1'
      }
    }
  });
  client.emit('notification', {
    method: 'item/delta',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        thread_id: '019e-thread',
        turn_id: 'turn-1'
      },
      delta: {
        text: '正在检查日志'
      }
    }
  });

  const streamingSession = await service.getThread('019e-thread');
  assert.deepEqual(streamingSession.entries.map((entry) => `${entry.type}:${entry.text}`), [
    'userMessage:分析一下',
    'live_activity:正在思考'
  ]);
  assert.equal(streamingSession.entries.at(-1).liveKind, 'reasoning');

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      turn: {
        id: 'turn-1',
        thread_id: '019e-thread',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');
  assert.equal(service.getRun(result.run.id).status, 'completed');
});

test('CodexThreadService keeps one bottom live activity while work changes from reasoning to command output', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: false
  });

  await service.startThread({ projectId: 'probe', prompt: '继续修复' });
  await client.waitForRequest('turn/start');

  client.emit('notification', {
    method: 'item/delta',
    params: {
      item: {
        id: 'reason-1',
        type: 'reasoning',
        threadId: '019e-thread',
        turnId: 'turn-1'
      },
      delta: {
        text: '定位状态入口'
      }
    }
  });
  client.emit('notification', {
    method: 'item/started',
    params: {
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'npm test -- test/codexThreadService.test.js',
        threadId: '019e-thread',
        turnId: 'turn-1'
      }
    }
  });
  client.emit('notification', {
    method: 'item/commandExecution/outputDelta',
    params: {
      itemId: 'command-1',
      threadId: '019e-thread',
      turnId: 'turn-1',
      delta: 'ok 1 - live activity'
    }
  });

  const streamingSession = await service.getThread('019e-thread');
  const liveEntries = streamingSession.entries.filter((entry) => entry.type === 'live_activity');
  assert.equal(liveEntries.length, 1);
  assert.equal(streamingSession.entries.at(-1), liveEntries[0]);
  assert.equal(liveEntries[0].liveKind, 'command');
  assert.equal(liveEntries[0].text, '正在执行命令');
});

test('CodexThreadService surfaces app-server auth errors as client notice entries', async () => {
  const client = new FakeAppServerClient();
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    autoOpenDesktop: false
  });

  const result = await service.startThread({ projectId: 'probe', prompt: '继续' });
  await client.waitForRequest('turn/start');

  client.emit('notification', {
    method: 'error',
    params: {
      threadId: '019e-thread',
      turnId: 'turn-1',
      statusCode: 401,
      error: {
        code: 'unauthorized',
        message: 'Unauthorized'
      }
    }
  });

  await until(() => service.getRun(result.run.id).status === 'failed');
  const failed = service.getRun(result.run.id);
  const notice = failed.session.entries.find((entry) => entry.type === 'codex_client_notice');

  assert.equal(failed.status, 'failed');
  assert.ok(notice);
  assert.equal(notice.liveKind, 'auth');
  assert.match(notice.text, /Codex 鉴权失败/);
  const noticeEvent = failed.events.find((event) => event.payload?.notice);
  assert.match(noticeEvent.payload.notice.title, /鉴权/);
});

test('CodexThreadService blocks deleting a running thread and clears local snapshots after deletion', async () => {
  const client = new FakeAppServerClient();
  const deleted = [];
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    sessions: {
      async deleteSession(threadId) {
        deleted.push(threadId);
        return {
          id: threadId,
          deletedFiles: ['C:\\Users\\agent\\.codex\\sessions\\rollout-019e-thread.jsonl'],
          archivedThreadCount: 1,
          removedIndexRecords: 1,
          removedGlobalStateEntries: 0,
          deletedAt: '2026-06-08T00:00:00.000Z'
        };
      }
    }
  });

  const result = await service.startThread({ prompt: '运行中' });
  await client.waitForRequest('turn/start');
  await assert.rejects(
    () => service.deleteThread('019e-thread'),
    /会话正在进行中/
  );
  assert.deepEqual(deleted, []);

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: '019e-thread',
      turn: {
        id: 'turn-1',
        status: 'completed'
      }
    }
  });
  await until(() => service.getRun(result.run.id).status === 'completed');

  const deletion = await service.deleteThread('019e-thread');
  assert.equal(deletion.archivedThreadCount, 1);
  assert.deepEqual(deleted, []);
  assert.equal(service.liveSessions.has('019e-thread'), false);
  assert.equal(client.calls.some((call) => call.method === 'thread/archive' && call.params.threadId === '019e-thread'), true);
});

test('CodexThreadService refuses deletion when App Server reports an externally running thread', async () => {
  const client = new FakeAppServerClient();
  client.threadStatus = 'inProgress';
  const deleted = [];
  const service = new CodexThreadService({
    client,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    sessions: {
      async deleteSession(threadId) {
        deleted.push(threadId);
        return {
          id: threadId,
          deletedFiles: [],
          preservedFiles: ['C:\\Users\\agent\\.codex\\sessions\\rollout-019e-thread.jsonl'],
          archivedThreadCount: 1,
          removedIndexRecords: 1,
          removedGlobalStateEntries: 0,
          deletedAt: '2026-06-08T00:00:00.000Z'
        };
      }
    }
  });

  await assert.rejects(
    () => service.deleteThread('019e-thread'),
    /会话正在进行中/
  );
  assert.deepEqual(deleted, []);
  assert.equal(client.calls.some((call) => call.method === 'thread/archive'), false);
});

test('CodexThreadService refuses deletion when a strict desktop session snapshot is still running', async () => {
  const deleted = [];
  const service = new CodexThreadService({
    allowIndependentAppServer: false,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    sessions: {
      async getSession(threadId) {
        return {
          id: threadId,
          activityStatus: 'running',
          runtimeState: 'running',
          entries: []
        };
      },
      async deleteSession(threadId) {
        deleted.push(threadId);
        return {
          id: threadId,
          deletedFiles: [],
          preservedFiles: [],
          archivedThreadCount: 1,
          removedIndexRecords: 1,
          removedGlobalStateEntries: 0,
          deletedAt: '2026-06-08T00:00:00.000Z'
        };
      }
    }
  });

  await assert.rejects(
    () => service.deleteThread('019e-thread'),
    /会话正在进行中/
  );
  assert.deepEqual(deleted, []);
});

test('CodexThreadService archives a completed strict desktop thread before hiding its local session', async () => {
  const archived = [];
  const deleted = [];
  const service = new CodexThreadService({
    allowIndependentAppServer: false,
    projects: [{ id: 'probe', name: 'Probe', root: 'C:\\work' }],
    archiveThreadProvider: async (threadId) => {
      archived.push(threadId);
      return { ok: true };
    },
    sessions: {
      async getSession(threadId) {
        return {
          id: threadId,
          activityStatus: 'completed',
          runtimeState: 'completed',
          entries: []
        };
      },
      async deleteSession(threadId) {
        deleted.push(threadId);
        const error = new Error('拒绝删除 Codex 会话目录之外的文件');
        error.statusCode = 403;
        throw error;
        return {
          id: threadId,
          deletedFiles: [],
          preservedFiles: ['C:\\Users\\agent\\.codex\\sessions\\rollout-019e-thread.jsonl'],
          archivedThreadCount: 1,
          removedIndexRecords: 1,
          removedGlobalStateEntries: 0,
          deletedAt: '2026-06-08T00:00:00.000Z'
        };
      }
    }
  });

  const result = await service.deleteThread('019e-thread');

  assert.deepEqual(archived, ['019e-thread']);
  assert.deepEqual(deleted, []);
  assert.equal(result.officialArchived, true);
  assert.deepEqual(result.preservedFiles, []);
});

test('deletion without an official archive channel fails without changing local state', async () => {
  const service = new CodexThreadService({
    allowIndependentAppServer: false,
    sessions: { async deleteSession() { assert.fail('must not mutate official files'); } }
  });
  service.liveSessions.set('019e-thread', { id: '019e-thread' });
  await assert.rejects(service.deleteThread('019e-thread'), { statusCode: 503 });
  assert.equal(service.liveSessions.has('019e-thread'), true);
});

test('official archive errors remain failures and preserve the local visible snapshot', async () => {
  const service = new CodexThreadService({
    allowIndependentAppServer: false,
    archiveThreadProvider: async () => { throw new Error('archive unavailable'); }
  });
  service.liveSessions.set('019e-thread', { id: '019e-thread' });
  await assert.rejects(service.deleteThread('019e-thread'), /archive unavailable/);
  assert.equal(service.liveSessions.has('019e-thread'), true);
});

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.waiters = [];
    this.threadStatus = 'completed';
    this.threadListStatus = { type: 'idle' };
  }

  async request(method, params) {
    this.calls.push({ method, params });
    this.resolveWaiters(method);
    if (method === 'thread/list') {
      return {
        data: [{
          id: '019e-thread',
          name: '测试会话',
          cwd: 'C:\\work',
          updatedAt: 1779926401,
          status: this.threadListStatus
        }]
      };
    }
    if (method === 'thread/start') {
      return {
        thread: {
          id: '019e-thread',
          name: '',
          cwd: params.cwd,
          updatedAt: 1779926400,
          turns: []
        }
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          cwd: 'C:\\work',
          turns: []
        }
      };
    }
    if (method === 'turn/start') {
      return {
        turn: {
          id: 'turn-1',
          status: 'inProgress'
        }
      };
    }
    if (method === 'turn/steer') {
      return {
        turnId: params.expectedTurnId
      };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          name: '测试会话',
          cwd: 'C:\\work',
          updatedAt: 1779926401,
          turns: [{
            id: 'turn-1',
            status: this.threadStatus,
            startedAt: 1779926400,
            completedAt: 1779926401,
            items: [{
              type: 'userMessage',
              id: 'user-1',
              content: [{ type: 'text', text: '你好', text_elements: [] }]
            }, {
              type: 'agentMessage',
              id: 'assistant-1',
              text: '你好，我正在处理。'
            }]
          }]
        }
      };
    }
    if (method === 'thread/archive') {
      return {};
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

async function until(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

function pathJoinTemp(child) {
  return path.join(os.tmpdir(), child);
}


