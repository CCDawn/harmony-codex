import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CodexSessionStore } from '../src/codexSessions.js';

test('desktop presentation decorates only protocol results without reading session files', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-presentation-'));
  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'pinned-thread-ids': ['user', 'internal'],
    'projectless-thread-ids': ['user']
  }));
  const store = new CodexSessionStore({ codexHome });
  const result = await store.decorateDesktopThreads([{ id: 'user', title: 'official title', projectRoot: '', pinned: false }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'user');
  assert.equal(result[0].title, 'official title');
  assert.equal(result[0].pinned, true);
  assert.equal(result[0].sidebarSection, 'recent');
});

test('CodexSessionStore lists latest sessions and reads detail previews', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  const sessionId = '019e-test-session';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '旧名字', updated_at: '2026-05-28T01:00:00Z' }),
    JSON.stringify({ id: sessionId, thread_name: '测试会话', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-05-28T02:00:00Z', type: 'session_meta', payload: { cwd: 'C:\\work', originator: 'Codex Desktop' } }),
    JSON.stringify({ timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '你好' } }),
    JSON.stringify({ timestamp: '2026-05-28T02:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好，我在。' }] } }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '测试会话');

  const detail = await store.getSession(sessionId);
  assert.equal(detail.id, sessionId);
  assert.equal(detail.entries.length, 2);
  assert.equal(detail.entries[0].role, 'user');
  assert.equal(detail.entries[1].text, '你好，我在。');
});

