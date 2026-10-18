import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const read = name => fs.readFileSync(new URL(`../HarmonyCodexRemote/entry/src/main/ets/${name}.ets`, import.meta.url), 'utf8');
const serviceSource = read('services/CompanionTextService').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
const index = read('pages/Index');
const methods = index.slice(index.indexOf('  private companionTextPartition('), index.indexOf('  private async restoreCompanionTranscripts('));
const partition = { bridgeUrl: 'https://bridge.example', profileId: 'profile-a', roomId: 'room-a' };
const plain = value => JSON.parse(JSON.stringify(value));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-text-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'companion-text-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const faults = { shortWrite: false, install: false };
  const fileIo = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    readTextSync: file => fs.readFileSync(file, 'utf8'),
    mkdirSync: dir => fs.mkdirSync(dir, { recursive: true }),
    openSync: file => ({ fd: fs.openSync(file, 'w') }),
    writeSync(fd, buffer) {
      const bytes = new Uint8Array(buffer);
      return fs.writeSync(fd, bytes, 0, faults.shortWrite ? bytes.length - 1 : bytes.length);
    },
    fsyncSync: fd => fs.fsyncSync(fd), closeSync: file => fs.closeSync(file.fd),
    unlinkSync: file => fs.unlinkSync(file),
    renameSync(from, to) {
      if (faults.install && from.endsWith('.tmp')) throw Error('synthetic install failure');
      fs.renameSync(from, to);
    }
  };
  const diskContext = { filesDir: root.replaceAll('\\', '/') };
  function fresh() {
    const context = vm.createContext({ fileIo, util: {
      generateRandomUUID: () => randomUUID(),
      TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } }
    }, getContext: () => diskContext });
    vm.runInContext(`${stripTypeScriptTypes(serviceSource)}\nglobalThis.Service = CompanionTextService;`, context);
    return { Service: context.Service, context };
  }
  const current = fresh();
  current.Service.load(diskContext, partition);
  return { ...current, diskContext, faults, fresh };
}

function pageHarness(t, request) {
  const setupResult = setup(t);
  const { Service, context } = setupResult;
  context.BridgeClient = { sendCompanionText: request };
  vm.runInContext(`${stripTypeScriptTypes(`class Page { ${methods} }`)}\nglobalThis.Page = Page;`, context);
  const page = new context.Page();
  Object.assign(page, {
    companionSelected: true, activeTab: 'sessions', companionTextReady: true, companionGeneration: 7,
    companionProfile: { id: partition.profileId, roomId: partition.roomId }, bridgeToken: 'test-token',
    companionTextPartitionKey: Service.partitionKey(partition), companionTextDrafts: new Map(),
    companionTextDraft: 'first message', companionTextMessages: [], companionTextError: '', companionEntries: [],
    normalizedBridgeUrl: () => partition.bridgeUrl, errorText: error => error.message,
    async refreshCompanionConversation() {}
  });
  return { ...setupResult, page };
}

