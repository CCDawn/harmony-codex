import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGuardian } from '../tools/windows/mobile-link-guardian-policy.mjs';

const enabled = { enabled: true, allowForceRestart: true };
const broken = (component = 'desktop', kind = 'transport') => ({ guardianSignals: { faults: [{ id: component, component, kind, repairable: true }] } });
function tick(state = {}, diagnostics = broken(), extra = {}) {
  return decideGuardian({ config: enabled, state, diagnostics, now: '2026-10-18T00:00:00Z', ...extra });
}
test('requires two consecutive failures and escalates only three rounds before cooldown', () => {
  let r = tick();
  assert.equal(r.action, null);
  r = tick(r.state);
  assert.equal(r.action.stage, 'reconnect');
  r = tick(r.state, broken(), { now: '2026-10-18T00:00:15Z' });
  assert.equal(r.action.stage, 'restart_services');
  r = tick(r.state, broken(), { now: '2026-10-18T00:00:30Z' });
  assert.equal(r.action.stage, 'restart_desktop');
  r = tick(r.state, broken(), { now: '2026-10-18T00:00:45Z' });
  assert.equal(r.action, null);
  assert.equal(r.status.phase, 'cooldown');
  assert.equal(r.status.attempts, 3);
  r = tick(r.state, broken(), { now: '2026-10-18T00:06:00Z' });
  assert.equal(r.action, null);
  assert.equal(r.status.attempts, 0);
});
test('manual stop and disabled take precedence even with an exhausted failure streak', () => {
  for (const extra of [{ paused: true }, { config: { enabled: false } }]) {
    const r = tick({ failures: 10, attempts: 2 }, broken(), extra);
    assert.equal(r.action, null);
    assert.ok(['paused', 'disabled'].includes(r.status.phase));
  }
});
test('normal idle, approval, muted, locked, optional HDC and healthy waiting do not trigger repair', () => {
  const diagnostics = { checks: ['desktop', 'sessions', 'voice', 'hdc', 'computer'].map(id => ({ id, state: 'waiting' })), guardianSignals: { faults: [{ id: 'hdc', component: 'hdc', repairable: true, kind: 'transport' }] } };
  const r = tick({ failures: 1, attempts: 2 }, diagnostics);
  assert.equal(r.action, null);
  assert.equal(r.status.phase, 'healthy');
  assert.equal(r.state.attempts, 2);
  assert.equal(tick(r.state, diagnostics).state.attempts, 0);
});
test('authentication, upstream, compatibility and unknown diagnoses never trigger restarts', () => {
  for (const kind of ['auth', 'account', 'api_compatibility', 'upstream', 'unknown']) {
    const r = tick({ failures: 20, attempts: 2 }, broken('companion', kind));
    assert.equal(r.action, null);
    assert.equal(r.status.phase, 'needs_attention');
  }
  assert.equal(tick({ failures: 2 }, { checks: [{ id: 'sessions', state: 'error' }] }).action, null);
});
test('bridge/public/voice faults cannot escalate to restarting Codex', () => {
  for (const component of ['bridge', 'public', 'voice']) {
    assert.equal(tick({ failures: 2, attempts: 2 }, broken(component)).action.stage, 'restart_services');
  }
  assert.equal(tick({ failures: 2, attempts: 2 }, broken(), { config: { enabled: true, allowForceRestart: false } }).action.stage, 'restart_services');
});
test('public output does not include raw fault text, endpoint, payload or runtime internals', () => {
  const r = tick({}, { guardianSignals: { faults: [{ id: 'desktop', component: 'desktop', kind: 'auth', message: 'secret-token', repairable: true }], token: 'secret-token' } });
  assert.ok(!JSON.stringify(r.status).includes('secret-token'));
  assert.equal(r.status.version, 1);
  assert.ok(r.status.nextCheckAt);
});
test('a changed fault resets its budget and cannot inherit a third-round desktop restart', () => {
  const r = tick({ failures: 2, attempts: 2, faultKey: 'bridge:transport' }, broken());
  assert.equal(r.action, null);
  assert.equal(r.status.attempts, 0);
  assert.equal(r.state.faultKey, 'desktop:transport');
  assert.equal(tick(r.state).action.stage, 'reconnect');
});
test('one healthy tick between failures cannot bypass the three-round budget', () => {
  let r = tick();
  r = tick(r.state);
  for (let attempt = 1; attempt < 3; attempt++) {
    r = tick(r.state, { guardianSignals: { faults: [] } });
    assert.equal(r.state.attempts, attempt);
    r = tick(r.state);
    assert.equal(r.action, null);
    r = tick(r.state);
    assert.equal(r.state.attempts, attempt + 1);
  }
  r = tick(r.state, { guardianSignals: { faults: [] } });
  r = tick(r.state);
  assert.equal(r.action, null);
  assert.equal(r.status.phase, 'cooldown');
});
test('mixed authentication and desktop transport failures never request restarts', () => {
  const diagnostics = { guardianSignals: { faults: [...broken().guardianSignals.faults, ...broken('companion', 'auth').guardianSignals.faults] } };
  const r = tick({ failures: 2, attempts: 2 }, diagnostics);
  assert.equal(r.action, null);
  assert.equal(r.status.phase, 'needs_attention');
});
test('malformed diagnostic signals always require attention and never report healthy or repair', () => {
  for (const guardianSignals of [null, {}, [], { faults: null }, { faults: {} }, { faults: [null] },
    { faults: ['desktop'] }, { faults: [{ component: 'desktop' }] },
    { faults: [{ id: 'x', component: 'unrecognized', kind: 'transport', repairable: true }] },
    { faults: [{ id: 'desktop', component: 'desktop', kind: 'transport', repairable: 'true' }] }]) {
    const r = tick({ failures: 2, attempts: 2 }, { guardianSignals });
    assert.equal(r.action, null);
    assert.equal(r.status.phase, 'needs_attention');
  }
});
test('duplicate same-component signals do not reset repair budgets or duplicate public faults', () => {
  const fault = broken().guardianSignals.faults[0];
  const r = tick({ failures: 2, attempts: 1, faultKey: 'desktop:transport' }, { guardianSignals: { faults: [fault, { ...fault, id: 'desktop-read' }] } });
  assert.equal(r.action.stage, 'restart_services');
  assert.equal(r.state.attempts, 2);
  assert.equal(r.status.faults.length, 1);
});
