import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexThreadService } from '../src/codexThreadService.js';

const user = (id, text) => ({ type: 'userMessage', id, clientId: `client-${id}`, content: [{ type: 'text', text }] });
const turn = (id, items, status = 'completed') => ({ id, status, startedAt: 1700000000, items });

test('official history is shared by detail and sync, keeps source identity and real tool actions', async () => {
  const calls = [];
  const newer = turn('turn-2', [user('u2', 'same'), user('u3', 'same'),
    { type: 'commandExecution', id: 'cmd', command: 'rg fixture', cwd: '/fixture', status: 'inProgress',
      commandActions: [{ type: 'search', command: 'rg fixture', query: 'fixture', path: '/fixture' }] },
    { type: 'fileChange', id: 'edit', changes: [{ path: 'fixture.js', kind: { type: 'update' } }], status: 'completed' },
    { type: 'mcpToolCall', id: 'mcp', server: 'fixture', tool: 'lookup', status: 'completed', arguments: {} },
    { type: 'subAgentActivity', id: 'agent', kind: 'started', agentPath: '/root/worker', agentThreadId: 'child', model: 'fixture-model' },
    { type: 'reasoning', id: 'reason', summary: ['fixture thinking'] },
    { type: 'agentMessage', id: 'a1', text: 'fixture answer', questions: [{ title: 'Choose', options: ['A', 'B'] }] }
  ], 'inProgress');
  const older = turn('turn-1', [user('u1', 'older')]);
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, name: 'fixture', cwd: '/fixture', updatedAt: 1700000000 } };
    if (method === 'thread/turns/list') {
      if (params.cursor === 'older-cursor') return { data: [older], nextCursor: null, backwardsCursor: 'older-anchor' };
      if (params.cursor === 'newer-anchor') return { data: [newer], nextCursor: null, backwardsCursor: 'newer-anchor' };
      return { data: [newer], nextCursor: 'older-cursor', backwardsCursor: 'newer-anchor' };
    }
    assert.fail(`unexpected ${method}`);
  };
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: request,
    sessions: { getSession() { assert.fail('rollout must not supply official history'); }, getSessionSync() { assert.fail('rollout must not supply official history'); } } });
  const detail = await service.getThread('thread-1', { tail: 2 });
  const recent = await service.syncThread('thread-1', { limit: 2 });
  assert.deepEqual(detail.entries.map(e => e.syncId), recent.entries.map(e => e.syncId));
  assert.equal(recent.entries.filter(e => e.role === 'user').length, 2);
  assert.ok(recent.entries.every(e => e.threadId === 'thread-1' && e.turnId === 'turn-2' && e.itemId));
  assert.equal(recent.entries[0].clientId, 'client-u2');
  const item = id => recent.entries.flatMap(e => e.toolItems ?? []).find(value => value.id === id);
  assert.equal(item('cmd').status, 'running');
  assert.equal(item('cmd').verb, 'Searched');
  assert.match(item('cmd').target, /fixture/);
  assert.equal(item('edit').status, 'completed');
  assert.match(item('mcp').target, /lookup/);
  assert.equal(item('agent').status, 'unknown');
  assert.equal(item('agent').agentThreadId, 'child');
  assert.equal(item('agent').model, 'fixture-model');
  assert.ok(recent.entries.some(e => e.type === 'reasoning' && e.text.includes('fixture thinking')));
  assert.ok(recent.entries.some(e => e.itemId === 'a1' && e.text === 'fixture answer' && e.questions[0].title === 'Choose'));
  assert.equal(recent.sync.hasMoreBefore, true);
  assert.deepEqual(recent.sync.completedTurnIds, []);
  const before = await service.syncThread('thread-1', { before: recent.sync.cursorStart });
  assert.equal(before.entries[0].itemId, 'u1');
  assert.deepEqual(before.sync.completedTurnIds, ['turn-1']);
  assert.equal(calls.findLast(c => c.method === 'thread/turns/list').params.sortDirection, 'desc');
  const after = await service.syncThread('thread-1', { after: recent.sync.cursorEnd });
  assert.equal(after.entries[0].itemId, 'u2');
  assert.equal(calls.findLast(c => c.method === 'thread/turns/list').params.sortDirection, 'asc');
  assert.deepEqual(after.entries.map(e => e.syncId), recent.entries.map(e => e.syncId));
  await assert.rejects(service.syncThread('other-thread', { before: recent.sync.cursorStart }), { statusCode: 400 });
  await assert.rejects(service.syncThread('thread-1', { before: '1234' }), { statusCode: 409 });
  assert.ok(calls.every(c => c.method === 'thread/read' || c.method === 'thread/turns/list'));
});

