import { fileURLToPath } from 'node:url';
import path from 'node:path';

const titles = { bridge: '本地桥接', desktop: 'Codex 桌面连接', sessions: '普通会话', companion: '个人助手会话', public: '公网连接', voice: '本机语音服务', voice_tunnel: '语音隧道' };
const repairKinds = new Set(['transport', 'process', 'local_service']);
const manualKinds = { auth: '身份验证失败，请检查配对或登录', account: '账号状态需要处理', api_compatibility: '接口版本不兼容，请更新组件', upstream: '上游服务异常，请稍后重试', unknown: '故障原因尚未确认，请查看检测结果' };
const count = value => Math.max(0, Math.min(3, Math.floor(Number(value) || 0)));
const budget = value => ({ failures: count(value?.failures), attempts: count(value?.attempts),
  cooldownUntil: Number.isFinite(Date.parse(value?.cooldownUntil)) ? value.cooldownUntil : null });
export function decideGuardian({ config = {}, state = {}, diagnostics = {}, paused = false, now = new Date().toISOString() } = {}) {
  const time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid clock');
  const at = new Date(time).toISOString();
  const next = { failures: Number(state.failures) || 0, attempts: Number(state.attempts) || 0,
    successes: Number(state.successes) || 0, faultKey: state.faultKey || null,
    cooldownUntil: state.cooldownUntil || null, lastSuccessAt: state.lastSuccessAt || null, lastRepairAt: state.lastRepairAt || null,
    // Worker-owned cheap-probe streak rides through untouched; only a stopped
    // or disabled guardian clears it.
    bridgeQuickStreak: Math.max(0, Math.min(64, Math.floor(Number(state.bridgeQuickStreak) || 0))) };
  // Budgets belong to components, so a flapping neighbour or a revised diagnosis
  // cannot reset a continuing fault. Migrate only identities known by old state.
  const budgets = {};
  const hasBudgets = state.componentBudgets && typeof state.componentBudgets === 'object' && !Array.isArray(state.componentBudgets);
  if (hasBudgets) {
    for (const component of Object.keys(titles)) {
      if (Object.hasOwn(state.componentBudgets, component)) budgets[component] = budget(state.componentBudgets[component]);
    }
  } else if (typeof state.faultKey === 'string') {
    for (const key of state.faultKey.split('|')) {
      const component = key.split(':')[0];
      if (Object.hasOwn(titles, component)) budgets[component] = budget(state);
    }
  }
  next.componentBudgets = budgets;
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
  if (validSignals && faults.length) {
    const present = new Set(faults.map(f => f.component));
    for (const component of Object.keys(budgets)) if (!present.has(component)) delete budgets[component];
    for (const component of present) {
      if (!Object.hasOwn(budgets, component)) {
        // Very old anonymous counters cannot authorize a third-round desktop
        // restart. Retain at most the first recovery round for compatibility.
        budgets[component] = !hasBudgets && !state.faultKey
          ? { ...budget(state), attempts: Math.min(1, count(state.attempts)) } : budget();
      }
    }
  }
  if (faultKey) next.faultKey = faultKey;
  if (faults.length) next.successes = 0;
  let phase = 'healthy', summary = '连接检测通过，自动守护中', action = null;
  if (!config.enabled || paused) {
    phase = config.enabled ? 'paused' : 'disabled';
    summary = config.enabled ? '链路已手动停止；守护开关已保存，等待手动启动' : '自动守护已关闭';
    next.failures = 0; next.attempts = 0; next.cooldownUntil = null; next.successes = 0; next.faultKey = null;
    next.componentBudgets = {}; next.bridgeQuickStreak = 0;
  } else if (!validSignals) {
    phase = 'needs_attention'; summary = '连接检测不可用，等待下次检测'; next.failures = 0; next.successes = 0;
    for (const value of Object.values(budgets)) value.failures = 0;
  } else if (!faults.length) {
    next.failures = 0; next.successes += 1; next.lastSuccessAt = at;
    for (const value of Object.values(budgets)) value.failures = 0;
    // Require two healthy snapshots before clearing the entire incident.
    if (next.successes >= 2) { next.attempts = 0; next.cooldownUntil = null; next.faultKey = null; next.componentBudgets = {}; }
  } else if (faults.some(f => !f.repairable)) {
    phase = 'needs_attention'; summary = '检测到需要手动处理的问题，自动守护继续检测'; next.failures = 0; next.successes = 0;
    for (const value of Object.values(budgets)) value.failures = 0;
  } else {
    next.successes = 0;
    const ready = [];
    for (const [component, value] of Object.entries(budgets)) {
      if (value.cooldownUntil && time < Date.parse(value.cooldownUntil)) continue;
      if (value.attempts >= 3) {
        if (value.cooldownUntil) {
          value.attempts = 0; value.failures = 1; value.cooldownUntil = null;
        } else value.cooldownUntil = new Date(time + 300_000).toISOString();
        continue;
      }
      value.failures += 1;
      if (value.failures < 2) continue;
      const stage = value.attempts === 0 ? 'reconnect' : value.attempts === 2 && config.allowForceRestart === true && ['desktop', 'sessions', 'companion'].includes(component) ? 'restart_desktop' : 'restart_services';
      ready.push({ component, stage });
    }
    if (ready.length) {
      const stages = ['reconnect', 'restart_services', 'restart_desktop'];
      const stage = stages[Math.max(...ready.map(value => stages.indexOf(value.stage)))];
      // Never include a new or cooling component in another component's
      // escalated recovery. Each selected component consumes its own round.
      const components = ready.filter(value => value.stage === stage).map(value => value.component);
      // A reconnect round cannot help the bridge (its repair path is gated on
      // restart_services), so a bridge-only selection starts the real repair;
      // mixed selections keep the shared reconnect first round.
      const finalStage = stage === 'reconnect' && components.length && components.every(component => component === 'bridge')
        ? 'restart_services' : stage;
      for (const component of components) budgets[component].attempts += 1;
      next.lastRepairAt = at;
      action = { stage: finalStage, components }; phase = 'repairing';
      summary = finalStage === 'restart_desktop' ? '正在重启 Codex 并恢复桌面连接' : finalStage === 'restart_services' ? '正在恢复故障服务' : '正在重新连接';
    } else if (Object.values(budgets).some(value => value.cooldownUntil)) {
      phase = 'cooldown'; summary = '三轮恢复后仍未通过；暂停五分钟，请查看检测结果';
    } else {
      phase = 'suspect'; summary = '检测到连接异常，等待第二次检测确认';
    }
  }
  if (validSignals && faults.length && config.enabled && !paused) {
    next.failures = Math.max(0, ...Object.values(budgets).map(value => value.failures));
    next.attempts = Math.max(0, ...Object.values(budgets).map(value => value.attempts));
    next.cooldownUntil = Object.values(budgets).map(value => value.cooldownUntil).filter(Boolean).sort()[0] || null;
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
