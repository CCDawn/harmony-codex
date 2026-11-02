import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopCdpAdapter } from '../src/codexDesktopCdpAdapter.js';
import { readRecentDesktopThread } from '../src/desktopRecentThread.js';

test('resuming an existing phone thread subscribes without serializing its stored turns', async () => {
  let resumeParams;
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async request(method, params) {
      assert.equal(method, 'thread/resume');
      resumeParams = params;
      return { thread: { id: params.threadId, status: { type: 'idle' } } };
    }
  } });
  const thread = await adapter.resumeThread({ codexSessionId: 'phone-thread', model: 'selected-model', serviceTier: 'priority' }, {}, () => {});
  assert.equal(thread.id, 'phone-thread');
  assert.equal(resumeParams.excludeTurns, true, 'resume must keep subscription semantics but omit the history payload');
  assert.equal(resumeParams.model, 'selected-model');
  assert.equal(resumeParams.serviceTier, 'priority');
  assert.equal(resumeParams.approvalPolicy, adapter.approvalPolicy);
});

test('final phone result reads only the most recent turn while retaining full message verification', async () => {
  let readOptions;
  const turn = { id: 'finished', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'phone input' }] },
    { type: 'agentMessage', text: 'finished output' }
  ] };
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async readRecentThread(id, options) {
      readOptions = options;
      return { thread: { id, turns: [turn] } };
    }
  } });
  const result = await adapter.readFinalThreadState({ thread: { id: 'phone-thread' }, task: { prompt: 'phone input' }, completed: { turn }, emit() {} });
  assert.equal(result.finalTurn, turn);
  assert.equal(readOptions.itemsView, 'full');
  assert.equal(readOptions.limit, 1, 'unrelated older turns must not block task completion');
});

test('bounded recent-thread reads forward the requested page size without loading full history', async () => {
  const calls = [];
  const detail = await readRecentDesktopThread({ async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'target' } };
    return { data: [{ id: 'latest', status: 'completed' }] };
  } }, 'target', { itemsView: 'full', limit: 1 });
  assert.equal(calls.find(x => x.method === 'thread/read').params.includeTurns, false);
  assert.equal(calls.find(x => x.method === 'thread/turns/list').params.limit, 1);
  assert.deepEqual(detail.thread.turns.map(t => t.id), ['latest']);
});

test('a newer desktop turn cannot replace the completed phone turn result', async () => {
  const completed = { id: 'phone-turn', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'phone input' }] },
    { type: 'agentMessage', text: 'phone result' }
  ] };
  const adapter = new CodexDesktopCdpAdapter({ client: {
    async readRecentThread(id) {
      return { thread: { id, turns: [{ id: 'newer-desktop-turn', status: 'inProgress', items: [] }] } };
    }
  } });
  const result = await adapter.readFinalThreadState({ thread: { id: 'phone-thread' }, task: { prompt: 'phone input' }, completed: { turn: completed }, emit() {} });
  assert.equal(result.finalTurn, completed);
});