test('only full terminal history pages establish settled turn identities, including empty turns', async () => {
  const turns = ['completed', 'interrupted', 'failed', 'inProgress', 'unknown'].map((status, i) =>
    turn(`turn-${i}`, [], status));
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: async (method, params) =>
    method === 'thread/read' ? { thread: { id: params.threadId, status: 'active' } }
      : { data: turns, nextCursor: null, backwardsCursor: 'anchor' } });
  const result = await service.getThread('thread-1');
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.sync.completedTurnIds, ['turn-2', 'turn-1', 'turn-0']);
});

test('one official turn is returned whole despite the entry limit', async () => {
  const items = Array.from({ length: 75 }, (_, i) => user(`u${i}`, 'same'));
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: async (method, params) =>
    method === 'thread/read' ? { thread: { id: params.threadId } } : { data: [turn('turn-1', items)], nextCursor: null, backwardsCursor: 'anchor' } });
  const result = await service.syncThread('thread-1', { limit: 2 });
  assert.equal(result.entries.length, 75);
  assert.equal(new Set(result.entries.map(e => e.syncId)).size, 75);
});

test('image-only messages and file references remain visible through the official history', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-history-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'original.png');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(original, imageBytes);
  const items = [
    { type: 'userMessage', id: 'img1', content: [{ type: 'localImage', path: original }] },
    { type: 'userMessage', id: 'img2', content: [{ type: 'image', url: `data:image/png;base64,${imageBytes.toString('base64')}` }] },
    { type: 'userMessage', id: 'img3', content: [{ type: 'image', fileId: 'fixture-file-id' }] },
    { type: 'userMessage', id: 'attachment', content: [{ type: 'mention', name: 'fixture.txt', path: '/fixture/fixture.txt' }] },
    { type: 'userMessage', id: 'linked', content: [{ type: 'text', text: `![手机端图片](${original})` }, { type: 'localImage', path: original }] }
  ];
  const imagesDir = path.join(dir, 'images');
  const service = new CodexThreadService({ allowIndependentAppServer: false, sessions: { mobileImagesDir: imagesDir },
    desktopThreadRequest: async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId } }
      : { data: [turn('turn-1', items)], nextCursor: null, backwardsCursor: 'anchor' } });
  const result = await service.syncThread('thread-1');
  const imagePath = result.entries[0].text.match(/\((.+)\)/)?.[1];
  assert.ok(imagePath && path.resolve(imagePath).startsWith(path.resolve(imagesDir) + path.sep));
  assert.deepEqual(await fs.readFile(imagePath), imageBytes);
  assert.match(result.entries[1].text, /!\[桌面端图片\]/);
  assert.match(result.entries[2].text, /图片.*不可用/);
  assert.match(result.entries[3].text, /fixture\.txt/);
  assert.equal((result.entries[4].text.match(/!\[/g) ?? []).length, 1);
});

test('forward pagination advances without omitting an inclusive current turn', async () => {
  const seen = [];
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    seen.push(params);
    if (params.cursor === 'anchor') return { data: [turn('t1', [user('u1', 'one')])], nextCursor: 'next', backwardsCursor: 'wrong-for-asc' };
    if (params.cursor === 'next') return { data: [turn('t2', [user('u2', 'two')])], nextCursor: null, backwardsCursor: 'wrong-for-asc' };
    return { data: [turn('t1', [user('u1', 'one')])], nextCursor: null, backwardsCursor: 'anchor' };
  } });
  const initial = await service.syncThread('thread-1');
  const first = await service.syncThread('thread-1', { after: initial.sync.cursorEnd });
  assert.equal(first.sync.hasMoreAfter, true);
  const second = await service.syncThread('thread-1', { after: first.sync.cursorEnd });
  assert.equal(second.entries[0].itemId, 'u2');
  assert.equal(second.sync.hasMoreAfter, false);
  assert.equal(second.sync.cursorEnd, first.sync.cursorEnd, 'repeat the last page anchor to catch updates');
  await service.syncThread('thread-1', { after: second.sync.cursorEnd });
  assert.deepEqual(seen.slice(1).map(value => value.cursor), ['anchor', 'next', 'next']);
});

