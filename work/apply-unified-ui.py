from pathlib import Path
p=Path('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');s=p.read_text(encoding='utf-8');Path('work/ui-unified-index-before.ets').write_text(s,encoding='utf-8')
s=s.replace("  @State companionAvatarFailed:","  @State sessionSearchQuery: string = '';\n  @State companionAvatarFailed:")
s=s.replace("        onVoice: () => this.openVoiceCall('companion_conversation')", "        onMarkdownLink: (href: string) => { void this.handleMarkdownReaderLink(href); },\n        onVoice: () => this.openVoiceCall('companion_conversation')")
a=s.index('  HomeHeaderActions(');b=s.index('  @Builder\n  HomeActionButton',a);t=s[a:b];t=t.replace(".fontColor([this.themeColor('#FFFFFF')])",".fontColor([this.theme().textPrimary])").replace(".backgroundColor(this.themeColor('#14853D'))",".backgroundColor(Color.Transparent)").replace("this.theme().accentSurface : this.theme().surfaceMuted","this.theme().accentSurface : Color.Transparent");s=s[:a]+t+s[b:]
a=s.index('  SessionSidebar() {');b=s.index('  @Builder\n  SessionSectionLabel',a);t=s[a:b]
start=t.index('        Text(this.isPullRefreshingSessions');end=t.index('        Refresh(',start)
t=t[:start]+'''        TextInput({ text: this.sessionSearchQuery, placeholder: '搜索会话' })
          .height(40).fontSize(this.scaledFontSize(13))
          .fontColor(this.theme().textPrimary).placeholderColor(this.theme().textSecondary)
          .backgroundColor(this.theme().surfaceMuted).borderRadius(10)
          .padding({ left: 12, right: 12 })
          .onChange((value: string) => { this.sessionSearchQuery = value; })

        if (this.sessionSearchQuery.trim().length === 0
          || (this.companionProfile?.name ?? '个人助手').toLowerCase().includes(this.sessionSearchQuery.trim().toLowerCase())) {
          this.CompanionSidebarItem()
        }

'''+t[end:]
t=t.replace("                this.PinnedSessionGroup()", "                if (this.sessionSearchQuery.trim().length > 0) {\n                  ForEach(this.searchSessionResults(), (session: CodexSessionSummary) => {\n                    this.SessionSidebarItem(session)\n                  }, (session: CodexSessionSummary) => this.sessionSidebarItemKey(session))\n                  if (this.searchSessionResults().length === 0) {\n                    Text('没有匹配的项目会话').fontSize(this.scaledFontSize(13))\n                      .fontColor(this.theme().textSecondary).padding(24)\n                  }\n                } else {\n                this.PinnedSessionGroup()")
t=t.replace('                this.RecentSessionGroup()','                this.RecentSessionGroup()\n                }')
t=t.replace('.edgeEffect(EdgeEffect.Spring)','.edgeEffect(EdgeEffect.Spring)\n            .align(Alignment.TopStart)')
t=t.replace("      .backgroundColor(this.themeColor('#FFFFFF'))", "      .backgroundColor(this.theme().surfaceSubtle)")
s=s[:a]+t+s[b:]
pos=s.index('  private sessionProjectLabels():')
s=s[:pos]+'''  private searchSessionResults(): CodexSessionSummary[] {
    const query = this.sessionSearchQuery.trim().toLowerCase();
    return this.sessions.filter((session: CodexSessionSummary) =>
      `${session.title} ${session.projectLabel ?? ''}`.toLowerCase().includes(query));
  }

'''+s[pos:]
a=s.index('  SessionProjectGroup(');b=s.index('  @Builder\n  CompanionSidebarItem',a);t=s[a:b].replace("this.scaledFontSize(13)","this.scaledFontSize(12)").replace('minHeight: 44','minHeight: 36');s=s[:a]+t+s[b:]
a=s.index('  CompanionSidebarItem()');b=s.index('  @Builder\n  SessionSidebarItem',a);t=s[a:b].replace('this.scaledFontSize(16)','this.scaledFontSize(15)').replace('minHeight: 64','minHeight: 62').replace('this.theme().accentSurface : this.theme().surface','this.theme().accentSurface : this.theme().surfaceSubtle').replace('.borderRadius(8)','.borderRadius(12)');s=s[:a]+t+s[b:]
a=s.index('  SessionSidebarItem(');b=s.index('  @Builder\n  SessionActivityBadge',a);t=s[a:b].replace('this.scaledFontSize(16)','this.scaledFontSize(15)').replace('this.scaledFontSize(13)','this.scaledFontSize(11)').replace('.height(40)', '.height(Math.max(58, this.scaledLineHeight(36)))').replace("this.themeColor('#F0ECE9') : this.themeColor('#FFFFFF')",'this.theme().accentSurface : this.theme().surfaceSubtle');s=s[:a]+t+s[b:]
s=s.replace('Math.ceil(84 * fontScalePercent(this.fontScaleMode) / 100)','Math.ceil(64 * fontScalePercent(this.fontScaleMode) / 100)')
a=s.index('  SessionEntryCard(');b=s.index('  @Builder\n  SessionContentActionRow',a);t=s[a:b].replace(".backgroundColor(this.themeColor('#EAF4FF'))\n            .border({ width: 1, color: this.themeColor('#CFE3FF') })\n            .borderRadius(10)",".backgroundColor(this.theme().surfaceMuted)\n            .borderRadius(14)").replace(".constraintSize({ maxWidth: '82%' })",".constraintSize({ maxWidth: '88%' })").replace(".width('88%')\n      .padding({ left: 12, right: 0, top: 2, bottom: 4 })",".width('100%')\n      .padding({ left: 0, right: 0, top: 8, bottom: 12 })");s=s[:a]+t+s[b:]
a=s.index('  SessionContentActionRow(');b=s.index('  @Builder\n  SessionEntryFoldToggleView',a);t=s[a:b];t=t.replace("Button(imageUrl.length > 0 ? '复制图片' : '复制')", "Button() {\n        SymbolGlyph($r('sys.symbol.doc_on_doc')).fontSize(16).fontColor([this.theme().textSecondary])\n      }\n        .accessibilityText(imageUrl.length > 0 ? '复制图片' : '复制')").replace("Button(imageUrl.length > 0 ? '分享图片' : '分享')", "Button() {\n        SymbolGlyph($r('sys.symbol.square_and_arrow_up')).fontSize(16).fontColor([this.theme().textSecondary])\n      }\n        .accessibilityText(imageUrl.length > 0 ? '分享图片' : '分享')").replace('.height(24)','.width(40).height(40)');s=s[:a]+t+s[b:]
a=s.index('  SessionMarkdownContent(');b=s.index('  @Builder\n  SessionMarkdownInlineText',a);t=s[a:b].replace('Column({ space: 4 })','Column({ space: 10 })',1).replace('isUser ? 12 : 11, isUser ? 17 : 16','15, 25').replace('isUser ? 11 : 10, isUser ? 16 : 15','14, 23');t=t.replace('this.scaledFontSize(10))\n          .fontColor(this.themeColor(\'#101828\'))','this.scaledFontSize(13))\n          .fontColor(this.themeColor(\'#101828\'))').replace('this.scaledLineHeight(14))','this.scaledLineHeight(21))');s=s[:a]+t+s[b:]
a=s.index('  private markdownHeadingFontSize(');b=s.index('  private markdownInlineDisplayText',a);s=s[:a]+'''  private markdownHeadingFontSize(level: number, isUser: boolean): number {
    return level <= 1 ? 19 : level === 2 ? 17 : 16;
  }

  private markdownHeadingLineHeight(level: number, isUser: boolean): number {
    return level <= 1 ? 30 : level === 2 ? 28 : 26;
  }

'''+s[b:]
# Move the existing composer actions below the text area, preserving handlers and attachment tools.
a=s.index('  SessionComposer() {');b=s.index('  @Builder\n  ComposerActionPopup',a);t=s[a:b].replace("Row({ space: 6 }) {\n          TextArea", "Column({ space: 6 }) {\n          TextArea",1).replace("placeholder: ''", "placeholder: '发送消息…'").replace('this.scaledFontSize(12)','this.scaledFontSize(15)').replace(".backgroundColor(this.themeColor('#FFFFFF'))",".backgroundColor(Color.Transparent)",1).replace('            .layoutWeight(1)\n            .onFocus','            .width(\'100%\')\n            .onFocus')
t=t.replace('            Column({ space: 5 }) {','            Row({ space: 8 }) {',1).replace('              Button() {\n                this.SessionPrimaryActionSymbol()',"              Blank()\n              Button() {\n                this.SessionPrimaryActionSymbol()",1).replace('.width(32)','.width(40)').replace('.height(32)','.height(40)').replace('.borderRadius(16)','.borderRadius(10)').replace('          .width(34)\n          .height(this.sessionComposerTextAreaHeight())',"          .width('100%')\n          .height(40)").replace('.translate({ x: 0, y: -234 })','.translate({ x: 0, y: -234 })\n                .alignItems(HorizontalAlign.Start)')
t=t.replace('.alignItems(HorizontalAlign.Center)\n            .zIndex(2)',".width('100%')\n            .alignItems(VerticalAlign.Center)\n            .zIndex(2)").replace('.alignItems(VerticalAlign.Bottom)','.alignItems(HorizontalAlign.Start)').replace('.padding({ left: 6, right: 6, top: 4, bottom: 1 })','.padding({ left: 10, right: 10, top: 8, bottom: 8 })').replace('.borderRadius(8)\n    .margin',".border({ width: 1, color: this.theme().border })\n    .borderRadius(14)\n    .margin");s=s[:a]+t+s[b:]
a=s.index('  private sessionComposerTextAreaHeight()');b=s.index('  private sessionBottomSignature',a);s=s[:a]+'''  private sessionComposerTextAreaHeight(): number {
    const lines = Math.min(4, Math.max(1, this.sessionMessage.split('\\n').length));
    return Math.max(42, this.scaledLineHeight(24) * lines + 12);
  }

'''+s[b:]
p.write_text(s,encoding='utf-8')
p=Path('HarmonyCodexRemote/entry/src/main/ets/theme/AppTheme.ets');s=p.read_text(encoding='utf-8');s=s.replace("canvas: '#F7F8FA'", "canvas: '#FFFFFF'").replace("surfaceSubtle: '#F8FAFC'", "surfaceSubtle: '#F8F9FA'").replace("textSecondary: '#68717D'", "textSecondary: '#65707D'").replace("textTertiary: '#8A95A3'", "textTertiary: '#717C89'").replace("accent: '#1F6FEB'", "accent: '#346BEA'").replace("border: '#DDE3EA'", "border: '#E8EBEE'");p.write_text(s,encoding='utf-8')
