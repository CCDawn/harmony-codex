import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ManagedCodexAppServerClient } from './managedCodexAppServerClient.js';
import { buildSessionSnapshot, sanitize, summarizeThreadForEvent } from './codexProtocolUtils.js';
import { CodexAppServerEventConverter } from './codexAppServerEvents.js';
import { CodexAppServerApprovalBroker } from './codexAppServerApprovalBroker.js';
import { CodexAppServerUserInputBroker } from './codexAppServerUserInputBroker.js';
import { CodexAppServerRunJournal, isRecoverableRunIdentifier } from './codexAppServerRunJournal.js';
import { isLiveActivityEntry } from './codexLiveActivity.js';
import { classifyCodexClientNotice, createCodexClientNoticeEntry } from './codexClientNotices.js';
import { CodexProjectCatalog } from './codexProjectCatalog.js';
import { extractLocalImageInputs } from './codexTurnInput.js';
import { normalizeModelId } from './sessionSettingsStore.js';
import { SessionRuntimeSnapshotTracker } from './sessionRuntimeSnapshot.js';
import { isSameOrChildPath, resolveSafeProjectRoot } from './workspaceGuard.js';

const VALID_THREAD_ID = /^[A-Za-z0-9_-]+$/;
export class CodexThreadService {
  constructor(options = {}) {
    this.client = options.client ?? new ManagedCodexAppServerClient(options);
    this.allowIndependentAppServer = options.allowIndependentAppServer !== false;
    this.sessions = options.sessions ?? null;
    this.projects = Array.isArray(options.projects) ? options.projects : [];
    this.projectCatalog = options.projectCatalog ?? new CodexProjectCatalog({
      projects: this.projects,
      historyPath: options.projectHistoryPath
    });
    this.eventBus = options.eventBus ?? null;
    this.logger = options.logger ?? null;
    this.desktopOpener = options.desktopOpener ?? null;
    this.runtimeStateProvider = options.runtimeStateProvider ?? null;
    this.desktopThreadListProvider = options.desktopThreadListProvider ?? null;
    this.archiveThreadProvider = options.archiveThreadProvider ?? null;
    this.autoOpenDesktop = options.autoOpenDesktop ?? process.env.CODEX_BRIDGE_AUTO_OPEN_DESKTOP === '1';
    this.model = options.model ?? process.env.CODEX_BRIDGE_MODEL ?? '';
    this.sandbox = options.sandbox
      ?? process.env.CODEX_BRIDGE_APP_SERVER_SANDBOX
      ?? process.env.CODEX_BRIDGE_SANDBOX
      ?? 'danger-full-access';
    this.approvalPolicy = options.approvalPolicy
      ?? process.env.CODEX_BRIDGE_APP_SERVER_APPROVAL_POLICY
      ?? process.env.CODEX_BRIDGE_APPROVAL_POLICY
      ?? 'never';
    this.runs = new Map();
    this.runsBySubmissionId = new Map();
    this.newThreadRunsBySubmissionId = new Map();
    this.newThreadSubmissionPromises = new Map();
    this.liveSessions = new Map();
    this.activeRunsByTurnId = new Map();
    this.activeRunsByThreadId = new Map();
    this.runtimeSnapshotTracker = new SessionRuntimeSnapshotTracker({
      epoch: options.runtimeSnapshotEpoch
    });
    this.lastRuntimeSnapshotLoggedRevision = 0;
    this.lastAppServerProjectionLogFingerprint = '';
    this.converter = new CodexAppServerEventConverter();
    this.runJournal = options.runJournal ?? new CodexAppServerRunJournal({
      filePath: options.runStatePath === undefined
        ? defaultRunStatePath()
        : options.runStatePath,
      epoch: this.runtimeSnapshotTracker.epoch
    });
    this.persistQueued = false;
    this.recoveryPromise = null;
    this.approvalBroker = options.approvalBroker ?? new CodexAppServerApprovalBroker({
      client: this.client,
      resolveRun: ({ threadId, turnId }) => this.resolveRunForNotification(threadId, turnId)
    });
    this.userInputBroker = options.userInputBroker ?? new CodexAppServerUserInputBroker({
      client: this.client,
      resolveRun: ({ threadId, turnId }) => this.resolveRunForNotification(threadId, turnId)
    });
    if (this.allowIndependentAppServer) {
      this.approvalBroker.on('required', (approval) => this.handleApprovalRequired(approval));
      this.approvalBroker.on('decided', (approval) => this.handleApprovalDecided(approval));
      this.approvalBroker.on('expired', (approval) => this.handleApprovalExpired(approval));
      this.approvalBroker.on('unsupported', (request) => this.addServiceEvent('codex.app_server.request.rejected', request));
      this.approvalBroker.start();
      this.userInputBroker.on('required', (request) => this.handleUserInputRequired(request));
      this.userInputBroker.on('answered', (request) => this.handleUserInputAnswered(request));
      this.userInputBroker.on('expired', (request) => this.handleUserInputExpired(request));
      this.userInputBroker.start();
      this.client.on('notification', (message) => this.handleNotification(message));
      this.client.on('stderr', (text) => this.writeLog('codex_app_server.stderr', { text }));
      this.client.on('connected', () => {
        void this.reconcilePersistedRuns();
      });
      this.client.on('reconnected', () => {
        void this.reconcilePersistedRuns();
      });
      this.restorePersistedRuns();
    }
  }

  async listThreads({ limit = 50, query = '' } = {}) {
    await this.projectCatalog.initialize();
    const max = clampLimit(limit);
    if (!this.allowIndependentAppServer) {
      const threads = await this.listDesktopThreads({ limit: max, query });
      await this.projectCatalog.observeSessions(threads);
      return threads;
    }
    const liveSummaries = [...this.liveSessions.values()].map((session) => sessionToSummary(session));
    let appServerThreads = [];
    let appServerError = null;
    if (this.allowIndependentAppServer) {
      try {
        appServerThreads = await this.listAppServerThreads({ limit: max, query });
      } catch (error) {
        appServerError = error;
        this.addServiceEvent('codex.app_server_threads.list_failed', {
          message: error.message ?? String(error)
        });
      }
    }
    const desktopThreads = await this.listDesktopThreads({ limit: max, query });
    const remoteSummaries = mergeSessions(liveSummaries, appServerThreads);
    const merged = mergeRemoteAndDesktopSessions(remoteSummaries, desktopThreads);
    if (appServerError && merged.length === 0) {
      throw appServerError;
    }
    const filtered = filterSessions(merged, query).slice(0, max);
    await this.projectCatalog.observeSessions(filtered);
    return filtered;
  }

  async getRuntimeSnapshot({ limit = 500 } = {}) {
    const sessions = await this.listThreads({ limit: clampLimit(limit, 500) });
    let officialStates = [];
    let stale = false;
    if (typeof this.runtimeStateProvider === 'function') {
      try {
        officialStates = await this.runtimeStateProvider({ limit: clampLimit(limit, 500) });
        if (!Array.isArray(officialStates)) {
          officialStates = [];
          stale = true;
        } else if (officialStates.length === 0 && sessions.length > 0) {
          stale = true;
        }
      } catch (error) {
        stale = true;
        this.addServiceEvent('codex.desktop_runtime_states.list_failed', {
          message: error.message ?? String(error)
        });
      }
    }
    if (this.allowIndependentAppServer) {
      const projectedStates = sessions
        .filter((session) => isRunningActivityStatus(
          normalizeActivityStatus(session?.appServerRuntimeState)
        ))
        .map(runtimeStateFromAppServerProjection);
      officialStates = mergeRuntimeStateLists(officialStates, projectedStates);
      const officialThreadIds = new Set(officialStates.map((state) => state.threadId));
      const unresolvedActiveThreadIds = sessions
        .filter((session) => {
          const state = normalizeActivityStatus(session?.runtimeState ?? session?.activityStatus);
          return isRunningActivityStatus(state)
            && !officialThreadIds.has(String(session?.id ?? session?.threadId ?? '').trim());
        })
        .map((session) => String(session?.id ?? session?.threadId ?? '').trim())
        .filter(Boolean);
      stale = unresolvedActiveThreadIds.length > 0;
      const projectionData = {
        source: 'thread/list',
        resolvedThreadIds: projectedStates.map((state) => state.threadId),
        activeThreadIds: projectedStates
          .filter((state) => isRunningActivityStatus(state.state))
          .map((state) => state.threadId),
        unresolvedActiveThreadIds
      };
      const projectionFingerprint = JSON.stringify(projectionData);
      if (projectionFingerprint !== this.lastAppServerProjectionLogFingerprint) {
        this.lastAppServerProjectionLogFingerprint = projectionFingerprint;
        this.addServiceEvent('runtime.snapshot.app_server_projected', projectionData);
      }
    }
    const snapshot = this.runtimeSnapshotTracker.build({
      sessions,
      activeRuns: [...this.runs.values()],
      officialStates,
      stale
    });
    if (snapshot.revision !== this.lastRuntimeSnapshotLoggedRevision) {
      this.lastRuntimeSnapshotLoggedRevision = snapshot.revision;
      const decisions = snapshot.decisions.filter((decision) => (
        decision.reason === 'official_terminal_sticky'
        || decision.reason === 'newer_turn_active'
      ));
      this.addServiceEvent('runtime.snapshot.reconciled', {
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        stale: snapshot.stale,
        sessionCount: snapshot.sessions.length,
        conflictCount: decisions.length,
        decisions: decisions.slice(0, 50)
      });
    }
    return snapshot;
  }

  async listAppServerThreads({ limit, query }) {
    this.assertIndependentAppServerEnabled('读取独立 App Server 会话列表');
    return this.listProtocolThreads({ limit, query }, (params) => this.requestAppServer('thread/list', params));
  }

