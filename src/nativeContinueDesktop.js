import { nativeContinueLatestTurn, nativeContinueStatus } from './nativeContinueEligibility.js';

// Runs inside DesktopInteractionClient's verified mounted manager lease. It
// intentionally bypasses question-state initialization and never creates a host.
export const NATIVE_CONTINUE_DESKTOP = String.raw`
if (params.operation.startsWith('native-continue')) {
  const nativeContinueLatestTurn = ${nativeContinueLatestTurn.toString()};
  const statusFor = ${nativeContinueStatus.toString()};
  const manager = lease.manager;
  const unavailable = () => Object.assign(new Error(), { code: 'NATIVE_CONTINUE_UNAVAILABLE' });
  if (typeof manager.sendRequest !== 'function') throw unavailable();
  const assertLease = async () => {
    const current = await findLegacyOwner();
    if (!current || current.owner !== lease.owner || current.binding !== lease.binding
      || current.manager !== manager || current.client !== lease.client) throw unavailable();
  };
  const readContext = async () => {
    const [metadata, goalRead] = await boundedRead(Promise.all([
      manager.sendRequest('thread/read', { threadId: params.threadId, includeTurns: false }),
      Promise.resolve().then(() => manager.sendRequest('thread/goal/get', { threadId: params.threadId }))
        .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
    ]), 5000);
    if (metadata?.thread?.id !== params.threadId) throw unavailable();
    let goal;
    if (goalRead.ok) {
      goal = goalRead.value;
      if (!goal || !Object.hasOwn(goal, 'goal')) throw unavailable();
    } else {
      const runtime = metadata.thread.status?.type ?? metadata.thread.status;
      const message = String(goalRead.error?.message ?? '').trim();
      // The goal endpoint requires a loaded runtime even though metadata and
      // persisted turn pages are readable. Preserve that known status without
      // claiming an absent goal or resuming a conversation from a GET.
      if (runtime !== 'notLoaded' || (message !== 'thread not found'
        && message !== 'thread not found: ' + params.threadId)) throw goalRead.error;
    }
    const current = await boundedRead(Promise.resolve().then(() => manager.getConversation(params.threadId)), 5000);
    if (current?.id && current.id !== params.threadId) throw unavailable();
    const history = current?.turnHistory?.kind === 'canonical' ? current.turnHistory.history : null;
    const canonical = history?.islands?.flatMap(island => island.entries.map(entry => history.entitiesByKey[entry.value])) ?? [];
    const turns = new Map();
    for (const turn of [...canonical, ...(current?.turns ?? [])]) {
      const id = turn?.turnId ?? turn?.id;
      if (id) turns.set(id, { ...turns.get(id), ...turn, id });
    }
    const latest = [...turns.values()].at(-1);
    // Return only status/identity metadata; the renderer keeps transcript items.
    const latestTurn = latest ? { id: latest.id, status: latest.status, error: latest.error,
      startedAt: latest.startedAt ?? (Number.isFinite(latest.turnStartedAtMs) ? latest.turnStartedAtMs / 1000 : undefined),
      updatedAt: latest.updatedAt } : null;
    return { id: params.threadId, status: current?.threadRuntimeStatus?.type === 'active'
      ? { type: 'active' } : metadata.thread.status,
      ...(goal ? { goal: goal.goal } : {}), latestTurn,
      hasPendingTurnSubmission: current?.unconfirmedTurnSubmissions?.some(value => value.terminal !== true) === true };
  };
  const readSnapshot = async () => {
    const [context, page] = await Promise.all([readContext(), boundedRead(Promise.resolve().then(() =>
      manager.sendRequest('thread/turns/list', { threadId: params.threadId, limit: 1, itemsView: 'full' })), 5000)]);
    if (!Array.isArray(page?.data)) throw unavailable();
    const thread = { ...context, turns: page.data.slice(0, 1).map(turn => ({
      id: turn.id, status: turn.status, error: turn.error, startedAt: turn.startedAt, updatedAt: turn.updatedAt
    })) };
    const latest = nativeContinueLatestTurn(thread);
    return { thread: { ...thread, turns: latest ? [latest] : [],
      ...(!latest && (thread.turns.length || context.latestTurn) ? { continueSourceAmbiguous: true } : {}) } };
  };
  if (params.operation === 'native-continue-context') {
    const context = await readContext();
    await assertLease();
    return context;
  }
  let snapshot = await readSnapshot();
  await assertLease();
  if (params.operation === 'native-continue-status') return snapshot;
  let status = statusFor(snapshot, params.threadId);
  const rejected = reason => ({ ...status, canContinue: false, reason, state: 'rejected', active: status.state === 'active' });
  if (status.turnId !== params.expectedTurnId) return rejected('stale_turn');
  if (!status.canContinue) return rejected(status.reason);
  if (typeof manager.startEmptyTurn !== 'function' || typeof manager.getFollowUpContext !== 'function'
    || typeof discovery.continueContext !== 'function') throw unavailable();
  let context, additionalContext;
  try {
    context = await boundedRead(Promise.resolve().then(() => manager.getFollowUpContext(params.threadId, true)), 5000);
    additionalContext = discovery.continueContext(params.threadId, context?.writingBlocks, undefined);
  // Context preparation and remote reads yield; repeat canonical identity,
  // runtime and goal checks at the last possible point before the native write.
  snapshot = await readSnapshot();
  status = statusFor(snapshot, params.threadId);
  await assertLease();
  if (status.turnId !== params.expectedTurnId) return rejected('stale_turn');
  if (!status.canContinue) return rejected(status.reason);
  nativeContinueWriteAttempted = true;
  await manager.startEmptyTurn(params.threadId, {
    turnTrigger: 'resume_interrupted_task', collaborationMode: context?.latestCollaborationMode ?? null,
    writingBlockContextPrepared: context != null, additionalContext
  });
  const observed = statusFor(await readSnapshot(), params.threadId);
  await assertLease();
  return { ...observed, canContinue: false, active: observed.state === 'active',
    state: observed.turnId && observed.turnId !== params.expectedTurnId ? 'confirmed' : 'uncertain',
    reason: observed.turnId && observed.turnId !== params.expectedTurnId ? 'started' : 'write_unconfirmed' };
  } finally {
    context?.[Symbol.dispose]?.();
  }
}
`;
