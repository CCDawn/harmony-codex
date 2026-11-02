import {
  buildDesktopCdpWebSocketOptions,
  getCdpTargets,
  selectCodexDesktopCdpTarget
} from '../src/codexDesktopCdpClient.js';

const bridgeUrl = (process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
const cdpPort = Number.parseInt(process.env.CODEX_DESKTOP_CDP_PORT ?? '9229', 10);
const heartbeatMs = Number.parseInt(process.env.CODEX_DESKTOP_CDP_HEARTBEAT_MS ?? '3000', 10);
const drainMs = Number.parseInt(process.env.CODEX_DESKTOP_CDP_DRAIN_MS ?? '1000', 10);
const maxSoftFailures = Number.parseInt(process.env.CODEX_DESKTOP_CDP_SOFT_FAILURES ?? '3', 10);

const authHeaders = token ? { 'X-Codex-Bridge-Token': token } : {};

async function main() {
  await assertBridgeAuthCompatible();
  let stopped = false;
  const state = {
    reconnectRequested: false,
    reconnectReason: null,
    lastStatus: null,
    consecutiveCdpFailures: 0,
    loopFailures: new Map()
  };
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });

  while (!stopped) {
    state.reconnectRequested = false;
    state.reconnectReason = null;
    let client = null;
    try {
      const target = await waitForTarget();
      client = await CdpClient.connect(target.webSocketDebuggerUrl);
      await enableRuntimeIfAvailable(client);
      await installPageBridge(client);
      const status = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      state.lastStatus = status;
      state.consecutiveCdpFailures = 0;
      const connected = await post('/desktop/script/connect', withAuthStatus(status));
      await updatePageRemoteStatus(client, connected);
      console.log(JSON.stringify({ ok: true, status }, null, 2));

      const cycle = Promise.race([
        heartbeatLoop(client, () => stopped || state.reconnectRequested, state),
        drainLoop(client, () => stopped || state.reconnectRequested, state),
        pollLoop(client, () => stopped || state.reconnectRequested, state)
      ]);
      await cycle;
    } catch (error) {
      if (!stopped) {
        state.reconnectReason = state.reconnectReason || error;
        console.warn('[desktop-cdp-live-host] reconnecting:', state.reconnectReason.message);
      }
    } finally {
      client?.close();
    }

    if (!stopped && (state.reconnectRequested || state.reconnectReason)) {
      await sleep(1000);
    }
  }
}

async function enableRuntimeIfAvailable(client) {
  try {
    await client.call('Runtime.enable', {}, 3000);
  } catch (error) {
    console.warn('[desktop-cdp-live-host] Runtime.enable skipped:', error.message);
  }
}

function requestReconnect(state, error) {
  if (error) {
    state.reconnectReason = state.reconnectReason || error;
  }
  state.reconnectRequested = true;
}

function noteLoopSuccess(state, label = null) {
  state.consecutiveCdpFailures = 0;
  if (label) {
    state.loopFailures.delete(label);
  }
}

function handleLoopFailure(state, label, error) {
  state.consecutiveCdpFailures += 1;
  const failures = (state.loopFailures.get(label) ?? 0) + 1;
  state.loopFailures.set(label, failures);
  if (failures === 1 || failures % 5 === 0) {
    console.warn(`[desktop-cdp-live-host] ${label} failed (${failures}/${maxSoftFailures}):`, error.message);
  }
  if (failures >= maxSoftFailures) {
    requestReconnect(state, error);
    return true;
  }
  return false;
}

function loopBackoffMs(state) {
  return Math.min(5000, Math.max(500, state.consecutiveCdpFailures * 1000));
}

async function heartbeatLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const status = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      state.lastStatus = status;
      noteLoopSuccess(state, 'heartbeat');
      const remoteStatus = await post('/desktop/script/status', withAuthStatus(status));
      await updatePageRemoteStatus(client, remoteStatus);
    } catch (error) {
      if (handleLoopFailure(state, 'heartbeat', error)) return;
      await sleep(loopBackoffMs(state));
    }
    await sleep(heartbeatMs);
  }
}

