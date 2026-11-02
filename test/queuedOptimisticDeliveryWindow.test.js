import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/services/';
const source = ['OptimisticMessageService.ets', 'OutboxMessagePresentation.ets'].map(name =>
  fs.readFileSync(root + name, 'utf8').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')
).join('\n');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source + '\nglobalThis.api = {' +
  'markOptimisticSessionSubmitted, reconcileOptimisticSessionMessages, stableCanonicalMessageKey, restoreOutboxMessages, outboxMessageLabel, ' +
  'outboxTaskMessageLabel: typeof outboxTaskMessageLabel === "function" ? outboxTaskMessageLabel : undefined };'), context);
const { markOptimisticSessionSubmitted: mark, reconcileOptimisticSessionMessages: reconcile,
  stableCanonicalMessageKey: key, restoreOutboxMessages: restore, outboxMessageLabel: label,
  outboxTaskMessageLabel: taskLabel } = context.api;
const at = seconds => new Date(Date.UTC(2026, 9, 23, 1, 0, seconds)).toISOString();
const local = (id = 'send', extra = {}) => ({ id, submissionId: id, sessionId: 'thread', isNewSession: false,
  projectId: 'project', text: 'hello', images: [], files: [], createdAt: at(0), state: 'submitted',
  submittedText: 'hello', baselineEntryKeys: [], ...extra });
const official = (seconds = 961, extra = {}) => ({ role: 'user', type: 'response_item', text: 'hello',
  threadId: 'thread', timestamp: at(seconds), syncId: 'official-user', ...extra });
const submit = (message, extra = {}) => mark([message], message.submissionId,
  { sessionId: 'thread', taskId: 'real-task', text: 'hello', ...extra })[0];
const outbox = (extra = {}) => ({ id: 'outbox-one', submissionId: 'send', threadId: 'thread', projectId: 'project',
  resultId: '', status: 'dispatching', text: 'hello', createdAt: at(0), lastAttemptAt: at(960), ...extra });

test('a valid delivery attempt retires a message queued over fifteen minutes without changing its send time', () => {
  const original = local();
  const accepted = submit(original, { deliveryAttemptAt: at(960) });
  assert.equal(accepted.deliveryAttemptAt, at(960));
  assert.equal(accepted.createdAt, at(0));
  assert.equal(original.deliveryAttemptAt, undefined);
  assert.equal(reconcile([accepted], 'thread', [official()]).length, 0);
});

test('missing or invalid delivery attempts retain the original bounded fallback window', () => {
  for (const attempt of [undefined, '', 'invalid date']) {
    const message = submit(local(), { deliveryAttemptAt: attempt });
    assert.equal(message.deliveryAttemptAt, undefined);
    assert.equal(reconcile([message], 'thread', [official()]).length, 1);
    assert.equal(reconcile([message], 'thread', [official(899)]).length, 0);
  }
  assert.equal(reconcile([local('invalid-existing', { deliveryAttemptAt: 'invalid date' })], 'thread', [official()]).length, 1);
});

test('the delivery anchor still rejects history older than its skew allowance or later than fifteen minutes', () => {
  const message = submit(local(), { deliveryAttemptAt: at(960) });
  assert.equal(reconcile([message], 'thread', [official(839)]).length, 1);
  assert.equal(reconcile([message], 'thread', [official(1861)]).length, 1);
  const withoutBaseline = { ...message, baselineEntryKeys: undefined };
  assert.equal(reconcile([withoutBaseline], 'thread', [official(959)]).length, 1);
});

test('a delivery attempt never overrides baselines, conflicting identities or the target thread', () => {
  const history = official(959);
  const message = submit(local('send', { baselineEntryKeys: [key(history)] }), { deliveryAttemptAt: at(960) });
  assert.equal(reconcile([message], 'thread', [history]).length, 1);
  assert.equal(reconcile([message], 'thread', [official(961, { submissionId: 'other-send' })]).length, 1);
  assert.equal(reconcile([message], 'thread', [official(961, { threadId: 'other-thread' })]).length, 1);
  const identified = { ...message, itemId: 'expected-item', turnId: 'expected-turn' };
  assert.equal(reconcile([identified], 'thread', [official(961, { itemId: 'other-item' })]).length, 1);
  assert.equal(reconcile([identified], 'thread', [official(961, { turnId: 'other-turn' })]).length, 1);
});

test('one canonical message consumes only one identical queued send across repeated reconciliation', () => {
  const messages = ['first', 'second'].map(id => submit(local(id), { deliveryAttemptAt: at(960) }));
  const remaining = reconcile(messages, 'thread', [official()]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].submissionId, 'second');
  assert.equal(remaining[0].deliveryAttemptAt, at(960));
  assert.equal(reconcile(remaining, 'thread', [official()]).length, 1);
});

