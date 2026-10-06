import { AppThemeTokens, appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';
import { VoiceTranscriptEntry } from '../model/BridgeModels';
import { CompanionProfile } from '../model/CompanionModels';

@ComponentV2
export struct CompanionConversationPanel {
  @Param profile: CompanionProfile | null = null;
  @Param entries: VoiceTranscriptEntry[] = [];
  @Param loading: boolean = false;
  @Param errorMessage: string = '';
  @Param hasOlder: boolean = false;
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Event onBack: () => void = () => {};
  @Event onComputer: () => void = () => {};
  @Event onVoice: () => void = () => {};
  @Event onRefresh: () => void = () => {};
  @Event onLoadEarlier: () => void = () => {};
  @Local avatarFailed: boolean = false;
  private messagesScroller: Scroller = new Scroller();
  private latestSignature: string = '';

  private theme(): AppThemeTokens {
    return appThemeTokens(this.darkMode);
  }

  private fs(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  @Monitor('entries')
  private onEntriesChanged(): void {
    if (this.entries.length === 0) {
      return;
    }
    const latest = this.entries[this.entries.length - 1];
    const signature = `${latest.itemId ?? ''}:${latest.text}`;
    if (signature === this.latestSignature) {
      return;
    }
    let followLatest = this.latestSignature.length === 0;
    try {
      followLatest = followLatest || this.messagesScroller.isAtEnd();
    } catch (_) {
    }
    this.latestSignature = signature;
    if (followLatest) {
      setTimeout(() => {
        try {
          this.messagesScroller.scrollEdge(Edge.Bottom);
        } catch (_) {
        }
      }, 60);
    }
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 10 }) {
        Button('返回')
          .height(32)
          .fontSize(this.fs(12))
          .fontColor(this.theme().textSecondary)
          .backgroundColor(this.theme().surfaceMuted)
          .onClick(() => this.onBack())
        if (this.profile?.avatarUrl && !this.avatarFailed) {
          Image(this.profile.avatarUrl)
            .width(40).height(40).borderRadius(20)
            .objectFit(ImageFit.Contain)
            .onError(() => { this.avatarFailed = true; })
        } else {
          Text('熊').width(40).height(40).borderRadius(20)
            .textAlign(TextAlign.Center)
            .fontColor(this.theme().textPrimary)
            .backgroundColor(this.theme().accentSurface)
        }
        Column({ space: 3 }) {
          Text(this.profile?.name ?? '熊大')
            .fontSize(this.fs(18)).fontWeight(FontWeight.Bold)
            .fontColor(this.theme().textPrimary)
          Text('个人助手')
            .fontSize(this.fs(11)).fontColor(this.theme().textSecondary)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button('电脑')
          .height(32).fontSize(this.fs(12))
          .fontColor(this.theme().textSecondary)
          .backgroundColor(this.theme().surfaceMuted)
          .enabled(this.profile !== null)
          .onClick(() => this.onComputer())
      }.width('100%')

      if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .width('100%').fontSize(this.fs(12))
          .fontColor(this.theme().danger)
          .padding(10).backgroundColor(this.theme().dangerSurface).borderRadius(10)
      }
      if (this.entries.length === 0) {
        Column({ space: 8 }) {
          Text(this.loading ? '正在同步会话…' : '暂无聊天记录')
            .fontSize(this.fs(15)).fontColor(this.theme().textSecondary)
          Text('接通语音后，可以直接和熊大对话')
            .fontSize(this.fs(12)).fontColor(this.theme().textTertiary)
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else {
        List({ space: 12, scroller: this.messagesScroller }) {
          if (this.hasOlder) {
            ListItem() {
              Button(this.loading ? '正在加载…' : '加载更早消息')
                .fontSize(this.fs(12)).height(32)
                .fontColor(this.theme().textSecondary)
                .backgroundColor(this.theme().surfaceMuted)
                .enabled(!this.loading)
                .onClick(() => this.onLoadEarlier())
            }
          }
          ForEach(this.entries, (entry: VoiceTranscriptEntry) => {
            ListItem() {
              this.MessageBubble(entry)
            }
          }, (entry: VoiceTranscriptEntry) => `${entry.itemId ?? ''}:${entry.role}:${entry.text}`)
        }.layoutWeight(1).width('100%').scrollBar(BarState.Auto)
      }
      Button('语音通话')
        .width('100%').height(44).borderRadius(22)
        .fontSize(this.fs(14)).fontWeight(FontWeight.Bold)
        .fontColor(this.theme().textOnAccent)
        .backgroundColor(this.theme().accent)
        .enabled(this.profile !== null)
        .onClick(() => this.onVoice())
    }
    .width('100%').height('100%')
    .padding({ left: 18, right: 18, top: 14, bottom: 18 })
    .backgroundColor(this.theme().canvas)
  }

  @Builder
  private MessageBubble(entry: VoiceTranscriptEntry) {
    Row() {
      if (entry.role === 'user') {
        Blank()
      }
      Column({ space: 4 }) {
        Text(entry.role === 'user' ? '你' : (this.profile?.name ?? '熊大'))
          .fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
        Text(entry.text)
          .fontSize(this.fs(14)).fontColor(this.theme().textPrimary)
          .copyOption(CopyOptions.InApp)
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .backgroundColor(entry.role === 'user' ? this.theme().accentSurface : this.theme().surface)
          .border({ width: 1, color: entry.role === 'user' ? this.theme().accentBorder : this.theme().border })
          .borderRadius(10)
      }
      .alignItems(HorizontalAlign.Start)
      .constraintSize({ maxWidth: '88%' })
      if (entry.role !== 'user') {
        Blank()
      }
    }.width('100%')
  }
}
