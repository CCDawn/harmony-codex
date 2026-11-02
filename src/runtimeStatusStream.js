// One read-only runtime observer per bridge, shared by all phone status views.
// Business notifications trigger reconciliation; the timer also detects a lost
// desktop channel when no thread emits an event. No turn is resumed or started.
export class RuntimeStatusStream {
  constructor({ readSnapshot, subscribe, intervalMs = 5000, debounceMs = 120,
    heartbeatMs = 15000, leaseMs = 300000, maxBufferedBytes = 1024 * 1024 } = {}) {
    this.readSnapshot = readSnapshot;
    this.subscribe = subscribe;
    this.intervalMs = intervalMs;
    this.debounceMs = debounceMs;
    this.heartbeatMs = heartbeatMs;
    this.leaseMs = leaseMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.clients = new Set();
    this.generation = 0;
    this.reading = false;
    this.dirty = false;
    this.lastSnapshot = null;
    this.observedTurns = new Set();
    this.completedTurns = new Set();
  }

  open(request, response) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' });
    response.flushHeaders?.();
    const client = { response };
    const close = () => {
      if (!this.clients.delete(client)) return;
      clearTimeout(client.lease);
      request?.off('aborted', close);
      response.off('close', close);
      response.off('finish', close);
      response.off('error', close);
      if (!this.clients.size) this.stop();
    };
    client.close = close;
    request?.once('aborted', close);
    response.once('close', close);
    response.once('finish', close);
    response.once('error', close);
    client.lease = setTimeout(() => {
      this.write(client, 'event: stream.control\ndata: {"reason":"reconnect"}\n\n');
      close();
      response.end();
    }, this.leaseMs);
    client.lease.unref?.();
    this.clients.add(client);
    if (this.clients.size === 1) this.start();
    else this.schedule();
  }

  start() {
    this.generation += 1;
    this.lastSnapshot = null;
    const generation = this.generation;
    try {
      this.subscription = this.subscribe?.((type, payload) => {
        if (generation !== this.generation || !this.clients.size) return;
        if (type === 'codex.desktop_live.poll_failed') {
          this.publish(false, 'unavailable');
          this.schedule();
        } else if (/^(thread\/(?:status\/changed|started|archived|unarchived)|turn\/(?:started|completed))$/.test(payload?.method ?? '')) {
          this.observeTransition(payload);
          this.schedule();
        }
      });
    } catch { /* Periodic canonical reads can still recover the connection. */ }
    this.timer = setInterval(() => this.schedule(), this.intervalMs);
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) this.write(client, ': heartbeat\n\n');
    }, this.heartbeatMs);
    this.timer.unref?.();
    this.heartbeat.unref?.();
    void this.refresh(generation);
  }

  schedule() {
    if (!this.clients.size) return;
    this.dirty = true;
    if (this.reading || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.refresh(this.generation);
    }, this.debounceMs);
    this.pending.unref?.();
  }

  async refresh(generation) {
    if (this.reading || generation !== this.generation || !this.clients.size) return;
    this.reading = true;
    this.dirty = false;
    try {
      const snapshot = await this.readSnapshot();
      if (generation !== this.generation || !this.clients.size) return;
      this.lastSnapshot = snapshot;
      this.publish(snapshot.stale !== true, snapshot.stale ? 'stale' : 'ready');
    } catch {
      if (generation === this.generation && this.clients.size) this.publish(false, 'unavailable');
    } finally {
      this.reading = false;
      // Reopening while an old read was pending must not strand the new view.
      if (this.clients.size && (this.dirty || generation !== this.generation)) this.schedule();
    }
  }

  publish(connected, state) {
    const snapshot = this.lastSnapshot === null ? null
      : { ...this.lastSnapshot, stale: !connected || this.lastSnapshot.stale === true };
    const data = { snapshot, desktop: { connected, state }, observedAt: new Date().toISOString() };
    const frame = `event: runtime.snapshot\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) this.write(client, frame);
  }

  observeTransition(message) {
    const params = message?.params ?? {};
    const threadId = String(params.threadId ?? '');
    const turnId = String(params.turnId ?? params.turn?.id ?? '');
    if (!threadId || !turnId) return;
    const key = `${threadId}:${turnId}`;
    if (message.method === 'turn/started') {
      this.observedTurns.add(key);
      if (this.observedTurns.size > 1000) this.observedTurns.delete(this.observedTurns.values().next().value);
      return;
    }
    const wasRunning = this.observedTurns.has(key) || this.lastSnapshot?.stale !== true
      && this.lastSnapshot?.sessions.some(session => session.threadId === threadId
        && ['running', 'waiting_input', 'waiting_approval', 'recovering'].includes(session.state));
    const state = params.turn?.status ?? params.status;
    if (message.method !== 'turn/completed' || !wasRunning || this.completedTurns.has(key)
      || !['completed', 'failed'].includes(state)) return;
    this.completedTurns.add(key);
    this.observedTurns.delete(key);
    if (this.completedTurns.size > 1000) this.completedTurns.delete(this.completedTurns.values().next().value);
    const frame = `event: runtime.transition\ndata: ${JSON.stringify({ threadId, turnId, state })}\n\n`;
    for (const client of [...this.clients]) this.write(client, frame);
  }

  write(client, frame) {
    const response = client.response;
    if (response.destroyed || response.writableEnded
      || Buffer.byteLength(frame) + (response.writableLength || 0) > this.maxBufferedBytes) {
      client.close();
      response.destroy();
      return;
    }
    try { response.write(frame); }
    catch { client.close(); response.destroy(); }
  }

  stop() {
    this.generation += 1;
    this.subscription?.stop();
    this.subscription = null;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.pending);
    this.pending = null;
    this.dirty = false;
    this.observedTurns.clear();
  }

  close() {
    for (const client of [...this.clients]) {
      client.close();
      client.response.end();
    }
    this.stop();
  }
}
