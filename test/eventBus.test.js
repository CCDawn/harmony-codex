import assert from 'node:assert/strict';
import test from 'node:test';
import { EventBus } from '../src/eventBus.js';

test('receipt observers receive events without phone task subscribers and can unsubscribe', () => {
  const bus = new EventBus();
  const all = [], selected = [];
  const off = bus.subscribeAll(event => all.push(event));
  const event = { type: 'codex.app_server.turn.started' };
  bus.publish('task-a', event);
  const offTask = bus.subscribe('task-b', value => selected.push(value));
  bus.publish('task-b', event);
  off(); offTask();
  bus.publish('task-b', event);
  assert.deepEqual(all, [event, event]);
  assert.deepEqual(selected, [event]);
  assert.equal(bus.observers.size, 0);
});
