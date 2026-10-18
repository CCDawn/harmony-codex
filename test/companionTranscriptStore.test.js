import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/CompanionTranscriptStore.ets', import.meta.url), 'utf8').replace(/^import\s+.*?;\s*$/gm, '').replace('export class CompanionTranscriptStore', 'class CompanionTranscriptStore');
const executable = `${stripTypeScriptTypes(source, { mode: 'strip' })}\nglobalThis.Store = CompanionTranscriptStore;`;
const partition = { bridgeUrl: 'https://bridge.example', assistantId: 'assistant-a', roomId: 'room-a' };
const turn = (n, text = `final turn ${n}`) => ({ itemId: `voice:call-a:item-${n}`, role: n % 2 ? 'assistant' : 'user', text, final: true, phoneTranscript: true, callId: 'call-a' });
const plain = value => JSON.parse(JSON.stringify(value));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-store-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'companion-store-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const faults = { shortWrite: false, renameInstall: false, sync: false };
  const fileIo = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    readTextSync: file => fs.readFileSync(file, 'utf8'),
    mkdirSync: dir => {
      if (fs.existsSync(dir)) throw Object.assign(Error('File exists'), { code: 13900015 });
      fs.mkdirSync(dir, { recursive: true });
    },
    openSync: file => ({ fd: fs.openSync(file, 'w') }),
    writeSync(fd, buffer) {
      if (!(buffer instanceof ArrayBuffer)) throw Object.assign(Error('Invalid buffer argument'), { code: 401 });
      const bytes = new Uint8Array(buffer);
      return fs.writeSync(fd, bytes, 0, faults.shortWrite ? Math.floor(bytes.length / 2) : bytes.length);
    },
    fsyncSync(fd) { if (faults.sync) throw Error('synthetic sync failure'); fs.fsyncSync(fd); },
    closeSync: file => fs.closeSync(file.fd), unlinkSync: file => fs.unlinkSync(file),
    renameSync(from, to) { if (faults.renameInstall && from.endsWith('/turns.tmp')) throw Error('synthetic install failure'); fs.renameSync(from, to); }
  };
  function freshStore() {
    const context = vm.createContext({ fileIo, util: { TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } } } });
    vm.runInContext(executable, context);
    return context.Store;
  }
  return { Store: freshStore(), freshStore, context: { filesDir: root.replaceAll('\\', '/') }, faults };
}
test('origin canonicalization isolates rooms assistants and servers without credentials', t => {
  const { Store } = setup(t);
  assert.equal(Store.normalizeBridgeOrigin(' HTTPS://Bridge.Example:443/api?q=secret '), 'https://bridge.example');
  assert.equal(Store.normalizeBridgeOrigin('http://bridge.example:80/'), 'http://bridge.example');
  assert.throws(() => Store.normalizeBridgeOrigin('https://user:password@bridge.example'), /桥接地址无效/);
  const keys = [partition, { ...partition, roomId: 'room-b' }, { ...partition, assistantId: 'assistant-b' }, { ...partition, bridgeUrl: 'https://other.example' }].map(p => Store.partitionKey(p));
  assert.equal(new Set(keys).size, 4);
  assert.ok(!Store.partitionKey({ ...partition, assistantId: '../escape' }).includes('..'));
});
test('concurrent large final turns survive a fresh store and preserve roles', async t => {
  const { Store, freshStore, context } = setup(t);
  const text = '长通话内容🙂'.repeat(1800);
  await Promise.all(Array.from({ length: 35 }, (_, n) => Store.appendFinal(context, partition, turn(n, `${n}:${text}`))));
  const reloaded = plain(await freshStore().load(context, partition));
  assert.equal(reloaded.length, 35);
  reloaded.forEach((entry, n) => {
    assert.equal(entry.text, `${n}:${text}`); assert.equal(entry.role, n % 2 ? 'assistant' : 'user');
    assert.equal(entry.callId, 'call-a'); assert.equal(entry.localStorageStatus, 'saved');
  });
  assert.deepEqual(plain(await Store.load(context, { ...partition, assistantId: 'assistant-b' })), []);
  await Store.appendFinal(context, partition, turn(2, 'same identity updated'));
  assert.equal((await Store.load(context, partition)).length, 35);
});
test('invalid turns and corrupt storage fail visibly without overwriting original bytes', async t => {
  const { Store, context } = setup(t);
  await assert.rejects(Store.appendFinal(context, partition, { ...turn(0), final: false }), /身份不完整/);
  await Store.appendFinal(context, partition, turn(0));
  const file = Store.documentPath(context, partition);
  fs.writeFileSync(file, '{broken');
  await assert.rejects(Store.load(context, partition), /无法读取/);
  await assert.rejects(Store.appendFinal(context, partition, turn(1)), /无法读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('mismatched document never leaks another assistant history', async t => {
  const { Store, context } = setup(t);
  await Store.appendFinal(context, partition, turn(0));
  const file = Store.documentPath(context, partition);
  const wrong = JSON.parse(fs.readFileSync(file, 'utf8')); wrong.roomId = 'different-room';
  fs.writeFileSync(file, JSON.stringify(wrong));
  await assert.rejects(Store.load(context, partition), /身份不匹配/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).roomId, 'different-room');
});
for (const fault of ['shortWrite', 'renameInstall', 'sync']) {
  test(`${fault} preserves acknowledged history and allows an explicit retry`, async t => {
    const { Store, freshStore, context, faults } = setup(t);
    await Store.appendFinal(context, partition, turn(0)); faults[fault] = true;
    await assert.rejects(Store.appendFinal(context, partition, turn(1)), /保存失败/);
    assert.deepEqual(Array.from(await freshStore().load(context, partition), e => e.text), ['final turn 0']);
    faults[fault] = false; await Store.appendFinal(context, partition, turn(1));
    assert.deepEqual(Array.from(await freshStore().load(context, partition), e => e.text), ['final turn 0', 'final turn 1']);
  });
}
test('interruption after moving old file to backup recovers acknowledged history', async t => {
  const { Store, freshStore, context } = setup(t);
  await Store.appendFinal(context, partition, turn(0)); const file = Store.documentPath(context, partition);
  fs.renameSync(file, file.replace(/turns\.json$/, 'turns.bak'));
  fs.writeFileSync(file.replace(/turns\.json$/, 'turns.tmp'), '{interrupted');
  assert.deepEqual(Array.from(await freshStore().load(context, partition), e => e.text), ['final turn 0']);
  await Store.appendFinal(context, partition, turn(1)); assert.equal((await freshStore().load(context, partition)).length, 2);
});
