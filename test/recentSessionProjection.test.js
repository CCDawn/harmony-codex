import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { projectCanonicalSessionTail, mergeRecentSessionProjection } from '../src/recentSessionProjection.js';
import { DesktopInteractionClient } from '../src/desktopInteractionClient.js';
import { CodexThreadService } from '../src/codexThreadService.js';

const threadId = 'thread-1';
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] });
const turn = (id, startedAt, text = id) => ({ id, status: 'completed', startedAt, items: [user('item-' + id, text)] });
const native = (id, at, items, extra = {}) => ({ turnId: id, turnStartedAtMs: at * 1000, status: 'completed', items, ...extra });
const conversation = (...turns) => ({ id: threadId, params: { private: 'PRIVATE_MANAGER_PARAMS' }, turnHistory: {
  kind: 'canonical', history: { islands: [{ entries: turns.map((_, i) => ({ value: String(i) })) }],
    entitiesByKey: Object.fromEntries(turns.map((t, i) => [String(i), t])) }
} });
const projected = (...turns) => projectCanonicalSessionTail(conversation(...turns), threadId);

test('complete native failed message and synthetic error map to an official turn without exposing manager fields', () => {
  const error = { message: 'Provider rejected request', codexErrorInfo: 'other' };
  const result = projected(native('old', 1, [{ type: 'commandExecution' }]),
    native('new', 2, [user('user-native', 'FOLD_FIXTURE'),
      { id: 'error-native', type: 'error', message: error.message, errorInfo: 'other', willRetry: false }], { status: 'failed', error }));
  assert.equal(result.threadId, threadId);
  assert.equal(result.source, 'mounted-canonical');
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].items, [user('user-native', 'FOLD_FIXTURE')]);
  assert.deepEqual(result.turns[0].error, error);
  assert.equal(result.boundary.id, 'old');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MANAGER_PARAMS|params|error-native/);
});

test('unsupported, oversized, noncanonical and wrong-thread candidates never return partial turns', () => {
  const cases = [
    conversation(native('n', 2, [user('u', 'kept?'), { id: 'tool', type: 'commandExecution' }])),
    conversation(native('n', 2, [user('u', 'x'.repeat(1000))])),
    { id: threadId, turns: [native('n', 2, [user('u', 'optimistic')])] },
    { ...conversation(native('n', 2, [user('u', 'other')])), id: 'other-thread' }
  ];
  for (const value of cases) {
    const result = projectCanonicalSessionTail(value, threadId, { maxBytes: 512 });
    assert.deepEqual(result.turns, []);
    assert.ok(result.diagnostic);
  }
});

test('native projection never crosses canonical islands or silently truncates an item budget', () => {
  const c = conversation(native('older', 1, [user('u1', 'older')]), native('newer', 3, [user('u2', 'newer')]));
  c.turnHistory.history.islands = [{ entries: [{ value: '0' }] }, { entries: [{ value: '1' }] }];
  const result = projectCanonicalSessionTail(c, threadId);
  assert.deepEqual(result.turns.map(t => t.id), ['newer']);
  assert.equal(result.boundary, null);
  assert.deepEqual(projectCanonicalSessionTail(conversation(native('n', 2, [user('a', 'a'), user('b', 'b')])),
    threadId, { maxItems: 1 }).turns, []);
});

test('item and content budgets stop before traversing unbounded payloads and count UTF-8 incrementally', () => {
  const items = Array(257);
  Object.defineProperty(items, '0', { get() { assert.fail('oversized item array must not be visited'); } });
  assert.equal(projected(native('n', 1, items)).diagnostic, 'projection_limit');
  const parts = Array(257);
  Object.defineProperty(parts, '0', { get() { assert.fail('oversized content array must not be visited'); } });
  assert.equal(projected(native('n', 1, [{ id: 'u', type: 'userMessage', content: parts }])).diagnostic, 'projection_limit');
  const content = [{ type: 'text', text: '你'.repeat(120) }, { type: 'text', text: '你'.repeat(120) }];
  Object.defineProperty(content, '2', { get() { assert.fail('UTF-8 budget must stop before the next part'); } });
  assert.deepEqual(projectCanonicalSessionTail(conversation(native('n', 1, [{ id: 'u', type: 'userMessage', content }])),
    threadId, { maxBytes: 600 }).turns, []);
});

test('known message phases are preserved and unsupported question or media semantics reject the whole turn', () => {
  const output = projected(native('n', 1, [{ id: 'a', type: 'agentMessage', text: 'answer', phase: 'final_answer' }]));
  assert.equal(output.turns[0].items[0].phase, 'final_answer');
  for (const item of [{ id: 'a', type: 'agentMessage', text: 'answer', phase: 'unknown' },
    { id: 'a', type: 'agentMessage', text: 'answer', questions: [{ title: 'question' }] },
    { id: 'u', type: 'userMessage', content: [{ type: 'image', url: 'private' }] }]) {
    assert.deepEqual(projected(native('n', 1, [item])).turns, []);
  }
});

