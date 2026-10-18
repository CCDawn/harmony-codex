import assert from 'node:assert/strict';
import test from 'node:test';
import { companionCallRecords } from '../src/companionCallHistory.js';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';
import { CompanionConversationService } from '../src/companionConversationService.js';

const authors = [{ accountUserId: 'self', role: 'user' }];
const message = {
  id: 'm1', account_user_id: 'self', created_at: '2026-10-08T11:49:14Z',
  content: { text: null, attachments: [{ type: 'call', call_id: 'rtc_a',
    ended_at: '2026-10-08T11:49:13Z', duration_ms: 952290,
    outcome: 'ended', transcript_status: 'unavailable', private_secret: 'must not escape' }] }
};

test('call-only record survives independently of text, with unavailable preserved', () => {
  const calls = companionCallRecords([message], authors);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { messageId: 'm1', callId: 'rtc_a', createdAt: '2026-10-08T11:49:14Z',
    endedAt: '2026-10-08T11:49:13Z', durationMs: 952290, outcome: 'ended',
    transcriptStatus: 'unavailable', summary: null });
  assert.ok(!JSON.stringify(calls).includes('must not escape'));
});

test('deleted and unknown-author calls do not reappear as metadata', () => {
  assert.deepEqual(companionCallRecords([null, {...message, deleted_at: 'now'},
    {...message, account_user_id: 'outsider'}], authors), []);
  assert.deepEqual(companionCallRecords([message], []), []);
});

test('missing or malformed metadata stays unknown, not falsely confirmed', () => {
  const calls = companionCallRecords([{...message, content: {text: 'summary', attachments: [
    {type: 'call', call_id: 'rtc_b', duration_ms: -1, ended_at: 'invalid'}]}}], authors);
  assert.equal(calls[0].transcriptStatus, 'unknown');
  assert.equal(calls[0].durationMs, null);
  assert.equal(calls[0].endedAt, null);
  assert.equal(calls[0].summary, 'summary');
});

test('call normalization deduplicates stable identities and keeps chronological order', () => {
  const earlier = {...message, id: 'earlier', created_at: '2026-10-07T00:00:00Z'};
  assert.deepEqual(companionCallRecords([message, earlier, message], authors).map(x => x.messageId), ['earlier', 'm1']);
});

test('official calls cross client and service boundaries without becoming chat messages', async () => {
  const service = new CompanionConversationService({ clientFactory: () => {
    const client = new CompanionDesktopClient({ensureConnected:async()=>{},evaluate:async()=>({items:[message]}),close(){}});
    client.profile = {id:'assistant',roomId:'room'};
    client.roomMetadata = {authors};
    client.discover = async()=>client.profile;
    return client;
  }});
  const page = await service.getMessages({profileId:'assistant',roomId:'room'});
  assert.deepEqual(page.entries, []);
  assert.equal(page.calls[0].callId, 'rtc_a');
  assert.equal(page.calls[0].transcriptStatus, 'unavailable');
});

test('official call summaries remain call metadata rather than duplicate authored utterances', async () => {
  const client = new CompanionDesktopClient({ ensureConnected: async () => {},
    evaluate: async () => ({ items: [{ ...message, content: { ...message.content, text: 'Official call summary' } }] }),
    close() {} });
  client.profile = { id: 'assistant', roomId: 'room' };
  client.roomMetadata = { authors };
  const page = await client.messages();
  assert.deepEqual(page.entries, []);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].summary, 'Official call summary');
});
