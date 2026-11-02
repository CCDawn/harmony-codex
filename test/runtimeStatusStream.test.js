import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RuntimeStatusStream } from '../src/runtimeStatusStream.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const snapshot = (revision, state = 'running') => ({ schemaVersion: 1, epoch: 'pc', revision,
  generatedAt: new Date().toISOString(), stale: false, sessions: [{ threadId: 'A', state }] });
class Response extends EventEmitter {
  frames = [];
  writeHead(code, headers) { this.code = code; this.headers = headers; }
  write(frame) { this.frames.push(frame); return true; }
  end() { this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  values() { return this.frames.filter(frame => frame.startsWith('event: runtime.snapshot'))
    .map(frame => JSON.parse(frame.split('data: ')[1])); }
}
function fixture(readSnapshot) {
  let listener; let subscriptions = 0; let releases = 0;
  const hub = new RuntimeStatusStream({ readSnapshot, debounceMs: 1, intervalMs: 60000,
    subscribe(callback) { listener = callback; subscriptions++; return { stop() { releases++; } }; } });
  const open = () => { const response = new Response(); hub.open(new EventEmitter(), response); return response; };
  return { hub, open, event: (...args) => listener(...args), subscriptions: () => subscriptions, releases: () => releases };
}

test('phones share one observer, state events reconcile and text deltas do not poll history', async t => {
  let reads = 0; const f = fixture(async () => snapshot(++reads)); t.after(() => f.hub.close());
  const one = f.open(); await settle(); const two = f.open(); await settle();
  assert.equal(f.subscriptions(), 1); assert.equal(one.values().at(-1).desktop.connected, true);
  const before = reads;
  for (let i = 0; i < 30; i++) f.event('codex.desktop_live.notification', { method: 'item/agentMessage/delta' });
  await settle(); assert.equal(reads, before);
  for (let i = 0; i < 30; i++) f.event('codex.desktop_live.notification', { method: 'thread/status/changed' });
  await settle(); assert.equal(reads, before + 1); assert.equal(two.values().at(-1).snapshot.revision, reads);
  one.end(); assert.equal(f.releases(), 0); two.end(); assert.equal(f.releases(), 1);
});

test('failed canonical read reports unavailable and marks a retained snapshot stale', async t => {
  let fail = false; const f = fixture(async () => { if (fail) throw Error('private'); return snapshot(1); });
  t.after(() => f.hub.close()); const view = f.open(); await settle();
  fail = true; f.event('codex.desktop_live.poll_failed', {}); await settle();
  const value = view.values().at(-1); assert.equal(value.desktop.connected, false); assert.equal(value.snapshot.stale, true);
  assert.equal(view.frames.join('').includes('private'), false);
  fail = false; f.event('codex.desktop_live.notification', { method: 'turn/completed' }); await settle();
  assert.equal(view.values().at(-1).desktop.connected, true); assert.equal(view.values().at(-1).snapshot.stale, false);
});

test('a first read failure never invents an idle or completed session', async t => {
  const f = fixture(async () => { throw Error('offline'); }); t.after(() => f.hub.close());
  const view = f.open(); await settle(); assert.deepEqual(view.values()[0].snapshot, null);
  assert.equal(view.values()[0].desktop.state, 'unavailable');
});

test('a closed generation cannot overwrite a freshly opened phone with a late result', async t => {
  let release; let reads = 0;
  const f = fixture(() => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(snapshot(2)));
  t.after(() => f.hub.close()); const old = f.open(); old.end(); const next = f.open();
  release(snapshot(1)); await settle();
  assert.equal(next.values().at(-1).snapshot.revision, 2);
  assert.equal(next.values().some(value => value.snapshot?.revision === 1), false);
});

test('bounded slow readers are released without retaining a notification subscription', async t => {
  const f = fixture(async () => snapshot(1)); t.after(() => f.hub.close());
  const view = f.open(); view.writableLength = 2 * 1024 * 1024; await settle();
  assert.equal(view.destroyed, true); assert.equal(f.hub.clients.size, 0); assert.equal(f.releases(), 1);
});

test('real completion transitions arrive once for desktop turns without phone tasks', async t => {
  const f = fixture(async () => snapshot(1)); t.after(() => f.hub.close()); const view = f.open(); await settle();
  const event = (method, status, turnId = 'turn') => f.event('codex.desktop_live.notification',
    { method, params: { threadId: 'A', turn: { id: turnId, status } } });
  event('turn/completed', 'completed'); event('turn/completed', 'completed');
  event('turn/completed', 'interrupted', 'stopped');
  event('turn/completed', 'unknown', 'unknown');
  const frames = view.frames.filter(frame => frame.startsWith('event: runtime.transition'));
  assert.equal(frames.length, 1); assert.equal(JSON.parse(frames[0].split('data: ')[1]).turnId, 'turn');
});

test('a short turn is observed through lifecycle events and old inactive history is not notified', async t => {
  const f = fixture(async () => snapshot(1, 'idle')); t.after(() => f.hub.close()); const view = f.open(); await settle();
  const send = (method, id, status) => f.event('codex.desktop_live.notification',
    { method, params: { threadId: 'A', turn: { id, status } } });
  send('turn/completed', 'old', 'completed');
  send('turn/started', 'new', 'inProgress'); send('turn/completed', 'new', 'failed');
  assert.equal(view.frames.filter(frame => frame.startsWith('event: runtime.transition')).length, 1);
});