test('large Unicode text survives restart in an isolated outbox; interrupted sends become uncertain without resending', t => {
  const { Service, fresh, diskContext } = setup(t);
  const text = '中文🙂'.repeat(4000);
  const id = randomUUID();
  Service.enqueue(partition, text, id);
  Service.save(diskContext, partition);
  const restarted = fresh().Service;
  const restored = restarted.load(diskContext, partition);
  assert.equal(restored[0].text, text);
  assert.equal(restored[0].state, 'uncertain');
  assert.equal(restored[0].requestId, id);
  for (const other of [
    { ...partition, bridgeUrl: 'https://other.example' },
    { ...partition, roomId: 'room-b' }, { ...partition, profileId: 'profile-b' }
  ]) assert.deepEqual(plain(restarted.load(diskContext, other)), []);
  assert.match(Service.documentPath(diskContext, partition), /\/companion-text-outbox\//);
  assert.equal(Service.partitionKey(partition), Service.partitionKey({ ...partition, bridgeUrl: 'https://BRIDGE.example:443/api?secret=redacted' }));
});

test('only the exact receipt itemId in official user history removes a bubble', t => {
  const { Service } = setup(t);
  const requestId = randomUUID();
  Service.enqueue(partition, 'identical text', requestId);
  const history = [{ itemId: 'room:other', role: 'user', text: 'identical text' }];
  assert.equal(Service.reconcile(partition, history), false);
  Service.applyReceipt(partition, { requestId, state: 'submitted', itemId: 'room:official' });
  assert.equal(Service.messages(partition)[0].state, 'submitted');
  assert.equal(Service.reconcile(partition, history), false);
  assert.equal(Service.reconcile(partition, [{ itemId: 'room:official', role: 'assistant' }]), false);
  assert.equal(Service.reconcile(partition, [{ itemId: 'room:official', role: 'user' }]), true);
  assert.equal(Service.messages(partition).length, 0);
});

for (const fault of ['shortWrite', 'install']) {
  test(`${fault} preserves the last saved record and keeps unsaved bubbles available in memory`, t => {
    const { Service, fresh, diskContext, faults } = setup(t);
    Service.enqueue(partition, 'saved first', randomUUID());
    Service.save(diskContext, partition);
    Service.enqueue(partition, 'still in memory', randomUUID());
    faults[fault] = true;
    assert.throws(() => Service.save(diskContext, partition));
    assert.equal(Service.messages(partition).length, 2);
    assert.deepEqual(Array.from(fresh().Service.load(diskContext, partition), row => row.text), ['saved first']);
    faults[fault] = false;
    Service.save(diskContext, partition);
    assert.equal(fresh().Service.load(diskContext, partition).length, 2);
  });
}

test('backup recovery and corrupt/wrong-partition records do not silently overwrite history', t => {
  const { Service, fresh, diskContext } = setup(t);
  Service.enqueue(partition, 'saved', randomUUID());
  Service.save(diskContext, partition);
  const file = Service.documentPath(diskContext, partition);
  fs.renameSync(file, `${file}.bak`);
  assert.equal(fresh().Service.load(diskContext, partition)[0].text, 'saved');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => fresh().Service.load(diskContext, partition), /损坏/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, '');
  assert.throws(() => fresh().Service.load(diskContext, partition), /损坏/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, partition: 'wrong', messages: [] }));
  assert.throws(() => fresh().Service.load(diskContext, partition), /身份不匹配/);
});

test('send displays and saves the user bubble immediately, permits a call, and leaves the next draft intact', async t => {
  let finish;
  let requestArgs;
  const { Service, page, fresh, diskContext } = pageHarness(t, (...args) => {
    requestArgs = args;
    return new Promise(resolve => { finish = resolve; });
  });
  page.voiceCallStatus = 'active';
  const sending = page.sendCompanionText();
  assert.equal(page.companionTextDraft, '');
  assert.equal(page.companionTextMessages[0].text, 'first message');
  assert.equal(page.companionTextMessages[0].state, 'pending');
  assert.equal(fresh().Service.load(diskContext, partition)[0].state, 'uncertain');
  page.changeCompanionTextDraft('new draft');
  finish({ requestId: requestArgs[4], state: 'submitted', itemId: 'room:official' });
  await sending;
  assert.equal(page.companionTextDraft, 'new draft');
  assert.equal(page.companionTextMessages[0].itemId, 'room:official');
  assert.equal(page.companionTextMessages[0].state, 'submitted');
  assert.equal(Service.messages(partition).length, 1);
});

test('history arriving before the POST receipt still reconciles exactly', async t => {
  let finish;
  let id;
  const { page } = pageHarness(t, (...args) => {
    id = args[4]; return new Promise(resolve => { finish = resolve; });
  });
  const sending = page.sendCompanionText();
  page.companionEntries = [{ itemId: 'room:official', role: 'user', text: 'first message' }];
  finish({ requestId: id, state: 'submitted', itemId: 'room:official' });
  await sending;
  assert.equal(page.companionTextMessages.length, 0);
});

test('two in-flight messages settle out of order without losing either bubble or the new draft', async t => {
  const pending = [];
  const { page } = pageHarness(t, (...args) => new Promise(resolve => pending.push({ id: args[4], resolve })));
  const first = page.sendCompanionText();
  page.changeCompanionTextDraft('second message');
  const second = page.sendCompanionText();
  page.changeCompanionTextDraft('third draft');
  pending[1].resolve({ requestId: pending[1].id, state: 'submitted', itemId: 'room:second' });
  await second;
  pending[0].resolve({ requestId: pending[0].id, state: 'submitted', itemId: 'room:first' });
  await first;
  assert.deepEqual(Array.from(page.companionTextMessages, row => row.itemId), ['room:first', 'room:second']);
  assert.equal(page.companionTextDraft, 'third draft');
});

