import { common, wantAgent } from '@kit.AbilityKit';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';

const VOICE_BACKGROUND_TASK_REQUEST_CODE: number = 11079;

/**
 * Owns only the continuous task created for an active voice call.
 * The app's existing data-transfer task has a separate owner and id.
 */
export class VoiceBackgroundTaskService {
  private static taskId: number | null = null;
  private static taskOwnerGeneration: number | null = null;
  private static context: common.UIAbilityContext | null = null;
  private static startPromise: Promise<number> | null = null;
  private static startGeneration: number | null = null;
  private static stopPromise: Promise<void> | null = null;
  private static cancelListener: ((info: backgroundTaskManager.ContinuousTaskCancelInfo) => void) | null = null;
  private static cancelListenerGeneration: number | null = null;
  private static cancelListenerTaskId: number | null = null;
  private static cancelListenerActive: boolean = false;
  private static cancelListenerStopping: boolean = false;
  private static cancelListenerPendingIds: number[] = [];
  private static onCancelled: ((generation: number) => void) | null = null;

  static async start(
    context: common.UIAbilityContext,
    ownerGeneration: number,
    onCancelled: (generation: number) => void = (_generation: number): void => {}
  ): Promise<number> {
    const pendingStop = VoiceBackgroundTaskService.stopPromise;
    if (pendingStop !== null) {
      await pendingStop;
    }
    if (VoiceBackgroundTaskService.taskId !== null) {
      if (VoiceBackgroundTaskService.taskOwnerGeneration === ownerGeneration) {
        VoiceBackgroundTaskService.onCancelled = onCancelled;
        return VoiceBackgroundTaskService.taskId;
      }
      const previousOwner = VoiceBackgroundTaskService.taskOwnerGeneration;
      if (previousOwner === null) {
        throw new Error('语音后台任务归属状态丢失');
      }
      await VoiceBackgroundTaskService.stop(previousOwner);
      return await VoiceBackgroundTaskService.start(context, ownerGeneration, onCancelled);
    }
    const pendingStart = VoiceBackgroundTaskService.startPromise;
    if (pendingStart !== null) {
      const pendingOwner = VoiceBackgroundTaskService.startGeneration;
      if (pendingOwner === ownerGeneration) {
        VoiceBackgroundTaskService.onCancelled = onCancelled;
        return await pendingStart;
      }
      try {
        await pendingStart;
      } catch (_) {
      }
      if (pendingOwner !== null) {
        await VoiceBackgroundTaskService.stop(pendingOwner);
      }
      return await VoiceBackgroundTaskService.start(context, ownerGeneration, onCancelled);
    }

    VoiceBackgroundTaskService.onCancelled = onCancelled;
    const operation = VoiceBackgroundTaskService.startTask(context, ownerGeneration);
    VoiceBackgroundTaskService.startPromise = operation;
    VoiceBackgroundTaskService.startGeneration = ownerGeneration;
    try {
      return await operation;
    } finally {
      if (VoiceBackgroundTaskService.startPromise === operation) {
        VoiceBackgroundTaskService.startPromise = null;
        VoiceBackgroundTaskService.startGeneration = null;
      }
    }
  }

