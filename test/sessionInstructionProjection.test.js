import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexSessionStore } from '../src/codexSessions.js';

const sessionId = 'instruction-projection-session';
const message = (role, text, extra = {}) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: 'input_text', text }], ...extra }
});

async function visibleEntries(t, records, mode) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'session-instruction-projection-'));
  t.after(async () => {
    const resolved = path.resolve(codexHome);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('session-instruction-projection-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const directory = path.join(codexHome, 'sessions', '2026', '05', '28');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({
    id: sessionId, thread_name: 'Instruction projection fixture', updated_at: '2026-05-28T02:00:59Z'
  }) + '\n');
  await fs.writeFile(path.join(directory, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`), records.map((record, index) =>
    JSON.stringify({ timestamp: new Date(Date.UTC(2026, 4, 28, 2, 0, index)).toISOString(), ...record })
  ).join('\n') + '\n');
  const store = new CodexSessionStore({ codexHome });
  const detail = mode === 'sync'
    ? await store.getSessionSync(sessionId, { limit: 80 })
    : await store.getSession(sessionId, { tail: 80 });
  return detail.entries;
}

for (const mode of ['detail', 'sync']) {
  test(`${mode} hides raw developer/system instructions and retains ordinary conversation`, async t => {
    const entries = await visibleEntries(t, [
      message('system', 'Runtime setup instructions without any XML wrapper.'),
      message('developer', 'Internal formatting policy without a recognized instruction tag.'),
      message('user', 'Please reply to this visible prompt.'),
      message('assistant', 'This is the visible answer.')
    ], mode);
    assert.deepEqual(entries.map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: 'Please reply to this visible prompt.' },
      { role: 'assistant', text: 'This is the visible answer.' }
    ]);
  });

  test(`${mode} never reclassifies raw instructions as visible client notices`, async t => {
    const entries = await visibleEntries(t, [
      message('developer', 'Internal retry instructions.', { method: 'thread/status/changed', message: 'HTTP 401 authentication failed' }),
      message('system', 'Internal quota handling policy.', { method: 'thread/status/changed', message: 'rate limit exceeded' })
    ], mode);
    assert.deepEqual(entries, []);
  });

  test(`${mode} preserves explicit event notices and literal role references in user/assistant text`, async t => {
    const userText = 'Explain this literal record: {"role":"developer","content":"a quoted instruction"}.';
    const assistantText = 'The literal words system and developer describe message roles; this answer remains visible.';
    const entries = await visibleEntries(t, [
      message('user', userText),
      message('assistant', assistantText),
      { type: 'event_msg', payload: { type: 'error', message: 'HTTP 401 authentication failed' } },
      { type: 'event_msg', payload: { type: 'context_compaction', message: 'Codex compaction in progress' } }
    ], mode);
    assert.equal(entries[0].role, 'user');
    assert.equal(entries[0].text, userText);
    assert.equal(entries[1].role, 'assistant');
    assert.equal(entries[1].text, assistantText);
    assert.deepEqual(entries.slice(2).map(({ type, role, liveKind }) => ({ type, role, liveKind })), [
      { type: 'codex_client_notice', role: 'system', liveKind: 'auth' },
      { type: 'codex_client_notice', role: 'system', liveKind: 'context' }
    ]);
  });
}