test('CodexSessionStore lists desktop sidebar sessions and filters internal workers', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-sidebar-'));
  const userSessionId = '019e-user-session';
  const workerSessionId = '019e-worker-session';
  const execSessionId = '019e-exec-session';
  const unsavedSmokeSessionId = '019e-unsaved-smoke-session';
  const unsavedUserSessionId = '019e-unsaved-user-session';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\ExampleProject';
  const unsavedProjectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-workspace-root-labels': {
      [projectRoot]: 'ExampleProject'
    },
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [userSessionId]: projectRoot
    },
    'pinned-thread-ids': [userSessionId]
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: userSessionId, thread_name: '短标题：对话开发负责人', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  const userSessionPath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${userSessionId}.jsonl`);
  await fs.writeFile(userSessionPath, [
    JSON.stringify({ timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '继续' } }),
    ''
  ].join('\n'), 'utf8');
  const smokeSessionPath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${unsavedSmokeSessionId}.jsonl`);
  await fs.writeFile(smokeSessionPath, [
    JSON.stringify({ timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'desktop live smoke ok' } }),
    ''
  ].join('\n'), 'utf8');
  const unsavedUserSessionPath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${unsavedUserSessionId}.jsonl`);
  await fs.writeFile(unsavedUserSessionPath, [
    JSON.stringify({ timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '请只回复：中文链路正常' } }),
    ''
  ].join('\n'), 'utf8');
  insert.run(userSessionId, `\\\\?\\${userSessionPath}`, '对话开发负责人', `\\\\?\\${projectRoot}`, 1779948000000, 1779948000, 'user', 'vscode', 0, '用户消息', '预览', 0);
  insert.run(workerSessionId, '', 'Run worker prompt', `\\\\?\\${projectRoot}`, 1779949000000, 1779949000, 'subagent', '{"subagent":true}', 0, 'worker', 'worker', 1);
  insert.run(execSessionId, '', '请检查当前项目', 'C:\\Users\\agent\\Desktop\\harmony-codex', 1779949500000, 1779949500, null, 'exec', 0, 'exec', 'exec', 1);
  insert.run(unsavedSmokeSessionId, `\\\\?\\${smokeSessionPath}`, '?????:desktop live smoke ok????????', `\\\\?\\${unsavedProjectRoot}`, 1779949600000, 1779949600, 'user', 'vscode', 0, 'desktop live smoke ok', 'desktop live smoke ok', 0);
  insert.run(unsavedUserSessionId, `\\\\?\\${unsavedUserSessionPath}`, '请只回复：中文链路正常', `\\\\?\\${unsavedProjectRoot}`, 1779949700000, 1779949700, 'user', 'vscode', 0, '请只回复：中文链路正常', '请只回复：中文链路正常', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, userSessionId);
  assert.equal(sessions[0].title, '短标题：对话开发负责人');
  assert.equal(sessions[0].projectLabel, 'ExampleProject');
  assert.equal(sessions[0].sidebarSection, 'project');
  assert.equal(sessions[0].source, 'desktop-sidebar');
  assert.equal(sessions[0].pinned, true);
  assert.equal(sessions.some((session) => session.id === workerSessionId), false);
  assert.equal(sessions.some((session) => session.id === execSessionId), false);
  assert.equal(sessions.some((session) => session.id === unsavedSmokeSessionId), false);
  assert.equal(sessions.some((session) => session.id === unsavedUserSessionId), false);
});

test('CodexSessionStore expands current local-project ids into visible workspace roots', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-local-projects-'));
  const bossSessionId = '019e-boss-session';
  const vibeSessionId = '019e-vibe-session';
  const bossRoot = 'C:\\Users\\agent\\Desktop\\BossAi-All';
  const vibeRoot = 'C:\\Users\\agent\\Desktop\\Vibelution';

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'project-order': ['boss-id', 'vibe-id'],
    'local-projects': {
      'vibe-id': { id: 'vibe-id', name: 'Vibelution', rootPaths: [vibeRoot] },
      'boss-id': { id: 'boss-id', name: 'BossAi-All', rootPaths: [bossRoot] }
    },
    'thread-workspace-root-hints': {
      [bossSessionId]: bossRoot,
      [vibeSessionId]: vibeRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), '', 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '27');
  await fs.mkdir(sessionDir, { recursive: true });
  const bossPath = path.join(sessionDir, `rollout-${bossSessionId}.jsonl`);
  const vibePath = path.join(sessionDir, `rollout-${vibeSessionId}.jsonl`);
  await fs.writeFile(bossPath, `${JSON.stringify({ timestamp: '2026-07-27T01:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Boss' } })}\n`, 'utf8');
  await fs.writeFile(vibePath, `${JSON.stringify({ timestamp: '2026-07-27T02:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Vibe' } })}\n`, 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT, rollout_path TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER,
      updated_at INTEGER, thread_source TEXT, source TEXT, archived INTEGER,
      first_user_message TEXT, preview TEXT, has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(bossSessionId, bossPath, 'Boss 会话', bossRoot, 1785114000000, 1785114000, 'user', 'vscode', 0, 'Boss', 'Boss', 1);
  insert.run(vibeSessionId, vibePath, 'Vibe 会话', vibeRoot, 1785117600000, 1785117600, 'user', 'vscode', 0, 'Vibe', 'Vibe', 1);
  db.close();

  const sessions = await new CodexSessionStore({ codexHome }).listSessions();
  assert.deepEqual(sessions.map((session) => session.projectLabel).sort(), ['BossAi-All', 'Vibelution']);
});

test('CodexSessionStore preserves Codex desktop project and recent sidebar sections', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-sidebar-sections-'));
  const projectSessionId = '019e-project-session';
  const recentSessionId = '019e-recent-session';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\BossAi-All';
  const recentRoot = 'C:\\Users\\agent\\Documents\\scratch';

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      boss: { id: 'boss', name: 'BossAi-All', rootPaths: [projectRoot] }
    },
    'thread-workspace-root-hints': {
      [projectSessionId]: projectRoot,
      [recentSessionId]: recentRoot
    },
    'projectless-thread-ids': [recentSessionId]
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), '', 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  const projectPath = path.join(sessionDir, `rollout-${projectSessionId}.jsonl`);
  const recentPath = path.join(sessionDir, `rollout-${recentSessionId}.jsonl`);
  await fs.writeFile(projectPath, `${JSON.stringify({ timestamp: '2026-07-28T01:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '项目消息' } })}\n`, 'utf8');
  await fs.writeFile(recentPath, `${JSON.stringify({ timestamp: '2026-07-28T02:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '最近消息' } })}\n`, 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT, rollout_path TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER,
      updated_at INTEGER, thread_source TEXT, source TEXT, archived INTEGER,
      first_user_message TEXT, preview TEXT, has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(projectSessionId, projectPath, '项目会话', projectRoot, 1785200400000, 1785200400, 'user', 'vscode', 0, '项目消息', '项目消息', 1);
  insert.run(recentSessionId, recentPath, '最近会话', recentRoot, 1785204000000, 1785204000, 'user', 'vscode', 0, '最近消息', '最近消息', 1);
  db.close();

  const sessions = await new CodexSessionStore({ codexHome }).listSessions();
  const project = sessions.find((session) => session.id === projectSessionId);
  const recent = sessions.find((session) => session.id === recentSessionId);

  assert.equal(project?.projectLabel, 'BossAi-All');
  assert.equal(project?.sidebarSection, 'project');
  assert.equal(recent?.sidebarSection, 'recent');
});

test('CodexSessionStore marks desktop commentary turns running until final completion', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-running-commentary-'));
  const runningSessionId = '019e-running-commentary';
  const completedSessionId = '019e-completed-commentary';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\ExampleProject';
  const progressAt = new Date(Date.now() - 30_000);
  const userAt = new Date(progressAt.getTime() - 120_000);
  const completedAt = new Date(progressAt.getTime() - 10_000);
  const completedFinalAt = new Date(completedAt.getTime() - 200);
  const completedProgressAt = new Date(completedAt.getTime() - 60_000);
  const completedUserAt = new Date(completedProgressAt.getTime() - 60_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [runningSessionId]: projectRoot,
      [completedSessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: runningSessionId, thread_name: '设置', updated_at: progressAt.toISOString() }),
    JSON.stringify({ id: completedSessionId, thread_name: '完成会话', updated_at: completedAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '30');
  await fs.mkdir(sessionDir, { recursive: true });
  const runningPath = path.join(sessionDir, `rollout-2026-05-30T08-18-00-${runningSessionId}.jsonl`);
  const completedPath = path.join(sessionDir, `rollout-2026-05-30T08-18-00-${completedSessionId}.jsonl`);
  await fs.writeFile(runningPath, [
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '好的开始实现' }] } }),
    JSON.stringify({ timestamp: progressAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '项目记忆的 lane 不是 markdown 文件格式，我先列一下真实结构。', phase: 'commentary' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(completedPath, [
    JSON.stringify({ timestamp: completedUserAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '好的开始实现' }] } }),
    JSON.stringify({ timestamp: completedProgressAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '正在收口。', phase: 'commentary' } }),
    JSON.stringify({ timestamp: completedFinalAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已完成。' }] } }),
    JSON.stringify({ timestamp: completedAt.toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(runningPath, progressAt, progressAt);
  await fs.utimes(completedPath, completedAt, completedAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(runningSessionId, `\\\\?\\${runningPath}`, '设置', `\\\\?\\${projectRoot}`, progressAt.getTime(), Math.floor(progressAt.getTime() / 1000), 'user', 'vscode', 0, '好的开始实现', '项目记忆', 1);
  insert.run(completedSessionId, `\\\\?\\${completedPath}`, '完成会话', `\\\\?\\${projectRoot}`, completedAt.getTime(), Math.floor(completedAt.getTime() / 1000), 'user', 'vscode', 0, '好的开始实现', '已完成', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const running = sessions.find((session) => session.id === runningSessionId);
  const completed = sessions.find((session) => session.id === completedSessionId);

  assert.equal(running?.activityStatus, 'running');
  assert.equal(running?.runtimeState, 'running');
  assert.equal(running?.canInterrupt, true);
  assert.equal(running?.activityUpdatedAt, progressAt.toISOString());
  assert.equal(completed?.activityStatus, 'completed');
  assert.equal(completed?.runtimeState, 'completed');
  assert.equal(completed?.canInterrupt, false);
  assert.equal(completed?.terminalReason, 'completed');
  assert.equal(completed?.activityUpdatedAt, completedAt.toISOString());
});

test('CodexSessionStore treats fresh assistant-only rollout tails as running', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-running-tail-'));
  const runningSessionId = '019e-running-tail-only';
  const staleSessionId = '019e-stale-tail-only';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';
  const freshAt = new Date(Date.now() - 30_000);
  const staleAt = new Date(Date.now() - 30 * 60_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [runningSessionId]: projectRoot,
      [staleSessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: runningSessionId, thread_name: '新鲜尾部', updated_at: freshAt.toISOString() }),
    JSON.stringify({ id: staleSessionId, thread_name: '陈旧尾部', updated_at: staleAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '30');
  await fs.mkdir(sessionDir, { recursive: true });
  const runningPath = path.join(sessionDir, `rollout-2026-05-30T08-30-00-${runningSessionId}.jsonl`);
  const stalePath = path.join(sessionDir, `rollout-2026-05-30T08-00-00-${staleSessionId}.jsonl`);
  await fs.writeFile(runningPath, [
    JSON.stringify({ timestamp: new Date(freshAt.getTime() - 60_000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '上一轮已结束。' }] } }),
    JSON.stringify({ timestamp: freshAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '我正在继续处理状态同步。', phase: 'commentary' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(stalePath, [
    JSON.stringify({ timestamp: staleAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '旧的中间进度。', phase: 'commentary' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(runningPath, freshAt, freshAt);
  await fs.utimes(stalePath, staleAt, staleAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(runningSessionId, `\\\\?\\${runningPath}`, '新鲜尾部', `\\\\?\\${projectRoot}`, freshAt.getTime(), Math.floor(freshAt.getTime() / 1000), 'user', 'vscode', 0, '继续', '处理中', 1);
  insert.run(staleSessionId, `\\\\?\\${stalePath}`, '陈旧尾部', `\\\\?\\${projectRoot}`, staleAt.getTime(), Math.floor(staleAt.getTime() / 1000), 'user', 'vscode', 0, '继续', '旧进度', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const running = sessions.find((session) => session.id === runningSessionId);
  const stale = sessions.find((session) => session.id === staleSessionId);

  assert.equal(running?.activityStatus, 'running');
  assert.equal(stale?.activityStatus, 'idle');
});

test('CodexSessionStore does not keep stale unfinished commentary running forever', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-stale-commentary-'));
  const sessionId = '019e-stale-user-commentary';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';
  const progressAt = new Date(Date.now() - 30 * 60_000);
  const userAt = new Date(progressAt.getTime() - 120_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [sessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '旧的未完成会话', updated_at: progressAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '30');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-30T08-30-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续检查链路' }] } }),
    JSON.stringify({ timestamp: progressAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '正在读取日志。', phase: 'commentary' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, progressAt, progressAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sessionId, `\\\\?\\${rolloutPath}`, '旧的未完成会话', `\\\\?\\${projectRoot}`, progressAt.getTime(), Math.floor(progressAt.getTime() / 1000), 'user', 'vscode', 0, '继续检查链路', '正在读取日志。', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);

  assert.equal(session?.activityStatus, 'idle');
  assert.equal(session?.activityUpdatedAt, progressAt.toISOString());
});

test('CodexSessionStore does not keep stale task_started records running forever', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-stale-task-started-'));
  const sessionId = '019e-stale-task-started';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';
  const taskStartedAt = new Date(Date.now() - 45 * 60_000);
  const userAt = new Date(taskStartedAt.getTime() + 1_000);
  const toolAt = new Date(taskStartedAt.getTime() + 60_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [sessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '旧的任务开始事件', updated_at: toolAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '08');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-08T08-00-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查旧任务' }] } }),
    JSON.stringify({ timestamp: toolAt.toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_old', output: '旧工具输出' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, toolAt, toolAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sessionId, `\\\\?\\${rolloutPath}`, '旧的任务开始事件', `\\\\?\\${projectRoot}`, toolAt.getTime(), Math.floor(toolAt.getTime() / 1000), 'user', 'vscode', 0, '检查旧任务', '旧工具输出', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);

  assert.equal(session?.activityStatus, 'idle');
  assert.equal(session?.activityUpdatedAt, toolAt.toISOString());
});

test('CodexSessionStore treats final answers without task_complete as completed', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-final-without-complete-'));
  const sessionId = '019e-final-without-complete';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';
  const taskStartedAt = new Date(Date.now() - 5 * 60_000);
  const userAt = new Date(taskStartedAt.getTime() + 1_000);
  const finalAt = new Date(taskStartedAt.getTime() + 60_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [sessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '只有最终回复', updated_at: finalAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '08');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-08T08-10-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请回复' }] } }),
    JSON.stringify({ timestamp: finalAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成。' }] } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, finalAt, finalAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sessionId, `\\\\?\\${rolloutPath}`, '只有最终回复', `\\\\?\\${projectRoot}`, finalAt.getTime(), Math.floor(finalAt.getTime() / 1000), 'user', 'vscode', 0, '请回复', '完成。', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);

  assert.equal(session?.activityStatus, 'completed');
  assert.equal(session?.activityUpdatedAt, finalAt.toISOString());
});

test('CodexSessionStore treats turn_aborted markers as terminal control records', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-turn-aborted-'));
  const sessionId = '019e-turn-aborted';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\ExampleProject';
  const taskStartedAt = new Date(Date.now() - 30 * 60_000);
  const assistantAt = new Date(taskStartedAt.getTime() + 60_000);
  const abortedAt = new Date(Date.now() - 5_000);

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [sessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '被中断的旧会话', updated_at: abortedAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '14');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-14T08-10-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: assistantAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '已经处理完主要内容。' } }),
    JSON.stringify({ timestamp: abortedAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }] } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, abortedAt, abortedAt);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sessionId, `\\\\?\\${rolloutPath}`, '被中断的旧会话', `\\\\?\\${projectRoot}`, abortedAt.getTime(), Math.floor(abortedAt.getTime() / 1000), 'user', 'vscode', 0, '继续', '用户已中断', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const detail = await store.getSession(sessionId);

  assert.equal(session?.activityStatus, 'interrupted');
  assert.equal(session?.runtimeState, 'interrupted');
  assert.equal(session?.canInterrupt, false);
  assert.equal(session?.terminalReason, 'interrupted');
  assert.equal(session?.activityUpdatedAt, abortedAt.toISOString());
  assert.equal(detail.entries.some((entry) => String(entry.text ?? '').includes('turn_aborted')), false);
});

test('CodexSessionStore verifies large rollout targets without reading the whole file', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-large-rollout-'));
  const sessionId = '019e-large-rollout-target';
  const abortedAt = '2026-06-15T11:46:46.341Z';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '超大会话', updated_at: abortedAt }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '15');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-15T19-40-00-${sessionId}.jsonl`);
  const hugePrefix = JSON.stringify({
    timestamp: '2026-06-15T11:40:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x'.repeat(12000) }]
    }
  });
  await fs.writeFile(rolloutPath, [
    hugePrefix,
    JSON.stringify({ timestamp: '2026-06-15T11:45:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-06-15T11:45:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: '尾部消息仍可读取' } }),
    JSON.stringify({ timestamp: abortedAt, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }] } }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({
    codexHome,
    sessionDetailFullReadLimitBytes: 256,
    sessionDetailTailBytes: 4096
  });
  const detail = await store.getSession(sessionId, { tail: 10 });
  const verified = await store.verifySessionTarget(sessionId, { filePath: rolloutPath });

  assert.equal(detail.activityStatus, 'interrupted');
  assert.equal(detail.runtimeState, 'interrupted');
  assert.equal(detail.terminalReason, 'interrupted');
  assert.equal(detail.activityUpdatedAt, abortedAt);
  assert.equal(detail.entries.some((entry) => String(entry.text ?? '').includes('turn_aborted')), false);
  assert.match(detail.entries.map((entry) => entry.text).join('\n'), /尾部消息仍可读取/);
  assert.equal(verified.filePath, rolloutPath);
});

test('CodexSessionStore sorts sidebar sessions by rollout file activity', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-file-activity-'));
  const freshSessionId = '019e-fresh-session';
  const staleSessionId = '019e-stale-session';
  const projectRoot = 'C:\\Users\\agent\\Documents\\Codex';

  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [freshSessionId]: projectRoot,
      [staleSessionId]: projectRoot
    }
  }), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: freshSessionId, thread_name: '真实最新会话', updated_at: '2026-05-29T07:00:00Z' }),
    JSON.stringify({ id: staleSessionId, thread_name: '被侧栏碰过的旧会话', updated_at: '2026-05-29T08:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '29');
  await fs.mkdir(sessionDir, { recursive: true });
  const freshPath = path.join(sessionDir, `rollout-2026-05-29T15-00-00-${freshSessionId}.jsonl`);
  const stalePath = path.join(sessionDir, `rollout-2026-05-29T14-00-00-${staleSessionId}.jsonl`);
  await fs.writeFile(freshPath, `${JSON.stringify({ timestamp: '2026-05-29T07:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '最新真实消息' } })}\n`, 'utf8');
  await fs.writeFile(stalePath, `${JSON.stringify({ timestamp: '2026-05-29T06:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '旧消息' } })}\n`, 'utf8');
  await fs.utimes(stalePath, new Date('2026-05-29T06:00:00Z'), new Date('2026-05-29T06:00:00Z'));
  await fs.utimes(freshPath, new Date('2026-05-29T07:30:00Z'), new Date('2026-05-29T07:30:00Z'));

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(staleSessionId, `\\\\?\\${stalePath}`, '旧会话', `\\\\?\\${projectRoot}`, 1780041600000, 1780041600, 'user', 'vscode', 0, '旧消息', '旧消息', 0);
  insert.run(freshSessionId, `\\\\?\\${freshPath}`, '最新会话', `\\\\?\\${projectRoot}`, 1780038000000, 1780038000, 'user', 'vscode', 0, '最新真实消息', '最新真实消息', 0);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();

  assert.equal(sessions[0].id, freshSessionId);
  assert.equal(sessions[0].activitySource, 'session-file');
  assert.equal(sessions[1].id, staleSessionId);
});

test('CodexSessionStore tails visible conversation entries with compact tool status rows', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-visible-tail-'));
  const sessionId = '019e-visible-tail';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '真实会话', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  const records = [
    { timestamp: '2026-05-28T02:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '第一条用户消息' } },
    { timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: '第一条 Codex 回复' } },
    { timestamp: '2026-05-28T02:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '第一条 Codex 回复' }] } }
  ];
  for (let index = 0; index < 30; index += 1) {
    records.push({
      timestamp: `2026-05-28T02:01:${String(index).padStart(2, '0')}Z`,
      type: 'response_item',
      payload: {
        type: index % 2 === 0 ? 'function_call' : 'function_call_output',
        name: 'shell_command',
        arguments: '{"command":"npm test"}',
        output: 'Exit code: 0\nWall time: 1.2 seconds'
      }
    });
  }
  records.push({ timestamp: '2026-05-28T02:02:00Z', type: 'event_msg', payload: { type: 'user_message', message: '第二条用户消息' } });

  await fs.writeFile(
    path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId, { tail: 5 });

  assert.deepEqual(detail.entries.map((entry) => entry.text.split('\n')[0]), [
    '第一条用户消息',
    '第一条 Codex 回复',
    '已运行 15 条命令',
    '第二条用户消息'
  ]);
  assert.equal(detail.entries.filter((entry) => entry.role === 'tool').length, 1);
  const toolEntry = detail.entries.find((entry) => entry.role === 'tool');
  assert.match(toolEntry?.text ?? '', /1\. npm test/);
  assert.match(toolEntry?.text ?? '', /输出：Exit code: 0/);
  assert.match(toolEntry?.text ?? '', /Wall time: 1\.2 seconds/);
  assert.equal(toolEntry?.toolItems?.length, 15);
  assert.deepEqual(toolEntry?.toolItems?.[0], {
    id: 'shell_command-2026-05-28T02:01:00Z',
    name: 'shell_command',
    verb: 'Ran',
    target: 'npm test',
    detail: 'Exit code: 0；Wall time: 1.2 seconds',
    status: 'completed'
  });
});

test('CodexSessionStore preserves concrete tool identity and pairs reversed outputs by call id', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-tool-identity-'));
  const sessionId = '019e-tool-identity';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '工具实名会话', updated_at: '2026-05-28T03:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T11-00-00-${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-05-28T03:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '检查展示' } }),
    JSON.stringify({
      timestamp: '2026-05-28T03:00:01Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'tool_search_tool',
        call_id: 'call_search',
        arguments: JSON.stringify({ query: 'sessionEntryDisplayText' })
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T03:00:02Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'apply_patch',
        call_id: 'call_patch',
        arguments: JSON.stringify({
          patch: '*** Begin Patch\n*** Update File: HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets\n*** End Patch'
        })
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T03:00:03Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_patch', output: 'Done!' }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T03:00:04Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_search', output: '4 matches' }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);
  const toolEntry = detail.entries.find((entry) => entry.role === 'tool');

  assert.equal(toolEntry?.toolItems?.length, 2);
  assert.deepEqual(toolEntry?.toolItems?.map((item) => ({
    id: item.id,
    name: item.name,
    verb: item.verb,
    target: item.target,
    detail: item.detail,
    status: item.status
  })), [
    {
      id: 'call_search',
      name: 'tool_search_tool',
      verb: 'Searched',
      target: 'sessionEntryDisplayText',
      detail: '4 matches',
      status: 'completed'
    },
    {
      id: 'call_patch',
      name: 'apply_patch',
      verb: 'Edited',
      target: 'HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets',
      detail: 'Done!',
      status: 'completed'
    }
  ]);
});

test('CodexSessionStore appends one live activity for running rollout detail and clears it after completion', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-live-activity-'));
  const runningSessionId = '019e-running-live-activity';
  const completedSessionId = '019e-completed-live-activity';
  const now = Date.now();
  const runningAt = new Date(now - 30_000);
  const commandAt = new Date(now - 20_000);
  const completedAt = new Date(now - 10_000);

  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: runningSessionId, thread_name: '运行中活动', updated_at: commandAt.toISOString() }),
    JSON.stringify({ id: completedSessionId, thread_name: '已完成活动', updated_at: completedAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '12');
  await fs.mkdir(sessionDir, { recursive: true });
  const runningPath = path.join(sessionDir, `rollout-2026-06-12T20-00-00-${runningSessionId}.jsonl`);
  const completedPath = path.join(sessionDir, `rollout-2026-06-12T20-00-00-${completedSessionId}.jsonl`);

  const runningRecords = [
    { timestamp: runningAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: new Date(runningAt.getTime() + 1000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续修复状态' }] } },
    { timestamp: new Date(runningAt.getTime() + 2000).toISOString(), type: 'response_item', payload: { type: 'reasoning', summary: '定位实时状态来源' } },
    { timestamp: commandAt.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"npm test -- test/codexSessions.test.js"}' } }
  ];
  await fs.writeFile(runningPath, `${runningRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  const completedRecords = [
    ...runningRecords.map((record) => ({ ...record, timestamp: new Date(Date.parse(record.timestamp) + 1000).toISOString() })),
    { timestamp: completedAt.toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }
  ];
  await fs.writeFile(completedPath, `${completedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  await fs.utimes(runningPath, commandAt, commandAt);
  await fs.utimes(completedPath, completedAt, completedAt);

  const store = new CodexSessionStore({ codexHome });
  const running = await store.getSession(runningSessionId, { tail: 20 });
  const completed = await store.getSession(completedSessionId, { tail: 20 });

  const runningLiveEntries = running.entries.filter((entry) => entry.type === 'live_activity');
  assert.equal(runningLiveEntries.length, 1);
  assert.equal(running.entries.at(-1), runningLiveEntries[0]);
  assert.equal(runningLiveEntries[0].liveKind, 'command');
  assert.equal(runningLiveEntries[0].text, '正在执行命令');
  assert.equal(completed.entries.some((entry) => entry.type === 'live_activity'), false);
});

test('CodexSessionStore downgrades stale pending tool calls when the session is not running', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-stale-tool-call-'));
  const sessionId = '019e-stale-pending-tool-call';
  const now = Date.now();
  const taskStartedAt = new Date(now - 30 * 60_000);
  const userAt = new Date(now - 29 * 60_000);
  const assistantAt = new Date(now - 28 * 60_000);
  const toolCallAt = new Date(now - 27 * 60_000);

  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '旧悬空命令', updated_at: toolCallAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '18');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-18T13-00-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] } }),
    JSON.stringify({ timestamp: assistantAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '开始跑测试。', phase: 'commentary' } }),
    JSON.stringify({ timestamp: toolCallAt.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'call_hung', arguments: '{"command":"python -m pytest tests/test_team_workflow_orchestration_service.py"}' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, toolCallAt, toolCallAt);

  const store = new CodexSessionStore({ codexHome });
  const session = await store.getSession(sessionId, { tail: 20 });

  assert.equal(session.activityStatus, 'idle');
  assert.equal(session.runtimeState, 'idle');
  assert.equal(session.canInterrupt, false);
  assert.equal(session.entries.some((entry) => entry.type === 'live_activity'), false);
  assert.equal(session.entries.some((entry) => entry.type === 'tool_call'), false);
  const staleTool = session.entries.find((entry) => entry.type === 'tool_result' && /命令未返回/.test(entry.text));
  assert.ok(staleTool);
  assert.match(staleTool.text, /python -m pytest/);
});

test('CodexSessionStore does not reuse an older pending command for a newer running turn', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-new-turn-old-tool-'));
  const sessionId = '019e-new-turn-old-tool';
  const now = Date.now();
  const oldTaskStartedAt = new Date(now - 30 * 60_000);
  const oldAssistantAt = new Date(now - 28 * 60_000);
  const oldToolCallAt = new Date(now - 27 * 60_000);
  const newUserAt = new Date(now - 60_000);
  const newTaskStartedAt = new Date(now - 58_000);

  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '新轮旧命令', updated_at: newUserAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '18');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-18T13-10-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: oldTaskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: oldAssistantAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '开始跑旧测试。', phase: 'commentary' } }),
    JSON.stringify({ timestamp: oldToolCallAt.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'call_old', arguments: '{"command":"python -m pytest old_tests.py"}' } }),
    JSON.stringify({ timestamp: newUserAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '现在同步了吗' }] } }),
    JSON.stringify({ timestamp: newTaskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, newTaskStartedAt, newTaskStartedAt);

  const store = new CodexSessionStore({ codexHome });
  const session = await store.getSession(sessionId, { tail: 20 });

  assert.equal(session.activityStatus, 'running');
  assert.equal(session.runtimeState, 'running');
  assert.equal(session.canInterrupt, true);
  assert.equal(session.entries.some((entry) => entry.type === 'tool_call'), false);
  const liveActivity = session.entries.find((entry) => entry.type === 'live_activity');
  assert.equal(liveActivity?.text, 'Codex 正在处理当前消息');
  assert.doesNotMatch(liveActivity?.text ?? '', /old_tests/);
  const staleTool = session.entries.find((entry) => entry.type === 'tool_result' && /命令未返回/.test(entry.text));
  assert.ok(staleTool);
  assert.match(staleTool.text, /old_tests/);
});

