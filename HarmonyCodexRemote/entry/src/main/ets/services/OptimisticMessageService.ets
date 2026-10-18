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
