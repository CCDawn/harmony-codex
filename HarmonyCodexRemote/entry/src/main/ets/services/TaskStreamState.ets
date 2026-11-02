import { BridgeEvent, BridgeTask } from '../model/BridgeModels';

/** Append-only notifications are already applied locally; only metadata needs a snapshot. */
export function taskStreamNeedsSnapshot(event: BridgeEvent): boolean {
  const method = event.payload['method'];
  if (typeof method !== 'string') return true;
  if (method === 'item/started' || method === 'item/completed'
    || method === 'item/reasoning/summaryPartAdded' || /\/[^/]*[Dd]elta$/.test(method)) return false;
  return true;
}

/** ArkTS has no object spread; copy metadata without cloning the full history. */
export function taskWithStreamEvents(task: BridgeTask, events: BridgeEvent[], cursor: number): BridgeTask {
  return {
    id: task.id, projectId: task.projectId, prompt: task.prompt,
    promptPreview: task.promptPreview, promptLength: task.promptLength,
    codexSessionId: task.codexSessionId, sessionFingerprint: task.sessionFingerprint,
    verifiedSessionTarget: task.verifiedSessionTarget, createdCodexSessionId: task.createdCodexSessionId,
    model: task.model, reasoningEffort: task.reasoningEffort, status: task.status,
    createdAt: task.createdAt,
    updatedAt: events.length > 0 && Date.parse(events[events.length - 1].createdAt) > Date.parse(task.updatedAt)
      ? events[events.length - 1].createdAt : task.updatedAt,
    activeCodexTurnId: task.activeCodexTurnId,
    interruptReady: task.interruptReady, interruptRequested: task.interruptRequested,
    interruptDispatching: task.interruptDispatching, interruptError: task.interruptError,
    syntheticInterrupt: task.syntheticInterrupt, desktopSync: task.desktopSync, runtime: task.runtime,
    pendingUserInput: task.pendingUserInput, submissionId: task.submissionId, session: task.session,
    eventCount: Math.max(task.eventCount ?? 0, cursor), eventCursor: cursor, eventGap: false,
    hasMoreEvents: false, latestEvent: events.length > 0 ? events[events.length - 1] : null,
    resultSummary: task.resultSummary, error: task.error, events
  };
}
