import { AppThemeTokens, appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';
import { VoiceCallStatus, VoiceCallStage, VoiceCallFailure, VoiceTranscriptEntry } from '../model/BridgeModels';
import { VoiceTranscriptPresentation } from '../services/VoiceTranscriptPresentation';

function voiceCallEmptyHintTitle(status: VoiceCallStatus, statusDetail: string, muted: boolean): string {
  if (status === 'active') {
    return muted ? '已接通，麦克风已静音' : '已接通，可以开始说话';
  }
  if (status === 'error') {
    return '通话未能开始';
  }
  if (status === 'idle' && statusDetail.length > 0) {
    return '通话已结束';
  }
  if (status === 'ready') { return '开始采集'; }
  return statusDetail.length > 0 ? statusDetail : '正在连接通道';
}

/**
 * 全屏语音通话面板：状态头 + 实时转写列表 + 打断/静音/挂断控制条。
 * 用户消息右对齐 accent 气泡、Codex 消息左对齐卡片，与会话视图聊天气泡风格一致。
 */
@ComponentV2
export struct VoiceCallPanel {
  @Param @Require status: VoiceCallStatus;
  @Param statusDetail: string = '';
  @Param assistantName: string = '个人助手';
  @Param stage: VoiceCallStage = 'channel';
  @Param stageStartedAt: number = 0;
  @Param failure: VoiceCallFailure = '';
  @Local clockNow: number = Date.now();
  private clockTimer: number = -1;
  private stageKeys: VoiceCallStage[] = ['channel', 'assistant', 'media', 'mic', 'listening'];
  private stageNames: string[] = ['连接通道', '助手准备', '媒体就绪', '开始采集', '聆听'];
  @Param @Require transcripts: VoiceTranscriptEntry[];
  @Param speaking: boolean = false;
  @Param muted: boolean = false;
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Event onClose: () => void = () => {};
  @Event onComputer: () => void = () => {};
  @Event onInterrupt: () => void = () => {};
  @Event onToggleMute: () => void = () => {};
  @Event onRetry: () => void = () => {};
  @Event onRecovery: () => void = () => {};

  aboutToAppear(): void {
    this.syncClock();
  }

  @Monitor('status')
  private onStatusChanged(): void { this.syncClock(); }

  private syncClock(): void {
    this.clockNow = Date.now();
    if (this.status === 'connecting' || this.status === 'ready') {
      if (this.clockTimer < 0) {
        this.clockTimer = setInterval(() => { this.clockNow = Date.now(); }, 1000);
      }
    } else if (this.clockTimer >= 0) {
      clearInterval(this.clockTimer);
      this.clockTimer = -1;
    }
  }

  aboutToDisappear(): void {
    if (this.clockTimer >= 0) { clearInterval(this.clockTimer); this.clockTimer = -1; }
  }

  private transcriptsScroller: Scroller = new Scroller();

  @Monitor('transcripts')
  private onTranscriptsChanged(): void {
    setTimeout(() => {
      try {
        this.transcriptsScroller.scrollEdge(Edge.Bottom);
      } catch (_) {
      }
    }, 60);
  }

  private theme(): AppThemeTokens {
    return appThemeTokens(this.darkMode);
  }

  private fs(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column({ space: 12 }) {
        this.HeaderBar()
        if (this.status === 'connecting' || this.status === 'ready') {
          this.StageCard()
        }
        if (this.shouldShowBanner()) {
          this.StatusBanner()
        }
        if (VoiceTranscriptPresentation.visible(this.transcripts).length === 0) {
          this.EmptyHint()
        } else {
          List({ space: 10, scroller: this.transcriptsScroller }) {
            ForEach(VoiceTranscriptPresentation.visible(this.transcripts), (entry: VoiceTranscriptEntry, index: number) => {
              ListItem() {
                this.TranscriptBubble(entry)
              }
            }, (entry: VoiceTranscriptEntry, index: number) => `${index}:${entry.role}:${entry.final ? 1 : 0}:${entry.text}`)
          }
          .layoutWeight(1)
          .width('100%')
          .scrollBar(BarState.Auto)
        }
        this.ControlRow()
      }
      .width('100%')
      .height('100%')
      .padding({ left: 18, right: 18, top: 18, bottom: 20 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.theme().canvas)
  }

  @Builder
  private HeaderBar() {
    Row({ space: 10 }) {
      Column({ space: 3 }) {
        Text(`${this.assistantName} · 语音通话`)
          .fontSize(this.fs(18))
          .fontWeight(FontWeight.Bold)
          .fontColor(this.theme().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Row({ space: 6 }) {
          Circle()
            .width(6)
            .height(6)
            .fill(this.statusDotColor())
          Text(this.statusText())
            .fontSize(this.fs(10))
            .fontColor(this.theme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(VerticalAlign.Center)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Button('电脑')
        .height(44)
        .fontSize(this.fs(12))
        .fontColor(this.theme().textSecondary)
        .backgroundColor(this.theme().surfaceMuted)
        .onClick(() => this.onComputer())
      Button('关闭')
        .height(32)
        .padding({ left: 12, right: 12 })
        .fontSize(this.fs(11))
        .fontColor(this.theme().textSecondary)
        .backgroundColor(this.theme().surfaceMuted)
        .border({ width: 1, color: this.theme().border })
        .borderRadius(16)
        .onClick(() => {
          this.onClose();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private StageCard() {
    Column({ space: 10 }) {
      Row() {
        Text('连接阶段').fontSize(this.fs(12)).fontWeight(FontWeight.Medium)
          .fontColor(this.theme().textPrimary).layoutWeight(1)
        Text(`本阶段已等待 ${this.elapsedText()}`).fontSize(this.fs(10))
          .fontColor(this.theme().textSecondary)
      }.width('100%')
      ForEach(this.stageKeys, (key: VoiceCallStage, index: number) => {
        Row({ space: 10 }) {
          Text(index < this.stageKeys.indexOf(this.stage) ? '✓' : `${index + 1}`)
            .width(22).height(22).textAlign(TextAlign.Center).fontSize(this.fs(11))
            .fontColor(key === this.stage ? this.theme().textOnAccent : this.theme().textSecondary)
            .backgroundColor(key === this.stage ? this.theme().accent : this.theme().surfaceMuted)
            .borderRadius(11)
          Text(this.stageNames[index]).fontSize(this.fs(12)).layoutWeight(1)
            .fontColor(key === this.stage ? this.theme().textPrimary : this.theme().textSecondary)
          Text(key === this.stage ? '进行中' : (index < this.stageKeys.indexOf(this.stage) ? '已完成' : '等待'))
            .fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
        }.width('100%')
      }, (key: VoiceCallStage) => key)
    }.width('100%').padding(14).backgroundColor(this.theme().surfaceMuted)
      .border({ width: 1, color: this.theme().border }).borderRadius(12)
  }

  private elapsedText(): string {
    const seconds = this.stageStartedAt > 0 ? Math.max(0, Math.floor((this.clockNow - this.stageStartedAt) / 1000)) : 0;
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }

  @Builder
  private StatusBanner() {
    Row({ space: 8 }) {
      Column({ space: 8 }) {
        Text(this.statusDetail)
        .fontSize(this.fs(11))
        .fontColor(this.bannerTextColor())
        .width('100%')
        if (this.status === 'error' || this.status === 'idle') {
          Row({ space: 10 }) {
            Button('重试').height(40).fontSize(this.fs(12))
              .backgroundColor(this.theme().accent).fontColor(this.theme().textOnAccent)
              .onClick(() => this.onRetry())
            if (this.failure === 'auth' || this.failure === 'channel' || this.failure === 'assistant' || this.failure === 'mic') {
              Button(this.failure === 'mic' ? '麦克风权限' : '检查配对').height(40).fontSize(this.fs(12))
                .backgroundColor(this.theme().surfaceMuted).fontColor(this.theme().textSecondary)
                .onClick(() => this.onRecovery())
            }
          }.width('100%')
        }
      }.layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .backgroundColor(this.bannerSurfaceColor())
    .border({ width: 1, color: this.bannerBorderColor() })
    .borderRadius(10)
  }

  @Builder
  private EmptyHint() {
    Column({ space: 8 }) {
      Text(this.emptyHintTitle())
        .fontSize(this.fs(16))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.theme().textPrimary)
      Text(this.emptyHintDesc())
        .fontSize(this.fs(11))
        .fontColor(this.theme().textSecondary)
        .textAlign(TextAlign.Center)
    }
    .justifyContent(FlexAlign.Center)
    .layoutWeight(1)
    .width('100%')
    .padding({ left: 24, right: 24 })
  }

  @Builder
  private TranscriptBubble(entry: VoiceTranscriptEntry) {
    if (entry.role === 'user') {
      Row() {
        Blank()
        Text(VoiceTranscriptPresentation.text(entry))
          .fontSize(this.fs(14))
          .fontColor(this.theme().textPrimary)
          .padding({ left: 12, right: 12, top: 9, bottom: 10 })
          .backgroundColor(this.theme().accentSurface)
          .border({ width: 1, color: this.theme().accentBorder })
          .borderRadius(10)
          .constraintSize({ maxWidth: '82%' })
      }
      .width('100%')
    } else {
      Column({ space: 4 }) {
        Row({ space: 6 }) {
          Row()
            .width(6)
            .height(6)
            .backgroundColor(this.theme().accent)
            .borderRadius(3)
          Text(this.assistantName)
            .fontSize(this.fs(10))
            .fontColor(this.theme().textTertiary)
        }
        .width('100%')

        Text(VoiceTranscriptPresentation.text(entry))
          .fontSize(this.fs(14))
          .fontColor(this.theme().textPrimary)
          .padding({ left: 12, right: 12, top: 9, bottom: 10 })
          .backgroundColor(this.theme().surface)
          .border({ width: 1, color: this.theme().border })
          .borderRadius(10)
          .constraintSize({ maxWidth: '88%' })
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
    }
  }

  @Builder
  private ControlRow() {
    Row({ space: 12 }) {
      Button('打断')
        .layoutWeight(1)
        .height(42)
        .fontSize(this.fs(13))
        .fontColor(this.theme().textSecondary)
        .backgroundColor(this.theme().surfaceMuted)
        .border({ width: 1, color: this.theme().border })
        .borderRadius(21)
        .enabled(this.canInterrupt())
        .opacity(this.canInterrupt() ? 1 : 0.5)
        .onClick(() => {
          this.onInterrupt();
        })

      Button(this.muted ? '取消静音' : '静音')
        .layoutWeight(1)
        .height(42)
        .fontSize(this.fs(13))
        .fontColor(this.muted ? this.theme().textOnAccent : this.theme().textSecondary)
        .backgroundColor(this.muted ? this.theme().accent : this.theme().surfaceMuted)
        .border({ width: 1, color: this.muted ? this.theme().accent : this.theme().border })
        .borderRadius(21)
        .enabled(this.canMute())
        .opacity(this.canMute() ? 1 : 0.5)
        .onClick(() => {
          this.onToggleMute();
        })

      Button('挂断')
        .layoutWeight(1)
        .height(42)
        .fontSize(this.fs(13))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.theme().textOnAccent)
        .backgroundColor(this.theme().danger)
        .borderRadius(21)
        .onClick(() => {
          this.onClose();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  private canInterrupt(): boolean {
    return this.status === 'active';
  }

  private canMute(): boolean {
    return this.status === 'active';
  }

  private statusDotColor(): string {
    if (this.status === 'active') {
      return '#4ED69B';
    }
    if (this.status === 'connecting' || this.status === 'ready') {
      return this.theme().accent;
    }
    if (this.status === 'closing') {
      return this.theme().warning;
    }
    if (this.status === 'error') {
      return this.theme().danger;
    }
    return this.theme().textTertiary;
  }

  private statusText(): string {
    if (this.status === 'connecting') {
      return this.stageNames[this.stageKeys.indexOf(this.stage)];
    }
    if (this.status === 'ready') {
      return '正在开启麦克风';
    }
    if (this.status === 'active') {
      if (this.speaking) {
        return '对方正在讲话';
      }
      return this.muted ? '通话中（已静音）' : '通话中 · 正在聆听';
    }
    if (this.status === 'closing') {
      return '正在结束';
    }
    if (this.status === 'error') {
      return '连接异常';
    }
    return this.statusDetail.length > 0 ? '已结束' : '待接通';
  }

  private shouldShowBanner(): boolean {
    return this.statusDetail.length > 0
      && (this.status === 'error' || this.status === 'idle');
  }

  private bannerTextColor(): string {
    if (this.status === 'error') {
      return this.theme().danger;
    }
    return this.theme().textSecondary;
  }

  private bannerSurfaceColor(): string {
    if (this.status === 'error') {
      return this.theme().dangerSurface;
    }
    return this.theme().surfaceMuted;
  }

  private bannerBorderColor(): string {
    if (this.status === 'error') {
      return this.theme().dangerBorder;
    }
    return this.theme().border;
  }

  private emptyHintTitle(): string {
    return voiceCallEmptyHintTitle(this.status, this.statusDetail, this.muted);
  }

  private emptyHintDesc(): string {
    if (this.status === 'active') {
      return `已接通，直接开口和${this.assistantName}对话\n说话内容会实时显示在这里`;
    }
    if (this.status === 'error' || (this.status === 'idle' && this.statusDetail.length > 0)) {
      return '请查看上方原因，处理后点击重试';
    }
    return this.stage === 'mic' ? '媒体已就绪，正在启动麦克风' : '连接完成后即可说话，内容会实时显示在这里';
  }
}
