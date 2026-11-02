import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/AppNotificationService.ets', 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const THREAD_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const THREAD_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function harness() {
  const published = [], badges = [];
  let foreground = false;
  const context = vm.createContext({
    AppStorage: { get: () => foreground },
    wantAgent: { async getWantAgent(options) { return options; },
      OperationType: { START_ABILITY: 0 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 0 } },
    notificationManager: {
      async publish(notification) { published.push(notification); },
      async setBadgeNumber(count) { badges.push(count); },
      SlotType: { CONTENT_INFORMATION: 0 }, ContentType: { NOTIFICATION_CONTENT_BASIC_TEXT: 0 }
    }
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) + '\nglobalThis.service = AppNotificationService;', context);
  return { service: context.service, published, badges,
    foreground(value) { foreground = value; },
    publish(sessionId, type = 'completed') { return context.service.publish({ sessionId, type, eventId: 'safe-event' }, 1); } };
}

test('background completion falls back locally for a thread outside acknowledged push coverage', async () => {
  const h = harness();
  h.service.setRemotePushEnabled(true, [THREAD_A]);
  await h.publish(THREAD_A);
  assert.equal(h.published.length, 0); assert.equal(h.badges.length, 1);
  await h.publish(THREAD_B);
  assert.equal(h.published.length, 1); assert.equal(h.badges.length, 2);
  assert.equal(h.published[0].wantAgent.wants[0].parameters.codexRemoteNotificationSessionId, THREAD_B);
});

test('all supported cloud types suppress only covered threads and connection warnings remain local', async () => {
  const h = harness();
  h.service.setRemotePushEnabled(true, [THREAD_A]);
  for (const type of ['completed', 'failed', 'approval_required', 'user_input_required']) {
    await h.publish(THREAD_A, type); await h.publish(THREAD_B, type);
  }
  assert.equal(h.published.length, 4);
  await h.publish(THREAD_A, 'connection_error');
  assert.equal(h.published.length, 5);
});

test('foreground completion remains local even for a covered thread', async () => {
  const h = harness();
  h.service.setRemotePushEnabled(true, [THREAD_A]); h.foreground(true);
  await h.publish(THREAD_A);
  assert.equal(h.published.length, 1);
});

test('coverage is copied and a later ready registration replaces the covered thread set', async () => {
  const h = harness(); const threads = [THREAD_A];
  h.service.setRemotePushEnabled(true, threads); threads.push(THREAD_B);
  await h.publish(THREAD_B); assert.equal(h.published.length, 1);
  h.service.setRemotePushEnabled(true, [THREAD_B]);
  await h.publish(THREAD_A); await h.publish(THREAD_B);
  assert.equal(h.published.length, 2);
});

test('disabled or empty push coverage never suppresses a local completion', async () => {
  const h = harness();
  h.service.setRemotePushEnabled(true, [THREAD_A]);
  h.service.setRemotePushEnabled(false, [THREAD_A]);
  await h.publish(THREAD_A); assert.equal(h.published.length, 1);
  h.service.setRemotePushEnabled(true);
  await h.publish(THREAD_A); assert.equal(h.published.length, 2);
});
