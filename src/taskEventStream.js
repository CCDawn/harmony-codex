import { paginateTaskEvents } from './taskEventCursor.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

// Controls never carry an SSE id. Only a fully consumed business frame advances
// the client's cursor; a gap requires a fresh task/run snapshot before reconnect.
export function openTaskEventStream({
  request, response, eventBus, sourceId, getSnapshot,
  heartbeatMs = 15_000, maxAgeMs = 300_000,
  maxBufferedBytes = 256 * 1024, closeGraceMs = 1_000,
  backpressureTimeoutMs = 15_000
}) {
  const { afterSeq, cursorRequested } = readStreamCursor(request);
  let cursor = afterSeq;
  let latestSeq = afterSeq;
  let closed = false;
  let replaying = true;
  let unsubscribe;
  let heartbeat;
  let maxAge;
  let closeDeadline;
  let backpressureDeadline;
  let paused = false;

  function cleanup() {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(heartbeat);
    clearTimeout(maxAge);
    clearTimeout(backpressureDeadline);
    response.off('drain', onDrain);
    request?.off('aborted', abort);
  }

  function abort() {
    cleanup();
    clearTimeout(closeDeadline);
    response.off('close', abort);
    response.off('finish', abort);
    response.off('error', onError);
  }

  function onError() {
    abort();
    response.destroy();
  }

  function finish(reason, extra = {}) {
    if (closed) return;
    cleanup();
    if (response.destroyed || response.writableEnded) return;
    // Bound graceful shutdown too: a peer that stops reading must release its
    // socket and subscription rather than retaining a pending end indefinitely.
    closeDeadline = setTimeout(() => response.destroy(), closeGraceMs);
    closeDeadline.unref?.();
    const control = { type: 'stream.control', reason, eventCursor: cursor, latestSeq, ...extra };
    try {
      const frame = `event: stream.control\ndata: ${JSON.stringify(control)}\n\n`;
      if (Buffer.byteLength(frame) + (response.writableLength || 0) > maxBufferedBytes) onError();
      else response.end(frame);
    } catch {
      onError();
    }
  }

  function onDrain() {
    if (closed) return;
    paused = false;
    clearTimeout(backpressureDeadline);
    // Events are already persisted by the publisher. Replay that tail instead
    // of retaining an additional unbounded per-subscriber queue.
    replaying = true;
    replay(true);
    replaying = false;
    checkTerminal();
  }

  function write(frame) {
    if (closed || paused || response.destroyed || response.writableEnded) return false;
    if (Buffer.byteLength(frame) + (response.writableLength || 0) > maxBufferedBytes) {
      finish('gap', { requiresSnapshot: true, detail: 'buffer_limit' });
      return false;
    }
    try {
      if (!response.write(frame)) {
        // false means the frame was accepted; wait for drain before writing
        // more. A genuinely stalled reader still has a bounded lifetime.
        paused = true;
        response.once('drain', onDrain);
        backpressureDeadline = setTimeout(() => finish('reconnect', {
          reconnect: true, detail: 'backpressure_timeout'
        }), backpressureTimeoutMs);
        backpressureDeadline.unref?.();
        return false;
      }
      return true;
    } catch {
      onError();
      return false;
    }
  }

  function sendEvent(event) {
    if (closed || paused) return;
    const seq = Number(event?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      finish('gap', { requiresSnapshot: true, detail: 'invalid_event_sequence' });
      return;
    }
    latestSeq = Math.max(latestSeq, seq);
    if (seq <= cursor) return;
    if (seq !== cursor + 1) {
      finish('gap', { requiresSnapshot: true, earliestSeq: seq, detail: 'sequence_gap' });
      return;
    }
    const frame = `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    // Advance only after the write is accepted. A backpressured write is still
    // accepted by Node; clients must resume from their own last parsed id.
    if (Buffer.byteLength(frame) + (response.writableLength || 0) <= maxBufferedBytes) cursor = seq;
    write(frame);
  }

  function checkTerminal() {
    if (closed || paused) return;
    const snapshot = currentSnapshot();
    if (snapshot && TERMINAL_STATUSES.has(snapshot.status)) {
      // A publisher can finish during replay. Flush its persisted tail before
      // closing, even if the queued notification has not run yet.
      replay(true);
      if (closed || paused) return;
      finish('terminal', { status: snapshot.status, requiresSnapshot: true });
    }
  }

  function currentSnapshot() {
    try {
      const snapshot = getSnapshot();
      if (snapshot) return snapshot;
    } catch {
      // Timer and bus callbacks must not throw into the shared server process.
    }
    finish('reconnect', { reconnect: true, detail: 'source_unavailable' });
    return null;
  }

  // Subscribe before taking the replay snapshot. Publishers persist events
  // before notifying this bus; a reentrant notification during replay is picked
  // up in a follow-up snapshot, with the cursor suppressing duplicates.
  function replay(cursorWasRequested) {
    if (closed || paused) return;
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    const page = paginateTaskEvents(snapshot.events, {
      afterSeq: cursor, cursorRequested: cursorWasRequested,
      eventLimit: snapshot.events?.length || 0
    });
    latestSeq = page.latestSeq;
    if (page.eventGap) {
      finish('gap', { requiresSnapshot: true, earliestSeq: page.events[0]?.seq ?? latestSeq + 1 });
      return;
    }
    // Legacy connections replay retained history even when it begins above 1.
    if (!cursorWasRequested && page.events.length) cursor = page.events[0].seq - 1;
    for (const event of page.events) {
      sendEvent(event);
      if (closed || paused) break;
    }
  }

  response.on('close', abort);
  response.on('finish', abort);
  response.on('error', onError);
  request?.on('aborted', abort);
  unsubscribe = eventBus.subscribe(sourceId, (event) => {
    if (closed || paused) return;
    if (replaying) queueMicrotask(() => { replay(true); checkTerminal(); });
    else {
      sendEvent(event);
      // Run status may be updated immediately after the terminal notification.
      queueMicrotask(checkTerminal);
    }
  });
  try {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.flushHeaders?.();
    replay(cursorRequested);
    replaying = false;
    checkTerminal();
    if (!closed) {
      heartbeat = setInterval(() => {
        checkTerminal();
        if (!closed) write(': heartbeat\n\n');
      }, heartbeatMs);
      heartbeat.unref?.();
      // The next HTTP request passes through the existing auth gate again.
      maxAge = setTimeout(() => finish('reconnect', { reconnect: true, detail: 'max_age' }), maxAgeMs);
      maxAge.unref?.();
    }
  } catch (error) {
    abort();
    throw error;
  }
  return abort;
}

export function readStreamCursor(request) {
  const url = new URL(request?.url ?? '/', 'http://127.0.0.1');
  const queryCursor = url.searchParams.get('afterSeq');
  const headerCursor = request?.headers?.['last-event-id'];
  const raw = queryCursor ?? headerCursor;
  if (raw === undefined || raw === null) return { afterSeq: 0, cursorRequested: false };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    const error = new Error('Invalid event cursor');
    error.statusCode = 400;
    throw error;
  }
  return { afterSeq: Number(raw), cursorRequested: true };
}
