import { appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';

@ComponentV2
export struct PairingPanel {
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Param paired: boolean = false;
  @Param deviceName: string = '';
  @Param checking: boolean = false;
  @Param busy: boolean = false;
  @Param connectionFailed: boolean = false;
  @Param messageStatus: string = '未检测';
  @Param voiceStatus: string = '未检测，通话时验证';
  @Param computerStatus: string = '未检测';
  @Param statusText: string = '';
  @Param scanAvailable: boolean = true;
  @Param draftUrl: string = '';
  @Param draftToken: string = '';
  @Param manualCode: string = '';
  @Event onBack: () => void = () => {};
  @Event onScan: () => void = () => {};
  @Event onRetry: () => void = () => {};
  @Event onUnpair: () => void = () => {};
  @Event onSave: () => void = () => {};
  @Event onManualPair: () => void = () => {};
  @Event onUrlChange: (value: string) => void = () => {};
  @Event onTokenChange: (value: string) => void = () => {};
  @Event onCodeChange: (value: string) => void = () => {};
  @Local advanced: boolean = false;

  @Builder
  StatusRow(title: string, detail: string) {
    Column({ space: 4 }) {
      Text(title).fontSize(scaleFontSize(14, this.fontScaleMode))
        .fontWeight(FontWeight.Medium).fontColor(appThemeTokens(this.darkMode).textPrimary)
      Text(detail).fontSize(scaleFontSize(12, this.fontScaleMode))
        .fontColor(appThemeTokens(this.darkMode).textSecondary)
    }.width('100%').alignItems(HorizontalAlign.Start).padding(14)
      .backgroundColor(appThemeTokens(this.darkMode).surface).borderRadius(10)
  }

  @Builder
  Action(label: string, callback: () => void, danger: boolean = false) {
    Button(label).width('100%').constraintSize({ minHeight: 44 })
      .fontSize(scaleFontSize(14, this.fontScaleMode))
      .fontColor(danger ? appThemeTokens(this.darkMode).danger : appThemeTokens(this.darkMode).textOnAccent)
      .backgroundColor(danger ? appThemeTokens(this.darkMode).surfaceMuted : appThemeTokens(this.darkMode).accent)
      .enabled(!this.busy && !this.checking).onClick(() => callback())
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').height(44).fontSize(scaleFontSize(14, this.fontScaleMode))
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
          .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).onClick(() => this.onBack())
        Text('配对').fontSize(scaleFontSize(18, this.fontScaleMode)).fontWeight(FontWeight.Bold)
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
        Blank()
      }.width('100%').padding(16)
      Scroll() {
        Column({ space: 12 }) {
          this.StatusRow(this.paired ? '已配对' : '尚未配对',
            this.paired ? this.deviceName : '扫描电脑端二维码，绑定你的个人助手')
          if (this.checking) {
            Row({ space: 8 }) {
              LoadingProgress().width(20).height(20).color(appThemeTokens(this.darkMode).accent)
              Text('正在检测连接…').fontSize(scaleFontSize(13, this.fontScaleMode))
                .fontColor(appThemeTokens(this.darkMode).textSecondary)
            }.width('100%')
          }
          if (!this.paired) {
            this.Action('扫码配对', this.onScan)
          } else if (this.connectionFailed && !this.checking) {
            this.Action('重试连接', this.onRetry)
          }
          this.StatusRow('消息', this.messageStatus)
          this.StatusRow('语音', this.voiceStatus)
          this.StatusRow('助手的云电脑', this.computerStatus)
          if (this.statusText.length > 0) {
            Text(this.statusText).width('100%').fontSize(scaleFontSize(12, this.fontScaleMode))
              .fontColor(appThemeTokens(this.darkMode).textSecondary)
          }
          Button(this.advanced ? '高级选项  ▴' : '高级选项  ▾')
            .width('100%').constraintSize({ minHeight: 44 }).fontSize(scaleFontSize(14, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).textPrimary)
            .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).onClick(() => { this.advanced = !this.advanced; })
          if (this.advanced) {
            Column({ space: 12 }) {
              Text('连接参数').fontWeight(FontWeight.Medium).fontSize(scaleFontSize(14, this.fontScaleMode))
                .fontColor(appThemeTokens(this.darkMode).textPrimary)
              Text('修改后点击“保存并检测”才会应用。返回会保留当前连接。')
                .fontSize(scaleFontSize(12, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textSecondary)
              TextInput({ text: this.draftUrl, placeholder: '桥接地址（http:// 或 https://）' })
                .height(48).fontSize(scaleFontSize(14, this.fontScaleMode))
                .onChange((value: string) => this.onUrlChange(value))
              TextInput({ text: this.draftToken, placeholder: '访问令牌' }).type(InputType.Password)
                .height(48).fontSize(scaleFontSize(14, this.fontScaleMode))
                .onChange((value: string) => this.onTokenChange(value))
              this.Action('保存并检测', this.onSave)
              TextInput({ text: this.manualCode, placeholder: '10 位配对码' })
                .height(48).fontSize(scaleFontSize(14, this.fontScaleMode))
                .onChange((value: string) => this.onCodeChange(value))
                .enterKeyType(EnterKeyType.Done).onSubmit(() => this.onManualPair())
              this.Action('使用配对码配对', this.onManualPair)
              if (!this.scanAvailable) {
                Text('本机不支持系统扫码，请使用手输配对码完成配对')
                  .fontSize(scaleFontSize(12, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textSecondary)
              }
              if (this.paired) {
                this.Action('重新扫码配对', this.onScan)
                this.Action('解除配对', this.onUnpair, true)
              }
            }.width('100%').alignItems(HorizontalAlign.Start)
          }
        }.width('100%').padding({ left: 16, right: 16, top: 4, bottom: 32 })
      }.width('100%').layoutWeight(1).align(Alignment.TopStart).scrollBar(BarState.Auto)
    }.width('100%').height('100%').backgroundColor(appThemeTokens(this.darkMode).canvas)
  }
}