  static async stop(ownerGeneration: number): Promise<void> {
    if (VoiceBackgroundTaskService.taskOwnerGeneration !== ownerGeneration
      && VoiceBackgroundTaskService.startGeneration !== ownerGeneration) {
      return;
    }
    const existingStop = VoiceBackgroundTaskService.stopPromise;
    if (existingStop !== null) {
      await existingStop;
      return;
    }
    const pendingStart = VoiceBackgroundTaskService.startGeneration === ownerGeneration
      ? VoiceBackgroundTaskService.startPromise
      : null;
    const operation = VoiceBackgroundTaskService.stopTask(ownerGeneration, pendingStart);
    VoiceBackgroundTaskService.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (VoiceBackgroundTaskService.stopPromise === operation) {
        VoiceBackgroundTaskService.stopPromise = null;
      }
    }
  }

  private static async startTask(context: common.UIAbilityContext, ownerGeneration: number): Promise<number> {
    const request = new backgroundTaskManager.ContinuousTaskRequest();
    request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_AV_PLAYBACK_AND_RECORD];
    request.backgroundTaskSubmodes = [
      backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_VOICE_CHAT_NORMAL_NOTIFICATION
    ];
    if (!request.isModeSupported()) {
      throw new Error('设备不支持全双工语音后台任务');
    }

    request.wantAgent = await wantAgent.getWantAgent({
      wants: [{
        bundleName: 'com.codex.remote.app',
        abilityName: 'EntryAbility'
      }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: VOICE_BACKGROUND_TASK_REQUEST_CODE,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });

    let listener: ((info: backgroundTaskManager.ContinuousTaskCancelInfo) => void) | null = null;
    try {
      listener = VoiceBackgroundTaskService.registerCancelListener(ownerGeneration);
      const notification = await backgroundTaskManager.startBackgroundRunning(context, request);
      const taskId = notification.continuousTaskId ?? request.continuousTaskId;
      if (typeof taskId !== 'number' || taskId < 0) {
        throw new Error('系统未返回语音后台任务编号');
      }
      VoiceBackgroundTaskService.context = context;
      VoiceBackgroundTaskService.taskId = taskId;
      VoiceBackgroundTaskService.taskOwnerGeneration = ownerGeneration;
      VoiceBackgroundTaskService.cancelListenerTaskId = taskId;
      if (VoiceBackgroundTaskService.cancelListenerPendingIds.includes(taskId) && listener !== null) {
        VoiceBackgroundTaskService.handleCancel(ownerGeneration, taskId, listener);
      }
      return taskId;
    } catch (error) {
      if (listener !== null) {
        VoiceBackgroundTaskService.unregisterCancelListener(listener);
      }
      if (VoiceBackgroundTaskService.taskOwnerGeneration !== ownerGeneration) {
        VoiceBackgroundTaskService.onCancelled = null;
      }
      throw (error as Error);
    }
  }

  private static async stopTask(ownerGeneration: number, pendingStart: Promise<number> | null): Promise<void> {
    if (pendingStart !== null) {
      try {
        await pendingStart;
      } catch (_) {
      }
    }
    const taskId = VoiceBackgroundTaskService.taskId;
    const context = VoiceBackgroundTaskService.context;
    if (taskId === null || context === null
      || VoiceBackgroundTaskService.taskOwnerGeneration !== ownerGeneration) {
      return;
    }

    // Stop only the id returned for this voice call. Never stop the app's data-transfer task.
    if (VoiceBackgroundTaskService.cancelListenerGeneration === ownerGeneration) {
      VoiceBackgroundTaskService.cancelListenerStopping = true;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(context, taskId);
    } catch (error) {
      if (VoiceBackgroundTaskService.taskId === taskId
        && VoiceBackgroundTaskService.cancelListenerGeneration === ownerGeneration) {
        VoiceBackgroundTaskService.cancelListenerStopping = false;
      }
      throw (error as Error);
    }
    if (VoiceBackgroundTaskService.taskId === taskId) {
      VoiceBackgroundTaskService.clearTaskState(taskId, ownerGeneration);
    }
  }

  private static registerCancelListener(ownerGeneration: number):
    (info: backgroundTaskManager.ContinuousTaskCancelInfo) => void {
    const previousListener = VoiceBackgroundTaskService.cancelListener;
    if (previousListener !== null) {
      VoiceBackgroundTaskService.unregisterCancelListener(previousListener);
      if (VoiceBackgroundTaskService.cancelListener !== null) {
        throw new Error('无法清理上一个语音后台任务取消监听');
      }
    }

    VoiceBackgroundTaskService.cancelListenerGeneration = ownerGeneration;
    VoiceBackgroundTaskService.cancelListenerTaskId = null;
    VoiceBackgroundTaskService.cancelListenerActive = true;
    VoiceBackgroundTaskService.cancelListenerStopping = false;
    VoiceBackgroundTaskService.cancelListenerPendingIds = [];
    const listener = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
      if (!VoiceBackgroundTaskService.cancelListenerActive
        || VoiceBackgroundTaskService.cancelListener !== listener
        || info === null || typeof info.id !== 'number') {
        return;
      }
      const expectedTaskId = VoiceBackgroundTaskService.cancelListenerTaskId;
      if (expectedTaskId === null) {
        VoiceBackgroundTaskService.cancelListenerPendingIds.push(info.id);
        return;
      }
      if (info.id !== expectedTaskId) {
        return;
      }
      VoiceBackgroundTaskService.handleCancel(ownerGeneration, expectedTaskId, listener);
    };

    VoiceBackgroundTaskService.cancelListener = listener;
    try {
      backgroundTaskManager.on('continuousTaskCancel', listener);
      return listener;
    } catch (error) {
      VoiceBackgroundTaskService.unregisterCancelListener(listener);
      throw (error as Error);
    }
  }

  private static handleCancel(
    ownerGeneration: number,
    taskId: number,
    listener: (info: backgroundTaskManager.ContinuousTaskCancelInfo) => void
  ): void {
    if (VoiceBackgroundTaskService.cancelListener !== listener
      || !VoiceBackgroundTaskService.cancelListenerActive
      || VoiceBackgroundTaskService.cancelListenerGeneration !== ownerGeneration
      || VoiceBackgroundTaskService.cancelListenerTaskId !== taskId
      || VoiceBackgroundTaskService.taskOwnerGeneration !== ownerGeneration
      || VoiceBackgroundTaskService.taskId !== taskId) {
      return;
    }

    const shouldNotify = !VoiceBackgroundTaskService.cancelListenerStopping;
    const callback = VoiceBackgroundTaskService.onCancelled;
    VoiceBackgroundTaskService.clearTaskState(taskId, ownerGeneration);
    if (shouldNotify && callback !== null) {
      try {
        callback(ownerGeneration);
      } catch (_) {
      }
    }
  }

  private static clearTaskState(taskId: number, ownerGeneration: number): void {
    if (VoiceBackgroundTaskService.taskId !== taskId
      || VoiceBackgroundTaskService.taskOwnerGeneration !== ownerGeneration) {
      return;
    }
    const listener = VoiceBackgroundTaskService.cancelListener;
    if (listener !== null && VoiceBackgroundTaskService.cancelListenerGeneration === ownerGeneration) {
      VoiceBackgroundTaskService.unregisterCancelListener(listener);
    }
    VoiceBackgroundTaskService.taskId = null;
    VoiceBackgroundTaskService.taskOwnerGeneration = null;
    VoiceBackgroundTaskService.context = null;
    VoiceBackgroundTaskService.onCancelled = null;
  }

  private static unregisterCancelListener(
    listener: (info: backgroundTaskManager.ContinuousTaskCancelInfo) => void
  ): void {
    if (VoiceBackgroundTaskService.cancelListener !== listener) {
      return;
    }
    // Disable first so a queued callback cannot mutate a later call generation.
    VoiceBackgroundTaskService.cancelListenerActive = false;
    try {
      backgroundTaskManager.off('continuousTaskCancel', listener);
      VoiceBackgroundTaskService.cancelListener = null;
      VoiceBackgroundTaskService.cancelListenerGeneration = null;
      VoiceBackgroundTaskService.cancelListenerTaskId = null;
      VoiceBackgroundTaskService.cancelListenerStopping = false;
      VoiceBackgroundTaskService.cancelListenerPendingIds = [];
    } catch (_) {
      // Retain the inactive listener reference so a later start can retry removal.
    }
  }
}
