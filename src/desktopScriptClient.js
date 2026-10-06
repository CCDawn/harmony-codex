const DEFAULT_RETRY_BACKOFF_MS = 2000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 30000;

// 失败退避：2s 起、×2、封顶 30s；服务端给了 Retry-After（429）时取两者较大值，同样封顶。
export function nextRetryDelayMs(failureCount, retryAfterMs = 0, {
  baseMs = DEFAULT_RETRY_BACKOFF_MS,
  maxMs = DEFAULT_RETRY_BACKOFF_MAX_MS
} = {}) {
  const failures = Math.max(1, Math.floor(Number(failureCount) || 1));
  const backoff = Math.min(baseMs * 2 ** (failures - 1), maxMs);
  const serverHint = Math.min(Math.max(0, Number(retryAfterMs) || 0), maxMs);
  return Math.max(backoff, serverHint);
}

export function buildDesktopScriptClient({
  bridgeUrl,
  authRequired = false,
  pollTimeoutMs = 25000,
  heartbeatMs = 5000,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  retryBackoffMaxMs = DEFAULT_RETRY_BACKOFF_MAX_MS
} = {}) {
  const baseUrl = String(bridgeUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('bridgeUrl is required');
  }

  // 安全约束：脚本响应体绝不内嵌桥接 token。页面在运行时自行取得令牌：
  // 先读 localStorage（历史会话已保存），否则提示用户输入一次并持久化。
  return `(() => {
  const bridgeUrl = ${JSON.stringify(baseUrl)};
  const authRequired = ${JSON.stringify(authRequired === true)};
  const tokenStorageKey = 'codex-hramony-bridge-token';
  const pollTimeoutMs = ${JSON.stringify(pollTimeoutMs)};
  const heartbeatMs = ${JSON.stringify(heartbeatMs)};
  const retryBackoffMs = ${JSON.stringify(retryBackoffMs)};
  const retryBackoffMaxMs = ${JSON.stringify(retryBackoffMaxMs)};

  function retryDelayMs(failures, retryAfterMs = 0) {
    const backoff = Math.min(retryBackoffMs * 2 ** Math.max(0, failures - 1), retryBackoffMaxMs);
    return Math.max(backoff, Math.min(Number(retryAfterMs) || 0, retryBackoffMaxMs));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resolveBridgeToken() {
    if (!authRequired) {
      return '';
    }
    try {
      const stored = window.localStorage.getItem(tokenStorageKey);
      if (stored) {
        return stored;
      }
    } catch (error) {
      console.warn('[codex-hramony] 读取本地桥接令牌失败', error);
    }
    try {
      const entered = window.prompt('请输入 Codex 桥接访问 token');
      if (entered) {
        window.localStorage.setItem(tokenStorageKey, entered);
        return entered;
      }
    } catch (error) {
      console.warn('[codex-hramony] 当前环境无法弹出令牌输入框', error);
    }
    return '';
  }

  if (!window.electronBridge || typeof window.electronBridge.sendMessageFromView !== 'function') {
    throw new Error('当前页面不是 Codex 桌面窗口，找不到 electronBridge.sendMessageFromView');
  }
  const bridgeToken = resolveBridgeToken();
  const authHeader = bridgeToken ? { 'X-Codex-Bridge-Token': bridgeToken } : {};
  if (authRequired && !bridgeToken) {
    console.warn('[codex-hramony] 桥接已开启令牌校验，但页面中没有令牌。请在控制台执行 localStorage.setItem("' + tokenStorageKey + '", "<token>") 后重新注入脚本。');
  }
  if (window.__codexHramonyDesktopScript?.stop) {
    window.__codexHramonyDesktopScript.stop();
  }

  const state = {
    stopped: false,
    scriptId: 'desktop-script-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    lastSessionId: null,
    badgeRoot: null,
    badgeStyle: null
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function ensureStatusBadge() {
    if (!document.body) return null;
    const doc = document;
    let style = doc.getElementById('codex-hramony-remote-status-style');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'codex-hramony-remote-status-style';
      style.textContent = [
        '#codex-hramony-remote-status {',
        '  position: fixed;',
        '  top: max(10px, env(safe-area-inset-top, 0px));',
        '  left: max(360px, calc(env(safe-area-inset-left, 0px) + 360px));',
        '  z-index: 9999;',
        '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
        '  color: #172033;',
        '  pointer-events: auto;',
        '}',
        '#codex-hramony-remote-status .chr-pill {',
        '  border: 1px solid rgba(125, 139, 163, 0.28);',
        '  border-radius: 999px;',
        '  background: rgba(255, 255, 255, 0.92);',
        '  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);',
        '  backdrop-filter: blur(12px);',
        '  -webkit-backdrop-filter: blur(12px);',
        '  min-height: 28px;',
        '  max-width: 86px;',
        '  padding: 0 10px 0 9px;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  gap: 6px;',
        '  cursor: pointer;',
        '  user-select: none;',
        '  font-size: 12px;',
        '  font-weight: 650;',
        '  line-height: 1;',
        '}',
        '#codex-hramony-remote-status .chr-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '#codex-hramony-remote-status .chr-dot {',
        '  width: 8px;',
        '  height: 8px;',
        '  border-radius: 999px;',
        '  background: var(--chr-color, #8a94a6);',
        '  box-shadow: 0 0 0 4px var(--chr-glow, rgba(138, 148, 166, 0.14));',
        '  flex: none;',
        '}',
        '#codex-hramony-remote-status .chr-detail {',
        '  position: absolute;',
        '  top: 34px;',
        '  left: 0;',
        '  width: 260px;',
        '  max-height: min(240px, calc(100vh - 54px));',
        '  overflow: auto;',
        '  padding: 10px 12px;',
        '  border: 1px solid rgba(125, 139, 163, 0.22);',
        '  border-radius: 12px;',
        '  background: rgba(255, 255, 255, 0.96);',
        '  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);',
        '  backdrop-filter: blur(14px);',
        '  -webkit-backdrop-filter: blur(14px);',
        '  display: none;',
        '  font-size: 12px;',
        '  line-height: 1.55;',
        '}',
        '#codex-hramony-remote-status:hover .chr-detail { display: block; }',
        '#codex-hramony-remote-status .chr-message { margin-bottom: 8px; color: #334155; font-weight: 600; }',
        '#codex-hramony-remote-status .chr-row {',
        '  display: flex;',
        '  justify-content: space-between;',
        '  gap: 10px;',
        '  border-top: 1px solid rgba(148, 163, 184, 0.18);',
        '  padding-top: 6px;',
        '  margin-top: 6px;',
        '}',
        '#codex-hramony-remote-status .chr-key { color: #64748b; white-space: nowrap; }',
        '#codex-hramony-remote-status .chr-value { color: #0f172a; text-align: right; overflow-wrap: anywhere; }',
        '#codex-hramony-remote-status.chr-ok { --chr-color: #16a34a; --chr-glow: rgba(22, 163, 74, 0.16); }',
        '#codex-hramony-remote-status.chr-warn { --chr-color: #d97706; --chr-glow: rgba(217, 119, 6, 0.17); }',
        '#codex-hramony-remote-status.chr-offline { --chr-color: #dc2626; --chr-glow: rgba(220, 38, 38, 0.16); }',
        '#codex-hramony-remote-status.chr-pending { --chr-color: #64748b; --chr-glow: rgba(100, 116, 139, 0.15); }'
      ].join('\\n');
      doc.documentElement.appendChild(style);
      state.badgeStyle = style;
    }
    let root = doc.getElementById('codex-hramony-remote-status');
    if (!root) {
      root = doc.createElement('div');
      root.id = 'codex-hramony-remote-status';
      root.dataset.chrOwner = state.scriptId;
      root.innerHTML = '<button class="chr-pill" type="button" aria-label="Codex 远程状态"><span class="chr-dot"></span><span class="chr-label">远程连接中</span></button><div class="chr-detail"></div>';
      doc.body.appendChild(root);
    }
    state.badgeRoot = root;
    return root;
  }

  function renderStatusBadge(tone, label, message) {
    try {
      const root = ensureStatusBadge();
      if (!root) return;
      root.className = 'chr-' + tone;
      const labelNode = root.querySelector('.chr-label');
      const detail = root.querySelector('.chr-detail');
      if (labelNode) labelNode.textContent = label;
      root.title = message;
      if (detail) {
        detail.innerHTML = '<div class="chr-message">' + escapeHtml(message) + '</div>'
          + '<div class="chr-row"><span class="chr-key">通道</span><span class="chr-value">脚本桥</span></div>'
          + '<div class="chr-row"><span class="chr-key">会话</span><span class="chr-value">' + escapeHtml(currentSessionId() || '未识别') + '</span></div>'
          + '<div class="chr-row"><span class="chr-key">实例</span><span class="chr-value">' + escapeHtml(state.scriptId.slice(0, 24)) + '</span></div>';
      }
    } catch (error) {
      console.warn('[codex-hramony] 更新远程状态条失败', error);
    }
  }

  function extractConversationId(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
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

  async function post(path, body) {
    const response = await fetch(bridgeUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(json.error || text || ('HTTP ' + response.status));
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        error.retryAfterMs = retryAfterSeconds * 1000;
      }
      throw error;
    }
    return json;
  }

  function envelope(extra = {}) {
    state.lastSessionId = currentSessionId();
    return {
      scriptId: state.scriptId,
      currentSessionId: state.lastSessionId,
      tokenPresent: Boolean(bridgeToken),
      ...extra
    };
  }

  function sendMessages(messages) {
    if (!messages.length || state.stopped) {
      return Promise.resolve();
    }
    return post('/desktop/script/messages', envelope({ messages })).catch((error) => {
      console.warn('[codex-hramony] 上传桌面事件失败', error);
    });
  }

  function onDesktopMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.type === 'mcp-response' || data.type === 'mcp-notification' || data.type === 'fetch-response') {
      sendMessages([data]);
    }
  }

  async function handleCommand(command) {
    if (!command || typeof command !== 'object') {
      return;
    }
    await window.electronBridge.sendMessageFromView(command);
  }

  let heartbeatFailures = 0;
  async function heartbeatLoop() {
    while (!state.stopped) {
      try {
        await post('/desktop/script/status', envelope());
        heartbeatFailures = 0;
        renderStatusBadge('ok', '远程在线', '桌面脚本桥在线');
        await sleep(heartbeatMs);
      } catch (error) {
        heartbeatFailures += 1;
        console.warn('[codex-hramony] 桌面脚本桥心跳失败', error);
        renderStatusBadge('warn', '心跳重试', '桌面脚本桥心跳失败，正在重试');
        await sleep(retryDelayMs(heartbeatFailures, error.retryAfterMs));
      }
    }
  }

  let pollFailures = 0;
  async function pollLoop() {
    while (!state.stopped) {
      try {
        const result = await post('/desktop/script/poll', envelope());
        pollFailures = 0;
        const commands = Array.isArray(result.commands) ? result.commands : [];
        for (const command of commands) {
          if (state.stopped) {
            return;
          }
          handleCommand(command).catch((error) => {
            sendMessages([{
              type: command.type === 'fetch' ? 'fetch-response' : 'mcp-response',
              requestId: command.requestId,
              hostId: command.hostId,
              message: command.request ? {
                id: command.request.id,
                error: { code: 1, message: error instanceof Error ? error.message : String(error) }
              } : undefined,
              responseType: 'error',
              error: error instanceof Error ? error.message : String(error)
            }]);
          });
        }
      } catch (error) {
        pollFailures += 1;
        console.warn('[codex-hramony] 桌面脚本桥轮询失败', error);
        renderStatusBadge('warn', '命令重试', '桌面命令轮询失败，正在重试');
        await sleep(retryDelayMs(pollFailures, error.retryAfterMs));
      }
    }
  }

  window.addEventListener('message', onDesktopMessage);
  window.__codexHramonyDesktopScript = {
    scriptId: state.scriptId,
    stop() {
      state.stopped = true;
      window.removeEventListener('message', onDesktopMessage);
      if (state.badgeRoot?.dataset?.chrOwner === state.scriptId) {
        state.badgeRoot.remove();
      }
    },
    status() {
      return {
        scriptId: state.scriptId,
        currentSessionId: currentSessionId(),
        bridgeUrl,
        authRequired,
        tokenPresent: Boolean(bridgeToken),
        stopped: state.stopped
      };
    }
  };

  let connectFailures = 0;
  async function connectLoop() {
    while (!state.stopped) {
      try {
        await post('/desktop/script/connect', envelope());
        connectFailures = 0;
        renderStatusBadge('ok', '远程在线', '桌面脚本桥已连接');
        console.log('[codex-hramony] 桌面脚本桥已连接', window.__codexHramonyDesktopScript.status());
        return;
      } catch (error) {
        connectFailures += 1;
        renderStatusBadge('offline', '远程断开', '桌面脚本桥连接失败，退避重试中');
        console.warn('[codex-hramony] 桌面脚本桥连接失败，退避后重试', error);
        await sleep(retryDelayMs(connectFailures, error.retryAfterMs));
      }
    }
  }

  if (authRequired && !bridgeToken) {
    renderStatusBadge('warn', '缺少令牌', '未取得桥接访问令牌，请在控制台设置 localStorage 后重新注入');
  } else {
    renderStatusBadge('pending', '远程连接中', '正在连接桌面脚本桥');
  }
  heartbeatLoop();
  pollLoop();
  connectLoop();
  return window.__codexHramonyDesktopScript;
})()`;
}
