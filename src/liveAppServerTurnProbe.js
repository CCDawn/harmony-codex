import { EventEmitter } from 'node:events';
import { ManagedCodexAppServerClient } from './managedCodexAppServerClient.js';

const TOOL_MARKER = 'CODEX_APP_SERVER_TOOL_OK';
const TURN_MARKER = 'CODEX_APP_SERVER_TURN_OK';

export async function runLiveAppServerTurnProbe(options = {}) {
  const client = options.client ?? new ManagedCodexAppServerClient(options);
  const cwd = String(options.cwd ?? process.cwd());
  const timeoutMs = Number(options.timeoutMs ?? 120_000);
  const journal = new ProtocolJournal({ client, timeoutMs });
  const startedAt = new Date().toISOString();
  const threadIds = [];
  const activeTurns = new Map();
  let report;

  journal.start();
  try {
    const firstConnection = await client.ensureStarted();
    const toolThread = await startProbeThread(client, cwd, 'on-request');
    threadIds.push(toolThread.id);

    const toolResponse = await client.request('turn/start', {
      threadId: toolThread.id,
      cwd: null,
      input: [{
        type: 'text',
        text: [
          '这是 Codex App Server 协议稳定性探针。',
          `请只执行一次 PowerShell 命令 \`Write-Output ${TOOL_MARKER}\`。`,
          '调用 shell_command 时必须设置 sandbox_permissions 为 require_escalated，并说明这是无害的协议审批测试。',
          '不得写文件，不得访问网络，不得执行其他命令。',
          `命令完成后最终仅回复 ${TURN_MARKER}。`
        ].join(''),
        text_elements: []
      }],
      approvalPolicy: 'on-request'
    });
    const toolTurnId = requireId(toolResponse?.turn?.id, 'turn/start did not return a tool turn id');
    activeTurns.set(toolThread.id, toolTurnId);

    const toolTerminal = await journal.waitForNotification((message) => (
      message.method === 'turn/completed'
      && notificationThreadId(message) === toolThread.id
      && notificationTurnId(message) === toolTurnId
    ));
    activeTurns.delete(toolThread.id);

    const toolStatus = terminalStatus(toolTerminal);
    const toolNotifications = journal.notificationsForTurn(toolThread.id, toolTurnId);
    const toolMethods = toolNotifications.map((message) => String(message.method ?? ''));
    const approvalEvidence = journal.approvalEvidenceForTurn(toolThread.id, toolTurnId);

    const secondConnection = await client.restart();
    const resumed = await client.request('thread/read', {
      threadId: toolThread.id,
      includeTurns: true
    });

    const interruptThread = await startProbeThread(client, cwd, 'never');
    threadIds.push(interruptThread.id);
    const interruptResponse = await client.request('turn/start', {
      threadId: interruptThread.id,
      cwd: null,
      input: [{
        type: 'text',
        text: [
          '这是 Codex App Server 中断协议探针。',
          '不要写文件，不要访问网络。',
          '请先等待一段时间再回答，最终仅回复不应被看到的 INTERRUPT_PROBE_FINISHED。'
        ].join(''),
        text_elements: []
      }],
      approvalPolicy: 'never'
    });
    const interruptTurnId = requireId(
      interruptResponse?.turn?.id,
      'turn/start did not return an interrupt turn id'
    );
    activeTurns.set(interruptThread.id, interruptTurnId);
    await journal.waitForNotification((message) => (
      message.method === 'turn/started'
      && notificationThreadId(message) === interruptThread.id
      && notificationTurnId(message) === interruptTurnId
    ));
    await client.request('turn/interrupt', {
      threadId: interruptThread.id,
      turnId: interruptTurnId
    });
    const interruptTerminal = await journal.waitForNotification((message) => (
      message.method === 'turn/completed'
      && notificationThreadId(message) === interruptThread.id
      && notificationTurnId(message) === interruptTurnId
    ));
    activeTurns.delete(interruptThread.id);

    const interruptStatus = terminalStatus(interruptTerminal);
    const checks = {
      initialize: {
        ok: Number(firstConnection?.generation ?? 0) === 1,
        generation: Number(firstConnection?.generation ?? 0)
      },
      toolTurn: {
        ok: toolStatus === 'completed'
          && hasStreamEvent(toolMethods)
          && toolNotifications.some(isToolNotification)
          && approvalEvidence.requests > 0
          && approvalEvidence.accepted > 0,
        threadId: toolThread.id,
        turnId: toolTurnId,
        status: toolStatus,
        streamEvents: toolMethods.filter(isStreamMethod).length,
        toolEvents: toolNotifications.filter(isToolNotification).length,
        approvalRequests: approvalEvidence.requests,
        approvalResponses: approvalEvidence.accepted,
        rejectedApprovalRequests: approvalEvidence.rejected,
        approvalDecisions: approvalEvidence.decisions,
        methods: [...new Set(toolMethods)]
      },
      reconnect: {
        ok: Number(secondConnection?.generation ?? 0) >= 2
          && resumed?.thread?.id === toolThread.id,
        generation: Number(secondConnection?.generation ?? 0),
        threadReadableAfterReconnect: resumed?.thread?.id === toolThread.id
      },
      interruptTurn: {
        ok: interruptStatus === 'interrupted',
        threadId: interruptThread.id,
        turnId: interruptTurnId,
        status: interruptStatus
      }
    };

    report = {
      ok: Object.values(checks).every((check) => check.ok),
      mode: 'live-controlled',
      startedAt,
      finishedAt: new Date().toISOString(),
      checks,
      capabilityEvidence: {
        send: checks.toolTurn.status ? 'live' : 'not-observed',
        stream: checks.toolTurn.streamEvents > 0 ? 'live' : 'not-observed',
        tools: checks.toolTurn.toolEvents > 0 ? 'live' : 'not-observed',
        approvals: checks.toolTurn.approvalResponses > 0
          ? 'live-accepted-safe-command'
          : 'not-observed',
        interrupt: checks.interruptTurn.ok ? 'live' : 'not-observed',
        reconnect: checks.reconnect.ok ? 'live' : 'not-observed'
      }
    };
  } catch (error) {
    report = {
      ok: false,
      mode: 'live-controlled',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error?.message ?? String(error),
      capabilityEvidence: journal.capabilityEvidence()
    };
  } finally {
    for (const [threadId, turnId] of activeTurns.entries()) {
      await journal.waitForNotification((message) => (
        message.method === 'turn/started'
        && notificationThreadId(message) === threadId
        && notificationTurnId(message) === turnId
      )).catch(() => {});
      await client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    }

    const archiveErrors = [];
    for (const threadId of threadIds) {
      try {
        await client.request('thread/archive', { threadId });
      } catch (error) {
        archiveErrors.push({
          threadId,
          error: error?.message ?? String(error)
        });
      }
    }
    journal.stop();
    await client.close().catch(() => {});

    report ??= {
      ok: false,
      mode: 'live-controlled',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: 'Live probe ended without a report'
    };
    report.cleanup = {
      archivedThreadIds: threadIds.filter((threadId) => (
        !archiveErrors.some((entry) => entry.threadId === threadId)
      )),
      errors: archiveErrors
    };
    if (archiveErrors.length > 0) {
      report.ok = false;
    }
  }

  return report;
}

