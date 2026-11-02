export function createOutboxReceiptReconciler({ threadService = null, store = null } = {}) {
  return async function reconcileOutboxReceipt(item) {
    // A task alone is not a receipt: an ACK must belong to this submission.
    if (item.result?.deliveryPending === true) {
      const task = store?.getTask?.(item.resultId);
      const receiptTask = task ?? persistedReceiptTask(item);
      const threadId = item.threadId || receiptTask?.codexSessionId || receiptTask?.createdCodexSessionId;
      const acknowledgement = findSubmissionAcknowledgement(item, receiptTask);
      if (acknowledgement) {
        return {
          status: 'submitted', evidence: 'rpc_acknowledgement',
          result: {
            ...(task ? { run: task } : sessionReceiptResult(item, threadId, { timestamp: acknowledgement.createdAt })),
            deliveryPending: false
          }
        };
      }
      const attemptAt = Date.parse(item.lastAttemptAt);
      if (isExplicitlyUnattemptedFailure(receiptTask, item)) {
        return {
          status: 'failed', retryable: true, evidence: 'delivery_not_attempted',
          result: { run: receiptTask, deliveryPending: true },
          error: receiptTask.error || '消息尚未尝试投递，可在连接恢复后重试。'
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

    // A matching history body has no submission identity and can belong to a
    // different send, even when its timestamp overlaps this attempt.
    return { status: 'unknown', evidence: 'no_receipt' };
  };
}

function findSubmissionAcknowledgement(item, task) {
  const threadId = task?.codexSessionId || task?.createdCodexSessionId;
  const submissionId = String(item.submissionId ?? '').trim();
  if (!submissionId || !item.resultId || task?.id !== item.resultId || !threadId
    || (item.kind === 'existing_thread' && threadId !== item.threadId)) return null;
  return (Array.isArray(task.events) ? task.events : []).find(event => {
    if (event.taskId && event.taskId !== task.id) return false;
    if (event.type === 'task.guidance.accepted') {
      return event.payload?.submissionId === submissionId && Boolean(event.payload?.turnId);
    }
    return event.type === 'codex.app_server.turn.started'
      && task.submissionId === submissionId && Boolean(event.payload?.turn?.id);
  }) ?? null;
}

function isExplicitlyUnattemptedFailure(task, item) {
  return task?.status === 'failed' && task.id === item.resultId
    && task.deliveryAttempted === false
    && (task.codexSessionId || task.createdCodexSessionId) === item.threadId
    && String(task.prompt ?? '').trim() === String(item.text ?? '').trim()
    && !(task.events ?? []).some(event => (
      event.type === 'codex.delivery.attempted'
      || event.type === 'codex.app_server.turn.started'
      || event.type === 'codex.app_server.turn.steered'
    ));
}

function persistedReceiptTask(item) {
  const task = item.result?.run;
  const threadId = task?.codexSessionId || task?.createdCodexSessionId;
  if (!item.resultId || task?.id !== item.resultId || !threadId
    || (item.kind === 'existing_thread' && threadId !== item.threadId)) return null;
  return task;
}

function sessionReceiptResult(item, threadId, entry) {
  const observedAt = String(entry.timestamp ?? '');
  return {
    id: `session-receipt:${threadId}:${observedAt}`,
    threadId,
    submissionId: item.submissionId,
    observedAt
  };
}
