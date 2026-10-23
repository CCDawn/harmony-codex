import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateTotp } from '../../src/totp.js';

const RESOURCE_TIMEOUT_MS = 3000;
const GiB = 1024 ** 3;

// Only numeric memory counters leave this process. No process inventory or configuration is read.
export async function readSystemResources({ platform = process.platform, execFileImpl = execFile,
  freeMemory = os.freemem } = {}) {
  if (platform !== 'win32') return { availablePhysicalBytes: freeMemory() };
  const command = "$ErrorActionPreference='Stop'; $memory=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -Property CommitLimit,CommittedBytes,AvailableBytes; @{commitLimitBytes=[double]$memory.CommitLimit;commitAvailableBytes=([double]$memory.CommitLimit-[double]$memory.CommittedBytes);availablePhysicalBytes=[double]$memory.AvailableBytes}|ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: RESOURCE_TIMEOUT_MS, maxBuffer: 4096, encoding: 'utf8' },
      (error, stdout) => {
        if (error) { reject(new Error('Resource probe unavailable')); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { reject(new Error('Resource counters unavailable')); }
      });
  });
}

export async function inspectResources({ resourceProvider = readSystemResources,
  timeoutMs = RESOURCE_TIMEOUT_MS } = {}) {
  const unknown = { id: 'resources', title: '本机资源', state: 'unknown', message: '本机内存资源未确认，请稍后重试检测' };
  let timer;
  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(resourceProvider),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Resource probe timed out')), Math.min(RESOURCE_TIMEOUT_MS, timeoutMs)); })
    ]);
    const { commitLimitBytes, commitAvailableBytes, availablePhysicalBytes } = snapshot || {};
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!valid(availablePhysicalBytes)) return unknown;
    const physical = `可用物理内存 ${(availablePhysicalBytes / GiB).toFixed(1)} GiB`;
    if (!valid(commitLimitBytes) || commitLimitBytes === 0 || !valid(commitAvailableBytes)
      || commitAvailableBytes > commitLimitBytes) return { ...unknown, message: `${physical}；内存提交额度未确认` };
    const pressure = commitAvailableBytes < 2 * GiB || commitAvailableBytes / commitLimitBytes < 0.05;
    return { id: 'resources', title: '本机资源', state: pressure ? 'waiting' : 'ready',
      message: `${pressure ? '本机资源不足：' : ''}内存提交余量 ${(commitAvailableBytes / GiB).toFixed(1)} GiB（${(100 * commitAvailableBytes / commitLimitBytes).toFixed(1)}%），${physical}${pressure ? '；请减少并发或关闭不需要的应用' : ''}` };
  } catch { return unknown; }
  finally { clearTimeout(timer); }
}

// Read-only probes. Never return response bodies, credentials, assistant identifiers or raw errors.
const FAST_PROBE_TIMEOUT_MS = 4000;
const ASSISTANT_PROBE_TIMEOUT_MS = 12000;

