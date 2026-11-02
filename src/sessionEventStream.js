import { createHash } from 'node:crypto';
import { extractConversationEntries } from './codexProtocolUtils.js';
import { nativeContinueStatus, nativeContinueLatestTurn } from './nativeContinueEligibility.js';

const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'failed']);
const ASSISTANT_TYPES = new Set(['agentMessage', 'agent_message']);
const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'subAgentActivity', 'collabAgentToolCall', 'webSearch', 'imageView']);
const TOOL_FIELDS = ['id', 'type', 'status', 'success', 'startedAtMs', 'completedAtMs', 'command',
  'commandActions', 'aggregatedOutput', 'source', 'pluginId', 'scriptPath', 'changes', 'tool', 'server',
  'namespace', 'arguments', 'result', 'contentItems', 'error', 'agentThreadId', 'agentPath', 'kind',
  'model', 'reasoningEffort', 'receiverThreadIds', 'senderThreadId', 'agentsStates', 'prompt', 'query', 'path'];

function toolFields(item) {
  return Object.fromEntries(TOOL_FIELDS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
}

function isTerminalToolStatus(status) {
  return ['completed', 'failed', 'declined', 'interrupted', 'cancelled', 'canceled']
    .includes(String(status ?? '').toLowerCase().replace(/[-_ ]/g, ''));
}

function hasTerminalToolState(item) {
  return isTerminalToolStatus(item.status) || typeof item.success === 'boolean';
}

function hasToolTitle(item) {
  const present = value => typeof value === 'string' && value.trim().length > 0;
  switch (item.type) {
    case 'commandExecution': return present(item.command) || (Array.isArray(item.command) && item.command.length > 0)
      || (Array.isArray(item.commandActions) && item.commandActions.some(action =>
        present(action?.command) || present(action?.name) || present(action?.path) || present(action?.query) || action?.type === 'listFiles'));
    case 'fileChange': return Array.isArray(item.changes) && item.changes.some(change => present(change?.path));
    case 'mcpToolCall':
    case 'dynamicToolCall': return present(item.tool);
    case 'subAgentActivity': return present(item.agentPath) || present(item.agentThreadId);
    case 'collabAgentToolCall': return present(item.tool);
    case 'webSearch': return present(item.query);
    case 'imageView': return present(item.path);
    default: return false;
  }
}

// This observer owns one subscription to the adapter's shared notification drain.
// Replay and live deltas share official notification IDs. Snapshot bodies stay
// separate from the replay accumulator: they have no atomic notification cursor,
// so appending retained deltas to a snapshot would duplicate an unknown suffix.
export async function openSessionEventStream({
  request, response, threadId, adapter, readThread, readRetainedNotifications,
  heartbeatMs = 15_000, maxAgeMs = 300_000,
  maxBufferedBytes = 256 * 1024, maxRetainedBytes = 4 * 1024 * 1024, closeGraceMs = 1_000,
  invalidateMs = 250, readDebounceMs = 100, backpressureTimeoutMs = 15_000
}) {
  let closed = false;
  let subscription;
  let heartbeat;
  let lease;
  let readTimer;
  let invalidateTimer;
  let closeDeadline;
  let backpressureDeadline;
  let paused = false;
  let outboundBytes = 0;
  const outbound = new Map();
  const writableWaiters = new Set();
  const repairTurns = new Set();
  let historyRepair = false;
  let reading = false;
  let dirty = false;
  let latestTurnId;
  let turnTimestamp = '';
  let turnTerminal = false;
  let initializing = true;
  let pending = [];
  let pendingBytes = 0;
  const notificationCursors = new Map();
  const retiredTurns = new Set();
  const replay = new Map();
  const baseline = new Map();
  const seen = new Map();
  const completedItems = new Set();
  const tools = new Map();
  let outputOwnerId = '';
  let statusRevision = 0;
  let statusFingerprint = '';
  let statusTransition = null;
  const notifications = [];

  function release() {
    if (closed) return;
    closed = true;
    const ownedSubscription = subscription;
    subscription = undefined;
    ownedSubscription?.stop();
    notifications.length = 0;
    pending.length = 0;
    replay.clear();
    baseline.clear();
    seen.clear();
    completedItems.clear();
    tools.clear();
    notificationCursors.clear();
    outbound.clear();
    outboundBytes = 0;
    clearInterval(heartbeat);
    clearTimeout(lease);
    clearTimeout(readTimer);
    clearTimeout(invalidateTimer);
    clearTimeout(backpressureDeadline);
    wakeWritableWaiters();
    response.off('drain', onDrain);
    request?.off('aborted', abort);
  }

  function detach() {
    clearTimeout(closeDeadline);
    response.off('close', abort);
    response.off('finish', abort);
    response.off('error', onError);
  }

  function abort() {
    release();
    detach();
  }

  function onError() {
    abort();
    response.destroy();
  }

  function finish(detail) {
    if (closed) return;
    release();
    if (response.destroyed || response.writableEnded) {
      detach();
      return;
    }
    // A stalled reader must not retain even a pending response.end forever.
    closeDeadline = setTimeout(() => { abort(); response.destroy(); }, closeGraceMs);
    closeDeadline.unref?.();
    const control = `event: stream.control\ndata: ${JSON.stringify({
      type: 'stream.control', reason: 'reconnect', detail
    })}\n\n`;
    try {
      if (Buffer.byteLength(control) + (response.writableLength || 0) > maxBufferedBytes) {
        abort();
        response.destroy();
      } else {
        response.end(control);
      }
    } catch {
      onError();
    }
  }

  function onDrain() {
    if (closed) return;
    paused = false;
    clearTimeout(backpressureDeadline);
    for (const [key, frame] of outbound) {
      outbound.delete(key);
      outboundBytes -= Buffer.byteLength(frame);
      if (!write(frame) || paused) { wakeWritableWaiters(); return; }
    }
    wakeWritableWaiters();
  }

  function wakeWritableWaiters() {
    for (const waiter of writableWaiters) {
      const invalid = closed || historyRepair || waiter.turnId !== latestTurnId;
      if (invalid || !paused) {
        writableWaiters.delete(waiter);
        waiter.resolve(!invalid);
      }
    }
  }

  function waitForWritable(turnId) {
    if (closed || historyRepair || turnId !== latestTurnId) return Promise.resolve(false);
    if (!paused) return Promise.resolve(true);
    return new Promise(resolve => writableWaiters.add({ turnId, resolve }));
  }

  function write(frame) {
    if (closed || paused) return false;
    if (response.destroyed || response.writableEnded) { abort(); return false; }
    if (Buffer.byteLength(frame) + outboundBytes + (response.writableLength || 0) > maxBufferedBytes) {
      finish('buffer_limit');
      return false;
    }
    try {
      if (!response.write(frame)) {
        // Node accepted this frame. Keep only each pending item's latest full
        // state until drain; a slow reader must not force normal reconnection.
        paused = true;
        response.once('drain', onDrain);
        backpressureDeadline = setTimeout(() => finish('backpressure_timeout'), backpressureTimeoutMs);
        backpressureDeadline.unref?.();
      }
      return true;
    } catch {
      onError();
      return false;
    }
  }

  function send(type, payload, snapshot = false) {
    if (closed) return false;
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (type === 'session.message' && (Buffer.byteLength(frame) > maxBufferedBytes
      || (snapshot && !paused && Buffer.byteLength(frame) + (response.writableLength || 0) > maxBufferedBytes))) {
      enterHistoryRepair(payload.entry?.turnId);
      return false;
    }
    if (!paused) return write(frame);
    // Include the turn identity: selecting the next turn clears its body caches,
    // but must not discard an earlier turn's still-pending completed message.
    const key = JSON.stringify([type, payload.entry?.turnId, payload.entry?.itemId]);
    const previous = outbound.get(key);
    const bytes = outboundBytes - (previous ? Buffer.byteLength(previous) : 0) + Buffer.byteLength(frame);
    if (bytes + (response.writableLength || 0) > maxBufferedBytes) {
      finish('buffer_limit');
      return false;
    }
    outbound.set(key, frame);
    outboundBytes = bytes;
    return true;
  }

  function invalidate() {
    if (closed || invalidateTimer) return;
    // Metadata is a small wake-up hint; never copy approval/tool bodies to SSE.
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined;
      if (!closed) send('session.invalidate', { threadId });
    }, invalidateMs);
    invalidateTimer.unref?.();
  }

  function latestSnapshotTurn(result) {
    const thread = result?.thread ?? result;
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) {
      throw new Error('Invalid official thread snapshot');
    }
    return nativeContinueLatestTurn(thread);
  }

  function publishStatus(status) {
    if (closed || initializing) return;
    const fingerprint = JSON.stringify(status);
    if (fingerprint !== statusFingerprint && send('session.status', status)) statusFingerprint = fingerprint;
  }

  function transitionStatus(state = 'unknown') {
    statusRevision++;
    statusTransition = { threadId, turnId: latestTurnId ?? '', state,
      canContinue: false, reason: state === 'active' ? 'active' : 'updating' };
    publishStatus(statusTransition);
  }

  function publishSnapshotStatus(result, revision) {
    const status = nativeContinueStatus(result, threadId);
    if (revision !== statusRevision || (latestTurnId && status.turnId !== latestTurnId)) {
      publishStatus(statusTransition ?? { threadId, turnId: latestTurnId ?? '', state: 'unknown', canContinue: false, reason: 'updating' });
      return;
    }
    statusTransition = null;
    publishStatus(status);
  }

  function selectTurn(id, timestamp = '') {
    if (!id || latestTurnId === id) return;
    // Close the old phase before discarding its bodies and official identities.
    if (latestTurnId) advanceOutputOwner('', !initializing);
    if (latestTurnId) retiredTurns.add(latestTurnId);
    // Only current-turn bodies are retained; the small retired-ID set also has
    // a bound for a long lease containing many very short turns.
    if (retiredTurns.size > 64) retiredTurns.delete(retiredTurns.values().next().value);
    latestTurnId = id;
    turnTimestamp = timestamp;
    turnTerminal = false;
    historyRepair = repairTurns.has(id);
    replay.clear();
    baseline.clear();
    seen.clear();
    completedItems.clear();
    tools.clear();
    outputOwnerId = '';
    wakeWritableWaiters();
  }

  function enterHistoryRepair(id = latestTurnId) {
    if (!id) return;
    repairTurns.add(id);
    if (repairTurns.size > 64) repairTurns.delete(repairTurns.values().next().value);
    if (id !== latestTurnId || historyRepair) return;
    historyRepair = true;
    replay.clear(); baseline.clear(); seen.clear(); completedItems.clear(); tools.clear();
    outputOwnerId = '';
    // Keep small status/control frames, but never flush an obsolete partial
    // body after telling the phone to repair this turn from canonical history.
    for (const [key, frame] of outbound) {
      const [type, turnId] = JSON.parse(key);
      if (type === 'session.message' && turnId === id) {
        outbound.delete(key); outboundBytes -= Buffer.byteLength(frame);
      }
    }
    wakeWritableWaiters();
    if (!initializing) invalidate();
  }

  function advanceOutputOwner(itemId, publish) {
    // Snapshot predecessors and completed notifications are monotonic evidence;
    // replaying an old start must not steal ownership from the current item.
    if (completedItems.has(itemId) || outputOwnerId === itemId) return;
    const previousOwnerId = outputOwnerId;
    outputOwnerId = itemId;
    for (const id of new Set([...baseline.keys(), ...replay.keys()])) {
      if (id === itemId || completedItems.has(id)) continue;
      completedItems.add(id);
      if (publish) publishItem(id);
    }
    if (previousOwnerId) completedItems.add(previousOwnerId);
  }

  function boundState() {
    let bytes = 0;
    for (const values of [replay, baseline]) {
      for (const state of values.values()) bytes += Buffer.byteLength(state.text) + 128;
    }
    for (const id of completedItems) bytes += Buffer.byteLength(String(id)) + 16;
    for (const state of tools.values()) bytes += Buffer.byteLength(JSON.stringify(state)) + 128;
    if (bytes > maxRetainedBytes) { enterHistoryRepair(); return false; }
    return true;
  }

  function publishItem(itemId, snapshot = false) {
    if (closed || historyRepair) return;
    const cached = replay.get(itemId);
    const official = baseline.get(itemId);
    let state = cached?.reliable ? cached : official;
    if (cached?.reliable && official && !cached.completed) {
      // A full completed item wins. Otherwise allow replay only when it extends
      // the snapshot; a short or divergent retained prefix cannot roll it back.
      if (official.completed || !cached.text.startsWith(official.text)) state = official;
    }
    if (!state || !state.text) return;
    const liveKind = state.completed || completedItems.has(itemId) || turnTerminal ? 'completed' : 'streaming';
    const fingerprint = `${liveKind}:${createHash('sha256').update(state.text).digest('hex')}`;
    if (seen.get(itemId) === fingerprint) return;
    const entry = {
      threadId, turnId: latestTurnId, itemId,
      role: 'assistant', type: 'agentMessage', liveKind,
      timestamp: turnTimestamp || state.timestamp || new Date().toISOString(), text: state.text
    };
    if (send('session.message', { entry }, snapshot)) seen.set(itemId, fingerprint);
  }

  function applyTool(item, terminal = false) {
    if (historyRepair || !item?.id || !TOOL_TYPES.has(item.type)) return;
    const previous = tools.get(item.id);
    if (previous?.terminal && (!terminal || previous.knownTerminal || !hasTerminalToolState(item))) return;
    const merged = { ...previous?.item, ...item };
    // A completion boundary is evidence of finality, but it is not itself a
    // status field. Never carry an old running status into a partial completion.
    if (terminal && !Object.hasOwn(item, 'status')) delete merged.status;
    if (!hasToolTitle(merged)) return;
    const [entry] = extractConversationEntries({ id: threadId, turns: [{ id: latestTurnId,
      startedAt: Date.parse(turnTimestamp) / 1000, items: [merged] }] }, { threadId });
    if (entry?.role !== 'tool') return;
    tools.set(item.id, { item: merged, entry, terminal: terminal || hasTerminalToolState(item),
      knownTerminal: hasTerminalToolState(item) });
  }

  function publishTool(itemId, snapshot = false) {
    if (historyRepair) return;
    const state = tools.get(itemId);
    if (!state) return;
    const entry = { ...state.entry, liveKind: state.terminal ? 'completed' : 'streaming' };
    const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    if (seen.get(itemId) === fingerprint) return;
    if (send('session.message', { entry }, snapshot)) seen.set(itemId, fingerprint);
  }

  async function publishSnapshotBodies(turnId) {
    // Snapshot publication is a producer too: do not enqueue hundreds of tool
    // frames while Node is waiting for a healthy socket's next drain event.
    for (const id of new Set([...baseline.keys(), ...replay.keys()])) {
      if (!await waitForWritable(turnId)) return;
      publishItem(id, true);
    }
    for (const id of [...tools.keys()]) {
      if (!await waitForWritable(turnId)) return;
      publishTool(id, true);
    }
  }

  function applySnapshot(turn, publish = true) {
    if (!turn?.id || (latestTurnId && latestTurnId !== turn.id)) return;
    selectTurn(turn.id, toIso(turn.startedAt) || toIso(turn.updatedAt));
    turnTimestamp ||= toIso(turn.startedAt) || toIso(turn.updatedAt);
    if (TERMINAL_STATUSES.has(turn.status)) turnTerminal = true;
    if (historyRepair) return;
    const items = Array.isArray(turn.items) ? turn.items : [];
    // A successor is evidence that a commentary body has finished, even when
    // the snapshot omits item.status and the containing turn is still active.
    for (const item of items.slice(0, -1)) if (item?.id) completedItems.add(item.id);
    if (!outputOwnerId) outputOwnerId = items.at(-1)?.id ?? '';
    for (const item of items) {
      if (closed) return;
      if (TOOL_TYPES.has(item?.type)) {
        applyTool(toolFields(item), hasTerminalToolState(item));
        if (!boundState()) return;
        continue;
      }
      if (!ASSISTANT_TYPES.has(item?.type) || !item.id || typeof item.text !== 'string') continue;
      const previous = baseline.get(item.id);
      const completed = turnTerminal || TERMINAL_STATUSES.has(item.status);
      if (completed) completedItems.add(item.id);
      if (!previous || completed || (!previous.completed && item.text.length >= previous.text.length)) {
        baseline.set(item.id, { text: item.text, completed, timestamp: turnTimestamp });
      }
      if (!boundState()) return;
    }
    if (!boundState()) return;
    if (publish) for (const id of new Set([...baseline.keys(), ...replay.keys()])) publishItem(id);
    if (publish) for (const id of tools.keys()) publishTool(id);
  }

  async function refresh() {
    if (closed || reading) return;
    reading = true;
    try {
      do {
        dirty = false;
        const revision = statusRevision;
        const result = await readThread();
        if (closed) return;
        const turn = latestSnapshotTurn(result);
        // A status event can identify a newer canonical turn before its start
        // notification arrives. Never resurrect a retired turn or a page that
        // was overtaken while the read was in flight.
        if (revision === statusRevision && turn?.id && turn.id !== latestTurnId && !retiredTurns.has(turn.id)) {
          selectTurn(turn.id, toIso(turn.startedAt) || toIso(turn.updatedAt));
        }
        applySnapshot(turn, false);
        await publishSnapshotBodies(latestTurnId);
        publishSnapshotStatus(result, revision);
        // Status and terminal boundaries repair one latest page; deltas do not.
      } while (dirty && !closed);
    } catch {
      // Do not log the upstream exception: it may contain conversation text.
      finish('read_failed');
    } finally {
      reading = false;
    }
  }

  function requestRefresh() {
    if (closed) return;
    dirty = true;
    if (reading || readTimer) return;
    readTimer = setTimeout(() => {
      readTimer = undefined;
      void refresh();
    }, readDebounceMs);
    readTimer.unref?.();
  }

  function consumeNotification(message, publish = true) {
    const position = notificationPosition(message.notificationId);
    if (position) {
      const cursor = notificationCursors.get(position.epoch) ?? -1;
      if (position.sequence <= cursor) return false;
      if (!notificationCursors.has(position.epoch) && notificationCursors.size >= 2) {
        notificationCursors.delete(notificationCursors.keys().next().value);
      }
      notificationCursors.set(position.epoch, position.sequence);
    }
    const { method, params } = message;
    const turnId = params.turnId ?? params.turn?.id;
    if (method === 'thread/status/changed') {
      // This official notification has no turnId on current desktop builds.
      transitionStatus(params.status?.type === 'active' ? 'active' : 'unknown');
      if (!initializing) requestRefresh();
      else dirty = true;
      return;
    }
    if (!turnId) return;
    if (method === 'turn/started' && turnId !== latestTurnId) {
      if (retiredTurns.has(turnId)) return;
      const timestamp = toIso(params.turn?.startedAt) || toIso(message.at);
      if (timestamp && turnTimestamp && timestamp < turnTimestamp) return;
      selectTurn(turnId, timestamp);
    }
    if (!latestTurnId) selectTurn(turnId, toIso(message.at));
    if (turnId !== latestTurnId) return;
    if (method === 'turn/started' && !turnTerminal) {
      transitionStatus('active');
      // Starting is conclusive evidence for a disabled continue button. Reuse
      // the terminal/status read for eligibility rather than polling on deltas.
      if (reading && !initializing) dirty = true;
    } else if (method === 'turn/completed') transitionStatus();
    if (historyRepair) {
      if (method === 'turn/completed') {
        turnTerminal = true;
        if (!initializing) requestRefresh();
      }
      return;
    }
    const item = params.item;
    let itemId = params.itemId ?? item?.id;
    if ((method === 'item/started' || method === 'item/completed') && TOOL_TYPES.has(item?.type)) {
      applyTool(toolFields(item), method === 'item/completed');
    }
    if (method === 'item/started' && itemId) {
      advanceOutputOwner(itemId, publish);
      if (ASSISTANT_TYPES.has(item?.type) && !completedItems.has(itemId)) {
        const previous = replay.get(itemId);
        if (!previous?.reliable && !previous?.unknownPrefix) {
          replay.set(itemId, { text: typeof item.text === 'string' ? item.text : '',
            reliable: true, completed: false, timestamp: toIso(message.at) });
        }
      }
    } else if (method === 'item/agentMessage/delta' && itemId && typeof params.delta === 'string') {
      let state = replay.get(itemId);
      if (!state) {
        // Retain the missing-prefix marker. An incomplete cache must never turn
        // a suffix into a standalone complete assistant message.
        state = { text: '', reliable: false, unknownPrefix: true, completed: false, timestamp: toIso(message.at) };
        replay.set(itemId, state);
      }
      if (!state.completed && !completedItems.has(itemId) && !turnTerminal) state.text += params.delta;
    } else if (method === 'item/completed' && ASSISTANT_TYPES.has(item?.type)
      && itemId && typeof item.text === 'string') {
      replay.set(itemId, { text: item.text, reliable: true, completed: true, timestamp: toIso(message.at) });
      completedItems.add(itemId);
    } else if (method === 'turn/completed') {
      turnTerminal = true;
      applySnapshot(params.turn, false);
      if (!initializing) requestRefresh();
      itemId = undefined;
    }
    if (!boundState()) return;
    if (publish) {
      if (itemId) publishItem(itemId);
      if (itemId) publishTool(itemId);
      else if (turnTerminal) for (const id of new Set([...baseline.keys(), ...replay.keys()])) publishItem(id);
    }
  }

  async function initialize() {
    reading = true;
    try {
      const revision = statusRevision;
      const [result, retained] = await Promise.all([
        readThread(), readRetainedNotifications ? readRetainedNotifications() : []
      ]);
      if (closed) return;
      const turn = latestSnapshotTurn(result);
      if (turn?.id) selectTurn(turn.id, toIso(turn.startedAt) || toIso(turn.updatedAt));
      const arrived = pending;
      pending = []; pendingBytes = 0;
      for (const message of [...(Array.isArray(retained) ? retained : []), ...arrived]) {
        if (message?.params?.threadId === threadId && isBodyNotification(message)) queuePending(bodyNotification(message));
      }
      const events = pending.sort((a, b) => {
          const left = notificationPosition(a.notificationId), right = notificationPosition(b.notificationId);
          if (left && right && left.epoch === right.epoch) return left.sequence - right.sequence;
          const at = Date.parse(toIso(a.at)), bt = Date.parse(toIso(b.at));
          return Number.isFinite(at) && Number.isFinite(bt) ? at - bt : 0;
        });
      pending = [];
      pendingBytes = 0;
      // Find the most recent official turn start before replaying its items.
      // Old retained starts precede the snapshot's turn start and are ignored.
      const starts = events.filter(message => message.method === 'turn/started');
      const snapshotStart = starts.findLastIndex(message => message.params.turn?.id === turn?.id);
      for (let index = 0; index < starts.length; index++) {
        const event = starts[index];
        const at = toIso(event.params.turn?.startedAt) || toIso(event.at);
        if (!latestTurnId || (snapshotStart >= 0 && index > snapshotStart)
          || (at && turnTimestamp && at >= turnTimestamp && event.params.turn?.id !== turn?.id)) {
          selectTurn(event.params.turn?.id, at);
        }
      }
      applySnapshot(turn, false);
      for (const event of events) {
        if (closed) return;
        // The initial pass already selected the latest turn; don't resurrect
        // earlier retained starts while rebuilding its reliable item prefixes.
        const eventTurnId = event.params.turnId ?? event.params.turn?.id;
        if (event.method !== 'thread/status/changed' && eventTurnId !== latestTurnId) continue;
        consumeNotification(event, false);
      }
      initializing = false;
      await publishSnapshotBodies(latestTurnId);
      if (historyRepair) invalidate();
      publishSnapshotStatus(result, revision);
      if (events.some(event => event.method === 'turn/completed'
        && (event.params.turnId ?? event.params.turn?.id) === latestTurnId)) dirty = true;
    } catch {
      finish('read_failed');
    } finally {
      reading = false;
      if (dirty && !closed) requestRefresh();
    }
  }

  function queuePending(message) {
    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    const boundary = value => ['thread/status/changed', 'turn/started', 'turn/completed'].includes(value.method);
    if (!repairTurns.has(turnId)) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (pendingBytes + bytes <= maxRetainedBytes && pending.length < 4096) {
        pending.push(message); pendingBytes += bytes; return;
      }
      if (turnId) {
        enterHistoryRepair(turnId);
      }
      pending = pending.flatMap(value => {
        if ((value.params?.turnId ?? value.params?.turn?.id) !== turnId) return [value];
        return boundary(value) ? [metadataNotification(value)] : [];
      });
    }
    // Large initialization bursts retain turn/status identities, never an
    // incomplete suffix that could later masquerade as a complete answer.
    if (boundary(message)) {
      pending = pending.filter(value => value.method !== message.method
        || (value.params?.turnId ?? value.params?.turn?.id) !== turnId);
      pending.push(metadataNotification(message));
    }
    pendingBytes = pending.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
  }

  function onNotification(type, payload) {
    try {
      if (closed) return;
      if (type === 'codex.desktop_live.poll_failed') { finish('notification_failed'); return; }
      if (type !== 'codex.desktop_live.notification' || payload?.params?.threadId !== threadId) return;
      const { method, params } = payload;
      const itemBoundary = method === 'item/started' || method === 'item/completed';
      const turnBoundary = method === 'turn/started' || method === 'turn/completed';
      let consumed = true;
      if (isBodyNotification(payload)) {
        if (initializing) {
          queuePending(bodyNotification(payload));
        } else {
          consumed = consumeNotification(payload) !== false;
        }
      }
      // Output deltas are frequent and do not change metadata. Boundaries,
      // status/settings changes and interactive requests warrant history repair.
      if (consumed && (itemBoundary || turnBoundary || isMetadataNotification(method))) invalidate();
    } finally {
      notifications.length = 0;
    }
  }

  response.on('close', abort);
  response.on('finish', abort);
  response.on('error', onError);
  request?.on('aborted', abort);
  try {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.flushHeaders?.();
    if (request?.aborted || response.destroyed || response.writableEnded) { abort(); return abort; }
    subscription = adapter.startNotificationPolling(threadId, notifications, onNotification);
    // A fixture (or adapter) can emit synchronously while subscribing.
    if (closed) { subscription.stop(); subscription = undefined; return abort; }
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    heartbeat.unref?.();
    lease = setTimeout(() => finish('max_age'), maxAgeMs);
    lease.unref?.();
    clearTimeout(readTimer);
    readTimer = undefined;
    void initialize();
  } catch {
    finish('subscription_failed');
  }
  return abort;
}

