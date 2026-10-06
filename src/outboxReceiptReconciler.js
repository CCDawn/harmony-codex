const SESSION_TIMESTAMP_SKEW_MS = 5_000;

export function createOutboxReceiptReconciler({ threadService = null, sessions = null, store = null } = {}) {
  return async function reconcileOutboxReceipt(item) {
    // A local task (or a steer acknowledgement for its original prompt) is not
    // a receipt for this submission. Confirm the exact input in official history.
    if (item.result?.deliveryPending === true) {
      const task = store?.getTask?.(item.resultId);
      const threadId = item.threadId || task?.codexSessionId || task?.createdCodexSessionId;
      const detail = threadId && sessions?.getSession
        ? await sessions.getSession(threadId, { tail: 200 }).catch(() => null)
        : null;
      const attemptAt = Date.parse(item.lastAttemptAt);
      const found = detail?.entries?.find(entry => isUserEntry(entry)
        && String(entry.text ?? '').trim() === String(item.text ?? '').trim()
        && Date.parse(entry.timestamp) >= attemptAt);
      if (found) {
        return {
          status: 'submitted', evidence: 'session_user_message',
          result: { ...(task ? { run: task } : item.result), deliveryPending: false }
        };
      }
      const expired = Number.isFinite(attemptAt) && Date.now() - attemptAt > 90_000;
      if (!task || ['failed', 'completed', 'interrupted'].includes(task.status) || expired) {
        return { status: 'uncertain', error: `未确认这条消息进入官方会话，已停止自动重发。${task?.error || '请核对会话后再决定是否重试。'}` };
      }
      return { status: 'unknown', evidence: 'awaiting_official_message' };
    }
    const persistedRun = typeof threadService?.findRunBySubmission === 'function'
      ? threadService.findRunBySubmission({
          kind: item.kind,
          threadId: item.threadId,
          projectId: item.projectId,
          submissionId: item.submissionId
        })
      : null;
    if (persistedRun) {
      return {
        status: 'submitted',
        evidence: 'submission_journal',
        result: persistedRun
      };
    }

    if (item.kind !== 'existing_thread'
      || !item.threadId
      || typeof sessions?.getSession !== 'function') {
      return { status: 'unknown', evidence: 'no_receipt' };
    }

    const detail = await sessions.getSession(item.threadId, { tail: 200 }).catch(() => null);
    const attemptAt = Date.parse(String(item.lastAttemptAt ?? item.updatedAt ?? ''));
    const matchingEntry = Array.isArray(detail?.entries)
      ? [...detail.entries].reverse().find((entry) => (
          isUserEntry(entry)
          && String(entry.text ?? '').trim() === String(item.text ?? '').trim()
          && isAtOrAfterAttempt(entry.timestamp, attemptAt)
        ))
      : null;
    if (!matchingEntry) {
      return { status: 'unknown', evidence: 'no_receipt' };
    }

    return {
      status: 'submitted',
      evidence: 'session_user_message',
      result: {
        id: `session-receipt:${item.threadId}:${String(matchingEntry.timestamp ?? '')}`,
        threadId: item.threadId,
        submissionId: item.submissionId,
        observedAt: String(matchingEntry.timestamp ?? '')
      }
    };
  };
}

function isUserEntry(entry) {
  const type = String(entry?.type ?? '').toLowerCase();
  const role = String(entry?.role ?? '').toLowerCase();
  return role === 'user' || type === 'usermessage' || type === 'user_message';
}

function isAtOrAfterAttempt(timestamp, attemptAt) {
  if (!Number.isFinite(attemptAt)) {
    return false;
  }
  const observedAt = Date.parse(String(timestamp ?? ''));
  return Number.isFinite(observedAt) && observedAt >= attemptAt - SESSION_TIMESTAMP_SKEW_MS;
}
