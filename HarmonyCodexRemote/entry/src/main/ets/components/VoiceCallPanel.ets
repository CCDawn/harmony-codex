import { AppThemeTokens, appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';
import { VoiceCallStatus, VoiceTranscriptEntry } from '../model/BridgeModels';

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
  return '正在等待接通';
}

/**
 * 全屏语音通话面板：状态头 + 实时转写列表 + 打断/静音/挂断控制条。
 * 用户消息右对齐 accent 气泡、Codex 消息左对齐卡片，与会话视图聊天气泡风格一致。
 */
@ComponentV2
export struct VoiceCallPanel {
  @Param @Require status: VoiceCallStatus;
  @Param statusDetail: string = '';
  @Param assistantName: string = '熊大';
  @Param @Require transcripts: VoiceTranscriptEntry[];
  @Param speaking: boolean = false;
  @Param muted: boolean = false;
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Event onClose: () => void = () => {};
  @Event onComputer: () => void = () => {};
  @Event onInterrupt: () => void = () => {};
  @Event onToggleMute: () => void = () => {};
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
        if (this.shouldShowBanner()) {
          this.StatusBanner()
        }
        if (this.transcripts.length === 0) {
          this.EmptyHint()
        } else {
          List({ space: 10, scroller: this.transcriptsScroller }) {
            ForEach(this.transcripts, (entry: VoiceTranscriptEntry, index: number) => {
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
  private StatusBanner() {
    Row({ space: 8 }) {
      Text(this.statusDetail)
        .fontSize(this.fs(11))
        .fontColor(this.bannerTextColor())
        .layoutWeight(1)
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
        Text(entry.text)
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

        Text(entry.text)
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
    return this.status === 'connecting' || this.status === 'active' || this.status === 'ready';
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
      return '连接中';
    }
    if (this.status === 'ready') {
      return '已就绪';
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
      && (this.status === 'connecting' || this.status === 'error' || this.status === 'idle');
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
      return '可挂断后从「熊大语音」菜单重新发起';
    }
    return `接通后直接开口和${this.assistantName}对话\n说话内容会实时显示在这里`;
  }
}