function isBodyNotification({ method, params }) {
  return method === 'thread/status/changed' || method === 'item/agentMessage/delta' || method === 'turn/started' || method === 'turn/completed'
    || method === 'item/started'
    || (method === 'item/completed' && (ASSISTANT_TYPES.has(params?.item?.type) || TOOL_TYPES.has(params?.item?.type)));
}

function notificationPosition(value) {
  if (Number.isSafeInteger(value)) return { epoch: 'legacy', sequence: value };
  if (typeof value !== 'string') return null;
  const colon = value.lastIndexOf(':');
  const sequence = Number(value.slice(colon + 1));
  if (colon < 1 || !/^\d+$/.test(value.slice(colon + 1)) || !Number.isSafeInteger(sequence)) return null;
  return { epoch: value.slice(0, colon), sequence };
}

function bodyNotification({ method, params, notificationId, at }) {
  const itemIdentity = item => TOOL_TYPES.has(item.type) ? toolFields(item) : ({ id: item.id, type: item.type,
    ...(ASSISTANT_TYPES.has(item.type) ? { text: item.text, status: item.status } : {}) });
  return { method, notificationId, at, params: {
    threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta,
    ...(method === 'thread/status/changed' ? { status: { type: params.status?.type } } : {}),
    ...(params.item ? { item: itemIdentity(params.item) } : {}),
    ...(params.turn ? { turn: { id: params.turn.id, status: params.turn.status,
      startedAt: params.turn.startedAt, updatedAt: params.turn.updatedAt,
      items: (params.turn.items ?? []).filter(Boolean).map(itemIdentity) } } : {})
  } };
}

function metadataNotification({ method, params, notificationId, at }) {
  return { method, notificationId, at, params: { threadId: params.threadId, turnId: params.turnId,
    ...(params.status ? { status: { type: params.status.type } } : {}),
    ...(params.turn ? { turn: { id: params.turn.id, status: params.turn.status,
      startedAt: params.turn.startedAt, updatedAt: params.turn.updatedAt, items: [] } } : {}) } };
}

function isMetadataNotification(method) {
  return typeof method === 'string' && (
    (method.startsWith('thread/') && !/\/(?:delta|outputDelta)$/.test(method))
    || /\/(?:requestApproval|requestUserInput|requestPermission)$/.test(method)
    || method === 'serverRequest/resolved'
    || method === 'turn/plan/updated'
    || method === 'turn/diff/updated'
    || method === 'error'
  );
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return '';
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
