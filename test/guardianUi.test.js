import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const index = fs.readFileSync(`${root}pages/Index.ets`, 'utf8');
const clientSource = fs.readFileSync(`${root}services/BridgeClient.ets`, 'utf8');
const settings = fs.readFileSync(`${root}components/SettingsPanel.ets`, 'utf8');
const tray = fs.readFileSync('scripts/windows-launcher/UnifiedTrayContext.cs', 'utf8');

function method(source, name, parameters = '', dependencies = {}) {
  const start = source.search(new RegExp(`^\\s*(?:(?:private|static|async) )*${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  const async = source.slice(start, open).includes('async ');
  const code = stripTypeScriptTypes(`${async ? 'async ' : ''}function run(${parameters}) {${source.slice(open + 1, end - 1)}}`);
  return new Function(...Object.keys(dependencies), `${code}; return run;`)(...Object.values(dependencies));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function status(enabled = false, phase = 'disabled') {
  return { version: 1, enabled, phase, summary: '本机读取结果', faults: [], history: [] };
}

function harness(client = {}, lifecycle = { foreground: true }) {
  const state = {
    guardian: status(), guardianBusy: false, guardianSaving: false, guardianError: '',
    guardianGeneration: 0, guardianRequestSequence: 0, guardianPageVisible: true,
    bridgeUrl: 'https://one.example', bridgeToken: 'one-token', activeTab: 'settings',
    normalizedBridgeUrl() { return this.bridgeUrl; }
  };
  const deps = { BridgeClient: client, CompanionComputerLifecycle: lifecycle };
  state.guardianTargetMatches = method(index, 'guardianTargetMatches', 'url, token, generation, sequence, tab', deps);
  state.refreshGuardianStatus = method(index, 'refreshGuardianStatus', '', deps);
  state.setGuardianEnabled = method(index, 'setGuardianEnabled', 'enabled', deps);
  return state;
}

test('all guardian phases describe observed state without claiming phone or voice acceptance', () => {
  const source = fs.readFileSync(`${root}services/GuardianPresentation.ets`, 'utf8');
  const phase = method(source, 'phaseLabel', 'phase');
  const labels = ['disabled', 'checking', 'healthy', 'suspect', 'repairing', 'cooldown', 'needs_attention', 'paused', 'unknown'].map(phase);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(phase('healthy'), '读取健康');
  assert.equal(phase('new-future-phase'), '状态未确认');
  assert.doesNotMatch(labels.join(' '), /全部正常|语音已验收/);
});

test('guardian timestamps use the phone local calendar and handle absent or invalid values', () => {
  const source = fs.readFileSync(`${root}services/GuardianPresentation.ets`, 'utf8');
  const localTime = method(source, 'localTime', "value, missing = '时间未记录'");
  for (const input of ['2026-10-18T00:02:03.000Z', '2026-10-18T23:59:02-07:00']) {
    const local = new Date(input);
    const pad = value => String(value).padStart(2, '0');
    const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
    assert.equal(localTime(input), expected);
    assert.doesNotMatch(localTime(input), /T|Z/);
  }
  assert.equal(localTime('', '尚未检查'), '尚未检查');
  assert.equal(localTime(null, '暂无修复'), '暂无修复');
  assert.equal(localTime(undefined, '尚未安排'), '尚未安排');
  assert.equal(localTime('  '), '时间未记录');
  assert.equal(localTime('not-a-timestamp'), '时间未确认');
});

test('guardian history localizes all worker actions and outcomes without claiming repair success', () => {
  const source = fs.readFileSync(`${root}services/GuardianPresentation.ets`, 'utf8');
  const action = method(source, 'actionLabel', 'action');
  const outcome = method(source, 'outcomeLabel', 'outcome');
  assert.deepEqual(['reconnect', 'restart_services', 'restart_desktop'].map(action), ['重新连接', '恢复故障服务', '重启 Codex']);
  assert.deepEqual(['requested', 'skipped', 'unconfirmed'].map(outcome), ['已执行，等待复查', '已取消', '完成情况未确认']);
  assert.equal(action(''), '其他处理');
  assert.equal(outcome('new-outcome'), '结果待确认');
  assert.doesNotMatch(outcome('requested'), /成功|已恢复/);
  assert.match(settings, /GuardianPresentation.localTime\(this.guardian.checkedAt, '尚未检查'\)/);
  assert.match(settings, /GuardianPresentation.localTime\(this.guardian.lastRepairAt, '暂无修复'\)/);
  assert.match(settings, /GuardianPresentation.localTime\(this.guardian.nextCheckAt, '尚未安排'\)/);
  assert.match(settings, /GuardianPresentation.localTime\(entry.at\)/);
  assert.match(settings, /GuardianPresentation.actionLabel\(entry.action\)/);
  assert.match(settings, /GuardianPresentation.outcomeLabel\(entry.outcome\)/);
});

test('failed mode save retains confirmed mode and shows an actionable error', async () => {
  const state = harness({ async setGuardianEnabled() { throw Error('offline'); } });
  const previous = state.guardian;
  await state.setGuardianEnabled(true);
  assert.equal(state.guardian, previous);
  assert.equal(state.guardian.enabled, false);
  assert.match(state.guardianError, /未确认/);
  assert.equal(state.guardianSaving, false);
});

test('successful mode save uses returned state and suppresses polling during the write', async () => {
  const pending = deferred();
  let reads = 0;
  const state = harness({ setGuardianEnabled() { return pending.promise; }, async getGuardianStatus() { reads++; } });
  const saving = state.setGuardianEnabled(true);
  assert.equal(state.guardian.enabled, false);
  assert.equal(state.guardianSaving, true);
  await state.refreshGuardianStatus();
  assert.equal(reads, 0);
  pending.resolve(status(true, 'checking'));
  await saving;
  assert.equal(state.guardian.enabled, true);
  assert.equal(state.guardian.phase, 'checking');
});

test('late reads cannot update another URL, token, navigation generation or background page', async () => {
  for (const change of [s => s.bridgeUrl = 'https://two.example', s => s.bridgeToken = 'new-token',
    s => s.guardianGeneration++, s => s.activeTab = 'sessions', s => s.guardianPageVisible = false]) {
    const pending = deferred();
    const state = harness({ getGuardianStatus() { return pending.promise; } });
    const previous = state.guardian;
    const reading = state.refreshGuardianStatus();
    change(state);
    pending.resolve(status(true, 'repairing'));
    await reading;
    assert.equal(state.guardian, previous);
    assert.equal(state.guardianError, '');
  }
});

test('late write after navigation cannot replace status from the current request', async () => {
  const pending = deferred();
  const state = harness({ setGuardianEnabled() { return pending.promise; } });
  const saving = state.setGuardianEnabled(true);
  state.guardianGeneration++;
  state.guardian = status(false, 'paused');
  pending.resolve(status(true, 'checking'));
  await saving;
  assert.equal(state.guardian.phase, 'paused');
  assert.equal(state.guardianSaving, false);
});

test('an old failed read cannot clear a newer read or replace its current error', async () => {
  const first = deferred(), second = deferred();
  let requests = 0;
  const state = harness({ getGuardianStatus() { return ++requests === 1 ? first.promise : second.promise; } });
  const readingOld = state.refreshGuardianStatus();
  state.guardianGeneration++;
  state.guardianRequestSequence++;
  state.guardianBusy = false;
  const readingNew = state.refreshGuardianStatus();
  first.reject(Error('old target offline'));
  await readingOld;
  assert.equal(state.guardianBusy, true);
  assert.equal(state.guardianError, '');
  second.resolve(status(true, 'healthy'));
  await readingNew;
  assert.equal(state.guardian.phase, 'healthy');
  assert.equal(state.guardianBusy, false);
});

test('phone background suspends reads and mode writes without changing desktop mode', async () => {
  let calls = 0;
  const state = harness({ getGuardianStatus() { calls++; }, setGuardianEnabled() { calls++; } }, { foreground: false });
  await state.refreshGuardianStatus();
  await state.setGuardianEnabled(true);
  assert.equal(calls, 0);
  assert.equal(state.guardian.enabled, false);
  assert.match(index, /onPageHide\(\): void \{\s*this.guardianPageVisible = false;\s*this.stopGuardianRefresh\(\)/);
});

test('read failure retains prior data but makes its current freshness unconfirmed', async () => {
  const state = harness({ async getGuardianStatus() { throw Error('private diagnostic'); } });
  await state.refreshGuardianStatus();
  assert.equal(state.guardian.enabled, false);
  assert.match(state.guardianError, /读取失败/);
  assert.doesNotMatch(state.guardianError, /private diagnostic/);
  assert.equal(state.guardianBusy, false);
});

test('guardian API sends phone heartbeat on GET and only enabled on PUT', async () => {
  const requests = [];
  const bridge = {
    async request(...args) { requests.push(args); return JSON.stringify({ guardian: status(true, 'checking') }); },
    parseGuardianStatus: method(clientSource, 'parseGuardianStatus', 'raw')
  };
  const deps = { BridgeClient: bridge, http: { RequestMethod: { GET: 'GET', PUT: 'PUT' } },
    GuardianUpdatePayload: class { constructor(enabled) { this.enabled = enabled; } } };
  await method(clientSource, 'getGuardianStatus', 'baseUrl, token', deps)('https://one.example', 'token');
  await method(clientSource, 'setGuardianEnabled', 'baseUrl, token, enabled', deps)('https://one.example', 'token', true);
  assert.equal(requests[0][1], 'https://one.example/system/guardian?client=phone');
  assert.equal(requests[1][0], 'PUT');
  assert.deepEqual(JSON.parse(requests[1][2]), { enabled: true });
  bridge.request = async () => JSON.stringify({ guardian: status(false) });
  await assert.rejects(method(clientSource, 'setGuardianEnabled', 'baseUrl, token, enabled', deps)('url', 'token', true), /未确认/);
  assert.throws(() => bridge.parseGuardianStatus('{}'), /状态格式不完整/);
});

test('UI preserves manual maintenance actions and exposes force restart policy without another approval', () => {
  for (const action of ['soft_repair', 'hard_restart', 'desktop_monitor', 'outbox']) assert.match(settings, new RegExp(`this.Action\\('${action}'`));
  assert.match(settings, /必要时会强制重启 Codex，可能中断任务和通话/);
  assert.match(tray, /必要时会强制重启 Codex，可能中断任务和通话/);
  assert.match(tray, /ExecuteGuardian\("Ensure", false\)/);
  assert.match(tray, /Task.Run\(delegate[\s\S]*mobile-link-guardian.ps1/);
});