test('recent merge appends only a provably newer, anchored complete canonical tail', () => {
  const page = [turn('old', 1)];
  const projection = projected(native('old', 1, [{ id: 'unsupported', type: 'tool' }]), native('new', 2, [user('u-new', 'FOLD_FIXTURE')]));
  const result = mergeRecentSessionProjection(threadId, page, projection);
  assert.deepEqual(result.turns.map(t => t.id), ['old', 'new']);
  assert.deepEqual(result.addedTurnIds, ['new']);
  assert.equal(page.length, 1, 'validated page remains unmodified');
});

test('newer page, ambiguous order, unanchored gaps and wrong thread retain the official page', () => {
  const cases = [
    [turn('page-new', 3), projected(native('native-old', 2, [user('u', 'stale')]))],
    [turn('page', undefined), projected(native('new', 2, [user('u', 'ambiguous')]))],
    [turn('page', 1), projected(native('gap', 2, [{ id: 'tool', type: 'tool' }]), native('new', 3, [user('u', 'missing turn')]))],
    [turn('page', 1), { ...projected(native('new', 2, [user('u', 'other')])), threadId: 'other' }]
  ];
  for (const [pageTurn, projection] of cases) {
    const page = [pageTurn];
    const result = mergeRecentSessionProjection(threadId, page, projection);
    assert.deepEqual(result.turns, page);
    assert.deepEqual(result.addedTurnIds, []);
    assert.ok(result.diagnostic);
  }
});

test('same-turn merge uses real item identity and keeps page text unless native is later or completes a live turn', () => {
  const page = [{ ...turn('same', 1, 'CANONICAL_NEWER_PAGE'), items: [user('shared', 'CANONICAL_NEWER_PAGE')] }];
  const older = projected(native('same', 1, [user('shared', 'STALE_NATIVE'), user('tail', 'native tail')]));
  const merged = mergeRecentSessionProjection(threadId, page, older);
  assert.equal(merged.turns[0].items[0].content[0].text, 'CANONICAL_NEWER_PAGE');
  assert.equal(merged.turns[0].items.length, 2);
  const later = projected(native('same', 1, [user('shared', 'NATIVE_LATER')], { updatedAt: 3 }));
  assert.equal(mergeRecentSessionProjection(threadId, [{ ...page[0], updatedAt: 2 }], later)
    .turns[0].items[0].content[0].text, 'NATIVE_LATER');
  const completed = mergeRecentSessionProjection(threadId, [{ ...page[0], status: 'inProgress' }], older);
  assert.equal(completed.turns[0].status, 'completed');
  assert.equal(completed.turns[0].items[0].content[0].text, 'STALE_NATIVE');
});

test('terminal official page cannot be rolled back by native active or reordered copies', () => {
  const page = [{ ...turn('same', 1), items: [user('a', 'a'), user('b', 'b')] }];
  const reordered = projected(native('same', 1, [user('b', 'changed'), user('a', 'changed')]));
  assert.deepEqual(mergeRecentSessionProjection(threadId, page, reordered).turns, page);
  const live = { source: 'mounted-canonical', threadId, turns: [{ ...turn('same', 1, 'stale'), status: 'inProgress' }], boundary: null };
  assert.deepEqual(mergeRecentSessionProjection(threadId, page, live).turns, page);
});

function serviceFixture(provider) {
  const requests = [], events = [];
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopSessionProjectionProvider: provider,
    projectCatalog: { async initialize() {} }, logger: { async write(_category, _level, type, data) { events.push({ type, data }); } },
    desktopThreadRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === 'thread/read') return { thread: { id: threadId, status: { type: 'idle' }, updatedAt: 2 } };
      if (method === 'thread/turns/list') return { data: [turn('old', 1)], nextCursor: 'older', backwardsCursor: 'newer' };
      assert.fail('Unexpected mutation ' + method);
    } });
  return { service, requests, events };
}

test('desktop recent session includes canonical fixture while official cursor and completed IDs remain valid', async () => {
  let calls = 0;
  const h = serviceFixture(async id => { calls++; assert.equal(id, threadId);
    return projected(native('old', 1, [user('item-old', 'old')]), native('new', 2, [user('u-new', 'FOLD_FIXTURE')])); });
  const session = await h.service.syncThread(threadId, { limit: 10 });
  assert.ok(session.entries.some(e => e.text === 'FOLD_FIXTURE'));
  assert.deepEqual(session.sync.completedTurnIds, ['old', 'new']);
  assert.equal(session.sync.entryCount, 2);
  assert.equal(calls, 1);
  const before = await h.service.syncThread(threadId, { before: session.sync.cursorStart });
  const after = await h.service.syncThread(threadId, { after: session.sync.cursorEnd });
  assert.equal(calls, 1, 'historical cursors never query the mounted projection');
  assert.deepEqual(before.entries.map(e => e.text), ['old']);
  assert.deepEqual(after.entries.map(e => e.text), ['old']);
  assert.equal(h.requests.find(r => r.params.cursor === 'older').params.sortDirection, 'desc');
  assert.equal(h.requests.find(r => r.params.cursor === 'newer').params.sortDirection, 'asc');
});

