import type { VoiceTranscriptEntry } from '../model/BridgeModels';

/**
 * Applies one realtime transcript event without mutating the current list.
 * itemId is the authoritative key when present. Older servers that omit it
 * fall back to the latest unfinished entry for the same role.
 */
export function reduceVoiceTranscriptEntries(
  entries: VoiceTranscriptEntry[],
  event: VoiceTranscriptEntry
): VoiceTranscriptEntry[] {
  const hasItemId = typeof event.itemId === 'string' && event.itemId.length > 0;
  let targetIndex = -1;

  if (hasItemId) {
    targetIndex = entries.findIndex((entry: VoiceTranscriptEntry) => entry.itemId === event.itemId);
  } else {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role === event.role && !entry.final && !entry.itemId) {
        targetIndex = index;
        break;
      }
    }
  }

  if (targetIndex < 0) {
    const created: VoiceTranscriptEntry = {
      role: event.role,
      text: event.text,
      final: event.final,
      itemId: event.itemId
    };
    if (event.phoneTranscript !== undefined) {
      created.phoneTranscript = event.phoneTranscript;
    }
    if (event.callId !== undefined) {
      created.callId = event.callId;
    }
    if (event.localStorageStatus !== undefined) {
      created.localStorageStatus = event.localStorageStatus;
    }
    if (event.localBridgeOrigin !== undefined) {
      created.localBridgeOrigin = event.localBridgeOrigin;
    }
    if (event.localAssistantId !== undefined) {
      created.localAssistantId = event.localAssistantId;
    }
    if (event.localRoomId !== undefined) {
      created.localRoomId = event.localRoomId;
    }
    return entries.concat(created);
  }

  const current = entries[targetIndex];
  if (current.final && !event.final) {
    return entries.slice();
  }

  const updated: VoiceTranscriptEntry = {
    role: current.role,
    text: event.final ? event.text : current.text + event.text,
    final: current.final || event.final,
    itemId: current.itemId
  };
  if (current.phoneTranscript !== undefined || event.phoneTranscript !== undefined) {
    updated.phoneTranscript = current.phoneTranscript ?? event.phoneTranscript;
  }
  if (current.callId !== undefined || event.callId !== undefined) {
    updated.callId = current.callId ?? event.callId;
  }
  if (current.localStorageStatus !== undefined || event.localStorageStatus !== undefined) {
    updated.localStorageStatus = current.localStorageStatus ?? event.localStorageStatus;
  }
  if (current.localBridgeOrigin !== undefined || event.localBridgeOrigin !== undefined) {
    updated.localBridgeOrigin = current.localBridgeOrigin ?? event.localBridgeOrigin;
  }
  if (current.localAssistantId !== undefined || event.localAssistantId !== undefined) {
    updated.localAssistantId = current.localAssistantId ?? event.localAssistantId;
  }
  if (current.localRoomId !== undefined || event.localRoomId !== undefined) {
    updated.localRoomId = current.localRoomId ?? event.localRoomId;
  }
  return entries.map((entry: VoiceTranscriptEntry, index: number) => index === targetIndex ? updated : entry);
}

export class VoiceTranscriptReducer {
  static normalizeHistory(entries: VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
    const normalized: VoiceTranscriptEntry[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if ((entry.role !== 'user' && entry.role !== 'assistant') || entry.text.length === 0) {
        continue;
      }
      normalized.push({
        itemId: entry.itemId,
        role: entry.role,
        text: entry.text,
        final: true
      });
    }
    return normalized;
  }

  static replaceHistory(history: VoiceTranscriptEntry[], liveEntries: VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
    const merged: VoiceTranscriptEntry[] = history.slice();
    for (let liveIndex = 0; liveIndex < liveEntries.length; liveIndex += 1) {
      const liveEntry = liveEntries[liveIndex];
      if (liveEntry.itemId !== undefined && liveEntry.itemId.indexOf('room:') === 0) {
        continue;
      }
      let alreadyInHistory = false;
      if (liveEntry.itemId !== undefined && liveEntry.itemId.length > 0) {
        for (let historyIndex = 0; historyIndex < merged.length; historyIndex += 1) {
          if (merged[historyIndex].itemId === liveEntry.itemId) {
            alreadyInHistory = true;
            break;
          }
        }
      } else {
        for (let historyIndex = 0; historyIndex < merged.length; historyIndex += 1) {
          const existing = merged[historyIndex];
          if (existing.itemId === undefined && existing.role === liveEntry.role && existing.text === liveEntry.text) {
            alreadyInHistory = true;
            break;
          }
        }
      }
      if (!alreadyInHistory) {
        merged.push(liveEntry);
      }
    }
    return merged;
  }

  static append(
    entries: VoiceTranscriptEntry[],
    event: VoiceTranscriptEntry
  ): VoiceTranscriptEntry[] {
    return reduceVoiceTranscriptEntries(entries, event);
  }
}
