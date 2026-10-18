import { fileURLToPath } from 'node:url';
import path from 'node:path';

const titles = { bridge: '本地桥接', desktop: 'Codex 桌面连接', sessions: '普通会话', companion: '个人助手会话', public: '公网连接', voice: '语音隧道' };
const repairKinds = new Set(['transport', 'process', 'local_service']);
const manualKinds = { auth: '身份验证失败，请检查配对或登录', account: '账号状态需要处理', api_compatibility: '接口版本不兼容，请更新组件', upstream: '上游服务异常，请稍后重试', unknown: '故障原因尚未确认，请查看检测结果' };
export function decideGuardian({ config = {}, state = {}, diagnostics = {}, paused = false, now = new Date().toISOString() } = {}) {
  const time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid clock');
  const at = new Date(time).toISOString();
  const next = { failures: Number(state.failures) || 0, attempts: Number(state.attempts) || 0,
    successes: Number(state.successes) || 0, faultKey: state.faultKey || null,
    cooldownUntil: state.cooldownUntil || null, lastSuccessAt: state.lastSuccessAt || null, lastRepairAt: state.lastRepairAt || null };
  // Only the read-only diagnostic classifier authorizes repair. Unknown errors never do.
  const signals = diagnostics.guardianSignals;
  const validSignals = signals && typeof signals === 'object' && !Array.isArray(signals)
    && Array.isArray(signals.faults) && signals.faults.length <= 64
    && signals.faults.every(f => f && typeof f === 'object' && !Array.isArray(f)
      && typeof f.id === 'string' && !!f.id && typeof f.kind === 'string'
      && typeof f.repairable === 'boolean' && typeof f.component === 'string'
      && (Object.hasOwn(titles, f.component) || ['hdc', 'phone_debug', 'computer'].includes(f.component)));
  const inputFaults = validSignals ? signals.faults : [];
  const faults = inputFaults.filter(f => Object.hasOwn(titles, f.component || f.id)).map(f => {
    const component = f.component || f.id;
    const kind = repairKinds.has(f.kind) || Object.hasOwn(manualKinds, f.kind) ? f.kind : 'unknown';
    return { id: component, title: titles[component], state: 'error', kind, component,
      repairable: f.repairable === true && repairKinds.has(kind),
      message: manualKinds[kind] || '连接或受管服务未就绪，等待自动恢复' };
  });
  const faultKey = [...new Set(faults.filter(f => f.repairable).map(f => `${f.component}:${f.kind}`))].sort().join('|');
  if (faultKey && next.faultKey && faultKey !== next.faultKey) {
    next.failures = 0; next.attempts = 0; next.cooldownUntil = null; next.successes = 0;
  }
  if (faultKey) next.faultKey = faultKey;
  if (faults.length) next.successes = 0;
  let phase = 'healthy', summary = '连接检测通过，自动守护中', action = null;
  if (!config.enabled || paused) {
    phase = config.enabled ? 'paused' : 'disabled';
    summary = config.enabled ? '链路已手动停止；守护开关已保存，等待手动启动' : '自动守护已关闭';
    next.failures = 0; next.attempts = 0; next.cooldownUntil = null; next.successes = 0; next.faultKey = null;
  } else if (!validSignals) {
    phase = 'needs_attention'; summary = '连接检测不可用，等待下次检测'; next.failures = 0; next.successes = 0;
  } else if (!faults.length) {
    next.failures = 0; next.successes += 1; next.lastSuccessAt = at;
    if (next.successes >= 2) { next.attempts = 0; next.cooldownUntil = null; next.faultKey = null; }
  } else if (faults.some(f => !f.repairable)) {
    phase = 'needs_attention'; summary = '检测到需要手动处理的问题，自动守护继续检测'; next.failures = 0; next.successes = 0;
  } else if (next.cooldownUntil && time < new Date(next.cooldownUntil).getTime()) {
    phase = 'cooldown'; summary = '三轮恢复后仍未通过；暂停五分钟，请查看检测结果';
  } else if (next.attempts >= 3) {
    if (next.cooldownUntil) {
      next.attempts = 0; next.failures = 1; next.cooldownUntil = null;
      phase = 'suspect'; summary = '冷却结束，正在重新确认故障';
    } else {
      next.cooldownUntil = new Date(time + 300_000).toISOString(); phase = 'cooldown';
      summary = '三轮恢复后仍未通过；暂停五分钟，请查看检测结果';
    }
  } else {
    next.successes = 0;
    next.failures += 1;
    if (next.failures < 2) {
      phase = 'suspect'; summary = '检测到连接异常，等待第二次检测确认';
    } else {
      const components = [...new Set(faults.filter(f => f.repairable).map(f => f.component))];
      const stage = next.attempts === 0 ? 'reconnect' : next.attempts === 2 && config.allowForceRestart === true && components.some(c => ['desktop', 'sessions', 'companion'].includes(c)) ? 'restart_desktop' : 'restart_services';
      next.attempts += 1; next.lastRepairAt = at;
      action = { stage, components }; phase = 'repairing';
      summary = stage === 'restart_desktop' ? '正在重启 Codex 并恢复桌面连接' : stage === 'restart_services' ? '正在恢复故障服务' : '正在重新连接';
    }
  }
  return { state: next, action, status: { version: 1, enabled: !!config.enabled, phase, summary,
    checkedAt: at, heartbeatAt: at, lastSuccessAt: next.lastSuccessAt, lastRepairAt: next.lastRepairAt,
    attempts: next.attempts, nextCheckAt: new Date(time + 15_000).toISOString(),
    faults: [...new Map(faults.map(({ id, title, state, message }) => [id, { id, title, state, message }])).values()], history: [] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 262144) throw new Error('Input too large'); }
    process.stdout.write(JSON.stringify(decideGuardian(JSON.parse(input))));
  } catch { process.stdout.write(JSON.stringify({ error: 'Guardian decision unavailable' })); process.exitCode = 1; }
}