export async function inspectMobileLink({ baseUrl, headers = {}, getHeaders = () => headers, fetchImpl = fetch,
  timeoutMs = FAST_PROBE_TIMEOUT_MS, assistantTimeoutMs = ASSISTANT_PROBE_TIMEOUT_MS, collectSignals = false }) {
  async function read(route, requestTimeoutMs = timeoutMs) {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    try {
      const response = await fetchImpl(baseUrl + route, { headers: await getHeaders(), signal });
      if (!response.ok) {
        let failureClass;
        if (collectSignals) {
          try {
            const body = await response.json();
            if (['api_compatibility', 'auth', 'account', 'upstream'].includes(body?.failureClass)) failureClass = body.failureClass;
          } catch { /* Gateway HTML is not diagnostic text. */ }
        }
        return { ok: false, httpStatus: response.status, ...(failureClass ? { failureClass } : {}) };
      }
      return { ok: true, body: await response.json() };
    } catch (error) {
      const failureKind = signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'request';
      return { ok: false, httpStatus: 0, failureKind };
    }
  }
  function check(id, title, state, message) { return { id, title, state, message }; }
  function failure(result) {
    return result.httpStatus ? `请求失败（HTTP ${result.httpStatus}）`
      : result.failureKind === 'timeout' ? '请求超时' : '请求异常';
  }
  const [health, desktop, sessions, profile] = await Promise.all([
    read('/health'), read('/desktop/live/status'), read('/codex/sessions?limit=1'),
    read('/companion/profile', assistantTimeoutMs)
  ]);
  const checks = [];
  const healthy = health.ok && health.body?.ok === true && health.body?.runtime?.mode === 'desktop';
  checks.push(check('bridge', '本地桥接', healthy ? 'ready' : 'error',
    healthy ? '健康检查通过，使用桌面模式' : health.ok ? '健康或运行模式不符合预期' : failure(health)));
  const live = desktop.ok && desktop.body?.desktop?.desktopLive === true;
  const failureClass = desktop.body?.desktop?.failureClass;
  const restartRequired = !live && ['codex_plain_no_cdp', 'codex_remote_debug_no_cdp'].includes(failureClass);
  const businessFailure = result => restartRequired && [500, 502, 503].includes(result.httpStatus)
    ? `${failure(result)}；本机 Codex 远程接口未就绪，请先恢复桌面连接`
    : failure(result);
  checks.push(check('desktop', 'Codex 桌面连接', live ? 'ready' : restartRequired ? 'blocked' : 'error',
    live ? '桌面实时通道已连接' : restartRequired
      ? '当前 Codex 没有可用的远程连接端口；点击“修复链路”可重启 Codex 并重新连接'
      : desktop.ok ? '桌面通道未连接，可尝试安全修复' : failure(desktop)));
  const readable = sessions.ok && Array.isArray(sessions.body?.sessions);
  checks.push(check('sessions', '普通会话', readable ? 'ready' : 'error',
    readable ? '会话列表读取正常；未验证发送' : sessions.ok ? '会话接口没有返回有效列表' : businessFailure(sessions)));
  let companionResult = profile;
  const assistant = profile.body?.profile;
  const validProfile = profile.ok && typeof assistant?.id === 'string' && assistant.id.trim()
    && typeof assistant?.roomId === 'string' && assistant.roomId.trim();
  if (validProfile) {
    const [messages, computer] = await Promise.all([
      read(`/companion/messages?profileId=${encodeURIComponent(assistant.id)}&roomId=${encodeURIComponent(assistant.roomId)}`,
        assistantTimeoutMs),
      read(`/companion/computer/status?assistantId=${encodeURIComponent(assistant.id)}&roomId=${encodeURIComponent(assistant.roomId)}`,
        assistantTimeoutMs)
    ]);
    companionResult = messages;
    const conversationReadable = messages.ok && Array.isArray(messages.body?.entries);
    checks.push(check('companion', '个人助手会话', conversationReadable ? 'ready' : 'error',
      conversationReadable ? '会话内容读取正常；未验证发送' : messages.ok ? '会话接口没有返回有效内容' : failure(messages)));
    const cloud = computer.body;
    const bound = cloud?.assistantId === assistant.id && cloud?.roomId === assistant.roomId;
    const cloudReady = computer.ok && bound && cloud.ready === true && !!cloud.threadId && !!cloud.environmentId;
    const waiting = computer.ok && bound && cloud.ready === false;
    checks.push(check('computer', '助手云电脑', cloudReady ? 'ready' : waiting ? 'waiting' : 'error',
      cloudReady ? '云环境已就绪；画面与操作仍需进入后验证' : waiting ? '云环境尚未就绪' : computer.ok ? '云电脑返回的助手或环境状态不符合预期' : failure(computer)));
  } else {
    checks.push(check('companion', '个人助手会话', 'error', profile.ok ? '没有有效的个人助手绑定' : businessFailure(profile)));
    checks.push(check('computer', '助手云电脑', 'unknown', '个人助手尚未连接，未继续检测云环境'));
  }
  if (!collectSignals) return { checks, restartRequired };
  const faults = [];
  const add = (id, kind, repairable, component) => faults.push({ id, kind, repairable, component });
  const httpFailureClass = result => result.failureClass
    || ([401, 403].includes(result.httpStatus) ? 'auth'
      : [404, 405].includes(result.httpStatus) ? 'api_compatibility'
        : result.httpStatus === 429 || result.httpStatus >= 500 ? 'upstream' : null);
  const desktopFault = httpFailureClass(desktop)
    || (desktop.ok && desktop.body?.desktop?.desktopLive === false ? 'local_service' : 'unknown');
  const classify = (result, id, component) => {
    if (result.failureClass) return add(id, result.failureClass, false, component);
    if (!live && desktopFault === 'auth') return add(id, 'auth', false, component);
    const explicitFailure = httpFailureClass(result);
    if (explicitFailure && !(explicitFailure === 'upstream' && !live && desktopFault === 'local_service')) {
      return add(id, explicitFailure, false, component);
    }
    if (!live) {
      return add(id, desktopFault, desktopFault === 'local_service', 'desktop');
    }
    if (result.httpStatus >= 500) return add(id, 'upstream', false, component);
    return add(id, 'unknown', false, component);
  };
  if (!healthy) {
    const healthFailure = httpFailureClass(health);
    if (healthFailure) add('bridge', healthFailure, false, 'bridge');
    else if (health.ok) add('bridge', 'unknown', false, 'bridge');
    else add('bridge', health.httpStatus === 0 ? 'transport' : 'unknown', health.httpStatus === 0, 'bridge');
  } else {
    if (!live) classify(desktop, 'desktop', 'desktop');
    if (!readable) classify(sessions, 'sessions', 'sessions');
    const companion = checks.find(check => check.id === 'companion');
    if (companion?.state === 'error') classify(companionResult, 'companion', 'companion');
  }
  return { checks, restartRequired, guardianSignals: { faults } };
}

