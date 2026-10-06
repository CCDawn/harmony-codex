import { EventEmitter } from 'node:events';
import { readRecentDesktopThread } from './desktopRecentThread.js';

export class DesktopScriptBridge extends EventEmitter {
  async readRecentThread(threadId, options = {}) {
    return readRecentDesktopThread(this, threadId, options);
  }

  constructor(options = {}) {
    super();
    this.hostId = options.hostId ?? process.env.CODEX_DESKTOP_HOST_ID ?? 'local';
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? Number.parseInt(process.env.CODEX_DESKTOP_SCRIPT_REQUEST_TIMEOUT_MS ?? '30000', 10);
    this.pollTimeoutMs = options.pollTimeoutMs
      ?? Number.parseInt(process.env.CODEX_DESKTOP_SCRIPT_POLL_TIMEOUT_MS ?? '25000', 10);
    this.commandCircuitBreakerMs = options.commandCircuitBreakerMs
      ?? Number.parseInt(process.env.CODEX_DESKTOP_SCRIPT_COMMAND_CIRCUIT_MS ?? '60000', 10);
    this.scriptId = null;
    this.currentSessionId = null;
    this.lastSeenAt = 0;
    this.lastCommandResponseAt = 0;
    this.lastCommandFailureAt = 0;
    this.lastCommandFailureMessage = '';
    this.commandCircuitOpenUntil = 0;
    this.pendingCommands = [];
    this.pendingResponses = new Map();
    this.pendingFetchResponses = new Map();
    this.activePolls = new Map();
    this.notifications = [];
    this.nextRequestId = 1;
    this.nextFetchRequestId = 1;
    this.scriptTokenPresent = null;
    this.unauthorizedCount = 0;
    this.lastUnauthorizedAt = 0;
    this.lastUnauthorizedRoute = '';
  }

  isOnline() {
    return this.scriptId !== null && Date.now() - this.lastSeenAt < 45000;
  }

  isCommandChannelHealthy() {
    return Date.now() >= this.commandCircuitOpenUntil;
  }

