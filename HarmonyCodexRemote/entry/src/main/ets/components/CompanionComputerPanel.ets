import { webview } from '@kit.ArkWeb';
import { BridgeClient } from '../services/BridgeClient';
import { CompanionComputerLifecycle } from '../services/CompanionComputerLifecycle';
import { CompanionProfile } from '../model/CompanionModels';
import { appThemeTokens } from '../theme/AppTheme';

class ComputerRequest {
  threadId: string = '';
  environmentId: string = '';
  sdp: string = '';
}

class ComputerWebBridge {
  active: boolean = false;
  baseUrl: string = '';
  token: string = '';
  assistantId: string = '';
  roomId: string = '';
  reply: (id: string, ok: boolean, value: string) => void = () => {};

  request(id: string, operation: string, payload: string): void {
    if (!this.active || !CompanionComputerLifecycle.foreground
      || id.length > 64 || payload.length > 120000) {
      return;
    }
    void this.perform(id, operation, payload);
  }

  private async perform(id: string, operation: string, payload: string): Promise<void> {
    try {
      let result: string = '';
      if (operation === 'status') {
        result = await BridgeClient.getCompanionComputerStatus(
          this.baseUrl, this.assistantId, this.roomId, this.token);
      } else if (operation === 'session') {
        const request = JSON.parse(payload) as ComputerRequest;
        result = await BridgeClient.startCompanionComputerSession(
          this.baseUrl, this.assistantId, this.roomId, request.threadId,
          request.environmentId, request.sdp, this.token);
      } else {
        throw new Error('Unsupported computer operation');
      }
      if (this.active && CompanionComputerLifecycle.foreground) {
        this.reply(id, true, result);
      }
    } catch (_) {
      if (this.active) {
        this.reply(id, false, '云电脑连接失败，请检查连接或重新打开页面');
      }
    }
  }
}

@ComponentV2
export struct CompanionComputerPanel {
  @Param profile: CompanionProfile | null = null;
  @Param baseUrl: string = '';
  @Param token: string = '';
  @Param darkMode: boolean = false;
  @Param voiceActive: boolean = false;
  @Param voiceMuted: boolean = false;
  @Event onBack: () => void = () => {};
  @Event onVoice: () => void = () => {};
  @Event onMute: () => void = () => {};
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: ComputerWebBridge = new ComputerWebBridge();
  private ready: boolean = false;
  private foregroundHandler: (foreground: boolean) => void = (foreground: boolean) => {
    this.execute(foreground ? 'window.computerViewer.resume()' : 'window.computerViewer.suspend()');
  };

  aboutToAppear(): void {
    this.bridge.baseUrl = this.baseUrl;
    this.bridge.token = this.token;
    this.bridge.assistantId = this.profile?.id ?? '';
    this.bridge.roomId = this.profile?.roomId ?? '';
    this.bridge.active = this.bridge.assistantId.length > 0 && this.bridge.roomId.length > 0;
    this.bridge.reply = (id: string, ok: boolean, value: string): void => {
      this.execute('window.computerViewer.reply(' + JSON.stringify(id) + ','
        + String(ok) + ',' + JSON.stringify(value) + ')');
    };
    CompanionComputerLifecycle.listener = this.foregroundHandler;
  }

  aboutToDisappear(): void {
    this.execute('window.computerViewer.close()');
    this.bridge.active = false;
    this.ready = false;
    if (CompanionComputerLifecycle.listener === this.foregroundHandler) {
      CompanionComputerLifecycle.listener = null;
    }
  }

  private execute(script: string): void {
    if (!this.ready) {
      return;
    }
    this.controller.runJavaScript(script).catch(() => {});
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回对话')
          .height(44)
          .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted)
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
          .onClick(() => {
            this.execute('window.computerViewer.close()');
            this.bridge.active = false;
            this.onBack();
          })
        Text('助手的电脑')
          .fontSize(18).fontWeight(FontWeight.Bold).layoutWeight(1)
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
      }.width('100%').padding(12)
      if (this.voiceActive) {
        Row({ space: 10 }) {
          Text(this.voiceMuted ? '语音通话 · 麦克风已静音' : '语音通话中')
            .fontSize(12).layoutWeight(1)
            .fontColor(appThemeTokens(this.darkMode).textSecondary)
          Button(this.voiceMuted ? '取消静音' : '静音').height(44).onClick(() => this.onMute())
          Button('通话').height(44).onClick(() => {
            this.execute('window.computerViewer.suspend()');
            this.onVoice();
          })
        }.width('100%').padding({ left: 12, right: 12 })
      }
      Web({ src: $rawfile('computer/viewer.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(false)
        .fileAccess(false)
        .javaScriptProxy({ object: this.bridge, name: 'ComputerNative', methodList: ['request'], controller: this.controller })
        .onLoadIntercept((event) => {
          const url = event?.data.getRequestUrl() ?? '';
          return !url.startsWith('resource://rawfile/computer/viewer.html');
        })
        .onPageEnd(() => {
          this.ready = true;
          this.execute('window.computerViewer.configure(' + JSON.stringify(this.bridge.assistantId)
            + ',' + JSON.stringify(this.bridge.roomId) + ',' + String(this.darkMode) + ')');
          this.foregroundHandler(CompanionComputerLifecycle.foreground);
        })
        .width('100%').layoutWeight(1)
    }.width('100%').height('100%').backgroundColor(appThemeTokens(this.darkMode).canvas)
  }
}
