import { BridgeDesktopInteraction, BridgeUserInputQuestion, BridgeUserInputOption } from '../model/BridgeModels';
import { appThemeTokens } from '../theme/AppTheme';
import { scaleFontSize } from '../theme/AppTypography';

@ComponentV2
export struct SessionInteractionPanel {
  @Param request: BridgeDesktopInteraction = {
    id: '', threadId: '', kind: 'unsupported', status: 'pending',
    title: '', detail: '', questions: [], supportsResponse: false
  };
  @Param darkMode: boolean = false;
  @Param fontScaleMode: string = 'standard';
  @Param answers: Record<string, string> = {};
  @Param busy: boolean = false;
  @Event onAnswer: (request: BridgeDesktopInteraction, questionId: string, value: string) => void = () => {};
  @Event onRespond: (request: BridgeDesktopInteraction, decision: string) => void = () => {};

  private answer(questionId: string): string {
    return this.answers[JSON.stringify(['desktop', this.request.threadId, this.request.id, questionId])] ?? '';
  }

  private canRespond(): boolean {
    return this.request.status === 'pending' && this.request.supportsResponse === true
      && (this.request.kind === 'approval' || this.request.kind === 'user-input');
  }

  private canSubmitAnswers(): boolean {
    return this.canRespond() && !this.busy && this.request.questions.length > 0
      && this.request.questions.every((question: BridgeUserInputQuestion) => this.answer(question.id).trim().length > 0);
  }

  @Builder
  Question(question: BridgeUserInputQuestion) {
    Column({ space: 8 }) {
      if (question.header.length > 0) {
        Text(question.header).fontSize(scaleFontSize(12, this.fontScaleMode)).fontWeight(FontWeight.Bold)
          .fontColor(appThemeTokens(this.darkMode).textSecondary).width('100%')
      }
      Text(question.question).fontSize(scaleFontSize(14, this.fontScaleMode))
        .fontColor(appThemeTokens(this.darkMode).textPrimary).width('100%')
      ForEach(question.options ?? [], (option: BridgeUserInputOption) => {
        Button() {
          Column({ space: 4 }) {
            Text(`${this.answer(question.id) === option.label ? '●' : '○'} ${option.label}`)
              .fontSize(scaleFontSize(14, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).textPrimary)
              .width('100%')
            if (option.description.length > 0) {
              Text(option.description).fontSize(scaleFontSize(12, this.fontScaleMode))
                .fontColor(appThemeTokens(this.darkMode).textSecondary).width('100%')
            }
          }.width('100%').alignItems(HorizontalAlign.Start)
        }.width('100%').constraintSize({ minHeight: 44 }).padding(10).borderRadius(8)
          .backgroundColor(this.answer(question.id) === option.label
            ? appThemeTokens(this.darkMode).accentSurface : appThemeTokens(this.darkMode).surface)
          .enabled(!this.busy).onClick(() => this.onAnswer(this.request, question.id, option.label))
      }, (option: BridgeUserInputOption) => JSON.stringify([this.request.id, question.id, option.label]))
      if ((question.options ?? []).length === 0 || question.isOther) {
        TextInput({ text: this.answer(question.id), placeholder: question.isSecret ? '请输入保密答案' : '请输入答案' })
          .type(question.isSecret ? InputType.Password : InputType.Normal)
          .height(44).fontSize(scaleFontSize(14, this.fontScaleMode)).enabled(!this.busy)
          .fontColor(appThemeTokens(this.darkMode).textPrimary)
          .backgroundColor(appThemeTokens(this.darkMode).surface).borderRadius(8)
          .onChange((value: string) => this.onAnswer(this.request, question.id, value))
      }
    }.width('100%').padding(10).borderRadius(8).backgroundColor(appThemeTokens(this.darkMode).surfaceMuted)
  }

  build() {
    Column({ space: 10 }) {
      Text(this.request.title || (this.request.kind === 'approval' ? '电脑请求确认' : '电脑需要你回答'))
        .fontSize(scaleFontSize(15, this.fontScaleMode)).fontWeight(FontWeight.Bold)
        .fontColor(appThemeTokens(this.darkMode).textPrimary).width('100%')
      if (this.request.detail.length > 0) {
        Text(this.request.detail).fontSize(scaleFontSize(13, this.fontScaleMode))
          .fontColor(appThemeTokens(this.darkMode).textSecondary).width('100%').copyOption(CopyOptions.LocalDevice)
      }
      if (!this.canRespond()) {
        Text('此请求需要在电脑处理，手机无法提交。')
          .fontSize(scaleFontSize(13, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).warning).width('100%')
      } else if (this.request.kind === 'approval') {
        Row({ space: 8 }) {
          Button(this.busy ? '提交中…' : '同意').layoutWeight(1).height(44).enabled(!this.busy)
            .fontColor(appThemeTokens(this.darkMode).textOnAccent).backgroundColor(appThemeTokens(this.darkMode).success)
            .onClick(() => this.onRespond(this.request, 'approved'))
          Button('拒绝').layoutWeight(1).height(44).enabled(!this.busy)
            .fontColor(appThemeTokens(this.darkMode).textOnAccent).backgroundColor(appThemeTokens(this.darkMode).danger)
            .onClick(() => this.onRespond(this.request, 'denied'))
        }.width('100%')
      } else if (this.request.kind === 'user-input') {
        ForEach(this.request.questions, (question: BridgeUserInputQuestion) => {
          this.Question(question)
        }, (question: BridgeUserInputQuestion) => JSON.stringify([this.request.id, question.id]))
        if (this.request.questions.length === 0) {
          Text('问题内容暂不可用，请刷新或在电脑处理。')
            .fontSize(scaleFontSize(13, this.fontScaleMode)).fontColor(appThemeTokens(this.darkMode).warning)
        }
        Button(this.busy ? '提交中…' : '提交回答').width('100%').height(44).enabled(this.canSubmitAnswers())
          .fontColor(appThemeTokens(this.darkMode).textOnAccent).backgroundColor(appThemeTokens(this.darkMode).accent)
          .onClick(() => this.onRespond(this.request, ''))
      }
    }.width('100%').padding(12).borderRadius(10).backgroundColor(appThemeTokens(this.darkMode).accentSurface)
      .border({ width: 1, color: appThemeTokens(this.darkMode).accentBorder })
  }
}
