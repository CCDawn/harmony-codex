import { VoiceTranscriptEntry } from '../model/BridgeModels';
import { CompanionTextMessage } from '../model/CompanionModels';

export interface CompanionTimelineItem {
  key: string;
  entry: VoiceTranscriptEntry | null;
  message: CompanionTextMessage | null;
}

interface OrderedTranscript {
  entry: VoiceTranscriptEntry;
  order: number;
}

interface OrderedTimelineItem {
  item: CompanionTimelineItem;
  createdAt: number | undefined;
  order: number;
}

function reliableTime(createdAt: number | undefined): number | undefined {
  return createdAt !== undefined && Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : undefined;
}

function compareTimes(left: number | undefined, right: number | undefined): number {
  const leftTime = reliableTime(left);
  const rightTime = reliableTime(right);
  if (leftTime === undefined) {
    return rightTime === undefined ? 0 : -1;
  }
  return rightTime === undefined ? 1 : leftTime - rightTime;
}

function transcriptIdentity(entry: VoiceTranscriptEntry): string | undefined {
  return entry.itemId !== undefined && entry.itemId.length > 0
    ? JSON.stringify([entry.role, entry.itemId]) : undefined;
}

function updatedHistoryEntry(current: VoiceTranscriptEntry, incoming: VoiceTranscriptEntry): VoiceTranscriptEntry {
  return {
    itemId: incoming.itemId,
    role: incoming.role,
    text: incoming.text,
    final: incoming.final,
    createdAt: reliableTime(incoming.createdAt) ?? reliableTime(current.createdAt),
    requestId: incoming.requestId ?? current.requestId,
    phoneTranscript: current.phoneTranscript === true ? true : incoming.phoneTranscript,
    callId: incoming.callId ?? current.callId,
    localStorageStatus: incoming.localStorageStatus ?? current.localStorageStatus,
    localBridgeOrigin: incoming.localBridgeOrigin ?? current.localBridgeOrigin,
    localAssistantId: incoming.localAssistantId ?? current.localAssistantId,
    localRoomId: incoming.localRoomId ?? current.localRoomId
  };
}

/** Pages update only stable role/item identities. Missing timestamps remain unknown. */
export function mergeCompanionHistory(
  existing: VoiceTranscriptEntry[],
  page: VoiceTranscriptEntry[],
  older: boolean
): VoiceTranscriptEntry[] {
  const merged: VoiceTranscriptEntry[] = [];
  const indexes: Map<string, number> = new Map<string, number>();
  // An older page precedes existing entries when both have no time or equal time.
  const sources: VoiceTranscriptEntry[][] = older ? [page, existing] : [existing, page];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    for (let index = 0; index < source.length; index += 1) {
      const entry = source[index];
      const identity = transcriptIdentity(entry);
      const target = identity === undefined ? undefined : indexes.get(identity);
      if (target === undefined) {
        if (identity !== undefined) {
          indexes.set(identity, merged.length);
        }
        merged.push(entry);
      } else {
        // The fetched page is authoritative for content, including older pages.
        merged[target] = older && sourceIndex === 1
          ? updatedHistoryEntry(entry, merged[target]) : updatedHistoryEntry(merged[target], entry);
      }
    }
  }
  const ordered: OrderedTranscript[] = merged.map((entry: VoiceTranscriptEntry, order: number): OrderedTranscript => {
    return { entry, order };
  });
  ordered.sort((left: OrderedTranscript, right: OrderedTranscript): number => {
    return compareTimes(left.entry.createdAt, right.entry.createdAt) || left.order - right.order;
  });
  return ordered.map((value: OrderedTranscript): VoiceTranscriptEntry => value.entry);
}

function validRequestId(requestId: string | undefined): boolean {
  return requestId !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
}

function textRequestKey(requestId: string): string {
  return validRequestId(requestId) ? requestId.toLowerCase() : requestId;
}

function confirmsText(entry: VoiceTranscriptEntry, message: CompanionTextMessage): boolean {
  if (entry.role !== 'user' || entry.phoneTranscript === true || !entry.itemId?.startsWith('room:')) {
    return false;
  }
  return (message.itemId !== null && entry.itemId === message.itemId)
    || (validRequestId(message.requestId) && validRequestId(entry.requestId)
      && entry.requestId?.toLowerCase() === message.requestId.toLowerCase() && entry.text === message.text);
}

/** Official history and the recovery outbox share one stable chronological list. */
export function composeCompanionTimeline(
  entries: VoiceTranscriptEntry[],
  textMessages: CompanionTextMessage[]
): CompanionTimelineItem[] {
  const ordered: OrderedTimelineItem[] = [];
  const normalized = mergeCompanionHistory([], entries, false);
  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    const identity = transcriptIdentity(entry);
    const hasUnconfirmedCopy = textMessages.some((message: CompanionTextMessage): boolean => {
      return validRequestId(entry.requestId) && validRequestId(message.requestId)
        && entry.requestId?.toLowerCase() === message.requestId.toLowerCase() && !confirmsText(entry, message);
    });
    const requestKey = entry.role === 'user' && entry.phoneTranscript !== true
      && entry.itemId?.startsWith('room:') === true && validRequestId(entry.requestId) && !hasUnconfirmedCopy;
    const item: CompanionTimelineItem = {
      key: requestKey ? `text:${entry.requestId?.toLowerCase()}`
        : identity === undefined ? `entry:legacy:${index}` : `entry:${identity}`,
      entry,
      message: null
    };
    ordered.push({ item, createdAt: entry.createdAt, order: ordered.length });
  }
  const messages: CompanionTextMessage[] = [];
  const requestIndexes: Map<string, number> = new Map<string, number>();
  for (let index = 0; index < textMessages.length; index += 1) {
    const message = textMessages[index];
    const requestKey = textRequestKey(message.requestId);
    const target = requestKey.length > 0 ? requestIndexes.get(requestKey) : undefined;
    if (target === undefined) {
      if (message.requestId.length > 0) {
        requestIndexes.set(requestKey, messages.length);
      }
      messages.push(message);
    } else {
      const current = messages[target];
      messages[target] = {
        requestId: message.requestId,
        text: message.text,
        state: message.state,
        itemId: message.itemId,
        createdAt: reliableTime(current.createdAt) ?? message.createdAt,
        detail: message.detail
      };
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (normalized.some((entry: VoiceTranscriptEntry): boolean => confirmsText(entry, message))) {
      continue;
    }
    const item: CompanionTimelineItem = {
      key: message.requestId.length > 0 ? `text:${textRequestKey(message.requestId)}` : `text:legacy:${index}`,
      entry: null,
      message
    };
    ordered.push({ item, createdAt: message.createdAt, order: ordered.length });
  }
  ordered.sort((left: OrderedTimelineItem, right: OrderedTimelineItem): number => {
    return compareTimes(left.createdAt, right.createdAt) || left.order - right.order;
  });
  return ordered.map((value: OrderedTimelineItem): CompanionTimelineItem => value.item);
}

/** ArkUI ForEach reuses unchanged keys without rebuilding plain-object items. */
export function companionTimelineRenderKey(item: CompanionTimelineItem): string {
  return JSON.stringify(item);
}
