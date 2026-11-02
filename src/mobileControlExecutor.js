import fs from 'node:fs/promises';
import path from 'node:path';
import { generateTotp } from './totp.js';
import { runMobileControlProcess } from './mobileControlProcess.js';

const HARD_FAULTS = new Set(['codex_plain_no_cdp', 'codex_remote_debug_no_cdp']);
const EXTERNAL_FAULTS = new Set(['auth', 'account', 'upstream', 'api_compatibility']);

// All executable names, switches and actions are local constants. Job data is used
// only in encoded authenticated HTTP paths/queries, never in a process command line.
export function createMobileControlExecutor({ repoRoot, bridgeUrl = 'http://127.0.0.1:8787',
  runProcess = runMobileControlProcess, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  const root = path.resolve(repoRoot);
  const base = new URL(bridgeUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new TypeError('Bridge must use local loopback HTTP');
  const script = path.join(root, 'tools', 'windows', 'mobile-link-control.ps1');

  async function read(endpoint) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const headers = { 'X-Codex-Bridge-Token': process.env.CODEX_BRIDGE_TOKEN ?? '' };
      const secret = process.env.CODEX_BRIDGE_TOTP_SECRET;
      if (secret) headers['X-Codex-Bridge-OTP'] = generateTotp(secret, { nowMs: now() });
      const response = await fetchImpl(new URL(endpoint, base), { headers, signal: controller.signal, redirect: 'error' });
      const body = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, body, reached: true };
    } catch { return { status: 0, ok: false, body: null, reached: false }; }
    finally { clearTimeout(timer); }
  }

  async function verify(sessionId) {
    const query = `?sessionId=${encodeURIComponent(sessionId)}`;
    const [health, sessions, desktopResult, linkResult] = await Promise.all([
      read(`/health?threadId=${encodeURIComponent(sessionId)}`), read('/codex/sessions?limit=3'),
      read(`/desktop/live/status${query}`), read(`/system/link/status${query}`)
    ]);
    const desktop = desktopResult.body?.desktop ?? {};
    const link = linkResult.body?.link ?? {};
    const execution = health.body?.runtime?.existingThreadExecution;
    // Unknown runtime modes retain desktop requirements. Never infer app_server
    // from a missing desktop, a truthy string, or an advertised capability.
    const desktopRequired = execution !== 'app_server';
    const readableSessions = sessions.ok && Array.isArray(sessions.body?.sessions);
    // Resolve the actual requested session through its business API. A list
    // entry or optional CDP acknowledgement cannot verify app_server execution.
    const targetResult = !desktopRequired && sessionId
      ? await read(`/codex/sessions/${encodeURIComponent(sessionId)}?tail=1`) : null;
    const targetSession = !sessionId ? readableSessions : desktopRequired
      ? desktopResult.ok && (desktop.sessionVerified === true || desktop.targetVerified === true)
        && (!desktop.targetSessionId || desktop.targetSessionId === sessionId)
      : targetResult?.ok === true && targetResult.body?.session?.id === sessionId;
    const verification = { bridge: health.ok && health.body?.ok === true,
      sessions: readableSessions,
      targetSession,
      desktopRequired, desktop: desktopResult.ok && desktop.desktopLive === true };
    const restartRequired = desktopRequired && (HARD_FAULTS.has(desktop.failureClass)
      || HARD_FAULTS.has(desktop.desktopProcessMode)
      || link.recommendedAction === 'desktop_cdp_restart_required');
    const requiredResults = desktopRequired ? [health, sessions, desktopResult, linkResult] : [health, sessions, targetResult].filter(Boolean);
    const external = requiredResults.some((result) =>
      [401, 403, 429].includes(result.status) || EXTERNAL_FAULTS.has(result.body?.failureClass))
      || (desktopRequired && EXTERNAL_FAULTS.has(desktop.failureClass))
      || (sessions.status >= 500 && !restartRequired) || (targetResult?.status >= 500);
    return { verification, restartRequired, external, bridgeOffline: !health.reached };
  }
  const succeeded = (v) => v.bridge && v.sessions && v.targetSession && (!v.desktopRequired || v.desktop);
  async function invoke(action, restart = false) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', action, '-BridgePort', base.port || '80'];
    if (restart) args.push('-RestartDesktop');
    try {
      const result = await runProcess('pwsh.exe', args, { cwd: root, shell: false,
        windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      let body;
      try { body = JSON.parse(result.stdout ?? 'null'); } catch { body = null; }
      // Joining another operation or returning "already healthy" cannot prove
      // that this explicitly requested restart actually happened.
      return { executed: !restart || body?.desktopRecovery?.state === 'restarted' };
    } catch { return { executed: false }; }
  }
  async function allowsRestart() {
    try {
      const policy = JSON.parse(await fs.readFile(path.join(root, 'logs', 'state', 'mobile-link-guardian-config.json'), 'utf8'));
      return policy.allowForceRestart === true;
    } catch { return false; }
  }
  return async function execute(job, report = async () => {}) {
    if (!job || !['auto', 'hard'].includes(job.mode) || typeof job.sessionId !== 'string'
      || job.sessionId.length > 128) throw new TypeError('Invalid repair job');
    await report({ phase: 'checking' });
    let state = await verify(job.sessionId);
    const result = (extra = {}) => ({ ok: succeeded(state.verification), verification: state.verification, ...extra });
    if (job.mode === 'hard' && job.confirmHardRestart !== true) return result({ ok: false, requiresConfirmation: true });
    if (state.external) return result({ ok: false });
    if (job.mode === 'auto' && succeeded(state.verification)) return result();
    if (state.bridgeOffline) {
      await report({ phase: 'starting_services' });
      await invoke('Start');
      await report({ phase: 'verifying' });
      state = await verify(job.sessionId);
      if (state.external || !state.verification.bridge) return result({ ok: false });
      if (job.mode === 'auto' && succeeded(state.verification)) return result();
    }
    // A reachable bridge that rejects health/auth is not evidence of a dead
    // local process. Leave it available for diagnostics instead of starting it.
    if (!state.verification.bridge) return result({ ok: false });
    // CDP repair/restart cannot fix an absent or mismatched app_server session.
    // Only an explicit confirmed hard request retains the desktop restart path.
    if (job.mode === 'auto' && !state.verification.desktopRequired) return result({ ok: false });
    if (job.mode === 'auto' && !state.restartRequired) {
      await report({ phase: 'connecting_desktop' });
      await invoke('Repair');
      await report({ phase: 'verifying' });
      state = await verify(job.sessionId);
      if (state.external || succeeded(state.verification)) return result({ ok: !state.external && succeeded(state.verification) });
      if (!state.restartRequired) return result({ ok: false });
    }
    if (job.mode === 'auto' && !await allowsRestart()) return result({ ok: false, requiresConfirmation: true });
    await report({ phase: 'restarting_desktop' });
    const restarted = await invoke('Repair', true);
    await report({ phase: 'verifying' });
    state = await verify(job.sessionId);
    return result({ ok: restarted.executed && !state.external && succeeded(state.verification) });
  };
}
