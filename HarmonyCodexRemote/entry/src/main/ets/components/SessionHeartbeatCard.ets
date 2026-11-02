import { appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';

/** A compact summary; the complete body stays available on request. */
@ComponentV2
export struct SessionHeartbeatCard {
  @Param title: string = '';
  @Param preview: string = '';
  @Param body: string = '';
  @Param metadata: string[] = [];
  @Param expanded: boolean = false;
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Event onToggle: () => void = () => {};
  @Event onCopy: () => void = () => {};

  build() {
    Column({ space: 8 }) {
      Button() {
        Row({ space: 8 }) {
          Text('↻').fontSize(scaleFontSize(16, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).accent).width(24).textAlign(TextAlign.Center)
          Text(this.title).fontSize(scaleFontSize(14, this.fontScaleMode)).fontWeight(FontWeight.Medium)
            .fontColor(appThemeTokens(this.darkMode).textPrimary).layoutWeight(1)
          Text(this.expanded ? '收起' : '展开').fontSize(scaleFontSize(12, this.fontScaleMode))
            .fontColor(appThemeTokens(this.darkMode).textSecondary)
          SymbolGlyph(this.expanded ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(12).fontColor([appThemeTokens(this.darkMode).textSecondary])
        }.width('100%').alignItems(VerticalAlign.Center)
      }.width('100%').constraintSize({ minHeight: 44 }).padding(0)
        .type(ButtonType.Normal).backgroundColor(Color.Transparent)
        .accessibilityText(`${this.title}，${this.expanded ? '收起详情' : '展开详情'}`)
        .onClick(() => this.onToggle())

      if (this.expanded) {
        Text(this.body).fontSize(scaleFontSize(14, this.fontScaleMode))
          .lineHeight(scaleFontSize(23, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
          .width('100%').copyOption(CopyOptions.LocalDevice)
        ForEach(this.metadata, (line: string, index: number) => {
          Text(line).fontSize(scaleFontSize(11, this.fontScaleMode))
            .lineHeight(scaleFontSize(18, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textSecondary)
            .width('100%').copyOption(CopyOptions.LocalDevice)
        }, (line: string, index: number) => `${index}:${line}`)
        Row() {
          Blank()
          Button('复制正文').type(ButtonType.Normal).constraintSize({ minHeight: 44 })
            .fontSize(scaleFontSize(12, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).accent)
            .backgroundColor(Color.Transparent).onClick(() => this.onCopy())
        }.width('100%')
      } else {
        Text(this.preview).fontSize(scaleFontSize(14, this.fontScaleMode))
          .lineHeight(scaleFontSize(23, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
          .width('100%').maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
          .onClick(() => this.onToggle())
      }
    }.width('100%').padding({ left: 14, right: 14, top: 8, bottom: 12 })
      .backgroundColor(appThemeTokens(this.darkMode).surfaceMuted).borderRadius(14)
      .alignItems(HorizontalAlign.Start)
  }
}
