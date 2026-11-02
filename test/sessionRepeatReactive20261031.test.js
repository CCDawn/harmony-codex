import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets', 'utf8');
const slice = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
test('both timeline paths reuse snapshot nodes and pass the reactive RepeatItem as a whole', () => {
  const uses = [...source.matchAll(/Repeat<SessionTimelineRow>\(this\.sessionTimelineRows\(\)\)\s*\.each\(\(row: RepeatItem<SessionTimelineRow>\) => \{ this\.SessionTimelineCard\(row\) \}\)\s*\.key\(\(row: SessionTimelineRow\): string => this\.sessionTimelineRenderKey\(row\)\)/g)];
  assert.equal(uses.length, 2);
  assert.match(source, /SessionTimelineCard\(row: RepeatItem<SessionTimelineRow>\)/);
  assert.doesNotMatch(source, /SessionTimelineCard\(row\.item\)/);
  assert.match(source, /return JSON\.stringify\(\[row, failure\]\)/);
});
test('streaming entry and markdown use full immutable block and span snapshots', () => {
  const row = slice('  SessionTimelineCard(', '  OptimisticSessionMessageCard(');
  assert.match(row, /this\.SessionEntryCard\(\{\s*entry:\s*row\.item\.entry/);
  const entry = slice('  SessionEntryCard(', '  SessionHeartbeatRequestView(');
  assert.match(entry, /SessionEntryCard\(\$\$: SessionEntryCardParams\)/);
  assert.match(entry, /this\.SessionMarkdownContent\(\{\s*entry:\s*\$\$\.entry/);
  const md = slice('  SessionMarkdownContent(', '  SessionMarkdownTableView(');
  assert.match(md, /SessionMarkdownContent\(\$\$: SessionMarkdownContentParams\)/);
  assert.match(md, /ForEach\(this\.sessionEntryMarkdownBlocks\(\$\$\.entry\)/);
  assert.match(md, /blockItem:\s*blockItem/);
  assert.match(md, /ForEach\(parseSessionMarkdownInline\(\$\$\.text\)/);
  assert.match(md, /JSON\.stringify\(block\)/);
  assert.match(md, /JSON\.stringify\(segment\)/);
});
test('tool rows and agent state use full snapshots while retaining interaction identities', () => {
  const entry = slice('  SessionEntryCard(', '  SessionHeartbeatRequestView(');
  assert.match(entry, /this\.SessionToolEntryView\(\{\s*entry:\s*\$\$\.entry\s*\}\)/);
  const agent = slice('  SessionAgentEventItemView(', '  SessionToolEntryView(');
  assert.match(agent, /SessionAgentEventItemView\(\$\$: SessionAgentItemParams\)/);
  assert.match(agent, /ForEach\(\$\$\.toolItem\.agents \?\? \[\]/);
  assert.match(agent, /JSON\.stringify\(\[index, agent\]\)/);
  const tool = slice('  SessionToolEntryView(', '  SessionMarkdownContent(');
  assert.match(tool, /SessionToolEntryView\(\$\$: SessionEntryViewParams\)/);
  assert.match(tool, /ForEach\(sessionToolPresentationItems\(\$\$\.entry\)/);
  assert.match(tool, /this\.SessionAgentEventItemView\(\{\s*entry:\s*\$\$\.entry,\s*toolItem:\s*toolItem\s*\}\)/);
  assert.match(tool, /toolItem\.status === 'running'/);
  assert.match(tool, /JSON\.stringify\(\[this\.sessionToolItemKey\(\$\$\.entry, item\), item\]\)/);
});
test('sampled stream diagnostics match item identity and log lengths without bodies', () => {
  const body = slice('  private sessionStreamDiagnosticMatch(', '\n  private syncSessionEventStream(');
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes('class Page {' + body.replace('private ', '') + '}\nglobalThis.Page=Page;'), context);
  const page = new context.Page();
  const incoming = { threadId: 't1', turnId: 'turn1', itemId: 'item1', syncId: 'sync1' };
  assert.equal(page.sessionStreamDiagnosticMatch(incoming, { ...incoming }), true);
  assert.equal(page.sessionStreamDiagnosticMatch(incoming, { ...incoming, syncId: 'sync2' }), false);
  assert.equal(page.sessionStreamDiagnosticMatch(incoming, { ...incoming, threadId: 't2' }), false);
  assert.equal(page.sessionStreamDiagnosticMatch({ ...incoming, syncId: undefined }, { ...incoming, turnId: 'turn2' }), false);
  assert.equal(page.sessionStreamDiagnosticMatch({ threadId: 't1' }, { threadId: 't1' }), false);
  const stream = slice('  private syncSessionEventStream(', '\n  private ');
  assert.match(stream, /this\.sessionStreamEntries\.find/);
  assert.match(stream, /this\.selectedSession\?\.entries\.find/);
  assert.match(stream, /this\.visibleSessionEntries\(\)\.find/);
  assert.doesNotMatch(stream, /sessionTimelineRows\(/);
  const log = stream.split('\n').find(line => line.includes("'session.stream.message'"));
  for (const field of ['length=', 'phase=', 'committedLength=', 'committedPhase=', 'historyLength=', 'historyPhase=', 'visibleLength=', 'visiblePhase=']) {
    assert.ok(log.includes(field), field);
  }
  assert.doesNotMatch(log, /\$\{(?:entry|committed|history|visible)\??\.text\}/);
});
test('same official identity retains one row as the streamed body and terminal state change', () => {
  const base = 'HarmonyCodexRemote/entry/src/main/ets/services/';
  const code = ['OptimisticMessageService.ets', 'SessionActivityPresentation.ets', 'SessionTimeline.ets']
    .map(name => fs.readFileSync(base + name, 'utf8').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')).join('\n');
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(code + '\nglobalThis.build=buildSessionTimeline;'), context);
  const snapshot = (text, liveKind, type) => ({ threadId: 'thread', turnId: 'turn', itemId: 'item',
    role: 'assistant', timestamp: '2026-10-31T00:00:00Z', text, liveKind, type });
  const rows = [snapshot('第', 'streaming', 'live_agent_streaming'),
    snapshot('第一段继续增长', 'streaming', 'live_agent_streaming'),
    snapshot('第一段继续增长并完成', 'completed', 'agentMessage')]
    .map(entry => context.build('thread', [entry], [], [])[0]);
  assert.equal(rows[0].key, rows[1].key);
  assert.equal(rows[1].key, rows[2].key);
  assert.deepEqual(rows.map(row => row.entry.text), ['第', '第一段继续增长', '第一段继续增长并完成']);
  assert.equal(rows[2].entry.liveKind, 'completed');
});


