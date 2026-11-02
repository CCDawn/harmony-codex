import { CodexSessionEntry, CodexSessionToolItem } from '../model/BridgeModels';

export interface SessionStreamMessage { entry: CodexSessionEntry; }

/** Official pages contain complete turns. Refresh those turns in their existing
 * positions; item timestamps and message bodies are never ordering identities. */
export function mergeOfficialSessionEntryPages(
  older: CodexSessionEntry[], newer: CodexSessionEntry[], completedTurnIds: string[] = [], threadId: string = ''
): CodexSessionEntry[] {
  const replacements: Map<string, CodexSessionEntry[]> = new Map<string, CodexSessionEntry[]>();
  newer.forEach((entry: CodexSessionEntry) => {
    const key = JSON.stringify([entry.threadId, entry.turnId]);
    const turn = replacements.get(key) ?? [];
    turn.push(entry);
    replacements.set(key, turn);
  });
  // A complete terminal turn can legitimately have no displayable items.
  // The supplied thread ID limits that empty replacement to its own session.
  if (threadId.length > 0) {
    completedTurnIds.forEach((turnId: string) => {
      if (turnId.length === 0) return;
      const key = JSON.stringify([threadId, turnId]);
      if (!replacements.has(key)) replacements.set(key, []);
    });
  }
  const result: CodexSessionEntry[] = [];
  const visited: Set<string> = new Set<string>();
  older.forEach((entry: CodexSessionEntry) => {
    const key = JSON.stringify([entry.threadId, entry.turnId]);
    const replacement = replacements.get(key);
    if (replacement !== undefined) {
      if (!visited.has(key)) replacement.forEach((item: CodexSessionEntry) => { result.push(item); });
      visited.add(key);
    } else {
      result.push(entry);
    }
  });
  replacements.forEach((turn: CodexSessionEntry[], key: string) => {
    if (!visited.has(key)) turn.forEach((entry: CodexSessionEntry) => { result.push(entry); });
  });
  return result;
}

/** Only full official terminal turns supersede the matching live turn. */
export function pruneSessionLiveEntries(
  entries: CodexSessionEntry[], threadId: string, completedTurnIds: string[]
): CodexSessionEntry[] {
  if (threadId.length === 0 || completedTurnIds.length === 0) return entries;
  const completed: Set<string> = new Set<string>(completedTurnIds);
  const shouldPrune = (entry: CodexSessionEntry): boolean => entry.threadId === threadId
    && !!entry.turnId && completed.has(entry.turnId);
  if (!entries.some(shouldPrune)) return entries;
  return entries.filter((entry: CodexSessionEntry): boolean => !shouldPrune(entry));
}

function sameLiveItem(left: CodexSessionEntry, right: CodexSessionEntry): boolean {
  return !!left.itemId && left.itemId === right.itemId && left.threadId === right.threadId
    && left.turnId === right.turnId;
}

function isSettledToolEntry(entry: CodexSessionEntry): boolean {
  const items: CodexSessionToolItem[] = entry.toolItems ?? [];
  return entry.role === 'tool' && items.length > 0
    && items.every((item: CodexSessionToolItem) => ['completed', 'failed', 'stopped'].includes(item.status));
}

/** A desktop message is a replacement of one official item, never an extra delta bubble. */
export function upsertSessionLiveEntry(entries: CodexSessionEntry[], entry: CodexSessionEntry): CodexSessionEntry[] {
  const index = entries.findIndex((previous: CodexSessionEntry) => sameLiveItem(previous, entry));
  if (index < 0) return entries.concat([entry]);
  if (entries[index].liveKind === 'completed' && entry.liveKind === 'streaming') return entries;
  if (isSettledToolEntry(entries[index]) && !isSettledToolEntry(entry)) return entries;
  // A reconnect may replay an older snapshot of the same growing item.
  // Completed or divergent snapshots remain eligible to correct its content.
  if (entry.role === 'assistant' && entry.liveKind === 'streaming' && entries[index].text.length > entry.text.length
    && entries[index].text.startsWith(entry.text)) return entries;
  return entries.map((previous: CodexSessionEntry, at: number) => at === index ? entry : previous);
}

/** Keep live text until official history has it; an older history read cannot replace a growing item. */
export function mergeSessionLiveEntries(
  history: CodexSessionEntry[], live: CodexSessionEntry[], threadId: string, completedTurnIds: string[] = []
): CodexSessionEntry[] {
  const merged = history.slice();
  pruneSessionLiveEntries(live, threadId, completedTurnIds).forEach((entry: CodexSessionEntry) => {
    if (entry.threadId !== threadId || (entry.role !== 'assistant' && entry.role !== 'tool')) return;
    const identityIndex = merged.findIndex((previous: CodexSessionEntry) => previous.role === entry.role
      && !!previous.itemId && previous.itemId === entry.itemId
      && (!previous.turnId || previous.turnId === entry.turnId)
      && (!previous.threadId || previous.threadId === threadId));
    if (identityIndex >= 0) {
      const canonical = merged[identityIndex];
      if (canonical.liveKind === 'completed' || isSettledToolEntry(canonical)) return;
      if (entry.role === 'tool') {
        merged[identityIndex] = entry;
        return;
      }
      if (canonical.text !== entry.text && (entry.liveKind === 'completed' || canonical.text.length < entry.text.length)) {
        merged[identityIndex] = entry;
      }
      return;
    }
    const covered = entry.role === 'assistant' && merged.some((previous: CodexSessionEntry) => {
      if (previous.role !== 'assistant' || previous.text.trim() !== entry.text.trim()) return false;
      if (previous.itemId && previous.itemId !== entry.itemId || previous.turnId && previous.turnId !== entry.turnId
        || previous.threadId && previous.threadId !== threadId) return false;
      const at = Date.parse(previous.timestamp);
      const start = Date.parse(entry.timestamp);
      return Number.isFinite(at) && Number.isFinite(start) && at >= start - 2000;
    });
    if (!covered) merged.push(entry);
  });
  return merged;
}
