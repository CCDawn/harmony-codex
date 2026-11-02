import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const index = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
function method(name) {
  const start = index.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return index.slice(start, index.indexOf('\n  }', start) + 4);
}
function setup() {
  let now = 0, nextTimer = 1;
  const timers = new Map(), connections = [];
  const clock = {
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = end;
    }
  };
  class Stream {
    constructor(options) { this.options = options; connections.push(this); }
    start() { this.options.onState('open'); }
    stop() { this.stopped = true; }
  }
  const files = ['TaskStreamState.ets', 'SessionLiveEntries.ets', 'SessionStreamPresentation.ets', 'StreamUiBatch.ets',
    'SessionActivityPresentation.ets', 'SessionPresentationService.ets'];
  const services = files.map(file => fs.readFileSync(root + 'services/' + file, 'utf8')
    .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')).join('\n');
  const context = vm.createContext({ BridgeEventStream: Stream, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const methods = ['stopTaskEventStream', 'syncTaskEventStream', 'stopSessionEventStream', 'syncSessionEventStream',
    'refreshSessionEventHistory', 'commitSessionNavigation', 'streamingAgentTextForTask', 'sessionStreamDiagnosticMatch',
    'visibleSessionEntries', 'normalizeVisibleSessionEntries', 'shouldHideSessionEntry'];
  vm.runInContext(stripTypeScriptTypes(services + '\nclass Page {' + methods.map(method).join('\n') + '}\nglobalThis.Page=Page;'), context);
  const page = Object.assign(new context.Page(), {
    currentTask: { id: 'task', status: 'running', codexSessionId: 's', events: [], eventCursor: 0, updatedAt: '2026-10-24T00:00:00Z' },
    selectedSession: { id: 's', entries: [] }, appForeground: true, activeTab: 'sessions', isNewSessionDraft: false,
    companionSelected: false, bridgeToken: 'pair', sessionStreamEntries: [], sessionStreamDiagnosticAt: 0,
    taskEventStream: null, taskEventStreamKey: '', taskEventStreamHealthy: false, taskStreamRepairId: '',
    sessionEventStream: null, sessionEventStreamKey: '', sessionStreamRefreshing: false,
    sessionNavigationState: JSON.stringify({ revision: 1, mode: 'session', sessionId: 's' }),
    normalizedBridgeUrl: () => 'https://fixture.test', taskSessionId: task => task.codexSessionId,
    taskUsesCodexRunApi: () => false, isTaskRunningStatus: status => status === 'running',
    currentTaskEventCursor: task => task?.eventCursor ?? 0, selectedVisibleTask() { return this.currentTask; },
    readSessionNavigation() { return JSON.parse(this.sessionNavigationState); },
    log() {}, logTaskStreamPresentation() {}, scrolls: 0, recoveryCursors: [], historyTexts: [],
    async refreshContinueStatus() {},
    scrollSessionToBottomIfFollowing() { this.scrolls++; },
    async recoverTaskEventStream() { this.recoveryCursors.push(this.currentTask.eventCursor); },
    async refreshSelectedSessionDetail() { this.historyTexts.push(this.sessionStreamEntries[0]?.text); }
  });
  let current = page.currentTask, writes = 0;
  Object.defineProperty(page, 'currentTask', { get: () => current, set(value) { writes++; current = value; }, configurable: true });
  const event = (seq, delta = String(seq), methodName = 'item/agentMessage/delta', extra = {}) => ({
    id: `e${seq}`, seq, taskId: 'task', type: 'codex.app_server.notification',
    createdAt: new Date(Date.parse('2026-10-24T00:00:00Z') + seq).toISOString(),
    payload: { method: methodName, params: { turnId: 'turn', itemId: 'a', delta } }, ...extra
  });
  const frame = (stream, value) => stream.options.onFrame({ event: 'task.event', data: JSON.stringify(value) });
  const sessionFrame = (stream, text, extra = {}) => {
    page.selectedSession.sync = { source: 'desktop-official' };
    stream.options.onFrame({ event: 'session.message', data: JSON.stringify({ entry: {
      threadId: 's', turnId: 'turn', itemId: 'a', role: 'assistant', timestamp: '2026-10-24T00:00:00Z', liveKind: 'streaming', text, ...extra
    } }) });
  };
  return { page, clock, connections, event, frame, sessionFrame, writes: () => writes };
}

test('first text renders immediately; later deltas preserve order and publish once within 50ms', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1, '首')); assert.equal(h.page.streamingAgentTextForTask(h.page.currentTask), '首');
  for (let seq = 2; seq <= 20; seq++) h.frame(stream, h.event(seq));
  assert.equal(h.page.currentTask.eventCursor, 1); assert.equal(h.writes(), 1);
  assert.equal(stream.options.afterSeq(), 20, 'reconnect cursor includes every accepted pending event');
  h.clock.advance(39); assert.equal(h.writes(), 1);
  h.clock.advance(1); assert.equal(h.page.currentTask.eventCursor, 20); assert.equal(h.writes(), 2);
  assert.deepEqual(Array.from(h.page.currentTask.events, event => event.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(h.page.scrolls, 2);
});

test('a burst of 1000 deltas retains all events with two UI commits', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  for (let seq = 1; seq <= 1000; seq++) h.frame(stream, h.event(seq, 'x'));
  assert.equal(h.writes(), 1); assert.equal(stream.options.afterSeq(), 1000);
  h.clock.advance(40); assert.equal(h.writes(), 2); assert.equal(h.page.currentTask.events.length, 1000);
  assert.equal(h.page.streamingAgentTextForTask(h.page.currentTask), 'x'.repeat(1000));
});