  async listProtocolThreads({ limit, query }, request) {
    const target = clampLimit(limit, 500);
    const pageSize = Math.min(target, 100);
    const byId = new Map();
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = {
        archived: false,
        limit: pageSize,
        searchTerm: query || null,
        sortKey: 'updated_at',
        sortDirection: 'desc'
      };
      if (cursor) {
        params.cursor = cursor;
      }
      const response = await request(params);
      const threads = Array.isArray(response) ? response : (response?.data ?? response?.threads ?? []);
      for (const thread of threads) {
        const summary = this.threadToSummary(thread);
        if (summary.id.length > 0 && !byId.has(summary.id)) {
          byId.set(summary.id, summary);
        }
      }
      const nextCursor = Array.isArray(response)
        ? null
        : String(response?.nextCursor ?? response?.next_cursor ?? '').trim() || null;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        cursor = null;
      } else {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } while (cursor && byId.size < target);
    return [...byId.values()].slice(0, target);
  }

  async listProjects({ limit = 500 } = {}) {
    await this.projectCatalog.initialize();
    if (typeof this.sessions?.listDesktopProjects === 'function') {
      const projects = await this.sessions.listDesktopProjects();
      await this.projectCatalog.observeSessions(projects.map((project) => ({
        projectRoot: project.root,
        projectLabel: project.name
      })));
    }
    let appServerThreads = [];
    if (this.allowIndependentAppServer) {
      try {
        appServerThreads = await this.listAppServerThreads({ limit, query: '' });
      } catch (error) {
        this.addServiceEvent('codex.app_server_projects.list_failed', {
          message: error.message ?? String(error)
        });
      }
    }
    const desktopThreads = await this.listDesktopThreads({
      limit: Math.min(clampLimit(limit, 500), 100),
      query: ''
    });
    await this.projectCatalog.observeSessions(
      mergeRemoteAndDesktopSessions(appServerThreads, desktopThreads)
    );
    return this.projectCatalog.listProjects();
  }

  async listDesktopThreads({ limit, query }) {
    if (!this.allowIndependentAppServer) {
      if (typeof this.desktopThreadListProvider !== 'function') {
        throw new Error('桌面 App Server 列表接口未连接');
      }
      const threads = await this.listProtocolThreads({ limit, query }, (params) => (
        this.desktopThreadListProvider({ ...params, useStateDbOnly: true })
      ));
      return typeof this.sessions?.decorateDesktopThreads === 'function'
        ? this.sessions.decorateDesktopThreads(threads)
        : threads;
    }
    if (!this.sessions || typeof this.sessions.listSessions !== 'function') {
      return [];
    }
    try {
      return await this.sessions.listSessions({ limit, query });
    } catch (error) {
      this.addServiceEvent('codex.desktop_threads.list_failed', {
        message: error.message ?? String(error)
      });
      return [];
    }
  }

  async getThread(threadId, { tail = 120 } = {}) {
    assertThreadId(threadId);
    const local = await this.readLocalThread(threadId, { tail });
    if (local) {
      const merged = mergeLocalThreadWithLiveState(local, this.liveSessions.get(threadId));
      if (isRunningActivityStatus(normalizeActivityStatus(merged.runtimeState ?? merged.activityStatus))) {
        const refreshed = await this.readLiveTerminalSnapshot(threadId);
        return limitSessionEntries(mergeLocalThreadWithLiveState(merged, refreshed), tail);
      }
      return limitSessionEntries(merged, tail);
    }

    const live = this.liveSessions.get(threadId);
    if (live) {
      return limitSessionEntries(live, tail);
    }

    const response = await this.requestAppServer('thread/read', {
      threadId,
      includeTurns: true
    });
    const session = buildSessionSnapshot(response.thread ?? response, { threadId });
    this.liveSessions.set(threadId, session);
    return limitSessionEntries(session, tail);
  }

  async syncThread(threadId, { limit = 80, after = '', before = '' } = {}) {
    assertThreadId(threadId);
    const local = await this.readLocalThreadSync(threadId, { limit, after, before });
    if (local) {
      const merged = mergeLocalThreadWithLiveState(local, this.liveSessions.get(threadId));
      if (isRunningActivityStatus(normalizeActivityStatus(merged.runtimeState ?? merged.activityStatus))) {
        const refreshed = await this.readLiveTerminalSnapshot(threadId);
        return mergeLocalThreadWithLiveState(merged, refreshed);
      }
      return merged;
    }
    const fallback = await this.getThread(threadId, { tail: limit });
    return {
      ...fallback,
      sync: {
        mode: 'snapshot',
        source: fallback.source ?? 'app-server-live',
        filePath: fallback.filePath ?? '',
        fileSize: 0,
        fileUpdatedAt: fallback.activityUpdatedAt ?? fallback.updatedAt ?? '',
        cursorStart: '0',
        cursorEnd: String(fallback.entries?.length ?? 0),
        hasMoreBefore: false,
        hasMoreAfter: false,
        entryCount: fallback.entries?.length ?? 0
      }
    };
  }

  async deleteThread(threadId) {
    assertThreadId(threadId);
    const activeRunId = this.activeRunsByThreadId.get(threadId);
    if (activeRunId) {
      const run = this.runs.get(activeRunId);
      if (run && run.status !== 'completed' && run.status !== 'failed') {
        const error = new Error('会话正在进行中，请先中断或等待完成后再删除。');
        error.statusCode = 409;
        throw error;
      }
    }

    if (this.sessions && typeof this.sessions.getSession === 'function') {
      try {
        const localSession = await this.sessions.getSession(threadId, { tail: 1 });
        const localState = normalizeActivityStatus(
          localSession?.runtimeState ?? localSession?.activityStatus ?? ''
        );
        if (isRunningActivityStatus(localState)) {
          const error = new Error('会话正在进行中，请先中断或等待完成后再删除。');
          error.statusCode = 409;
          throw error;
        }
      } catch (error) {
        if (Number(error?.statusCode ?? 0) === 409) {
          throw error;
        }
      }
    }

    if (typeof this.runtimeStateProvider === 'function') {
      try {
        const states = await this.runtimeStateProvider({ limit: 500 });
        const targetState = Array.isArray(states)
          ? states.find((state) => String(state?.threadId ?? state?.id ?? '') === threadId)
          : null;
        const runtimeState = normalizeActivityStatus(
          targetState?.runtimeState ?? targetState?.activityStatus ?? targetState?.status ?? ''
        );
        if (isRunningActivityStatus(runtimeState)) {
          const error = new Error('会话正在进行中，请先中断或等待完成后再删除。');
          error.statusCode = 409;
          throw error;
        }
      } catch (error) {
        if (Number(error?.statusCode ?? 0) === 409) {
          throw error;
        }
        this.addServiceEvent('codex.thread.delete_runtime_probe_failed', {
          threadId,
          message: error.message ?? String(error)
        });
      }
    }

    let officialArchived = false;
    if (typeof this.archiveThreadProvider === 'function') {
      await this.archiveThreadProvider(threadId);
      officialArchived = true;
    } else if (this.allowIndependentAppServer) {
      const response = await this.requestAppServer('thread/read', {
        threadId,
        includeTurns: true
      });
      const officialState = runtimeStateFromDesktopThread(response.thread ?? response);
      if (isRunningActivityStatus(officialState)) {
        const error = new Error('会话正在进行中，请先中断或等待完成后再删除。');
        error.statusCode = 409;
        throw error;
      }
      await this.requestAppServer('thread/archive', { threadId });
      officialArchived = true;
    }

    if (!officialArchived) {
      const error = new Error('桌面归档通道不可用，无法删除会话。');
      error.statusCode = 503;
      throw error;
    }

    const deletion = {
      id: threadId,
      deletedFiles: [],
      preservedFiles: [],
      archivedThreadCount: 1,
      removedIndexRecords: 0,
      removedGlobalStateEntries: 0,
      deletedAt: new Date().toISOString()
    };
    this.liveSessions.delete(threadId);
    this.activeRunsByThreadId.delete(threadId);
    for (const [turnId, runId] of [...this.activeRunsByTurnId.entries()]) {
      const run = this.runs.get(runId);
      if (run?.threadId === threadId) {
        this.activeRunsByTurnId.delete(turnId);
      }
    }
    this.addServiceEvent('codex.thread.deleted', {
      threadId,
      officialArchived,
      deletedFiles: deletion.deletedFiles?.length ?? 0,
      preservedFiles: deletion.preservedFiles?.length ?? 0,
      archivedThreadCount: deletion.archivedThreadCount ?? 0,
      removedIndexRecords: deletion.removedIndexRecords ?? 0
    });
    return {
      ...deletion,
      officialArchived
    };
  }

  async readLiveTerminalSnapshot(threadId) {
    if (!this.allowIndependentAppServer) {
      return null;
    }
    try {
      const response = await this.requestAppServer('thread/read', {
        threadId,
        includeTurns: true
      });
      const runtimeState = runtimeStateFromDesktopThread(response.thread ?? response);
      if (!isTerminalActivityStatus(runtimeState)) {
        return null;
      }
      const session = buildSessionSnapshot(response.thread ?? response, { threadId });
      applyTerminalStateToSession(session, runtimeState, session.updatedAt || new Date().toISOString());
      session.activitySource = 'desktop-thread-read';
      session.runtimeSource = 'desktop-thread-read';
      this.liveSessions.set(threadId, session);
      this.addServiceEvent('codex.thread.live_terminal_overlay', {
        threadId,
        runtimeState,
        source: 'thread_read_for_local_running'
      });
      return session;
    } catch (error) {
      this.addServiceEvent('codex.thread.live_terminal_overlay_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async readLocalThread(threadId, { tail = 120 } = {}) {
    if (!this.sessions || typeof this.sessions.getSession !== 'function') {
      return null;
    }
    try {
      const local = await this.sessions.getSession(threadId, { tail });
      if (!local || local.detailAvailable === false || !Array.isArray(local.entries) || local.entries.length === 0) {
        return null;
      }
      return {
        ...local,
        source: local.source ?? 'session-file',
        activitySource: local.activitySource ?? 'session-file'
      };
    } catch (error) {
      this.addServiceEvent('codex.local_thread.read_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async readLocalThreadSync(threadId, { limit = 80, after = '', before = '' } = {}) {
    if (!this.sessions || typeof this.sessions.getSessionSync !== 'function') {
      return null;
    }
    try {
      const local = await this.sessions.getSessionSync(threadId, { limit, after, before });
      if (!local || local.detailAvailable === false || !Array.isArray(local.entries)) {
        return null;
      }
      return {
        ...local,
        source: local.source ?? 'session-file',
        activitySource: local.activitySource ?? 'session-file'
      };
    } catch (error) {
      this.addServiceEvent('codex.local_thread.sync_failed', {
        threadId,
        message: error.message ?? String(error)
      });
      return null;
    }
  }

  async startThread({ projectId = '', cwd = '', prompt = '', model = '', reasoningEffort = '', submissionId = '' } = {}) {
    this.assertIndependentAppServerEnabled('通过独立 App Server 新建会话');
    await this.projectCatalog.initialize();
    const project = this.resolveProject(projectId, cwd);
    const resolvedCwd = resolveSafeProjectRoot(project, { action: '手机端新建 Codex 会话' });
    const normalizedSubmissionId = String(submissionId ?? '').trim();
    const resolvedProjectId = project?.id ?? projectId;
    const newThreadSubmissionKey = this.newThreadSubmissionKey(resolvedProjectId, normalizedSubmissionId);
    const existingRunId = newThreadSubmissionKey ? this.newThreadRunsBySubmissionId.get(newThreadSubmissionKey) : '';
    const existingRun = existingRunId ? this.runs.get(existingRunId) : null;
    if (existingRun) {
      this.addRunEvent(existingRun, 'codex.thread.duplicate_submission_ignored', {
        projectId: resolvedProjectId,
        submissionId: normalizedSubmissionId,
        threadId: existingRun.threadId
      });
      const existingThread = this.liveSessions.get(existingRun.threadId)
        ?? buildSessionSnapshot({ id: existingRun.threadId, cwd: resolvedCwd, turns: [] }, { threadId: existingRun.threadId });
      return { thread: existingThread, run: this.serializeRun(existingRun) };
    }
    if (newThreadSubmissionKey && this.newThreadSubmissionPromises.has(newThreadSubmissionKey)) {
      return await this.newThreadSubmissionPromises.get(newThreadSubmissionKey);
    }

    const start = async () => {
      this.addServiceEvent('policy.effective', {
        operation: 'thread/start',
        sandbox: this.sandbox,
        approvalPolicy: this.approvalPolicy,
        projectId: resolvedProjectId,
        submissionId: normalizedSubmissionId
      });
      const response = await this.requestAppServer('thread/start', {
        cwd: resolvedCwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: appServerSandboxFromMode(this.sandbox),
        model: this.optionalModel(model),
        serviceName: 'codex_harmony_remote',
        threadSource: 'user'
      });
      const thread = response.thread;
      if (!thread?.id) {
        throw new Error('Codex app-server did not return thread.id');
      }
      const session = buildSessionSnapshot(thread, { threadId: thread.id });
      this.liveSessions.set(thread.id, session);
      if (prompt.trim().length === 0) {
        return { thread: session, run: null };
      }
      const run = await this.sendMessage({
        threadId: thread.id,
        text: prompt,
        projectId: resolvedProjectId,
        createdThreadId: thread.id,
        model,
        reasoningEffort,
        submissionId: normalizedSubmissionId
      });
      if (newThreadSubmissionKey) {
        this.newThreadRunsBySubmissionId.set(newThreadSubmissionKey, run.id);
      }
      return { thread: this.liveSessions.get(thread.id) ?? session, run };
    };
    const startPromise = start();
    if (!newThreadSubmissionKey) {
      return await startPromise;
    }
    this.newThreadSubmissionPromises.set(newThreadSubmissionKey, startPromise);
    try {
      return await startPromise;
    } finally {
      this.newThreadSubmissionPromises.delete(newThreadSubmissionKey);
    }
  }

  async sendMessage({
    threadId,
    text,
    projectId = '',
    createdThreadId = null,
    model = '',
    reasoningEffort = '',
    submissionId = '',
    deliveryMode = 'app_server'
  }) {
    this.assertIndependentAppServerEnabled('通过独立 App Server 发送消息');
    assertThreadId(threadId);
    const prompt = String(text ?? '').trim();
    if (prompt.length === 0) {
      const error = new Error('消息不能为空');
      error.statusCode = 400;
      throw error;
    }

    const normalizedSubmissionId = String(submissionId ?? '').trim();
    const submissionKey = this.submissionKey(threadId, normalizedSubmissionId);
    if (submissionKey && this.runsBySubmissionId.has(submissionKey)) {
      const existing = this.runs.get(this.runsBySubmissionId.get(submissionKey));
      if (existing) {
        if (canRetryFailedSubmission(existing)) {
          this.runsBySubmissionId.delete(submissionKey);
          this.addRunEvent(existing, 'codex.turn.failed_submission_retried', {
            threadId,
            submissionId: normalizedSubmissionId,
            previousRunId: existing.id
          });
        } else {
          this.addRunEvent(existing, 'codex.turn.duplicate_submission_ignored', {
            threadId,
            submissionId: normalizedSubmissionId
          });
          return this.serializeRun(existing);
        }
      }
      this.runsBySubmissionId.delete(submissionKey);
    }

    const run = this.createRun({
      threadId,
      prompt,
      projectId,
      createdThreadId,
      model,
      reasoningEffort,
      submissionId: normalizedSubmissionId,
      deliveryMode
    });
    if (submissionKey) {
      this.runsBySubmissionId.set(submissionKey, run.id);
    }
    if (run.deliveryMode === 'desktop_fallback') {
      this.addRunEvent(run, 'codex.desktop_sync', desktopSyncForRun(run));
    }
    this.addEntry(threadId, {
      timestamp: new Date().toISOString(),
      type: 'userMessage',
      role: 'user',
      text: prompt
    });
    this.addRunEvent(run, 'codex.user.message', { threadId, text: prompt });
    this.persistRuns();
    this.openDesktopThread(run, 'submitted');
    void this.runTurn(run).catch((error) => this.failRun(run, error));
    return this.serializeRun(run);
  }

  canSteerThread(threadId) {
    const runId = this.activeRunsByThreadId.get(String(threadId ?? ''));
    const run = runId ? this.runs.get(runId) : null;
    return Boolean(run && !isTerminalActivityStatus(run.status));
  }

  async steerMessage({ threadId, text, submissionId = '' }) {
    this.assertIndependentAppServerEnabled('通过独立 App Server 追加引导');
    assertThreadId(threadId);
    const prompt = String(text ?? '').trim();
    if (!prompt) {
      const error = new Error('引导消息不能为空');
      error.statusCode = 400;
      throw error;
    }
    const normalizedSubmissionId = String(submissionId ?? '').trim();
    const submissionKey = this.submissionKey(threadId, normalizedSubmissionId);
    if (submissionKey && this.runsBySubmissionId.has(submissionKey)) {
      const existing = this.runs.get(this.runsBySubmissionId.get(submissionKey));
      if (existing) {
        return this.serializeRun(existing);
      }
      this.runsBySubmissionId.delete(submissionKey);
    }
    const runId = this.activeRunsByThreadId.get(threadId);
    const run = runId ? this.runs.get(runId) : null;
    if (!run || isTerminalActivityStatus(run.status)) {
      const error = new Error('当前回合已经结束，无法追加引导消息。');
      error.statusCode = 409;
      error.code = 'CODEX_STEER_NO_ACTIVE_TURN';
      error.safeToFallback = true;
      throw error;
    }
    const turnId = await this.waitForTurnId(run);
    if (!turnId) {
      const error = new Error('当前回合尚未进入可引导阶段，请稍后重试。');
      error.statusCode = 409;
      error.code = 'CODEX_STEER_NO_ACTIVE_TURN';
      error.safeToFallback = true;
      throw error;
    }
    const input = [{
      type: 'text',
      text: prompt
    }, ...extractLocalImageInputs(prompt)];
    const response = await this.requestAppServer('turn/steer', {
      threadId,
      input,
      expectedTurnId: turnId
    });
    this.addEntry(threadId, {
      timestamp: new Date().toISOString(),
      type: 'userMessage',
      role: 'user',
      text: prompt
    });
    this.addRunEvent(run, 'codex.turn.steered', {
      threadId,
      turnId: response?.turnId ?? turnId,
      submissionId: normalizedSubmissionId,
      inputCount: input.length
    });
    if (submissionKey) {
      this.runsBySubmissionId.set(submissionKey, run.id);
    }
    // The phone renders the live user bubble from run.prompt; steering reuses the
    // same run, so the prompt must carry the latest steered text.
    run.prompt = prompt;
    run.updatedAt = new Date().toISOString();
    this.persistRuns();
    return this.serializeRun(run);
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('Unknown Codex run');
      error.statusCode = 404;
      throw error;
    }
    return this.serializeRun(run);
  }

  async initialize() {
    if (!this.allowIndependentAppServer) {
      return this.runtimeHealth();
    }
    if (typeof this.client.initialize === 'function') {
      await this.client.initialize();
    } else if (typeof this.client.ensureStarted === 'function') {
      await this.client.ensureStarted();
    }
    await this.reconcilePersistedRuns();
    return this.runtimeHealth();
  }

  listRuns() {
    return [...this.runs.values()]
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  }

  findRunBySubmission({ kind = 'existing_thread', threadId = '', projectId = '', submissionId = '' } = {}) {
    const normalizedSubmissionId = String(submissionId ?? '').trim();
    if (!normalizedSubmissionId) {
      return null;
    }
    const key = kind === 'new_thread'
      ? this.newThreadSubmissionKey(projectId, normalizedSubmissionId)
      : this.submissionKey(threadId, normalizedSubmissionId);
    const runId = kind === 'new_thread'
      ? this.newThreadRunsBySubmissionId.get(key)
      : this.runsBySubmissionId.get(key);
    const run = runId ? this.runs.get(runId) : null;
    return run ? this.serializeRun(run) : null;
  }

  listApprovals() {
    return this.approvalBroker.list();
  }

  getApproval(approvalId) {
    return this.approvalBroker.get(approvalId);
  }

  decideApproval(approvalId, decision) {
    return this.approvalBroker.decide(approvalId, decision);
  }

  listUserInputs() {
    return this.userInputBroker.list();
  }

  getUserInput(requestId) {
    return this.userInputBroker.get(requestId);
  }

  answerUserInput(requestId, answers) {
    return this.userInputBroker.answer(requestId, answers);
  }

  runtimeHealth() {
    if (!this.allowIndependentAppServer) {
      return {
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
      };
    }
    const health = typeof this.client.health === 'function' ? this.client.health() : {};
    return {
      kind: 'app_server',
      enabled: true,
      state: health.state ?? 'unknown',
      generation: Number(health.generation ?? this.clientGeneration()),
      pendingRequests: Number(health.pendingRequests ?? 0),
      reconnectAttempts: Number(health.reconnectAttempts ?? 0),
      reconnectScheduled: health.reconnectScheduled === true,
      recoveredRuns: [...this.runs.values()].filter((run) => run.status === 'recovering').length,
      pendingApprovals: this.listApprovals().filter((approval) => approval.status === 'pending').length,
      pendingUserInputs: this.listUserInputs().filter((request) => request.status === 'pending').length
    };
  }

  assertIndependentAppServerEnabled(action = '调用独立 App Server') {
    if (this.allowIndependentAppServer) {
      return;
    }
    const error = new Error(
      `严格桌面模式已禁用独立 App Server：${action}必须由桌面 Codex 当前可见会话完成。`
    );
    error.statusCode = 409;
    error.code = 'independent_app_server_disabled';
    throw error;
  }

  requestAppServer(method, params) {
    this.assertIndependentAppServerEnabled(`调用 ${method}；`);
    return this.client.request(method, params);
  }

  handleApprovalRequired(approval) {
    const run = this.runs.get(approval.runId);
    if (!run || isTerminalActivityStatus(run.status)) {
      return;
    }
    if (this.approvalPolicy === 'never') {
      this.addServiceEvent('policy.mismatch', {
        operation: 'approval/required',
        configuredApprovalPolicy: this.approvalPolicy,
        configuredSandbox: this.sandbox,
        approvalId: approval.id,
        runId: approval.runId,
        threadId: approval.threadId,
        turnId: approval.turnId
      });
    }
    run.status = 'waiting_approval';
    run.pendingApprovalId = approval.id;
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'approval.required', {
      approvalId: approval.id,
      command: approval.command,
      reason: approval.reason,
      risk: approval.risk,
      generation: approval.generation,
      threadId: approval.threadId,
      turnId: approval.turnId
    });
    this.schedulePersistRuns();
  }

  handleApprovalDecided(approval) {
    const run = this.runs.get(approval.runId);
    if (!run) {
      return;
    }
    if (run.status === 'waiting_approval') {
      run.status = 'running';
    }
    run.pendingApprovalId = '';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'approval.decided', {
      approvalId: approval.id,
      decision: approval.decision,
      threadId: approval.threadId,
      turnId: approval.turnId
    });
    this.schedulePersistRuns();
  }

  handleApprovalExpired(approval) {
    const run = this.runs.get(approval.runId);
    if (!run) {
      return;
    }
    if (run.status === 'waiting_approval') {
      run.status = 'recovering';
    }
    run.pendingApprovalId = '';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'approval.expired', {
      approvalId: approval.id,
      reason: approval.expireReason ?? 'app_server_reconnected',
      threadId: approval.threadId,
      turnId: approval.turnId
    });
    this.schedulePersistRuns();
    void this.reconcilePersistedRuns();
  }

  handleUserInputRequired(request) {
    const run = this.runs.get(request.runId);
    if (!run || isTerminalActivityStatus(run.status)) {
      return;
    }
    run.status = 'waiting_input';
    run.pendingUserInputId = request.id;
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'user_input.required', {
      requestId: request.id,
      itemId: request.itemId,
      questions: request.questions,
      autoResolutionMs: request.autoResolutionMs,
      generation: request.generation,
      threadId: request.threadId,
      turnId: request.turnId
    });
    this.schedulePersistRuns();
  }

  handleUserInputAnswered(request) {
    const run = this.runs.get(request.runId);
    if (!run) {
      return;
    }
    if (run.status === 'waiting_input') {
      run.status = 'running';
    }
    run.pendingUserInputId = '';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'user_input.answered', {
      requestId: request.id,
      itemId: request.itemId,
      threadId: request.threadId,
      turnId: request.turnId
    });
    this.schedulePersistRuns();
  }

  handleUserInputExpired(request) {
    const run = this.runs.get(request.runId);
    if (!run) {
      return;
    }
    if (run.status === 'waiting_input') {
      run.status = 'recovering';
    }
    run.pendingUserInputId = '';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'user_input.expired', {
      requestId: request.id,
      itemId: request.itemId,
      reason: request.expireReason ?? 'app_server_reconnected',
      threadId: request.threadId,
      turnId: request.turnId
    });
    this.schedulePersistRuns();
    void this.reconcilePersistedRuns();
  }

  async interruptRun(runId) {
    this.assertIndependentAppServerEnabled('中断独立 App Server 回合');
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('Unknown Codex run');
      error.statusCode = 404;
      throw error;
    }
    if (isTerminalActivityStatus(run.status) || run.status === 'recovering') {
      return this.serializeRun(run);
    }
    const turnId = await this.waitForTurnId(run);
    if (!turnId) {
      return this.serializeRun(run);
    }
    if (run.interruptRequested) {
      return this.serializeRun(run);
    }

    run.interruptRequested = true;
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'codex.turn.interrupt.requested', { threadId: run.threadId, turnId });
    this.schedulePersistRuns();
    try {
      await this.requestAppServer('turn/interrupt', {
        threadId: run.threadId,
        turnId
      });
    } catch (error) {
      if (!isUncertainTurnStartError(error)) {
        run.interruptRequested = false;
        this.addRunEvent(run, 'codex.turn.interrupt.failed', {
          threadId: run.threadId,
          turnId,
          message: error?.message ?? String(error)
        });
        this.schedulePersistRuns();
        throw error;
      }
    }

    const terminal = await this.waitForTerminalState(run);
    if (!terminal) {
      await this.reconcilePersistedRun(run);
    }
    if (!isTerminalActivityStatus(run.status)) {
      this.addRunEvent(run, 'codex.turn.interrupt.pending', { threadId: run.threadId, turnId });
      this.schedulePersistRuns();
    }
    return this.serializeRun(run);
  }

  async interruptThread(threadId) {
    this.assertIndependentAppServerEnabled('中断独立 App Server 会话');
    assertThreadId(threadId);
    const runId = this.activeRunsByThreadId.get(threadId);
    if (!runId) {
      const error = new Error('当前会话没有可中断的 App Server 运行');
      error.statusCode = 404;
      throw error;
    }
    return await this.interruptRun(runId);
  }

  async waitForTurnId(run) {
    const deadline = Date.now() + Number(process.env.CODEX_APP_SERVER_INTERRUPT_WAIT_MS ?? 3_000);
    while (!run.turnId && Date.now() < deadline) {
      await delay(25);
    }
    if (run.turnId) {
      return run.turnId;
    }
    await this.reconcileUncertainTurnStart(run, new Error('等待 App Server 回合标识超时'));
    return run.turnId;
  }

  async waitForTerminalState(run) {
    const deadline = Date.now() + Number(process.env.CODEX_APP_SERVER_INTERRUPT_CONFIRM_MS ?? 5_000);
    while (!isTerminalActivityStatus(run.status) && Date.now() < deadline) {
      await delay(25);
    }
    return isTerminalActivityStatus(run.status);
  }

  createRun({ threadId, prompt, projectId, createdThreadId, model, reasoningEffort, submissionId = '', deliveryMode = 'app_server' }) {
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(),
      projectId: projectId || 'codex',
      prompt,
      threadId,
      createdThreadId,
      turnId: null,
      activeCodexTurnId: null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      session: this.liveSessions.get(threadId) ?? null,
      model: normalizeModelId(model),
      reasoningEffort: normalizeReasoningEffort(reasoningEffort),
      submissionId: String(submissionId ?? '').trim(),
      deliveryMode: normalizeDeliveryMode(deliveryMode),
      promptLength: String(prompt ?? '').length,
      generation: this.clientGeneration(),
      interruptRequested: false,
      pendingApprovalId: '',
      pendingUserInputId: '',
      error: ''
    };
    this.runs.set(run.id, run);
    return run;
  }

  restorePersistedRuns() {
    if (!this.allowIndependentAppServer) {
      return;
    }
    const recovered = this.runJournal.load();
    for (const snapshot of recovered) {
      if (!isRecoverableRunIdentifier(snapshot) || !snapshot.id || this.runs.has(snapshot.id)) {
        continue;
      }
      const run = {
        ...snapshot,
        activeCodexTurnId: snapshot.turnId,
        events: [],
        session: null,
        error: '',
        interruptRequested: false,
        pendingApprovalId: '',
        pendingUserInputId: ''
      };
      this.runs.set(run.id, run);
      this.activeRunsByThreadId.set(run.threadId, run.id);
      if (run.turnId) {
        this.activeRunsByTurnId.set(run.turnId, run.id);
      }
      const submissionKey = this.submissionKey(run.threadId, run.submissionId);
      if (submissionKey) {
        this.runsBySubmissionId.set(submissionKey, run.id);
      }
      const newThreadKey = this.newThreadSubmissionKey(run.projectId, run.submissionId);
      if (newThreadKey && run.createdThreadId) {
        this.newThreadRunsBySubmissionId.set(newThreadKey, run.id);
      }
    }
  }

  async reconcilePersistedRuns() {
    if (!this.allowIndependentAppServer) {
      return [];
    }
    if (this.recoveryPromise) {
      return await this.recoveryPromise;
    }
    const active = [...this.runs.values()].filter((run) => !isTerminalActivityStatus(run.status));
    this.recoveryPromise = Promise.all(active.map((run) => this.reconcilePersistedRun(run)))
      .finally(() => {
        this.recoveryPromise = null;
      });
    return await this.recoveryPromise;
  }

  async reconcilePersistedRun(run) {
    if (!run || isTerminalActivityStatus(run.status)) {
      return run;
    }
    const recoveringFrom = run.lastKnownStatus ?? run.status;
    run.status = 'recovering';
    run.updatedAt = new Date().toISOString();
    this.addRunEvent(run, 'codex.run.recovering', this.recoveryEventPayload(
      run,
      recoveringFrom,
      'recovering',
      'recovery_started'
    ));
    this.schedulePersistRuns();
    try {
      const response = await this.requestAppServer('thread/read', {
        threadId: run.threadId,
        includeTurns: true
      });
      const thread = response?.thread ?? response;
      const session = buildSessionSnapshot(thread, { threadId: run.threadId, prompt: run.prompt });
      this.liveSessions.set(run.threadId, session);
      run.session = session;
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const turnStates = turns.map((turn) => ({
        id: String(turn?.id ?? '').trim(),
        status: normalizeDesktopTurnStatus(turn?.status)
      }));
      const activeTurnStates = turnStates.filter((turn) => !isTerminalActivityStatus(turn.status));

      if (run.turnId) {
        const exact = turnStates.find((turn) => turn.id === run.turnId) ?? null;
        if (exact && isTerminalActivityStatus(exact.status)) {
          // Official terminal state for the exact same turn is sticky: a
          // persisted run can never resurrect it as active.
          this.settleRecoveredRun(run, exact.status, 'official_terminal_sticky', { markSession: true });
          return run;
        }
        if (exact) {
          this.activateRecoveredRun(run, 'verified_active');
          return run;
        }
        // The exact turn is gone. A genuinely newer active turn must stay
        // running; otherwise the run is settled as no longer present.
        const reason = activeTurnStates.length > 0 ? 'superseded_by_newer_turn' : 'turn_not_found';
        this.settleRecoveredRun(run, 'interrupted', reason, { markSession: activeTurnStates.length === 0 });
        return run;
      }

      if (activeTurnStates.length === 1) {
        // Uncertain start: adopt the thread's single active turn so the run
        // stays bound to a real Codex-shaped turn id.
        run.turnId = activeTurnStates[0].id;
        run.activeCodexTurnId = run.turnId;
        this.activeRunsByTurnId.set(run.turnId, run.id);
        this.activateRecoveredRun(run, 'turn_id_recovered');
      } else if (activeTurnStates.length > 1) {
        this.activateRecoveredRun(run, 'multi_turn_active');
      } else {
        const terminalState = runtimeStateFromDesktopThread(thread);
        const status = isTerminalActivityStatus(terminalState) ? terminalState : 'interrupted';
        this.settleRecoveredRun(run, status, 'turn_not_found', { markSession: true });
      }
    } catch (error) {
      // Fail closed: an unverifiable run must not linger as recovering/running,
      // must not be interruptible, and must not be persisted again as active.
      run.error = error?.message ?? String(error);
      this.settleRecoveredRun(run, 'failed', 'thread_read_failed', {
        markSession: true,
        message: run.error
      });
    }
    return run;
  }

  activateRecoveredRun(run, reason) {
    const fromStatus = run.status;
    run.status = 'running';
    run.updatedAt = new Date().toISOString();
    this.activeRunsByThreadId.set(run.threadId, run.id);
    if (run.turnId) {
      this.activeRunsByTurnId.set(run.turnId, run.id);
    }
    this.addRunEvent(run, 'codex.run.recovered', this.recoveryEventPayload(
      run,
      fromStatus,
      'running',
      reason
    ));
    this.schedulePersistRuns();
  }

  settleRecoveredRun(run, status, reason, { markSession = true, message = '' } = {}) {
    const fromStatus = run.status;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (run.turnId) {
      this.activeRunsByTurnId.delete(run.turnId);
    }
    if (this.activeRunsByThreadId.get(run.threadId) === run.id) {
      this.activeRunsByThreadId.delete(run.threadId);
    }
    if (markSession) {
      this.markLiveSessionTerminal(run.threadId, status, run.updatedAt, run.turnId);
      this.removeLiveActivity(run.threadId, run.turnId);
    }
    this.resolveInterruptRequest(run, status, `recovery:${reason}`);
    const eventType = status === 'failed' ? 'codex.run.recovery_failed' : 'codex.run.recovered_terminal';
    this.addRunEvent(run, eventType, this.recoveryEventPayload(
      run,
      fromStatus,
      status,
      reason,
      message ? { message } : {}
    ));
    this.schedulePersistRuns();
  }

  recoveryEventPayload(run, fromStatus, toStatus, reason, extra = {}) {
    return {
      runId: run.id,
      threadId: run.threadId,
      turnId: run.turnId ?? null,
      fromStatus,
      toStatus,
      reason,
      generation: Number(run.generation ?? this.clientGeneration()) || 0,
      epoch: this.runtimeSnapshotTracker.epoch,
      ...extra
    };
  }

  async reconcileUncertainTurnStart(run, error) {
    this.addRunEvent(run, 'codex.turn.start.uncertain', {
      runId: run.id,
      threadId: run.threadId,
      turnId: run.turnId ?? null,
      reason: 'uncertain_turn_start',
      generation: Number(run.generation ?? this.clientGeneration()) || 0,
      epoch: this.runtimeSnapshotTracker.epoch,
      message: error?.message ?? String(error)
    });
    await this.reconcilePersistedRun(run);
    return run;
  }

  submissionKey(threadId, submissionId) {
    const normalized = String(submissionId ?? '').trim();
    return normalized ? `${String(threadId ?? '').trim()}:${normalized}` : '';
  }

  newThreadSubmissionKey(projectId, submissionId) {
    const normalized = String(submissionId ?? '').trim();
    return normalized ? `${String(projectId ?? 'codex').trim()}:${normalized}` : '';
  }

  clientGeneration() {
    const health = typeof this.client.health === 'function' ? this.client.health() : {};
    return Number(health.generation ?? 0) || 0;
  }

  persistRuns() {
    this.runJournal.persist([...this.runs.values()]);
  }

  schedulePersistRuns() {
    if (this.persistQueued) {
      return;
    }
    this.persistQueued = true;
    queueMicrotask(() => {
      this.persistQueued = false;
      this.persistRuns();
    });
  }

  async runTurn(run) {
    run.status = 'running';
    run.updatedAt = new Date().toISOString();
    this.activeRunsByThreadId.set(run.threadId, run.id);
    this.addRunEvent(run, 'codex.turn.preparing', { threadId: run.threadId });
    this.schedulePersistRuns();
    this.addRunEvent(run, 'policy.effective', {
      operation: 'turn/start',
      sandbox: this.sandbox,
      approvalPolicy: this.approvalPolicy,
      threadId: run.threadId,
      submissionId: run.submissionId
    });

    try {
      await this.requestAppServer('thread/resume', {
        threadId: run.threadId,
        cwd: null,
        approvalPolicy: this.approvalPolicy,
        sandbox: appServerSandboxFromMode(this.sandbox),
        model: this.optionalModel(run.model)
      });
    } catch (error) {
      this.addRunEvent(run, 'codex.thread.resume.warning', { threadId: run.threadId, message: error.message });
    }

    try {
      const response = await this.requestAppServer('turn/start', {
        threadId: run.threadId,
        cwd: null,
        input: [{
          type: 'text',
          text: run.prompt
        }],
        approvalPolicy: this.approvalPolicy,
        sandboxPolicy: sandboxPolicyFromMode(this.sandbox),
        model: this.optionalModel(run.model),
        effort: normalizeReasoningEffort(run.reasoningEffort)
      });
      run.turnId = response?.turn?.id ?? null;
      run.activeCodexTurnId = run.turnId;
      run.generation = this.clientGeneration();
      if (run.turnId) {
        this.activeRunsByTurnId.set(run.turnId, run.id);
      }
      this.addRunEvent(run, 'codex.turn.started', sanitize(response));
      this.schedulePersistRuns();
    } catch (error) {
      if (isUncertainTurnStartError(error)) {
        await this.reconcileUncertainTurnStart(run, error);
        return;
      }
      throw error;
    }
  }

  async handleNotification(message) {
    const threadId = extractThreadIdFromNotification(message);
    const turnId = extractTurnIdFromNotification(message);
    const run = this.resolveRunForNotification(threadId, turnId);
    if (!run) {
      this.addServiceEvent('codex.app_server.notification.unmatched', {
        method: message?.method ?? '',
        threadId,
        turnId,
        activeThreadIds: [...this.activeRunsByThreadId.keys()],
        activeTurnIds: [...this.activeRunsByTurnId.keys()],
        paramsShape: summarizeShape(message?.params)
      });
      return;
    }

    if (turnId && !run.turnId) {
      run.turnId = turnId;
      run.activeCodexTurnId = turnId;
      this.activeRunsByTurnId.set(turnId, run.id);
    }
    run.generation = this.clientGeneration();

    const converted = this.converter.convert(message);
    for (const item of converted) {
      if (item.entry) {
        this.applyEntry(run.threadId, item.entry);
      }
      this.addRunEvent(run, item.type, item.payload ?? sanitize(message));
      if (item.failed) {
        run.status = 'failed';
        run.error = item.entry?.text ?? 'Codex 回合失败';
      }
      if (item.terminal) {
        const terminalStatus = terminalStatusFromConvertedEvent(item);
        this.markLiveSessionTerminal(run.threadId, terminalStatus, new Date().toISOString(), run.turnId);
        this.removeLiveActivity(run.threadId, run.turnId);
        if (terminalStatus === 'interrupted') {
          run.status = 'interrupted';
          run.error = '已中断当前回复';
        } else if (terminalStatus === 'failed' || run.status === 'failed') {
          run.status = 'failed';
        } else {
          run.status = 'completed';
        }
        this.resolveInterruptRequest(run, run.status, `notification:${item.type}`);
        await this.finishRun(run);
      }
    }
    this.schedulePersistRuns();
  }

  resolveRunForNotification(threadId, turnId) {
    if (turnId && this.activeRunsByTurnId.has(turnId)) {
      return this.runs.get(this.activeRunsByTurnId.get(turnId)) ?? null;
    }
    if (threadId && this.activeRunsByThreadId.has(threadId)) {
      return this.runs.get(this.activeRunsByThreadId.get(threadId)) ?? null;
    }
    return null;
  }

  async finishRun(run) {
    if (run.turnId) {
      this.activeRunsByTurnId.delete(run.turnId);
    }
    this.activeRunsByThreadId.delete(run.threadId);
    try {
      const response = await this.requestAppServer('thread/read', {
        threadId: run.threadId,
        includeTurns: true
      });
      const session = buildSessionSnapshot(response.thread, {
        threadId: run.threadId,
        prompt: run.prompt
      });
      const terminalStatus = ['completed', 'failed', 'interrupted'].includes(run.status)
        ? run.status
        : 'completed';
      applyTerminalStateToSession(session, terminalStatus, run.updatedAt || new Date().toISOString(), run.turnId);
      const merged = preserveClientNoticeEntries(this.liveSessions.get(run.threadId), session);
      this.liveSessions.set(run.threadId, merged);
      run.session = merged;
      this.addRunEvent(run, 'codex.thread.read', summarizeThreadForEvent(response));
    } catch (error) {
      this.addRunEvent(run, 'codex.thread.read.failed', { threadId: run.threadId, message: error.message });
    }
    run.updatedAt = new Date().toISOString();
    this.openDesktopThread(run, 'completed');
    this.persistRuns();
  }

  failRun(run, error) {
    run.status = 'failed';
    run.error = error.message ?? String(error);
    run.updatedAt = new Date().toISOString();
    if (run.turnId) {
      this.activeRunsByTurnId.delete(run.turnId);
    }
    if (this.activeRunsByThreadId.get(run.threadId) === run.id) {
      this.activeRunsByThreadId.delete(run.threadId);
    }
    this.removeLiveActivity(run.threadId, run.turnId);
    this.markLiveSessionTerminal(run.threadId, 'failed', run.updatedAt, run.turnId);
    const notice = classifyCodexClientNotice(error, { source: 'codex.run.failed' });
    if (notice) {
      this.addEntry(run.threadId, createCodexClientNoticeEntry(error, {
        notice,
        threadId: run.threadId
      }));
    } else {
      this.addEntry(run.threadId, {
        timestamp: new Date().toISOString(),
        type: 'error',
        role: 'system',
        text: run.error
      });
    }
    this.addRunEvent(run, 'codex.run.failed', notice
      ? { threadId: run.threadId, message: run.error, notice }
      : { threadId: run.threadId, message: run.error });
    this.persistRuns();
  }

  addRunEvent(run, type, payload) {
    const event = {
      id: randomUUID(),
      seq: run.events.length + 1,
      taskId: run.id,
      type,
      payload: payload ?? {},
      createdAt: new Date().toISOString()
    };
    run.events.push(event);
    run.updatedAt = event.createdAt;
    this.schedulePersistRuns();
    this.eventBus?.publish?.(run.id, event);
    void this.writeLog(type, { runId: run.id, threadId: run.threadId, payload: event.payload });
    return event;
  }

  resolveInterruptRequest(run, terminalStatus, resolution) {
    if (run.interruptRequested !== true || !isTerminalActivityStatus(terminalStatus)) {
      return;
    }
    run.interruptRequested = false;
    this.addRunEvent(run, 'codex.turn.interrupt.confirmed', {
      threadId: run.threadId,
      turnId: run.turnId,
      terminalStatus,
      resolution,
      generation: Number(run.generation ?? this.clientGeneration()) || 0,
      epoch: this.runtimeSnapshotTracker.epoch
    });
  }

  openDesktopThread(run, stage) {
    if (!this.autoOpenDesktop || typeof this.desktopOpener !== 'function') {
      return;
    }
    void Promise.resolve()
      .then(() => this.desktopOpener(run.threadId))
      .then((result) => {
        this.addRunEvent(run, 'codex.desktop.opened', {
          threadId: run.threadId,
          stage,
          desktop: sanitize(result)
        });
      })
      .catch((error) => {
        this.addRunEvent(run, 'codex.desktop.open_failed', {
          threadId: run.threadId,
          stage,
          message: error.message ?? String(error)
        });
      });
  }

  addEntry(threadId, entry) {
    const existing = this.liveSessions.get(threadId);
    const session = existing ?? {
      id: threadId,
      title: entry.text.slice(0, 80) || '未命名会话',
      updatedAt: entry.timestamp,
      relativeTime: '刚刚',
      projectRoot: '',
      projectLabel: '未归类',
      source: 'app-server-live',
      pinned: false,
      detailAvailable: true,
      filePath: '',
      entries: [],
      entryCount: 0
    };
    session.entries = [...(session.entries ?? []), entry];
    session.entryCount = session.entries.length;
    session.updatedAt = entry.timestamp;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
    return session;
  }

  applyEntry(threadId, entry) {
    const session = this.liveSessions.get(threadId);
    if (!session) {
      return this.addEntry(threadId, entry);
    }
    if (isLiveActivityEntry(entry)) {
      session.entries = withoutLiveActivity(session.entries ?? [], entry.turnId);
      session.entries.push(entry);
    } else {
      const entries = session.entries ?? [];
      const liveEntry = entries.find((candidate) => isLiveActivityEntry(candidate)) ?? null;
      const stableEntries = entries.filter((candidate) => !isLiveActivityEntry(candidate));
      const lastStable = stableEntries.at(-1);
      if (!(lastStable && lastStable.role === entry.role && lastStable.text === entry.text)) {
        stableEntries.push(entry);
      }
      session.entries = liveEntry ? [...stableEntries, liveEntry] : stableEntries;
    }
    session.entryCount = session.entries.length;
    session.updatedAt = entry.timestamp;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
    return session;
  }

  removeLiveActivity(threadId, turnId = null) {
    const session = this.liveSessions.get(threadId);
    if (!session?.entries) {
      return;
    }
    const nextEntries = withoutLiveActivity(session.entries, turnId);
    if (nextEntries.length === session.entries.length) {
      return;
    }
    session.entries = nextEntries;
    session.entryCount = nextEntries.length;
    session.relativeTime = '刚刚';
    this.liveSessions.set(threadId, session);
  }

  markLiveSessionTerminal(threadId, status, timestamp = new Date().toISOString(), turnId = null) {
    const session = this.liveSessions.get(threadId);
    if (!session) {
      return null;
    }
    applyTerminalStateToSession(session, status, timestamp, turnId);
    this.liveSessions.set(threadId, session);
    return session;
  }

  serializeRun(run) {
    return {
      id: run.id,
      projectId: run.projectId,
      prompt: run.prompt,
      promptLength: run.promptLength ?? String(run.prompt ?? '').length,
      codexSessionId: run.threadId,
      createdCodexSessionId: run.createdThreadId,
      turnId: run.turnId,
      activeCodexTurnId: run.activeCodexTurnId ?? run.turnId,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      interruptReady: !isTerminalActivityStatus(run.status) && run.status !== 'recovering' && Boolean(run.turnId || run.status === 'running'),
      interruptRequested: run.interruptRequested === true,
      submissionId: run.submissionId || '',
      runtime: {
        kind: 'app_server',
        state: run.status,
        generation: run.generation ?? this.clientGeneration(),
        canInterrupt: !isTerminalActivityStatus(run.status) && run.status !== 'recovering' && Boolean(run.turnId || run.status === 'running'),
        reconnecting: this.runtimeHealth().state === 'reconnecting'
      },
      pendingUserInput: run.pendingUserInputId
        ? this.getUserInput(run.pendingUserInputId)
        : null,
      desktopSync: desktopSyncForRun(run),
      session: this.liveSessions.get(run.threadId) ?? run.session,
      events: run.events,
      eventCount: run.events.length,
      latestEvent: run.events.at(-1) ?? null,
      error: run.error
    };
  }

  threadToSummary(thread) {
    const id = String(thread?.id ?? '');
    const cwd = String(thread?.cwd ?? '');
    const project = this.resolveProjectByRoot(cwd);
    const updatedAt = timestampToIso(thread?.updatedAt ?? thread?.createdAt) || new Date().toISOString();
    const runtime = appServerThreadRuntimeState(thread);
    return {
      id,
      title: cleanTitle(thread?.name ?? thread?.preview ?? thread?.firstUserMessage ?? '未命名会话'),
      updatedAt,
      relativeTime: formatRelativeTime(Date.parse(updatedAt)),
      projectRoot: cwd,
      projectLabel: project?.name ?? (cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '未归类'),
      sidebarSection: 'recent',
      source: 'app-server',
      activitySource: 'app-server-thread-list',
      activityStatus: runtime.state,
      activityUpdatedAt: updatedAt,
      runtimeState: runtime.state,
      runtimeSource: 'app-server-thread-list',
      runtimeUpdatedAt: updatedAt,
      activeTurnId: runtime.activeTurnId,
      canInterrupt: runtime.canInterrupt,
      terminalReason: '',
      appServerRuntimeState: runtime.state,
      appServerRuntimeUpdatedAt: updatedAt,
      appServerActiveTurnId: runtime.activeTurnId,
      pinned: thread?.isPinned === true,
      detailAvailable: true
    };
  }

  resolveProject(projectId, cwd = '') {
    if (projectId) {
      return this.projects.find((project) => project.id === projectId) ?? this.resolveProjectByRoot(cwd);
    }
    return this.resolveProjectByRoot(cwd) ?? this.projects[0] ?? null;
  }

  resolveProjectByRoot(cwd = '') {
    const requested = String(cwd ?? '').trim();
    if (requested.length === 0) {
      return null;
    }
    return this.projects.find((project) => {
      return isSameOrChildPath(requested, project.root) || isSameOrChildPath(project.root, requested);
    }) ?? null;
  }

  optionalModel(model = '') {
    const requested = normalizeModelId(model);
    if (requested.length > 0) {
      return requested;
    }
    const value = this.model.trim();
    return value.length > 0 ? value : null;
  }

  async writeLog(event, data) {
    if (!this.logger?.write) {
      return;
    }
    await this.logger.write('bridge', 'info', event, data).catch(() => {});
  }

  addServiceEvent(type, payload) {
    void this.writeLog(type, payload);
  }
}

