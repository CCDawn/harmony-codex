from pathlib import Path
p=Path('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets')
s=p.read_text(encoding='utf-8')
start=s.index('  @Builder\n  HomeHeaderActions(')
end=s.index('  @Builder\n  HomeActionButton(',start)
s=s[:start]+'''  @Builder
  HomeHeaderActions(source: string) {
    Row({ space: 8 }) {
      Button() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(21).fontColor([this.themeColor('#FFFFFF')])
      }
      .width(44).height(44).borderRadius(22)
      .accessibilityText('新建会话')
      .backgroundColor(this.themeColor('#14853D'))
      .enabled(this.canStartNewSessionDraft())
      .onClick(() => {
        this.homeActionMenuVisible = false;
        this.homeActionMenuSource = '';
        this.startNewSessionDraft();
      })
      Button() {
        SymbolGlyph($r('sys.symbol.list_bullet'))
          .fontSize(20)
          .fontColor([this.homeActionMenuVisible ? this.theme().accent : this.theme().textPrimary])
      }
      .width(44).height(44).borderRadius(22)
      .accessibilityText('会话菜单')
      .backgroundColor(this.homeActionMenuVisible ? this.theme().accentSurface : this.theme().surfaceMuted)
      .onClick(() => this.toggleHomeActionMenu(source))
    }
  }

'''+s[end:]
s=s.replace("this.HomeActionMenuItem('pairing', '配对', '设备与连接状态',", "this.HomeActionMenuItem('pairing', '配对', '',")
s=s.replace("this.HomeActionMenuItem('settings', '设置', '语音、外观与账号维护',", "this.HomeActionMenuItem('settings', '设置', '',")
s=s.replace("          this.HomeActionMenuItem('voice_call', `${this.companionProfile?.name ?? '个人助手'}语音`, '和个人助手实时对话', this.theme().accent, source)\n",'')
s=s.replace('3 * Math.max(48, this.scaledFontSize(12) * 3.5) + 28','2 * Math.max(44, this.scaledFontSize(14) + 20) + 22')
s=s.replace('    .width(248)\n',"    .width(Math.min(208, Math.max(140, (this.sessionWindowWidthVp() || 360) - 28)))\n")
a=s.index('  HomeActionMenuItem('); b=s.index('  @Builder\n  HomeActionIcon',a)
t=s[a:b].replace('this.scaledFontSize(12)','this.scaledFontSize(14)')
t=t.replace("            .fontColor(this.themeColor('#17202A'))\n", "            .fontColor(this.themeColor('#17202A'))\n            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })\n")
t=t.replace('          Text(description)', "          if (description.length > 0) {\n          Text(description)")
t=t.replace("            .textOverflow({ overflow: TextOverflow.Ellipsis })\n        }", "            .textOverflow({ overflow: TextOverflow.Ellipsis })\n          }\n        }")
t=t.replace('Math.max(48, this.scaledFontSize(14) * 3.5)','Math.max(44, this.scaledFontSize(14) + 20)')
s=s[:a]+t+s[b:]
s=s.replace("      if (action === 'theme') {", "      if (action === 'pairing') {\n        SymbolGlyph($r('sys.symbol.qrcode')).fontSize(19).fontColor([color])\n      } else if (action === 'settings') {\n        SymbolGlyph($r('sys.symbol.gearshape')).fontSize(19).fontColor([color])\n      } else if (action === 'theme') {",1)
a=s.index('  SessionSidebar() {'); b=s.index('  @Builder\n  SessionSectionLabel',a)
t=s[a:b]
summary="""            Text(this.sessionMonitorSummaryText())
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#68717D'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
"""
assert summary in t
t=t.replace(summary,'')
t=t.replace('          Button() {', "          if (!this.isLandscapeSessionLayout() && (this.selectedSession !== null || this.isNewSessionDraft || this.companionSelected)) {\n          Button() {",1)
t=t.replace('.width(36)\n            .height(36)', '.width(44)\n            .height(44)')
t=t.replace('.borderRadius(18)', ".borderRadius(22)\n            .accessibilityText('返回会话')")
t=t.replace('          this.HomeHeaderActions', '          }\n\n          this.HomeHeaderActions',1)
old="""        Text(this.sessionRefreshHintText())
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#8A95A3'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
"""
new="""        Text(this.isPullRefreshingSessions || this.deletingSessionId.length > 0
          ? this.sessionRefreshHintText() : this.sessionMonitorSummaryText())
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.theme().textTertiary)
          .width('100%').maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
"""
assert old in t
t=t.replace(old,new)
t=t.replace("        this.HomeActionMenu('sidebar_header')", "        Row().width('100%').height('100%')\n          .backgroundColor(Color.Transparent)\n          .onClick(() => { this.homeActionMenuVisible = false; this.homeActionMenuSource = ''; })\n        this.HomeActionMenu('sidebar_header')")
s=s[:a]+t+s[b:]
s=s.replace("          .textOverflow({ overflow: TextOverflow.Ellipsis })\n        Blank()\n        Text(this.projectGroupMetaText", "          .textOverflow({ overflow: TextOverflow.Ellipsis })\n          .layoutWeight(1)\n        Text(this.projectGroupMetaText")
s=s.replace("      .height(34)\n      .padding({ left: 4, right: 6 })", "      .constraintSize({ minHeight: 44 })\n      .padding({ left: 4, right: 6, top: 6, bottom: 6 })")
s=s.replace("  CompanionSidebarItem() {\n    Row({ space: 10 }) {\n      if (this.companionProfile?.avatarUrl)", "  CompanionSidebarItem() {\n    Row({ space: 10 }) {\n      if (this.companionProfile?.avatarUrl && !this.companionAvatarFailed)")
s=s.replace('.width(38).height(38).borderRadius(19).objectFit(ImageFit.Contain)', '.width(38).height(38).borderRadius(19).objectFit(ImageFit.Contain)\n          .onError(() => { this.companionAvatarFailed = true; })')
s=s.replace("Text('熊').width(38)", "Text((this.companionProfile?.name ?? '助手').substring(0, 1)).width(38)")
s=s.replace("        Text('个人助手 · 语音对话')", "        Text('个人助手')")
s=s.replace("          .fontSize(this.scaledFontSize(16)).fontWeight(FontWeight.Medium)\n          .fontColor(this.theme().textPrimary)", "          .fontSize(this.scaledFontSize(16)).fontWeight(FontWeight.Medium)\n          .fontColor(this.theme().textPrimary)\n          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })")
s=s.replace(".width('100%').height(58).padding({ left: 8, right: 8 })", ".width('100%').constraintSize({ minHeight: 64 }).padding({ left: 8, right: 8, top: 8, bottom: 8 })")
s=s.replace("return this.voiceCallStatus !== 'connecting' && this.voiceCallStatus !== 'active' && this.voiceCallStatus !== 'ready';", 'return true;')
s=s.replace('        profile: this.companionProfile,\n        entries:', "        profile: this.companionProfile,\n        voiceOngoing: this.voiceCallStatus === 'connecting' || this.voiceCallStatus === 'ready' || this.voiceCallStatus === 'active',\n        entries:")
s=s.replace("        assistantName: this.companionProfile?.name ?? '个人助手',\n",'')
s=s.replace('      this.companionProfile = profile;', "      if (this.companionProfile?.avatarUrl !== profile.avatarUrl) {\n        this.companionAvatarFailed = false;\n      }\n      this.companionProfile = profile;")
pos=s.index("  @State companionProfile:") if '  @State companionProfile:' in s else -1
assert pos>=0
s=s[:pos]+"  @State companionAvatarFailed: boolean = false;\n"+s[pos:]
p.write_text(s,encoding='utf-8')
p=Path('HarmonyCodexRemote/entry/src/main/ets/components/SettingsPanel.ets')
s=p.read_text(encoding='utf-8').replace("  @Param assistantName: string = '个人助手';\n",'').replace("            this.Action('voice_call', `打开${this.assistantName}语音`)\n",'')
p.write_text(s,encoding='utf-8')
p=Path('HarmonyCodexRemote/entry/src/main/ets/components/CompanionConversationPanel.ets')
s=p.read_text(encoding='utf-8').replace('  @Param loading:', '  @Param voiceOngoing: boolean = false;\n  @Param loading:')
s=s.replace('  private latestSignature:', "  private avatarUrl: string = '';\n  private latestSignature:")
s=s.replace("  @Monitor('entries')", "  @Monitor('profile')\n  private onProfileChanged(): void {\n    const url = this.profile?.avatarUrl ?? '';\n    if (url !== this.avatarUrl) {\n      this.avatarFailed = false;\n      this.avatarUrl = url;\n    }\n  }\n\n  @Monitor('entries')")
s=s.replace("Text('熊').width(40)","Text((this.profile?.name ?? '助手').substring(0, 1)).width(40)")
s=s.replace("            .fontSize(this.fs(18)).fontWeight(FontWeight.Bold)\n", "            .fontSize(this.fs(18)).fontWeight(FontWeight.Bold)\n            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })\n")
s=s.replace("Button('语音通话')", "Button(this.voiceOngoing ? '返回通话' : '语音通话')")
s=s.replace('.enabled(this.profile !== null)\n        .onClick(() => this.onVoice())', '.enabled(this.voiceOngoing || this.profile !== null)\n        .onClick(() => this.onVoice())')
s=s.replace("Button('返回')\n          .height(32)", "Button() {\n          SymbolGlyph($r('sys.symbol.chevron_left')).fontSize(20).fontColor([this.theme().textPrimary])\n        }\n          .width(44).height(44).accessibilityText('返回会话列表')")
s=s.replace("Button('电脑')\n          .height(32)", "Button('电脑')\n          .constraintSize({ minWidth: 60 }).height(44)")
p.write_text(s,encoding='utf-8')