async function startProbeThread(client, cwd, approvalPolicy) {
  const response = await client.request('thread/start', {
    cwd,
    approvalPolicy,
    sandbox: 'read-only',
    model: null,
    threadSource: 'user'
  });
  const id = requireId(response?.thread?.id, 'thread/start did not return thread.id');
  return { ...response.thread, id };
}

class ProtocolJournal extends EventEmitter {
  constructor({ client, timeoutMs }) {
    super();
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.notifications = [];
    this.approvals = [];
    this.waiters = [];
    this.started = false;
    this.onNotification = (message) => this.recordNotification(message);
    this.onServerRequest = (message) => this.handleServerRequest(message);
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.on('notification', this.onNotification);
    this.client.on('serverRequest', this.onServerRequest);
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.client.off('notification', this.onNotification);
    this.client.off('serverRequest', this.onServerRequest);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Protocol journal stopped'));
    }
    this.waiters = [];
  }

  recordNotification(message) {
    this.notifications.push(message);
    this.resolveWaiters();
  }

  handleServerRequest(message) {
    const method = String(message?.method ?? '');
    const threadId = notificationThreadId(message);
    const turnId = notificationTurnId(message);
    const approval = {
      id: message?.id,
      method,
      threadId,
      turnId,
      decision: 'rejected',
      command: flattenCommand(message?.params?.command)
    };

    if (isApprovalMethod(method) && isAllowedProbeCommand(message?.params?.command)) {
      this.client.respond(message.id, { decision: 'accept' });
      approval.decision = 'accepted';
    } else if (isApprovalMethod(method)) {
      this.client.respond(message.id, { decision: 'decline' });
    } else {
      this.client.respond(message.id, null, {
        code: -32601,
        message: `Unsupported live probe server request: ${method}`
      });
    }
    this.approvals.push(approval);
  }

  waitForNotification(predicate) {
    const existing = this.notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for app-server notification after ${this.timeoutMs}ms`));
        }, this.timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      const match = this.notifications.find(waiter.predicate);
      if (!match) {
        continue;
      }
      clearTimeout(waiter.timeout);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(match);
    }
  }

  notificationsForTurn(threadId, turnId) {
    return this.notifications
      .filter((message) => (
        notificationThreadId(message) === threadId
        && (
          notificationTurnId(message) === turnId
          || notificationTurnId(message) === ''
        )
      ));
  }

  approvalEvidenceForTurn(threadId, turnId) {
    const matches = this.approvals.filter((approval) => (
      approval.threadId === threadId && approval.turnId === turnId
    ));
    return {
      requests: matches.length,
      accepted: matches.filter((approval) => approval.decision === 'accepted').length,
      rejected: matches.filter((approval) => approval.decision !== 'accepted').length,
      decisions: matches.map((approval) => ({
        method: approval.method,
        decision: approval.decision,
        command: approval.command
      }))
    };
  }

  capabilityEvidence() {
    const methods = this.notifications.map((message) => String(message?.method ?? ''));
    return {
      send: methods.includes('turn/started') ? 'live' : 'not-observed',
      stream: hasStreamEvent(methods) ? 'live' : 'not-observed',
      tools: this.notifications.some(isToolNotification) ? 'live' : 'not-observed',
      approvals: this.approvals.some((approval) => approval.decision === 'accepted')
        ? 'live-accepted-safe-command'
        : 'not-observed',
      interrupt: this.notifications.some((message) => terminalStatus(message) === 'interrupted')
        ? 'live'
        : 'not-observed',
      reconnect: 'not-observed'
    };
  }
}

function isAllowedProbeCommand(command) {
  const text = flattenCommand(command);
  if (!text) {
    return false;
  }
  if (isKnownPowerShellProbeWrapper(text)) {
    return true;
  }
  if (/[;&|><`\r\n]|\$\(/.test(text)) {
    return false;
  }
  const tokens = text
    .replace(/["']/g, '')
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase());
  const allowed = new Set([
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    '-noprofile',
    '-command',
    'write-output',
    TOOL_MARKER.toLowerCase()
  ]);
  return tokens.includes('write-output')
    && tokens.filter((token) => token === TOOL_MARKER.toLowerCase()).length === 1
    && tokens.every((token) => allowed.has(token));
}