test('a busy stream cannot postpone the oldest pending update past its fixed 40ms deadline', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1)); h.frame(stream, h.event(2)); h.clock.advance(39);
  h.frame(stream, h.event(3)); h.clock.advance(1);
  assert.equal(h.page.currentTask.eventCursor, 3); assert.equal(h.writes(), 2);
});

test('pending cursor and IDs reject duplicate frames without inventing a sequence gap', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1)); h.frame(stream, h.event(2)); h.frame(stream, h.event(2));
  h.frame(stream, h.event(3, 'duplicate id', undefined, { id: 'e2' }));
  h.frame(stream, h.event(3)); h.clock.advance(40);
  assert.equal(h.page.currentTask.eventCursor, 3); assert.equal(h.page.currentTask.events.length, 3);
  assert.equal(h.page.recoveryCursors.length, 0);
});

test('item completion flushes pending text immediately and completed text wins', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1, 'par')); h.frame(stream, h.event(2, 'tial'));
  h.frame(stream, h.event(3, '', 'item/completed', { payload: { method: 'item/completed', params: {
    turnId: 'turn', item: { id: 'a', type: 'agentMessage', text: 'complete' }
  } } }));
  assert.equal(h.page.currentTask.events.length, 3); assert.equal(h.page.streamingAgentTextForTask(h.page.currentTask), 'complete');
  h.clock.advance(40); assert.equal(h.writes(), 2);
});

test('terminal and interaction metadata flush all accepted events before snapshot recovery', () => {
  for (const payload of [{ type: 'task.completed', payload: {} }, { payload: { method: 'item/tool/requestUserInput', params: {} } }]) {
    const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
    h.frame(stream, h.event(1)); h.frame(stream, h.event(2)); h.frame(stream, h.event(3, '', undefined, payload));
    assert.deepEqual(h.page.recoveryCursors, [3]); assert.equal(h.page.currentTask.events.length, 3);
    h.clock.advance(40); assert.equal(h.writes(), 2);
  }
});

test('terminal control and sequence repair flush pending frames before stopping', () => {
  const terminal = setup(); terminal.page.syncTaskEventStream(); const stream = terminal.connections[0];
  terminal.frame(stream, terminal.event(1)); terminal.frame(stream, terminal.event(2));
  stream.options.onFrame({ event: 'stream.control', data: JSON.stringify({ reason: 'terminal' }) });
  assert.deepEqual(terminal.page.recoveryCursors, [2]); assert.equal(stream.stopped, true);
  const gap = setup(); gap.page.syncTaskEventStream(); const other = gap.connections[0];
  gap.frame(other, gap.event(1)); gap.frame(other, gap.event(2)); gap.frame(other, gap.event(4));
  assert.deepEqual(gap.page.recoveryCursors, [2]); assert.equal(other.stopped, true);
  gap.clock.advance(40); assert.equal(gap.page.currentTask.events.length, 2);
});

test('reconnect resumes from accepted cursor and flushes before taking a snapshot', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1)); h.frame(stream, h.event(2));
  assert.equal(stream.options.afterSeq(), 2); stream.options.onReconnect();
  assert.deepEqual(h.page.recoveryCursors, [2]); h.frame(stream, h.event(3)); h.clock.advance(40);
  assert.deepEqual(Array.from(h.page.currentTask.events, event => event.seq), [1, 2, 3]);
});

test('a newer polling snapshot overlapping the pending batch cannot duplicate events', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1)); h.frame(stream, h.event(2)); h.frame(stream, h.event(3));
  h.page.currentTask = { ...h.page.currentTask, events: [h.event(1), h.event(2)], eventCursor: 2 };
  h.clock.advance(40);
  assert.deepEqual(Array.from(h.page.currentTask.events, event => event.seq), [1, 2, 3]);
});

test('IDs introduced by a concurrent snapshot participate in stream deduplication', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1));
  h.page.currentTask = { ...h.page.currentTask, events: [h.event(1), h.event(2, '', undefined, { id: 'snapshot-id' })], eventCursor: 2 };
  h.frame(stream, h.event(3, 'duplicate', undefined, { id: 'snapshot-id' }));
  h.frame(stream, h.event(3, 'fresh')); h.clock.advance(40);
  assert.equal(h.page.currentTask.events.length, 3); assert.equal(h.page.currentTask.events[2].id, 'e3');
});

