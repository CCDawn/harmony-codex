import type { SessionTimelineRow } from './SessionTimeline';

/** Only the UI is paged; canonical history, grouping and message identities stay complete. */
export function sessionRenderWindow(rows: SessionTimelineRow[], startKey: string): SessionTimelineRow[] {
  if (startKey.length === 0) return rows;
  const index = rows.findIndex((row: SessionTimelineRow) => row.key === startKey);
  // A canonical replacement may remove the boundary. Showing more is safer
  // than losing messages or moving a reader to a different recent window.
  return index > 0 ? rows.slice(index) : rows;
}

/** Reveal the page immediately before a stable row, or the recent page initially. */
export function earlierSessionRenderStartKey(rows: SessionTimelineRow[], beforeKey: string = '', size: number = 40): string {
  const before = beforeKey.length > 0 ? rows.findIndex((row: SessionTimelineRow) => row.key === beforeKey) : rows.length;
  const index = Math.max(0, before - size);
  return index > 0 ? rows[index].key : '';
}