function isKnownPowerShellProbeWrapper(command) {
  const normalized = String(command).replace(/\r\n/g, '\n').trim();
  const executable = String.raw`(?:"[^"\r\n]*\\(?:pwsh|powershell)\.exe"|(?:pwsh|powershell)(?:\.exe)?)`;
  const currentWrapper = new RegExp(
    `^${executable} -Command 'Write-Output ${TOOL_MARKER}'$`,
    'i'
  );
  if (currentWrapper.test(normalized)) {
    return true;
  }
  const utf8Prelude = String.raw`try \{ \[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8 \} catch \{\}\n`;
  const expression = new RegExp(
    `^${executable} -NoProfile -Command "(?:${utf8Prelude})?Write-Output ${TOOL_MARKER}"$`,
    'i'
  );
  return expression.test(normalized);
}

function flattenCommand(command) {
  if (Array.isArray(command)) {
    return command.flat(Infinity).map((part) => String(part)).join(' ');
  }
  return String(command ?? '');
}

function notificationThreadId(message) {
  return String(
    message?.params?.threadId
    ?? message?.params?.thread_id
    ?? message?.params?.turn?.threadId
    ?? message?.params?.turn?.thread_id
    ?? ''
  );
}

function notificationTurnId(message) {
  return String(
    message?.params?.turnId
    ?? message?.params?.turn_id
    ?? message?.params?.turn?.id
    ?? ''
  );
}

function terminalStatus(message) {
  return String(message?.params?.turn?.status ?? message?.params?.status ?? '');
}

function isStreamMethod(method) {
  const normalized = String(method).toLowerCase();
  return normalized.includes('agentmessage/delta')
    || normalized.includes('reasoning/')
    || normalized.endsWith('/textdelta');
}

function hasStreamEvent(methods) {
  return methods.some(isStreamMethod);
}

function isToolMethod(method) {
  const normalized = String(method).toLowerCase();
  return normalized.includes('commandexecution')
    || normalized.includes('filechange')
    || normalized.includes('mcptoolcall')
    || normalized.includes('dynamictoolcall');
}

function isToolNotification(message) {
  if (isToolMethod(message?.method)) {
    return true;
  }
  const itemType = String(
    message?.params?.item?.type
    ?? message?.params?.itemType
    ?? message?.params?.type
    ?? ''
  ).toLowerCase();
  return itemType === 'commandexecution'
    || itemType === 'filechange'
    || itemType === 'mcptoolcall'
    || itemType === 'dynamictoolcall';
}

function isApprovalMethod(method) {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval';
}

function requireId(value, message) {
  const id = String(value ?? '');
  if (!id) {
    throw new Error(message);
  }
  return id;
}