async function drainLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const payload = await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.drainMessages(10)');
      state.lastStatus = stripMessages(payload);
      noteLoopSuccess(state, 'drain');
      if (payload?.messages?.length > 0) {
        await post('/desktop/script/messages', withAuthStatus(payload));
      }
    } catch (error) {
      if (handleLoopFailure(state, 'drain', error)) return;
      await sleep(loopBackoffMs(state));
    }
    await sleep(drainMs);
  }
}

async function pollLoop(client, isStopped, state) {
  while (!isStopped()) {
    try {
      const status = state.lastStatus
        ?? await evaluatePage(client, 'window.__codexHramonyDesktopCdpHost.status()');
      const result = await post('/desktop/script/poll', withAuthStatus(status), 35000);
      const commands = Array.isArray(result.commands) ? result.commands : [];
      for (const command of commands) {
        const dispatched = await dispatchCommand(client, command);
        if (!dispatched) {
          const error = new Error('桌面 CDP host 派发命令失败');
          if (handleLoopFailure(state, 'dispatch', error)) return;
        }
      }
      noteLoopSuccess(state, 'poll');
    } catch (error) {
      if (handleLoopFailure(state, 'poll', error)) return;
      await sleep(loopBackoffMs(state));
    }
  }
}

async function dispatchCommand(client, command) {
  const expression = `window.__codexHramonyDesktopCdpHost.dispatch(${JSON.stringify(command)})`;
  let result = null;
  try {
    result = await evaluatePage(client, expression);
  } catch (error) {
    await postCommandError(command, error instanceof Error ? error.message : String(error));
    return false;
  }
  if (!result?.ok) {
    const errorMessage = result?.error ?? '桌面 CDP host 派发命令失败';
    await postCommandError(command, errorMessage, result);
    return false;
  }
  return true;
}

async function updatePageRemoteStatus(client, payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const expression = `window.__codexHramonyDesktopCdpHost?.updateRemoteStatus?.(${JSON.stringify(payload)})`;
  try {
    await evaluatePage(client, expression, 3000);
  } catch (error) {
    console.warn('[desktop-cdp-live-host] status badge update skipped:', error.message);
  }
}

async function postCommandError(command, errorMessage, result = null) {
  await post('/desktop/script/messages', withAuthStatus({
    scriptId: result?.scriptId ?? `desktop-cdp-host-${Date.now()}`,
    currentSessionId: result?.currentSessionId ?? null,
    messages: [buildCommandErrorMessage(command, errorMessage)]
  }));
}

function stripMessages(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const { messages, ...status } = payload;
  return status;
}

function buildCommandErrorMessage(command, errorMessage) {
  if (command?.type === 'fetch') {
    return {
      type: 'fetch-response',
      requestId: command.requestId,
      hostId: command.hostId,
      responseType: 'error',
      error: errorMessage
    };
  }
  return {
    type: 'mcp-response',
    requestId: command?.requestId,
    hostId: command?.hostId,
    message: command?.request ? {
      id: command.request.id,
      error: { code: 1, message: errorMessage }
    } : undefined,
    responseType: 'error',
    error: errorMessage
  };
}

async function assertBridgeAuthCompatible() {
  try {
    const response = await fetch(`${bridgeUrl}/health`, {
      headers: authHeaders
    });
    if (response.status === 401 && !token.trim()) {
      throw new Error('bridge requires CODEX_BRIDGE_TOKEN, but desktop live-host was started without one');
    }
    if (!response.ok && response.status !== 404) {
      console.warn('[desktop-cdp-live-host] bridge health probe warning:', response.status, await response.text().catch(() => ''));
    }
  } catch (error) {
    if (/requires CODEX_BRIDGE_TOKEN/.test(error?.message ?? '')) {
      throw error;
    }
    console.warn('[desktop-cdp-live-host] bridge auth probe skipped:', error?.message ?? String(error));
  }
}

