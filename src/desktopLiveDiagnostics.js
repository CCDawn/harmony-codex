import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeDesktopCdpLiveness } from './codexDesktopCdpClient.js';

export class DesktopLiveDiagnostics {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.statusPath = options.statusPath ?? path.join(this.repoRoot, 'logs', 'desktop-live-status.json');
    this.timeoutMs = Number.parseInt(options.timeoutMs ?? process.env.CODEX_DESKTOP_DIAGNOSTICS_TIMEOUT_MS ?? '4000', 10);
    this.ttlMs = Number.parseInt(options.ttlMs ?? process.env.CODEX_DESKTOP_DIAGNOSTICS_TTL_MS ?? '2500', 10);
    this.powershell = options.powershell ?? 'powershell.exe';
    this.cdpLivenessProbe = options.cdpLivenessProbe ?? probeDesktopCdpLiveness;
    this.cdpLivenessTimeoutMs = Number.parseInt(
      options.cdpLivenessTimeoutMs ?? process.env.CODEX_DESKTOP_CDP_LIVENESS_TIMEOUT_MS ?? '1500',
      10
    );
    this.cache = null;
  }

  async inspect(status = {}) {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) {
      return classifyDiagnostics(this.cache.value, status);
    }
    const [processes, statusFile] = await Promise.all([
      this.readProcesses(),
      this.readStatusFile()
    ]);
    const snapshot = {
      processes,
      statusFile,
      cdpLiveness: await this.readCdpLiveness(processes, statusFile),
      inspectedAt: new Date().toISOString()
    };
    this.cache = { at: now, value: snapshot };
    return classifyDiagnostics(snapshot, status);
  }

  // 在线判定的地面真相：CDP DevTools 入口必须真实应答。TCP 可达（半死外壳
  // 占住监听 socket）或脚本桥心跳残留都不能再支撑 desktopLive=true。
  async readCdpLiveness(processes, statusFile) {
    if (typeof this.cdpLivenessProbe !== 'function') {
      return null;
    }
    const ports = collectCandidateCdpPorts(Array.isArray(processes) ? processes : [], statusFile);
    const timeoutMs = Number.isFinite(this.cdpLivenessTimeoutMs) ? this.cdpLivenessTimeoutMs : undefined;
    try {
      return await this.cdpLivenessProbe(ports.length > 0 ? { ports, timeoutMs } : { timeoutMs });
    } catch (error) {
      return { checked: true, ok: false, reason: `CDP 真实应答探测失败：${error?.message ?? String(error)}` };
    }
  }

  async readProcesses() {
    if (process.platform !== 'win32') {
      return [];
    }
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$items = @(Get-CimInstance Win32_Process | Where-Object {",
      "  $_.Name -in @('Codex.exe', 'ChatGPT.exe') -or ([string]$_.CommandLine -match 'start-desktop-cdp-live-host\\.mjs')",
      "} | ForEach-Object {",
      "  [pscustomobject]@{",
      "    processId = [int]$_.ProcessId",
      "    parentProcessId = [int]$_.ParentProcessId",
      "    name = [string]$_.Name",
      "    commandLine = [string]$_.CommandLine",
      "    creationDate = [string]$_.CreationDate",
      "  }",
      "})",
      "$items | ConvertTo-Json -Depth 5 -Compress"
    ].join('\n');
    const result = await spawnWithTimeout(this.powershell, ['-NoProfile', '-Command', script], {
      cwd: this.repoRoot,
      timeoutMs: this.timeoutMs
    });
    if (result.exitCode !== 0) {
      throw new Error(`桌面进程诊断失败，退出码 ${result.exitCode}: ${tailText(result.stderr || result.stdout, 1000)}`);
    }
    const text = result.stdout.trim();
    if (!text) {
      return [];
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async readStatusFile() {
    try {
      const text = await fs.readFile(this.statusPath, 'utf8');
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }
}

export function classifyDiagnostics(snapshot = {}, status = {}) {
  const processes = Array.isArray(snapshot.processes) ? snapshot.processes : [];
  const codexProcesses = processes.filter((processInfo) => isCodexProcess(processInfo));
  const liveHostProcesses = processes.filter((processInfo) => isLiveHostProcess(processInfo));
  const codexCdpPorts = uniqueNumbers(codexProcesses.map((processInfo) => extractRemoteDebuggingPort(processInfo.commandLine)));
  const liveHostCdpPorts = uniqueNumbers(liveHostProcesses.map((processInfo) => extractLiveHostCdpPort(processInfo.commandLine)));
  const statusFilePort = Number.parseInt(String(snapshot.statusFile?.cdpPort ?? ''), 10);
  const candidateCdpPorts = uniqueNumbers([
    ...codexCdpPorts,
    ...liveHostCdpPorts,
    Number.isFinite(statusFilePort) ? statusFilePort : 0
  ]);
  const desktopProcessMode = codexProcesses.length === 0
    ? 'missing'
    : codexCdpPorts.length === 0
      ? 'plain'
      : codexCdpPorts.length < codexProcesses.length
        ? 'mixed'
        : 'cdp';
  const cdpLiveness = snapshot.cdpLiveness ?? null;
  const cdpResponsive = cdpLiveness?.checked === true ? cdpLiveness.ok === true : null;
  const base = {
    available: true,
    inspectedAt: snapshot.inspectedAt ?? new Date().toISOString(),
    desktopProcessMode,
    codexProcessCount: codexProcesses.length,
    codexProcessId: codexProcesses[0]?.processId ?? null,
    codexStartedAt: codexProcesses[0]?.creationDate ?? null,
    liveHostRunning: liveHostProcesses.length > 0,
    liveHostProcessId: liveHostProcesses[0]?.processId ?? null,
    cdpPort: codexCdpPorts[0] ?? liveHostCdpPorts[0] ?? (Number.isFinite(statusFilePort) ? statusFilePort : null),
    candidateCdpPorts,
    lastInjectedCdpPort: Number.isFinite(statusFilePort) ? statusFilePort : null,
    cdpResponsive,
    cdpLiveness
  };

  // 地面真相优先：上游宣称 desktopLive=true 时，若 CDP DevTools 入口没有真实
  // 应答（半死外壳占端口、socket 残留），必须推翻在线判定，不能直接判 none。
  if (status?.desktopLive === true && cdpLiveness?.checked === true && cdpLiveness.ok !== true) {
    if (desktopProcessMode === 'missing') {
      return {
        ...base,
        failureClass: 'codex_not_running',
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
    if (desktopProcessMode === 'plain') {
      return {
        ...base,
        failureClass: 'codex_plain_no_cdp',
        requiresDesktopCdp: true,
        mobileRecoverable: false
      };
    }
    return {
      ...base,
      failureClass: 'desktop_cdp_unavailable',
      requiresDesktopCdp: false,
      mobileRecoverable: true
    };
  }

  if (status?.desktopLive === true) {
    return {
      ...base,
      failureClass: 'none',
      requiresDesktopCdp: false,
      mobileRecoverable: true
    };
  }

  if (desktopProcessMode === 'missing') {
    return {
      ...base,
      failureClass: 'codex_not_running',
      requiresDesktopCdp: true,
      mobileRecoverable: false
    };
  }

  if (desktopProcessMode === 'plain') {
    return {
      ...base,
      failureClass: 'codex_plain_no_cdp',
      requiresDesktopCdp: true,
      mobileRecoverable: false
    };
  }

  const text = [
    status?.status,
    status?.message,
    status?.reason,
    status?.recoveryError
  ].map((value) => String(value ?? '')).join(' ');
  const failureClass = /session|会话|mismatch|unverified/i.test(text)
    ? 'desktop_session_unverified'
    : base.liveHostRunning
      ? 'desktop_cdp_unavailable'
      : 'desktop_live_host_offline';

  return {
    ...base,
    failureClass,
    requiresDesktopCdp: false,
    mobileRecoverable: true
  };
}

function isCodexProcess(processInfo) {
  const name = String(processInfo?.name ?? '').toLowerCase();
  const commandLine = String(processInfo?.commandLine ?? '');
  if (/\s--type=/.test(commandLine)) {
    return false;
  }
  if (name === 'chatgpt.exe') {
    return /\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe/i.test(commandLine);
  }
  if (name === 'codex.exe') {
    return /\\app\\Codex\.exe/i.test(commandLine)
      && !/\\app\\resources\\codex\.exe/i.test(commandLine)
      && !/\bapp-server\b/i.test(commandLine);
  }
  return false;
}

function isLiveHostProcess(processInfo) {
  return /start-desktop-cdp-live-host\.mjs/i.test(String(processInfo?.commandLine ?? ''));
}

function collectCandidateCdpPorts(processes, statusFile) {
  const codexProcesses = processes.filter((processInfo) => isCodexProcess(processInfo));
  const liveHostProcesses = processes.filter((processInfo) => isLiveHostProcess(processInfo));
  const statusFilePort = Number.parseInt(String(statusFile?.cdpPort ?? ''), 10);
  return uniqueNumbers([
    ...codexProcesses.map((processInfo) => extractRemoteDebuggingPort(processInfo.commandLine)),
    ...liveHostProcesses.map((processInfo) => extractLiveHostCdpPort(processInfo.commandLine)),
    Number.isFinite(statusFilePort) ? statusFilePort : 0
  ]);
}

function extractRemoteDebuggingPort(commandLine) {
  const match = String(commandLine ?? '').match(/remote-debugging-port[=\s]+(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function extractLiveHostCdpPort(commandLine) {
  const text = String(commandLine ?? '');
  const match = text.match(/CODEX_DESKTOP_CDP_PORT\s*=\s*['"]?(\d+)/i)
    ?? text.match(/CODEX_DESKTOP_CDP_PORT['"]?\s*;\s*\$env:CODEX_DESKTOP_CDP_PORT\s*=\s*['"]?(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function uniqueNumbers(values) {
  const result = [];
  for (const value of values) {
    const number = Number.parseInt(String(value ?? ''), 10);
    if (Number.isInteger(number) && number > 0 && !result.includes(number)) {
      result.push(number);
    }
  }
  return result;
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
    }, Math.max(1000, timeoutMs));

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