test('CodexSessionStore treats fresh work after an interrupted marker as a new running turn', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-post-interrupt-running-'));
  const sessionId = '019e-post-interrupt-running';
  const now = Date.now();
  const userAt = new Date(now - 120_000);
  const abortedAt = new Date(now - 90_000);
  const reasoningAt = new Date(now - 30_000);
  const toolCallAt = new Date(now - 20_000);

  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '中断后继续运行', updated_at: toolCallAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '19');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-19T16-00-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先中断' }] } }),
    JSON.stringify({ timestamp: abortedAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }] } }),
    JSON.stringify({ timestamp: reasoningAt.toISOString(), type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '重新分析链路状态' }] } }),
    JSON.stringify({ timestamp: toolCallAt.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'call_after_interrupt', arguments: '{"command":"npm test"}' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, toolCallAt, toolCallAt);

  const store = new CodexSessionStore({ codexHome });
  const session = await store.getSession(sessionId, { tail: 20 });

  assert.equal(session.activityStatus, 'running');
  assert.equal(session.runtimeState, 'running');
  assert.equal(session.canInterrupt, true);
  assert.equal(session.terminalReason, '');
  assert.equal(session.activityUpdatedAt, toolCallAt.toISOString());
  assert.equal(session.entries.some((entry) => entry.type === 'live_activity'), true);
});

