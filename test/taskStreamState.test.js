import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const code = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/TaskStreamState.ets', 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(code + '\nglobalThis.apply=taskWithStreamEvents;globalThis.needsSnapshot=taskStreamNeedsSnapshot;'), context);

test('fresh stream events advance the live bubble time without changing task creation or execution metadata', () => {
  const task = { id: 'task-1', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:01Z',
    events: [], status: 'running', activeCodexTurnId: 'turn', pendingUserInput: { id: 'question' } };
  const event = { seq: 1, createdAt: '2026-10-22T00:00:05Z', payload: {} };
  const next = context.apply(task, [event], 1);
  assert.equal(next.updatedAt, event.createdAt);
  assert.equal(next.createdAt, task.createdAt);
  assert.equal(next.status, 'running');
  assert.equal(next.pendingUserInput, task.pendingUserInput);
  assert.equal(next.activeCodexTurnId, 'turn');
  assert.equal(task.updatedAt, '2026-10-22T00:00:01Z');
  assert.equal(context.apply(next, [{ ...event, createdAt: task.updatedAt }], 2).updatedAt, event.createdAt);
  assert.equal(context.apply(next, [], 0).updatedAt, event.createdAt);
});

test('append-only body changes do not fetch metadata; status and interaction changes still recover', () => {
  const event = method => ({ type: 'codex.desktop_live.notification', payload: { method } });
  for (const method of ['item/agentMessage/delta', 'item/commandExecution/outputDelta',
    'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded',
    'item/started', 'item/completed']) {
    assert.equal(context.needsSnapshot(event(method)), false, method);
  }
  for (const method of ['turn/started', 'turn/completed', 'thread/status/changed',
    'thread/settings/updated', 'item/commandExecution/requestApproval', 'item/tool/requestUserInput']) {
    assert.equal(context.needsSnapshot(event(method)), true, method);
  }
  for (const type of ['task.completed', 'task.waiting_input', 'approval.requested', 'task.failed']) {
    assert.equal(context.needsSnapshot({ type, payload: {} }), true, type);
  }
});
