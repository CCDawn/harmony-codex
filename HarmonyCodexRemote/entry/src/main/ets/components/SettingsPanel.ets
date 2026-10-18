import { appThemeTokens, themeModeLabel } from '../theme/AppTheme';
import { scaleFontSize, fontScaleLabel } from '../theme/AppTypography';
import { GuardianStatus, GuardianFault, GuardianHistoryEntry } from '../model/BridgeModels';
import { GuardianPresentation } from '../services/GuardianPresentation';

@ComponentV2
export struct SettingsPanel {
  @Param darkMode: boolean = false;
  @Param themeMode: string = 'system';
  @Param fontScaleMode: string = 'standard';
  @Param backgroundState: string = '未运行';
  @Param voiceState: string = '未开始通话';
  @Param guardian: GuardianStatus | null = null;
  @Param guardianBusy: boolean = false;
  @Param guardianError: string = '';
  @Param initialSection: string = '';
  @Event onGuardianToggle: (enabled: boolean) => void = () => {};
  @Event onGuardianRefresh: () => void = () => {};
  @Event onBack: () => void = () => {};
  @Event onTheme: (mode: string) => void = () => {};
  @Event onFontScale: (mode: string) => void = () => {};
  @Event onAction: (action: string) => void = () => {};
  @Local section: string = '';

  aboutToAppear(): void { this.section = this.initialSection; }

