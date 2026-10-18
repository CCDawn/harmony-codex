import path from 'node:path';
import { extractLocalImageInputs } from './codexTurnInput.js';

const SESSION_TIMESTAMP_SKEW_MS = 5_000;

export function createOutboxReceiptReconciler({ threadService = null, sessions = null, store = null } = {}) {
  return async function reconcileOutboxReceipt(item) {
    // A local task (or a steer acknowledgement for its original prompt) is not
    // a receipt for this submission. Confirm the exact input in official history.
    if (item.result?.deliveryPending === true) {
      const task = store?.getTask?.(item.resultId);
      const receiptTask = task ?? persistedReceiptTask(item);
      const threadId = item.threadId || receiptTask?.codexSessionId || receiptTask?.createdCodexSessionId;
      const detail = threadId && sessions?.getSession
        ? await sessions.getSession(threadId, { tail: 200 }).catch(() => null)
        : null;
      const attemptAt = Date.parse(item.lastAttemptAt);
      const found = detail?.entries?.find(entry => isUserEntry(entry)
        && String(entry.text ?? '').trim() === String(item.text ?? '').trim()
        && Date.parse(entry.timestamp) >= attemptAt);
      const canonicalImageReceipt = !found && await findCanonicalImageReceipt({ item, task: receiptTask, threadId, attemptAt, sessions });
      if (found || canonicalImageReceipt) {
        return {
          status: 'submitted', evidence: 'session_user_message',
          // A persisted run is evidence only; its old running state is not a
          // recovered task. Without a live task, return an official receipt.
          result: {
            ...(task ? { run: task } : sessionReceiptResult(item, threadId, found || canonicalImageReceipt)),
            deliveryPending: false
          }
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

async function findCanonicalImageReceipt({ item, task, threadId, attemptAt, sessions }) {
  const images = extractLocalImageInputs(item.text);
  if (images.length === 0 || !Number.isFinite(attemptAt)
    || task?.id !== item.resultId || typeof sessions?.readSessionRecordsAfterCursor !== 'function') {
    return false;
  }
  // Display entries append image markdown and sanitize text. Read the original
  // official input only from this task's captured, thread-scoped rollout cursor.
  const cursor = [...(Array.isArray(task.events) ? task.events : [])].reverse().find(event => (
    event.type === 'codex.session_file.cursor_captured'
    && (!event.taskId || event.taskId === task.id)
    && event.payload?.sessionId === threadId
    && event.payload.filePath
    && Number.isSafeInteger(event.payload.offset)
    && event.payload.offset >= 0
  ))?.payload;
  if (!cursor) return false;
  const records = await sessions.readSessionRecordsAfterCursor(cursor).catch(() => []);
  return Array.isArray(records) && records.find(record => {
    const message = record?.payload;
    if (record?.type !== 'response_item' || message?.type !== 'message' || message.role !== 'user'
      || !(Date.parse(record.timestamp) >= attemptAt) || !Array.isArray(message.content)) return false;
    const content = message.content;
    if (content.length !== 1 + images.length * 3 || content[0]?.type !== 'input_text'
      || String(content[0].text ?? '').trim() !== String(item.text ?? '').trim()) return false;
    return images.every((image, index) => {
      const [opening, pixels, closing] = content.slice(1 + index * 3, 4 + index * 3);
      const wrapper = opening?.type === 'input_text'
        ? String(opening.text ?? '').match(/^<image name=\[Image #(\d+)\] path=(.+)>$/) : null;
      if (!wrapper || Number(wrapper[1]) !== index + 1 || pixels?.type !== 'input_image'
        || closing?.type !== 'input_text' || String(closing.text ?? '').trim() !== '</image>') return false;
      let imagePath = wrapper[2];
      if (imagePath.startsWith('"')) {
        try { imagePath = JSON.parse(imagePath); } catch { return false; }
      }
      return typeof imagePath === 'string' && sameImagePath(imagePath, image.path);
    });
  });
}

function sameImagePath(left, right) {
  const normalize = value => path.win32.normalize(value).toLowerCase();
  return normalize(left) === normalize(right);
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
