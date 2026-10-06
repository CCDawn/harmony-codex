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

  static async start(context: common.UIAbilityContext, ownerGeneration: number): Promise<number> {
    const pendingStop = VoiceBackgroundTaskService.stopPromise;
    if (pendingStop !== null) {
      await pendingStop;
    }
    if (VoiceBackgroundTaskService.taskId !== null) {
      if (VoiceBackgroundTaskService.taskOwnerGeneration === ownerGeneration) {
        return VoiceBackgroundTaskService.taskId;
      }
      const previousOwner = VoiceBackgroundTaskService.taskOwnerGeneration;
      if (previousOwner === null) {
        throw new Error('语音后台任务归属状态丢失');
      }
      await VoiceBackgroundTaskService.stop(previousOwner);
      return await VoiceBackgroundTaskService.start(context, ownerGeneration);
    }
    const pendingStart = VoiceBackgroundTaskService.startPromise;
    if (pendingStart !== null) {
      const pendingOwner = VoiceBackgroundTaskService.startGeneration;
      if (pendingOwner === ownerGeneration) {
        return await pendingStart;
      }
      try {
        await pendingStart;
      } catch (_) {
      }
      if (pendingOwner !== null) {
        await VoiceBackgroundTaskService.stop(pendingOwner);
      }
      return await VoiceBackgroundTaskService.start(context, ownerGeneration);
    }

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

    const notification = await backgroundTaskManager.startBackgroundRunning(context, request);
    const taskId = notification.continuousTaskId ?? request.continuousTaskId;
    if (typeof taskId !== 'number' || taskId < 0) {
      throw new Error('系统未返回语音后台任务编号');
    }
    VoiceBackgroundTaskService.context = context;
    VoiceBackgroundTaskService.taskId = taskId;
    VoiceBackgroundTaskService.taskOwnerGeneration = ownerGeneration;
    return taskId;
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
    await backgroundTaskManager.stopBackgroundRunning(context, taskId);
    if (VoiceBackgroundTaskService.taskId === taskId) {
      VoiceBackgroundTaskService.taskId = null;
      VoiceBackgroundTaskService.taskOwnerGeneration = null;
      VoiceBackgroundTaskService.context = null;
    }
  }
}