test('CodexSessionStore exposes Codex client errors and compaction as dedicated notice entries', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-client-notices-'));
  const sessionId = '019e-client-notices';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '客户端通知', updated_at: '2026-06-16T08:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '16');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-16T16-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-16T08:00:01Z',
      type: 'event_msg',
      payload: {
        type: 'client_error',
        statusCode: 401,
        error: { code: 'unauthorized', message: 'Unauthorized' }
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-16T08:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'client_status',
        message: 'Codex 正在压缩上下文，等待 compaction 完成。'
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);
  const notices = detail.entries.filter((entry) => entry.type === 'codex_client_notice');

  assert.equal(notices.length, 2);
  assert.equal(notices[0].liveKind, 'auth');
  assert.match(notices[0].text, /Codex 鉴权失败/);
  assert.equal(notices[1].liveKind, 'context');
  assert.match(notices[1].text, /正在压缩上下文/);
});

test('CodexSessionStore keeps open turns running after a settled tool output tail', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-settled-tool-output-'));
  const sessionId = '019e-settled-tool-output';
  const now = Date.now();
  const taskStartedAt = new Date(now - 70_000);
  const userAt = new Date(now - 69_000);
  const assistantAt = new Date(now - 45_000);
  const toolCallAt = new Date(now - 35_000);
  const toolOutputAt = new Date(now - 25_000);

  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '命令输出已稳定', updated_at: toolOutputAt.toISOString() }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '14');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-14T12-00-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt.toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: userAt.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] } }),
    JSON.stringify({ timestamp: assistantAt.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: '现在做最后检查。', phase: 'commentary' } }),
    JSON.stringify({ timestamp: toolCallAt.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'call_done', arguments: '{"command":"npm test"}' } }),
    JSON.stringify({ timestamp: toolOutputAt.toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_done', output: 'Exit code: 0\\nWall time: 0.2 seconds' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(rolloutPath, toolOutputAt, toolOutputAt);

  const store = new CodexSessionStore({ codexHome });
  const session = await store.getSession(sessionId, { tail: 20 });

  assert.equal(session.activityStatus, 'running');
  assert.equal(session.runtimeState, 'running');
  assert.equal(session.canInterrupt, true);
  assert.equal(session.terminalReason, '');
  assert.equal(session.activityUpdatedAt, toolOutputAt.toISOString());
  assert.equal(session.entries.some((entry) => entry.type === 'live_activity'), true);
});