function assertThreadId(threadId) {
  if (!VALID_THREAD_ID.test(String(threadId ?? ''))) {
    const error = new Error('Invalid Codex thread id');
    error.statusCode = 400;
    throw error;
  }
}

function clampLimit(value, max = 100) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(parsed, 1), max);
}

function timestampToIso(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 80) {
    return text || '未命名会话';
  }
  return `${text.slice(0, 80)}...`;
}

function appServerThreadRuntimeState(thread) {
  const rawStatus = typeof thread?.status === 'object'
    ? String(thread.status?.type ?? '')
    : String(thread?.status ?? '');
  const activeFlags = Array.isArray(thread?.status?.activeFlags)
    ? thread.status.activeFlags.map((flag) => String(flag).toLowerCase())
    : [];
  const joinedFlags = activeFlags.join(' ');
  let state = 'idle';
  if (rawStatus.trim().toLowerCase() === 'active') {
    if (joinedFlags.includes('approval')) {
      state = 'waiting_approval';
    } else if (joinedFlags.includes('input') || joinedFlags.includes('question')) {
      state = 'waiting_input';
    } else if (joinedFlags.includes('recover') || joinedFlags.includes('compact')) {
      state = 'recovering';
    } else {
      state = 'running';
    }
  }
  return {
    state,
    activeTurnId: String(thread?.activeTurnId ?? thread?.turnId ?? '').trim(),
    canInterrupt: isRunningActivityStatus(state)
  };
}

