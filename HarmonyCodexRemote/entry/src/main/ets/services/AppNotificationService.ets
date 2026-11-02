import { wantAgent, WantAgent } from '@kit.AbilityKit';
import notificationManager from '@ohos.notificationManager';
import { StandbyMonitorSnapshot } from '../model/StandbyMonitorModels';

export const NOTIFICATION_SESSION_STORAGE_KEY: string = 'codexRemoteNotificationSessionId';
export const NOTIFICATION_EVENT_TYPE_STORAGE_KEY: string = 'codexRemoteNotificationEventType';
export const NOTIFICATION_EVENT_ID_STORAGE_KEY: string = 'codexRemoteNotificationEventId';
export const NOTIFICATION_REVISION_STORAGE_KEY: string = 'codexRemoteNotificationRevision';

export interface AppNotificationTarget {
  type: string;
  sessionId: string;
  eventId: string;
}

interface AppNotificationCopy {
  title: string;
  text: string;
}

export interface MonitorNotificationSyncResult {
  action: string;
  state: string;
}

const MONITOR_NOTIFICATION_ID: number = 31_070;

export class AppNotificationService {
  private static remotePushEnabled: boolean = false;
  private static remotePushThreadIds: string[] = [];

  static setRemotePushEnabled(enabled: boolean, threadIds: string[] = []): void {
    AppNotificationService.remotePushEnabled = enabled;
    AppNotificationService.remotePushThreadIds = enabled ? [...threadIds] : [];
  }
  private static requestCode: number = 31078;
  private static lastMonitorNotificationKey: string = '';

  static async requestPermission(): Promise<boolean> {
    let enabled = await notificationManager.isNotificationEnabled();
    if (!enabled) {
      await notificationManager.requestEnableNotification();
      enabled = await notificationManager.isNotificationEnabled();
    }
    return enabled;
  }

  static async publish(target: AppNotificationTarget, unreadCount: number): Promise<void> {
    if (AppNotificationService.remotePushEnabled
      && AppNotificationService.remotePushThreadIds.includes(target.sessionId)
      && AppStorage.get<boolean>('codexRemoteAppForeground') !== true
      && ['completed', 'failed', 'approval_required', 'user_input_required'].includes(target.type)) {
      await AppNotificationService.syncBadgeNumber(unreadCount);
      return;
    }
    const copy = AppNotificationService.copyForType(target.type);
    const requestCode = AppNotificationService.requestCode;
    AppNotificationService.requestCode += 1;
    const agent = await AppNotificationService.openTargetWantAgent(target, requestCode);
    await notificationManager.publish({
      id: requestCode,
      wantAgent: agent,
      notificationSlotType: notificationManager.SlotType.CONTENT_INFORMATION,
      badgeNumber: 0,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: copy.title,
          text: copy.text,
          additionalText: '点击打开对应会话'
        }
      }
    });
    await AppNotificationService.syncBadgeNumber(unreadCount);
  }

  static async syncBadgeNumber(unreadCount: number): Promise<void> {
    const normalizedUnreadCount = Math.max(0, Math.floor(unreadCount));
    await notificationManager.setBadgeNumber(normalizedUnreadCount);
  }

  static async syncMonitorSnapshot(
    snapshot: StandbyMonitorSnapshot
  ): Promise<MonitorNotificationSyncResult> {
    if (snapshot.runningCount <= 0 && snapshot.unreadCount <= 0) {
      let action = 'none';
      try {
        await notificationManager.cancel(MONITOR_NOTIFICATION_ID);
        action = 'cleared';
      } catch (_) {
      }
      AppNotificationService.lastMonitorNotificationKey = '';
      await AppNotificationService.syncBadgeNumber(0);
      return { action, state: 'idle' };
    }

    const targetSessionId = AppNotificationService.monitorTargetSessionId(snapshot);
    const monitorNotificationKey = AppNotificationService.monitorNotificationKey(snapshot, targetSessionId);
    if (monitorNotificationKey === AppNotificationService.lastMonitorNotificationKey) {
      await AppNotificationService.syncBadgeNumber(snapshot.unreadCount);
      return {
        action: 'unchanged',
        state: snapshot.connected ? 'connected' : 'offline_snapshot'
      };
    }
    const agent = await AppNotificationService.openTargetWantAgent(
      {
        type: 'monitor_summary',
        sessionId: targetSessionId,
        eventId: ''
      },
      MONITOR_NOTIFICATION_ID
    );
    const connectionText = snapshot.connected ? '已连接' : '连接暂时离线';
    const usageText = snapshot.usagePrimaryValue === '等待同步'
      ? '额度等待同步'
      : `${snapshot.usagePrimaryLabel} ${snapshot.usagePrimaryValue}`;
    await notificationManager.publish({
      id: MONITOR_NOTIFICATION_ID,
      wantAgent: agent,
      notificationSlotType: notificationManager.SlotType.CONTENT_INFORMATION,
      isAlertOnce: true,
      tapDismissed: false,
      badgeNumber: 0,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: 'Codex 任务监控',
          text: `运行 ${snapshot.runningCount} · 未读 ${snapshot.unreadCount}`,
          additionalText: `${connectionText} · ${usageText}`
        }
      }
    });
    await AppNotificationService.syncBadgeNumber(snapshot.unreadCount);
    AppNotificationService.lastMonitorNotificationKey = monitorNotificationKey;
    return { action: 'updated', state: snapshot.connected ? 'connected' : 'offline_snapshot' };
  }

  private static async openTargetWantAgent(
    target: AppNotificationTarget,
    requestCode: number
  ): Promise<WantAgent> {
    return await wantAgent.getWantAgent({
      wants: [{
        bundleName: 'com.codex.remote.app',
        abilityName: 'EntryAbility',
        parameters: {
          codexRemoteNotificationSessionId: target.sessionId,
          codexRemoteNotificationEventType: target.type,
          codexRemoteNotificationEventId: target.eventId,
          codexRemoteNotificationRevision: `${Date.now()}`
        }
      }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
  }

  private static monitorTargetSessionId(snapshot: StandbyMonitorSnapshot): string {
    for (let index = 0; index < snapshot.sessionIds.length; index += 1) {
      const kind = snapshot.sessionKinds[index] ?? '';
      if (kind === 'running' || kind === 'unread') {
        return snapshot.sessionIds[index];
      }
    }
    return '';
  }

  private static monitorNotificationKey(snapshot: StandbyMonitorSnapshot, targetSessionId: string): string {
    return [
      snapshot.connected ? '1' : '0',
      `${snapshot.runningCount}`,
      `${snapshot.unreadCount}`,
      snapshot.usagePrimaryLabel,
      snapshot.usagePrimaryValue,
      targetSessionId
    ].join('|');
  }

  private static copyForType(type: string): AppNotificationCopy {
    if (type === 'approval_required') {
      return { title: 'Codex 需要确认', text: '有一项操作等待你的确认' };
    }
    if (type === 'user_input_required') {
      return { title: 'Codex 需要回答', text: '有一组问题等待你的回答' };
    }
    if (type === 'connection_error') {
      return { title: 'Codex 连接异常', text: '远程连接需要检查' };
    }
    if (type === 'failed') {
      return { title: 'Codex 执行失败', text: '任务已结束，请打开应用查看' };
    }
    return { title: 'Codex 已完成', text: '任务已完成并有新结果' };
  }
}
