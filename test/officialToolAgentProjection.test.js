import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConversationEntries } from '../src/codexProtocolUtils.js';

const project = turns => extractConversationEntries({ id: 'parent', turns });
const turn = (id, items) => ({ id, status: 'completed', startedAt: 1, items });
const tool = (entries, id) => entries.find(entry => entry.itemId === id).toolItems[0];

test('native unknown actions use their readable command while retaining original shell and metadata', () => {
  const command = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe ' + '-NoLogo '.repeat(16) + '-Command Start-Sleep -Seconds 60';
  const entries = project([turn('t', [{ type: 'commandExecution', id: 'cmd', status: 'completed', command,
    source: 'agent', pluginId: 'plugin', scriptPath: 'scripts/run.ps1',
    commandActions: [{ type: 'unknown', command: 'Start-Sleep -Seconds 60' }] }])]);
  const item = tool(entries, 'cmd');
  assert.equal(item.target, 'Start-Sleep -Seconds 60');
  assert.equal(item.args, command);
  assert.equal(item.displayCommand, 'Start-Sleep -Seconds 60');
  assert.equal(item.source, 'agent');
  assert.equal(item.pluginId, 'plugin');
  assert.equal(item.scriptPath, 'scripts/run.ps1');
});

test('known actions retain read/search/list semantics and multiple actions remain distinct', () => {
  const actions = [{ type: 'read', name: 'a.txt' }, { type: 'search', query: 'needle' },
    { type: 'listFiles', path: '/src' }, { type: 'unknown', command: 'git status' }];
  const entries = project([turn('t', actions.map((action, index) => ({ type: 'commandExecution', id: `c${index}`,
    status: 'completed', command: 'wrapped command', commandActions: [action] })).concat([
    { type: 'commandExecution', id: 'multi', command: 'wrapped', commandActions: actions }]))]);
  assert.deepEqual(['c0', 'c1', 'c2', 'c3'].map(id => tool(entries, id).target),
    ['a.txt', 'needle', '列出文件 /src', 'git status']);
  assert.equal(tool(entries, 'multi').target, '读取 a.txt；搜索 needle；列出文件 /src；git status');
});

test('unknown action selection favors the last nonempty command and keeps Happy title truncation', () => {
  const long = 'y'.repeat(81);
  const entries = project([turn('t', [{ type: 'commandExecution', id: 'many', command: 'outer shell',
    commandActions: [{ type: 'unknown', command: 'first' }, { type: 'unknown', command: long },
      { type: 'unknown', command: '' }] }])]);
  assert.equal(tool(entries, 'many').target, `${'y'.repeat(77)}...`);
  assert.equal(tool(entries, 'many').args, 'outer shell');
});

test('quoted native shell wrappers show their command while args preserve the original', () => {
  const windows = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Start-Sleep -Seconds 60'`;
  const bash = `/usr/bin/bash -lc 'echo hello'`;
  const unmatched = `C:\\Program Files\\PowerShell\\7\\pwsh.exe -Command 'Start-Sleep -Seconds 60'`;
  const long = 'x'.repeat(81);
  const items = [
    { id: 'raw', command: windows, commandActions: [] },
    { id: 'action', command: 'original shell invocation', commandActions: [{ type: 'unknown', command: windows }] },
    { id: 'bash', command: bash, commandActions: [] },
    { id: 'unmatched', command: unmatched, commandActions: [] },
    { id: 'long', command: `bash -c '${long}'`, commandActions: [] }
  ].map(item => ({ type: 'commandExecution', status: 'completed', ...item }));
  const entries = project([turn('t', items)]);
  assert.equal(tool(entries, 'raw').target, 'Start-Sleep -Seconds 60');
  assert.equal(tool(entries, 'raw').args, windows);
  assert.equal(tool(entries, 'action').target, 'Start-Sleep -Seconds 60');
  assert.equal(tool(entries, 'action').args, 'original shell invocation');
  assert.equal(tool(entries, 'bash').target, 'echo hello');
  assert.equal(tool(entries, 'bash').args, bash);
  assert.equal(tool(entries, 'unmatched').target, unmatched);
  assert.equal(tool(entries, 'unmatched').args, unmatched);
  assert.equal(tool(entries, 'long').target, `${'x'.repeat(77)}...`);
});

