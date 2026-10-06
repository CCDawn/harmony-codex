import { spawn } from 'node:child_process';

// 单行日志截断上限：voice_server 的 stdout/stderr 只进桥接日志，不落帧内容。
const LOG_LINE_CLAMP = 400;
const SPAWN_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_CAP_MS = 30_000;

// 轻量引号感知命令拆分：只处理空格 + 双引号，配合 spawn({ shell: false }) 使用，
// 避免 shell 注入面。voiceCommand 形如 `"C:\repo\.venv\Scripts\python.exe" "C:\repo\voice\voice_server.py" --port 8790`。
export function splitVoiceCommand(commandLine) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (const char of String(commandLine ?? '')) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

// 受管 voice_server.py 子进程监督器：懒启动（首个 /voice 升级时拉起）、
// 异常退出后按退避自动重启（CODEX_BRIDGE_VOICE_AUTO_RECONNECT / _RECONNECT_DELAY_MS）。
// 参照 managedCodexAppServerClient 的 disconnect/reconnect 形态，但不做协议握手——
// 健康判定交给 /voice 隧道自身（连不上即 502）。
export function createVoiceProcessSupervisor({ config, logger }) {
  const enabled = config?.voiceEnabled === true;
  const commandText = String(config?.voiceCommand ?? '').trim();
  const autoReconnect = config?.voiceAutoReconnect
    ?? process.env.CODEX_BRIDGE_VOICE_AUTO_RECONNECT !== '0';
  const reconnectDelayMs = Math.max(0, Number.parseInt(
    String(config?.voiceReconnectDelayMs ?? process.env.CODEX_BRIDGE_VOICE_RECONNECT_DELAY_MS ?? '2000'),
    10
  ) || 0);

  let child = null;
  let starting = null;
  let closing = false;
  let lastExitCode = null;
  let restarts = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const outputBuffers = new Map();

  function logEvent(level, event, data = {}) {
    void Promise.resolve(logger?.write?.('voice', level, event, data)).catch(() => {});
  }

  function clampLine(text) {
    return text.length > LOG_LINE_CLAMP ? `${text.slice(0, LOG_LINE_CLAMP)}[truncated]` : text;
  }

  function drainOutput(streamName, chunk) {
    const buffer = `${outputBuffers.get(streamName) ?? ''}${chunk.toString('utf8')}`;
    const lines = buffer.split(/\r?\n/);
    outputBuffers.set(streamName, lines.pop() ?? '');
    for (const line of lines) {
      const text = line.trim();
      if (text.length > 0) {
        logEvent('info', 'voice.server.output', { stream: streamName, text: clampLine(text) });
      }
    }
  }

  function flushOutput(streamName) {
    const text = (outputBuffers.get(streamName) ?? '').trim();
    outputBuffers.set(streamName, '');
    if (text.length > 0) {
      logEvent('info', 'voice.server.output', { stream: streamName, text: clampLine(text) });
    }
  }

  function start() {
    const parts = splitVoiceCommand(commandText);
    if (parts.length === 0) {
      return Promise.reject(new Error('CODEX_BRIDGE_VOICE_COMMAND is empty; voice server cannot start'));
    }
    const [command, ...args] = parts;
    const spawned = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = spawned;
    reconnectAttempts = 0;
    logEvent('info', 'voice.server.starting', { pid: spawned.pid ?? null });

    spawned.stdout?.on('data', (chunk) => drainOutput('stdout', chunk));
    spawned.stderr?.on('data', (chunk) => drainOutput('stderr', chunk));
    spawned.on('error', (error) => handleExit(spawned, null, null, error));
    spawned.on('close', (code, signal) => handleExit(spawned, code, signal, null));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('voice server spawn timed out'));
      }, SPAWN_TIMEOUT_MS);
      spawned.once('spawn', () => {
        clearTimeout(timer);
        resolve({ pid: spawned.pid });
      });
      spawned.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`voice server failed to start: ${error.message}`));
      });
    });
  }

  async function ensureRunning() {
    if (!enabled) {
      throw new Error('voice server is disabled (CODEX_BRIDGE_VOICE_ENABLED != 1)');
    }
    if (closing) {
      throw new Error('voice supervisor is closed');
    }
    if (child) {
      return { pid: child.pid };
    }
    if (starting) {
      return starting;
    }
    starting = start().finally(() => {
      starting = null;
    });
    return starting;
  }

  function handleExit(spawned, code, signal, error) {
    if (child !== spawned || spawned.__voiceExitHandled) {
      return;
    }
    spawned.__voiceExitHandled = true;
    child = null;
    lastExitCode = code;
    flushOutput('stdout');
    flushOutput('stderr');
    const intentional = spawned.__voiceIntentionalClose === true || closing;
    if (error) {
      logEvent('error', 'voice.server.spawn_error', { message: error?.message ?? String(error) });
    }
    logEvent(intentional ? 'info' : 'warn', 'voice.server.exited', {
      pid: spawned.pid ?? null,
      exitCode: code,
      signal: signal ?? null,
      intentional
    });
    if (!intentional && autoReconnect && !closing) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || closing || !autoReconnect) {
      return;
    }
    reconnectAttempts += 1;
    restarts += 1;
    const delayMs = Math.min(reconnectDelayMs * reconnectAttempts, RECONNECT_DELAY_CAP_MS);
    logEvent('info', 'voice.server.restart_scheduled', { delayMs, restarts });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureRunning().catch(() => {
        scheduleReconnect();
      });
    }, delayMs);
  }

  function status() {
    return {
      enabled,
      running: child !== null,
      pid: child?.pid ?? null,
      lastExitCode,
      restarts
    };
  }

  function close() {
    closing = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const previous = child;
    child = null;
    starting = null;
    if (previous) {
      previous.__voiceIntentionalClose = true;
      previous.kill();
    }
  }

  return { ensureRunning, status, close };
}
