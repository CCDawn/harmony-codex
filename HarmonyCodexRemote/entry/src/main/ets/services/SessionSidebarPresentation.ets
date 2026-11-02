import { CodexSessionSummary } from '../model/BridgeModels';

export function reconcileSessionSidebar(
  previous: CodexSessionSummary[],
  latest: CodexSessionSummary[],
  keepOrder: boolean
): CodexSessionSummary[] {
  const previousById = new Map<string, CodexSessionSummary>();
  previous.forEach((session: CodexSessionSummary) => {
    previousById.set(session.id, session);
  });

  const latestById = new Map<string, CodexSessionSummary>();
  const latestOrder: string[] = [];
  latest.forEach((session: CodexSessionSummary) => {
    if (!latestById.has(session.id)) {
      latestOrder.push(session.id);
    }
    latestById.set(session.id, session);
  });

  const orderedIds: string[] = [];
  const orderedIdSet: Set<string> = new Set<string>();
  if (keepOrder) {
    previous.forEach((session: CodexSessionSummary) => {
      if (latestById.has(session.id) && !orderedIdSet.has(session.id)) {
        orderedIds.push(session.id);
        orderedIdSet.add(session.id);
      }
    });
    latestOrder.forEach((id: string) => {
      if (!previousById.has(id)) {
        orderedIds.push(id);
      }
    });
  } else {
    latestOrder.forEach((id: string) => {
      orderedIds.push(id);
    });
  }

  const reconciled: CodexSessionSummary[] = [];
  orderedIds.forEach((id: string) => {
    const latestSession = latestById.get(id);
    if (latestSession === undefined) {
      return;
    }

    const previousSession = previousById.get(id);
    if (previousSession !== undefined && JSON.stringify(previousSession) === JSON.stringify(latestSession)) {
      reconciled.push(previousSession);
    } else {
      reconciled.push(latestSession);
    }
  });

  if (reconciled.length === previous.length) {
    let sameReferences = true;
    for (let index = 0; index < reconciled.length; index++) {
      if (reconciled[index] !== previous[index]) {
        sameReferences = false;
        break;
      }
    }
    if (sameReferences) {
      return previous;
    }
  }

  return reconciled;
}
