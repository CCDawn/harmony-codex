import { createId } from './ids.js';
import { classifyCodexClientNotice } from './codexClientNotices.js';
import { normalizeModelId } from './sessionSettingsStore.js';

export class TaskStore {
  constructor({
    projects,
    adapter,
    eventBus,
    logger,
    beforeRun = null,
    interruptReconciler = null,
    interruptReconcileTimeoutMs = 30000,
    interruptReconcilePollMs = 500
  }) {
    this.projects = projects;
    this.adapter = adapter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.beforeRun = beforeRun;
    this.interruptReconciler = typeof interruptReconciler === 'function' ? interruptReconciler : null;
    this.interruptReconcileTimeoutMs = Math.max(0, Number(interruptReconcileTimeoutMs) || 0);
    this.interruptReconcilePollMs = Math.max(25, Number(interruptReconcilePollMs) || 500);
    this.tasks = new Map();
    this.tasksBySubmissionId = new Map();
    this.approvals = new Map();
  }

  listProjects() {
    return this.projects.map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root
    }));
  }

  createTask({ projectId, prompt, codexSessionId = null, sessionFingerprint = null, verifiedSessionTarget = null, verifiedDesktopStatus = null, submissionSource = '', submissionId = '', reasoningEffort = '', model = '', desktopRelaunch = '' }) {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      const error = new Error('Unknown project');
      error.statusCode = 404;
      throw error;
    }

    if (typeof prompt !== 'string' || prompt.trim().length < 1) {
      const error = new Error('请输入要发送给 Codex 的内容');
      error.statusCode = 400;
      throw error;
    }

    const normalizedSessionId = normalizeSessionId(codexSessionId);
    const normalizedSubmissionId = normalizeOptionalString(submissionId);
    const submissionKey = buildTaskSubmissionKey(projectId, normalizedSessionId, normalizedSubmissionId);
    if (submissionKey && this.tasksBySubmissionId.has(submissionKey)) {
      const existing = this.tasks.get(this.tasksBySubmissionId.get(submissionKey));
      if (existing && !isSafelyRetryableFailedSubmission(existing)) {
        this.addEvent(existing.id, 'task.duplicate_submission_ignored', {
          submissionId: normalizedSubmissionId,
          status: existing.status
        });
        return existing;
      }
      this.tasksBySubmissionId.delete(submissionKey);
    }
    const now = new Date().toISOString();
    const task = {
      id: createId('task'),
      projectId,
      prompt: prompt.trim(),
      codexSessionId: normalizedSessionId,
      sessionFingerprint: normalizeSessionFingerprint(sessionFingerprint),
      verifiedSessionTarget: normalizeSessionFingerprint(verifiedSessionTarget),
      status: 'queued',
      createdCodexSessionId: null,
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      error: null,
      desktopSync: null,
      verifiedDesktopStatus,
      desktopRelaunch: normalizeOptionalString(desktopRelaunch),
      submissionSource: normalizeOptionalString(submissionSource),
      submissionId: normalizedSubmissionId,
      model: normalizeModelId(model),
      reasoningEffort: normalizeReasoningEffort(reasoningEffort),
      activeCodexTurnId: null,
      interruptRequested: false,
      interruptDispatching: false,
      interruptError: null,
      interruptOperationId: null,
      interruptRequestedAt: null,
      interruptReconcileUntil: null,
      interruptRecovering: false,
      interruptAttemptCount: 0,
      lastInterruptFailure: null
    };

    this.tasks.set(task.id, task);
    if (submissionKey) {
      this.tasksBySubmissionId.set(submissionKey, task.id);
    }
    this.addEvent(task.id, 'task.created', {
      projectId,
      codexSessionId: normalizedSessionId,
      sessionFingerprint: task.sessionFingerprint,
      submissionId: normalizedSubmissionId
    });
    this.runTask(task.id);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  interruptTask(taskId) {
    return this.requestInterruptTask(taskId);
  }

  requestInterruptTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      const error = new Error('Unknown task');
      error.statusCode = 404;
      throw error;
    }
    if (!['queued', 'running', 'waiting_approval'].includes(task.status)) {
      const error = new Error('当前任务已经结束，不能中断。');
      error.statusCode = 409;
      throw error;
    }
    if (!this.adapter || typeof this.adapter.interrupt !== 'function') {
      const error = new Error('当前 Codex 通道不支持中断。');
      error.statusCode = 501;
      throw error;
    }

    this.queueInterruptDispatch(taskId);
    return task;
  }

  findRunningTaskForSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const runningTasks = [...this.tasks.values()]
      .filter((task) => ['queued', 'running', 'waiting_approval'].includes(task.status))
      .filter((task) => task.codexSessionId === normalizedSessionId || task.createdCodexSessionId === normalizedSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return runningTasks[0] ?? null;
  }

  canSteerSessionTask(sessionId) {
    return typeof this.adapter?.steer === 'function'
      && this.findRunningTaskForSession(sessionId) !== null;
  }

  async steerSessionTask(sessionId, { prompt, submissionId = '' } = {}) {
    const task = this.findRunningTaskForSession(sessionId);
    if (!task || typeof this.adapter?.steer !== 'function') {
      const error = new Error('当前会话没有可追加引导的运行任务。');
      error.statusCode = 409;
      error.code = 'CODEX_STEER_NO_ACTIVE_TURN';
      error.safeToFallback = true;
      throw error;
    }
    const text = String(prompt ?? '').trim();
    if (!text) {
      const error = new Error('引导消息不能为空');
      error.statusCode = 400;
      throw error;
    }
    const normalizedSubmissionId = normalizeOptionalString(submissionId);
    const submissionKey = buildTaskSubmissionKey(task.projectId, task.codexSessionId, normalizedSubmissionId);
    if (submissionKey && this.tasksBySubmissionId.has(submissionKey)) {
      const existing = this.tasks.get(this.tasksBySubmissionId.get(submissionKey));
      if (existing) {
        this.addEvent(existing.id, 'task.guidance.duplicate_submission_ignored', {
          submissionId: normalizedSubmissionId
        });
        return existing;
      }
      this.tasksBySubmissionId.delete(submissionKey);
    }
    this.addEvent(task.id, 'task.guidance.submitting', {
      submissionId: normalizedSubmissionId,
      promptLength: text.length
    });
    try {
      const result = await this.adapter.steer({
        task,
        prompt: text,
        submissionId: normalizedSubmissionId,
        emit: (type, payload) => this.recordAdapterEvent(task.id, type, payload)
      });
      if (submissionKey) {
        this.tasksBySubmissionId.set(submissionKey, task.id);
      }
      this.addEvent(task.id, 'task.guidance.accepted', {
        submissionId: normalizedSubmissionId,
        turnId: result?.turnId ?? task.activeCodexTurnId ?? ''
      });
      // The phone renders the live user bubble from task.prompt; steering reuses
      // the same task, so the prompt must carry the latest steered text.
      task.prompt = text;
      task.updatedAt = new Date().toISOString();
      return task;
    } catch (error) {
      this.addEvent(task.id, 'task.guidance.failed', {
        submissionId: normalizedSubmissionId,
        message: error instanceof Error ? error.message : String(error)
      });
      if (error.deliveryUncertain === true) error.deliveryTaskId = task.id;
      throw error;
    }
  }

  interruptSessionTask(sessionId) {
    return this.requestInterruptSessionTask(sessionId);
  }

  requestInterruptSessionTask(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const task = this.findRunningTaskForSession(normalizedSessionId);
    if (task) {
      return this.requestInterruptTask(task.id);
    }
    if (!this.adapter || typeof this.adapter.interrupt !== 'function') {
      const error = new Error('当前 Codex 通道不支持按会话中断。');
      error.statusCode = 501;
      throw error;
    }

    const now = new Date().toISOString();
    const syntheticTask = {
      id: createId('task'),
      projectId: this.projects[0]?.id ?? 'probe',
      prompt: '中断当前会话',
      codexSessionId: normalizedSessionId,
      sessionFingerprint: null,
      verifiedSessionTarget: null,
      status: 'running',
      createdCodexSessionId: normalizedSessionId,
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      error: null,
      desktopSync: null,
      verifiedDesktopStatus: null,
      submissionId: '',
      model: '',
      reasoningEffort: '',
      activeCodexTurnId: null,
      interruptRequested: false,
      interruptDispatching: false,
      interruptError: null,
      interruptOperationId: null,
      interruptRequestedAt: null,
      interruptReconcileUntil: null,
      interruptRecovering: false,
      interruptAttemptCount: 0,
      lastInterruptFailure: null,
      syntheticInterrupt: true
    };
    this.tasks.set(syntheticTask.id, syntheticTask);
    this.addEvent(syntheticTask.id, 'task.created', {
      projectId: syntheticTask.projectId,
      codexSessionId: normalizedSessionId,
      source: 'session_interrupt'
    });
    this.queueInterruptDispatch(syntheticTask.id, { source: 'session_interrupt' });
    return syntheticTask;
  }

  queueInterruptDispatch(taskId, payload = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }
    if (!['queued', 'running', 'waiting_approval'].includes(task.status)) {
      return task;
    }
    if (task.interruptDispatching === true || task.interruptRecovering === true) {
      this.addEvent(taskId, 'task.interrupt.duplicate_ignored', {
        reason: task.interruptDispatching === true ? 'dispatching' : 'reconciling'
      });
      return task;
    }
    task.interruptRequested = true;
    task.interruptError = null;
    task.lastInterruptFailure = null;
    task.interruptRequestedAt = new Date().toISOString();
    task.interruptOperationId = createId('interrupt');
    task.interruptAttemptCount = Number(task.interruptAttemptCount ?? 0) + 1;
    if (!task.interruptDispatching) {
      task.interruptDispatching = true;
      this.addEvent(taskId, 'task.interrupt.requested', payload);
      this.addEvent(taskId, 'task.interrupt.dispatching', payload);
      setTimeout(() => {
        void this.dispatchInterrupt(taskId);
      }, 0);
    }
    return task;
  }

  async dispatchInterrupt(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    try {
      const result = await this.adapter.interrupt({
        task,
        emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload)
      });
      const latest = this.tasks.get(taskId);
      if (!latest) {
        return;
      }
      if (latest.status === 'interrupted') {
        return;
      }
      if (!['queued', 'running', 'waiting_approval'].includes(latest.status)) {
        latest.interruptDispatching = false;
        latest.interruptRecovering = false;
        latest.interruptRequested = false;
        latest.interruptError = null;
        this.addEvent(taskId, 'task.interrupt.late_confirm_ignored', { status: latest.status });
        return;
      }
      if (result?.accepted === true && result?.confirmed === true) {
        if (isStrongInterruptedOutcomeForTask(latest, result)) {
          this.markTaskInterrupted(latest, result);
          return;
        }
        if (isStrongCompletedOutcomeForTask(latest, result)) {
          this.markTaskCompletedFromReconcile(latest, {
            ...result,
            reason: result.reason ?? 'desktop_turn_already_terminal'
          });
          return;
        }
        latest.interruptDispatching = false;
        latest.interruptRequested = true;
        latest.interruptRecovering = false;
        latest.lastInterruptFailure = '桌面返回了中断终态，但无法确认它属于当前回合。';
        this.addEvent(taskId, 'task.interrupt.weak_confirm_ignored', compactReconcileOutcome(result));
        this.addEvent(taskId, 'task.interrupt.recoverable_failed', {
          message: latest.lastInterruptFailure,
          reason: 'weak_confirm'
        });
        return;
      }
      if (result?.accepted === true && result?.confirmed !== true) {
        latest.interruptRequested = true;
        latest.interruptDispatching = true;
        latest.interruptRecovering = true;
        latest.interruptError = null;
        latest.lastInterruptFailure = null;
        latest.interruptReconcileUntil = futureIso(this.interruptReconcileTimeoutMs);
        this.addEvent(taskId, 'task.interrupt.accepted', {
          message: '桌面已接受中断请求，正在等待回合结束确认。'
        });
        this.startInterruptReconciliation(taskId, { reason: 'accepted_without_confirmation' });
        return;
      }
      latest.interruptDispatching = false;
      latest.interruptRecovering = false;
      latest.interruptRequested = true;
      latest.interruptError = null;
      latest.lastInterruptFailure = '桌面未返回可确认的中断结果。';
      this.addEvent(taskId, 'task.interrupt.unconfirmed', {
        reason: 'missing_confirmed_result'
      });
      this.addEvent(taskId, 'task.interrupt.recoverable_failed', {
        message: latest.lastInterruptFailure
      });
    } catch (error) {
      const latest = this.tasks.get(taskId);
      if (!latest) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!['queued', 'running', 'waiting_approval'].includes(latest.status)) {
        latest.interruptDispatching = false;
        latest.interruptRecovering = false;
        this.addEvent(taskId, 'task.interrupt.late_failed_ignored', { status: latest.status, message });
        return;
      }
      latest.interruptDispatching = false;
      latest.lastInterruptFailure = message;
      if (latest.status === 'interrupted') {
        return;
      }
      this.addEvent(taskId, 'task.interrupt.dispatch_failed', { message });
      if (latest.syntheticInterrupt) {
        latest.status = 'failed';
        latest.error = `中断失败：${message}`;
        this.addEvent(taskId, 'task.failed', { message: latest.error });
        return;
      }
      latest.interruptRequested = true;
      latest.interruptRecovering = true;
      latest.interruptError = null;
      latest.error = null;
      latest.interruptReconcileUntil = futureIso(this.interruptReconcileTimeoutMs);
      this.addEvent(taskId, 'task.interrupt.reconcile_started', { message });
      this.startInterruptReconciliation(taskId, { reason: 'dispatch_failed', message });
    }
  }

  startInterruptReconciliation(taskId, payload = {}) {
    if (!this.interruptReconciler) {
      void this.finishInterruptReconciliationWithoutProvider(taskId, payload);
      return;
    }
    void this.reconcileInterruptUntilTerminal(taskId, payload);
  }

  async finishInterruptReconciliationWithoutProvider(taskId, payload = {}) {
    const task = this.tasks.get(taskId);
    if (!task || !['queued', 'running', 'waiting_approval'].includes(task.status)) {
      return;
    }
    task.interruptDispatching = false;
    task.interruptRecovering = false;
    task.lastInterruptFailure = payload.message ?? task.lastInterruptFailure ?? '无法确认桌面中断状态';
    task.interruptError = null;
    task.error = null;
    this.addEvent(taskId, 'task.interrupt.recoverable_failed', {
      message: task.lastInterruptFailure,
      reason: 'missing_reconciler'
    });
  }

  async reconcileInterruptUntilTerminal(taskId, payload = {}) {
    const startedAt = Date.now();
    const timeoutMs = this.interruptReconcileTimeoutMs;
    const deadline = startedAt + timeoutMs;
    let lastOutcome = null;
    do {
      const task = this.tasks.get(taskId);
      if (!task || !['queued', 'running', 'waiting_approval'].includes(task.status)) {
        return;
      }
      const outcome = await this.reconcileInterruptOnce(task, payload).catch((error) => ({
        status: 'unknown',
        reason: 'reconciler_error',
        message: error instanceof Error ? error.message : String(error)
      }));
      lastOutcome = outcome;
      this.addEvent(taskId, 'task.interrupt.reconcile_polled', compactReconcileOutcome(outcome));
      if (this.applyInterruptReconciliationOutcome(taskId, outcome)) {
        return;
      }
      if (timeoutMs <= 0 || Date.now() >= deadline) {
        break;
      }
      await sleep(Math.min(this.interruptReconcilePollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);

    const latest = this.tasks.get(taskId);
    if (!latest || !['queued', 'running', 'waiting_approval'].includes(latest.status)) {
      return;
    }
    latest.interruptDispatching = false;
    latest.interruptRecovering = false;
    latest.interruptError = null;
    latest.error = null;
    latest.lastInterruptFailure = payload.message ?? latest.lastInterruptFailure ?? '未确认中断结果';
    this.addEvent(taskId, 'task.interrupt.reconcile_timeout', {
      message: latest.lastInterruptFailure,
      lastOutcome: compactReconcileOutcome(lastOutcome)
    });
    this.addEvent(taskId, 'task.interrupt.recoverable_failed', {
      message: latest.lastInterruptFailure
    });
  }

  async reconcileInterruptOnce(task, payload = {}) {
    const threadId = normalizeSessionId(task.codexSessionId || task.createdCodexSessionId);
    const activeTurnId = String(task.activeCodexTurnId ?? '');
    if (!threadId && !activeTurnId) {
      return { status: 'unknown', reason: 'missing_thread_and_turn' };
    }
    return await this.interruptReconciler({
      task: { ...task, events: task.events.slice() },
      threadId,
      activeTurnId,
      reason: payload.reason ?? '',
      message: payload.message ?? ''
    });
  }

  applyInterruptReconciliationOutcome(taskId, outcome) {
    const task = this.tasks.get(taskId);
    if (!task || !outcome || typeof outcome !== 'object') {
      return false;
    }
    const status = String(outcome.status ?? '');
    if (status === 'interrupted') {
      if (!isStrongInterruptedOutcomeForTask(task, outcome)) {
        this.addEvent(taskId, 'task.interrupt.weak_confirm_ignored', compactReconcileOutcome(outcome));
        return false;
      }
      this.markTaskInterrupted(task, outcome);
      return true;
    }
    if (status === 'completed') {
      if (!isStrongCompletedOutcomeForTask(task, outcome)) {
        this.addEvent(taskId, 'task.interrupt.weak_confirm_ignored', compactReconcileOutcome(outcome));
        return false;
      }
      this.markTaskCompletedFromReconcile(task, outcome);
      return true;
    }
    return false;
  }

  async waitForInterruptDispatch(taskId, timeoutMs = 700) {
    const startedAt = Date.now();
    const delayMs = 25;
    do {
      const task = this.tasks.get(taskId);
      if (!task) {
        return null;
      }
      if (!task.interruptDispatching || !['queued', 'running', 'waiting_approval'].includes(task.status)) {
        return task;
      }
      await sleep(delayMs);
    } while (Date.now() - startedAt < Math.max(0, timeoutMs));
    return this.tasks.get(taskId) ?? null;
  }

  markTaskInterrupted(task, evidence = {}) {
    if (task.status === 'interrupted') {
      return task;
    }
    task.interruptDispatching = false;
    task.interruptRecovering = false;
    task.interruptRequested = true;
    task.interruptError = null;
    task.lastInterruptFailure = null;
    task.status = 'interrupted';
    task.error = '已中断当前会话';
    this.addEvent(task.id, 'task.interrupt.reconcile_confirmed', {
      status: 'interrupted',
      reason: evidence.reason ?? '',
      turnId: evidence.turnId ?? evidence.activeTurnId ?? ''
    });
    this.addEvent(task.id, 'task.interrupted', { message: task.error });
    return task;
  }

  listTasks() {
    return [...this.tasks.values()].sort((left, right) => {
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  getApproval(approvalId) {
    return this.approvals.get(approvalId) ?? null;
  }

  decideApproval(approvalId, decision) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      const error = new Error('Unknown approval');
      error.statusCode = 404;
      throw error;
    }

    if (approval.status !== 'pending') {
      const error = new Error('Approval has already been decided');
      error.statusCode = 409;
      throw error;
    }

    if (!['approved', 'denied'].includes(decision)) {
      const error = new Error('Decision must be approved or denied');
      error.statusCode = 400;
      throw error;
    }

    approval.status = 'decided';
    approval.decision = decision;
    approval.decidedAt = new Date().toISOString();
    approval.resolve(approval);
    this.addEvent(approval.taskId, 'approval.decided', {
      approvalId,
      decision
    });
    return approval;
  }

  addEvent(taskId, type, payload = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    const event = {
      id: createId('evt'),
      seq: task.events.length + 1,
      taskId,
      type,
      payload,
      createdAt: new Date().toISOString()
    };

    task.events.push(event);
    task.updatedAt = event.createdAt;
    this.eventBus.publish(taskId, event);
    void this.logger?.write('task-events', 'info', type, event);
    return event;
  }

  async runTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const project = this.projects.find((candidate) => candidate.id === task.projectId);
    task.status = 'running';
    this.addEvent(taskId, 'task.running');
    this.addEvent(taskId, 'task.adapter.starting', {
      adapter: this.adapter?.constructor?.name ?? 'unknown',
      projectRoot: project?.root ?? ''
    });

    try {
      if (typeof this.beforeRun === 'function') {
        await this.beforeRun({
          task,
          project,
          emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload)
        });
      }
      const result = await this.adapter.run({
        task,
        project,
        emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload),
        requestApproval: (request) => this.createApproval(taskId, request)
      });

      if (task.status === 'interrupted' || task.status === 'completed') {
        return;
      }
      if (['queued', 'running', 'waiting_approval'].includes(task.status)) {
        task.status = 'completed';
        task.result = result;
        this.addEvent(taskId, 'task.completed', result);
      }
    } catch (error) {
      if (task.status === 'completed') {
        return;
      }
      if (task.status === 'interrupted') {
        return;
      }
      if (task.interruptRequested && task.interruptDispatching && !task.interruptError) {
        task.interruptDispatching = false;
        task.interruptRecovering = false;
        task.lastInterruptFailure = '任务结束时仍未确认中断是否成功。';
        this.addEvent(taskId, 'task.interrupt.recoverable_failed', {
          message: task.lastInterruptFailure,
          reason: 'run_error_during_interrupt'
        });
      } else if (task.interruptRecovering === true && !task.interruptError) {
        this.addEvent(taskId, 'task.error.deferred_during_interrupt_reconcile', {
          message: error instanceof Error ? error.message : String(error)
        });
      } else {
        task.status = 'failed';
        task.error = error.message;
        const notice = error?.notice ?? classifyCodexClientNotice(error, { source: 'task.failed' });
        this.addEvent(taskId, 'task.failed', notice ? { message: task.error, notice } : { message: task.error });
      }
    }
  }

  recordAdapterEvent(taskId, type, payload = {}) {
    if (payload?.diagnosticOnly === true) {
      void this.logger?.write('task-diagnostics', 'warn', type, {
        taskId,
        ...payload
      });
      return null;
    }
    const task = this.tasks.get(taskId);
    if (task && (type === 'codex.exec.event' || type === 'codex.app_server.thread.ready')) {
      const threadId = extractThreadId(payload);
      if (threadId && !task.createdCodexSessionId) {
        task.createdCodexSessionId = threadId;
        if (!task.codexSessionId) {
          task.codexSessionId = threadId;
        }
      }
    }
    if (task && type === 'codex.desktop_sync') {
      task.desktopSync = payload;
    }
    if (task && type === 'codex.app_server.turn.started') {
      const turnId = extractTurnId(payload);
      if (turnId) {
        task.activeCodexTurnId = turnId;
      }
    }
    if (task
      && (type === 'codex.app_server.turn.interrupted' || type === 'codex.session_file.turn.interrupted')
      && ['queued', 'running', 'waiting_approval'].includes(task.status)) {
      if (task.interruptRequested === true && isStrongInterruptedOutcomeForTask(task, payload)) {
        this.markTaskInterrupted(task, {
          ...payload,
          reason: type
        });
      } else {
        this.addEvent(taskId, 'task.interrupt.weak_confirm_ignored', {
          status: 'interrupted',
          reason: type,
          turnId: extractTurnId(payload)
        });
      }
    }
    return this.addEvent(taskId, type, payload);
  }

  markTaskCompletedFromReconcile(task, outcome = {}) {
    if (task.status === 'completed') {
      return task;
    }
    task.interruptDispatching = false;
    task.interruptRecovering = false;
    task.interruptRequested = false;
    task.interruptError = null;
    task.lastInterruptFailure = null;
    task.status = 'completed';
    task.error = null;
    task.result = task.result ?? {
      summary: '桌面会话已完成',
      changedFiles: [],
      tests: [],
      exitCode: 0
    };
    this.addEvent(task.id, 'task.interrupt.reconcile_confirmed', {
      status: 'completed',
      reason: outcome.reason ?? ''
    });
    this.addEvent(task.id, 'task.completed', task.result);
    return task;
  }

  createApproval(taskId, request) {
    const approval = {
      id: createId('approval'),
      taskId,
      status: 'pending',
      decision: null,
      command: request.command,
      reason: request.reason,
      risk: request.risk,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      resolve: null
    };

    const promise = new Promise((resolve) => {
      approval.resolve = resolve;
    });

    this.approvals.set(approval.id, approval);
    const task = this.tasks.get(taskId);
    task.status = 'waiting_approval';
    this.addEvent(taskId, 'approval.required', {
      approvalId: approval.id,
      command: approval.command,
      reason: approval.reason,
      risk: approval.risk
    });

    return promise;
  }

}