function runtimeStateFromAppServerProjection(session) {
  const state = normalizeActivityStatus(session?.appServerRuntimeState) || 'idle';
  return {
    threadId: String(session?.id ?? session?.threadId ?? '').trim(),
    state,
    updatedAt: String(session?.appServerRuntimeUpdatedAt ?? session?.updatedAt ?? ''),
    source: 'app-server-thread-list',
    activeTurnId: String(session?.appServerActiveTurnId ?? '').trim(),
    canInterrupt: isRunningActivityStatus(state)
  };
}

function sessionToSummary(session) {
  const runtimeState = normalizeActivityStatus(session.runtimeState ?? session.activityStatus) || 'idle';
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    relativeTime: session.relativeTime ?? '',
    projectRoot: session.projectRoot ?? '',
    projectLabel: session.projectLabel ?? '未归类',
    sidebarSection: session.sidebarSection ?? 'recent',
    source: session.source ?? 'app-server-live',
    activitySource: session.runtimeSource ?? session.activitySource ?? 'app-server-live',
    activityStatus: runtimeState,
    activityUpdatedAt: session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? '',
    runtimeState,
    runtimeSource: session.runtimeSource ?? session.activitySource ?? 'app-server-live',
    runtimeUpdatedAt: session.runtimeUpdatedAt ?? session.activityUpdatedAt ?? '',
    canInterrupt: session.canInterrupt === true || runtimeState === 'running',
    terminalReason: terminalReasonForStatus(runtimeState),
    lastVisibleRole: session.lastVisibleRole ?? '',
    pinned: session.pinned ?? false,
    detailAvailable: true
  };
}

