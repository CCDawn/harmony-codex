import fs from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_SUPERVISOR_MAX_AGE_MS = 20_000;
export const DESKTOP_RELAUNCH_MESSAGE = '正在拉起桌面 Codex';

export function supervisorArmPath(repoRoot) {
  return path.join(repoRoot, 'logs', 'state', 'desktop-supervisor.json');
}

export function canAutoRelaunchMissingCodex(desktop, supervisor) {
  if (supervisor?.armed !== true || desktop?.desktopLive === true) {
    return false;
  }
  if (desktop?.desktopProcessMode === 'plain' || desktop?.failureClass === 'codex_plain_no_cdp') {
    return false;
  }
  return desktop?.desktopProcessMode === 'missing' || desktop?.failureClass === 'codex_not_running';
}

export function evaluateSupervisorArm(record, { now = Date.now(), isPidAlive = () => false, maxAgeMs = DESKTOP_SUPERVISOR_MAX_AGE_MS } = {}) {
  const heartbeatMs = Date.parse(String(record?.heartbeatAt ?? ''));
  const pid = Number(record?.pid);
  if (!Number.isFinite(heartbeatMs) || !Number.isInteger(pid) || pid <= 0) {
    return { armed: false, reason: 'invalid' };
  }
  const ageMs = now - heartbeatMs;
  if (ageMs > maxAgeMs || ageMs < -5_000) {
    return { armed: false, reason: 'stale', pid, ageMs };
  }
  if (!isPidAlive(pid)) {
    return { armed: false, reason: 'dead', pid, ageMs };
  }
  return { armed: true, reason: 'ok', pid, ageMs };
}

export async function readSupervisorArmFile(repoRoot, options = {}) {
  try {
    const text = await fs.readFile(supervisorArmPath(repoRoot), 'utf8');
    return evaluateSupervisorArm(JSON.parse(text), options);
  } catch {
    return { armed: false, reason: 'absent' };
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
