import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/SessionDraftStore.ets', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.Store = SessionDraftStore;', context);
const scope = (sessionId = 'A', overrides = {}) => ({
  bridgeUrl: 'http://bridge-one', bridgeToken: 'pair-one', sessionId, projectId: 'project-one', ...overrides
});
const draft = (text = 'unsent message', overrides = {}) => ({ text, images: [], files: [], ...overrides });
const copy = value => JSON.parse(JSON.stringify(value));
const image = { id: 'image-one', uri: 'file://image-one', fileName: 'one.png', mimeType: 'image/png' };
const file = { id: 'file-one', uri: 'file://file-one', fileName: 'one.md', mimeType: 'text/markdown', bytes: 123 };

test('switching A to B and back restores each unsent message without carrying A into B', () => {
  const store = new context.Store();
  assert.equal(store.save(scope('A'), draft(' A draft\n')), true);
  assert.equal(store.has(scope('B')), false);
  assert.equal(store.load(scope('B')), null);
  assert.equal(store.save(scope('B'), draft('B draft')), true);
  assert.equal(store.load(scope('A')).text, ' A draft\n');
  assert.equal(store.load(scope('B')).text, 'B draft');
});

test('pairing URL and token isolate even the same session and survive switching identities', () => {
  const store = new context.Store();
  store.save(scope(), draft('original pair'));
  const anotherUrl = scope('A', { bridgeUrl: 'http://bridge-two' });
  const anotherToken = scope('A', { bridgeToken: 'pair-two' });
  assert.equal(store.load(anotherUrl), null);
  assert.equal(store.load(anotherToken), null);
  store.save(anotherUrl, draft('another computer'));
  store.save(anotherToken, draft('another pairing'));
  assert.equal(store.load(scope()).text, 'original pair');
  assert.equal(store.load(anotherUrl).text, 'another computer');
  assert.equal(store.load(anotherToken).text, 'another pairing');
});

test('new conversations are scoped by project and cannot collide with existing session IDs', () => {
  const store = new context.Store();
  const first = scope('', { projectId: 'project-A' });
  const second = scope('', { projectId: 'project-B' });
  store.save(first, draft('new A'));
  assert.equal(store.load(second), null);
  assert.equal(store.load(scope('project-A')), null);
  store.save(second, draft('new B'));
  store.save(scope('project-A'), draft('existing session'));
  assert.equal(store.load(first).text, 'new A');
  assert.equal(store.load(second).text, 'new B');
  assert.equal(store.load(scope('project-A', { projectId: 'changed project metadata' })).text, 'existing session');
  const collisionA = scope('c', { bridgeUrl: 'a|b', bridgeToken: 'x' });
  const collisionB = scope('c', { bridgeUrl: 'a', bridgeToken: 'b|x' });
  store.save(collisionA, draft('tuple A'));
  assert.equal(store.load(collisionB), null);
});

test('attachment-only drafts preserve all picker fields and isolate save/load mutations', () => {
  const store = new context.Store();
  const original = draft('', { images: [{ ...image }], files: [{ ...file }] });
  const expected = copy(original);
  assert.equal(store.save(scope(), original), true);
  original.images[0].uri = 'changed after save';
  original.files[0].bytes = 999;
  original.images.push({ ...image, id: 'extra' });
  original.files.length = 0;
  const restored = store.load(scope());
  assert.deepEqual(copy(restored), expected);
  restored.text = 'changed after load';
  restored.images[0].fileName = 'changed.png';
  restored.files[0].uri = 'changed after load';
  restored.images.length = 0;
  restored.files.push({ ...file, id: 'extra' });
  assert.deepEqual(copy(store.load(scope())), expected);
});

test('failed send leaves a draft available; successful send removes only the submitted scope', () => {
  const store = new context.Store();
  const pending = draft('retry me', { images: [image], files: [file] });
  store.save(scope('A'), pending);
  store.save(scope('B'), draft('keep B'));
  assert.deepEqual(copy(store.load(scope('A'))), pending, 'load is non-destructive for failed sends');
  store.remove(scope('A'));
  assert.equal(store.has(scope('A')), false);
  assert.equal(store.load(scope('A')), null);
  assert.equal(store.load(scope('B')).text, 'keep B');
  store.remove(scope('A'));
});

test('saving an empty composer removes its older draft and each attachment kind counts as non-empty', () => {
  const store = new context.Store();
  store.save(scope(), draft());
  assert.equal(store.save(scope(), draft('')), true);
  assert.equal(store.has(scope()), false);
  assert.equal(store.save(scope(), draft('', { images: [image] })), true);
  assert.equal(store.has(scope()), true);
  assert.equal(store.save(scope(), draft('', { files: [file] })), true);
  assert.equal(store.load(scope()).files[0].bytes, file.bytes);
});

test('64-draft capacity refuses new scopes without eviction, permits updates, and releases removed slots', () => {
  const store = new context.Store();
  for (let index = 0; index < 64; index += 1) {
    assert.equal(store.save(scope(`session-${index}`), draft(`draft-${index}`)), true);
  }
  assert.equal(store.save(scope('overflow'), draft('must stay in composer')), false);
  assert.equal(store.has(scope('overflow')), false);
  for (let index = 0; index < 64; index += 1) {
    assert.equal(store.load(scope(`session-${index}`)).text, `draft-${index}`);
  }
  assert.equal(store.save(scope('session-0'), draft('updated at capacity')), true);
  assert.equal(store.load(scope('session-0')).text, 'updated at capacity');
  assert.equal(store.save(scope('untracked-empty'), draft('')), true);
  assert.equal(store.save(scope('session-1'), draft('')), true);
  assert.equal(store.save(scope('overflow'), draft('retained now')), true);
  assert.equal(store.save(scope('still-overflow'), draft()), false);
  store.remove(scope('session-2'));
  assert.equal(store.save(scope('still-overflow'), draft()), true);
});

test('capacity is bounded across identities and projects, with no hidden eviction or disk persistence', () => {
  const store = new context.Store();
  for (let index = 0; index < 64; index += 1) {
    store.save(scope('', { projectId: `project-${index}` }), draft(`new-${index}`));
  }
  assert.equal(store.save(scope('A', { bridgeToken: 'another-pair' }), draft()), false);
  assert.equal(store.load(scope('', { projectId: 'project-0' })).text, 'new-0');
  assert.equal(new context.Store().load(scope('', { projectId: 'project-0' })), null);
});
