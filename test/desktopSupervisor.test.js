import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutoRelaunchMissingCodex,
  evaluateSupervisorArm
} from '../src/desktopSupervisor.js';

const now = Date.parse('2026-09-27T04:00:00.000Z');

test('supervisor arm accepts a fresh heartbeat from a live process', () => {
  const arm = evaluateSupervisorArm({
    pid: 42,
    heartbeatAt: '2026-09-27T03:59:50.000Z'
  }, { now, isPidAlive: (pid) => pid === 42 });
  assert.equal(arm.armed, true);
});

test('supervisor arm rejects a stale heartbeat and a dead process', () => {
  assert.equal(evaluateSupervisorArm({
    pid: 42,
    heartbeatAt: '2026-09-27T03:59:00.000Z'
  }, { now, isPidAlive: () => true }).armed, false);
  assert.equal(evaluateSupervisorArm({
    pid: 42,
    heartbeatAt: '2026-09-27T03:59:50.000Z'
  }, { now, isPidAlive: () => false }).reason, 'dead');
});

test('missing Codex relaunch follows the desktop app switch', () => {
  const missing = { desktopLive: false, desktopProcessMode: 'missing', failureClass: 'codex_not_running' };
  const plain = { desktopLive: false, desktopProcessMode: 'plain', failureClass: 'codex_plain_no_cdp' };
  const live = { desktopLive: true, desktopProcessMode: 'cdp', failureClass: 'none' };
  assert.equal(canAutoRelaunchMissingCodex(missing, { armed: true }), true);
  assert.equal(canAutoRelaunchMissingCodex(missing, { armed: false }), false);
  assert.equal(canAutoRelaunchMissingCodex(plain, { armed: true }), false);
  assert.equal(canAutoRelaunchMissingCodex(live, { armed: true }), false);
  assert.equal(canAutoRelaunchMissingCodex({
    desktopLive: false,
    desktopProcessMode: 'plain',
    failureClass: 'codex_not_running'
  }, { armed: true }), false);
});