test('CodexSessionStore merges duplicate user records from rollout event and response sources', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-duplicate-user-'));
  const mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-images-'));
  const sessionId = '019e-duplicate-user';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '截图问题', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  const timestamp = '2026-05-28T02:00:01Z';
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { text: '# Files mentioned by the user:\n\n## phone.jpg\n\n手机端的会话内容和桌面端的没有对齐\n\n<image name=[Image #1]>\n</image>' },
          { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('desktop-image').toString('base64')}` }
        ]
      }
    }),
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '# Files mentioned by the user:\n\n## phone.jpg\n\n手机端的会话内容和桌面端的没有对齐\n'
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome, mobileImagesDir });
  const detail = await store.getSession(sessionId);

  assert.equal(detail.entries.length, 1);
  assert.equal(detail.entries[0].role, 'user');
  assert.doesNotMatch(detail.entries[0].text, /<image/);
  assert.match(detail.entries[0].text, /!\[桌面端图片\]\(.+desktop-.+\.png\)/);
  const imagePath = detail.entries[0].text.match(/\((.+desktop-.+\.png)\)/)?.[1];
  assert.ok(imagePath);
  await fs.access(imagePath);
});

test('CodexSessionStore merges duplicate assistant records from rollout event and response sources', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-duplicate-assistant-'));
  const sessionId = '019e-duplicate-assistant';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '重复回复', updated_at: '2026-06-16T18:20:57.600Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '16');
  await fs.mkdir(sessionDir, { recursive: true });
  const assistantText = '审查结果：你这个判断是对的。重复显示来自两个日志来源。';
  const assistantTextWithCitation = `${assistantText}\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[test]\n</citation_entries>\n<rollout_ids>\n019e-test\n</rollout_ids>\n</oai-mem-citation>`;
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-16T18-20-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-16T18:20:57.580Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: assistantText
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-16T18:20:57.587Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: assistantTextWithCitation }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);
  const assistantEntries = detail.entries.filter((entry) => entry.role === 'assistant');

  assert.equal(assistantEntries.length, 1);
  assert.equal(assistantEntries[0].type, 'response_item');
  assert.match(assistantEntries[0].text, /<oai-mem-citation>/);
});

test('CodexSessionStore materializes desktop tool output images for mobile display', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-tool-image-'));
  const mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-tool-images-'));
  const sessionId = '019e-tool-image';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '桌面图片', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-05-28T02:00:01Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'view_image',
        call_id: 'call_image',
        arguments: JSON.stringify({ path: 'C:\\tmp\\generated.png' })
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-28T02:00:02Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [
          { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('desktop-tool-image').toString('base64')}` }
        ]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome, mobileImagesDir });
  const detail = await store.getSession(sessionId);
  const imageEntry = detail.entries.find((entry) => entry.type === 'tool_result');

  assert.ok(imageEntry);
  assert.match(imageEntry.text, /^已查看图片\n!\[桌面端图片\]\(.+desktop-.+\.png\)$/);
  const imagePath = imageEntry.text.match(/\((.+desktop-.+\.png)\)/)?.[1];
  assert.ok(imagePath);
  await fs.access(imagePath);
});

