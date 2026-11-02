import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConversationEntries } from '../src/codexProtocolUtils.js';

const question = { title: 'AUDIT_CHOICE', options: ['Alpha', 'Beta'] };
function project(text) {
  return extractConversationEntries({ id: 'thread', turns: [{ id: 'turn', status: 'inProgress',
    items: [{ type: 'agentMessage', id: 'question-item', text, questions: [question] }] }] });
}
test('the native async-question markdown is not repeated by appending question metadata', () => {
  const native = 'AUDIT_CHOICE\n- Alpha\n- Beta';
  const entries = project(native);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, native);
  assert.deepEqual(entries[0].questions, [question]);
});
test('native prose is retained separately from the structured choice-card questions', () => {
  assert.equal(project('Please choose below.')[0].text, 'Please choose below.');
});
test('an empty native body can still show its structured question in historical content', () => {
  const entry = project('')[0];
  assert.equal(entry.text, 'AUDIT_CHOICE\nAlpha\nBeta');
  assert.deepEqual(entry.questions, [question]);
});
