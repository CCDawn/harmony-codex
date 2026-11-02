// This is a receipt snapshot, never a replacement for the current runtime run.
// Copy selected fields before any JSON cloning: a run can contain years of
// output and tool events, while an outbox entry only needs its own send identity.
const RUN_FIELDS = [
  'id', 'kind', 'threadId', 'codexSessionId', 'createdCodexSessionId', 'createdThreadId',
  'projectId', 'projectRoot', 'submissionId', 'submissionSource', 'prompt',
  'promptPreview', 'promptLength', 'status', 'turnId', 'activeCodexTurnId',
  'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'submittedAt', 'observedAt',
  'deliveryAttempted', 'error', 'model', 'reasoningEffort', 'serviceTier'
];
const THREAD_FIELDS = [
  'id', 'threadId', 'title', 'name', 'projectId', 'projectRoot', 'cwd',
  'status', 'activityStatus', 'runtimeState', 'model', 'reasoningEffort',
  'serviceTier', 'createdAt', 'updatedAt'
];
const EVENT_TYPES = new Set([
  'codex.app_server.turn.started', 'codex.turn.started',
  'task.guidance.accepted', 'codex.delivery.attempted',
  'codex.app_server.turn.steered', 'codex.turn.steered'
]);

export function compactOutboxResult(result, item = null) {
  if (!isRecord(result)) return null;
  const snapshot = copyScalars(result, [...RUN_FIELDS, 'deliveryPending']);
  snapshot.outboxSnapshotVersion = 1;
  if (isRecord(result.run)) snapshot.run = compactRun(result.run, item);
  else if (result.run === null) snapshot.run = null;
  if (isRecord(result.thread)) snapshot.thread = copyScalars(result.thread, THREAD_FIELDS);
  if (Array.isArray(result.events)) snapshot.events = compactEvents(result, item);
  return snapshot;
}

function compactRun(run, item) {
  const snapshot = copyScalars(run, RUN_FIELDS);
  if (Array.isArray(run.events)) snapshot.events = compactEvents(run, item);
  return snapshot;
}

function compactEvents(run, item) {
  const evidence = new Map();
  for (const event of run.events) {
    if (!isRecord(event) || !EVENT_TYPES.has(event.type)) continue;
    // Do not retain another task's ACK as this task's persisted evidence.
    if (event.taskId && event.taskId !== run.id) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const submissionId = String(item?.submissionId ?? '').trim();
    if (submissionId) {
      if (event.type === 'task.guidance.accepted'
        && payload.submissionId !== submissionId) continue;
    }
    if (event.type === 'task.guidance.accepted' && !payload.turnId) continue;
    const saved = copyScalars(event, ['id', 'taskId', 'type', 'createdAt']);
    saved.payload = copyScalars(payload, [
      'submissionId', 'threadId', 'sessionId', 'turnId', 'expectedTurnId', 'deliveryAttempted'
    ]);
    if (isRecord(payload.turn)) saved.payload.turn = copyScalars(payload.turn, ['id', 'status']);
    if (isRecord(payload.thread)) saved.payload.thread = copyScalars(payload.thread, ['id']);
    // One latest piece of evidence of each kind suffices for this entry. Without
    // an item identity (e.g. an offline inspection), keep each submission's ACK.
    const key = item ? event.type : `${event.type}\0${payload.submissionId ?? ''}`;
    // A later malformed start/steer must not erase an earlier valid ACK. Keep
    // nonmatching start/steer as attempt evidence: the run's primary submission
    // identity prevents those events from acknowledging another queued input.
    const previous = evidence.get(key);
    if (previous && evidenceStrength(previous, run, submissionId)
      > evidenceStrength(saved, run, submissionId)) continue;
    evidence.set(key, saved);
  }
  return [...evidence.values()];
}

function evidenceStrength(event, run, submissionId) {
  if (event.type.endsWith('turn.started')) {
    return event.payload?.turn?.id && (!submissionId || run.submissionId === submissionId) ? 1 : 0;
  }
  if (event.type.endsWith('turn.steered')) {
    return event.payload?.turnId && (!submissionId || event.payload.submissionId === submissionId) ? 1 : 0;
  }
  return 0;
}

function copyScalars(source, fields) {
  const target = {};
  for (const field of fields) {
    const value = source[field];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      target[field] = value;
    }
  }
  return target;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