test('CodexSessionStore rewrites assistant local markdown images into mobile image storage', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-local-markdown-image-'));
  const mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-local-images-'));
  const sessionId = '019e-local-markdown-image';
  const sourceImage = path.join(codexHome, 'generated-output.png');
  await fs.writeFile(sourceImage, Buffer.from('assistant-local-image'));
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '生成图片', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-05-28T02:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: `生成结果\n![结果](${sourceImage.replace(/\\/g, '/')})` }
        ]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome, mobileImagesDir });
  const detail = await store.getSession(sessionId);

  assert.equal(detail.entries.length, 1);
  assert.match(detail.entries[0].text, /生成结果\n!\[结果\]\(.+desktop-.+\.png\)/);
  assert.doesNotMatch(detail.entries[0].text, new RegExp(sourceImage.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  const imagePath = detail.entries[0].text.match(/\((.+desktop-.+\.png)\)/)?.[1];
  assert.ok(imagePath);
  await fs.access(imagePath);
});

test('CodexSessionStore materializes Codex generated images for mobile display', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-generated-image-'));
  const mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-generated-images-'));
  const sessionId = '019e-generated-image';
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '生成图', updated_at: '2026-06-18T10:55:45.587Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '18');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-18T10-55-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-18T10:55:45.568Z',
      type: 'event_msg',
      payload: {
        type: 'image_generation_end',
        call_id: 'ig_1',
        status: 'completed',
        result: imageBytes.toString('base64')
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-18T10:55:45.582Z',
      type: 'response_item',
      payload: {
        type: 'image_generation_call',
        id: 'ig_1',
        status: 'completed',
        result: imageBytes.toString('base64')
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-18T10:55:45.587Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '图片已生成。' }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome, mobileImagesDir });
  const detail = await store.getSession(sessionId);
  const imageEntries = detail.entries.filter((entry) => /!\[桌面端图片\]\(.+desktop-.+\.png\)/.test(entry.text));

  assert.equal(imageEntries.length, 1);
  assert.equal(imageEntries[0].role, 'assistant');
  assert.equal(imageEntries[0].type, 'response_item');
  assert.match(imageEntries[0].syncId, /^generated-image:ig_1:/);
  assert.match(imageEntries[0].text, /^已生成图片\n!\[桌面端图片\]\(.+desktop-.+\.png\)$/);
  const imagePath = imageEntries[0].text.match(/\((.+desktop-.+\.png)\)/)?.[1];
  assert.ok(imagePath);
  assert.deepEqual(await fs.readFile(imagePath), imageBytes);
});