test('desktop history cannot silently fall back to a different source', async () => {
  const service = new CodexThreadService({ allowIndependentAppServer: false,
    sessions: { getSession() { assert.fail('must not read rollout'); }, getSessionSync() { assert.fail('must not read rollout'); } } });
  await assert.rejects(service.getThread('thread-1'), { statusCode: 503, code: 'official_history_unavailable' });
  await assert.rejects(service.syncThread('thread-1'), { statusCode: 503, code: 'official_history_unavailable' });
});

test('official turn order is restored and updated tool state keeps the same identity', async () => {
  let status = 'inProgress';
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'active' } } };
    return { data: [turn('new', [{ type: 'commandExecution', id: 'cmd', status, command: 'fixture', commandActions: [] }], 'inProgress'),
      turn('old', [user('u1', 'first'), user('u2', 'second')])], nextCursor: null, backwardsCursor: 'anchor' };
  } });
  const first = await service.syncThread('thread-1');
  assert.deepEqual(first.entries.map(e => e.itemId), ['u1', 'u2', 'cmd']);
  assert.equal(first.runtimeState, 'running');
  assert.equal(first.entries.at(-1).toolItems[0].status, 'running');
  status = 'completed';
  const next = await service.syncThread('thread-1');
  assert.equal(next.entries.at(-1).toolItems[0].status, 'completed');
  assert.equal(next.entries.at(-1).syncId, first.entries.at(-1).syncId);
});

test('multi-action commands and generated images retain their actual official contents', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-generated-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const items = [
    { type: 'commandExecution', id: 'cmd', status: 'completed', command: 'fixture', commandActions: [
      { type: 'read', name: 'alpha.txt' }, { type: 'search', query: 'needle' }
    ] },
    { type: 'imageGeneration', id: 'image', status: 'completed', result }
  ];
  const service = new CodexThreadService({ allowIndependentAppServer: false, sessions: { mobileImagesDir: dir },
    desktopThreadRequest: async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId } }
      : { data: [turn('turn-1', items)], nextCursor: null, backwardsCursor: 'anchor' } });
  const detail = await service.getThread('thread-1');
  assert.match(detail.entries[0].toolItems[0].target, /读取 alpha\.txt；搜索 needle/);
  assert.match(detail.entries[1].text, /!\[桌面端图片\]/);
  assert.equal(detail.entries[1].itemId, 'image');
});

test('unknown command titles reuse the pinned Happy truncation and retain full arguments', async () => {
  const long = 'x'.repeat(81);
  const items = [
    { type: 'commandExecution', id: 'short', status: 'completed', command: 'echo fixture', commandActions: [{ type: 'unknown' }] },
    { type: 'commandExecution', id: 'long', status: 'completed', command: long, commandActions: [{ type: 'unknown' }] },
    { type: 'commandExecution', id: 'empty', status: 'completed', command: '', commandActions: [] },
    { type: 'commandExecution', id: 'array', status: 'completed', command: ['git', 'status'], commandActions: [] }
  ];
  const service = new CodexThreadService({ allowIndependentAppServer: false, desktopThreadRequest: async (method, params) =>
    method === 'thread/read' ? { thread: { id: params.threadId } }
      : { data: [turn('turn-1', items)], nextCursor: null, backwardsCursor: 'anchor' } });
  const result = await service.syncThread('thread-1');
  const tools = result.entries.map(entry => entry.toolItems[0]);
  assert.equal(tools[0].target, 'echo fixture');
  assert.equal(tools[1].target, `${'x'.repeat(77)}...`);
  assert.equal(tools[1].args, long);
  assert.equal(tools[2].target, '命令');
  assert.equal(tools[3].target, 'git status');
});

test('incomplete official pages fail instead of silently dropping history', async () => {
  for (const incomplete of [
    { id: 'turn', itemsView: 'summary', items: [] },
    { id: 'turn', itemsView: 'full' },
    { id: 'turn', itemsView: 'full', items: [{ type: 'agentMessage', text: 'fixture' }] }
  ]) {
    const service = new CodexThreadService({ allowIndependentAppServer: false,
      desktopThreadRequest: async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId } }
        : { data: [incomplete], nextCursor: null, backwardsCursor: null } });
    await assert.rejects(service.syncThread('thread-1'), /官方历史响应无效/);
  }
});
