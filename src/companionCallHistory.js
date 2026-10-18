// Call records are official metadata, not user/assistant transcript messages.
export function companionCallRecords(items, authors = []) {
  const authorIds = new Set(authors.map(author => author.accountUserId));
  const records = new Map();
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.deleted_at || !validId(item.id) || !authorIds.has(item.account_user_id)) continue;
    const attachments = Array.isArray(item.content?.attachments) ? item.content.attachments : [];
    for (const call of attachments) {
      if (!call || call.type !== 'call' || !validId(call.call_id)) continue;
      const record = {
        messageId: item.id,
        callId: call.call_id,
        createdAt: date(item.created_at) ?? '',
        endedAt: date(call.ended_at),
        durationMs: Number.isSafeInteger(call.duration_ms) && call.duration_ms >= 0 ? call.duration_ms : null,
        outcome: typeof call.outcome === 'string' && call.outcome.length <= 64 ? call.outcome : 'unknown',
        transcriptStatus: typeof call.transcript_status === 'string' && call.transcript_status.length <= 64
          ? call.transcript_status : 'unknown',
        summary: typeof item.content?.text === 'string' && item.content.text.trim() ? item.content.text : null
      };
      records.set(JSON.stringify([record.messageId, record.callId]), record);
    }
  }
  return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
