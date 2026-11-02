import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const source = fs.readFileSync(root + 'services/SessionPresentationService.ets', 'utf8')
  .replace(/^import .*;\s*$/gm, '').replaceAll('export ', '');
const index = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
const names = ['hasExpandableSessionToolItem', 'isSessionAgentToolItem', 'sessionAgentDisplayStatus',
  'sessionAgentItemTaskName', 'sessionAgentItemName', 'sessionAgentAvatarText', 'sessionAgentArgsTaskName', 'sessionAgentInstructionText', 'hasSessionAgentItemDetail'];
const methods = names.map(name => {
  const start = index.indexOf(`  private ${name}(`);
  assert.ok(start >= 0, name);
  return index.slice(start, index.indexOf('\n  }', start) + 4);
}).join('\n');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source + '\nclass Page {' + methods +
  '}\nglobalThis.api = { Page, sessionToolPresentationItems, compactAdjacentSessionToolEntries };'), context);
const { Page, sessionToolPresentationItems: items, compactAdjacentSessionToolEntries: compact } = context.api;
const page = new Page();
const tool = extra => ({ id: 'native-call', name: 'spawn_agent', verb: 'Called', target: 'task',
  detail: '', status: 'completed', ...extra });
const entry = item => ({ type: 'tool_result', role: 'tool', text: 'task', threadId: 'parent', turnId: 'turn', toolItems: [item] });

test('collaboration headers show exact names and a stable avatar independently of long task instructions', () => {
  assert.equal(page.sessionAgentItemName(tool({ agentPath: '/root/check', taskName: 'Full instruction'.repeat(100) })), '/root/check');
  assert.equal(page.sessionAgentAvatarText('/root/check'), 'CH');
  assert.equal(page.sessionAgentItemName(tool({ agents: [{ name: 'official-id', displayName: '/root/review', status: 'completed' }] })), '/root/review');
  assert.equal(page.sessionAgentAvatarText(''), '协');
  const header = index.slice(index.indexOf('  SessionAgentEventItemView('), index.indexOf('  SessionAgentAvatar('));
  assert.doesNotMatch(header, /scaledFontSize\((?:8|9|10)\)/, 'collaboration headers must not use the former tiny fonts');
  assert.match(header, /this\.SessionAgentAvatar\(this\.sessionAgentItemName/);
});

test('a command with arguments can expand even when its title and output are short', () => {
  assert.equal(page.hasExpandableSessionToolItem(tool({ args: 'pwsh -Command "Get-Date"' })), true);
  assert.equal(page.hasExpandableSessionToolItem(tool({ args: '', target: 'short' })), false);
});
test('official collaboration items use the agent presentation for all official tool names', () => {
  for (const name of ['spawnAgent', 'followupTask', 'sendInput', 'closeAgent', 'wait']) {
    assert.equal(page.isSessionAgentToolItem(tool({ name, rawType: 'collabAgentToolCall' })), true);
  }
});
test('tool completion never reports a still-running child as completed', () => {
  assert.equal(page.sessionAgentDisplayStatus(tool({ rawType: 'collabAgentToolCall', agents: [{ name: 'child', status: 'running' }] })), 'unknown');
  assert.equal(page.sessionAgentDisplayStatus(tool({ rawType: 'collabAgentToolCall', agents: [{ name: 'child', status: 'unknown' }] })), 'unknown');
  assert.equal(page.sessionAgentDisplayStatus(tool({ rawType: 'collabAgentToolCall', agents: [{ name: 'child', status: 'completed' }] })), 'completed');
});
test('a real task description takes precedence over the agent path', () => {
  assert.equal(page.sessionAgentItemTaskName(tool({ agentPath: '/root/check', taskName: '核查流式与历史交接' })), '核查流式与历史交接');
});
test('normalization and grouping preserve official agent identity, source, prompt and state', () => {
  const metadata = { rawType: 'collabAgentToolCall', rawTool: 'spawnAgent', senderThreadId: 'parent',
    receiverThreadIds: ['child'], agentsStates: { child: { status: 'running', message: null } },
    prompt: 'full prompt', source: 'unifiedExecStartup', pluginId: null, scriptPath: null,
    agentThreadId: 'child', agentPath: '/root/check', model: 'fixture-model', reasoningEffort: 'high' };
  const rows = compact([entry(tool({ status: 'running', ...metadata })), entry(tool({ status: 'completed' }))]);
  const projected = items(rows[0])[0];
  for (const [name, value] of Object.entries(metadata)) assert.equal(JSON.stringify(projected[name]), JSON.stringify(value), name);
});
test('late running metadata enriches a settled call without changing its terminal status', () => {
  const rows = compact([entry(tool({ status: 'completed' })), entry(tool({ status: 'running', model: 'late-model', agentThreadId: 'child' }))]);
  const projected = items(rows[0])[0];
  assert.equal(projected.status, 'completed');
  assert.equal(projected.model, 'late-model');
  assert.equal(projected.agentThreadId, 'child');
});
test('legacy retry completion retains the original full command arguments', () => {
  const rows = compact([entry(tool({ id: 'legacy-tool', status: 'failed', args: 'full original command' })),
    entry(tool({ id: 'legacy-tool', status: 'completed' }))]);
  const projected = items(rows[0])[0];
  assert.equal(projected.args, 'full original command');
  assert.equal(projected.retryCount, 1);
});
test('native agent details show instructions and model fields instead of an internal JSON record', () => {
  const event = tool({ name: 'subAgentActivity', agentThreadId: 'child', args: '{"kind":"completed","agentThreadId":"child"}' });
  assert.equal(page.sessionAgentInstructionText(event), '');
  assert.equal(page.hasSessionAgentItemDetail(event), false);
  assert.equal(page.hasSessionAgentItemDetail({ ...event, model: 'fixture-model' }), true);
  assert.equal(page.sessionAgentInstructionText({ ...event, prompt: 'Verify the response once.' }), 'Verify the response once.');
});
