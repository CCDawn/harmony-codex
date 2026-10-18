import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PHASES = new Set(['disabled', 'checking', 'healthy', 'suspect', 'repairing', 'cooldown', 'needs_attention', 'paused', 'unknown']);
const STATES = new Set(['ready', 'error', 'blocked', 'unknown', 'waiting', 'unverified']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
const text = (value, limit = 180) => typeof value === 'string'
  ? value.replace(/https?:\/\/\S+/gi, '[地址]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[地址]').slice(0, limit) : '';

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The worker owns repair policy and configuration; this adapter never repairs on GET. */
export class MobileLinkGuardianService {
  constructor({ repoRoot, port = 8787, run = exec, now = () => Date.now() } = {}) {
    this.repoRoot = path.resolve(repoRoot ?? process.cwd());
    this.directory = path.join(this.repoRoot, 'logs', 'state');
    this.port = port;
    this.run = run;
    this.now = now;
    this.heartbeatQueue = Promise.resolve();
  }

  async status({ phone = false } = {}) {
    if (phone) await this.phoneHeartbeat();
    let config, state;
    try {
      [config, state] = await Promise.all([
        readJson(path.join(this.directory, 'mobile-link-guardian-config.json')),
        readJson(path.join(this.directory, 'mobile-link-guardian-status.json'))
      ]);
      if (config && (config.version !== 1 || typeof config.enabled !== 'boolean')) throw new Error('Invalid configuration');
    } catch {
      return { guardian: this.publicStatus(null, { phase: 'unknown', summary: '自动守护状态读取失败，请在电脑管理应用中检查' }) };
    }
    return { guardian: this.publicStatus(config, state) };
  }

  publicStatus(config, state) {
    const enabled = config?.enabled === true;
    let phase = PHASES.has(state?.phase) ? state.phase : enabled ? 'checking' : 'disabled';
    let summary = text(state?.summary) || (enabled ? '正在等待自动守护检测' : '自动守护未开启');
    if (!enabled && phase !== 'unknown') { phase = 'disabled'; summary = '自动守护未开启'; }
    const heartbeat = iso(state?.heartbeatAt);
    // A bounded repair may outlive the normal check interval. Its own deadline
    // distinguishes it from a dead worker without inventing a successful repair.
    const deadline = iso(state?.nextCheckAt);
    if (enabled && heartbeat && this.now() - Date.parse(heartbeat) > 90_000
      && !(phase === 'repairing' && deadline && Date.parse(deadline) > this.now())) {
      phase = 'unknown'; summary = '自动守护进程暂未报告状态，请检查电脑管理应用';
    }
    return {
      version: 1, enabled, allowForceRestart: config?.allowForceRestart === true,
      phase, summary, checkedAt: iso(state?.checkedAt), heartbeatAt: heartbeat,
      lastSuccessAt: iso(state?.lastSuccessAt), lastRepairAt: iso(state?.lastRepairAt),
      nextCheckAt: deadline, attempts: Math.max(0, Math.min(3, Number(state?.attempts) || 0)),
      faults: (Array.isArray(state?.faults) ? state.faults : []).filter(value => value && typeof value === 'object').slice(0, 12).map(value => ({
        id: text(value.id, 48), title: text(value.title, 60),
        state: STATES.has(value.state) ? value.state : 'unknown', message: text(value.message)
      })),
      history: (Array.isArray(state?.history) ? state.history : []).filter(value => value && typeof value === 'object').slice(-12).map(value => ({
        at: iso(value.at), action: text(value.action, 48), outcome: text(value.outcome, 48), message: text(value.message)
      }))
    };
  }

  async setEnabled(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => key !== 'enabled')) {
      throw Object.assign(new Error('自动守护设置无效'), { statusCode: 400 });
    }
    try {
      await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(this.repoRoot, 'tools', 'windows', 'mobile-link-guardian.ps1'),
        '-Action', body.enabled ? 'Enable' : 'Disable', '-BridgePort', String(this.port)],
      { windowsHide: true, timeout: 25_000, maxBuffer: 256 * 1024, cwd: this.repoRoot });
      const result = await this.status();
      if (result.guardian.enabled !== body.enabled || result.guardian.phase === 'unknown') throw new Error('Unconfirmed setting');
      return result;
    } catch {
      // Subprocess output can contain local configuration; never publish it.
      throw Object.assign(new Error('自动守护设置尚未确认，请刷新或在电脑管理应用中检查'), { statusCode: 503 });
    }
  }

  async phoneHeartbeat() {
    const operation = this.heartbeatQueue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, 'mobile-link-guardian-phone.json');
      const temp = file + '.' + process.pid + '.tmp';
      await fs.writeFile(temp, JSON.stringify({ version: 1, lastSeenAt: new Date(this.now()).toISOString() }), 'utf8');
      await fs.rename(temp, file);
    });
    this.heartbeatQueue = operation;
    // A heartbeat write failure must not hide an otherwise readable status.
    await operation.catch(() => {});
  }
}
