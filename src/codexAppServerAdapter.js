import { serviceTierParams } from './sessionSettingsStore.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { extractLocalImageInputs } from './codexTurnInput.js';
import {
  buildSessionSnapshot,
  extractChangedFiles,
  extractLatestAgentMessage,
  findTurn,
  sanitize,
  summarizeThreadForEvent,
  summarizeTurnStatus,
  waitForTurnCompletion
} from './codexProtocolUtils.js';
import { resolveSafeProjectRoot } from './workspaceGuard.js';

export class CodexAppServerAdapter {
  constructor(options = {}) {
    this.client = options.client ?? new CodexAppServerClient(options);
    this.model = options.model ?? process.env.CODEX_BRIDGE_MODEL ?? '';
    this.sandbox = options.sandbox ?? process.env.CODEX_BRIDGE_SANDBOX ?? 'danger-full-access';
    this.approvalPolicy = options.approvalPolicy ?? process.env.CODEX_BRIDGE_APPROVAL_POLICY ?? 'never';
  }

  async run({ task, project, emit }) {
    const notifications = [];
    const onNotification = (message) => {
      notifications.push(message);
      emit('codex.app_server.notification', sanitize(message));
    };
    const onStderr = (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          emit('codex.app_server.stderr', { line });
        }
      }
    };

    this.client.on('notification', onNotification);
    this.client.on('stderr', onStderr);

    try {
      emit('codex.desktop_sync', {
        status: 'app_server',
        desktopLive: false,
        mode: task.codexSessionId ? 'resume' : 'new',
        message: '手机端已通过 Codex app-server 协议提交消息，使用桌面端同一套会话核心能力；当前 Windows 桌面窗口可能需要刷新/重新打开会话才能显示最新内容。',
        reason: 'Windows 桌面端的当前窗口通过 Electron 持有自己的 stdio app-server；桥接服务会独立启动 app-server 协议进程，无法直接注入已打开窗口的实时订阅。'
      });

      const thread = task.codexSessionId
        ? await this.resumeThread(task, project, emit)
        : await this.startThread(task, project, emit);

      emit('codex.app_server.thread.ready', {
        threadId: thread.id,
        sessionId: thread.sessionId,
        cwd: thread.cwd,
        status: thread.status
      });

      const turnResponse = await this.client.request('turn/start', {
        threadId: thread.id,
        input: [{
          type: 'text',
          text: task.prompt,
          text_elements: []
        }, ...extractLocalImageInputs(task.prompt)],
        approvalPolicy: this.approvalPolicy,
        model: this.taskModel(task),
        effort: normalizeReasoningEffort(task.reasoningEffort),
        ...serviceTierParams(task.serviceTier)
      });

      emit('codex.app_server.turn.started', sanitize(turnResponse));
      const completed = await waitForTurnCompletion({
        notifications,
        threadId: thread.id,
        turnId: turnResponse.turn?.id,
        timeoutMs: Number.parseInt(process.env.CODEX_BRIDGE_CODEX_TIMEOUT_MS ?? '900000', 10)
      });

      emit('codex.app_server.turn.completed', sanitize(completed));
      const detail = await this.client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true
      });
      emit('codex.app_server.thread.read', summarizeThreadForEvent(detail));
      const finalTurn = findTurn(detail.thread, completed.turn?.id) ?? completed.turn;
      const session = buildSessionSnapshot(detail.thread, {
        threadId: thread.id,
        prompt: task.prompt
      });
      return {
        summary: extractLatestAgentMessage(finalTurn) || summarizeTurnStatus(finalTurn),
        changedFiles: extractChangedFiles(finalTurn),
        tests: [],
        session,
        exitCode: 0,
        desktopSync: {
          status: 'app_server',
          desktopLive: false,
          mode: task.codexSessionId ? 'resume' : 'new'
        }
      };
    } finally {
      this.client.off('notification', onNotification);
      this.client.off('stderr', onStderr);
    }
  }

  taskModel(task = {}) {
    const requested = String(task?.model ?? '').trim();
    if (requested.length > 0) {
      return requested;
    }
    const fallback = this.model.trim();
    return fallback.length > 0 ? fallback : null;
  }

  async startThread(task, project, emit) {
    const cwd = resolveSafeProjectRoot(project, { action: 'Codex app-server 新建会话' });
    const response = await this.client.request('thread/start', {
      cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      model: this.taskModel(task),
      ...serviceTierParams(task.serviceTier),
      threadSource: 'user'
    });
    emit('codex.app_server.thread.started', summarizeThreadForEvent(response));
    return response.thread;
  }

  async resumeThread(task, project, emit) {
    const response = await this.client.request('thread/resume', {
      threadId: task.codexSessionId,
      cwd: null,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      model: this.taskModel(task),
      ...serviceTierParams(task.serviceTier)
    });
    emit('codex.app_server.thread.resumed', summarizeThreadForEvent(response));
    return response.thread;
  }
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return null;
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : null;
}