function mergeSessions(primary, secondary) {
  const byId = new Map();
  for (const item of [...secondary, ...primary]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => {
    return Date.parse(right.updatedAt || '0') - Date.parse(left.updatedAt || '0');
  });
}

function mergeRemoteAndDesktopSessions(remoteSessions, desktopSessions) {
  const byId = new Map(remoteSessions.map((session) => [session.id, session]));
  for (const desktop of desktopSessions) {
    const remote = byId.get(desktop.id);
    if (!remote) {
      byId.set(desktop.id, desktop);
      continue;
    }
    const runtime = mergeActivityState(remote, desktop);
    const runtimeState = runtime.status;
    const runtimeUpdatedAt = runtime.updatedAt;
    const terminal = isTerminalActivityStatus(runtimeState);
    byId.set(desktop.id, {
      ...remote,
      ...desktop,
      updatedAt: latestIso(remote.updatedAt, desktop.updatedAt),
      relativeTime: remote.relativeTime || desktop.relativeTime,
      projectRoot: desktop.projectRoot || remote.projectRoot,
      projectLabel: desktop.projectLabel || remote.projectLabel,
      sidebarSection: desktop.sidebarSection || remote.sidebarSection || '',
      source: remote.source || desktop.source,
      activitySource: runtime.source,
      activityStatus: runtimeState,
      activityUpdatedAt: runtimeUpdatedAt,
      runtimeState,
      runtimeSource: runtime.source,
      runtimeUpdatedAt,
      canInterrupt: !terminal && (runtimeState === 'running' || runtimeState === 'waiting_approval' || runtimeState === 'waiting_input' || remote.canInterrupt === true || desktop.canInterrupt === true),
      terminalReason: terminalReasonForStatus(runtimeState),
      appServerRuntimeState: remote.appServerRuntimeState ?? '',
      appServerRuntimeUpdatedAt: remote.appServerRuntimeUpdatedAt ?? '',
      appServerActiveTurnId: remote.appServerActiveTurnId ?? '',
      lastVisibleRole: remote.lastVisibleRole || desktop.lastVisibleRole || '',
      pinned: desktop.pinned ?? remote.pinned ?? false,
      detailAvailable: desktop.detailAvailable !== false || remote.detailAvailable === true
    });
  }
  return [...byId.values()].sort((left, right) => {
    return Date.parse(right.updatedAt || '0') - Date.parse(left.updatedAt || '0');
  });
}