test('CodexSessionStore gives split generated-image records the same stable sync id', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-generated-image-sync-'));
  const mobileImagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-generated-image-sync-'));
  const sessionId = '019e-generated-image-sync';
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const imageBase64 = imageBytes.toString('base64');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '生成图分页', updated_at: '2026-06-18T10:56:45.587Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '18');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-18T10-56-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-18T10:56:45.568Z',
      type: 'event_msg',
      payload: {
        type: 'image_generation_end',
        call_id: 'ig_split',
        status: 'completed',
        result: imageBase64
      }
    }),
    JSON.stringify({ timestamp: '2026-06-18T10:56:45.570Z', type: 'event_msg', payload: { type: 'agent_message', message: '中间消息一' } }),
    JSON.stringify({ timestamp: '2026-06-18T10:56:45.571Z', type: 'event_msg', payload: { type: 'agent_message', message: '中间消息二' } }),
    JSON.stringify({
      timestamp: '2026-06-18T10:56:45.582Z',
      type: 'response_item',
      payload: {
        type: 'image_generation_call',
        id: 'ig_split',
        status: 'completed',
        result: imageBase64
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-18T10:56:45.587Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '图片已生成。' }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome, mobileImagesDir });
  const detail = await store.getSession(sessionId);
  const imageEntries = detail.entries.filter((entry) => /!\[桌面端图片\]\(.+desktop-.+\.png\)/.test(entry.text));
  assert.equal(imageEntries.length, 1);
  assert.equal(imageEntries[0].type, 'response_item');

  const recent = await store.getSessionSync(sessionId, { limit: 2 });
  const recentImage = recent.entries.find((entry) => /!\[桌面端图片\]\(.+desktop-.+\.png\)/.test(entry.text));
  assert.ok(recentImage);
  assert.equal(recentImage.type, 'response_item');

  const older = await store.getSessionSync(sessionId, { limit: 10, before: recent.sync.cursorStart });
  const olderImage = older.entries.find((entry) => /!\[桌面端图片\]\(.+desktop-.+\.png\)/.test(entry.text));
  assert.ok(olderImage);
  assert.equal(olderImage.type, 'event_msg');
  assert.equal(olderImage.syncId, recentImage.syncId);
});

test('CodexSessionStore hides skill triggers and internal skill instruction blocks from visible chat', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-skill-visible-'));
  const sessionId = '019e-skill-visible';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '技能展示', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-05-28T02:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ text: '$ccdawn-brt 请修复布局\n\n<skills_instructions>\n# SKILL.md\n很长的技能内容\n</skills_instructions>' }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);

  assert.equal(detail.entries.length, 1);
  assert.equal(detail.entries[0].text, '请修复布局');
});

test('CodexSessionStore strips personality spec blocks from visible chat', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-personality-visible-'));
  const sessionId = '019e-personality-visible';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '人格泄露', updated_at: '2026-06-02T01:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '02');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-02T01-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-02T01:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '<personality_spec>\n不要展示内部设定\n</personality_spec>\n\n正常回复' }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);

  assert.equal(detail.entries.length, 1);
  assert.equal(detail.entries[0].text, '正常回复');
});

test('CodexSessionStore strips Codex review directives from visible chat', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-directives-'));
  const sessionId = '019e-directives-visible';
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '审查结果', updated_at: '2026-06-02T01:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '02');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `rollout-2026-06-02T01-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-02T01:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: 'Findings:\n\n::code-comment{title="Block unsafe markdown links", body="internal review directive", file="C:\\\\work\\\\a.ts", start=12, priority="P1"}\n\nI did not run tests.' }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-06-02T01:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ text: '::code-comment{title="Only directive",\nbody="multi-line directive",\nfile="C:\\\\work\\\\b.ts", start=20, priority="P2"}' }]
      }
    }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const detail = await store.getSession(sessionId);

  assert.equal(detail.entries.length, 1);
  assert.equal(detail.entries[0].text, 'Findings:\n\nI did not run tests.');
  assert.doesNotMatch(detail.entries[0].text, /::code-comment/);
});

