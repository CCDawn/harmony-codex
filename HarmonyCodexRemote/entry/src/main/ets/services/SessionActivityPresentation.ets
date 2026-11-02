import type { CodexSessionEntry } from '../model/BridgeModels';

export interface SessionDisplayEntry extends CodexSessionEntry {
  footerProgress?: string;
  activityInFooter?: boolean;
  activitySuperseded?: boolean;
  previousVisibleRole?: string;
  lastVisibleAssistant?: boolean;
}

function compactActivity(text: string): string {
  const value = text.trim();
  if (value === '正在返回内容' || value === 'Codex 正在返回内容' || value === '正在回复') return '正在回复';
  if (value === '正在思考' || value === 'Codex 正在思考' || value === '思考中') return '思考中';
  if (value === 'Codex 正在处理当前消息' || value === '处理中') return '处理中';
  return '';
}

function protectedActivity(entry: CodexSessionEntry): boolean {
  return entry.role === 'user' || entry.role === 'tool' || (entry.toolItems?.length ?? 0) > 0
    || /approval|question|user_input|error|tool/i.test(entry.liveKind ?? '');
}

function genericActivity(entry: CodexSessionEntry): boolean {
  return (entry.type === 'live_activity' || entry.type === 'live_agent_status')
    && !protectedActivity(entry) && compactActivity(entry.text).length > 0;
}

function laterActivity(entries: CodexSessionEntry[], previous: number, candidate: number): number {
  if (previous < 0) return candidate;
  const previousAt = Date.parse(entries[previous].timestamp);
  const candidateAt = Date.parse(entries[candidate].timestamp);
  return Number.isFinite(previousAt) && Number.isFinite(candidateAt) && candidateAt < previousAt ? previous : candidate;
}

/** Only contiguous generic statuses compete; important content ends the group. */
function supersededActivities(entries: CodexSessionEntry[]): Set<number> {
  const superseded: Set<number> = new Set<number>();
  let latest = -1;
  let turnId = '';
  entries.forEach((entry: CodexSessionEntry, index: number): void => {
    if (!genericActivity(entry)) { latest = -1; turnId = ''; return; }
    if (entry.turnId && turnId && entry.turnId !== turnId) latest = -1;
    turnId = entry.turnId || (latest >= 0 ? turnId : '');
    if (latest >= 0) {
      const winner = laterActivity(entries, latest, index);
      superseded.add(winner === index ? latest : index);
      latest = winner;
    } else {
      latest = index;
    }
  });
  return superseded;
}

/** Only generic adjacent progress can move into an assistant footer. */
export function sessionActivityOwner(entries: CodexSessionEntry[], activityIndex: number): number {
  const activity = entries[activityIndex];
  if (!activity || !genericActivity(activity)) return -1;
  let turnId = activity.turnId ?? '';
  for (let index = activityIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.turnId && turnId && entry.turnId !== turnId) return -1;
    turnId = turnId || entry.turnId || '';
    if (genericActivity(entry)) continue;
    return entry.role === 'assistant' && entry.type !== 'live_agent_status' ? index : -1;
  }
  return -1;
}

export function sessionAssistantActivity(entries: CodexSessionEntry[], assistantIndex: number): string {
  let latest = -1;
  for (let index = assistantIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!genericActivity(entry)) break;
    if (sessionActivityOwner(entries, index) !== assistantIndex) break;
    latest = laterActivity(entries, latest, index);
  }
  if (latest >= 0) return compactActivity(entries[latest].text);
  return entries[assistantIndex]?.type === 'live_agent_streaming' ? '正在回复' : '';
}

/** Delivery receipts belong to the user's bubble, never to Codex's content. */
export function isSessionDeliveryActivity(entry: CodexSessionEntry): boolean {
  if (protectedActivity(entry) || entry.type !== 'live_activity' && entry.type !== 'live_agent_status') return false;
  const value = entry.text.trim();
  return value === '消息已进入 Codex 官方会话' || value === '已提交 · 正在同步'
    || value === '正在确认这条消息是否进入官方会话'
    || value === '消息已进入 Codex 官方会话，正在同步会话'
    || /^(已发送|已送达|已提交|已排队|发送中|正在发送|等待连接后发送)(?:\s*[·：:]\s*等待确认)?$/.test(value);
}

export function shouldHideSessionActivity(entry: SessionDisplayEntry): boolean {
  return entry.activityInFooter === true || entry.activitySuperseded === true || isSessionDeliveryActivity(entry);
}

/** Snapshot row context in two linear passes, preserving the input list's role order. */
export function presentSessionEntryContext(entries: CodexSessionEntry[]): SessionDisplayEntry[] {
  let lastAssistantIndex = -1;
  entries.forEach((entry: CodexSessionEntry, index: number): void => {
    if (entry.role === 'assistant') lastAssistantIndex = index;
  });
  let previousRole = '';
  return entries.map((entry: CodexSessionEntry, index: number): SessionDisplayEntry => {
    const previous = entry as SessionDisplayEntry;
    const role = entry.role;
    const result: SessionDisplayEntry = {
      timestamp: entry.timestamp, type: entry.type, role: role, text: entry.text,
      syncId: entry.syncId, syncStartOffset: entry.syncStartOffset, syncEndOffset: entry.syncEndOffset,
      liveKind: entry.liveKind, threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId,
      toolItems: entry.toolItems, footerProgress: previous.footerProgress,
      activityInFooter: previous.activityInFooter, activitySuperseded: previous.activitySuperseded,
      previousVisibleRole: previousRole, lastVisibleAssistant: index === lastAssistantIndex
    };
    previousRole = role;
    return result;
  });
}

/** Compute presentation metadata once per list, without mutating server history. */
export function presentSessionActivities(entries: CodexSessionEntry[]): SessionDisplayEntry[] {
  const superseded = supersededActivities(entries);
  // A live turn can contain many already-finished commentary messages. Only
  // the current content at the end of the list can own a running footer;
  // later user/tool/approval content also ends the previous message's status.
  let activeAssistantIndex = -1;
  entries.forEach((entry: CodexSessionEntry, index: number): void => {
    if (!genericActivity(entry) && !isSessionDeliveryActivity(entry)) {
      activeAssistantIndex = entry.role === 'assistant' ? index : -1;
    }
  });
  return entries.map((entry: CodexSessionEntry, index: number): SessionDisplayEntry => {
    const footerProgress = index === activeAssistantIndex ? sessionAssistantActivity(entries, index) : '';
    const activityInFooter = sessionActivityOwner(entries, index) >= 0;
    const activitySuperseded = superseded.has(index);
    const previous = entry as SessionDisplayEntry;
    if (footerProgress.length === 0 && !activityInFooter && !activitySuperseded
      && !previous.footerProgress && !previous.activityInFooter && !previous.activitySuperseded) return entry;
    return {
      timestamp: entry.timestamp, type: entry.type, role: entry.role, text: entry.text,
      syncId: entry.syncId, syncStartOffset: entry.syncStartOffset, syncEndOffset: entry.syncEndOffset,
      liveKind: entry.liveKind, threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId,
      toolItems: entry.toolItems, footerProgress, activityInFooter, activitySuperseded,
      previousVisibleRole: previous.previousVisibleRole, lastVisibleAssistant: previous.lastVisibleAssistant
    };
  });
}
