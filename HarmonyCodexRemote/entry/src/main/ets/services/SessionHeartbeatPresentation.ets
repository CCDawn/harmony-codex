export interface SessionHeartbeat {
  automationId: string;
  currentTimeIso: string;
  instructions: string;
  preview: string;
}

export interface SessionHeartbeatResult {
  automationId: string;
  decision: string;
  message: string;
  preview: string;
}

function heartbeatPreview(value: string): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 240).join('');
}

/** Only consume a complete known envelope. Mixed text and unknown fields keep their normal rendering. */
export function parseSessionHeartbeat(text: string): SessionHeartbeat | null {
  const value = String(text ?? '').trim();
  if (!value.startsWith('<heartbeat>')) return null;
  const match = value.match(/^<heartbeat>\s*<automation_id>([^<>]+)<\/automation_id>\s*<current_time_iso>([^<>]+)<\/current_time_iso>\s*<instructions>([\s\S]*?)<\/instructions>\s*<\/heartbeat>$/);
  if (match === null || !match[1].trim() || !match[2].trim() || !match[3].trim()
    || /<\/?(?:heartbeat|instructions)\b[^>]*>/.test(match[3])) return null;
  return { automationId: match[1].trim(), currentTimeIso: match[2].trim(), instructions: match[3].trim(),
    preview: heartbeatPreview(match[3]) };
}

/** The assistant's heartbeat result has a different envelope from a scheduled instruction. */
export function parseSessionHeartbeatResult(text: string): SessionHeartbeatResult | null {
  const value = String(text ?? '').trim();
  if (!value.startsWith('<heartbeat>')) return null;
  const match = value.match(/^<heartbeat>\s*<automation_id>([^<>]+)<\/automation_id>\s*<decision>([^<>]+)<\/decision>\s*<message>([\s\S]*?)<\/message>\s*<\/heartbeat>$/);
  if (match === null || !match[1].trim() || !match[2].trim() || !match[3].trim()
    || /<\/?(?:heartbeat|message)\b[^>]*>/.test(match[3])) return null;
  return { automationId: match[1].trim(), decision: match[2].trim(), message: match[3].trim(),
    preview: heartbeatPreview(match[3]) };
}