test('switching storage partition with an unreadable cache clears old bubbles and keeps the new composer disabled', t => {
  const { page, Service } = pageHarness(t, async () => {});
  page.companionTextMessages = [{ requestId: 'old' }];
  page.companionTextDrafts.set(Service.partitionKey({ ...partition, roomId: 'room-b' }), 'room-b draft');
  page.companionProfile = { id: partition.profileId, roomId: 'room-b' };
  Service.load = () => { throw Error('cache unreadable'); };
  page.restoreCompanionText(page.companionProfile, page.companionGeneration);
  assert.equal(page.companionTextMessages.length, 0);
  assert.equal(page.companionTextReady, false);
  assert.equal(page.companionTextDraft, 'room-b draft');
  assert.equal(page.companionTextError, 'cache unreadable');
});

for (const change of ['leave', 'profile', 'room', 'origin', 'token']) {
  test(`late receipt after ${change} updates the original partition without touching the current screen`, async t => {
    let finish;
    let id;
    const { page, Service } = pageHarness(t, (...args) => {
      id = args[4]; return new Promise(resolve => { finish = resolve; });
    });
    const sending = page.sendCompanionText();
    if (change === 'leave') { page.companionSelected = false; page.companionGeneration += 1; }
    if (change === 'profile') page.companionProfile = { id: 'different', roomId: partition.roomId };
    if (change === 'room') page.companionProfile = { id: partition.profileId, roomId: 'different' };
    if (change === 'origin') page.normalizedBridgeUrl = () => 'https://other.example';
    if (change === 'token') page.bridgeToken = 'different';
    page.companionTextDraft = 'other room draft';
    page.companionTextMessages = [{ requestId: 'other-room' }];
    finish({ requestId: id, state: 'uncertain', itemId: null });
    await sending;
    assert.equal(page.companionTextMessages[0].requestId, 'other-room');
    assert.equal(page.companionTextDraft, 'other room draft');
    assert.equal(Service.messages(partition)[0].state, 'uncertain');
  });
}

test('disk failure prevents the POST, exposes failure and recovers text only into an empty draft', async t => {
  let calls = 0;
  const { page, faults } = pageHarness(t, async () => { calls += 1; });
  faults.shortWrite = true;
  await page.sendCompanionText();
  assert.equal(calls, 0);
  const failed = page.companionTextMessages[0];
  assert.equal(failed.state, 'failed');
  page.changeCompanionTextDraft('keep me');
  page.recoverCompanionText(failed);
  assert.equal(page.companionTextDraft, 'keep me');
  page.changeCompanionTextDraft(''); page.recoverCompanionText(failed);
  assert.equal(page.companionTextDraft, 'first message');
});

test('transport timeout is uncertain and never retried; explicit rejection is recoverable failure', async t => {
  for (const [error, state] of [['network timeout', 'uncertain'], ['桥接返回异常 HTTP 409：identity changed', 'failed']]) {
    let calls = 0;
    const { page } = pageHarness(t, async () => { calls += 1; throw Error(error); });
    await page.sendCompanionText();
    assert.equal(calls, 1);
    assert.equal(page.companionTextMessages[0].state, state);
    page.companionTextDraft = '';
    page.recoverCompanionText(page.companionTextMessages[0]);
    assert.equal(page.companionTextDraft, state === 'failed' ? 'first message' : '');
  }
});

test('dedicated client posts the official room identity once and preserves the prefixed receipt id', async () => {
  const source = read('services/BridgeClient');
  const method = source.slice(source.indexOf('  static async sendCompanionText('), source.indexOf('  static async getCompanionProfile('));
  let captured;
  let receipt;
  const context = vm.createContext({ http: { RequestMethod: { POST: 'POST' } },
    capture: args => { captured = args; return JSON.stringify(receipt); } });
  vm.runInContext(stripTypeScriptTypes(`class Client { static async request(...args) { return capture(args); }
    ${method.replaceAll('BridgeClient.', 'Client.')} } globalThis.Client = Client;`), context);
  const requestId = randomUUID();
  receipt = { requestId, state: 'submitted', itemId: 'room:message' };
  const result = await context.Client.sendCompanionText('https://bridge.example', 'profile-a', 'room-a', 'hello', requestId, 'token');
  assert.equal(captured[0], 'POST'); assert.equal(captured[1], 'https://bridge.example/companion/messages');
  assert.deepEqual(JSON.parse(captured[2]), { profileId: 'profile-a', roomId: 'room-a', text: 'hello', requestId });
  assert.equal(captured[4].retries, 0);
  assert.equal(result.itemId, 'room:message');
  receipt.requestId = randomUUID();
  await assert.rejects(context.Client.sendCompanionText('https://bridge.example', 'profile-a', 'room-a', 'hello', requestId), /回执无效/);
});
