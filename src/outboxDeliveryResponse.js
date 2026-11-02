// The outbox owns delivery receipts, while live task stores own model runs.
// A compact persisted snapshot must never revive a stale running task.
export function resolveOutboxDispatchResult(item, { store, threadService } = {}) {
  const result = item.result;
  if (!result || result.outboxSnapshotVersion !== 1) return result;
  const { outboxSnapshotVersion: _version, ...payload } = result;
  const id = String(item.resultId || result.run?.id || result.id || '');
  let run = id ? store?.getTask?.(id) : null;
  if (!run && id && typeof threadService?.getRun === 'function') {
    try { run = threadService.getRun(id); } catch { /* The old run may no longer be loaded. */ }
  }
  const expectedThread = item.threadId || result.run?.codexSessionId
    || result.run?.createdCodexSessionId || result.run?.threadId || result.threadId || result.thread?.id;
  const actualThread = run?.codexSessionId || run?.createdCodexSessionId || run?.threadId;
  if (run?.id === id && expectedThread && actualThread === expectedThread
    && run.submissionId === item.submissionId) {
    payload.run = run;
  } else {
    delete payload.run;
  }
  return payload;
}
