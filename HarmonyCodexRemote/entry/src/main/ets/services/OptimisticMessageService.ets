import type { CodexSessionEntry } from '../model/BridgeModels';

export interface OptimisticSessionImage {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
}

export interface OptimisticSessionFile {
  id: string;
  fileName: string;
}

export interface OptimisticSessionMessage {
  id: string;
  sessionId: string;
  isNewSession: boolean;
  projectId: string;
  submissionId: string;
  text: string;
  images: OptimisticSessionImage[];
  files: OptimisticSessionFile[];
  createdAt: string;
  deliveryAttemptAt?: string;
  state?: 'sending' | 'submitted';
  taskId?: string;
  turnId?: string;
  itemId?: string;
  submittedText?: string;
  baselineEntryKeys?: string[];
  restoredFromOutbox?: boolean;
}

export interface OptimisticSessionSubmission {
  sessionId: string;
  taskId: string;
  deliveryAttemptAt?: string;
  turnId?: string;
  itemId?: string;
  text: string;
}

/** The bridge may attach the originating mobile submission to an official item. */
export interface IdentifiedSessionEntry extends CodexSessionEntry {
  submissionId?: string;
}

export interface SessionMessageMatch {
  messageIndex: number;
  entryIndex: number;
  entryKey: string;
}

export function appendOptimisticSessionMessage(
  messages: OptimisticSessionMessage[],
  message: OptimisticSessionMessage
): OptimisticSessionMessage[] {
  const next: OptimisticSessionMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].submissionId !== message.submissionId) {
      next.push(messages[index]);
    }
  }
  next.push(message);
  return next;
}

export function removeOptimisticSessionMessage(
  messages: OptimisticSessionMessage[],
  submissionId: string
): OptimisticSessionMessage[] {
  if (submissionId.length === 0) {
    return messages;
  }
  const next: OptimisticSessionMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].submissionId !== submissionId) {
      next.push(messages[index]);
    }
  }
  return next;
}

export function optimisticSessionMessagesForTarget(
  messages: OptimisticSessionMessage[],
  sessionId: string
): OptimisticSessionMessage[] {
  const visible: OptimisticSessionMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].sessionId === sessionId) {
      visible.push(messages[index]);
    }
  }
  return visible;
}
function copyOptimisticMessage(message: OptimisticSessionMessage): OptimisticSessionMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    isNewSession: message.isNewSession,
    projectId: message.projectId,
    submissionId: message.submissionId,
    text: message.text,
    images: message.images.slice(),
    files: message.files.slice(),
    createdAt: message.createdAt,
    deliveryAttemptAt: message.deliveryAttemptAt,
    state: message.state,
    taskId: message.taskId,
    turnId: message.turnId,
    itemId: message.itemId,
    submittedText: message.submittedText,
    baselineEntryKeys: message.baselineEntryKeys?.slice(),
    restoredFromOutbox: message.restoredFromOutbox
  };
}

/** Acknowledgement retains the original bubble until an official user item arrives. */
export function markOptimisticSessionSubmitted(
  messages: OptimisticSessionMessage[],
  submissionId: string,
  submission: OptimisticSessionSubmission
): OptimisticSessionMessage[] {
  return messages.map((message: OptimisticSessionMessage): OptimisticSessionMessage => {
    if (submissionId.length === 0 || message.submissionId !== submissionId) {
      return message;
    }
    const updated = copyOptimisticMessage(message);
    updated.sessionId = submission.sessionId;
    updated.isNewSession = false;
    updated.state = 'submitted';
    updated.taskId = submission.taskId;
    updated.turnId = submission.turnId ?? message.turnId;
    updated.itemId = submission.itemId ?? message.itemId;
    updated.submittedText = submission.text;
    if (submission.deliveryAttemptAt !== undefined && Number.isFinite(Date.parse(submission.deliveryAttemptAt))) {
      updated.deliveryAttemptAt = submission.deliveryAttemptAt;
    }
    return updated;
  });
}