function extractThreadId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
    return payload.thread_id;
  }
  if (typeof payload.threadId === 'string') {
    return payload.threadId;
  }
  if (typeof payload.sessionId === 'string') {
    return payload.sessionId;
  }
  return '';
}

function extractTurnId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (typeof payload.turnId === 'string') {
    return payload.turnId;
  }
  if (typeof payload.turn_id === 'string') {
    return payload.turn_id;
  }
  if (typeof payload.activeTurnId === 'string') {
    return payload.activeTurnId;
  }
  if (payload.turn && typeof payload.turn === 'object' && typeof payload.turn.id === 'string') {
    return payload.turn.id;
  }
  return '';
}

function futureIso(timeoutMs) {
  return new Date(Date.now() + Math.max(0, Number(timeoutMs) || 0)).toISOString();
}

function compactReconcileOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return { status: 'unknown', reason: 'empty_outcome' };
  }
  return {
    status: String(outcome.status ?? 'unknown'),
    reason: String(outcome.reason ?? ''),
    message: String(outcome.message ?? '').slice(0, 300),
    turnId: extractTurnId(outcome)
  };
}

function isStrongInterruptedOutcomeForTask(task, outcome) {
  return isStrongTerminalOutcomeForTask(task, outcome, isInterruptedInterruptStatus);
}

