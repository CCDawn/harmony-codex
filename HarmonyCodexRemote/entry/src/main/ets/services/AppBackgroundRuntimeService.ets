import { common, wantAgent } from '@kit.AbilityKit';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';

export interface AppBackgroundRuntimeSnapshot {
  running: boolean;
  startedAt: number;
  lastEnsuredAt: number;
  source: string;
  detail: string;
  taskId: number | null;
  mode: string;
  suspended: boolean | null;
}

const BACKGROUND_STATE_STORAGE_KEY = 'codexRemoteBackgroundRuntimeState';
const BACKGROUND_DETAIL_STORAGE_KEY = 'codexRemoteBackgroundRuntimeDetail';
const FOREGROUND_STORAGE_KEY = 'codexRemoteAppForeground';
const BACKGROUND_ABILITY = 'EntryAbility';
const BACKGROUND_BUNDLE = 'com.codex.remote.app';

interface PendingTaskCancellation {
  id: number;
  foregroundEpoch: number;
}

/** Owns only this application's data-transfer continuous task, never the voice task. */
export class AppBackgroundRuntimeService {
  private static running: boolean = false;
  private static startedAt: number = 0;
  private static lastEnsuredAt: number = 0;
  private static lastSource: string = '';
  private static detail: string = 'not_started';
  private static taskId: number | null = null;
  private static verifiedMode: string = '';
  private static verifiedSuspended: boolean | null = null;
  private static startPromise: Promise<AppBackgroundRuntimeSnapshot> | null = null;
  private static starting: boolean = false;
  private static pendingCancellations: PendingTaskCancellation[] = [];
  private static cancelListenerRegistered: boolean = false;
  private static awaitForeground: boolean = false;
  private static foregroundEpoch: number = 0;
  private static recoveryEpoch: number = 0;
  private static leaseForegroundEpoch: number = 0;
  private static readonly cancelListener = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    if (info === null || typeof info.id !== 'number') return;
    if (AppBackgroundRuntimeService.taskId === null) {
      // As in VoiceBackgroundTaskService, the callback may arrive before the
      // system returns the allocated id. Compare it only after id assignment.
      if (AppBackgroundRuntimeService.starting) AppBackgroundRuntimeService.pendingCancellations.push({
        id: info.id, foregroundEpoch: AppBackgroundRuntimeService.foregroundEpoch
      });
      return;
    }
    AppBackgroundRuntimeService.markCancelled(info.id);
  };

  private static markCancelled(id: number, epoch: number = AppBackgroundRuntimeService.foregroundEpoch): void {
    if (id !== AppBackgroundRuntimeService.taskId) return;
    AppBackgroundRuntimeService.taskId = null;
    AppBackgroundRuntimeService.running = false;
    AppBackgroundRuntimeService.verifiedMode = '';
    AppBackgroundRuntimeService.verifiedSuspended = null;
    AppBackgroundRuntimeService.awaitForeground = true;
    AppBackgroundRuntimeService.recoveryEpoch = epoch;
    AppBackgroundRuntimeService.detail = 'continuous_task_cancelled';
    AppBackgroundRuntimeService.publishState();
  }

  static async ensureRunning(
    context: common.UIAbilityContext,
    source: string
  ): Promise<AppBackgroundRuntimeSnapshot> {
    if (source === 'ability_foreground') AppBackgroundRuntimeService.foregroundEpoch += 1;
    AppBackgroundRuntimeService.lastEnsuredAt = Date.now();
    AppBackgroundRuntimeService.lastSource = source;
    if (AppBackgroundRuntimeService.startPromise !== null) return await AppBackgroundRuntimeService.startPromise;
    const operation = AppBackgroundRuntimeService.ensureLatestForeground(context);
    AppBackgroundRuntimeService.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (AppBackgroundRuntimeService.startPromise === operation) AppBackgroundRuntimeService.startPromise = null;
    }
  }

  private static async ensureLatestForeground(context: common.UIAbilityContext): Promise<AppBackgroundRuntimeSnapshot> {
    // A foreground request may join a query that cancellation invalidates.
    // Consume that newer lifecycle event before releasing the shared operation.
    // Each repeat requires a new foreground event; background cancellation alone
    // never starts another task.
    while (true) {
      const epoch = AppBackgroundRuntimeService.foregroundEpoch;
      const state = await AppBackgroundRuntimeService.ensure(context);
      if (state.running || AppStorage.get<boolean>(FOREGROUND_STORAGE_KEY) !== true
        || AppBackgroundRuntimeService.foregroundEpoch <= epoch
        || AppBackgroundRuntimeService.foregroundEpoch <= AppBackgroundRuntimeService.recoveryEpoch) return state;
    }
  }

  static snapshot(): AppBackgroundRuntimeSnapshot {
    return {
      running: AppBackgroundRuntimeService.running,
      startedAt: AppBackgroundRuntimeService.startedAt,
      lastEnsuredAt: AppBackgroundRuntimeService.lastEnsuredAt,
      source: AppBackgroundRuntimeService.lastSource,
      detail: AppBackgroundRuntimeService.detail,
      taskId: AppBackgroundRuntimeService.taskId,
      mode: AppBackgroundRuntimeService.verifiedMode,
      suspended: AppBackgroundRuntimeService.verifiedSuspended
    };
  }

  private static async ensure(
    context: common.UIAbilityContext
  ): Promise<AppBackgroundRuntimeSnapshot> {
    try {
      AppBackgroundRuntimeService.registerCancelListener();
      const priorId = AppBackgroundRuntimeService.taskId;
      const tasks = await backgroundTaskManager.getAllContinuousTasks(context, true);
      // A cancellation callback can run while the query is in flight.
      if (priorId !== AppBackgroundRuntimeService.taskId) return AppBackgroundRuntimeService.snapshot();
      if (priorId !== null) {
        const matches = tasks.filter((task: backgroundTaskManager.ContinuousTaskInfo) => task.continuousTaskId === priorId);
        if (matches.length > 0) {
          const current = matches[0];
          if (matches.length !== 1 || !AppBackgroundRuntimeService.isOwnMode(current)
            || typeof current.suspendState !== 'boolean') {
            // An id exists but its mode, ability or status cannot be verified.
            // Keep ownership and never allocate a competing task.
            AppBackgroundRuntimeService.running = false;
            AppBackgroundRuntimeService.verifiedMode = '';
            AppBackgroundRuntimeService.verifiedSuspended = null;
            AppBackgroundRuntimeService.detail = 'continuous_task_identity_unconfirmed';
            AppBackgroundRuntimeService.publishState();
            return AppBackgroundRuntimeService.snapshot();
          }
          AppBackgroundRuntimeService.verifiedMode = 'dataTransfer';
          AppBackgroundRuntimeService.verifiedSuspended = current.suspendState;
          AppBackgroundRuntimeService.running = current.suspendState === false;
          AppBackgroundRuntimeService.detail = AppBackgroundRuntimeService.running
            ? 'data_transfer_active' : 'continuous_task_suspended';
          if (AppBackgroundRuntimeService.running) {
            AppBackgroundRuntimeService.leaseForegroundEpoch = AppBackgroundRuntimeService.foregroundEpoch;
          }
          AppBackgroundRuntimeService.publishState();
          return AppBackgroundRuntimeService.snapshot();
        }
        AppBackgroundRuntimeService.taskId = null;
        AppBackgroundRuntimeService.running = false;
        AppBackgroundRuntimeService.verifiedMode = '';
        AppBackgroundRuntimeService.verifiedSuspended = null;
        AppBackgroundRuntimeService.awaitForeground = true;
        AppBackgroundRuntimeService.recoveryEpoch = AppBackgroundRuntimeService.leaseForegroundEpoch;
        AppBackgroundRuntimeService.detail = 'continuous_task_missing';
        AppBackgroundRuntimeService.publishState();
      }
      // Never adopt or replace another unowned task, even one with our mode.
      if (tasks.some((task: backgroundTaskManager.ContinuousTaskInfo) => AppBackgroundRuntimeService.isOwnMode(task))) {
        AppBackgroundRuntimeService.running = false;
        AppBackgroundRuntimeService.detail = 'unowned_continuous_task';
        AppBackgroundRuntimeService.publishState();
        return AppBackgroundRuntimeService.snapshot();
      }
      const foreground = AppStorage.get<boolean>(FOREGROUND_STORAGE_KEY) === true;
      if (foreground && AppBackgroundRuntimeService.foregroundEpoch > AppBackgroundRuntimeService.recoveryEpoch) {
        AppBackgroundRuntimeService.awaitForeground = false;
      }
      if (!foreground || AppBackgroundRuntimeService.awaitForeground) {
        AppBackgroundRuntimeService.running = false;
        AppBackgroundRuntimeService.detail = 'awaiting_foreground';
        AppBackgroundRuntimeService.publishState();
        return AppBackgroundRuntimeService.snapshot();
      }
      return await AppBackgroundRuntimeService.start(context);
    } catch (error) {
      AppBackgroundRuntimeService.running = false;
      AppBackgroundRuntimeService.verifiedMode = '';
      AppBackgroundRuntimeService.verifiedSuspended = null;
      AppBackgroundRuntimeService.detail = AppBackgroundRuntimeService.errorText(error);
      AppBackgroundRuntimeService.publishState();
      throw new Error(AppBackgroundRuntimeService.detail);
    }
  }

  private static async start(context: common.UIAbilityContext): Promise<AppBackgroundRuntimeSnapshot> {
    const request = new backgroundTaskManager.ContinuousTaskRequest();
    request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER];
    request.backgroundTaskSubmodes = [backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_LIVE_VIEW_NOTIFICATION];
    if (!request.isModeSupported()) throw new Error('data_transfer_unsupported');
    request.wantAgent = await wantAgent.getWantAgent({
      wants: [{ bundleName: BACKGROUND_BUNDLE, abilityName: BACKGROUND_ABILITY }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 11078,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
    // Foreground can change while obtaining the WantAgent.
    if (AppStorage.get<boolean>(FOREGROUND_STORAGE_KEY) !== true || AppBackgroundRuntimeService.awaitForeground) {
      AppBackgroundRuntimeService.running = false;
      AppBackgroundRuntimeService.detail = 'awaiting_foreground';
      AppBackgroundRuntimeService.publishState();
      return AppBackgroundRuntimeService.snapshot();
    }
    AppBackgroundRuntimeService.pendingCancellations = [];
    AppBackgroundRuntimeService.starting = true;
    let id: number | null = null;
    try {
      const notification = await backgroundTaskManager.startBackgroundRunning(context, request);
      const returnedId = notification.continuousTaskId ?? request.continuousTaskId;
      if (typeof returnedId !== 'number' || !Number.isInteger(returnedId) || returnedId < 0) {
        throw new Error('continuous_task_id_missing');
      }
      id = returnedId;
      AppBackgroundRuntimeService.taskId = id;
      // The allocation belongs to this foreground epoch even if the system's
      // first verification query is absent or fails. Never allocate twice in
      // that same epoch while the allocated id is unconfirmed.
      AppBackgroundRuntimeService.leaseForegroundEpoch = AppBackgroundRuntimeService.foregroundEpoch;
      const cancellation = AppBackgroundRuntimeService.pendingCancellations.find(
        (event: PendingTaskCancellation) => event.id === id
      );
      if (cancellation !== undefined) {
        AppBackgroundRuntimeService.markCancelled(id, cancellation.foregroundEpoch);
        return AppBackgroundRuntimeService.snapshot();
      }
    } finally {
      AppBackgroundRuntimeService.starting = false;
      AppBackgroundRuntimeService.pendingCancellations = [];
    }
    // Starting succeeded, but do not report a lease until the OS confirms the
    // exact id, mode, ability and non-suspended state. Retain id on query
    // failure or an absent first read so a subsequent ensure cannot duplicate it.
    const tasks = await backgroundTaskManager.getAllContinuousTasks(context, true);
    if (id !== AppBackgroundRuntimeService.taskId) return AppBackgroundRuntimeService.snapshot();
    const matches = tasks.filter((task: backgroundTaskManager.ContinuousTaskInfo) => task.continuousTaskId === id);
    const current = matches.length === 1 ? matches[0] : undefined;
    const verified = current !== undefined && AppBackgroundRuntimeService.isOwnMode(current)
      && typeof current.suspendState === 'boolean';
    AppBackgroundRuntimeService.verifiedMode = verified ? 'dataTransfer' : '';
    AppBackgroundRuntimeService.verifiedSuspended = verified && current !== undefined ? current.suspendState : null;
    AppBackgroundRuntimeService.running = verified && current?.suspendState === false;
    AppBackgroundRuntimeService.startedAt = Date.now();
    if (AppBackgroundRuntimeService.running) {
      AppBackgroundRuntimeService.leaseForegroundEpoch = AppBackgroundRuntimeService.foregroundEpoch;
    }
    AppBackgroundRuntimeService.detail = AppBackgroundRuntimeService.running ? 'data_transfer_active'
      : !verified ? 'continuous_task_unconfirmed' : 'continuous_task_suspended';
    AppBackgroundRuntimeService.publishState();
    return AppBackgroundRuntimeService.snapshot();
  }

  private static isOwnMode(task: backgroundTaskManager.ContinuousTaskInfo): boolean {
    if (task.abilityName !== BACKGROUND_ABILITY || (task.bundleName && task.bundleName !== BACKGROUND_BUNDLE)
      || !Array.isArray(task.backgroundModes)) return false;
    return task.backgroundModes.includes('dataTransfer');
  }

  private static registerCancelListener(): void {
    if (AppBackgroundRuntimeService.cancelListenerRegistered) return;
    try {
      backgroundTaskManager.on('continuousTaskCancel', AppBackgroundRuntimeService.cancelListener);
      AppBackgroundRuntimeService.cancelListenerRegistered = true;
    } catch (error) {
      try { backgroundTaskManager.off('continuousTaskCancel', AppBackgroundRuntimeService.cancelListener); } catch (_) {}
      throw (error as Error);
    }
  }

  private static publishState(): void {
    AppStorage.setOrCreate<string>(
      BACKGROUND_STATE_STORAGE_KEY,
      AppBackgroundRuntimeService.running ? 'running' : 'stopped'
    );
    AppStorage.setOrCreate<string>(BACKGROUND_DETAIL_STORAGE_KEY, AppBackgroundRuntimeService.detail);
  }

  private static errorText(error: Object): string {
    const typed = error as Error;
    if (typed && typeof typed.message === 'string' && typed.message.length > 0) return typed.message;
    return String(error);
  }
}
