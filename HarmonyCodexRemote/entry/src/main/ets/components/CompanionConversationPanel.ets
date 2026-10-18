import { AppThemeTokens, appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';
import { VoiceTranscriptEntry } from '../model/BridgeModels';
import { CompanionCallRecord, CompanionProfile, CompanionTextMessage } from '../model/CompanionModels';
import { CompanionHistoryReducer } from '../services/CompanionHistoryReducer';
import { VoiceTranscriptPresentation } from '../services/VoiceTranscriptPresentation';
import {
  parseSessionMarkdownInline,
  parseSessionMarkdownTable,
  SessionMarkdownInlineSegment
} from '../services/SessionPresentationService';

interface CompanionMarkdownBlock {
  id: string;
  kind: string;
  text: string;
  level: number;
  marker: string;
  checked: boolean;
  language: string;
}

function parseCompanionMarkdownBlocks(markdown: string): CompanionMarkdownBlock[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: CompanionMarkdownBlock[] = [];
  let paragraph: string[] = [];

  const pushBlock = (kind: string, text: string, level: number = 0, marker: string = '',
    checked: boolean = false, language: string = ''): void => {
    blocks.push({
      id: `companion-markdown-${blocks.length}`,
      kind,
      text,
      level,
      marker,
      checked,
      language
    });
  };
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      pushBlock('paragraph', paragraph.join('\n'));
      paragraph = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```+|~~~+)\s*([\w.+-]*)\s*$/);
    if (fence !== null) {
      flushParagraph();
      const fenceMark = fence[1].charAt(0);
      const closingFence = new RegExp(`^${fenceMark}{${fence[1].length},}\\s*$`);
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closingFence.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      pushBlock('code', codeLines.join('\n'), 0, '', false, fence[2] ?? '');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading !== null) {
      flushParagraph();
      pushBlock('heading', heading[2], heading[1].length);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      pushBlock('rule', '');
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      pushBlock('quote', quoteLines.join('\n'));
      continue;
    }

    if (index + 1 < lines.length && line.indexOf('|') >= 0 && lines[index + 1].indexOf('|') >= 0
      && parseSessionMarkdownTable(`${line}\n${lines[index + 1]}`).headers.length > 0) {
      flushParagraph();
      const tableLines: string[] = [];
      const tableColumns = parseSessionMarkdownTable(`${line}\n${lines[index + 1]}`).headers.length;
      while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim().length > 0
        && companionMarkdownTableCellCount(lines[index]) === tableColumns) {
        tableLines.push(lines[index]);
        index += 1;
      }
      pushBlock('table', tableLines.join('\n'));
      continue;
    }

    const task = line.match(/^(\s*)[-+*]\s+\[([ xX])\]\s+(.+)$/);
    if (task !== null) {
      flushParagraph();
      pushBlock('task', task[3], Math.min(4, Math.floor(task[1].length / 2)), '',
        task[2].toLowerCase() === 'x');
      index += 1;
      continue;
    }

    const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/);
    if (unordered !== null) {
      flushParagraph();
      pushBlock('list', unordered[2], Math.min(4, Math.floor(unordered[1].length / 2)), '•');
      index += 1;
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered !== null) {
      flushParagraph();
      pushBlock('list', ordered[3], Math.min(4, Math.floor(ordered[1].length / 2)), `${ordered[2]}.`);
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function companionMarkdownTableCellCount(line: string): number {
  let value = line.trim();
  if (value.startsWith('|')) {
    value = value.slice(1);
  }
  if (value.endsWith('|')) {
    value = value.slice(0, value.length - 1);
  }
  return value.indexOf('|') < 0 ? 0 : value.split('|').length;
}

@ComponentV2
export struct CompanionConversationPanel {
  @Param profile: CompanionProfile | null = null;
  @Param entries: VoiceTranscriptEntry[] = [];
  @Param calls: CompanionCallRecord[] = [];
  @Param textMessages: CompanionTextMessage[] = [];
  @Param draft: string = '';
  @Param textReady: boolean = false;
  @Param textError: string = '';
  @Param voiceOngoing: boolean = false;
  @Param loading: boolean = false;
  @Param errorMessage: string = '';
  @Param transcriptStorageError: string = '';
  @Param hasOlder: boolean = false;
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Event onBack: () => void = () => {};
  @Event onComputer: () => void = () => {};
  @Event onVoice: () => void = () => {};
  @Event onDraftChange: (text: string) => void = (_text: string) => {};
  @Event onSendText: () => void = () => {};
  @Event onRecoverText: (message: CompanionTextMessage) => void = (_message: CompanionTextMessage) => {};
  @Event onRefresh: () => void = () => {};
  @Event onLoadEarlier: () => void = () => {};
  @Event onMarkdownLink: (href: string) => void = (_href: string) => {};
  @Event onRetryTranscriptSave: (entry: VoiceTranscriptEntry) => void = (_entry: VoiceTranscriptEntry) => {};
  @Local avatarFailed: boolean = false;
  @Local callsExpanded: boolean = false;
  private messagesScroller: Scroller = new Scroller();
  private avatarUrl: string = '';
  private latestSignature: string = '';

  private theme(): AppThemeTokens {
    return appThemeTokens(this.darkMode);
  }

  private fs(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  @Monitor('profile')
  private onProfileChanged(): void {
    const url = this.profile?.avatarUrl ?? '';
    if (url !== this.avatarUrl) {
      this.avatarFailed = false;
      this.avatarUrl = url;
      this.callsExpanded = false;
    }
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

  @Monitor('textMessages')
  private onTextMessagesChanged(): void {
    if (this.textMessages.length > 0) {
      setTimeout(() => {
        try { this.messagesScroller.scrollEdge(Edge.Bottom); } catch (_) {}
      }, 60);
    }
  }

  build() {
    Column({ space: 8 }) {
      this.HeaderBar()

      if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .width('100%').fontSize(this.fs(12))
          .fontColor(this.theme().danger)
          .padding(10).backgroundColor(this.theme().dangerSurface).borderRadius(10)
      }

      if (this.transcriptStorageError.length > 0) {
        Text(this.transcriptStorageError)
          .width('100%').fontSize(this.fs(11))
          .fontColor(this.theme().danger)
          .padding({ left: 10, right: 10, top: 7, bottom: 7 })
          .backgroundColor(this.theme().dangerSurface).borderRadius(9)
      }

      if (this.hasPhoneTranscripts()) {
        Row({ space: 6 }) {
          Text('•').fontSize(this.fs(12)).fontColor(this.theme().textTertiary)
          Text('手机转写 · 未确认同步到 Codex')
            .fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
        }
        .width('100%').padding({ left: 2, top: 2, bottom: 1 })
      }

      if (VoiceTranscriptPresentation.visible(this.entries).length === 0 && this.calls.length === 0
        && this.textMessages.length === 0) {
        Column({ space: 8 }) {
          Text(this.loading ? '正在同步会话…' : '暂无聊天记录')
            .fontSize(this.fs(15)).fontColor(this.theme().textSecondary)
          Text(`发送文字或接通语音，和${this.profile?.name ?? '个人助手'}对话`)
            .fontSize(this.fs(12)).fontColor(this.theme().textTertiary)
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else {
        List({ space: 10, scroller: this.messagesScroller }) {
          if (this.hasOlder) {
            ListItem() {
              Button(this.loading ? '正在加载…' : '加载更早消息')
                .fontSize(this.fs(12)).height(36)
                .fontColor(this.theme().textSecondary)
                .backgroundColor(this.theme().surfaceMuted)
                .enabled(!this.loading)
                .onClick(() => this.onLoadEarlier())
            }
          }
          if (this.calls.length > 0) {
            ListItem() {
              Row({ space: 8 }) {
                Text(`语音通话记录（${this.calls.length}）`)
                  .fontSize(this.fs(12)).fontWeight(FontWeight.Medium)
                  .fontColor(this.theme().textSecondary)
                Blank()
                if (this.calls.length > 1) {
                  Button(this.callsExpanded ? '收起' : `查看其余 ${this.calls.length - 1} 条`)
                    .fontSize(this.fs(10)).height(28)
                    .fontColor(this.theme().accent)
                    .backgroundColor(this.theme().accentSurface)
                    .onClick(() => { this.callsExpanded = !this.callsExpanded; })
                }
              }.width('100%')
            }
            ForEach(this.visibleCalls(), (call: CompanionCallRecord) => {
              ListItem() {
                this.CallRecordCard(call)
              }
            }, (call: CompanionCallRecord) => `${call.callId}:${call.messageId}`)
          }
          ForEach(VoiceTranscriptPresentation.visible(this.entries), (entry: VoiceTranscriptEntry) => {
            ListItem() {
              this.MessageBubble(entry)
            }
          }, (entry: VoiceTranscriptEntry) => `${entry.itemId ?? ''}:${entry.role}:${entry.text}`)
          ForEach(this.textMessages, (message: CompanionTextMessage) => {
            ListItem() {
              this.TextMessageBubble(message)
            }
          }, (message: CompanionTextMessage) => message.requestId)
        }.layoutWeight(1).width('100%').scrollBar(BarState.Auto)
      }

      this.TextComposer()
    }
    .width('100%').height('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 14 })
    .backgroundColor(this.theme().canvas)
  }

  @Builder
  private HeaderBar() {
    Row({ space: 10 }) {
      Button() {
        SymbolGlyph($r('sys.symbol.chevron_left')).fontSize(19).fontColor([this.theme().textSecondary])
      }
        .width(40).height(44).accessibilityText('返回会话列表')
        .backgroundColor(Color.Transparent)
        .onClick(() => this.onBack())

      if (this.profile?.avatarUrl && !this.avatarFailed) {
        Image(this.profile.avatarUrl)
          .width(40).height(40).borderRadius(20)
          .objectFit(ImageFit.Contain)
          .onError(() => { this.avatarFailed = true; })
      } else {
        Text((this.profile?.name ?? '助手').substring(0, 1)).width(38).height(38).borderRadius(19)
          .textAlign(TextAlign.Center)
          .fontSize(this.fs(15)).fontColor(this.theme().textPrimary)
          .backgroundColor(this.theme().accentSurface)
      }

      Column({ space: 2 }) {
        Text(this.profile?.name ?? '个人助手')
          .fontSize(this.fs(16)).fontWeight(FontWeight.Bold)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontColor(this.theme().textPrimary)
        Text('个人助手')
          .fontSize(this.fs(11)).fontColor(this.theme().textSecondary)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)

      Button() {
        this.ComputerGlyph()
      }
        .width(40).height(44).accessibilityText('打开云电脑')
        .backgroundColor(Color.Transparent)
        .enabled(this.profile !== null)
        .onClick(() => this.onComputer())
    }.width('100%').alignItems(VerticalAlign.Center)
  }

  @Builder
  private ComputerGlyph() {
    Column({ space: 2 }) {
      Column()
        .width(18).height(12)
        .border({ width: 1.4, color: this.theme().textSecondary })
        .borderRadius(2)
      Column()
        .width(2).height(3)
        .backgroundColor(this.theme().textSecondary)
      Row()
        .width(12).height(1.4)
        .backgroundColor(this.theme().textSecondary)
        .borderRadius(1)
    }
    .width(24).height(24)
    .alignItems(HorizontalAlign.Center)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  private TextComposer() {
    Column({ space: 5 }) {
      if (this.textError.length > 0) {
        Text(this.textError).width('100%').fontSize(this.fs(11)).fontColor(this.theme().danger)
      }
      Row({ space: 8 }) {
        TextArea({ text: this.draft, placeholder: `发消息给${this.profile?.name ?? '个人助手'}…` })
          .layoutWeight(1).height(this.draft.indexOf('\n') >= 0 || this.draft.length > 40 ? 96 : 48)
          .maxLength(20000).fontSize(this.fs(14)).fontColor(this.theme().textPrimary)
          .enabled(this.textReady && this.profile !== null)
          .backgroundColor(this.theme().surfaceSubtle).borderRadius(12)
          .padding({ left: 12, right: 10, top: 12, bottom: 10 })
          .onChange((value: string) => this.onDraftChange(value))
          .accessibilityText('个人助手文字消息')
        Button('发送')
          .width(56).height(44).padding({ left: 0, right: 0 }).fontSize(this.fs(13)).fontColor(this.theme().textOnAccent)
          .backgroundColor(this.theme().accent).borderRadius(12)
          .enabled(this.textReady && this.profile !== null && this.draft.trim().length > 0)
          .onClick(() => this.onSendText())
        Button(this.voiceOngoing ? '通话' : '语音')
          .width(48).height(44).padding({ left: 0, right: 0 }).fontSize(this.fs(12)).fontColor(this.theme().accent)
          .backgroundColor(this.theme().accentSurface).borderRadius(12)
          .enabled(this.voiceOngoing || this.profile !== null)
          .accessibilityText(this.voiceOngoing ? '返回正在进行的语音通话' : '开始语音对话')
          .onClick(() => this.onVoice())
      }.width('100%').alignItems(VerticalAlign.Bottom)
      Text(this.voiceOngoing ? '通话中仍可继续打字' : '可输入多行文字 · 随时开始语音对话')
        .width('100%').fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
    }.width('100%').padding({ top: 7 })
  }

  @Builder
  private TextMessageBubble(message: CompanionTextMessage) {
    Row() {
      Blank()
      Column({ space: 5 }) {
        this.MarkdownContent(message.text, true)
        Flex({ wrap: FlexWrap.Wrap, alignItems: ItemAlign.Center }) {
          Text(message.state === 'pending' ? '发送中…'
            : message.state === 'submitted' ? '已提交 · 等待官方记录确认'
              : message.state === 'failed' ? '发送失败' : '发送结果待确认')
            .fontSize(this.fs(10))
            .fontColor(message.state === 'failed' ? this.theme().danger : this.theme().textSecondary)
          if (message.state === 'failed') {
            Button('恢复文字').height(32).fontSize(this.fs(10))
              .fontColor(this.theme().accent).backgroundColor(Color.Transparent)
              .enabled(this.draft.length === 0).onClick(() => this.onRecoverText(message))
          } else if (message.state === 'uncertain' || message.state === 'submitted') {
            Button('核对记录').height(32).fontSize(this.fs(10))
              .fontColor(this.theme().accent).backgroundColor(Color.Transparent)
              .onClick(() => this.onRefresh())
          }
        }.width('100%')
        if (message.detail.length > 0) {
          Text(message.detail).width('100%').fontSize(this.fs(10))
            .fontColor(this.theme().textSecondary)
        }
      }.width('92%').padding(12).backgroundColor(this.theme().accentSurface).borderRadius(13)
    }.width('100%')
  }

  @Builder
  private MessageBubble(entry: VoiceTranscriptEntry) {
    Row() {
      if (entry.role === 'user') {
        Blank()
      }
      Column() {
        if (entry.phoneTranscript === true) {
          Row({ space: 6 }) {
            Text(this.phoneTranscriptStatusLabel(entry.localStorageStatus))
              .fontSize(this.fs(9)).fontColor(entry.localStorageStatus === 'failed'
                ? this.theme().danger : this.theme().textTertiary)
            if (entry.localStorageStatus === 'failed') {
              Button('重试保存')
                .height(24).fontSize(this.fs(9))
                .fontColor(this.theme().accent)
                .backgroundColor(this.theme().accentSurface)
                .onClick(() => this.onRetryTranscriptSave(entry))
            }
          }.width('100%').padding({ bottom: 3 })
        }
        this.MarkdownContent(VoiceTranscriptPresentation.text(entry), entry.role === 'user')
      }
      .width(entry.role === 'user' ? '92%' : '100%')
      .padding(entry.role === 'user' ? { left: 12, right: 12, top: 9, bottom: 9 } : 0)
      .backgroundColor(entry.role === 'user' ? this.theme().accentSurface : Color.Transparent)
      .borderRadius(13)
      if (entry.role !== 'user') {
        Blank()
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  private CallRecordCard(call: CompanionCallRecord) {
    Column({ space: 5 }) {
      Row({ space: 6 }) {
        Text('语音通话')
          .fontSize(this.fs(12)).fontWeight(FontWeight.Medium)
          .fontColor(this.theme().textPrimary)
        Blank()
        Text(this.callOutcomeLabel(call.outcome))
          .fontSize(this.fs(10)).fontColor(this.theme().textSecondary)
      }.width('100%')
      Text(`${this.callCreatedLabel(call.createdAt)} · ${this.callDurationLabel(call.durationMs)}`)
        .fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
      Text(CompanionHistoryReducer.transcriptStatusLabel(call.transcriptStatus))
        .fontSize(this.fs(10))
        .fontColor(call.transcriptStatus.toLowerCase() === 'unavailable'
          ? this.theme().danger : this.theme().textSecondary)
      if (call.summary !== null && call.summary.length > 0) {
        Text(call.summary)
          .fontSize(this.fs(11)).fontColor(this.theme().textPrimary)
          .lineHeight(this.fs(18)).width('100%')
      }
    }
    .width('100%').padding(10)
    .backgroundColor(this.theme().surfaceSubtle)
    .border({ width: 0.8, color: this.theme().border })
    .borderRadius(10)
  }

  private hasPhoneTranscripts(): boolean {
    return this.entries.some((entry: VoiceTranscriptEntry) => entry.phoneTranscript === true);
  }

  private phoneTranscriptStatusLabel(status: 'pending' | 'saved' | 'failed' | undefined): string {
    if (status === 'saved') {
      return '手机转写 · 本机已保存，未确认同步到 Codex';
    }
    if (status === 'failed') {
      return '手机转写 · 本机保存失败，未确认同步到 Codex';
    }
    return '手机转写 · 本机保存中，未确认同步到 Codex';
  }

  private visibleCalls(): CompanionCallRecord[] {
    if (this.callsExpanded || this.calls.length <= 1) {
      return this.calls;
    }
    return this.calls.slice(this.calls.length - 1);
  }

  private callCreatedLabel(value: string): string {
    if (value.trim().length === 0) {
      return '时间未知';
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return value;
    }
    return new Date(timestamp).toLocaleString('zh-CN');
  }

  private callDurationLabel(durationMs: number | null): string {
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
      return '时长未知';
    }
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  }

  private callOutcomeLabel(outcome: string): string {
    const normalized = String(outcome ?? '').trim().toLowerCase();
    if (normalized === 'completed' || normalized === 'success' || normalized === 'ended') {
      return '已结束';
    }
    if (normalized === 'failed' || normalized === 'error') {
      return '异常结束';
    }
    if (normalized === 'interrupted') {
      return '已中断';
    }
    if (normalized === 'cancelled' || normalized === 'canceled') {
      return '已取消';
    }
    return normalized.length > 0 && normalized !== 'unknown' ? `状态：${outcome}` : '通话状态未知';
  }

  @Builder
  private MarkdownContent(markdown: string, isUser: boolean) {
    Column({ space: 7 }) {
      ForEach(parseCompanionMarkdownBlocks(markdown), (block: CompanionMarkdownBlock) => {
        this.MarkdownBlock(block, isUser)
      }, (block: CompanionMarkdownBlock) => block.id)
    }
    .width('100%')
  }

  @Builder
  private MarkdownBlock(block: CompanionMarkdownBlock, isUser: boolean) {
    if (block.kind === 'heading') {
      this.InlineText(block.text, isUser, this.headingSize(block.level), true)
    } else if (block.kind === 'code') {
      Column({ space: 4 }) {
        if (block.language.length > 0) {
          Text(block.language)
            .fontSize(this.fs(10)).fontColor(this.theme().textTertiary)
        }
        Scroll() {
          Text(block.text)
            .width(this.codeContentWidth(block.text))
            .fontSize(this.fs(12)).fontColor(this.theme().textPrimary)
            .fontFamily('monospace').lineHeight(this.fs(18))
            .copyOption(CopyOptions.LocalDevice)
        }
        .scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Auto)
        .width('100%')
      }
      .width('100%').padding(10)
      .backgroundColor(this.theme().surfaceMuted)
      .borderRadius(9)
    } else if (block.kind === 'quote') {
      Row({ space: 9 }) {
        Column().width(2).alignSelf(ItemAlign.Stretch)
          .backgroundColor(this.theme().borderStrong).borderRadius(1)
        Column() {
          this.MarkdownContent(block.text, isUser)
        }.layoutWeight(1)
      }
      .width('100%').padding({ top: 2, bottom: 2 })
    } else if (block.kind === 'list' || block.kind === 'task') {
      Row({ space: 7 }) {
        Text(block.kind === 'task' ? (block.checked ? '✓' : '○') : block.marker)
          .fontSize(this.fs(13)).fontColor(this.theme().textSecondary)
          .width(block.kind === 'task' ? 15 : 22).textAlign(TextAlign.Start)
        Column() {
          this.InlineText(block.text, isUser, 15, false)
        }.layoutWeight(1)
      }
      .width('100%')
      .padding({ left: Math.min(16, block.level * 10), right: 0, top: 1, bottom: 1 })
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === 'table') {
      this.MarkdownTable(block, isUser)
    } else if (block.kind === 'rule') {
      Row().height(1).width('100%').backgroundColor(this.theme().border)
    } else {
      this.InlineText(block.text, isUser, isUser ? 14 : 15, false)
    }
  }

  @Builder
  private InlineText(text: string, isUser: boolean, fontSize: number, isHeading: boolean) {
    Text() {
      ForEach(parseSessionMarkdownInline(text), (segment: SessionMarkdownInlineSegment) => {
        if (segment.kind === 'strong') {
          Span(segment.text).fontWeight(FontWeight.Bold)
        } else if (segment.kind === 'emphasis') {
          Span(segment.text).fontStyle(FontStyle.Italic)
        } else if (segment.kind === 'strike') {
          Span(segment.text).decoration({ type: TextDecorationType.LineThrough })
        } else if (segment.kind === 'code') {
          Span(segment.text)
            .fontFamily('monospace')
            .fontColor(this.theme().textPrimary)
            .textBackgroundStyle({
              color: isUser ? this.theme().accentSurfaceStrong : this.theme().surfaceMuted,
              radius: 4
            })
        } else if (segment.kind === 'link') {
          Span(segment.text)
            .fontColor(this.theme().accent)
            .decoration({ type: TextDecorationType.Underline })
            .onClick(() => this.onMarkdownLink(segment.href))
        } else {
          Span(segment.text)
        }
      }, (segment: SessionMarkdownInlineSegment) => segment.id)
    }
    .fontSize(this.fs(fontSize))
    .fontColor(this.theme().textPrimary)
    .fontWeight(isHeading ? FontWeight.Bold : FontWeight.Regular)
    .lineHeight(this.fs(isHeading ? fontSize + 7 : fontSize + 8))
    .width('100%')
    .copyOption(CopyOptions.LocalDevice)
  }

  @Builder
  private MarkdownTable(block: CompanionMarkdownBlock, isUser: boolean) {
    Scroll() {
      Column({ space: 0 }) {
        Row() {
          ForEach(parseSessionMarkdownTable(block.text).headers, (cell: string, index: number) => {
            this.MarkdownTableCell(cell, true, isUser, block)
          }, (cell: string, index: number) => `companion-table-header-${index}-${cell}`)
        }
        ForEach(parseSessionMarkdownTable(block.text).rows, (row: string[], rowIndex: number) => {
          Row() {
            ForEach(row, (cell: string, columnIndex: number) => {
              this.MarkdownTableCell(cell, false, isUser, block)
            }, (cell: string, columnIndex: number) => `companion-table-${rowIndex}-${columnIndex}-${cell}`)
          }
        }, (row: string[], rowIndex: number) => `companion-table-row-${rowIndex}`)
      }
      .width(this.tableContentWidth(block))
    }
    .scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Auto)
    .width('100%')
    .borderRadius(8)
  }

  @Builder
  private MarkdownTableCell(cell: string, isHeader: boolean, isUser: boolean, block: CompanionMarkdownBlock) {
    Column() {
      this.InlineText(cell, isUser, 12, isHeader)
    }
    .width(this.tableColumnWidth(block))
    .constraintSize({ minHeight: 36 })
    .alignSelf(ItemAlign.Stretch)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .backgroundColor(isHeader ? this.theme().surfaceMuted : Color.Transparent)
    .border({ width: 0.6, color: this.theme().border })
  }

  private headingSize(level: number): number {
    if (level <= 1) {
      return 20;
    }
    if (level === 2) {
      return 18;
    }
    if (level === 3) {
      return 17;
    }
    return 16;
  }

  private codeContentWidth(text: string): number {
    const lines = text.split('\n');
    let longest = 0;
    lines.forEach((line: string) => {
      const widthUnits = line.replace(/[^\x00-\xFF]/g, 'xx').length;
      longest = Math.max(longest, widthUnits);
    });
    return Math.max(1, Math.ceil(longest * this.fs(12) * 0.66 + 20));
  }

  private tableColumnWidth(block: CompanionMarkdownBlock): number {
    const columns = Math.max(1, parseSessionMarkdownTable(block.text).headers.length);
    return Math.max(112, Math.min(176, Math.floor(720 / columns)));
  }

  private tableContentWidth(block: CompanionMarkdownBlock): number {
    return Math.max(1, parseSessionMarkdownTable(block.text).headers.length) * this.tableColumnWidth(block);
  }
}