test('collaboration preserves native data and normalizes names and explicit agent states', () => {
  const prompt = '任务内容'.repeat(400);
  const agentsStates = { child: { status: 'running', message: null }, second: { status: 'errored', message: 'failed detail' },
    third: { status: 'notFound', message: null } };
  const items = ['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents']
    .map((name, index) => ({ type: 'collabAgentToolCall', id: `c${index}`, tool: name, status: 'completed',
      senderThreadId: 'parent', receiverThreadIds: ['child', 'second', 'third'], agentsStates, prompt,
      model: 'model-x', reasoningEffort: 'high' }));
  const entries = project([turn('t', items)]);
  assert.deepEqual(items.map((_, index) => tool(entries, `c${index}`).name),
    ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent', 'send_message', 'followup_task', 'interrupt_agent', 'list_agents']);
  const item = tool(entries, 'c0');
  assert.equal(item.rawType, 'collabAgentToolCall');
  assert.equal(item.rawTool, 'spawnAgent');
  assert.equal(item.senderThreadId, 'parent');
  assert.deepEqual(item.receiverThreadIds, ['child', 'second', 'third']);
  assert.deepEqual(item.agentsStates, agentsStates);
  assert.equal(item.prompt, prompt);
  assert.equal(item.args, prompt);
  assert.equal(item.model, 'model-x');
  assert.equal(item.reasoningEffort, 'high');
  assert.deepEqual(item.agents, [{ name: 'child', status: 'running' },
    { name: 'second', status: 'failed', report: 'failed detail' }, { name: 'third', status: 'unknown' }]);
  assert.equal(item.agentThreadId, undefined);
});

test('agent states are mapped only from explicit official state evidence', () => {
  const agentsStates = Object.fromEntries(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound', 'future']
    .map(status => [status, { status, message: null }]));
  const entries = project([turn('t', [{ type: 'collabAgentToolCall', id: 'states', tool: 'wait', status: 'completed',
    receiverThreadIds: ['missing'], agentsStates }])]);
  const item = tool(entries, 'states');
  assert.equal(item.agentThreadId, 'missing');
  assert.deepEqual(item.agents.map(agent => agent.status),
    ['unknown', 'pending', 'running', 'stopped', 'completed', 'failed', 'stopped', 'unknown', 'unknown']);
});

test('agent activity gets only an exact receiver task and never infers status from start or interaction', () => {
  const prompt = '真实任务'.repeat(300);
  const spawn = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed',
    receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running', message: null } },
    prompt, model: 'requested', reasoningEffort: 'high' };
  const activities = ['started', 'interacted', 'completed'].map((kind, index) => ({ type: 'subAgentActivity',
    id: `a${index}`, kind, agentThreadId: 'child-1', agentPath: '/root/one', model: null, reasoningEffort: null }));
  const unrelated = { type: 'subAgentActivity', id: 'other', kind: 'started', agentThreadId: 'child-10', agentPath: '/root/ten' };
  const entries = project([turn('earlier', [activities[0], spawn, unrelated]), turn('later', activities.slice(1))]);
  for (const id of ['a0', 'a1', 'a2']) {
    const item = tool(entries, id);
    assert.equal(item.prompt, prompt);
    assert.equal(item.taskName, prompt);
    assert.equal(item.model, 'requested');
    assert.equal(item.reasoningEffort, 'high');
    assert.equal(JSON.parse(item.args).prompt, prompt);
  }
  assert.equal(tool(entries, 'a0').status, 'unknown');
  assert.equal(tool(entries, 'a1').status, 'unknown');
  assert.equal(tool(entries, 'a2').status, 'completed');
  assert.equal(tool(entries, 'other').prompt, undefined);
  assert.equal(tool(entries, 'spawn').status, 'completed');
  assert.equal(tool(entries, 'spawn').agents[0].status, 'running');
  assert.equal(tool(entries, 'spawn').agents[0].name, 'child-1', 'original official identity remains available');
  assert.equal(tool(entries, 'spawn').agents[0].displayName, '/root/one', 'exact activity path supplies a readable collaborator name');
});