  @Builder
  GuardianDetails() {
    Row({ space: 12 }) {
      Text(this.guardianBusy ? '正在读取 / 保存…' : '自动守护')
        .fontSize(scaleFontSize(14, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
        .layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.guardian?.enabled ?? false })
        .enabled(this.guardian !== null && !this.guardianBusy && this.guardianError.length === 0)
        .accessibilityText('自动守护')
        .onChange((enabled: boolean) => this.onGuardianToggle(enabled))
    }.width('100%').constraintSize({ minHeight: 44 })
    Text('必要时会强制重启 Codex，可能中断任务和通话。模式保存在电脑，桌面重开后继续；手机退出不影响守护。')
      .width('100%').fontSize(scaleFontSize(12, this.fontScaleMode))
      .fontColor(appThemeTokens(this.darkMode).textSecondary)
    if (this.guardianError.length > 0) {
      Text(this.guardianError).width('100%').fontSize(scaleFontSize(13, this.fontScaleMode))
        .fontColor(appThemeTokens(this.darkMode).danger)
    }
    if (this.guardian !== null) {
      Text(this.guardian.summary || GuardianPresentation.phaseLabel(this.guardian.phase))
        .width('100%').fontSize(scaleFontSize(13, this.fontScaleMode))
        .fontColor(appThemeTokens(this.darkMode).textPrimary)
      Text(`上次检查：${GuardianPresentation.localTime(this.guardian.checkedAt, '尚未检查')}\n最近修复：${GuardianPresentation.localTime(this.guardian.lastRepairAt, '暂无修复')}\n下次检查：${GuardianPresentation.localTime(this.guardian.nextCheckAt, '尚未安排')}`)
        .width('100%').fontSize(scaleFontSize(12, this.fontScaleMode))
        .fontColor(appThemeTokens(this.darkMode).textSecondary)
      ForEach(this.guardian.faults, (fault: GuardianFault) => {
        Text(`${fault.title} · ${fault.state}\n${fault.message}`)
          .width('100%').fontSize(scaleFontSize(12, this.fontScaleMode))
          .fontColor(appThemeTokens(this.darkMode).textSecondary)
      }, (fault: GuardianFault) => fault.id)
      if (this.guardian.history.length > 0) {
        Text('最近处理记录').width('100%').fontWeight(FontWeight.Medium)
          .fontSize(scaleFontSize(13, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
        ForEach(this.guardian.history.slice(-5).reverse(), (entry: GuardianHistoryEntry) => {
          Text(`${GuardianPresentation.localTime(entry.at)} · ${GuardianPresentation.actionLabel(entry.action)} · ${GuardianPresentation.outcomeLabel(entry.outcome)}\n${entry.message}`)
            .width('100%').fontSize(scaleFontSize(12, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).textSecondary)
        })
      }
    }
    Button('刷新守护状态').width('100%').constraintSize({ minHeight: 44 })
      .fontSize(scaleFontSize(14, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
      .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).enabled(!this.guardianBusy)
      .onClick(() => this.onGuardianRefresh())
  }

  @Builder
  Section(key: string, title: string, detail: string) {
    Button() {
      Row({ space: 12 }) {
        Column({ space: 5 }) {
          Text(title).fontWeight(FontWeight.Medium).fontSize(scaleFontSize(15, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).textPrimary)
          Text(detail).fontSize(scaleFontSize(12, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).textSecondary)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text(this.section === key ? '▴' : '▾').fontColor(appThemeTokens(this.darkMode).textSecondary)
      }.width('100%')
    }.width('100%').constraintSize({ minHeight: 64 }).padding(14).borderRadius(10)
      .backgroundColor(appThemeTokens(this.darkMode).surface)
      .onClick(() => { this.section = this.section === key ? '' : key; })
  }

  @Builder
  Action(action: string, label: string, danger: boolean = false) {
    Button(label).width('100%').constraintSize({ minHeight: 44 }).fontSize(scaleFontSize(14, this.fontScaleMode))
      .fontColor(danger ? appThemeTokens(this.darkMode).danger : appThemeTokens(this.darkMode).textPrimary)
      .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).onClick(() => {
        if (action === 'go_tools') {
          this.section = 'tools';
        } else {
          this.onAction(action);
        }
      })
  }

  @Builder
  ThemeOption(mode: string, label: string) {
    Button(label).width('100%').constraintSize({ minHeight: 44 }).fontSize(scaleFontSize(14, this.fontScaleMode))
      .fontColor(this.themeMode === mode ? appThemeTokens(this.darkMode).textOnAccent : appThemeTokens(this.darkMode).textPrimary)
      .backgroundColor(this.themeMode === mode ? appThemeTokens(this.darkMode).accent : appThemeTokens(this.darkMode).surfaceMuted)
      .onClick(() => this.onTheme(mode))
  }

  @Builder
  FontOption(mode: string, label: string) {
    Button(label).width('100%').constraintSize({ minHeight: 44 }).fontSize(scaleFontSize(14, this.fontScaleMode))
      .fontColor(this.fontScaleMode === mode ? appThemeTokens(this.darkMode).textOnAccent : appThemeTokens(this.darkMode).textPrimary)
      .backgroundColor(this.fontScaleMode === mode ? appThemeTokens(this.darkMode).accent : appThemeTokens(this.darkMode).surfaceMuted)
      .onClick(() => this.onFontScale(mode))
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').height(44).fontSize(scaleFontSize(14, this.fontScaleMode))
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
          .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).onClick(() => this.onBack())
        Text('设置').fontSize(scaleFontSize(18, this.fontScaleMode)).fontWeight(FontWeight.Bold)
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
        Blank()
      }.width('100%').padding(16)
      Scroll() {
        Column({ space: 12 }) {
          this.Section('guardian', '自动守护', GuardianPresentation.summary(this.guardian, this.guardianError))
          if (this.section === 'guardian') { this.GuardianDetails() }
          this.Section('voice', '语音与后台', this.voiceState)
          if (this.section === 'voice') {
            Text(`后台连接：${this.backgroundState}。锁屏通话还受系统权限和网络状态影响。`)
              .width('100%').fontSize(scaleFontSize(13, this.fontScaleMode))
              .fontColor(appThemeTokens(this.darkMode).textSecondary)
          }
          this.Section('appearance', '外观', `${themeModeLabel(this.themeMode)} · 字体${fontScaleLabel(this.fontScaleMode)}`)
          if (this.section === 'appearance') {
            this.ThemeOption('dark', '夜晚')
            this.ThemeOption('light', '浅色')
            this.ThemeOption('system', '跟随系统')
            this.FontOption('small', '小字体')
            this.FontOption('standard', '标准字体')
            this.FontOption('large', '大字体')
            this.FontOption('extra_large', '特大字体')
          }
          this.Section('account', '账号与维护', '账号用量与高级工具')
          if (this.section === 'account') {
            this.Action('usage', '账号用量')
            this.Action('go_tools', '高级工具')
          }
          if (this.section === 'tools') {
            this.Action('go_overview', '项目总览')
            this.Action('go_tasks', '任务与事件')
            this.Action('desktop_monitor', '桌面监控')
            this.Action('outbox', '发送队列')
            this.Action('soft_repair', '恢复链路')
            this.Action('hard_restart', '重启 Codex', true)
          }
        }.width('100%').padding({ left: 16, right: 16, top: 4, bottom: 32 })
      }.width('100%').layoutWeight(1).align(Alignment.TopStart).scrollBar(BarState.Auto)
    }.width('100%').height('100%').backgroundColor(appThemeTokens(this.darkMode).canvas)
  }
}