function withAuthStatus(payload) {
  return {
    ...(payload && typeof payload === 'object' ? payload : {}),
    tokenPresent: token.trim().length > 0
  };
}

async function installPageBridge(client) {
  const source = `
(() => {
  if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== 'function') {
    throw new Error('当前页面不是 Codex 桌面窗口，找不到 electronBridge.sendMessageFromView');
  }
  if (window.__codexHramonyDesktopCdpHost?.stop) {
    window.__codexHramonyDesktopCdpHost.stop();
  }
  const state = {
    stopped: false,
    scriptId: 'desktop-cdp-host-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    queue: [],
    remoteStatus: null,
    badgeRoot: null,
    badgeStyle: null
  };
  function extractConversationId(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const normalized = value.startsWith('#') ? value.slice(1) : value;
    const withoutQuery = normalized.split('?')[0].split('#')[0].replace(/\\/+$/, '');
    const match = withoutQuery.match(/^\\/(?:local|remote)\\/([^/]+)$/)
      || withoutQuery.match(/^\\/hotkey-window\\/thread\\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function currentSessionId() {
    return extractConversationId(window.location.pathname)
      || extractConversationId(window.location.hash)
      || extractConversationId(new URL(window.location.href).pathname)
      || null;
  }
  function status(extra = {}) {
    return { scriptId: state.scriptId, currentSessionId: currentSessionId(), ...extra };
  }
  function shortId(value) {
    if (typeof value !== 'string' || value.length === 0) return '无';
    return value.length > 14 ? value.slice(0, 8) + '...' + value.slice(-4) : value;
  }
  function relativeTime(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '刚刚';
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return seconds + ' 秒前';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    const hours = Math.round(minutes / 60);
    return hours + ' 小时前';
  }
  function pickRemoteStatus() {
    const payload = state.remoteStatus;
    if (!payload || typeof payload !== 'object') return null;
    return payload.desktop || payload.bridge || payload;
  }
  function statusViewModel() {
    const remote = pickRemoteStatus();
    const local = status({ stopped: state.stopped });
    if (state.stopped) {
      return {
        tone: 'offline',
        label: '远程已停止',
        message: '桌面注入脚本已停止',
        local,
        remote
      };
    }
    if (!remote) {
      return {
        tone: 'pending',
        label: '远程注入中',
        message: '已注入桌面脚本，等待 bridge 首次回传状态',
        local,
        remote
      };
    }
    if (remote.stale) {
      return {
        tone: 'offline',
        label: '远程旧实例',
        message: 'bridge 拒绝了旧注入实例，等待重新连接',
        local,
        remote
      };
    }
    const statusText = remote.status || (remote.online === true ? 'ready' : '');
    if (statusText === 'verified') {
      return { tone: 'ok', label: '会话已校验', message: remote.message || '桌面当前会话与手机选择会话一致', local, remote };
    }
    if (statusText === 'ready' || remote.desktopLive === true || remote.online === true) {
      return { tone: 'ok', label: '远程在线', message: remote.message || '桌面实时通道在线', local, remote };
    }
    if (statusText === 'unverified') {
      return { tone: 'warn', label: '会话未确认', message: remote.message || '无法确认桌面当前会话', local, remote };
    }
    if (statusText === 'mismatch') {
      return { tone: 'warn', label: '会话不一致', message: remote.message || '桌面当前会话与手机选择会话不一致', local, remote };
    }
    if (statusText === 'degraded') {
      return { tone: 'offline', label: '命令通道异常', message: remote.message || remote.reason || '命令通道已熔断', local, remote };
    }
    if (statusText === 'unavailable' || remote.online === false) {
      return { tone: 'offline', label: '远程断开', message: remote.message || remote.reason || '桌面实时通道离线', local, remote };
    }
    return { tone: 'pending', label: '状态同步中', message: remote.message || '等待更完整的远程状态', local, remote };
  }
  function ensureBadge() {
    if (state.badgeRoot?.isConnected) return state.badgeRoot;
    const doc = document;
    const style = doc.createElement('style');
    style.id = 'codex-hramony-remote-status-style';
    style.textContent = \`
      #codex-hramony-remote-status {
        position: fixed;
        top: max(10px, env(safe-area-inset-top, 0px));
        left: max(360px, calc(env(safe-area-inset-left, 0px) + 360px));
        z-index: 9999;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #172033;
        pointer-events: auto;
      }
      #codex-hramony-remote-status .chr-pill {
        border: 1px solid rgba(125, 139, 163, 0.28);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        min-height: 28px;
        max-width: 86px;
        padding: 0 10px 0 9px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        font-weight: 650;
        line-height: 1;
      }
      #codex-hramony-remote-status .chr-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #codex-hramony-remote-status .chr-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--chr-color, #8a94a6);
        box-shadow: 0 0 0 4px var(--chr-glow, rgba(138, 148, 166, 0.14));
        flex: none;
      }
      #codex-hramony-remote-status .chr-detail {
        position: absolute;
        top: 34px;
        left: 0;
        width: 260px;
        max-height: min(240px, calc(100vh - 54px));
        overflow: auto;
        margin-top: 0;
        padding: 10px 12px;
        border: 1px solid rgba(125, 139, 163, 0.22);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        display: none;
        font-size: 12px;
        line-height: 1.55;
      }
      #codex-hramony-remote-status:hover .chr-detail {
        display: block;
      }
      #codex-hramony-remote-status .chr-message {
        margin-bottom: 8px;
        color: #334155;
        font-weight: 600;
      }
      #codex-hramony-remote-status .chr-row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        border-top: 1px solid rgba(148, 163, 184, 0.18);
        padding-top: 6px;
        margin-top: 6px;
      }
      #codex-hramony-remote-status .chr-key {
        color: #64748b;
        white-space: nowrap;
      }
      #codex-hramony-remote-status .chr-value {
        color: #0f172a;
        text-align: right;
        overflow-wrap: anywhere;
      }
      #codex-hramony-remote-status.chr-ok { --chr-color: #16a34a; --chr-glow: rgba(22, 163, 74, 0.16); }
      #codex-hramony-remote-status.chr-warn { --chr-color: #d97706; --chr-glow: rgba(217, 119, 6, 0.17); }
      #codex-hramony-remote-status.chr-offline { --chr-color: #dc2626; --chr-glow: rgba(220, 38, 38, 0.16); }
      #codex-hramony-remote-status.chr-pending { --chr-color: #64748b; --chr-glow: rgba(100, 116, 139, 0.15); }
    \`;
    const root = doc.createElement('div');
    root.id = 'codex-hramony-remote-status';
    root.innerHTML = '<button class="chr-pill" type="button" aria-label="Codex 远程状态"><span class="chr-dot"></span><span class="chr-label">远程注入中</span></button><div class="chr-detail"></div>';
    doc.documentElement.appendChild(style);
    doc.body.appendChild(root);
    state.badgeStyle = style;
    state.badgeRoot = root;
    return root;
  }
  function renderStatusBadge() {
    if (!document.body) return;
    const root = ensureBadge();
    const view = statusViewModel();
    root.className = 'chr-' + view.tone;
    const label = root.querySelector('.chr-label');
    const detail = root.querySelector('.chr-detail');
    if (label) label.textContent = view.label;
    root.title = view.message;
    if (detail) {
      const remote = view.remote || {};
      const local = view.local || {};
      const commandHealthy = remote.commandChannelHealthy;
      detail.innerHTML = '';
      const message = document.createElement('div');
      message.className = 'chr-message';
      message.textContent = view.message;
      detail.appendChild(message);
      const sendStatus = (
        view.tone === 'ok'
        && remote.stale !== true
        && remote.status !== 'mismatch'
        && remote.status !== 'unverified'
        && commandHealthy !== false
        && remote.desktopLive !== false
        && remote.online !== false
      ) ? '可用' : '不可用';
      const cdpStatus = (
        remote.status === 'unavailable'
        || remote.online === false
      ) ? '失效' : '正常';
      const rows = [
        ['手机发送', sendStatus],
        ['CDP 注入', cdpStatus],
        ['心跳', relativeTime(remote.checkedAt)]
      ];
      if (remote.status === 'mismatch' || remote.status === 'unverified') {
        rows.splice(1, 0,
          ['桌面会话', shortId(local.currentSessionId || remote.currentSessionId)],
          ['手机选择', shortId(remote.targetSessionId)]
        );
      }
      if (remote.reason) rows.push(['最近错误', String(remote.reason)]);
      for (const [key, value] of rows) {
        const row = document.createElement('div');
        row.className = 'chr-row';
        const keyNode = document.createElement('span');
        keyNode.className = 'chr-key';
        keyNode.textContent = key;
        const valueNode = document.createElement('span');
        valueNode.className = 'chr-value';
        valueNode.textContent = value || '无';
        row.appendChild(keyNode);
        row.appendChild(valueNode);
        detail.appendChild(row);
      }
    }
  }
  function onDesktopMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mcp-response' || data.type === 'mcp-notification' || data.type === 'fetch-response') {
      state.queue.push(data);
      if (state.queue.length > 1000) state.queue.splice(0, state.queue.length - 1000);
    }
  }
  window.addEventListener('message', onDesktopMessage);
  window.__codexHramonyDesktopCdpHost = {
    stop() {
      state.stopped = true;
      window.removeEventListener('message', onDesktopMessage);
      state.badgeRoot?.remove();
      state.badgeStyle?.remove();
    },
    status() {
      renderStatusBadge();
      return status({ stopped: state.stopped });
    },
    updateRemoteStatus(payload) {
      state.remoteStatus = payload;
      renderStatusBadge();
      return status({ ok: true, stopped: state.stopped });
    },
    drainMessages(limit = 10) {
      renderStatusBadge();
      const count = Math.max(1, Math.min(20, Number(limit) || 10));
      const messages = state.queue.splice(0, count);
      return status({ messages });
    },
    async dispatch(command) {
      try {
        await window.electronBridge.sendMessageFromView(command);
        return status({ ok: true });
      } catch (error) {
        return status({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return window.__codexHramonyDesktopCdpHost.status();
})()
`;
  await client.call('Page.addScriptToEvaluateOnNewDocument', { source });
  return evaluatePage(client, source);
}

