import { spawn } from 'node:child_process';
import path from 'node:path';

export class DesktopLiveRecovery {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.scriptPath = options.scriptPath ?? path.join(this.repoRoot, 'scripts', 'recover-codex-desktop-live-soft.ps1');
    this.hardScriptPath = options.hardScriptPath ?? path.join(this.repoRoot, 'scripts', 'restart-codex-desktop-live.ps1');
    this.bridgeUrl = options.bridgeUrl ?? process.env.CODEX_DESKTOP_RECOVERY_BRIDGE_URL ?? 'http://127.0.0.1:8787';
    this.bridgeToken = options.bridgeToken ?? process.env.CODEX_BRIDGE_TOKEN ?? '';
    this.timeoutMs = Number.parseInt(options.timeoutMs ?? process.env.CODEX_DESKTOP_RECOVERY_TIMEOUT_MS ?? '90000', 10);
    this.hardTimeoutMs = Number.parseInt(options.hardTimeoutMs ?? process.env.CODEX_DESKTOP_HARD_RECOVERY_TIMEOUT_MS ?? '150000', 10);
    this.enabled = options.enabled ?? process.env.CODEX_DESKTOP_AUTO_RECOVER !== '0';
    this.inflight = null;
    this.lastAttemptAt = 0;
    this.cooldownMs = Number.parseInt(options.cooldownMs ?? process.env.CODEX_DESKTOP_RECOVERY_COOLDOWN_MS ?? '15000', 10);
  }

  shouldRecover(status) {
    if (!this.enabled || !status || status.desktopLive === true) {
      return false;
    }
    if (status.mobileRecoverable === false || status.requiresDesktopCdp === true) {
      return false;
    }
    const state = String(status.status ?? '');
    const reason = String(status.reason ?? status.message ?? '');
    return state === 'unavailable'
      || /未连接|timeout|超时|heartbeat|socket|CDP|not connected/i.test(reason);
  }

  async recover({ sessionId = '', logger = null, reason = '', mode = 'soft', refusePlain = false } = {}) {
    if (!this.enabled) {
      return { attempted: false, skipped: true, reason: 'disabled' };
    }
    if (this.inflight) {
      return this.inflight;
    }
    const sinceLastAttempt = Date.now() - this.lastAttemptAt;
    if (sinceLastAttempt < this.cooldownMs) {
      return {
        attempted: false,
        skipped: true,
        reason: `cooldown ${this.cooldownMs - sinceLastAttempt}ms`
      };
    }
    this.lastAttemptAt = Date.now();
    this.inflight = this.runRecovery({ sessionId, logger, reason, mode, refusePlain }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async runRecovery({ sessionId, logger, reason, mode = 'soft', refusePlain = false }) {
    const startedAt = Date.now();
    const hard = mode === 'hard';
    const scriptPath = hard ? this.hardScriptPath : this.scriptPath;
    await logger?.write?.('bridge', 'warn', 'desktop_live.recovery.started', {
      sessionId,
      reason,
      mode: hard ? 'hard' : 'soft',
      bridgeUrl: this.bridgeUrl,
      scriptPath
    }).catch(() => {});

    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-BridgeUrl',
      this.bridgeUrl,
      '-BridgeToken',
      this.bridgeToken
    ];
    if (sessionId) {
      args.push('-SessionId', sessionId);
    }
    if (hard && refusePlain === true) {
      args.push('-RefusePlainCodex');
    }

    const result = await spawnWithTimeout('powershell.exe', args, {
      cwd: this.repoRoot,
      timeoutMs: hard ? this.hardTimeoutMs : this.timeoutMs
    });

    const payload = {
      sessionId,
      mode: hard ? 'hard' : 'soft',
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutTail: tailText(result.stdout, 3000),
      stderrTail: tailText(result.stderr, 3000)
    };
    const shared = hard && result.exitCode === 10;
    const plainRefused = hard && result.exitCode === 11;
    const ok = result.exitCode === 0 || shared;
    await logger?.write?.('bridge', ok ? 'info' : 'error', ok ? 'desktop_live.recovery.completed' : 'desktop_live.recovery.failed', payload).catch(() => {});
    if (plainRefused) {
      const error = new Error('检测到普通 Codex 正在运行，已停止自动拉起。');
      error.recovery = payload;
      throw error;
    }
    if (!ok) {
      const error = new Error(`桌面 live ${hard ? '硬' : '软'}恢复失败，退出码 ${result.exitCode}`);
      error.recovery = payload;
      throw error;
    }
    return { attempted: true, ok: true, shared, ...payload };
  }
}

function spawnWithTimeout(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nTimeout after ${timeoutMs}ms` });
    }, Math.max(5000, timeoutMs));

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

function tailText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(text.length - maxLength);
}