function mergeLocalThreadWithLiveState(localSession, liveSession) {
  const liveStatus = normalizeActivityStatus(liveSession?.runtimeState ?? liveSession?.activityStatus);
  if (!isTerminalActivityStatus(liveStatus)) {
    return localSession;
  }
  const localStatus = normalizeActivityStatus(localSession?.runtimeState ?? localSession?.activityStatus);
  if (!isRunningActivityStatus(localStatus) && !isLiveActivityEntry(localSession?.entries?.at(-1))) {
    return localSession;
  }
  const liveUpdatedAt = liveSession?.runtimeUpdatedAt || liveSession?.activityUpdatedAt || liveSession?.updatedAt || '';
  const localUpdatedAt = localSession?.runtimeUpdatedAt || localSession?.activityUpdatedAt || localSession?.updatedAt || '';
  const liveSource = liveSession?.runtimeSource || liveSession?.activitySource || 'app-server-live';
  if (liveSource !== 'desktop-thread-read' && isActivityStateNewerByMoreThan(
    { status: localStatus, updatedAt: localUpdatedAt },
    { status: liveStatus, updatedAt: liveUpdatedAt },
    3000
  )) {
    return localSession;
  }
  const entries = withoutLiveActivity(localSession.entries ?? []);
  return {
    ...localSession,
    entries,
    entryCount: entries.length,
    activitySource: liveSession.runtimeSource || liveSession.activitySource || 'app-server-live',
    activityStatus: liveStatus,
    activityUpdatedAt: liveUpdatedAt || localUpdatedAt,
    runtimeState: liveStatus,
    runtimeSource: liveSession.runtimeSource || liveSession.activitySource || 'app-server-live',
    runtimeUpdatedAt: liveUpdatedAt || localUpdatedAt,
    canInterrupt: false,
    terminalReason: terminalReasonForStatus(liveStatus) || liveSession.terminalReason || liveStatus
  };
}

