import { CodexRuntimeSession, CodexRuntimeSnapshot, CodexSessionSummary } from '../model/BridgeModels';

export class SessionRuntimeStore {
  private currentSnapshot: CodexRuntimeSnapshot | null = null;
  private retiredEpochs: string[] = [];

  apply(snapshot: CodexRuntimeSnapshot): boolean {
    if (this.currentSnapshot === null) {
      this.currentSnapshot = snapshot;
      return true;
    }
    const current = this.currentSnapshot;
    if (snapshot.epoch !== current.epoch) {
      if (this.retiredEpochs.indexOf(snapshot.epoch) >= 0) {
        return false;
      }
      this.retiredEpochs = [...this.retiredEpochs, current.epoch].slice(-8);
      this.currentSnapshot = snapshot;
      return true;
    }
    if (snapshot.revision < current.revision) {
      return false;
    }
    if (snapshot.revision === current.revision
      && SessionRuntimeStore.isoTime(snapshot.generatedAt) < SessionRuntimeStore.isoTime(current.generatedAt)) {
      return false;
    }
    this.currentSnapshot = snapshot;
    return true;
  }

  snapshot(): CodexRuntimeSnapshot | null {
    return this.currentSnapshot;
  }

  markStale(): void {
    if (this.currentSnapshot !== null) {
      this.currentSnapshot.stale = true;
    }
  }

  mergeSessions(sessions: CodexSessionSummary[]): CodexSessionSummary[] {
    if (this.currentSnapshot === null) {
      return sessions;
    }
    const legacyById: Record<string, CodexSessionSummary> = {};
    sessions.forEach((session: CodexSessionSummary) => {
      legacyById[session.id] = session;
    });
    const merged: CodexSessionSummary[] = this.currentSnapshot.sessions.map((runtime: CodexRuntimeSession) => {
      const legacy = legacyById[runtime.threadId];
      if (this.currentSnapshot?.stale === true && legacy !== undefined) {
        return legacy;
      }
      const summary: CodexSessionSummary = {
        id: runtime.threadId,
        title: runtime.title,
        updatedAt: runtime.updatedAt,
        relativeTime: runtime.relativeTime,
        projectRoot: runtime.projectRoot,
        projectLabel: runtime.projectLabel,
        sidebarSection: runtime.sidebarSection,
        source: legacy?.source ?? runtime.source,
        pinned: runtime.pinned,
        detailAvailable: runtime.detailAvailable
      };
      // A failed runtime read leaves list metadata cached, not authoritative activity.
      if (this.currentSnapshot?.stale !== true) {
        summary.activitySource = runtime.source;
        summary.activityStatus = runtime.state;
        summary.activityUpdatedAt = runtime.stateUpdatedAt;
        summary.runtimeState = runtime.state;
        summary.runtimeSource = runtime.source;
        summary.runtimeUpdatedAt = runtime.stateUpdatedAt;
        summary.activeTurnId = runtime.activeTurnId;
        summary.canInterrupt = runtime.canInterrupt;
        summary.terminalReason = runtime.terminalReason;
        summary.lastVisibleRole = runtime.lastVisibleRole;
      }
      return summary;
    });
    const runtimeIds = this.currentSnapshot.sessions.map((session: CodexRuntimeSession) => session.threadId);
    sessions.forEach((session: CodexSessionSummary) => {
      if (runtimeIds.indexOf(session.id) < 0) {
        merged.push(session);
      }
    });
    return merged;
  }

  activeSessionIds(): string[] {
    if (this.currentSnapshot === null || this.currentSnapshot.stale === true) {
      return [];
    }
    return this.currentSnapshot.sessions
      .filter((session: CodexRuntimeSession) => SessionRuntimeStore.isActiveState(session.state))
      .map((session: CodexRuntimeSession) => session.threadId);
  }

  static isActiveState(state: string): boolean {
    return state === 'queued'
      || state === 'running'
      || state === 'waiting_approval'
      || state === 'waiting_input'
      || state === 'recovering';
  }

  private static isoTime(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