function isStrongCompletedOutcomeForTask(task, outcome) {
  return isStrongTerminalOutcomeForTask(task, outcome, isCompletedInterruptStatus);
}

function isStrongTerminalOutcomeForTask(task, outcome, statusPredicate) {
  if (!task || !outcome || typeof outcome !== 'object') {
    return false;
  }
  const activeTurnId = String(task.activeCodexTurnId ?? '').trim();
  if (!activeTurnId) {
    return false;
  }
  const outcomeTurnId = extractTurnId(outcome);
  if (outcomeTurnId !== activeTurnId) {
    return false;
  }
  if (!statusPredicate(outcome.status ?? outcome.turn?.status ?? '')) {
    return false;
  }
  const requestedAt = Date.parse(String(task.interruptRequestedAt ?? ''));
  const observedAt = Date.parse(String(
    outcome.observedAt
      ?? outcome.interruptedAt
      ?? outcome.completedAt
      ?? outcome.updatedAt
      ?? outcome.message
      ?? ''
  ));
  return !Number.isFinite(requestedAt)
    || !Number.isFinite(observedAt)
    || observedAt >= requestedAt;
}

function isInterruptedInterruptStatus(status) {
  const normalized = String(status ?? '').toLowerCase().replace(/[-_ ]/g, '');
  return normalized === 'interrupted'
    || normalized === 'aborted'
    || normalized === 'cancelled'
    || normalized === 'canceled';
}

function isCompletedInterruptStatus(status) {
  const normalized = String(status ?? '').toLowerCase().replace(/[-_ ]/g, '');
  return normalized.length > 0
    && normalized !== 'interrupted'
    && normalized !== 'aborted'
    && normalized !== 'cancelled'
    && normalized !== 'canceled';
}

function buildTaskSubmissionKey(projectId, sessionId, submissionId) {
  if (!submissionId) {
    return '';
  }
  return `${String(projectId ?? '')}\u0000${sessionId ?? '__new_thread__'}\u0000${submissionId}`;
}

function isSafelyRetryableFailedSubmission(task) {
  if (task?.status !== 'failed') {
    return false;
  }
  return !task.events.some((event) => event.type === 'codex.app_server.turn.started');
}

function normalizeSessionId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function normalizeSessionFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    id: normalizeOptionalString(value.id),
    title: normalizeOptionalString(value.title),
    projectRoot: normalizeOptionalString(value.projectRoot),
    projectLabel: normalizeOptionalString(value.projectLabel),
    filePath: normalizeOptionalString(value.filePath),
    entryCount: Number.isFinite(Number(value.entryCount)) ? Number(value.entryCount) : null
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return '';
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : '';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