test('CodexSessionStore reads SQLite rollout_path and hides missing archived files from lists', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-rollout-path-'));
  const readableSessionId = '019e-readable-rollout';
  const missingSessionId = '019e-missing-rollout';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: readableSessionId, thread_name: '可读会话', updated_at: '2026-05-28T02:00:00Z' }),
    JSON.stringify({ id: missingSessionId, thread_name: '缺失会话', updated_at: '2026-05-28T02:00:00Z' }),
    ''
  ].join('\n'), 'utf8');

  const readablePath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${readableSessionId}.jsonl`);
  const missingPath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${missingSessionId}.jsonl`);
  await fs.writeFile(readablePath, [
    JSON.stringify({ timestamp: '2026-05-28T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '读取 rollout path' } }),
    ''
  ].join('\n'), 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(readableSessionId, `\\\\?\\${readablePath}`, '可读会话', 'C:\\work', 1779948000000, 1779948000, 'user', 'vscode', 0, '用户消息', '预览', 1);
  insert.run(missingSessionId, `\\\\?\\${missingPath}`, '缺失会话', 'C:\\work', 1779947000000, 1779947000, 'user', 'vscode', 0, '用户消息', '预览', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const sessions = await store.listSessions();
  assert.equal(sessions.find((session) => session.id === readableSessionId)?.detailAvailable, true);
  assert.equal(sessions.some((session) => session.id === missingSessionId), false);

  const readable = await store.getSession(readableSessionId);
  assert.equal(readable.detailAvailable, true);
  assert.equal(readable.entries[0].text, '读取 rollout path');

  const missing = await store.getSession(missingSessionId);
  assert.equal(missing.detailAvailable, false);
  assert.equal(missing.entries[0].type, 'missing_session_file');
});

test('CodexSessionStore reads visible entries appended after a rollout cursor', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-cursor-'));
  const sessionId = '019e-cursor-session';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '29');
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-2026-05-29T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(filePath, [
    JSON.stringify({ timestamp: '2026-05-29T02:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '旧消息' } }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const cursor = await store.getSessionFileCursor(sessionId, filePath);
  await fs.appendFile(filePath, [
    JSON.stringify({ timestamp: '2026-05-29T02:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: '新消息' } }),
    JSON.stringify({ timestamp: '2026-05-29T02:01:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '新回复' }] } }),
    ''
  ].join('\n'), 'utf8');

  const entries = await store.readSessionEntriesAfterCursor(cursor);

  assert.deepEqual(entries.map((entry) => entry.text), ['新消息', '新回复']);
});

test('CodexSessionStore syncs recent, older, and appended session pages by file offset', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-sync-page-'));
  const sessionId = '019e-sync-page-session';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '16');
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-2026-06-16T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(filePath, [
    JSON.stringify({ timestamp: '2026-06-16T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '消息一' } }),
    JSON.stringify({ timestamp: '2026-06-16T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '回复二' } }),
    JSON.stringify({ timestamp: '2026-06-16T00:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: '消息三' } }),
    JSON.stringify({ timestamp: '2026-06-16T00:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '回复四' }] } }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({ codexHome });
  const recent = await store.getSessionSync(sessionId, { limit: 2 });

  assert.equal(recent.sync.mode, 'recent');
  assert.equal(recent.sync.hasMoreBefore, true);
  assert.deepEqual(recent.entries.map((entry) => entry.text), ['消息三', '回复四']);
  assert.ok(Number(recent.sync.cursorStart) > 0);
  assert.ok(Number(recent.sync.cursorEnd) > Number(recent.sync.cursorStart));

  const older = await store.getSessionSync(sessionId, { limit: 2, before: recent.sync.cursorStart });
  assert.equal(older.sync.mode, 'before');
  assert.deepEqual(older.entries.map((entry) => entry.text), ['消息一', '回复二']);

  await fs.appendFile(filePath, [
    JSON.stringify({ timestamp: '2026-06-16T00:00:05Z', type: 'event_msg', payload: { type: 'user_message', message: '消息五' } }),
    ''
  ].join('\n'), 'utf8');
  const appended = await store.getSessionSync(sessionId, { limit: 2, after: recent.sync.cursorEnd });

  assert.equal(appended.sync.mode, 'after');
  assert.deepEqual(appended.entries.map((entry) => entry.text), ['消息五']);
  assert.ok(Number(appended.sync.cursorEnd) > Number(recent.sync.cursorEnd));

  const unchanged = await store.getSessionSync(sessionId, { limit: 2, after: appended.sync.cursorEnd });
  assert.equal(unchanged.sync.mode, 'after');
  assert.equal(unchanged.sync.pageDirection, 'after');
  assert.equal(unchanged.sync.snapshotFileSize, unchanged.sync.fileSize);
  assert.deepEqual(unchanged.entries.map((entry) => entry.text), []);
  assert.ok(Number(unchanged.sync.cursorEnd) >= Number(appended.sync.cursorEnd));

  const beyondCurrentFile = await store.getSessionSync(sessionId, { limit: 2, after: String(Number(appended.sync.cursorEnd) + 5000) });
  assert.equal(beyondCurrentFile.sync.mode, 'after');
  assert.deepEqual(beyondCurrentFile.entries.map((entry) => entry.text), []);
  assert.ok(Number(beyondCurrentFile.sync.cursorEnd) >= Number(appended.sync.cursorEnd) + 5000);
});

test('CodexSessionStore recent sync expands backward to include the latest user turn anchor', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-sync-anchor-'));
  const sessionId = '019e-sync-anchor-session';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '19');
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-2026-06-19T17-00-00-${sessionId}.jsonl`);
  await fs.writeFile(filePath, [
    JSON.stringify({ timestamp: '2026-06-19T09:06:59.000Z', type: 'event_msg', payload: { type: 'user_message', message: '请分析这个显示问题' } }),
    JSON.stringify({ timestamp: '2026-06-19T09:07:00.000Z', type: 'session_meta', payload: { cwd: 'C:\\work', notes: 'x'.repeat(1600) } }),
    JSON.stringify({ timestamp: '2026-06-19T09:07:08.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '正在核对日志' }] } }),
    JSON.stringify({ timestamp: '2026-06-19T09:07:10.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我先核对刚才补丁有没有落在正确位置。' }] } }),
    JSON.stringify({ timestamp: '2026-06-19T09:07:11.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } }),
    ''
  ].join('\n'), 'utf8');

  const store = new CodexSessionStore({
    codexHome,
    sessionDetailFullReadLimitBytes: 128,
    sessionDetailTailBytes: 256
  });
  const recent = await store.getSessionSync(sessionId, { limit: 3 });

  assert.equal(recent.sync.mode, 'recent');
  assert.equal(recent.entries[0].role, 'user');
  assert.equal(recent.entries[0].text, '请分析这个显示问题');
  assert.ok(recent.entries.some((entry) => entry.text.includes('我先核对刚才补丁')));
  assert.ok(Number(recent.sync.cursorStart) < Number(recent.sync.cursorEnd));
});

test('CodexSessionStore archives the thread from desktop lists while preserving its rollout file', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-delete-'));
  const sessionId = '019e-delete-session';
  const projectRoot = 'C:\\Users\\agent\\Desktop\\harmony-codex';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '08');
  await fs.mkdir(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-06-08T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ timestamp: '2026-06-08T02:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '删除我' } }),
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '待删除会话', updated_at: '2026-06-08T02:00:00Z' }),
    JSON.stringify({ id: '019e-keep-session', thread_name: '保留会话', updated_at: '2026-06-08T01:00:00Z' }),
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'electron-saved-workspace-roots': [projectRoot],
    'thread-workspace-root-hints': {
      [sessionId]: projectRoot
    },
    'pinned-thread-ids': [sessionId],
    'projectless-thread-ids': [sessionId]
  }), 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT,
      rollout_path TEXT,
      title TEXT,
      cwd TEXT,
      updated_at_ms INTEGER,
      updated_at INTEGER,
      thread_source TEXT,
      source TEXT,
      archived INTEGER,
      first_user_message TEXT,
      preview TEXT,
      has_user_event INTEGER
    )
  `);
  db.prepare(`
    INSERT INTO threads
      (id, rollout_path, title, cwd, updated_at_ms, updated_at, thread_source, source, archived, first_user_message, preview, has_user_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, `\\\\?\\${rolloutPath}`, '待删除会话', `\\\\?\\${projectRoot}`, 1780874400000, 1780874400, 'user', 'vscode', 0, '删除我', '删除我', 1);
  db.close();

  const store = new CodexSessionStore({ codexHome });
  const deleted = await store.deleteSession(sessionId);

  assert.equal(deleted.deletedFiles.length, 0);
  assert.deepEqual(deleted.preservedFiles, [rolloutPath]);
  assert.equal(deleted.archivedThreadCount, 1);
  assert.equal(deleted.removedIndexRecords, 1);
  assert.equal(await exists(rolloutPath), true);
  assert.equal((await store.listSessions({ limit: 10 })).some((session) => session.id === sessionId), false);
  assert.doesNotMatch(await fs.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8'), new RegExp(sessionId));

  const reopened = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), { readOnly: true });
  const row = reopened.prepare('SELECT archived FROM threads WHERE id = ?').get(sessionId);
  reopened.close();
  assert.equal(row.archived, 1);
});

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}


