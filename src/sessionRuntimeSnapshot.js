import { randomUUID } from 'node:crypto';

const ACTIVE_STATES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'recovering'
]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted']);

export class SessionRuntimeSnapshotTracker {
  constructor(options = {}) {
    this.epoch = String(options.epoch ?? randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.revision = 0;
    this.lastFingerprint = '';
  }

  build({ sessions = [], activeRuns = [], officialStates = [], stale = false } = {}) {
    const activeByThread = latestActiveRunByThread(activeRuns);
    const officialByThread = runtimeStateByThread(officialStates);
    const decisions = [];
    const runtimeSessions = sessions.map((session) => {
      const threadId = String(session?.id ?? session?.threadId ?? '').trim();
      const activeRun = activeByThread.get(threadId) ?? null;
      const officialState = officialByThread.get(threadId) ?? null;
      const built = runtimeSession(session, activeRun, officialState, this.epoch);
      decisions.push(built.decision);
      return built.session;
    });
    const fingerprint = JSON.stringify(runtimeSessions);
    if (this.revision === 0 || fingerprint !== this.lastFingerprint) {
      this.revision += 1;
      this.lastFingerprint = fingerprint;
    }
    return {
      schemaVersion: 1,
      epoch: this.epoch,
      revision: this.revision,
      generatedAt: this.now(),
      stale: stale === true,
      sessions: runtimeSessions,
      decisions
    };
  }
}

export function normalizeRuntimeSnapshotState(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'processing') {
    return 'running';
  }
  if (normalized === 'complete' || normalized === 'done') {
    return 'completed';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'aborted') {
    return 'interrupted';
  }
  if (ACTIVE_STATES.has(normalized) || TERMINAL_STATES.has(normalized) || normalized === 'idle') {
    return normalized;
  }
  return 'idle';
}

function runtimeSession(session, activeRun, officialState, epoch) {
  const threadId = String(session?.id ?? session?.threadId ?? '').trim();
  const projectedState = normalizeRuntimeSnapshotState(session?.runtimeState ?? session?.activityStatus);
  const projectedTurnId = String(session?.activeTurnId ?? session?.activityTurnId ?? '').trim();
  const activeTurnId = activeRun
    ? String(activeRun.turnId ?? activeRun.activeCodexTurnId ?? '').trim()
    : officialState
      ? String(officialState.activeTurnId ?? '').trim()
      : projectedTurnId;
  let stateUpdatedAt = String(
    activeRun?.updatedAt
      ?? officialState?.updatedAt
      ?? session?.runtimeUpdatedAt
      ?? session?.activityUpdatedAt
      ?? session?.updatedAt
      ?? ''
  );
  let state;
  let source;
  let reason;
  let runId = null;
  let generation = null;

  if (activeRun) {
    const runState = normalizeRuntimeSnapshotState(activeRun.status ?? activeRun.runtime?.state);
    const runTurnId = String(activeRun.turnId ?? activeRun.activeCodexTurnId ?? '').trim();
    const officialRunState = normalizeRuntimeSnapshotState(officialState?.state ?? officialState?.status);
    const officialTurnId = String(officialState?.activeTurnId ?? officialState?.turnId ?? '').trim();
    const officialTerminalForRun = Boolean(
      officialState
      && runTurnId
      && officialTurnId === runTurnId
      && TERMINAL_STATES.has(officialRunState)
    );
    runId = String(activeRun.id ?? '');
    if (officialTerminalForRun) {
      state = officialRunState;
      reason = 'official_terminal_sticky';
      generation = numberOrNull(officialState.generation);
      source = String(officialState.source ?? 'desktop-app-server');
      stateUpdatedAt = String(officialState.updatedAt ?? stateUpdatedAt);
    } else if (
      runTurnId
      && projectedTurnId === runTurnId
      && TERMINAL_STATES.has(projectedState)
      && !TERMINAL_STATES.has(runState)
    ) {
      // The official projection is terminal for the exact same turn the run
      // claims: terminal is sticky and the stale run must not override it.
      state = projectedState;
      reason = 'official_terminal_sticky';
      generation = numberOrNull(activeRun.generation);
      source = String(session?.runtimeSource ?? session?.activitySource ?? session?.source ?? 'unknown');
    } else {
      state = runState;
      generation = numberOrNull(activeRun.generation);
      reason = runTurnId && projectedTurnId && runTurnId !== projectedTurnId
        ? 'newer_turn_active'
        : 'active_run';
      source = 'app-server-run';
    }
  } else if (officialState) {
    state = normalizeRuntimeSnapshotState(officialState.state ?? officialState.status);
    reason = 'official_state';
    generation = numberOrNull(officialState.generation);
    source = String(officialState.source ?? 'desktop-app-server');
  } else {
    state = projectedState;
    reason = 'session_projected';
    source = String(session?.runtimeSource ?? session?.activitySource ?? session?.source ?? 'unknown');
  }

  const decision = {
    threadId,
    runId,
    turnId: activeTurnId,
    fromState: projectedState,
    toState: state,
    generation,
    epoch,
    reason
  };
  return {
    session: {
      threadId,
      title: String(session?.title ?? '未命名会话'),
      projectRoot: String(session?.projectRoot ?? ''),
      projectLabel: String(session?.projectLabel ?? '未归类'),
      sidebarSection: String(session?.sidebarSection ?? 'recent'),
      pinned: session?.pinned === true,
      updatedAt: String(session?.updatedAt ?? stateUpdatedAt),
      relativeTime: String(session?.relativeTime ?? ''),
      state,
      stateUpdatedAt,
      source,
      activeTurnId,
      canInterrupt: activeRun
        ? ACTIVE_STATES.has(state)
        : officialState
          ? officialState.canInterrupt === true || ACTIVE_STATES.has(state)
          : session?.canInterrupt === true,
      terminalReason: TERMINAL_STATES.has(state)
        ? String(officialState?.terminalReason ?? session?.terminalReason ?? state)
        : '',
      lastVisibleRole: String(session?.lastVisibleRole ?? ''),
      nativeState: String(officialState?.nativeState ?? session?.nativeState ?? ''),
      detailAvailable: session?.detailAvailable !== false
    },
    decision
  };
}

function runtimeStateByThread(states) {
  const byThread = new Map();
  for (const state of states) {
    const threadId = String(state?.threadId ?? state?.id ?? '').trim();
    if (threadId) {
      byThread.set(threadId, state);
    }
  }
  return byThread;
}

function latestActiveRunByThread(runs) {
  const byThread = new Map();
  for (const run of runs) {
    const state = normalizeRuntimeSnapshotState(run?.status ?? run?.runtime?.state);
    if (!ACTIVE_STATES.has(state)) {
      continue;
    }
    const threadId = String(run?.threadId ?? run?.codexSessionId ?? '').trim();
    if (!threadId) {
      continue;
    }
    const current = byThread.get(threadId);
    if (!current || isNewerRun(run, current)) {
      byThread.set(threadId, run);
    }
  }
  return byThread;
}

function isNewerRun(candidate, current) {
  const candidateMs = Date.parse(String(candidate?.updatedAt ?? candidate?.createdAt ?? ''));
  const currentMs = Date.parse(String(current?.updatedAt ?? current?.createdAt ?? ''));
  if (Number.isFinite(candidateMs) && Number.isFinite(currentMs) && candidateMs !== currentMs) {
    return candidateMs > currentMs;
  }
  return String(candidate?.id ?? '') > String(current?.id ?? '');
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
