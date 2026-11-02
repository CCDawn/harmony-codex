import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const source = fs.readFileSync(`${root}pages/Index.ets`, 'utf8');
const service = fs.readFileSync(`${root}services/SessionHeartbeatPresentation.ets`, 'utf8').replaceAll('export ', '');
function method(name) {
  const start = source.search(new RegExp(`^  private ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4).replace('private ', '');
}
const methods = ['sessionHeartbeatRequest', 'sessionHeartbeatKey', 'isSessionHeartbeatExpanded', 'toggleSessionHeartbeat'];
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${service}\nclass Page {${methods.map(method).join('\n')}}\nglobalThis.Page = Page;`), context);
const heartbeat = '<heartbeat>\n<automation_id>sample</automation_id>\n<current_time_iso>today</current_time_iso>\n<instructions>body</instructions>\n</heartbeat>';
const entry = (overrides = {}) => ({ role: 'user', type: 'response_item', timestamp: 'now', text: heartbeat, ...overrides });
const page = () => Object.assign(new context.Page(), { expandedSessionEntries: [], sessionEntryVisibleMarkdown: value => value.text });

test('only a complete user heartbeat enters the task card and its visible text is sanitized first', () => {
  const state = page();
  assert.equal(state.sessionHeartbeatRequest(entry()).instructions, 'body');
  for (const candidate of [entry({ role: 'assistant' }), entry({ text: `user text\n${heartbeat}` }),
    entry({ text: heartbeat + '\nmore' }), entry({ text: '<approval>heartbeat</approval>' })]) {
    assert.equal(state.sessionHeartbeatRequest(candidate), null);
  }
  state.sessionEntryVisibleMarkdown = () => '';
  assert.equal(state.sessionHeartbeatRequest(entry()), null, 'hidden context cannot bypass existing sanitization');
});

test('expanded state is isolated by official identity and survives streaming-to-completed type changes', () => {
  const state = page();
  const first = entry({ role: 'assistant', threadId: 't', turnId: 'turn', itemId: 'item1', type: 'live_agent_streaming' });
  const next = entry({ role: 'assistant', threadId: 't', turnId: 'turn', itemId: 'item2', type: 'live_agent_streaming' });
  state.toggleSessionHeartbeat(first, 'md-0-directive', 'row-1');
  assert.equal(state.isSessionHeartbeatExpanded(first, 'md-0-directive', 'row-1'), true);
  assert.equal(state.isSessionHeartbeatExpanded({ ...first, type: 'agentMessage' }, 'md-0-directive', 'row-1'), true);
  assert.equal(state.isSessionHeartbeatExpanded(next, 'md-0-directive', 'row-2'), false);
  assert.equal(state.isSessionHeartbeatExpanded(first, 'other-block', 'row-1'), false);
  state.toggleSessionHeartbeat(first, 'md-0-directive', 'row-1');
  assert.equal(state.isSessionHeartbeatExpanded(first, 'md-0-directive', 'row-1'), false);
});

test('fallback identities do not conflate separate messages at the same timestamp', () => {
  const state = page();
  const first = entry({ text: heartbeat });
  const second = entry({ text: heartbeat.replace('body', 'different body') });
  state.toggleSessionHeartbeat(first, 'request', 'row-1');
  assert.equal(state.isSessionHeartbeatExpanded(first, 'request', 'row-1'), true);
  assert.equal(state.isSessionHeartbeatExpanded(second, 'request', 'row-2'), false);
});


test('mixed attachments or sanitized instruction content stay on the original rendering path', () => {
  const state = page();
  const trailing = [heartbeat + '\n![image](file:///tmp/example.png)', heartbeat + '\nC:/images/example.png'];
  for (const text of trailing) {
    state.sessionEntryVisibleMarkdown = () => heartbeat;
    assert.equal(state.sessionHeartbeatRequest(entry({ text })), null);
  }
  for (const inserted of ['![image](file:///tmp/example.png)', 'C:/images/example.png', '<environment_context>private</environment_context>']) {
    const text = heartbeat.replace('body', `body\n${inserted}`);
    state.sessionEntryVisibleMarkdown = () => heartbeat;
    assert.equal(state.sessionHeartbeatRequest(entry({ text })), null);
  }
});

test('identical rows and scopes maintain independent expansion state', () => {
  const state = page();
  const same = entry();
  state.toggleSessionHeartbeat(same, 'request', 'official:same:0');
  assert.equal(state.isSessionHeartbeatExpanded(same, 'request', 'official:same:0'), true);
  assert.equal(state.isSessionHeartbeatExpanded(same, 'request', 'official:same:1'), false);
  assert.equal(state.isSessionHeartbeatExpanded(same, 'result-block', 'official:same:0'), false);
});

test('timeline identity and body copy are wired to both task card variants', () => {
  const card = fs.readFileSync(`${root}components/SessionHeartbeatCard.ets`, 'utf8');
  assert.match(source, /SessionTimelineCard\(row: RepeatItem<SessionTimelineRow>\)/);
  assert.match(source, /SessionEntryCard\(\{ entry: row\.item\.entry as CodexSessionEntry, rowKey: row\.item\.key \}\)/);
  assert.match(source, /copySessionPresentationText\(heartbeat\.instructions/);
  assert.match(source, /copySessionPresentationText\(heartbeat\.message/);
  assert.match(card, /Button\('复制正文'\)/);
});