function applyTerminalStateToSession(session, status, timestamp = new Date().toISOString(), turnId = null) {
  const terminalStatus = normalizeActivityStatus(status) || 'completed';
  const normalized = isTerminalActivityStatus(terminalStatus) ? terminalStatus : 'completed';
  session.activitySource = 'app-server-live';
  session.activityStatus = normalized;
  session.activityUpdatedAt = timestamp;
  session.runtimeState = normalized;
  session.runtimeSource = 'app-server-live';
  session.runtimeUpdatedAt = timestamp;
  session.canInterrupt = false;
  session.terminalReason = terminalReasonForStatus(normalized) || normalized;
  session.entries = withoutLiveActivity(session.entries ?? [], turnId);
  session.entryCount = session.entries.length;
  session.updatedAt = latestIso(session.updatedAt, timestamp);
}

function terminalStatusFromConvertedEvent(item) {
  const raw = item?.payload?.params?.turn?.status
    ?? item?.payload?.params?.status
    ?? item?.payload?.status
    ?? '';
  const normalized = normalizeDesktopTurnStatus(raw);
  if (isTerminalActivityStatus(normalized)) {
    return normalized;
  }
  if (item?.failed === true || item?.type === 'codex.turn.failed') {
    return 'failed';
  }
  return 'completed';
}

function mergeRuntimeStateLists(primary, secondary) {
  const byThreadId = new Map();
  for (const state of [...secondary, ...primary]) {
    const threadId = String(state?.threadId ?? state?.id ?? '').trim();
    if (threadId) {
      byThreadId.set(threadId, state);
    }
  }
  return [...byThreadId.values()];
}

function latestRuntimeTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => String(turn?.status ?? '').trim().length > 0) ?? null;
}

function runtimeStateFromDesktopThread(thread) {
  const latest = latestRuntimeTurn(thread);
  if (!latest) {
    return '';
  }
  const mapped = normalizeDesktopTurnStatus(latest.status);
  if (mapped) {
    return mapped;
  }
  const status = String(latest.status ?? '').trim().toLowerCase().replace(/[-_ ]/g, '');
  if (status === 'inprogress' || status === 'running' || status === 'active') {
    return 'running';
  }
  return '';
}