function normalizedSubmittedText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function containsAttachmentIdentity(text: string): boolean {
  return /!?\[[^\]]*\]\([^)]*\)|<image(?:\s|>)|图片路径[：:]|(?:https?|file):\/\//i.test(text)
    || /(?:^|[\s"'=(])(?:[A-Za-z]:[\\/]|\\\\|\/[^\s/])/.test(text);
}

/**
 * Mirrors the non-lossy parts of codexSessions.sanitizeVisibleSessionText for
 * user records. Never erase an attachment identity to obtain a text match.
 * Null means that the visible projection cannot safely confirm this send.
 */
function projectedSubmittedUserText(value: string): string | null {
  let text = normalizedSubmittedText(value);
  const blockNames: string[] = [
    'permissions instructions', 'environment_context', 'app-context',
    'collaboration_mode', 'skills_instructions', 'plugins_instructions',
    'turn_aborted', 'personality_spec', 'image_resize_notice'
  ];
  for (let blockIndex = 0; blockIndex < blockNames.length; blockIndex += 1) {
    const name = blockNames[blockIndex];
    const open = `<${name}>`;
    const close = `</${name}>`;
    for (let guard = 0; guard < 12; guard += 1) {
      const start = text.indexOf(open);
      if (start < 0) {
        break;
      }
      const closeStart = text.indexOf(close, start + open.length);
      const end = closeStart < 0 ? text.length : closeStart + close.length;
      if (containsAttachmentIdentity(text.slice(start, end))) {
        return null;
      }
      text = text.slice(0, start) + text.slice(end);
      if (closeStart < 0) {
        break;
      }
    }
  }
  const agentsIndex = text.indexOf('# AGENTS.md instructions');
  if (agentsIndex >= 0) {
    if (containsAttachmentIdentity(text.slice(agentsIndex))) {
      return null;
    }
    text = text.slice(0, agentsIndex);
  }
  // Attribute-bearing image placeholders may contain paths erased by the
  // server; keep such sends pending instead of comparing their remaining prose.
  if (/<image\s+[^>]*>/i.test(text)) {
    return null;
  }
  text = text.replace(/<image>\s*<\/image>/gi, '')
    .replace(/^\s*<image>\s*$/gim, '').replace(/^\s*<\/image>\s*$/gim, '');
  const lines = text.split('\n');
  const kept: string[] = [];
  let skippingDirective = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const startsDirective = trimmed.startsWith('::code-comment{') || trimmed.startsWith('::archive{');
    if (skippingDirective || startsDirective) {
      if (containsAttachmentIdentity(line)) {
        return null;
      }
      skippingDirective = !trimmed.endsWith('}');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/^\s*\$[A-Za-z0-9][A-Za-z0-9_.-]*(?:\s+|$)/, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function submittedTextMatchesCanonical(submittedText: string, canonicalText: string): boolean {
  const expected = normalizedSubmittedText(canonicalText);
  if (normalizedSubmittedText(submittedText) === expected) {
    return true;
  }
  // Canonical text has already been projected exactly once by the bridge.
  const projected = projectedSubmittedUserText(submittedText);
  if (projected !== null && projected.length > 0 && projected === expected) return true;
  // Image labels and local file URL escaping are presentation differences;
  // retain every path/URL and its multiplicity while comparing their bodies.
  return projected !== null && projected.length > 0
    && normalizedImageSubmission(projected) === normalizedImageSubmission(expected);
}

function normalizedImagePath(value: string): string {
  let path = value.trim().replace(/^<(.+)>$/, '$1');
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(?:\/([A-Za-z]:))?/i, '$1');
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    try { path = decodeURIComponent(path); } catch (_) {}
    return path.replace(/\\/g, '/').toLowerCase();
  }
  return path;
}

function normalizedImageSubmission(value: string): string {
  let text = value.replace(/!\[[^\]]*\]\(([^)]+)\)/g,
    (_match: string, path: string): string => `![image](${normalizedImagePath(path)})`);
  text = text.replace(/^\s*图片路径[：:]\s*(.+)$/gm,
    (_match: string, path: string): string => `![image](${normalizedImagePath(path)})`);
  if (text.indexOf('![image](') >= 0) {
    text = text.replace(/^\s*我从手机端发送了一张图片，请查看并结合当前对话回复。\s*$/gm, '')
      .replace(/\n+(?=!\[image\]\()/g, '\n').trim();
  }
  return text;
}

/** Baseline identities never use text similarity or a mutable array index. */
export function stableCanonicalMessageKey(entry: CodexSessionEntry): string {
  const identified = entry as IdentifiedSessionEntry;
  if (entry.itemId !== undefined && entry.itemId.length > 0) {
    return `item:${JSON.stringify([entry.threadId ?? '', entry.role, entry.itemId])}`;
  }
  if (entry.syncId !== undefined && entry.syncId.length > 0) {
    return `sync:${JSON.stringify([entry.threadId ?? '', entry.role, entry.syncId])}`;
  }
  if (identified.submissionId !== undefined && identified.submissionId.length > 0) {
    return `submission:${JSON.stringify([entry.threadId ?? '', entry.role, identified.submissionId])}`;
  }
  return `content:${JSON.stringify([
    entry.threadId ?? '', entry.timestamp, entry.type, entry.role,
    entry.turnId ?? '', normalizedSubmittedText(entry.text)
  ])}`;
}

/** Count indistinguishable legacy records instead of collapsing actual sends. */
export function stableCanonicalMessageKeys(entries: CodexSessionEntry[]): string[] {
  const occurrences: Map<string, number> = new Map<string, number>();
  return entries.map((entry: CodexSessionEntry): string => {
    const key = stableCanonicalMessageKey(entry);
    if (!key.startsWith('content:')) return key;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return occurrence === 0 ? key : `${key}:occurrence:${occurrence}`;
  });
}

