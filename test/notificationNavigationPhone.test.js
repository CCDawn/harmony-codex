import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
const start = source.indexOf('  private async applyPendingNotificationNavigation(');
const end = source.indexOf('\n  }', start) + 4;
const body = source.slice(start, end);
const watcherStart = source.indexOf('  private notificationTargetChanged(');
const watcher = watcherStart < 0 ? '' : source.slice(watcherStart, source.indexOf('\n  }', watcherStart) + 4);

function setup(read = async () => ({ id: 'target', title: 'Completed target', updatedAt: 'now', entries: [] })) {
  const opened = [], reads = [], logs = [];
  const context = vm.createContext({ BridgeClient: { async getSession(...args) { reads.push(args); return read(...args); } } });
  vm.runInContext(stripTypeScriptTypes(`class Page { ${body} ${watcher} } globalThis.Page = Page;`), context);
  let navigation = { revision: 1, mode: 'home', sessionId: '' };
  const page = Object.assign(new context.Page(), {
    notificationTargetRevision: 'notice-1', notificationTargetSessionId: 'target',
    notificationTargetEventType: 'completed', notificationTargetEventId: 'event-1',
    lastHandledNotificationRevision: '', notificationNavigationBusy: false,
    appForeground: true,
    sessions: [], bridgeToken: 'authority-one', selectedSession: null,
    normalizedBridgeUrl: () => 'https://fixture.test/bridge',
    readSessionNavigation: () => navigation,
    isSessionNavigationCurrent: (revision, id) => navigation.revision === revision && navigation.mode === 'session' && navigation.sessionId === id,
    async openSession(target) { opened.push(target.id); navigation = { revision: navigation.revision + 1, mode: 'session', sessionId: target.id }; page.selectedSession = target; },
    scrollSessionToBottomIfFollowing() {}, errorText: error => error.message,
    log(level, event, details) { logs.push({ level, event, details }); }
  });
  return { page, opened, reads, logs, navigate(id) { navigation = { revision: navigation.revision + 1, mode: 'session', sessionId: id }; } };
}

test('a notification opens its canonical conversation even when absent from the current sidebar page', async () => {
  const h = setup(); await h.page.applyPendingNotificationNavigation();
  assert.deepEqual(h.opened, ['target']);
  assert.deepEqual(h.reads, [['https://fixture.test/bridge', 'target', 'authority-one']]);
  assert.equal(h.page.notificationTargetSessionId, '');
  assert.equal(h.page.lastHandledNotificationRevision, 'notice-1');
});

test('a foreground new-Want revision opens immediately instead of waiting for a dashboard refresh', async () => {
  const h = setup();
  assert.match(source, /@StorageLink\(NOTIFICATION_REVISION_STORAGE_KEY\)\s*@Watch\('notificationTargetChanged'\)/);
  assert.equal(typeof h.page.notificationTargetChanged, 'function');
  h.page.notificationTargetChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, ['target']);
  const background = setup(); background.page.appForeground = false;
  background.page.notificationTargetChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(background.opened, [], 'a background revision stays pending until foreground');
});

test('a newer notification arriving during lookup is processed immediately after the old owner retires', async () => {
  let finish;
  const h = setup((_url, id) => id === 'target' ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ id, title: 'Newest target', updatedAt: 'now', entries: [] }));
  const old = h.page.applyPendingNotificationNavigation();
  h.page.notificationTargetRevision = 'notice-2'; h.page.notificationTargetSessionId = 'new-target';
  await h.page.applyPendingNotificationNavigation();
  finish({ id: 'target', title: 'Old target', updatedAt: 'now', entries: [] });
  await old; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, ['new-target']);
  assert.equal(h.page.lastHandledNotificationRevision, 'notice-2');
});

test('a listed target uses the existing session without an additional lookup', async () => {
  const h = setup(); h.page.sessions = [{ id: 'target', title: 'Listed', detailAvailable: true }];
  await h.page.applyPendingNotificationNavigation();
  assert.deepEqual(h.opened, ['target']); assert.equal(h.reads.length, 0);
});

for (const change of ['navigation', 'credentials', 'notification']) {
  test(`an in-flight notification lookup cannot override changed ${change}`, async () => {
    let finish; const h = setup(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.page.applyPendingNotificationNavigation();
    if (change === 'navigation') h.navigate('reader-choice');
    if (change === 'credentials') h.page.bridgeToken = 'authority-two';
    if (change === 'notification') { h.page.notificationTargetRevision = 'notice-2'; h.page.notificationTargetSessionId = 'new-target'; }
    finish({ id: 'target', title: 'Old target', updatedAt: 'now', entries: [] }); await pending;
    assert.deepEqual(h.opened, []); assert.equal(h.page.lastHandledNotificationRevision, 'notice-1');
    assert.equal(h.page.notificationTargetSessionId, change === 'notification' ? 'new-target' : 'target');
    if (change !== 'notification') { await h.page.applyPendingNotificationNavigation(); assert.deepEqual(h.opened, []); }
  });
}

test('concurrent lifecycle refreshes share one notification lookup and open it once', async () => {
  let finish; const h = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.page.applyPendingNotificationNavigation();
  await h.page.applyPendingNotificationNavigation();
  assert.equal(h.reads.length, 1);
  finish({ id: 'target', title: 'Target', updatedAt: 'now', entries: [] }); await pending;
  await h.page.applyPendingNotificationNavigation(); assert.deepEqual(h.opened, ['target']);
});

test('a failed target read keeps the notification pending for a later foreground refresh', async () => {
  let fail = true; const h = setup(async () => { if (fail) throw new Error('offline'); return { id: 'target', title: 'Target', updatedAt: 'now', entries: [] }; });
  await h.page.applyPendingNotificationNavigation();
  assert.deepEqual(h.opened, []); assert.equal(h.page.notificationTargetSessionId, 'target');
  assert.equal(h.page.notificationNavigationBusy, false);
  fail = false; await h.page.applyPendingNotificationNavigation(); assert.deepEqual(h.opened, ['target']);
});

test('manual navigation during the target history load cancels the old notification navigation', async () => {
  const h = setup(); h.page.sessions = [{ id: 'target', title: 'Listed', detailAvailable: true }];
  let finish;
  h.page.openSession = () => { h.navigate('target'); h.page.selectedSession = { id: 'target' }; return new Promise(resolve => { finish = resolve; }); };
  const pending = h.page.applyPendingNotificationNavigation();
  h.navigate('reader-choice'); finish(); await pending;
  assert.equal(h.page.lastHandledNotificationRevision, 'notice-1');
  assert.equal(h.page.notificationTargetSessionId, 'target');
  await h.page.applyPendingNotificationNavigation(); assert.equal(h.page.readSessionNavigation().sessionId, 'reader-choice');
});
