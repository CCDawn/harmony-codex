import type { CompanionCallRecord } from '../model/CompanionModels';

export class CompanionHistoryReducer {
  /**
   * Merge calls by the official call identity while retaining records that a
   * partial or older backend response omitted.
   */
  static mergeCalls(existing: CompanionCallRecord[], incoming: CompanionCallRecord[]): CompanionCallRecord[] {
    const merged: CompanionCallRecord[] = existing.slice();
    incoming.forEach((call: CompanionCallRecord) => {
      const match = merged.findIndex((current: CompanionCallRecord) =>
        current.callId === call.callId && current.messageId === call.messageId);
      if (match >= 0) {
        merged[match] = call;
      } else {
        merged.push(call);
      }
    });
    merged.sort((left: CompanionCallRecord, right: CompanionCallRecord) => {
      const timeOrder = CompanionHistoryReducer.timestamp(left.createdAt)
        - CompanionHistoryReducer.timestamp(right.createdAt);
      return timeOrder === 0 ? left.messageId.localeCompare(right.messageId) : timeOrder;
    });
    return merged;
  }

  static transcriptStatusLabel(status: string): string {
    const normalized = String(status ?? '').trim().toLowerCase();
    if (normalized === 'unavailable') {
      return '官方转写不可用';
    }
    if (normalized === 'available' || normalized === 'completed') {
      return '官方转写可用';
    }
    if (normalized === 'pending' || normalized === 'processing' || normalized === 'in_progress') {
      return '官方转写处理中';
    }
    if (normalized === 'failed' || normalized === 'error') {
      return '官方转写失败';
    }
    return normalized.length > 0 ? `官方转写状态：${status}` : '官方转写状态未知';
  }

  private static timestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
