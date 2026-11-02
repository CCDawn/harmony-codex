// Persisted turn pages can lag official lifecycle notifications. The mounted
// manager's latest canonical/optimistic turn is another official source, not a
// bridge inference. Compare real start times before selecting between sources.
export function nativeContinueLatestTurn(snapshot) {
  const thread = snapshot?.thread ?? snapshot;
  if (thread?.continueSourceAmbiguous) return null;
  const persisted = thread?.turns?.at(-1) ?? null;
  const live = thread?.latestTurn ?? null;
  if (!persisted) return live;
  if (!live) return persisted;
  const identity = turn => turn?.id ?? turn?.turnId;
  if (identity(persisted) === identity(live)) {
    const terminal = status => ['completed', 'interrupted', 'failed'].includes(status);
    // A terminal boundary cannot be undone by an older cached inProgress copy.
    if (terminal(persisted.status) && !terminal(live.status)) return persisted;
    return { ...persisted, ...live, error: live.error ?? persisted.error };
  }
  const startedAt = turn => {
    if (Number.isFinite(turn?.turnStartedAtMs)) return turn.turnStartedAtMs;
    const value = turn?.startedAt;
    if (value === undefined || value === null || value === '') return NaN;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric > 10_000_000_000 ? numeric : numeric * 1000 : Date.parse(value);
  };
  const persistedAt = startedAt(persisted), liveAt = startedAt(live);
  // Different identities without an ordering proof must never enable continue
  // for an older turn simply because one source is temporarily incomplete.
  if (!Number.isFinite(persistedAt) || !Number.isFinite(liveAt) || persistedAt === liveAt) return null;
  return liveAt > persistedAt ? live : persisted;
}

// The lease injects this policy and the source chooser into its renderer so the
// final pre-write check uses exactly the same rules as HTTP and SSE status.
export function nativeContinueStatus(snapshot, threadId) {
  const thread = snapshot?.thread ?? snapshot;
  const valid = thread && thread.id === threadId && Array.isArray(thread.turns);
  const turn = valid ? nativeContinueLatestTurn(thread) : null;
  const turnId = String(turn?.id ?? turn?.turnId ?? '');
  const runtime = thread?.status?.type ?? thread?.threadRuntimeStatus?.type ?? thread?.status;
  const busy = runtime === 'active' || turn?.status === 'inProgress'
    || thread?.hasPendingTurnSubmission === true
    || thread?.unconfirmedTurnSubmissions?.some(value => value?.terminal !== true) === true;
  const state = busy ? 'active' : ['interrupted', 'failed', 'completed'].includes(turn?.status)
    ? turn.status : runtime === 'idle' ? 'idle' : 'unknown';
  const result = reason => ({ threadId, turnId, canContinue: false, reason, state });
  if (!valid) return result('unavailable');
  if (busy) return result('active');
  if (!turnId) return result(thread.latestTurn || thread.turns.length ? 'unavailable' : 'no_turn');
  if (thread.goal != null || thread.threadGoal != null) return result('goal_present');
  if (thread.continueBlockedReason) return result(thread.continueBlockedReason);
  // Missing goal information is not evidence that a goal is absent.
  if (!Object.hasOwn(thread, 'goal') && !Object.hasOwn(thread, 'threadGoal')) return result('unavailable');
  if (turn.status === 'interrupted') return { ...result('interrupted'), canContinue: true };
  if (turn.status !== 'failed' || !turn.error) return result('not_retryable');
  const { codexErrorInfo: info, message = '' } = turn.error;
  const retryable = info === 'serverOverloaded' || info === 'internalServerError'
    || (typeof info === 'object' && info !== null && ['httpConnectionFailed', 'responseStreamConnectionFailed',
      'responseStreamDisconnected', 'responseTooManyFailedAttempts'].some(key => Object.hasOwn(info, key)))
    || (info === 'other'
      && !/\b(?:usage|quota|rate[\s_-]+limit(?:s|ed|ing)?|billing|credits?)\b/i.test(message)
      && /\bmodel\s+is\s+temporarily\s+unavailable\b|^stream\s+disconnected\s+before\s+completion:\s*we['’]re\s+currently\s+processing\s+too\s+many\s+requests\b/i.test(message));
  return { ...result(retryable ? 'retryable_error' : 'not_retryable'), canContinue: retryable };
}
