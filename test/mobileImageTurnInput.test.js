import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { CodexAppServerAdapter } from '../src/codexAppServerAdapter.js';

const imagePrompt = [
  'Inspect both attached mobile images.',
  '![手机端图片](C:/mobile-uploads/first.png)',
  '![手机端图片](<C:/mobile-uploads/first.png>)',
  '![手机端图片](C:/mobile-uploads/second.png)'
].join('\n');
const imageInputs = [
  { type: 'localImage', path: 'C:/mobile-uploads/first.png' },
  { type: 'localImage', path: 'C:/mobile-uploads/second.png' }
];
const expectedInput = (prompt, images) => [{ type: 'text', text: prompt, text_elements: [] }, ...images];

class AppServerRequestFixture extends EventEmitter {
  calls = [];

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') {
      return { thread: { id: params.threadId || 'new-thread', cwd: process.cwd(), status: { type: 'idle' } } };
    }
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/completed', params: {
        threadId: params.threadId, turn: { id: 'fixture-turn', status: 'completed', items: [] }
      } });
      return { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } };
    }
    if (method === 'thread/read') {
      return { thread: { id: params.threadId, turns: [{ id: 'fixture-turn', status: 'completed', items: [] }] } };
    }
    assert.fail(`Unexpected app-server request: ${method}`);
  }
}

for (const existing of [false, true]) {
  for (const [kind, prompt, images] of [
    ['images', imagePrompt, imageInputs], ['plain text', 'A plain text follow-up.', []]
  ]) {
    test(`desktop ${existing ? 'resume' : 'new'} turn/start carries ${kind} without changing prompt or duplicating paths`, async t => {
      const calls = [];
      const prepared = [];
      const adapter = new CodexDesktopCdpAdapter({ client: { async request(method, params) {
        calls.push({ method, params });
        assert.equal(method, 'turn/start');
        return { turn: { id: 'fixture-turn', status: 'inProgress' } };
      } } });
      t.after(() => adapter.close());
      adapter.startThread = async () => { prepared.push('new'); return { id: 'new-thread' }; };
      adapter.prepareExistingThread = async () => { prepared.push('resume'); return { thread: { id: 'existing-thread' }, resumed: false }; };
      adapter.captureSessionFileCursor = async () => null;
      adapter.clearDesktopNotificationNoise = async () => ({ ok: true });
      adapter.startNotificationPolling = () => ({ stop() {} });
      adapter.waitForDesktopTurnCompletion = async () => ({ turn: { id: 'fixture-turn', status: 'completed' } });
      adapter.completeDesktopTurnResult = async () => ({ summary: 'fixture complete' });
      await adapter.run({ task: { id: 'task', prompt, ...(existing ? { codexSessionId: 'existing-thread' } : {}) },
        project: { root: process.cwd() }, emit() {} });
      assert.deepEqual(prepared, [existing ? 'resume' : 'new']);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].params.threadId, existing ? 'existing-thread' : 'new-thread');
      assert.deepEqual(calls[0].params.input, expectedInput(prompt, images));
    });

    test(`app-server ${existing ? 'resume' : 'new'} turn/start carries ${kind} without changing prompt or duplicating paths`, async () => {
      const client = new AppServerRequestFixture();
      const adapter = new CodexAppServerAdapter({ client });
      await adapter.run({ task: { id: 'task', prompt, ...(existing ? { codexSessionId: 'existing-thread' } : {}) },
        project: { root: process.cwd() }, emit() {} });
      assert.equal(client.calls[0].method, existing ? 'thread/resume' : 'thread/start');
      const turn = client.calls.filter(call => call.method === 'turn/start');
      assert.equal(turn.length, 1);
      assert.equal(turn[0].params.threadId, existing ? 'existing-thread' : 'new-thread');
      assert.deepEqual(turn[0].params.input, expectedInput(prompt, images));
      assert.equal(client.listenerCount('notification'), 0);
      assert.equal(client.listenerCount('stderr'), 0);
    });
  }
}

for (const [kind, prompt, images] of [
  ['images', imagePrompt, imageInputs], ['plain text', 'A plain text steering message.', []]
]) {
  test(`desktop steer retains its existing ${kind} input behavior`, async t => {
    const calls = [];
    const adapter = new CodexDesktopCdpAdapter({ client: { async request(method, params) {
      calls.push({ method, params });
      return { turnId: 'active-turn' };
    } } });
    t.after(() => adapter.close());
    await adapter.steer({ task: { codexSessionId: 'existing-thread', activeCodexTurnId: 'active-turn' }, prompt, emit() {} });
    assert.deepEqual(calls, [{ method: 'turn/steer', params: {
      threadId: 'existing-thread', expectedTurnId: 'active-turn', input: expectedInput(prompt, images)
    } }]);
  });
}