test('native failure, bounds, unsupported and identity mismatch keep useful page and never invent completion evidence', async () => {
  for (const provider of [async () => { throw Object.assign(Error('PRIVATE_ERROR'), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' }); },
    async () => projected(native('new', 2, [{ id: 'tool', type: 'unsupported' }])),
    async () => ({ ...projected(native('new', 2, [user('u', 'other')])), threadId: 'other' })]) {
    const h = serviceFixture(provider);
    const session = await h.service.syncThread(threadId);
    assert.deepEqual(session.entries.map(e => e.text), ['old']);
    assert.deepEqual(session.sync.completedTurnIds, ['old']);
    assert.ok(h.service.projectionDiagnostics?.length || h.events.length, 'fallback is observable without exposing transcript');
  }
});

test('a stalled optional provider falls back at 500ms and does not hold a useful official page for five seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = serviceFixture(() => new Promise(() => {}));
  let settled = false;
  const pending = h.service.syncThread(threadId).then(value => { settled = true; return value; });
  context.mock.timers.tick(499);
  await Promise.resolve();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  const session = await pending;
  assert.deepEqual(session.entries.map(e => e.text), ['old']);
  assert.deepEqual(session.sync.completedTurnIds, ['old']);
  assert.equal(h.events.at(-1).data.reason, 'projection_timeout');
});

test('malformed optional projection cannot fail a valid official history response', async () => {
  const malformed = { threadId, source: 'mounted-canonical', turns: [] };
  malformed.circular = malformed;
  const h = serviceFixture(async () => malformed);
  const session = await h.service.syncThread(threadId);
  assert.deepEqual(session.entries.map(e => e.text), ['old']);
  assert.deepEqual(session.sync.completedTurnIds, ['old']);
  assert.equal(h.events.at(-1).data.reason, 'projection_invalid');
});

function desktopFixture(value, replaceOnTextRead = false) {
  const family = {}, calls = [];
  const manager = { getHostId() { return 'local'; }, getConversation(id) { calls.push(id); return value; } };
  for (const name of ['replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse', 'sendFollowUpMessage']) manager[name] = () => assert.fail('No native writes');
  let client = { hostId: 'local', rpc: manager };
  const binding = { get: () => ({ status: 'ready', client }) };
  const owner = { familyBindings: new Map([[family, new Map([['local', { value: binding }]])]]) };
  const window = { __codexRoot: { _internalRoot: { current: { tag: 10, memoizedProps: { value: new Map([['owner', owner]]) } } } },
    __codexHarmonyDesktopInteractionRuntime: { entryUrl: 'app://-/assets/index.js', discoveryVersion: 9,
      promise: Promise.resolve({ hostFamily: family }) } };
  if (replaceOnTextRead) Object.defineProperty(value.turnHistory.history.entitiesByKey['0'].items[0].content[0], 'text',
    { get() { client = { hostId: 'local', rpc: manager }; return 'changed lease'; } });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const transport = { hostId: 'local', async ensureConnected() {}, async evaluate(expression) {
    return new AsyncFunction('window', 'document', 'crypto', 'return ' + expression)(window,
      { scripts: [{ type: 'module', src: 'app://-/assets/index.js' }] }, { randomUUID });
  } };
  return { api: new DesktopInteractionClient(transport), calls };
}

test('desktop projection reuses a mounted lease with pure reads and never initializes question state', async () => {
  const h = desktopFixture(conversation(native('new', 2, [user('u', 'FIXTURE')])));
  const result = await h.api.readRecentSessionProjection(threadId);
  assert.equal(result.turns[0].items[0].content[0].text, 'FIXTURE');
  assert.deepEqual(h.calls, [threadId]);
});

test('desktop projection rechecks thread identity and lease after selecting its bounded fields', async () => {
  const wrong = desktopFixture({ ...conversation(native('n', 2, [user('u', 'x')])), id: 'other' });
  assert.deepEqual((await wrong.api.readRecentSessionProjection(threadId)).turns, []);
  const replaced = desktopFixture(conversation(native('n', 2, [user('u', 'x')])), true);
  await assert.rejects(replaced.api.readRecentSessionProjection(threadId), { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE' });
});
