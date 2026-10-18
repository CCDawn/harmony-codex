import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { createVoiceProcessSupervisor } from '../src/voiceProcess.js';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for supervisor');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('repeated early process exits increase the restart delay', async t => {
  const events = [];
  const supervisor = createVoiceProcessSupervisor({
    config: { voiceEnabled: true, voiceCommand: `"${process.execPath}" -e "process.exit(1)"`,
      voiceReconnectDelayMs: 40 },
    logger: { write: (_channel, _level, event, data) => events.push({ event, ...data }) }
  });
  t.after(() => supervisor.close());
  await supervisor.ensureRunning();
  await until(() => events.filter(e => e.event === 'voice.server.restart_scheduled').length >= 3);
  const delays = events.filter(e => e.event === 'voice.server.restart_scheduled').slice(0, 3).map(e => e.delayMs);
  assert.deepEqual(delays, [40, 80, 120]);
});

test('closing the supervisor cancels a pending restart', async t => {
  let starts = 0;
  let scheduled = false;
  const supervisor = createVoiceProcessSupervisor({
    config: { voiceEnabled: true, voiceCommand: `"${process.execPath}" -e "process.exit(1)"`,
      voiceReconnectDelayMs: 150 },
    logger: { write: (_channel, _level, event) => {
      if (event === 'voice.server.starting') starts += 1;
      if (event === 'voice.server.restart_scheduled') scheduled = true;
    } }
  });
  t.after(() => supervisor.close());
  await supervisor.ensureRunning();
  await until(() => scheduled);
  supervisor.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(starts, 1);
  assert.equal(supervisor.status().running, false);
});

test('a process surviving thirty seconds resets the crash streak', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new EventEmitter();
  const supervisor = createVoiceProcessSupervisor({
    config: { voiceEnabled: true, voiceCommand: `"${process.execPath}" -e "setInterval(()=>{},200)"`,
      voiceReconnectDelayMs: 40 },
    logger: { write: (_channel, _level, event, data) => events.emit(event, data) }
  });
  t.after(() => supervisor.close());
  const first = await supervisor.ensureRunning();
  let restarted = once(events, 'voice.server.restart_scheduled');
  process.kill(first.pid);
  assert.equal((await restarted)[0].delayMs, 40);
  const second = await supervisor.ensureRunning();
  t.mock.timers.tick(30000);
  restarted = once(events, 'voice.server.restart_scheduled');
  process.kill(second.pid);
  assert.equal((await restarted)[0].delayMs, 40);
});