function isCanonicalUserEntry(entry: CodexSessionEntry, sessionId: string): boolean {
  return entry.role === 'user' && !entry.type.startsWith('live_')
    && (entry.liveKind === undefined || entry.liveKind.length === 0)
    && (entry.threadId === undefined || entry.threadId.length === 0 || entry.threadId === sessionId);
}

function matchesSubmittedMessage(
  message: OptimisticSessionMessage,
  entry: CodexSessionEntry,
  phase: number
): boolean {
  const identified = entry as IdentifiedSessionEntry;
  if (message.submissionId.length > 0 && identified.submissionId) {
    return message.submissionId === identified.submissionId;
  }
  const hasMessageItem = message.itemId !== undefined && message.itemId.length > 0;
  const hasEntryItem = entry.itemId !== undefined && entry.itemId.length > 0;
  if (hasMessageItem && hasEntryItem) {
    return message.itemId === entry.itemId;
  }
  if (phase === 0 || message.submittedText === undefined) {
    return false;
  }
  if (message.turnId !== undefined && message.turnId.length > 0
    && entry.turnId !== undefined && entry.turnId.length > 0 && message.turnId !== entry.turnId) {
    return false;
  }
  const textMatches = submittedTextMatchesCanonical(message.submittedText, entry.text);
  const sameTurn = !!message.turnId && message.turnId === entry.turnId;
  if (phase === 1) {
    return sameTurn && textMatches;
  }
  const attemptedAt = Date.parse(message.deliveryAttemptAt ?? '');
  const submittedAt = Number.isFinite(attemptedAt) ? attemptedAt : Date.parse(message.createdAt);
  const canonicalAt = Date.parse(entry.timestamp);
  // Only device-created timestamps need clock-skew tolerance. Actual delivery
  // attempts and official history share the host clock; never consume a user
  // record from before that attempt, even when the original send had a baseline.
  const skewMs = !Number.isFinite(attemptedAt) && message.baselineEntryKeys !== undefined ? 120000 : 0;
  return Number.isFinite(submittedAt) && Number.isFinite(canonicalAt)
    && canonicalAt >= submittedAt - skewMs && canonicalAt <= submittedAt + 900000 && textMatches;
}

/** Identity reservations precede turn/text and bounded timestamp fallback. */
export function matchOptimisticSessionMessages(
  messages: OptimisticSessionMessage[], sessionId: string, canonicalEntries: CodexSessionEntry[]
): SessionMessageMatch[] {
  const matches: SessionMessageMatch[] = [];
  const entryKeys = stableCanonicalMessageKeys(canonicalEntries);
  const consumed: Set<string> = new Set<string>();
  const removed: Set<number> = new Set<number>();
  for (let phase = 0; phase < 3; phase += 1) {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (message.sessionId !== sessionId || message.state !== 'submitted' || removed.has(messageIndex)) continue;
      const baseline = message.baselineEntryKeys ?? [];
      for (let entryIndex = 0; entryIndex < canonicalEntries.length; entryIndex += 1) {
        const entry = canonicalEntries[entryIndex];
        if (!isCanonicalUserEntry(entry, sessionId)) continue;
        const key = entryKeys[entryIndex];
        const baseKey = stableCanonicalMessageKey(entry);
        // Also accept pre-migration baselines containing the same base key N times.
        const occurrence = key === baseKey ? 0 : Number(key.slice(baseKey.length + ':occurrence:'.length));
        let legacyCount = 0;
        baseline.forEach((value: string): void => { if (value === baseKey) legacyCount += 1; });
        if (consumed.has(key) || baseline.indexOf(key) >= 0 || legacyCount > occurrence
          || !matchesSubmittedMessage(message, entry, phase)) continue;
        consumed.add(key);
        removed.add(messageIndex);
        matches.push({ messageIndex, entryIndex, entryKey: key });
        break;
      }
    }
  }
  return matches;
}

/**
 * Consumes official user items one-to-one, then carries their identities into
 * every remaining bubble's baseline so later polls cannot reuse a confirmation.
 */
export function reconcileOptimisticSessionMessages(
  messages: OptimisticSessionMessage[],
  sessionId: string,
  canonicalEntries: CodexSessionEntry[]
): OptimisticSessionMessage[] {
  const consumed: Set<string> = new Set<string>();
  const removed: Set<number> = new Set<number>();
  const matches = matchOptimisticSessionMessages(messages, sessionId, canonicalEntries);
  matches.forEach((match: SessionMessageMatch): void => {
    consumed.add(match.entryKey);
    removed.add(match.messageIndex);
  });
  const remaining: OptimisticSessionMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (removed.has(index)) {
      continue;
    }
    const message = messages[index];
    if (message.sessionId !== sessionId || consumed.size === 0) {
      remaining.push(message);
      continue;
    }
    const updated = copyOptimisticMessage(message);
    const baseline = updated.baselineEntryKeys ?? [];
    consumed.forEach((key: string): void => {
      if (baseline.indexOf(key) < 0) {
        baseline.push(key);
      }
    });
    updated.baselineEntryKeys = baseline;
    remaining.push(updated);
  }
  return remaining;
}