function normalizeDesktopTurnStatus(status) {
  const value = String(status ?? '').trim().toLowerCase().replace(/[-_ ]/g, '');
  if (value === 'failed' || value === 'error') {
    return 'failed';
  }
  if (value === 'interrupted' || value === 'cancelled' || value === 'canceled' || value === 'aborted') {
    return 'interrupted';
  }
  if (value === 'completed' || value === 'complete' || value === 'success' || value === 'succeeded') {
    return 'completed';
  }
  return '';
}

function mergeActivityState(liveSession, desktopSession) {
  const live = activityStateCandidate(liveSession, 'app-server-live');
  const desktop = activityStateCandidate(desktopSession, 'session-file');
  const chosen = chooseActivityState(live, desktop);
  return {
    status: chosen.status || 'idle',
    source: chosen.source || 'unknown',
    updatedAt: chosen.updatedAt || latestIso(live.updatedAt, desktop.updatedAt)
  };
}

function activityStateCandidate(session, fallbackSource) {
  const status = normalizeActivityStatus(session.runtimeState ?? session.activityStatus);
  const explicitUpdatedAt = session.runtimeUpdatedAt || session.activityUpdatedAt || '';
  return {
    status,
    source: session.runtimeSource || session.activitySource || fallbackSource,
    updatedAt: explicitUpdatedAt || session.updatedAt || '',
    explicitUpdatedAt
  };
}

function chooseActivityState(left, right) {
  if (!left.status) {
    return right;
  }
  if (!right.status) {
    return left;
  }
  if (left.status === right.status) {
    return newerActivityState(left, right);
  }

  const leftTerminal = isTerminalActivityStatus(left.status);
  const rightTerminal = isTerminalActivityStatus(right.status);
  const leftRunning = isRunningActivityStatus(left.status);
  const rightRunning = isRunningActivityStatus(right.status);
  const leftIdle = left.status === 'idle';
  const rightIdle = right.status === 'idle';

  if ((leftTerminal && rightRunning) || (rightTerminal && leftRunning)) {
    const terminal = leftTerminal ? left : right;
    const running = leftRunning ? left : right;
    if (isActivityStateNewerByMoreThan(running, terminal, 3000)) {
      return running;
    }
    return terminal;
  }

  if ((leftRunning && rightIdle) || (rightRunning && leftIdle)) {
    const running = leftRunning ? left : right;
    const idle = leftIdle ? left : right;
    if (idle.source === 'app-server-thread-list') {
      return running;
    }
    if (!idle.explicitUpdatedAt) {
      return running;
    }
    return newerActivityState(running, idle);
  }

  return newerActivityState(left, right);
}

function newerActivityState(left, right) {
  const leftMs = Date.parse(left.updatedAt || '');
  const rightMs = Date.parse(right.updatedAt || '');
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs > rightMs ? left : right;
  }
  if (Number.isFinite(leftMs) && !Number.isFinite(rightMs)) {
    return left;
  }
  if (!Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return right;
  }
  const leftPriority = activityStatusPriority(left.status);
  const rightPriority = activityStatusPriority(right.status);
  return leftPriority >= rightPriority ? left : right;
}

function isActivityStateNewerByMoreThan(candidate, baseline, thresholdMs) {
  const candidateMs = Date.parse(candidate.updatedAt || '');
  const baselineMs = Date.parse(baseline.updatedAt || '');
  return Number.isFinite(candidateMs) && Number.isFinite(baselineMs) && candidateMs - baselineMs > thresholdMs;
}

function activityStatusPriority(status) {
  if (status === 'failed') {
    return 50;
  }
  if (status === 'interrupted') {
    return 45;
  }
  if (status === 'completed') {
    return 40;
  }
  if (status === 'waiting_approval') {
    return 30;
  }
  if (status === 'waiting_input') {
    return 30;
  }
  if (status === 'recovering') {
    return 25;
  }
  if (status === 'running') {
    return 20;
  }
  if (status === 'idle') {
    return 10;
  }
  return 0;
}

function isTerminalActivityStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function isRunningActivityStatus(status) {
  return status === 'running' || status === 'waiting_approval' || status === 'waiting_input' || status === 'recovering';
}

function normalizeActivityStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  if (status === 'running' || status === 'waiting_approval' || status === 'waiting_input' || status === 'recovering' || status === 'interrupted' || status === 'failed' || status === 'completed' || status === 'idle') {
    return status;
  }
  return '';
}

function terminalReasonForStatus(status) {
  const normalized = normalizeActivityStatus(status);
  if (normalized === 'completed' || normalized === 'interrupted' || normalized === 'failed') {
    return normalized;
  }
  return '';
}

function latestIso(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const leftMs = Date.parse(leftText || '0');
  const rightMs = Date.parse(rightText || '0');
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs >= rightMs ? leftText : rightText;
  }
  return leftText || rightText;
}

function filterSessions(sessions, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) {
    return sessions;
  }
  return sessions.filter((session) => {
    return `${session.id} ${session.title} ${session.projectLabel} ${session.projectRoot}`.toLowerCase().includes(normalized);
  });
}

function sandboxPolicyFromMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (normalized === 'danger-full-access' || normalized === 'dangerfullaccess') {
    return { type: 'dangerFullAccess' };
  }
  if (normalized === 'read-only' || normalized === 'readonly') {
    return { type: 'readOnly' };
  }
  return { type: 'workspaceWrite', networkAccess: true };
}

function appServerSandboxFromMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (normalized === 'danger-full-access' || normalized === 'dangerfullaccess') {
    return 'danger-full-access';
  }
  if (normalized === 'read-only' || normalized === 'readonly') {
    return 'read-only';
  }
  return 'workspace-write';
}

function normalizeDeliveryMode(value) {
  return String(value ?? '').trim() === 'desktop_fallback' ? 'desktop_fallback' : 'app_server';
}

function desktopSyncForRun(run) {
  if (normalizeDeliveryMode(run?.deliveryMode) === 'desktop_fallback') {
    return {
      status: 'app_server_fallback',
      desktopLive: false,
      mode: run?.createdThreadId ? 'new' : 'resume',
      message: '桌面实时通道暂不可用，已通过 App Server 安全兜底提交到目标会话。',
      reason: '发送前桌面会话预检未通过；本次不会实时显示到桌面窗口，待桌面远程模式恢复后自动回到桌面主链路。'
    };
  }
  return {
    status: 'app_server_official',
    desktopLive: false,
    mode: run?.createdThreadId ? 'new' : 'resume',
    message: '已通过 Codex 官方 app-server 会话协议提交。',
    reason: '手机端现在以 app-server thread 为准，不再依赖桌面窗口注入。'
  };
}

function canRetryFailedSubmission(run) {
  return run?.status === 'failed'
    && !String(run.turnId ?? '').trim()
    && !String(run.activeCodexTurnId ?? '').trim();
}

function defaultRunStatePath() {
  return path.join(process.cwd(), 'logs', 'app-server-active-runs.json');
}

function isUncertainTurnStartError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('stdin is not writable')
    || message.includes('closed')
    || message.includes('disconnect')
    || message.includes('connection');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return null;
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : null;
}

function limitSessionEntries(session, tail) {
  const limit = clampLimit(tail, 200);
  const entries = (session.entries ?? []).slice(-limit);
  return {
    ...session,
    entries,
    entryCount: entries.length
  };
}

function withoutLiveActivity(entries, turnId = null) {
  return entries.filter((entry) => {
    if (!isLiveActivityEntry(entry)) {
      return true;
    }
    if (!turnId) {
      return false;
    }
    return entry.turnId && entry.turnId !== turnId;
  });
}

function preserveClientNoticeEntries(existing, snapshot) {
  if (!existing?.entries?.length) {
    return snapshot;
  }
  const notices = existing.entries.filter((entry) => entry.type === 'codex_client_notice');
  if (notices.length === 0) {
    return snapshot;
  }
  const entries = [...(snapshot.entries ?? [])];
  for (const notice of notices) {
    const duplicate = entries.some((entry) => {
      return entry.type === notice.type
        && entry.role === notice.role
        && entry.text === notice.text;
    });
    if (!duplicate) {
      entries.push(notice);
    }
  }
  return {
    ...snapshot,
    entries,
    entryCount: entries.length
  };
}

function formatRelativeTime(updatedAtMs) {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return '';
  }
  const diffMs = Date.now() - updatedAtMs;
  if (diffMs < 60 * 1000) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function extractThreadIdFromNotification(message) {
  const params = message?.params ?? {};
  return firstString([
    params.threadId,
    params.thread_id,
    params.threadID,
    params.sessionId,
    params.session_id,
    params.conversationId,
    params.conversation_id,
    params.thread?.id,
    params.thread?.threadId,
    params.thread?.thread_id,
    params.turn?.threadId,
    params.turn?.thread_id,
    params.turn?.thread?.id,
    params.item?.threadId,
    params.item?.thread_id,
    params.item?.thread?.id,
    params.event?.threadId,
    params.event?.thread_id,
    params.event?.thread?.id,
    params.delta?.threadId,
    params.delta?.thread_id
  ]);
}

export function extractTurnIdFromNotification(message) {
  const params = message?.params ?? {};
  return firstString([
    params.turnId,
    params.turn_id,
    params.turnID,
    params.responseId,
    params.response_id,
    params.turn?.id,
    params.turn?.turnId,
    params.turn?.turn_id,
    params.item?.turnId,
    params.item?.turn_id,
    params.item?.turn?.id,
    params.event?.turnId,
    params.event?.turn_id,
    params.event?.turn?.id,
    params.delta?.turnId,
    params.delta?.turn_id
  ]);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function summarizeShape(value, depth = 0) {
  if (!value || typeof value !== 'object') {
    return typeof value;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? '[array]' : '[object]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => summarizeShape(item, depth + 1));
  }
  const shape = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    const child = value[key];
    shape[key] = child && typeof child === 'object' ? summarizeShape(child, depth + 1) : typeof child;
  }
  return shape;
}
