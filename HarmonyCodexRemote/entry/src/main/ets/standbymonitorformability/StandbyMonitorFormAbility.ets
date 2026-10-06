import { Want } from '@kit.AbilityKit';
import { formBindingData, FormExtensionAbility, formInfo } from '@kit.FormKit';
import { CredentialRuntime } from '../config/CredentialRuntime';
import { CodexAccountUsage } from '../model/BridgeModels';
import { BridgeClient } from '../services/BridgeClient';
import { BridgeCredentialStore } from '../services/BridgeCredentialStore';
import { SessionRuntimeStore } from '../services/SessionRuntimeStore';
import { StandbyMonitorSnapshotService } from '../services/StandbyMonitorSnapshotService';

export default class StandbyMonitorFormAbility extends FormExtensionAbility {
  private credentialLoadAttempted: boolean = false;
  onAddForm(want: Want): formBindingData.FormBindingData {
    const formId = String(want.parameters?.[formInfo.FormParam.IDENTITY_KEY] ?? '');
    const initial = StandbyMonitorSnapshotService.defaultSnapshot();
    void StandbyMonitorSnapshotService.registerFormId(this.context, formId)
      .then(() => this.refreshFromBridge(formId));
    return StandbyMonitorSnapshotService.toFormBindingData(initial);
  }

  onUpdateForm(formId: string): void {
    void this.refreshFromBridge(formId);
  }

  onFormEvent(formId: string, message: string): void {
    if (message.indexOf('refresh') >= 0 || message.indexOf('同步') >= 0) {
      void this.refreshFromBridge(formId);
    }
  }

  onFormLocationChanged(formId: string, newFormLocation: formInfo.FormLocation): void {
    void this.updateFormLocation(
      formId,
      newFormLocation === formInfo.FormLocation.STANDBY ? 'standby' : 'desktop'
    );
  }

  onSizeChanged(
    formId: string,
    newDimension: formInfo.FormDimension,
    newRect: formInfo.Rect
  ): void {
    const layoutMode = newRect.height > newRect.width ? 'portrait' : 'landscape';
    void this.updateLayoutMode(formId, layoutMode);
  }

  onRemoveForm(formId: string): void {
    void StandbyMonitorSnapshotService.unregisterFormId(this.context, formId);
  }

  onAcquireFormState(want: Want): formInfo.FormState {
    return formInfo.FormState.READY;
  }

  private async refreshFromBridge(formId: string): Promise<void> {
    await this.ensureRuntimeCredential();
    const cached = await StandbyMonitorSnapshotService.loadSnapshot(this.context);
    try {
      const runtime = await BridgeClient.getRuntimeSnapshot(
        CredentialRuntime.getRuntimeBridgeUrl(),
        CredentialRuntime.getRuntimeToken()
      );
      const runtimeStore = new SessionRuntimeStore();
      runtimeStore.apply(runtime);
      const sessions = runtimeStore.mergeSessions([]);
      const usage = await this.loadUsageOrCached();
      const snapshot = StandbyMonitorSnapshotService.buildSnapshot(
        sessions,
        [],
        cached.unreadSessionIds,
        usage,
        true,
        cached.layoutMode,
        cached.formLocation,
        runtime,
        cached.attentionRevision
      );
      await StandbyMonitorSnapshotService.publishIfNewer(this.context, snapshot);
    } catch (error) {
      cached.connected = false;
      cached.runtimeStale = true;
      cached.mainStatus = '连接暂时离线';
      cached.summaryText = '保留上次同步内容';
      cached.updatedAt = new Date().toISOString();
      console.warn(`standby bridge refresh failed: ${String(error)}`);
      await StandbyMonitorSnapshotService.publishIfNewer(this.context, cached);
    }
  }

  private async loadUsageOrCached(): Promise<CodexAccountUsage | null> {
    try {
      return await BridgeClient.getCodexAccountUsage(
        CredentialRuntime.getRuntimeBridgeUrl(),
        CredentialRuntime.getRuntimeToken()
      );
    } catch (_) {
      return null;
    }
  }

  /**
   * 卡片侧启动时加载设备配对凭证：加载完成前的刷新周期回落烘焙常量（可接受）。
   * 未配对（查无此条）只尝试一次，避免每个刷新周期重复查询。
   */
  private async ensureRuntimeCredential(): Promise<void> {
    if (CredentialRuntime.getRuntimeCredential() !== null || this.credentialLoadAttempted) {
      return;
    }
    this.credentialLoadAttempted = true;
    try {
      const credential = await BridgeCredentialStore.loadCredential(this.context);
      if (credential !== null) {
        CredentialRuntime.setRuntimeCredential(credential);
      }
    } catch (error) {
      console.warn(`standby form credential load failed: ${String(error)}`);
    }
  }

  private async updateLayoutMode(formId: string, layoutMode: string): Promise<void> {
    await StandbyMonitorSnapshotService.registerFormId(this.context, formId);
    const snapshot = await StandbyMonitorSnapshotService.loadSnapshot(this.context);
    snapshot.layoutMode = layoutMode;
    snapshot.updatedAt = new Date().toISOString();
    await StandbyMonitorSnapshotService.publish(this.context, snapshot);
  }

  private async updateFormLocation(formId: string, formLocation: string): Promise<void> {
    await StandbyMonitorSnapshotService.registerFormId(this.context, formId);
    const snapshot = await StandbyMonitorSnapshotService.loadSnapshot(this.context);
    snapshot.formLocation = formLocation;
    snapshot.updatedAt = new Date().toISOString();
    await StandbyMonitorSnapshotService.publish(this.context, snapshot);
  }

}
