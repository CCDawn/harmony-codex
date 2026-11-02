import type { CodexSessionEntry } from '../model/BridgeModels';
import { matchOptimisticSessionMessages, stableCanonicalMessageKey } from './OptimisticMessageService';
import type { OptimisticSessionMessage, SessionMessageMatch } from './OptimisticMessageService';
import { presentSessionActivities, shouldHideSessionActivity } from './SessionActivityPresentation';
import type { SessionDisplayEntry } from './SessionActivityPresentation';

/** Structurally compatible with the page's failed message, without UI ownership. */
export interface SessionTimelineFailedMessage {
  id: string;
  sessionId: string;
  submissionId: string;
  text: string;
  createdAt: string;
  itemId?: string;
  turnId?: string;
  submittedText?: string;
  baselineEntryKeys?: string[];
  images?: Object[];
  files?: Object[];
}

export interface SessionTimelineRow {
  key: string;
  kind: 'entry' | 'optimistic' | 'failed';
  timestamp: string;
  entry?: SessionDisplayEntry;
  optimistic?: OptimisticSessionMessage;
  failedId?: string;
}

function localMessageKey(sessionId: string, submissionId: string, fallbackId: string): string {
  return `local:${JSON.stringify([sessionId, submissionId || fallbackId])}`;
}

function failedMatchCandidate(message: SessionTimelineFailedMessage): OptimisticSessionMessage {
  const hasAttachments = (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0;
  return {
    id: message.id, sessionId: message.sessionId, submissionId: message.submissionId,
    projectId: '', isNewSession: false, text: message.text, createdAt: message.createdAt,
    images: [], files: [], state: 'submitted', itemId: message.itemId, turnId: message.turnId,
    // Without a send-time baseline or an explicit identity a failed send cannot
    // be retired merely because an older/later message contains the same prose.
    submittedText: message.submittedText ?? (!hasAttachments && (message.baselineEntryKeys !== undefined || !!message.turnId)
      ? message.text : undefined),
    baselineEntryKeys: message.baselineEntryKeys
  };
}

/**
 * Pure projection: official history retains its order, local rows are inserted
 * at their original send time. No global text de-duplication or state mutation.
 * Call after every history/live/receipt update; store reconciliation separately.
 */
export function buildSessionTimeline(
  sessionId: string, officialEntries: CodexSessionEntry[],
  optimisticMessages: OptimisticSessionMessage[], failedMessages: SessionTimelineFailedMessage[]
): SessionTimelineRow[] {
  const failed = failedMessages.filter((message: SessionTimelineFailedMessage): boolean => message.sessionId === sessionId);
  const candidates: OptimisticSessionMessage[] = optimisticMessages.filter((message: OptimisticSessionMessage): boolean =>
    message.sessionId === sessionId && !failed.some((failure: SessionTimelineFailedMessage): boolean =>
      !!message.submissionId && failure.submissionId === message.submissionId));
  const optimisticCount = candidates.length;
  failed.forEach((message: SessionTimelineFailedMessage): void => { candidates.push(failedMatchCandidate(message)); });
  const matches = matchOptimisticSessionMessages(candidates, sessionId, officialEntries);
  const matched: Set<number> = new Set<number>();
  const officialLocalKeys: Map<number, string> = new Map<number, string>();
  matches.forEach((match: SessionMessageMatch): void => {
    matched.add(match.messageIndex);
    const message = candidates[match.messageIndex];
    officialLocalKeys.set(match.entryIndex, localMessageKey(sessionId, message.submissionId, message.id));
  });
  const rows: SessionTimelineRow[] = [];
  const occurrences: Map<string, number> = new Map<string, number>();
  officialEntries.forEach((entry: CodexSessionEntry, index: number): void => {
    const baseKey = entry.role === 'assistant' && !entry.itemId && !entry.syncId
      ? `assistant:${JSON.stringify([entry.threadId ?? sessionId, entry.turnId ?? '', entry.type,
        entry.type === 'live_agent_streaming' ? '' : entry.timestamp])}` : stableCanonicalMessageKey(entry);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    rows.push({ key: officialLocalKeys.get(index) ?? `official:${baseKey}:${occurrence}`, kind: 'entry', timestamp: entry.timestamp,
      entry: entry as SessionDisplayEntry });
  });
  const localRows: SessionTimelineRow[] = [];
  candidates.forEach((message: OptimisticSessionMessage, index: number): void => {
    if (matched.has(index)) return;
    const key = localMessageKey(sessionId, message.submissionId, message.id);
    if (index < optimisticCount) {
      localRows.push({ key, kind: 'optimistic', timestamp: message.createdAt, optimistic: message });
    } else {
      localRows.push({ key, kind: 'failed', timestamp: message.createdAt, failedId: message.id });
    }
  });
  localRows.sort((left: SessionTimelineRow, right: SessionTimelineRow): number => {
    const difference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return Number.isFinite(difference) ? difference : 0;
  });
  // Do not re-sort official records: timestamps can be coarse or skewed.
  localRows.forEach((row: SessionTimelineRow): void => {
    const at = Date.parse(row.timestamp);
    let insertion = rows.length;
    if (Number.isFinite(at)) {
      for (let index = 0; index < rows.length; index += 1) {
        const officialAt = Date.parse(rows[index].timestamp);
        if (Number.isFinite(officialAt) && officialAt > at) { insertion = index; break; }
      }
    }
    rows.splice(insertion, 0, row);
  });
  // Local user sends must end an activity group too. Project only after all
  // local rows have been inserted, otherwise statuses could merge across them.
  const activityEntries = rows.map((row: SessionTimelineRow): CodexSessionEntry => {
    if (row.entry !== undefined) return row.entry;
    return { timestamp: row.timestamp, type: 'local_user_message', role: 'user', text: '', threadId: sessionId };
  });
  const presented = presentSessionActivities(activityEntries);
  return rows.filter((row: SessionTimelineRow, index: number): boolean => {
    if (row.kind !== 'entry') return true;
    row.entry = presented[index];
    return !shouldHideSessionActivity(presented[index]);
  });
}
