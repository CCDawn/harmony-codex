import { BridgeOutboxItem, BridgeTask } from '../model/BridgeModels';
import { OptimisticSessionMessage } from './OptimisticMessageService';

export function outboxMessageLabel(message: OptimisticSessionMessage, items: BridgeOutboxItem[], task: BridgeTask | null): string {
  if (message.state !== 'submitted') return '发送中…';
  const item = items.find((entry: BridgeOutboxItem) => entry.submissionId === message.submissionId
    && entry.threadId === message.sessionId);
  if (item !== undefined) {
    if (item.status === 'held') return '历史待处理 · 查看队列';
    if (item.status === 'uncertain') return '发送结果待核对 · 查看队列';
    if (item.status === 'failed') return '发送失败 · 查看队列';
    if (item.status === 'queued') return item.blockedBy || item.blockedReason
      ? '前序消息待处理 · 查看队列' : '排队中';
    if (item.status === 'dispatching') return '正在确认送达';
  }
  return task !== null && task.id === message.taskId ? outboxTaskMessageLabel(task) : '等待送达确认';
}

export function outboxTaskMessageLabel(task: BridgeTask): string {
  if (task.runtime?.kind === 'durable_outbox') {
    if (task.runtime.state === 'queued') {
      const blocked = task.events.some((event) => typeof event.payload['message'] === 'string'
        && (event.payload['message'] as string).indexOf('前一条') >= 0);
      return blocked ? '前序消息待处理 · 查看队列' : '排队中';
    }
    if (task.runtime.state === 'held') return '历史待处理 · 查看队列';
    if (task.runtime.state === 'uncertain') return '发送结果待核对 · 查看队列';
    if (task.runtime.state === 'dispatching') return '正在确认送达';
  }
  return '等待送达确认';
}

/** Re-opened apps recover pending user bubbles from the durable submission IDs. */
export function restoreOutboxMessages(messages: OptimisticSessionMessage[], items: BridgeOutboxItem[], sessionId: string): OptimisticSessionMessage[] {
  const restored = messages.slice();
  items.forEach((item: BridgeOutboxItem) => {
    if (!sessionId || item.threadId !== sessionId) return;
    const deliveryAttemptAt = Number.isFinite(Date.parse(item.lastAttemptAt ?? '')) ? item.lastAttemptAt : undefined;
    const existingIndex = restored.findIndex((message: OptimisticSessionMessage) =>
      message.submissionId === item.submissionId && message.sessionId === sessionId);
    if (existingIndex >= 0) {
      const previous = restored[existingIndex];
      if (deliveryAttemptAt !== undefined && deliveryAttemptAt !== previous.deliveryAttemptAt) {
        restored[existingIndex] = {
          id: previous.id, sessionId: previous.sessionId, isNewSession: previous.isNewSession,
          projectId: previous.projectId, submissionId: previous.submissionId, text: previous.text,
          images: previous.images, files: previous.files, createdAt: previous.createdAt,
          deliveryAttemptAt, state: previous.state, taskId: previous.taskId, turnId: previous.turnId,
          itemId: previous.itemId, submittedText: previous.submittedText,
          baselineEntryKeys: previous.baselineEntryKeys, restoredFromOutbox: previous.restoredFromOutbox
        };
      }
      return;
    }
    if (!['queued', 'dispatching', 'uncertain', 'failed'].includes(item.status)) return;
    restored.push({ id: `outbox:${item.submissionId}`, sessionId, projectId: item.projectId,
      isNewSession: false, submissionId: item.submissionId, taskId: item.resultId || item.id,
      text: item.text, submittedText: item.text, createdAt: item.createdAt, deliveryAttemptAt, state: 'submitted',
      images: [], files: [], restoredFromOutbox: true });
  });
  return restored;
}