  getStatus(targetSessionId = '') {
    const online = this.isOnline();
    const currentSessionId = online ? this.currentSessionId : null;
    if (!online) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId,
        sessionVerified: false,
        message: '桌面脚本桥未连接，手机端不能直接投递到当前桌面会话。',
        reason: this.scriptId ? 'desktop script heartbeat timeout' : 'desktop script not connected',
        checkedAt: new Date().toISOString()
      };
    }
    if (!this.isCommandChannelHealthy()) {
      return {
        ok: true,
        desktopLive: false,
        status: 'degraded',
        currentSessionId,
        targetSessionId,
        sessionVerified: false,
        commandChannelHealthy: false,
        commandCircuitOpenUntil: new Date(this.commandCircuitOpenUntil).toISOString(),
        message: '桌面脚本桥在线，但 app-server 命令通道刚刚超时，已临时熔断，避免吞消息。',
        reason: `desktop script command channel timeout: ${this.lastCommandFailureMessage || 'unknown'}`,
        checkedAt: new Date().toISOString()
      };
    }
    if (targetSessionId) {
      if (!currentSessionId) {
        return {
          ok: true,
          desktopLive: true,
          status: 'unverified',
          currentSessionId: null,
          targetSessionId,
          sessionVerified: false,
          message: '桌面脚本桥已连接，但无法确认桌面当前会话，已阻止直接发送。',
          checkedAt: new Date().toISOString()
        };
      }
      if (currentSessionId !== targetSessionId) {
        return {
          ok: true,
          desktopLive: true,
          status: 'mismatch',
          currentSessionId,
          targetSessionId,
          sessionVerified: false,
          message: '桌面当前会话与手机选择的会话不一致，已阻止发送以避免串线。',
          checkedAt: new Date().toISOString()
        };
      }
      return {
        ok: true,
        desktopLive: true,
        status: 'verified',
        currentSessionId,
        targetSessionId,
        sessionVerified: true,
        message: '已校验：桌面当前会话与手机选择会话一致，可以实时发送。',
        checkedAt: new Date().toISOString()
      };
    }
    return {
      ok: true,
      desktopLive: true,
      status: 'ready',
      currentSessionId,
      targetSessionId,
      sessionVerified: false,
      message: '桌面脚本桥已连接',
      checkedAt: new Date().toISOString()
    };
  }

  snapshot(options = {}) {
    const authRequired = options.authRequired === true;
    const online = this.isOnline();
    const recentUnauthorized = this.lastUnauthorizedAt > 0 && Date.now() - this.lastUnauthorizedAt < 120000;
    const scriptAuthHealthy = !authRequired
      || (
        (!online || this.scriptTokenPresent === true)
        && !recentUnauthorized
      );
    return {
      ok: true,
      online,
      scriptId: this.scriptId,
      currentSessionId: online ? this.currentSessionId : null,
      lastSeenAt: this.lastSeenAt > 0 ? new Date(this.lastSeenAt).toISOString() : null,
      pendingCommandCount: this.pendingCommands.length,
      pendingResponseCount: this.pendingResponses.size,
      notificationCount: this.notifications.length,
      commandChannelHealthy: this.isCommandChannelHealthy(),
      commandCircuitOpenUntil: this.commandCircuitOpenUntil > Date.now()
        ? new Date(this.commandCircuitOpenUntil).toISOString()
        : null,
      lastCommandResponseAt: this.lastCommandResponseAt > 0 ? new Date(this.lastCommandResponseAt).toISOString() : null,
      lastCommandFailureAt: this.lastCommandFailureAt > 0 ? new Date(this.lastCommandFailureAt).toISOString() : null,
      lastCommandFailureMessage: this.lastCommandFailureMessage || null,
      scriptAuth: {
        required: authRequired,
        otpRequired: options.otpRequired === true,
        clientTokenEmbedded: options.clientTokenEmbedded === true,
        scriptTokenPresent: this.scriptTokenPresent === true,
        healthy: scriptAuthHealthy,
        recentUnauthorized,
        unauthorizedCount: this.unauthorizedCount,
        lastUnauthorizedAt: this.lastUnauthorizedAt > 0 ? new Date(this.lastUnauthorizedAt).toISOString() : null,
        lastUnauthorizedRoute: this.lastUnauthorizedRoute || null
      },
      checkedAt: new Date().toISOString()
    };
  }

  connect({ scriptId, currentSessionId, tokenPresent }, options = {}) {
    const replace = options.replace ?? false;
    const nextScriptId = normalizeString(scriptId) || this.scriptId || `script-${Date.now()}`;
    if (this.scriptId && nextScriptId !== this.scriptId && this.isOnline() && !replace) {
      return {
        ok: false,
        stale: true,
        scriptId: nextScriptId,
        activeScriptId: this.scriptId,
        hostId: this.hostId,
        currentSessionId: this.currentSessionId,
        checkedAt: new Date().toISOString()
      };
    }
    if (this.scriptId && nextScriptId !== this.scriptId) {
      for (const poll of this.activePolls.values()) {
        poll.finish([]);
      }
      this.activePolls.clear();
    }
    if (!this.scriptId || nextScriptId !== this.scriptId || replace) {
      this.resetCommandCircuit();
    }
    this.scriptId = nextScriptId;
    this.currentSessionId = normalizeSessionId(currentSessionId);
    if (tokenPresent !== undefined) {
      this.scriptTokenPresent = tokenPresent === true;
      if (this.scriptTokenPresent) {
        this.lastUnauthorizedAt = 0;
        this.lastUnauthorizedRoute = '';
      }
    }
    this.lastSeenAt = Date.now();
    return {
      ok: true,
      scriptId: this.scriptId,
      hostId: this.hostId,
      currentSessionId: this.currentSessionId,
      tokenPresent: this.scriptTokenPresent === true,
      checkedAt: new Date().toISOString()
    };
  }

  updateStatus({ scriptId, currentSessionId, tokenPresent }) {
    const connected = this.connect({ scriptId, currentSessionId, tokenPresent });
    if (connected.stale) {
      return connected;
    }
    return this.getStatus('');
  }

  async poll({ scriptId, currentSessionId, tokenPresent }) {
    const connected = this.connect({ scriptId, currentSessionId, tokenPresent });
    if (connected.stale) {
      await delay(this.pollTimeoutMs);
      return [];
    }
    if (this.pendingCommands.length > 0) {
      return this.pendingCommands.splice(0, 20);
    }
    const pollKey = this.scriptId ?? normalizeString(scriptId) ?? 'default';
    const previousPoll = this.activePolls.get(pollKey);
    if (previousPoll) {
      previousPoll.finish([]);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve([]);
      }, this.pollTimeoutMs);
      const onCommands = () => {
        cleanup();
        resolve(this.pendingCommands.splice(0, 20));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('commands', onCommands);
        if (this.activePolls.get(pollKey)?.cleanup === cleanup) {
          this.activePolls.delete(pollKey);
        }
      };
      this.activePolls.set(pollKey, {
        cleanup,
        finish(value) {
          cleanup();
          resolve(value);
        }
      });
      this.on('commands', onCommands);
    });
  }

  receiveMessages({ scriptId, currentSessionId, tokenPresent, messages = [] }) {
    const connected = this.connect({ scriptId, currentSessionId, tokenPresent });
    if (connected.stale) {
      return { ok: false, stale: true, received: 0 };
    }
    for (const message of Array.isArray(messages) ? messages : []) {
      this.receiveMessage(message);
    }
    return { ok: true, received: Array.isArray(messages) ? messages.length : 0 };
  }

  reset() {
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('桌面脚本桥已重置'));
    }
    for (const pending of this.pendingFetchResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('桌面脚本桥已重置'));
    }
    this.scriptId = null;
    this.currentSessionId = null;
    this.scriptTokenPresent = null;
    this.lastSeenAt = 0;
    this.pendingCommands = [];
    for (const poll of this.activePolls.values()) {
      poll.finish([]);
    }
    this.activePolls.clear();
    this.pendingResponses.clear();
    this.pendingFetchResponses.clear();
    this.notifications = [];
    this.unauthorizedCount = 0;
    this.lastUnauthorizedAt = 0;
    this.lastUnauthorizedRoute = '';
    this.resetCommandCircuit();
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  recordUnauthorized(route) {
    this.unauthorizedCount += 1;
    this.lastUnauthorizedAt = Date.now();
    this.lastUnauthorizedRoute = normalizeString(route);
  }

  receiveMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'mcp-response') {
      const requestId = message.message?.id;
      const pending = this.pendingResponses.get(requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(requestId);
      this.markCommandSuccess();
      if (message.message?.error) {
        pending.reject(new Error(message.message.error.message ?? '桌面脚本桥 app-server 请求失败'));
      } else {
        pending.resolve(message.message?.result ?? null);
      }
      return;
    }
    if (message.type === 'fetch-response') {
      const requestId = message.requestId;
      const pending = this.pendingFetchResponses.get(requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingFetchResponses.delete(requestId);
      this.markCommandSuccess();
      if (message.responseType === 'success') {
        try {
          pending.resolve(parseHostFetchBody(message.bodyJsonString));
        } catch (error) {
          pending.reject(error);
        }
      } else {
        pending.reject(new Error(message.error || message.bodyJsonString || '桌面脚本桥 Host 命令失败'));
      }
      return;
    }
    if (message.type === 'mcp-notification') {
      this.notifications.push({
        at: Date.now(),
        hostId: message.hostId ?? this.hostId,
        method: message.method,
        params: message.params
      });
      if (this.notifications.length > 1000) {
        this.notifications.splice(0, this.notifications.length - 1000);
      }
    }
  }

  request(method, params = {}) {
    if (!this.isOnline()) {
      throw new Error('桌面脚本桥未连接');
    }
    if (!this.isCommandChannelHealthy()) {
      const error = new Error(`桌面脚本桥命令通道已临时熔断，拒绝发送：${method}`);
      error.code = 'DESKTOP_SCRIPT_COMMAND_CHANNEL_DEGRADED';
      error.method = method;
      throw error;
    }
    const request = {
      id: `desktop-script-${Date.now()}-${this.nextRequestId++}`,
      method,
      params
    };
    const command = {
      type: 'mcp-request',
      hostId: this.hostId,
      request
    };
    this.pendingCommands.push(command);
    this.emit('commands');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        const error = new Error(`等待桌面脚本桥 app-server 响应超时：${method}`);
        error.code = 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT';
        error.method = method;
        error.requestId = request.id;
        error.scriptId = this.scriptId;
        error.currentSessionId = this.currentSessionId;
        this.markCommandFailure(error);
        reject(error);
      }, this.requestTimeoutMs);
      this.pendingResponses.set(request.id, { resolve, reject, timeout });
    });
  }

  fetchFromHost(command, params = {}) {
    if (!this.isOnline()) {
      throw new Error('桌面脚本桥未连接');
    }
    if (!this.isCommandChannelHealthy()) {
      const error = new Error(`桌面脚本桥命令通道已临时熔断，拒绝发送 Host 命令：${command}`);
      error.code = 'DESKTOP_SCRIPT_COMMAND_CHANNEL_DEGRADED';
      error.command = command;
      throw error;
    }
    const requestId = `desktop-script-fetch-${Date.now()}-${this.nextFetchRequestId++}`;
    const message = {
      type: 'fetch',
      requestId,
      method: 'POST',
      url: `vscode://codex/${command}`,
      body: JSON.stringify(params)
    };
    this.pendingCommands.push(message);
    this.emit('commands');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingFetchResponses.delete(requestId);
        const error = new Error(`等待桌面脚本桥 Host 命令响应超时：${command}`);
        error.code = 'DESKTOP_SCRIPT_HOST_TIMEOUT';
        error.command = command;
        error.requestId = requestId;
        error.scriptId = this.scriptId;
        error.currentSessionId = this.currentSessionId;
        this.markCommandFailure(error);
        reject(error);
      }, this.requestTimeoutMs);
      this.pendingFetchResponses.set(requestId, { resolve, reject, timeout });
    });
  }

  async drainNotifications() {
    const items = this.notifications.splice(0);
    return items.filter((notification) => notification.hostId === this.hostId);
  }

  markCommandSuccess() {
    this.lastCommandResponseAt = Date.now();
    this.commandCircuitOpenUntil = 0;
    this.lastCommandFailureMessage = '';
  }

  markCommandFailure(error) {
    this.lastCommandFailureAt = Date.now();
    this.lastCommandFailureMessage = error?.message ?? String(error);
    this.commandCircuitOpenUntil = Date.now() + Math.max(1000, this.commandCircuitBreakerMs);
  }

  resetCommandCircuit() {
    this.commandCircuitOpenUntil = 0;
    this.lastCommandFailureAt = 0;
    this.lastCommandFailureMessage = '';
  }
}

export const desktopScriptBridge = new DesktopScriptBridge();

function normalizeSessionId(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  return text.startsWith('local:') ? text.slice('local:'.length) : text;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHostFetchBody(value) {
  if (value == null || value === '') {
    return null;
  }
  return JSON.parse(value);
}