test('acknowledgement and reconciliation copies preserve valid attempts when later input is absent or invalid', () => {
  const original = local('send', { deliveryAttemptAt: at(960), images: [{ id: 'image', uri: 'local://image' }], files: [{ id: 'file' }] });
  for (const attempt of [undefined, '', 'invalid date']) {
    const copy = submit(original, { deliveryAttemptAt: attempt });
    assert.equal(copy.deliveryAttemptAt, at(960));
    assert.equal(copy.createdAt, original.createdAt);
    assert.deepEqual(copy.images, original.images);
    assert.deepEqual(copy.files, original.files);
  }
  assert.equal(submit(original, { deliveryAttemptAt: at(1200) }).deliveryAttemptAt, at(1200));
  assert.equal(original.deliveryAttemptAt, at(960));
});

test('restored outbox messages use only valid actual attempts and retain their original creation time', () => {
  const restored = restore([], [outbox()], 'thread');
  assert.equal(restored[0].deliveryAttemptAt, at(960));
  assert.equal(restored[0].createdAt, at(0));
  assert.equal(reconcile(restored, 'thread', [official()]).length, 0);
  for (const attempt of [undefined, '', 'invalid date']) {
    assert.equal(restore([], [outbox({ lastAttemptAt: attempt })], 'thread')[0].deliveryAttemptAt, undefined);
  }
});

test('an actual host delivery attempt cannot consume identical history from before dispatch', () => {
  const restored=restore([], [outbox()], 'thread');
  assert.equal(restored[0].baselineEntryKeys, undefined);
  assert.equal(reconcile(restored, 'thread', [official(900)]).length, 1);
  const captured=submit(local(), {deliveryAttemptAt:at(960)});
  assert.equal(reconcile([captured], 'thread', [official(900)]).length, 1);
  assert.equal(reconcile([captured], 'thread', [official(961)]).length, 0);
});

test('outbox refresh enriches an existing matching send without replacing attachments, state or metadata', () => {
  const message = local('send', { state: 'sending', taskId: 'original-task', turnId: 'original-turn', itemId: 'original-item',
    images: [{ id: 'image', uri: 'local://image' }], files: [{ id: 'file' }], baselineEntryKeys: ['old-history'],
    restoredFromOutbox: false });
  const result = restore([message], [outbox()], 'thread');
  assert.equal(result.length, 1);
  assert.equal(result[0].deliveryAttemptAt, at(960));
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), { ...message, deliveryAttemptAt: at(960) });
  assert.equal(message.deliveryAttemptAt, undefined);
  for (const attempt of [undefined, '', 'invalid date']) {
    assert.equal(restore([message], [outbox({ lastAttemptAt: attempt })], 'thread')[0], message);
  }
});

test('outbox refresh can enrich an existing submitted receipt but never restores a new terminal bubble', () => {
  const message = local();
  const item = outbox({ status: 'submitted', resultId: 'real-task' });
  assert.equal(restore([message], [item], 'thread')[0].deliveryAttemptAt, at(960));
  assert.equal(restore([], [item], 'thread').length, 0);
});

test('outbox enrichment requires both submission and thread identity', () => {
  const otherThread = local('send', { sessionId: 'other-thread' });
  const otherSubmission = local('other-send');
  const result = restore([otherThread, otherSubmission], [outbox()], 'thread');
  assert.equal(result[0], otherThread);
  assert.equal(result[1], otherSubmission);
  assert.equal(result.length, 3);
  assert.equal(result[2].deliveryAttemptAt, at(960));
  assert.equal(restore([local()], [outbox({ threadId: 'other-thread' })], 'thread')[0].deliveryAttemptAt, undefined);
});

test('task and optimistic delivery footers use the same durable outbox state labels', () => {
  const message = local('send', { taskId: 'outbox-one' });
  for (const [state, expected] of [
    ['queued', '排队中'], ['dispatching', '正在确认送达'], ['held', '历史待处理 · 查看队列'],
    ['uncertain', '发送结果待核对 · 查看队列'], ['submitted', '等待送达确认']
  ]) {
    const task = { id: 'outbox-one', runtime: { kind: 'durable_outbox', state }, events: [] };
    assert.equal(taskLabel(task), expected);
    assert.equal(label(message, [], task), expected);
  }
  const blocked = { id: 'outbox-one', runtime: { kind: 'durable_outbox', state: 'queued' },
    events: [{ payload: { message: '前一条消息的发送结果待确认' } }] };
  assert.equal(taskLabel(blocked), '前序消息待处理 · 查看队列');
  assert.equal(label(message, [], blocked), taskLabel(blocked));
  assert.equal(label({ ...message, taskId: 'other-task' }, [], blocked), '等待送达确认');
  assert.equal(taskLabel({ id: 'real-task', events: [] }), '等待送达确认');
});