test('a batch flush retains IDs newly introduced by an overlapping snapshot', () => {
  const h = setup(); h.page.syncTaskEventStream(); const stream = h.connections[0];
  h.frame(stream, h.event(1)); h.frame(stream, h.event(2)); h.frame(stream, h.event(3));
  h.page.currentTask = { ...h.page.currentTask, events: [h.event(1), h.event(2, '', undefined, { id: 'snapshot-id' })], eventCursor: 2 };
  h.clock.advance(40); h.frame(stream, h.event(4, 'duplicate', undefined, { id: 'snapshot-id' }));
  h.frame(stream, h.event(4, 'fresh')); h.clock.advance(40);
  assert.deepEqual(Array.from(h.page.currentTask.events, event => event.id), ['e1', 'snapshot-id', 'e3', 'e4']);
});

test('navigation cancels pending task UI and late frames while old detail is still selected', () => {
  const h = setup(); h.page.syncTaskEventStream(); const old = h.connections[0];
  h.frame(old, h.event(1)); h.frame(old, h.event(2));
  h.page.commitSessionNavigation('session', 'other', 'fixture');
  assert.equal(old.stopped, true); h.frame(old, h.event(3)); h.clock.advance(40);
  assert.equal(h.page.currentTask.eventCursor, 1); assert.equal(h.writes(), 1);
  h.page.syncTaskEventStream(); assert.equal(h.connections.length, 1, 'polling cannot restart the old task during navigation');
});

test('reopening the same stream key cannot revive a stopped callback or its pending batch', () => {
  const h = setup(); h.page.syncTaskEventStream(); const old = h.connections[0];
  h.frame(old, h.event(1, 'first')); h.frame(old, h.event(2, 'stale pending'));
  h.page.stopTaskEventStream(); h.page.syncTaskEventStream(); const next = h.connections[1];
  h.frame(old, h.event(2, 'stale callback')); h.clock.advance(40);
  assert.equal(h.page.currentTask.eventCursor, 1);
  h.frame(next, h.event(2, ' fresh'));
  assert.equal(h.page.streamingAgentTextForTask(h.page.currentTask), 'first fresh');
});

test('desktop item snapshots render first text immediately, coalesce updates and flush completion', () => {
  const h = setup(); h.page.currentTask = null; h.page.syncSessionEventStream(); const stream = h.connections[0];
  h.sessionFrame(stream, '首'); assert.equal(h.page.sessionStreamEntries[0].text, '首');
  h.sessionFrame(stream, '首字'); h.sessionFrame(stream, '首字显示');
  assert.equal(h.page.sessionStreamEntries[0].text, '首'); h.clock.advance(40);
  assert.equal(h.page.sessionStreamEntries[0].text, '首字显示');
  h.sessionFrame(stream, 'done', { liveKind: 'completed' }); assert.equal(h.page.sessionStreamEntries[0].text, 'done');
  h.sessionFrame(stream, 'late'); h.clock.advance(40); assert.equal(h.page.sessionStreamEntries[0].text, 'done');
});

test('desktop invalidation flushes pending snapshots; navigation cancels its timer and late frames', () => {
  const h = setup(); h.page.currentTask = null; h.page.syncSessionEventStream(); const stream = h.connections[0];
  h.sessionFrame(stream, 'a'); h.sessionFrame(stream, 'ab'); stream.options.onFrame({ event: 'session.invalidate' });
  assert.deepEqual(h.page.historyTexts, ['ab']); h.sessionFrame(stream, 'abc');
  h.page.commitSessionNavigation('session', 'other', 'fixture'); h.sessionFrame(stream, 'late'); h.clock.advance(40);
  assert.equal(stream.stopped, true); assert.equal(h.page.sessionStreamEntries.length, 0);
  h.page.syncSessionEventStream(); assert.equal(h.connections.length, 1, 'old detail cannot re-open a stream during navigation');
});

test('an empty desktop item snapshot cannot delay its first real text', () => {
  const h = setup(); h.page.currentTask = null; h.page.syncSessionEventStream(); const stream = h.connections[0];
  h.sessionFrame(stream, ''); h.sessionFrame(stream, 'first');
  assert.equal(h.page.sessionStreamEntries[0].text, 'first');
});

test('repeated builder reads replay a task events reference once and invalidate on a new snapshot', () => {
  const h = setup(); let reads = 0;
  const event = h.event(1, 'text'), payload = event.payload;
  Object.defineProperty(event, 'payload', { get() { reads++; return payload; } });
  const events = [event];
  for (let i = 0; i < 30; i++) assert.equal(h.page.streamingAgentTextForTask({ events }), 'text');
  assert.equal(reads, 2, 'one replay reads method and params once');
  assert.equal(h.page.streamingAgentTextForTask({ events: [...events, h.event(2, ' more')] }), 'text more');
  assert.equal(reads, 4);
});