async function evaluatePage(client, expression, timeoutMs = 15000) {
  const response = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  }, timeoutMs);
  if (response.error) {
    throw new Error(response.error.message ?? 'CDP evaluate failed');
  }
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  }
  return response.result?.result?.value ?? null;
}

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await getCdpTargets(cdpPort, Math.min(5000, Math.max(1, deadline - Date.now())));
      const page = selectCodexDesktopCdpTarget(targets);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(700);
  }
  throw lastError ?? new Error(`No Codex CDP target found on 127.0.0.1:${cdpPort}`);
}

async function post(path, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bridgeUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(json.error || text || `HTTP ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    };
    this.socket.onclose = () => this.rejectAll(new Error('CDP socket closed'));
    this.socket.onerror = () => this.rejectAll(new Error('CDP socket error'));
  }

  static async connect(url) {
    const socket = new WebSocket(url, [], buildDesktopCdpWebSocketOptions(cdpPort));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Failed to connect CDP websocket'));
    });
    return new CdpClient(socket);
  }

  call(method, params = {}, timeoutMs = 10000) {
    const queued = this.queue.then(
      () => this.callNow(method, params, timeoutMs),
      () => this.callNow(method, params, timeoutMs)
    );
    this.queue = queued.catch(() => {});
    return queued;
  }

  callNow(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

await main();