// Connection-only probes never send an assistant message or start a voice call.
export async function inspectGuardianExtras({ baseUrl, publicBaseUrl = '', getHeaders = () => ({}),
  fetchImpl = fetch, localReady = false, timeoutMs = 6000, probeVoice = probeVoiceUpgrade, includeVoice = true } = {}) {
  const checks = [], faults = [];
  const voiceFault = (id, status, component, repairKind) => ({ id, component,
    kind: [401, 403].includes(status) ? 'auth' : [404, 405].includes(status) ? 'api_compatibility'
      : [0, 502, 503, 504].includes(status) ? repairKind
        : status === 429 || status >= 500 ? 'upstream' : 'unknown',
    repairable: [0, 502, 503, 504].includes(status) });
  let publicReady = false;
  async function read(base, route) {
    try {
      const response = await fetchImpl(base + route, { headers: await getHeaders(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return { status: response.status, ok: response.ok, body: response.ok ? await response.json() : null };
    } catch { return { status: 0, ok: false, body: null }; }
  }
  let publicUrl = null;
  try { publicUrl = publicBaseUrl ? new URL(publicBaseUrl) : null; } catch { /* Invalid configuration is reported below. */ }
  const validPublic = publicUrl && ['http:', 'https:'].includes(publicUrl.protocol)
    && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash;
  if (publicBaseUrl && !validPublic) {
    faults.push({ id: 'public', kind: 'unknown', component: 'public', repairable: false });
    checks.push({ id: 'public', title: '手机公网入口', state: 'unknown', message: '公网入口配置需要检查' });
  } else if (validPublic) {
    const publicRead = await read(publicBaseUrl.replace(/\/$/, ''), '/codex/sessions?limit=1');
    const ready = publicRead.ok && Array.isArray(publicRead.body?.sessions);
    publicReady = ready;
    checks.push({ id: 'public', title: '手机公网入口', state: ready ? 'ready' : localReady ? 'error' : 'unknown',
      message: ready ? '公网入口鉴权与会话读取通过；手机网络状态以最近心跳为准'
        : localReady ? '本机读取正常，公网入口尚未通过' : '本机链路未就绪，公网入口待复核' });
    if (!ready && localReady) faults.push({ id: 'public', kind: [401, 403].includes(publicRead.status) ? 'auth'
      : [0, 502, 503, 504].includes(publicRead.status) ? 'transport' : 'unknown',
      repairable: [0, 502, 503, 504].includes(publicRead.status), component: 'public' });
  } else {
    checks.push({ id: 'public', title: '手机公网入口', state: 'unknown', message: '未配置公网入口，手机网络状态以最近心跳为准' });
  }
  if (includeVoice && localReady) {
    const voice = await read(baseUrl, '/voice/status');
    if (voice.ok && voice.body?.voice?.enabled === true) {
      const result = await probeVoice(baseUrl, await getHeaders(), timeoutMs);
      checks.push({ id: 'voice_transport', title: '语音通道', state: result.ok ? 'ready' : 'error',
        message: result.ok ? '语音通道握手通过；未发起通话，实际声音尚未验证' : '语音通道握手失败，尚未发起通话' });
      if (!result.ok) faults.push(voiceFault('voice_transport', result.status, 'voice', 'local_service'));
      if (result.ok && publicReady) {
        const publicVoice = await probeVoice(publicBaseUrl, await getHeaders(), timeoutMs);
        checks.push({ id: 'voice_public', title: '公网语音通道', state: publicVoice.ok ? 'ready' : 'error',
          message: publicVoice.ok ? '公网语音握手通过；未发送声音，通话体验尚未验证' : '本机语音正常，公网语音握手未通过' });
        if (!publicVoice.ok) faults.push(voiceFault('voice_public', publicVoice.status, 'public', 'transport'));
      }
    } else {
      checks.push({ id: 'voice_transport', title: '语音通道', state: 'unverified',
        message: voice.ok ? '语音服务未启用；未验证通话' : '语音状态暂未读取，待下次检查' });
    }
  }
  return { checks, faults };
}

export function inspectPhoneHeartbeat({ phone, now = Date.now(), recentMs = 120_000 } = {}) {
  const lastSeenAt = typeof phone?.lastSeenAt === 'string' ? phone.lastSeenAt : '';
  const at = Date.parse(lastSeenAt);
  const age = now - at;
  if (!Number.isFinite(at) || !Number.isFinite(age) || age < 0) {
    return { id: 'phone_recent', title: '手机最近连接', state: 'unknown',
      message: '尚无有效手机心跳；手机可能未打开应用，不能据此判断服务故障' };
  }
  const recent = age <= recentMs;
  return { id: 'phone_recent', title: '手机最近连接', state: recent ? 'ready' : 'waiting',
    message: recent ? '最近两分钟内收到手机心跳；当前操作仍需在手机确认'
      : '手机心跳已过期；应用可能未打开或已进入后台，请打开手机应用复核' };
}

// Shared Status/guardian composition. Observational checks never authorize or veto recovery.
export async function inspectMobileLinkStatus({ paused = false, guardianMode = false, voiceState,
  phoneProvider = () => null, resourceProvider, now, ...probeOptions } = {}) {
  const diagnostics = paused ? { checks: [], restartRequired: false }
    : await inspectMobileLink({ ...probeOptions, collectSignals: guardianMode });
  if (!paused) {
    const localReady = ['bridge', 'desktop', 'sessions'].every(id => diagnostics.checks.some(check => check.id === id && check.state === 'ready'));
    const [extras, resources] = await Promise.all([
      inspectGuardianExtras({ ...probeOptions, timeoutMs: 6000, localReady, includeVoice: guardianMode }),
      inspectResources({ resourceProvider })
    ]);
    let phone;
    try { phone = await phoneProvider(); } catch { /* A missing heartbeat is not a repair reason. */ }
    const phoneCheck = inspectPhoneHeartbeat({ phone, now: now ?? Date.now() });
    diagnostics.checks.push(...extras.checks, phoneCheck, resources);
    if (guardianMode) {
      diagnostics.guardianSignals.faults.push(...extras.faults,
        ...classifyVoiceTunnelFault({ voiceState, checks: diagnostics.checks }));
      if (phoneCheck.state !== 'unknown') diagnostics.guardianSignals.phoneLastSeenAt = phone.lastSeenAt;
    }
  }
  const voiceTunnel = { configured: !!voiceState && voiceState !== 'not-configured', running: voiceState === 'Running', state: voiceState };
  return { ...diagnostics, ...summarizeMobileLink({ paused, checks: diagnostics.checks, voiceTunnel }) };
}

function probeVoiceUpgrade(baseUrl, headers, timeoutMs) {
  return new Promise(resolve => {
    const url = new URL('/voice', baseUrl);
    const request = (url.protocol === 'https:' ? https : http).request(url, { headers: { ...headers,
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64') } });
    let finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { finish({ ok: false, status: 0 }); request.destroy(); }, timeoutMs);
    request.on('upgrade', (response, socket) => {
      finish({ ok: response.statusCode === 101, status: response.statusCode });
      // A masked close frame, with no start frame and no microphone samples.
      socket.end(Buffer.from([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]));
      socket.on('error', () => {});
      socket.setTimeout(1000, () => socket.destroy());
    });
    request.on('response', response => { finish({ ok: false, status: response.statusCode }); response.resume(); });
    request.on('error', () => finish({ ok: false, status: 0 }));
    request.end();
  });
}

export function classifyVoiceTunnelFault({ voiceState, checks = [] }) {
  // Scheduler state describes the launcher, not an already running bound tunnel.
  // A successful authenticated public upgrade takes precedence over that snapshot.
  if (checks.some(check => check.id === 'voice_public' && check.state === 'ready')
    || !voiceState || ['Running', 'not-configured', 'unverified'].includes(voiceState)) return [];
  const repairable = ['Ready', 'Disabled', 'forward-failed', 'connection-failed'].includes(voiceState);
  return [{ id: 'voice_tunnel', kind: repairable ? 'transport' : 'unknown', repairable, component: 'voice_tunnel' }];
}

export function summarizeMobileLink({ paused, checks, voiceTunnel }) {
  const result = checks.map(check => ({ ...check }));
  const voiceConfigured = !!voiceTunnel?.configured;
  const voiceState = voiceTunnel?.state;
  const voicePublicReady = checks.some(check => check.id === 'voice_public' && check.state === 'ready');
  const voiceFailed = !voicePublicReady && voiceConfigured && !voiceTunnel?.running && voiceState !== 'unverified';
  const voiceUnknown = !voicePublicReady && voiceConfigured && !voiceTunnel?.running && voiceState === 'unverified';
  result.push({ id: 'voice', title: '语音', state: paused || voiceUnknown ? 'unknown' : voicePublicReady ? 'ready' : voiceFailed ? 'error' : 'unverified',
    message: paused ? '链路已停止，未检测语音'
      : voicePublicReady ? '公网语音握手通过；实际通话和锁屏语音尚未验证'
      : !voiceConfigured ? '未配置独立语音隧道；实际通话尚未验证'
        : voiceState === 'forward-failed' ? '受管 SSH 远端端口转发被拒绝，可能有已有隧道占用；公网语音可用性需另行验证'
          : voiceState === 'connection-failed' ? 'SSH 隧道连接或转发失败，请查看隧道日志'
          : voiceUnknown ? '计划任务在运行，但无法确认 SSH 转发已经建立'
            : voiceTunnel?.running ? 'SSH 反向转发已建立；实际通话和锁屏语音尚未验证'
              : '独立语音隧道任务未运行或绑定异常' });
  const restartRequired = result.some(check => check.id === 'desktop' && check.state === 'blocked');
  const failures = result.filter(check => ['error', 'blocked'].includes(check.state));
  const unknown = result.filter(check => check.state === 'unknown');
  const resourcePressure = result.some(check => check.id === 'resources' && check.state === 'waiting');
  const resourceUnknown = result.some(check => check.id === 'resources' && check.state === 'unknown');
  const phoneWaiting = result.some(check => check.id === 'phone_recent' && ['waiting', 'unknown'].includes(check.state));
  const severity = paused ? 'stopped' : failures.length || resourcePressure ? 'degraded' : unknown.length ? 'unknown' : 'unverified';
  return { severity, summary: paused ? '链路已停止' : failures.length
    ? `连接需要处理：${failures.map(check => check.title).join('、')}${resourcePressure ? '；本机资源不足' : ''}`
    : resourcePressure ? '本机资源不足，请减少并发或关闭不需要的应用'
      : resourceUnknown ? '连接检测已完成，本机内存资源未确认'
        : phoneWaiting ? '读取与连接检测已完成，手机近期连接待确认'
          : unknown.length ? '部分通道尚未检测' : '读取与连接检测通过；发送、通话和远程操作仍需验证',
    nextAction: paused ? 'start' : restartRequired ? 'desktop_restart_required'
      : result.some(check => check.id === 'voice' && check.state === 'error' && ['forward-failed','connection-failed'].includes(voiceState))
        ? 'check_logs' : failures.length ? 'safe_repair' : resourcePressure ? 'check_resources' : 'none',
    checks: result };
}

let failureStage = 'arguments';
async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid bridge port');
  failureStage = 'configuration';
  const configPath = path.join(repo, 'HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets');
  const config = fs.readFileSync(configPath, 'utf8');
  const value = name => config.match(new RegExp(`${name}:\\s*string\\s*=\\s*['"]([^'"]*)['"]`))?.[1] || '';
  const token = value('DEFAULT_BRIDGE_TOKEN');
  const secret = value('DEFAULT_BRIDGE_TOTP_SECRET');
  const headers = {};
  failureStage = 'authentication';
  if (token) headers['X-Codex-Bridge-Token'] = token;
  if (secret) headers['X-Codex-Bridge-OTP'] = generateTotp(secret);
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; };
  const paused = option('--paused') === 'true';
  const voiceState = option('--voice-state');
  failureStage = 'probes';
  const getHeaders = () => secret ? { ...headers, 'X-Codex-Bridge-OTP': generateTotp(secret) } : headers;
  // Execution-time recheck for scoped recovery. It does not start a call, send
  // microphone data, or depend on the assistant/desktop's current busy state.
  if (process.argv.includes('--voice-repair-json')) {
    const extras = await inspectGuardianExtras({ baseUrl: `http://127.0.0.1:${port}`,
      publicBaseUrl: value('DEFAULT_BRIDGE_URL'), getHeaders, localReady: true });
    extras.faults.push(...classifyVoiceTunnelFault({ voiceState, checks: extras.checks }));
    process.stdout.write(JSON.stringify({ checks: extras.checks, guardianSignals: { faults: extras.faults } }));
    return;
  }
  const guardianMode = process.argv.includes('--guardian-json');
  const diagnostics = await inspectMobileLinkStatus({ paused, guardianMode, voiceState,
    baseUrl: `http://127.0.0.1:${port}`, publicBaseUrl: value('DEFAULT_BRIDGE_URL'), headers, getHeaders,
    phoneProvider: () => JSON.parse(fs.readFileSync(path.join(repo, 'logs/state/mobile-link-guardian-phone.json'), 'utf8')) });
  failureStage = 'output';
  process.stdout.write(JSON.stringify(diagnostics));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Deliberately omit raw errors: configuration and authenticated URLs must not reach logs/UI.
    const failureCode = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error?.code) ? error.code : 'unclassified';
    process.stdout.write(JSON.stringify({ severity: 'unknown', summary: '检测工具或本地配置不可用，不能确认通道状态',
      nextAction: 'check_logs', failureStage, failureCode,
      checks: [{ id: 'diagnostics', title: '业务检测', state: 'unknown',
        message: '检测工具或本地配置不可用，不能确认通道状态' }], restartRequired: false }));
  });
}
