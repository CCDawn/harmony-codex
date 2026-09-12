import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');
const contentActionServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/ContentActionService.ets');
const notificationServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/AppNotificationService.ets');
const desktopMonitorPanelPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/components/DesktopMonitorPanel.ets');
const desktopMonitorDisplayServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/DesktopMonitorDisplayService.ets');
const optimisticMessageServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/OptimisticMessageService.ets');
const sessionPresentationServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/SessionPresentationService.ets');
const bridgeModelsPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/model/BridgeModels.ets');
const entryAbilityPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/entryability/EntryAbility.ets');
const moduleProfilePath = path.resolve('HarmonyCodexRemote/entry/src/main/module.json5');
const backgroundRuntimeServicePath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/AppBackgroundRuntimeService.ets'
);

function source() {
  return fs.readFileSync(indexPath, 'utf8');
}

function contentActionServiceSource() {
  return fs.readFileSync(contentActionServicePath, 'utf8');
}

function entryAbilitySource() {
  return fs.readFileSync(entryAbilityPath, 'utf8');
}

function optimisticMessageServiceSource() {
  return fs.readFileSync(optimisticMessageServicePath, 'utf8');
}

function sessionPresentationServiceSource() {
  return fs.readFileSync(sessionPresentationServicePath, 'utf8');
}

function bridgeModelsSource() {
  return fs.readFileSync(bridgeModelsPath, 'utf8');
}

function moduleProfileSource() {
  return fs.readFileSync(moduleProfilePath, 'utf8');
}

function backgroundRuntimeServiceSource() {
  return fs.readFileSync(backgroundRuntimeServicePath, 'utf8');
}

function methodBody(name) {
  const text = source();
  const methodName = name.split('(')[0];
  const start = text.search(new RegExp(`^\\s*(?:private\\s+(?:async\\s+)?|@Builder\\s+)?${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'm'));
  assert.notEqual(start, -1, `missing method ${name}`);
  const open = text.indexOf('{', start);
  assert.notEqual(open, -1, `missing method body ${name}`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  assert.fail(`unterminated method ${name}`);
}

test('session primary interrupt state accepts bridge task or desktop activity', () => {
  const body = methodBody('canInterruptSelectedSessionTask()');
  const selectedBody = methodBody('selectedSessionInterruptTaskId()');

  assert.match(body, /selectedSessionInterruptTaskId\(\)\.length > 0/);
  assert.match(body, /this\.isSelectedSessionActivityRunning\(\)/);
  assert.doesNotMatch(selectedBody, /this\.isBridgeTaskInterruptReady\(this\.currentTask\)/);
  assert.doesNotMatch(selectedBody, /this\.isTaskSummaryInterruptReady\(task\)/);
});

test('session primary action sends drafts even when the session is interruptible', () => {
  const composerBody = methodBody('SessionComposer()');
  const actionBody = methodBody('shouldUseSessionInterruptAction()');
  const sendBody = methodBody('canSendSessionMessage()');
  const modeBody = methodBody('sessionPrimaryActionMode()');
  const colorBody = methodBody('sessionPrimaryActionColor()');

  assert.match(composerBody, /this\.shouldUseSessionInterruptAction\(\)/);
  assert.match(actionBody, /this\.canInterruptSelectedSessionTask\(\)/);
  assert.match(actionBody, /!this\.hasSessionDraftContent\(\)/);
  assert.doesNotMatch(sendBody, /hasBridgeRunningTaskForSession\(this\.selectedSession\.id\)[\s\S]{0,80}return false/);
  assert.match(modeBody, /this\.shouldUseSessionInterruptAction\(\)[\s\S]*return 'interrupt'/);
  assert.match(modeBody, /this\.canSendSessionMessage\(\)[\s\S]*this\.hasRunningTaskForSession\(this\.selectedSession\.id\)[\s\S]*return 'guidance_send'/);
  assert.match(modeBody, /return 'disabled'/);
  assert.match(colorBody, /mode === 'guidance_send'[\s\S]*return this\.themeColor\('#14853D'\)/);
  assert.match(colorBody, /mode === 'disabled'[\s\S]*return this\.themeColor\('#8A95A3'\)/);
});

test('running sessions keep image, file, and desktop screenshot guidance attachments enabled', () => {
  const imageBody = methodBody('canPickSessionImage()');
  const fileBody = methodBody('canPickSessionFile()');
  const screenshotBody = methodBody('canAttachDesktopScreenshotDraft()');

  assert.doesNotMatch(imageBody, /hasBridgeRunningTaskForSession/);
  assert.match(imageBody, /this\.isUploadingImage \|\| this\.isBusy/);
  assert.match(fileBody, /!this\.isPickingFile && this\.canPickSessionImage\(\)/);
  assert.match(screenshotBody, /this\.canPickSessionImage\(\)/);
});

test('selected running desktop session can interrupt through thread activity without a bridge task', () => {
  const interruptBody = methodBody('canInterruptSelectedSessionTask()');
  const selectedInterruptBody = methodBody('interruptSelectedSessionTask()');
  const selectedActivityBody = methodBody('isSelectedSessionActivityRunning()');

  assert.match(interruptBody, /selectedSessionInterruptTaskId\(\)\.length > 0 \|\| this\.isSelectedSessionActivityRunning\(\)/);
  assert.match(selectedActivityBody, /this\.selectedSession\.activityStatus/);
  assert.match(selectedActivityBody, /this\.sessionActivityStatusById\[sessionId\]/);
  assert.match(selectedActivityBody, /this\.isLocallyClearedSessionActivity/);
  assert.match(selectedActivityBody, /cachedStatus !== 'idle'[\s\S]*return cachedStatus === 'running'/);
  assert.match(selectedInterruptBody, /BridgeClient\.interruptCodexThread\(this\.normalizedBridgeUrl\(\), targetSessionId, this\.bridgeToken\)/);
});

test('session interrupt requires explicit confirmation and records the decision boundary', () => {
  const composerBody = methodBody('SessionComposer()');
  const confirmBody = methodBody('confirmSelectedSessionInterrupt()');

  assert.match(composerBody, /this\.confirmSelectedSessionInterrupt\(\)/);
  assert.doesNotMatch(composerBody, /void this\.interruptSelectedSessionTask\(\)/);
  assert.match(confirmBody, /AlertDialog\.show\(\{/);
  assert.match(confirmBody, /ui\.interrupt\.confirmation\.shown/);
  assert.match(confirmBody, /ui\.interrupt\.confirmation\.cancelled/);
  assert.match(confirmBody, /ui\.interrupt\.confirmation\.confirmed/);
  assert.match(confirmBody, /void this\.interruptSelectedSessionTask\(\)/);
});

test('a draft remains sendable while the prior turn interrupt is being confirmed', () => {
  const modeBody = methodBody('sessionPrimaryActionMode()');
  const interruptingIndex = modeBody.indexOf('this.isInterruptingSelectedSessionTask()');
  const sendableIndex = modeBody.indexOf('this.canSendSessionMessage()');

  assert.ok(sendableIndex >= 0 && sendableIndex < interruptingIndex,
    'draft sendability must be resolved before the interrupt-only loading state');
  assert.match(modeBody, /this\.canSendSessionMessage\(\)[\s\S]*this\.hasRunningTaskForSession\(this\.selectedSession\.id\)[\s\S]*return 'guidance_send'/);
});

test('primary action loading state is scoped to the selected session', () => {
  const symbolBody = methodBody('SessionPrimaryActionSymbol()');
  const modeBody = methodBody('sessionPrimaryActionMode()');
  const interruptingBody = methodBody('isInterruptingSelectedSessionTask()');

  assert.match(symbolBody, /this\.sessionPrimaryActionMode\(\) === 'interrupt'/);
  assert.doesNotMatch(symbolBody, /this\.isSendingSessionMessage \|\| this\.isInterruptingTask/);
  assert.match(modeBody, /this\.isSendingCurrentSessionMessage\(\)/);
  assert.match(modeBody, /this\.isInterruptingSelectedSessionTask\(\)/);
  assert.match(interruptingBody, /interruptingSessionTargetId/);
});

test('session sending is optimistic in the conversation and does not open a separate sending banner', () => {
  const sourceText = source();
  const optimisticSource = optimisticMessageServiceSource();
  const panelBody = methodBody('SessionConversationPanel()');
  const cardBody = methodBody('OptimisticSessionMessageCard(message: OptimisticSessionMessage)');
  const sendBody = methodBody('sendMessageToSelectedSession(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const newSendBody = methodBody('sendNewSessionMessage(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const floatingBody = methodBody('shouldShowSessionFloatingStatus(): boolean');
  const floatingTitleBody = methodBody('sessionFloatingStatusTitle(): string');

  assert.match(optimisticSource, /export interface OptimisticSessionMessage/);
  assert.match(optimisticSource, /export function appendOptimisticSessionMessage/);
  assert.match(optimisticSource, /export function removeOptimisticSessionMessage/);
  assert.match(sourceText, /@State optimisticSessionMessages: OptimisticSessionMessage\[\] = \[\]/);
  assert.match(panelBody, /visibleOptimisticSessionMessages\(\)/);
  assert.match(cardBody, /message\.text/);
  assert.match(cardBody, /LoadingProgress\(\)/);
  assert.ok(sendBody.indexOf('this.beginOptimisticSessionSend(') < sendBody.indexOf("await this.guard('sendSessionMessage'"));
  assert.ok(newSendBody.indexOf('this.beginOptimisticSessionSend(') < newSendBody.indexOf("await this.guard('sendNewSessionMessage'"));
  assert.doesNotMatch(floatingBody, /isSendingSessionMessage/);
  assert.doesNotMatch(floatingTitleBody, /正在发送到 Codex/);
});

test('terminal task refresh locally suppresses stale running activity', () => {
  const body = methodBody('refreshTask()');

  assert.match(body, /this\.isTaskTerminalStatus\(task\.status\)/);
  assert.match(body, /this\.markSessionRunningLocallyCleared\(this\.taskSessionId\(task\)\)/);
});

test('task refresh ignores stale async results after current task is cleared', () => {
  const body = methodBody('refreshTask()');

  assert.match(body, /const activeTask = this\.currentTask/);
  assert.match(body, /const activeTaskId = activeTask\.id/);
  assert.match(body, /this\.currentTask === null \|\| this\.currentTask\.id !== activeTaskId/);
  assert.match(body, /task\.refresh\.result_ignored/);
  assert.match(body, /task\.refresh\.missing_ignored/);
});

test('durable outbox tasks keep polling through the Codex run API and hand pending state to the real task', () => {
  const refreshBody = methodBody('refreshTask()');
  const routeBody = methodBody('taskUsesCodexRunApi(task: BridgeTask | BridgeTaskSummary): boolean');
  const handoffBody = methodBody('handoffPendingSessionSend(previousTaskId: string, task: BridgeTask): void');
  const sendBody = methodBody('sendMessageToSelectedSession(retryFailedMessageId: string = \'\'): Promise<boolean>');

  assert.match(routeBody, /this\.taskUsesAppServer\(task\)/);
  assert.match(routeBody, /task\.runtime\?\.kind === 'durable_outbox'/);
  assert.match(refreshBody, /this\.taskUsesCodexRunApi\(activeTask\)/);
  assert.match(refreshBody, /BridgeClient\.getCodexRun/);
  assert.match(refreshBody, /this\.handoffPendingSessionSend\(activeTaskId, task\)/);
  assert.match(handoffBody, /this\.pendingSessionSendsByTaskId\[previousTaskId\]/);
  assert.match(handoffBody, /next\[task\.id\] = pending/);
  assert.match(handoffBody, /this\.activeSessionTaskId === previousTaskId/);
  assert.match(sendBody, /this\.currentTask\.runtime\?\.kind === 'durable_outbox'/);
  assert.match(sendBody, /消息已排队，将在当前回合结束后按顺序自动发送/);
});

test('mobile negotiates Bridge compatibility and advances a monotonic task event cursor', () => {
  const sourceText = source();
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const modelText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/model/BridgeModels.ets'), 'utf8');
  const refreshBody = methodBody('refreshTask()');
  const mergeBody = methodBody('mergeTaskEventPage(previous: BridgeTask, incoming: BridgeTask): BridgeTask');
  const dashboardBody = methodBody('refreshDashboard(force: boolean = false): Promise<void>');
  const contractBody = methodBody('requiresDesktopLiveForSend(targetSessionId: string, source: string): Promise<boolean>');

  assert.match(modelText, /export interface BridgeProtocolHandshake/);
  assert.match(modelText, /eventCursor\?: number/);
  assert.match(modelText, /eventGap\?: boolean/);
  assert.match(clientText, /clientProtocol=/);
  assert.match(clientText, /clientVersion=/);
  assert.match(clientText, /afterSeq=/);
  assert.match(clientText, /Bridge 协议不兼容/);
  assert.match(refreshBody, /this\.currentTaskEventCursor\(activeTask\)/);
  assert.match(refreshBody, /this\.mergeTaskEventPage\(activeTask, task\)/);
  assert.match(mergeBody, /incoming\.eventGap === true/);
  assert.match(mergeBody, /event\.id/);
  assert.match(dashboardBody, /BridgeClient\.getRuntimeStatus/);
  assert.match(dashboardBody, /lastRuntimeContractRefreshAt/);
  assert.match(contractBody, /Bridge 协议不兼容/);
  assert.match(contractBody, /throw new Error\(message\)/);
  assert.match(sourceText, /task\.event_cursor\.gap/);
});

test('running session refresh uses task list and session activity, not only currentTask', () => {
  const dashboardBody = methodBody('refreshDashboard(force: boolean = false): Promise<void>');
  const anyRunningBody = methodBody('hasAnyRunningSession()');
  const selectedFastBody = methodBody('selectedSessionNeedsFastRefresh()');
  const openBody = methodBody('openSession(session: CodexSessionSummary): Promise<void>');
  const applyBody = methodBody('applySessionActivitySnapshot(session: CodexSessionSummary | CodexSessionDetail, source: string): void');

  assert.match(dashboardBody, /const hasAnyRunning = this\.hasAnyRunningSession\(\)/);
  assert.match(dashboardBody, /selectedSessionNeedsFastRefresh\(\) \? 5000 : 15000/);
  assert.match(anyRunningBody, /this\.runningSessionIds\.length > 0/);
  assert.match(anyRunningBody, /this\.tasks\.length/);
  assert.match(selectedFastBody, /this\.hasRunningTaskForSession\(this\.selectedSession\.id\)/);
  assert.match(selectedFastBody, /normalizedSessionActivityStatus\(this\.selectedSession\.activityStatus/);
  assert.match(applyBody, /status === 'running'/);
  assert.match(applyBody, /this\.markSessionRunning\(sessionId\)/);
  assert.match(applyBody, /status === 'completed'/);
  assert.match(applyBody, /this\.unmarkSessionRunning\(sessionId\)/);
  assert.match(applyBody, /this\.clearStaleCurrentTaskForCompletedSession\(sessionId, activityUpdatedAt/);
  assert.match(openBody, /await this\.adoptSelectedSessionTaskFromSummaries\(this\.tasks\)/);
});

test('ended-task interrupt conflict is treated as recovered terminal state', () => {
  const body = methodBody('recoverAfterGuardError(name: string, error: Object): Promise<boolean>');

  assert.match(body, /name === 'interruptSelectedSessionTask'/);
  assert.match(body, /this\.isEndedTaskInterruptConflict\(message\)/);
  assert.match(body, /this\.clearSelectedSessionRunningAfterEndedInterruptConflict\(\)/);
});

test('composer action menu pops upward without changing the composer width', () => {
  const body = methodBody('SessionComposer()');
  const guardBody = methodBody('shouldIgnoreComposerActionToggle(): boolean');
  const popupIndex = body.indexOf('this.ComposerActionPopup()');
  const plusIndex = body.indexOf("SymbolGlyph($r('sys.symbol.plus'))");

  assert.ok(popupIndex >= 0, 'missing composer action popup');
  assert.ok(plusIndex >= 0, 'missing plus button');
  assert.ok(popupIndex < plusIndex, 'popup should be rendered before the stable plus rail so the plus button remains on top');
  assert.match(body, /Stack\(\{ alignContent: Alignment\.Bottom \}\)/);
  assert.match(body, /\.width\(34\)/);
  assert.match(body, /\.translate\(\{ x: 0, y: -234 \}\)/);
  assert.match(body, /\.zIndex\(1\)/);
  assert.match(body, /\.zIndex\(2\)/);
  assert.match(body, /this\.shouldIgnoreComposerActionToggle\(\)/);
  assert.match(guardBody, /lastComposerActionToggleAt/);
  assert.doesNotMatch(body, /composerActionMenuExpanded \? 80 : 38/);
});

test('session composer keeps an empty draft compact', () => {
  const sourceText = source();
  const panelBody = methodBody('SessionPanel()');
  const composerBody = methodBody('SessionComposer()');
  const heightBody = methodBody('sessionComposerTextAreaHeight(): number');
  const marginBody = methodBody('sessionComposerBottomMargin(): number');
  const shiftBody = methodBody('sessionComposerBottomShift(): number');

  assert.match(sourceText, /\.expandSafeArea\(\[SafeAreaType\.SYSTEM\], \[SafeAreaEdge\.BOTTOM\]\)/);
  assert.match(sourceText, /\.ignoreLayoutSafeArea\(\[LayoutSafeAreaType\.SYSTEM\], \[LayoutSafeAreaEdge\.BOTTOM\]\)/);
  assert.match(panelBody, /\.padding\(\{ left: 12, right: 12, top: 12, bottom: 0 \}\)/);
  assert.match(composerBody, /\.width\(32\)/);
  assert.match(composerBody, /\.padding\(\{ left: 6, right: 6, top: 4, bottom: 1 \}\)/);
  assert.match(composerBody, /\.translate\(\{ y: this\.sessionComposerBottomShift\(\) \}\)/);
  assert.match(heightBody, /return 66/);
  assert.match(heightBody, /return 72/);
  assert.match(heightBody, /return 78/);
  assert.doesNotMatch(heightBody, /return 9[0-9]|return 100/);
  assert.match(marginBody, /return 0/);
  assert.match(shiftBody, /this\.sessionComposerFocused \? 0 : 16/);
});

test('desktop screenshot button uses a drawn icon instead of the blurry display symbol', () => {
  const headerBody = methodBody('SessionPanel()');
  const popupBody = methodBody('ComposerActionPopup()');
  const iconBody = methodBody('DesktopScreenshotButtonIcon()');
  const attachIconBody = methodBody('DesktopScreenshotAttachButtonIcon()');

  assert.doesNotMatch(headerBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(popupBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(popupBody, /this\.DesktopScreenshotAttachButtonIcon\(\)/);
  assert.match(popupBody, /this\.canAttachDesktopScreenshotDraft\(\)/);
  assert.match(popupBody, /this\.attachDesktopScreenshotDraft\(\)/);
  assert.match(popupBody, /source=plus_menu/);
  assert.doesNotMatch(headerBody, /sys\.symbol\.display/);
  assert.match(iconBody, /\.border\(\{ width: 2, color: this\.themeColor\('#17202A'\) \}\)/);
  assert.match(iconBody, /\.backgroundColor\(this\.themeColor\('#1F6FEB'\)\)/);
  assert.match(attachIconBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(attachIconBody, /sys\.symbol\.plus/);
  assert.match(attachIconBody, /\.backgroundColor\(this\.themeColor\('#14853D'\)\)/);
});

test('desktop screenshot can be attached as a draft image and uploaded with the message', () => {
  const sourceText = source();
  const attachBody = methodBody('attachDesktopScreenshotDraft(): Promise<void>');
  const composeBody = methodBody('composeOutgoingSessionMessage(text: string, images: PendingSessionImage[]): Promise<ComposedSessionMessage>');
  const dataUriBody = methodBody('desktopScreenshotDataUri(image: DesktopScreenshotImage): string');
  const readPendingBody = methodBody('readPendingImageAsBase64(uri: string): string');

  assert.match(sourceText, /@State isAttachingDesktopScreenshot: boolean = false/);
  assert.match(attachBody, /BridgeClient\.captureDesktopScreenshot/);
  assert.match(attachBody, /this\.pendingSessionImages = \[/);
  assert.match(attachBody, /desktop-shot-\$\{Date\.now\(\)\}/);
  assert.match(attachBody, /this\.desktopScreenshotDataUri\(image\)/);
  assert.match(attachBody, /this\.desktopScreenshotDraftFileName\(image\)/);
  assert.match(composeBody, /this\.readPendingImageAsBase64\(image\.uri\)/);
  assert.match(dataUriBody, /data:\$\{this\.normalizedDesktopScreenshotMimeType\(image\.mimeType\)\};base64/);
  assert.match(readPendingBody, /uri\.startsWith\('data:'\)/);
  assert.match(readPendingBody, /metadata\.indexOf\(';base64'\)/);
  assert.match(readPendingBody, /return this\.readFileAsBase64\(uri\)/);
});

test('image previews adapt to portrait and landscape before back navigation', () => {
  const previewBody = methodBody('ImagePreviewOverlay()');
  const desktopPreviewBody = methodBody('DesktopScreenshotPreviewOverlay()');
  const previewContentBody = methodBody('AdaptiveImagePreviewContent(imageUrl: string)');
  const widthBody = methodBody('adaptiveImagePreviewWidth(): string');
  const heightBody = methodBody('adaptiveImagePreviewHeight(): string');
  const areaBody = methodBody('handleAdaptiveImagePreviewAreaChange(): void');
  const backBody = methodBody('onBackPress(): boolean');
  const captureBody = methodBody('captureDesktopScreenshotPreview(): Promise<void>');
  const userWidthBody = methodBody('userSessionEntryWidth(entry: CodexSessionEntry): string | number');
  const userHeightBody = methodBody('userImageEntryHeight(entry: CodexSessionEntry): number');

  assert.match(previewBody, /this\.AdaptiveImagePreviewContent\(this\.previewImageUrl\)/);
  assert.match(desktopPreviewBody, /this\.AdaptiveImagePreviewContent\(this\.desktopScreenshotPreviewUrl\)/);
  assert.match(previewContentBody, /\.width\(this\.adaptiveImagePreviewWidth\(\)\)/);
  assert.match(previewContentBody, /\.height\(this\.adaptiveImagePreviewHeight\(\)\)/);
  assert.match(previewContentBody, /GestureGroup\(GestureMode\.Parallel[\s\S]*PinchGesture\(\)[\s\S]*PanGesture\(\)/);
  assert.match(previewContentBody, /TapGesture\(\{ count: 2 \}\)/);
  assert.match(widthBody, /this\.isLandscapeSessionLayout\(\) \? '88%' : '92%'/);
  assert.match(heightBody, /this\.isLandscapeSessionLayout\(\) \? '90%' : '75%'/);
  assert.match(areaBody, /this\.desktopScreenshotOffsetX = 0/);
  assert.match(areaBody, /this\.desktopScreenshotOffsetY = 0/);
  assert.doesNotMatch(areaBody, /this\.desktopScreenshotScale = 1/);
  assert.match(backBody, /if \(this\.hasOpenImagePreview\(\)\)[\s\S]*this\.closeOpenImagePreview\('system_back'\)[\s\S]*return true/);
  assert.doesNotMatch(captureBody, /startDesktopScreenshotAutoRotation/);
  assert.match(userWidthBody, /this\.isLandscapeSessionLayout\(\) \? '72%' : '58%'/);
  assert.match(userHeightBody, /this\.isLandscapeSessionLayout\(\) \? 300 : 430/);
  assert.match(source(), /@StorageLink\('codexRemotePreviewImageUrl'\) previewImageUrl: string = ''/);
  assert.match(source(), /@StorageLink\('codexRemoteImagePreviewScale'\) desktopScreenshotScale: number = 1/);
});

test('automatic reasoning effort displays the desktop default strength', () => {
  const sourceText = source();
  const headerButtonBody = methodBody('ReasoningEffortHeaderButton()');
  const shortLabelBody = methodBody('reasoningEffortShortLabel(value: string): string');
  const displayLabelBody = methodBody('reasoningEffortDisplayLabel(value: string): string');
  const descriptionBody = methodBody('reasoningEffortDescription(value: string): string');
  const loadBody = methodBody('loadSessionReasoningEffort(sessionId: string): Promise<void>');
  const defaultsBody = methodBody('loadDesktopReasoningDefaults(): Promise<void>');
  const modelOptionsBody = methodBody('modelOptionValues(): CodexModelOption[]');
  const modelChangeBody = methodBody('changeSessionModel(value: string): Promise<void>');

  assert.match(sourceText, /@State sessionModel: string = ''/);
  assert.match(sourceText, /@State desktopDefaultModel: string = ''/);
  assert.match(sourceText, /@State availableModels: CodexModelOption\[\] = \[\]/);
  assert.match(sourceText, /@State desktopDefaultReasoningEffort: string = ''/);
  assert.match(sourceText, /BridgeClient\.getCodexSettings/);
  assert.match(headerButtonBody, /Text\(this\.modelHeaderLabel\(\)\)/);
  assert.match(headerButtonBody, /· \$\{this\.reasoningEffortShortLabel\(this\.sessionReasoningEffort\)\}/);
  assert.doesNotMatch(headerButtonBody, /思考·/);
  assert.match(headerButtonBody, /\.width\(132\)/);
  assert.doesNotMatch(headerButtonBody, /Text\('思'\)/);
  assert.match(shortLabelBody, /this\.normalizeReasoningEffort\(value\)/);
  assert.match(shortLabelBody, /this\.desktopDefaultReasoningEffort/);
  assert.match(displayLabelBody, /自动·\$\{this\.reasoningEffortLabel\(desktopDefault\)\}/);
  assert.match(descriptionBody, /跟随桌面默认：\$\{this\.reasoningEffortLabel\(desktopDefault\)\}/);
  assert.match(modelOptionsBody, /this\.availableModels/);
  assert.match(modelOptionsBody, /this\.desktopDefaultModel/);
  assert.match(modelChangeBody, /BridgeClient\.updateSessionSettings/);
  assert.match(modelChangeBody, /model: nextModel/);
  assert.match(loadBody, /settings\.defaultModel/);
  assert.match(loadBody, /settings\.modelOptions/);
  assert.match(loadBody, /settings\.defaultReasoningEffort/);
  assert.match(defaultsBody, /settings\.defaultModel/);
  assert.match(defaultsBody, /settings\.modelOptions/);
  assert.match(defaultsBody, /settings\.defaultReasoningEffort/);
});

test('model settings cache refreshes after failures and emits catalog diagnostics', () => {
  const sourceText = source();
  const loadBody = methodBody('loadSessionReasoningEffort(sessionId: string, force: boolean = false): Promise<void>');
  const defaultsBody = methodBody('loadDesktopReasoningDefaults(force: boolean = false): Promise<void>');

  assert.match(sourceText, /private modelSettingsCacheTtlMs: number = 10000/);
  assert.match(loadBody, /force/);
  assert.match(loadBody, /Date\.now\(\) - this\.reasoningEffortLoadedAt < this\.modelSettingsCacheTtlMs/);
  assert.match(loadBody, /session\.model_catalog\.loaded/);
  assert.match(loadBody, /modelCount=\$\{this\.availableModels\.length\}/);
  assert.doesNotMatch(loadBody, /catch \(error\)[\s\S]*this\.reasoningEffortLoadedSessionId = sessionId/);
  assert.match(defaultsBody, /force/);
  assert.match(defaultsBody, /session\.model_catalog\.refreshed/);
  assert.match(defaultsBody, /modelCount=\$\{this\.availableModels\.length\}/);
});

test('git codex directives render as compact component blocks', () => {
  const sourceText = source();
  const parseBody = methodBody('parseSessionMarkdown(text: string): SessionMarkdownBlock[]');
  const blockBody = methodBody('SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean)');
  const directiveBody = methodBody('CodexDirectiveBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock)');
  const directiveIconBody = methodBody('CodexDirectiveIconView(name: string)');
  const directiveDetailViewBody = methodBody('CodexDirectiveDetailView(block: SessionMarkdownBlock)');
  const fieldViewBody = methodBody('StructuredFieldView(field: SessionStructuredField)');
  const plainBody = methodBody('markdownPlainDisplayText(text: string): string');
  const titleBody = methodBody('codexDirectiveTitle(name: string): string');
  const summaryBody = methodBody('codexDirectiveSummary(block: SessionMarkdownBlock): string');
  const detailFieldsBody = methodBody('codexDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[]');

  assert.match(parseBody, /const codexDirectiveName = this\.markdownCodexDirectiveName\(trimmed\)/);
  assert.match(parseBody, /pushBlock\('codex_directive', trimmed, 0, false, false, codexDirectiveName\)/);
  assert.match(blockBody, /block\.kind === 'codex_directive'/);
  assert.match(blockBody, /this\.CodexDirectiveBlockView\(entry, block\)/);
  assert.match(directiveBody, /this\.CodexDirectiveIconView\(block\.language\)/);
  assert.match(directiveBody, /this\.codexDirectiveSummary\(block\)/);
  assert.match(directiveBody, /this\.isSessionMarkdownBlockExpanded\(entry, block\)/);
  assert.match(directiveBody, /this\.toggleSessionMarkdownBlock\(entry, block\)/);
  assert.match(directiveBody, /this\.CodexDirectiveDetailView\(block\)/);
  assert.match(directiveDetailViewBody, /this\.codexDirectiveDetailFields\(block\)/);
  assert.match(directiveDetailViewBody, /this\.StructuredFieldView\(field\)/);
  assert.match(fieldViewBody, /field\.label/);
  assert.match(fieldViewBody, /field\.meta/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.folder'\)\)/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.plus'\)\)/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.arrow_up'\)\)/);
  assert.match(titleBody, /git-create-branch[\s\S]*创建 Git 分支/);
  assert.match(titleBody, /git-stage[\s\S]*暂存 Git 改动/);
  assert.match(titleBody, /git-commit[\s\S]*提交 Git 变更/);
  assert.match(summaryBody, /this\.codexDirectiveAttribute\(text, 'branch'\)/);
  assert.match(summaryBody, /this\.codexDirectivePathSummary\(cwd\)/);
  assert.match(detailFieldsBody, /label: '工作区'/);
  assert.match(detailFieldsBody, /label: '指令'/);
  assert.match(plainBody, /this\.markdownCodexDirectiveName\(trimmed\)/);
  assert.match(plainBody, /this\.codexDirectiveTitle\(codexDirectiveName\)/);
  assert.match(sourceText, /private markdownCodexDirectiveName\(trimmedLine: string\): string/);
});

test('memory citation directive blocks are clickable and recent activity header is hidden', () => {
  const sourceText = source();
  const blockBody = methodBody('SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean)');
  const contentBody = methodBody('SessionMarkdownContent(entry: CodexSessionEntry, isUser: boolean)');
  const detailViewBody = methodBody('MarkdownDirectiveDetailView(block: SessionMarkdownBlock)');
  const detailFieldsBody = methodBody('markdownDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[]');

  assert.match(contentBody, /this\.SessionMarkdownBlockView\(entry, block, isUser\)/);
  assert.match(blockBody, /block\.kind === 'directive'/);
  assert.match(blockBody, /this\.isSessionMarkdownBlockExpanded\(entry, block\)/);
  assert.match(blockBody, /this\.toggleSessionMarkdownBlock\(entry, block\)/);
  assert.match(blockBody, /this\.MarkdownDirectiveDetailView\(block\)/);
  assert.match(detailViewBody, /this\.markdownDirectiveDetailFields\(block\)/);
  assert.match(detailFieldsBody, /block\.language === 'oai-mem-citation'/);
  assert.match(detailFieldsBody, /label: uuidLike \? '会话' : '来源'/);
  assert.match(detailFieldsBody, /noteStart \+ 7/);
  assert.doesNotMatch(sourceText, /Text\('最近活跃'\)/);
});

test('session message stream renders rich markdown and concrete expandable tool presentations', () => {
  const sourceText = source();
  const presentationSource = sessionPresentationServiceSource();
  const modelsSource = bridgeModelsSource();
  const blockBody = methodBody('SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean)');
  const inlineBody = methodBody('SessionMarkdownInlineText(text: string, isUser: boolean, fontSize: number, lineHeight: number)');
  const toolBody = methodBody('SessionToolEntryView(entry: CodexSessionEntry)');
  const tableBody = methodBody('SessionMarkdownTableView(block: SessionMarkdownBlock, isUser: boolean)');
  const tableColumnWidthBody = methodBody('sessionMarkdownTableColumnWidth(block: SessionMarkdownBlock): number');
  const parseBody = methodBody('parseSessionMarkdown(text: string): SessionMarkdownBlock[]');

  assert.match(sourceText, /from '\.\.\/services\/SessionPresentationService'/);
  assert.match(modelsSource, /export interface CodexSessionToolItem/);
  assert.match(modelsSource, /toolItems\?: CodexSessionToolItem\[\]/);

  assert.match(presentationSource, /export function parseSessionMarkdownInline/);
  assert.match(presentationSource, /export function parseSessionMarkdownTable/);
  assert.match(presentationSource, /export function sessionToolPresentationItems/);
  assert.match(presentationSource, /export function compactAdjacentSessionToolEntries/);
  assert.match(presentationSource, /previous\.role !== 'tool' \|\| entry\.role !== 'tool'/);
  assert.match(presentationSource, /retryCount/);
  for (const kind of ['strong', 'emphasis', 'code', 'strike', 'link']) {
    assert.match(presentationSource, new RegExp(`'${kind}'`));
  }

  assert.match(inlineBody, /ForEach\(parseSessionMarkdownInline\(text\)/);
  assert.match(inlineBody, /Span\(segment\.text\)/);
  assert.match(inlineBody, /FontWeight\.Bold/);
  assert.match(inlineBody, /FontStyle\.Italic/);
  assert.match(inlineBody, /TextDecorationType\.LineThrough/);
  assert.doesNotMatch(blockBody, /Text\(this\.markdownInlineDisplayText\(block\.text\)\)/);

  assert.match(parseBody, /parseSessionMarkdownTable/);
  assert.match(parseBody, /pushBlock\('table'/);
  assert.match(blockBody, /block\.kind === 'table'/);
  assert.match(blockBody, /this\.SessionMarkdownTableView\(block, isUser\)/);
  assert.match(tableBody, /parseSessionMarkdownTable\(block\.text\)\.headers/);
  assert.match(tableBody, /parseSessionMarkdownTable\(block\.text\)\.rows/);
  assert.match(tableBody, /\.width\(this\.sessionMarkdownTableColumnWidth\(block\)\)/);
  assert.match(tableBody, /\.constraintSize\(\{ minHeight: 34 \}\)/);
  assert.match(tableBody, /\.alignSelf\(ItemAlign\.Stretch\)/);
  assert.doesNotMatch(tableBody, /\.width\(128\)/);
  assert.doesNotMatch(tableBody, /\.height\(34\)/);
  assert.match(tableColumnWidthBody, /parseSessionMarkdownTable\(block\.text\)\.headers\.length/);
  assert.match(tableColumnWidthBody, /this\.sessionWindowWidthVp\(\)/);
  assert.match(tableColumnWidthBody, /this\.isLandscapeSessionLayout\(\)/);

  const quoteStart = blockBody.indexOf("block.kind === 'quote'");
  const quoteEnd = blockBody.indexOf("block.kind === 'list'");
  const quoteBody = blockBody.slice(quoteStart, quoteEnd);
  assert.equal(quoteStart >= 0 && quoteEnd > quoteStart, true);
  assert.doesNotMatch(quoteBody, /\.height\('100%'\)/);
  assert.match(quoteBody, /\.alignSelf\(ItemAlign\.Stretch\)/);

  assert.match(toolBody, /sessionToolPresentationItems\(entry\)/);
  assert.match(toolBody, /item\.verb/);
  assert.match(toolBody, /item\.target/);
  assert.match(toolBody, /item\.detail/);
  assert.match(toolBody, /this\.toggleSessionToolItem\(entry, item\)/);
  assert.match(toolBody, /this\.isSessionToolGroup\(entry\)/);
  assert.match(toolBody, /this\.shouldShowSessionToolGroupItems\(entry\)/);
  assert.match(toolBody, /全部展开/);
  assert.match(toolBody, /收起/);
  assert.doesNotMatch(toolBody, /项工具调用/);

  const normalizeBody = methodBody('normalizeVisibleSessionEntries(entries: CodexSessionEntry[]): CodexSessionEntry[]');
  const groupTitleBody = methodBody('sessionToolGroupTitle(entry: CodexSessionEntry): string');
  const statusBody = methodBody('sessionToolItemStatusText(item: SessionToolPresentationItem): string');
  assert.match(normalizeBody, /compactAdjacentSessionToolEntries\(visibleEntries\)/);
  assert.match(groupTitleBody, /已完成.*项操作/);
  assert.match(groupTitleBody, /正在执行.*项操作/);
  assert.match(statusBody, /重试.*次后成功/);
});

test('compaction retry events are visible in running task status', () => {
  const sourceText = source();
  const summaryBody = methodBody('eventSummary(event: BridgeEvent)');
  const workingBody = methodBody('eventWorkingStatus(event: BridgeEvent)');
  const compactionBody = methodBody('compactionEventText(event: BridgeEvent, fallback: string)');
  const labelBody = methodBody('compactionSignalLabel(signal: string)');

  for (const eventType of [
    'codex.app_server.turn.retry_after_compaction',
    'codex.app_server.compaction.detected',
    'codex.app_server.compaction.waiting'
  ]) {
    assert.match(summaryBody, new RegExp(eventType.replace(/[.]/g, '\\.')));
    assert.match(workingBody, new RegExp(eventType.replace(/[.]/g, '\\.')));
  }
  assert.match(sourceText, /发送后触发上下文压缩/);
  assert.match(compactionBody, /nextAttempt/);
  assert.match(compactionBody, /maxAttempts/);
  assert.match(labelBody, /post_submit_prewrite_interrupted/);
  assert.match(labelBody, /上下文接近窗口上限/);
});

test('running Codex status is rendered inside the conversation stream', () => {
  const hideBody = methodBody('shouldHideSessionEntry(entry: CodexSessionEntry): boolean');
  const cardBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const floatingBody = methodBody('shouldShowSessionFloatingStatus()');
  const panelBody = methodBody('SessionConversationPanel()');

  assert.doesNotMatch(hideBody, /entry\.type === 'live_agent_status'/);
  assert.match(cardBody, /entry\.type === 'live_agent_status'/);
  assert.match(cardBody, /Text\('Codex'\)/);
  assert.match(cardBody, /LoadingProgress\(\)/);
  assert.doesNotMatch(floatingBody, /shouldShowSelectedSessionTaskPanel\(\)/);
  assert.doesNotMatch(floatingBody, /shouldShowNewSessionTaskPanel\(\)/);
  assert.match(panelBody, /this\.sessionEntryKey\(entry\)/);
});

test('live activity is rendered as one stable bottom conversation entry', () => {
  const hideBody = methodBody('shouldHideSessionEntry(entry: CodexSessionEntry): boolean');
  const cardBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const keyBody = methodBody('sessionEntryKey(entry: CodexSessionEntry): string');
  const visibleBody = methodBody('visibleSessionEntries(): CodexSessionEntry[]');
  const textBody = methodBody('sessionEntryVisibleText(entry: CodexSessionEntry): string');
  const stageBody = methodBody('liveSessionEntryStageText(value: string): string');
  const itemStatusBody = methodBody('itemWorkingStatus(item: Record<string, Object>): string');

  assert.doesNotMatch(hideBody, /entry\.type === 'live_activity'/);
  assert.match(hideBody, /entry\.type === 'reasoning'/);
  assert.match(cardBody, /entry\.type === 'live_activity'/);
  assert.match(cardBody, /LoadingProgress\(\)/);
  assert.match(keyBody, /entry\.type === 'live_activity'/);
  assert.match(keyBody, /live-\$\{entry\.threadId/);
  assert.match(visibleBody, /this\.normalizeVisibleSessionEntries\(entries\)/);
  assert.match(textBody, /entry\.type === 'live_activity' \|\| entry\.type === 'live_agent_status'/);
  assert.match(textBody, /this\.liveSessionEntryStageText/);
  assert.match(stageBody, /return '正在思考'/);
  assert.match(stageBody, /return '正在执行命令'/);
  assert.match(stageBody, /return '正在调用工具'/);
  assert.match(stageBody, /return '正在返回内容'/);
  assert.match(itemStatusBody, /return '正在执行命令'/);
  assert.doesNotMatch(itemStatusBody, /compactDisplayText\(command/);

  const liveBranchStart = cardBody.indexOf("entry.type === 'live_activity'");
  const nextBranchStart = cardBody.indexOf("entry.type === 'live_agent_status'");
  assert.ok(liveBranchStart >= 0 && nextBranchStart > liveBranchStart, 'live activity should be handled before legacy live status');
  const liveBranch = cardBody.slice(liveBranchStart, nextBranchStart);
  assert.doesNotMatch(liveBranch, /sessionEntryTimeText/);
});

test('failed session messages render in the conversation with a left retry button', () => {
  const sourceText = source();
  const panelBody = methodBody('SessionConversationPanel()');
  const cardBody = methodBody('FailedSessionMessageCard(message: FailedSessionMessage)');
  const rememberBody = methodBody('rememberFailedSessionMessageAfterSendFailure(input: FailedSessionMessageRecordInput): void');
  const retryBody = methodBody('retryFailedSessionMessage(message: FailedSessionMessage, source: string = \'manual\'): Promise<void>');
  const visibleFailedBody = methodBody('visibleFailedSessionMessages(): FailedSessionMessage[]');

  assert.match(panelBody, /ForEach\(this\.visibleFailedSessionMessages\(\)/);
  assert.match(rememberBody, /this\.failedSessionMessages = \[/);
  assert.match(rememberBody, /retryLimit: this\.failedSessionAutoRetryLimit/);
  assert.match(rememberBody, /this\.scheduleFailedSessionAutoRetry\(id, 'new_failure'\)/);
  assert.match(rememberBody, /this\.scheduleFailedSessionAutoRetry\(input\.failedId, 'updated_failure'\)/);
  assert.match(rememberBody, /this\.sessionMessage = ''/);
  assert.match(rememberBody, /this\.pendingSessionImages = \[\]/);

  const blankIndex = cardBody.indexOf('Blank()');
  const retryIndex = cardBody.indexOf("retryFailedSessionMessage(message, 'manual')");
  const bubbleIndex = cardBody.indexOf('failedSessionMessageStatusText(message)');
  assert.ok(blankIndex >= 0 && retryIndex > blankIndex, 'retry button should appear after the right-aligning blank');
  assert.ok(bubbleIndex > retryIndex, 'retry button should appear to the left of the failed message bubble');
  assert.match(cardBody, /backgroundColor\(message\.retrying \? this\.themeColor\('#8A95A3'\) : this\.themeColor\('#14853D'\)\)/);
  assert.match(cardBody, /cancelFailedSessionAutoRetry\(message\.id\)/);
  assert.doesNotMatch(cardBody, /failed_message_repair/);
  assert.doesNotMatch(cardBody, /repairDesktopLiveFromPhone\('failed_message'\)/);

  assert.match(sourceText, /private failedSessionAutoRetryLimit: number = 5/);
  assert.match(sourceText, /private scheduleFailedSessionAutoRetry\(failedId: string, source: string\): void/);
  assert.match(sourceText, /private async autoRetryFailedSessionMessage\(failedId: string\): Promise<void>/);
  assert.match(sourceText, /private cancelFailedSessionAutoRetry\(failedId: string\): void/);
  assert.match(retryBody, /beginFailedSessionRetryAttempt\(message\.id, source\)/);
  assert.match(retryBody, /this\.sessionMessage = attempt\.text/);
  assert.match(retryBody, /this\.pendingSessionImages = attempt\.images\.slice\(\)/);
  assert.match(retryBody, /sendMessageToSelectedSession\(attempt\.id\)/);
  assert.match(retryBody, /sendNewSessionMessage\(attempt\.id\)/);
  assert.match(retryBody, /this\.scheduleFailedSessionAutoRetry\(attempt\.id, 'retry_failed'\)/);
  assert.match(visibleFailedBody, /pruneResolvedFailedSessionMessages/);
  assert.match(sourceText, /private failedSessionMessageHasCanonicalEntry/);
});

test('pending session sends become retryable chat messages when the bridge task fails', () => {
  const sourceText = source();
  const sendBody = methodBody('sendMessageToSelectedSession(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const newBody = methodBody('sendNewSessionMessage(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const terminalBody = methodBody('handleTaskTerminalForSession(task: BridgeTask, previousStatus: string, source: string): Promise<void>');
  const pendingBody = methodBody('rememberPendingSessionSend(taskId: string, pending: PendingSessionSend): void');
  const failedTerminalBody = methodBody('rememberFailedSessionMessageForTerminalTask(task: BridgeTask): void');
  const failureTextBody = methodBody('taskFailureMessage(task: BridgeTask): string');

  assert.match(sourceText, /interface PendingSessionSend/);
  assert.match(sourceText, /private pendingSessionSendsByTaskId: Record<string, PendingSessionSend> = \{\}/);
  assert.match(sendBody, /this\.rememberPendingSessionSend\(this\.currentTask\.id/);
  assert.match(sendBody, /引导已提交，正在确认 Codex 接收/);
  assert.match(newBody, /this\.rememberPendingSessionSend\(this\.currentTask\.id/);
  assert.match(terminalBody, /this\.rememberFailedSessionMessageForTerminalTask\(task\)/);
  assert.match(pendingBody, /this\.pendingSessionSendsByTaskId\[taskId\] = pending/);
  assert.match(failedTerminalBody, /this\.rememberFailedSessionMessageAfterSendFailure/);
  assert.match(failedTerminalBody, /this\.clearPendingSessionSend\(task\.id\)/);
  assert.match(failureTextBody, /event\.type === 'task\.failed'/);
});

test('selected session adoption does not replace a newer active guidance task with an older task summary', () => {
  const adoptBody = methodBody('adoptSelectedSessionTaskFromSummaries(tasks: BridgeTaskSummary[]): Promise<void>');
  const newerBody = methodBody('isTaskNewerThanSummary(task: BridgeTask, summary: BridgeTaskSummary): boolean');

  assert.match(adoptBody, /this\.isTaskRunningStatus\(this\.currentTask\.status\)/);
  assert.match(adoptBody, /this\.taskSessionId\(this\.currentTask\) === currentSelected/);
  assert.match(adoptBody, /this\.isTaskNewerThanSummary\(this\.currentTask, summary\)/);
  assert.match(adoptBody, /task\.selected_session\.adopt\.skipped_current_newer/);
  assert.match(newerBody, /taskUpdated/);
  assert.match(newerBody, /summaryUpdated/);
});

test('app-server send contract clears stale desktop CDP unavailable state', () => {
  const contractBody = methodBody('requiresDesktopLiveForSend(targetSessionId: string, source: string): Promise<boolean>');
  const applyBody = methodBody('applyAppServerPrimaryStatus(targetSessionId: string, source: string, execution: string): void');
  const taskBody = methodBody('applyTaskExecutionContract(task: BridgeTask, targetSessionId: string, source: string): void');
  const openBody = methodBody('openSession(session: CodexSessionSummary): Promise<void>');

  assert.match(contractBody, /!requiresDesktop[\s\S]*applyAppServerPrimaryStatus/);
  assert.match(applyBody, /this\.desktopLiveState = 'not_required'/);
  assert.match(applyBody, /this\.desktopLiveReason = ''/);
  assert.match(applyBody, /this\.desktopLiveRequiresDesktopCdp = false/);
  assert.match(taskBody, /this\.taskUsesAppServer\(task\)[\s\S]*applyAppServerPrimaryStatus/);
  assert.doesNotMatch(openBody, /syncDesktopAndRefresh|openDesktopSelectedSession/);
});

test('session entries expose official text and image copy and share actions', () => {
  const entryBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const actionBody = methodBody('SessionContentActionRow(entry: CodexSessionEntry, imageUrl: string)');
  const service = contentActionServiceSource();

  assert.match(entryBody, /SessionContentActionRow\(entry, imageUrl\)/);
  assert.match(entryBody, /SessionContentActionRow\(entry, ''\)/);
  assert.match(actionBody, /copySessionImage/);
  assert.match(actionBody, /shareSessionImage/);
  assert.match(actionBody, /copySessionText/);
  assert.match(actionBody, /shareSessionText/);
  assert.match(service, /pasteboard\.MIMETYPE_TEXT_PLAIN/);
  assert.match(service, /pasteboard\.MIMETYPE_PIXELMAP/);
  assert.match(service, /new systemShare\.ShareController/);
  assert.match(service, /fileUri\.getUriFromPath/);
});

test('session sidebar separates desktop projects from projectless recent sessions', () => {
  const sidebarBody = methodBody('SessionSidebar()');
  const itemBody = methodBody('SessionSidebarItem(session: CodexSessionSummary)');
  const labelsBody = methodBody('sessionProjectLabels(): string[]');
  const recentBody = methodBody('recentSessions(): CodexSessionSummary[]');
  const timeWidthBody = methodBody('sessionSidebarTimeWidth(): number');

  assert.match(sidebarBody, /SessionSectionLabel\('项目'\)/);
  assert.match(sidebarBody, /RecentSessionGroup\(\)/);
  assert.match(itemBody, /Text\(this\.sessionTimeLabel\(session\)\)[\s\S]*\.textAlign\(TextAlign\.End\)/);
  assert.match(itemBody, /\.width\(this\.sessionSidebarTimeWidth\(\)\)/);
  assert.doesNotMatch(itemBody, /Text\(this\.sessionTimeLabel\(session\)\)[\s\S]*?textOverflow/);
  assert.match(timeWidthBody, /84 \* fontScalePercent\(this\.fontScaleMode\) \/ 100/);
  assert.match(labelsBody, /session\.sidebarSection === 'recent'/);
  assert.match(recentBody, /session\.sidebarSection === 'recent'/);
});

test('session workspace uses responsive landscape columns with a fully hidden collapsible sidebar', () => {
  const sourceText = source();
  const workspaceBody = methodBody('SessionWorkspace()');
  const panelBody = methodBody('SessionPanel()');
  const sidebarBody = methodBody('SessionSidebar()');
  const resizeHandleBody = methodBody('SessionSidebarResizeHandle()');
  const shouldShowToggleBody = methodBody('shouldShowSessionHeaderSidebarToggle(): boolean');
  const toggleBody = methodBody('toggleSessionSidebarFromHeader(): void');
  const landscapeBody = methodBody('isLandscapeSessionLayout(): boolean');
  const sidebarVisibleBody = methodBody('isSessionSidebarVisible(): boolean');
  const sidebarMenuBody = methodBody('shouldShowHomeActionMenuInSidebar(): boolean');
  const resizeBody = methodBody('resizeSessionLandscapeSidebar(offsetX: number): void');
  const closeBody = methodBody('closeSessionSidebar(source: string): void');
  const openBody = methodBody('openSession(session: CodexSessionSummary): Promise<void>');
  const restoreBody = methodBody('restoreActiveSessionIfNeeded(): Promise<void>');
  const returnHomeBody = methodBody('returnToSessionHome(source: string): void');
  const sendBody = methodBody("sendMessageToSelectedSession(retryFailedMessageId: string = ''): Promise<boolean>");
  const aboutToAppearBody = methodBody('aboutToAppear(): void');
  const abilityText = entryAbilitySource();
  const moduleText = moduleProfileSource();

  assert.match(sourceText, /@StorageLink\('codexRemoteWindowWidth'\) sessionWindowWidth: number = 0/);
  assert.match(sourceText, /@StorageLink\('codexRemoteWindowHeight'\) sessionWindowHeight: number = 0/);
  assert.match(sourceText, /@StorageLink\('codexRemoteActiveSessionId'\) activeSessionId: string = ''/);
  assert.match(sourceText, /@StorageLink\('codexRemoteSessionNavigationState'\) sessionNavigationState: string = ''/);
  assert.match(sourceText, /@StorageLink\('codexRemoteSessionDraft'\) sessionMessage: string = ''/);
  assert.match(sourceText, /@StorageLink\('codexRemoteSessionSidebarWidth'\) sessionSidebarWidth: number = 304/);
  assert.match(sourceText, /@State sessionSidebarUserCollapsed: boolean = false/);
  assert.match(workspaceBody, /if \(this\.isLandscapeSessionLayout\(\)\)/);
  assert.match(workspaceBody, /if \(!this\.sessionSidebarUserCollapsed\)[\s\S]*this\.SessionSidebar\(\)[\s\S]*this\.SessionSidebarResizeHandle\(\)/);
  assert.match(workspaceBody, /\.width\(this\.sessionLandscapeSidebarWidth\(\)\)/);
  assert.match(workspaceBody, /if \(!this\.sessionSidebarCollapsed\)[\s\S]*this\.SessionSidebar\(\)/);
  assert.match(panelBody, /this\.SessionSidebarHeaderToggleButton\(\)/);
  assert.match(sidebarBody, /Column\(\{ space: 3 \}\)[\s\S]*\.layoutWeight\(1\)/);
  assert.match(resizeHandleBody, /PanGesture\(\{ direction: PanDirection\.Horizontal \}\)/);
  assert.match(resizeHandleBody, /this\.resizeSessionLandscapeSidebar\(event\.offsetX\)/);
  assert.match(resizeBody, /Math\.max\(this\.sessionLandscapeSidebarMinWidth\(\), Math\.min\(this\.sessionLandscapeSidebarMaxWidth\(\), nextWidth\)\)/);
  assert.match(sidebarVisibleBody, /this\.isLandscapeSessionLayout\(\) \? !this\.sessionSidebarUserCollapsed : !this\.sessionSidebarCollapsed/);
  assert.match(sidebarMenuBody, /this\.isSessionSidebarVisible\(\)/);
  assert.match(shouldShowToggleBody, /return this\.sessionSidebarCollapsed/);
  assert.match(toggleBody, /const collapsed = !this\.sessionSidebarUserCollapsed/);
  assert.match(toggleBody, /this\.sessionSidebarUserCollapsed = collapsed/);
  assert.match(landscapeBody, /width >= 720 && width > height/);
  assert.match(closeBody, /this\.sessionSidebarUserCollapsed = this\.isLandscapeSessionLayout\(\)/);
  assert.match(openBody, /this\.commitSessionNavigation\('session', session\.id, 'open_session'\)/);
  assert.match(openBody, /this\.sessionSidebarUserCollapsed = false/);
  assert.match(restoreBody, /const navigation = this\.readSessionNavigation\(\)/);
  assert.match(restoreBody, /navigation\.mode !== 'session'/);
  assert.match(restoreBody, /const restoreRevision = navigation\.revision/);
  assert.match(restoreBody, /this\.isSessionNavigationCurrent\(restoreRevision, sessionId\)/);
  assert.match(returnHomeBody, /this\.commitSessionNavigation\('home', '', source\)/);
  assert.match(sendBody, /const navigation = this\.readSessionNavigation\(\)/);
  assert.match(sendBody, /navigation\.mode !== 'session' \|\| navigation\.sessionId !== this\.selectedSession\.id/);
  assert.match(sendBody, /reason=navigation_target_mismatch/);
  assert.doesNotMatch(aboutToAppearBody, /this\.sessionMessage = ''/);
  assert.match(abilityText, /mainWindow\.on\('windowSizeChange', this\.windowSizeChangeHandler\)/);
  assert.match(abilityText, /mainWindow\.off\('windowSizeChange', this\.windowSizeChangeHandler\)/);
  assert.match(abilityText, /AppStorage\.set<number>\(WINDOW_WIDTH_STORAGE_KEY, width\)/);
  assert.match(abilityText, /AppStorage\.setOrCreate<string>\(ACTIVE_SESSION_STORAGE_KEY, ''\)/);
  assert.match(abilityText, /AppStorage\.setOrCreate<string>\(SESSION_DRAFT_STORAGE_KEY, ''\)/);
  assert.match(abilityText, /AppStorage\.setOrCreate<number>\(SESSION_SIDEBAR_WIDTH_STORAGE_KEY, 304\)/);
  assert.match(moduleText, /"orientation": "auto_rotation"/);
});

test('failed task overlay is suppressed after the phone prompt has a canonical assistant reply', () => {
  const selectedBody = methodBody('selectedVisibleTask()');
  const completedBody = methodBody('failedTaskHasCanonicalCompletion(task: BridgeTask): boolean');
  const adoptBody = methodBody('adoptSelectedSessionTaskFromSummaries(tasks: BridgeTaskSummary[]): Promise<void>');

  assert.match(selectedBody, /this\.failedTaskHasCanonicalCompletion\(this\.currentTask\)[\s\S]*return null/);
  assert.match(completedBody, /task\.status !== 'failed'/);
  assert.match(completedBody, /entry\.role !== 'user'/);
  assert.match(completedBody, /entry\.role === 'assistant'/);
  assert.match(completedBody, /index > promptIndex/);
  assert.match(adoptBody, /this\.failedTaskHasCanonicalCompletion\(task\)/);
  assert.match(adoptBody, /task\.selected_session\.adopt\.skipped_canonical_completion/);
});

test('local terminal task state suppresses stale running summaries before adoption', () => {
  const sourceText = source();
  const reconcileBody = methodBody('reconcileSessionTaskMonitor(tasks: BridgeTaskSummary[]): void');
  const ignoreBody = methodBody('shouldIgnoreRunningTaskForSession(sessionId: string, taskCreatedAt: string, taskId: string = \'\')');
  const latestRunningBody = methodBody('latestRunningTaskSummary(tasks: BridgeTaskSummary[]): BridgeTaskSummary | null');
  const latestForSessionBody = methodBody('latestTaskSummaryForSession(tasks: BridgeTaskSummary[], sessionId: string): BridgeTaskSummary | null');

  assert.match(sourceText, /private isTaskLocallyTerminalForSession\(taskId: string, sessionId: string\): boolean/);
  assert.match(ignoreBody, /this\.isTaskLocallyTerminalForSession\(taskId, sessionId\)/);
  assert.match(reconcileBody, /if \(this\.isTaskRunningStatus\(task\.status\)\) \{[\s\S]*const previousStatus = this\.taskStatusById\[task\.id\] \?\? '';/);
  assert.match(reconcileBody, /this\.shouldIgnoreRunningTaskForSession\(sessionId, task\.createdAt, task\.id\)[\s\S]*this\.isTaskTerminalStatus\(previousStatus\)/);
  assert.match(reconcileBody, /this\.isTaskTerminalStatus\(previousStatus\)[\s\S]*this\.taskStatusById\[task\.id\] = previousStatus/);
  assert.match(latestRunningBody, /this\.shouldIgnoreRunningTaskForSession\(sessionId, task\.createdAt, task\.id\)/);
  assert.match(latestForSessionBody, /const ignoreRunning = this\.isTaskRunningStatus\(task\.status\)[\s\S]*this\.shouldIgnoreRunningTaskForSession\(taskSessionId, task\.createdAt, task\.id\)/);
  assert.match(latestForSessionBody, /if \(ignoreRunning\) \{[\s\S]*continue;/);
});

test('phone desktop-live repair stays soft and failed-message retry does not restart Codex', () => {
  const repairBody = methodBody('repairDesktopLiveFromPhone(source: string): Promise<boolean>');
  const preflightBody = methodBody('ensureDesktopLiveReadyForSend(targetSessionId: string, source: string): Promise<boolean>');
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const cardBody = methodBody('FailedSessionMessageCard(message: FailedSessionMessage)');

  assert.match(repairBody, /BridgeClient\.recoverSystemLink\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, 'auto'\)/);
  assert.match(repairBody, /this\.applySystemLinkStatus\(link, targetSessionId\)/);
  assert.match(preflightBody, /BridgeClient\.getDesktopLiveStatus\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, true\)/);
  assert.doesNotMatch(preflightBody, /repairDesktopLive/);
  assert.doesNotMatch(cardBody, /repairDesktopLiveFromPhone\('failed_message'\)/);
  assert.match(clientText, /getSystemLinkStatus/);
  assert.match(clientText, /recoverSystemLink/);
  assert.match(clientText, /getSystemRepairStatus/);
  assert.match(clientText, /repairSystemLink/);
  assert.match(clientText, /mode: hard \? 'hard' : 'soft'/);
  assert.match(clientText, /readTimeout: hard \? 150000 : 90000/);
});

test('home plus menu owns account usage and desktop restart actions', () => {
  const sourceText = source();
  const sessionPanelBody = methodBody('SessionPanel()');
  const sidebarBody = methodBody('SessionSidebar()');
  const menuBody = methodBody('HomeActionMenu(source: string)');
  const actionBody = methodBody('handleHomeAction(action: string, source: string): void');
  const toggleBody = methodBody('toggleHomeActionMenu(source: string): void');
  const actionGuardBody = methodBody('shouldIgnoreHomeActionMenuAction(action: string, source: string): boolean');
  const sessionMenuVisibleBody = methodBody('shouldShowHomeActionMenuInSessionPanel(): boolean');
  const sidebarMenuVisibleBody = methodBody('shouldShowHomeActionMenuInSidebar(): boolean');
  const closeUsageBody = methodBody('closeAccountUsagePanel(source: string): void');
  const usageBody = methodBody('loadCodexAccountUsage(source: string): Promise<void>');
  const hardBody = methodBody('repairDesktopLiveHardFromPhone(source: string): Promise<boolean>');
  const confirmBody = methodBody('confirmHardRestartCodexFromPhone(source: string): void');
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');

  assert.match(sourceText, /@State homeActionMenuVisible: boolean = false/);
  assert.match(sourceText, /@State homeActionMenuSource: string = ''/);
  assert.match(sourceText, /@State accountUsagePanelVisible: boolean = false/);
  assert.match(sessionPanelBody, /this\.HomeActionButton\('home_header'\)/);
  assert.match(sessionPanelBody, /if \(this\.sessionSidebarCollapsed\)[\s\S]*this\.HomeActionButton\('home_header'\)/);
  assert.match(sidebarBody, /this\.HomeActionButton\('sidebar_header'\)/);
  assert.match(sidebarBody, /Stack\(\{ alignContent: Alignment\.TopEnd \}\)/);
  assert.match(sidebarBody, /this\.HomeActionMenu\('sidebar_header'\)/);
  assert.doesNotMatch(sidebarBody, /Row\(\) \{[\s\S]{0,80}this\.HomeActionMenu\('sidebar_header'\)/);
  assert.doesNotMatch(sidebarBody, /ui\.click\.desktop_repair/);
  assert.match(menuBody, /账号用量/);
  assert.match(menuBody, /新建会话/);
  assert.match(menuBody, /恢复链路/);
  assert.match(menuBody, /检测 bridge、CDP 与无线 HDC/);
  assert.match(menuBody, /重启 Codex/);
  assert.match(menuBody, /source === 'sidebar_header' \? 60 : 42/);
  assert.match(toggleBody, /this\.shouldIgnoreHomeActionToggle\(source\)/);
  assert.match(toggleBody, /this\.homeActionMenuSource = this\.homeActionMenuVisible \? source : ''/);
  assert.match(sessionMenuVisibleBody, /this\.homeActionMenuSource === 'home_header'/);
  assert.match(sidebarMenuVisibleBody, /this\.homeActionMenuSource === 'sidebar_header'/);
  assert.match(actionBody, /this\.shouldIgnoreHomeActionMenuAction\(action, source\)/);
  assert.match(actionBody, /this\.openAccountUsagePanel\(source\)/);
  assert.match(actionBody, /this\.confirmHardRestartCodexFromPhone/);
  assert.match(actionGuardBody, /reason=just_opened/);
  assert.match(closeUsageBody, /source === 'backdrop'/);
  assert.match(closeUsageBody, /close_ignored/);
  assert.match(usageBody, /BridgeClient\.getCodexAccountUsage/);
  assert.match(confirmBody, /AlertDialog\.show/);
  assert.match(hardBody, /BridgeClient\.repairSystemLink\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, 'hard', true\)/);
  assert.match(clientText, /getCodexAccountUsage/);
  assert.match(clientText, /confirmHardRestart/);
});

test('session refresh only follows live activity when the user is already near bottom', () => {
  const refreshBody = methodBody('refreshSelectedSessionDetail(): Promise<void>');
  const followBody = methodBody('scrollSessionToBottomIfFollowing(delayMs: number = 50, source: string = \'auto_refresh\'): void');
  const willScrollBody = methodBody('handleSessionWillScroll(yOffset: number, scrollSource: ScrollSource): void');
  const edgeBody = methodBody('handleSessionScrollEdge(edge: Edge): void');

  assert.match(refreshBody, /this\.scrollSessionToBottomIfFollowing\(60, 'session_detail_refresh'\)/);
  assert.match(followBody, /if \(!this\.sessionAutoFollowBottom\)/);
  assert.match(followBody, /ui\.session_scroll\.follow_skipped/);
  assert.match(willScrollBody, /this\.sessionAutoFollowBottom = false/);
  assert.match(willScrollBody, /this\.bumpSessionScrollGeneration\(\)/);
  assert.match(edgeBody, /this\.sessionAutoFollowBottom = true/);
});

test('stale session detail responses cannot overwrite the current conversation', () => {
  const loadBody = methodBody('loadSessionDetail(sessionId: string): Promise<void>');
  const homeBody = methodBody('returnToSessionHome(source: string): void');

  assert.match(source(), /private sessionDetailRequestSeq: number = 0/);
  assert.match(loadBody, /const requestSeq = \+\+this\.sessionDetailRequestSeq/);
  assert.match(loadBody, /requestSeq !== this\.sessionDetailRequestSeq/);
  assert.match(loadBody, /session\.detail\.stale_ignored/);
  assert.match(loadBody, /session\.detail\.stale_error_ignored/);
  assert.match(loadBody, /this\.applySessionActivitySnapshot\(detail, 'detail'\)/);
  assert.match(homeBody, /this\.sessionDetailRequestSeq \+= 1/);
});

test('mobile uses the Bridge runtime contract before skipping CDP and preserves a retry submission identity', () => {
  const sourceText = source();
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const modelText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/model/BridgeModels.ets'), 'utf8');
  const sendBody = methodBody('sendMessageToSelectedSession(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const newBody = methodBody('sendNewSessionMessage(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const contractBody = methodBody('requiresDesktopLiveForSend(targetSessionId: string, source: string): Promise<boolean>');
  const desktopReadyBody = methodBody('ensureDesktopLiveReadyForSend(targetSessionId: string, source: string): Promise<boolean>');
  const taskRuntimeBody = methodBody('taskUsesAppServer(task: BridgeTask | BridgeTaskSummary): boolean');
  const retryBody = methodBody('submissionIdForRetry(retryFailedMessageId: string): string');
  const nextRetryBody = methodBody('updateFailedSessionMessageNextRetryAt(failedId: string, nextRetryAt: string): void');
  const updateRetryBody = methodBody('updateFailedSessionMessage(failedId: string, retrying: boolean, error: string = \'\'): void');

  assert.match(modelText, /export interface BridgeRuntimeStatus/);
  assert.match(modelText, /existingThreadExecution: string/);
  assert.match(modelText, /submissionId\?: string/);
  assert.match(clientText, /static async getRuntimeStatus/);
  assert.match(clientText, /\$\{baseUrl\}\/health\?\$\{params\.join\('&'\)\}/);
  assert.match(clientText, /JSON\.stringify\(\{ projectId, text, sessionFingerprint, reasoningEffort, model, submissionId \}\)/);
  assert.match(clientText, /JSON\.stringify\(\{ projectId, text, reasoningEffort, model, submissionId \}\)/);

  assert.match(sendBody, /const requiresDesktopLive = await this\.requiresDesktopLiveForSend/);
  assert.match(sendBody, /if \(requiresDesktopLive\) \{[\s\S]*ensureDesktopLiveReadyForSend/);
  assert.match(sendBody, /submissionId/);
  assert.match(newBody, /this\.submissionIdForRetry\(retryFailedMessageId\)/);
  assert.match(contractBody, /BridgeClient\.getRuntimeStatus/);
  assert.match(contractBody, /runtime\.existingThreadExecution !== 'app_server'/);
  assert.doesNotMatch(contractBody, /runtime\.existingThreadExecution !== 'desktop_primary'/);
  assert.match(desktopReadyBody, /status\.sessionVerified === true \|\| status\.targetVerified === true/);
  assert.match(contractBody, /return true;/);
  assert.match(taskRuntimeBody, /task\.runtime\?\.kind === 'app_server'/);
  assert.match(retryBody, /failed\.submissionId/);
  assert.match(sourceText, /submissionId: pending\.submissionId/);
  assert.match(nextRetryBody, /submissionId: message\.submissionId/);
  assert.match(updateRetryBody, /submissionId: message\.submissionId/);
  assert.match(sourceText, /status === 'recovering'/);
});

test('mobile renders and answers structured App Server questions and can explicitly hand off to desktop', () => {
  const sourceText = source();
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const modelText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/model/BridgeModels.ets'), 'utf8');
  const answerBody = methodBody('answerPendingUserInput(): Promise<void>');
  const desktopBody = methodBody('openDesktopSelectedSession(source: string): Promise<void>');

  assert.match(modelText, /export interface BridgeUserInput/);
  assert.match(modelText, /pendingUserInput\?: BridgeUserInput/);
  assert.match(clientText, /static async answerUserInput/);
  assert.match(clientText, /\/user-inputs\/\$\{requestId\}/);
  assert.match(sourceText, /UserInputForm\(\)/);
  assert.match(sourceText, /waiting_input/);
  assert.match(answerBody, /BridgeClient\.answerUserInput/);
  assert.match(desktopBody, /BridgeClient\.openDesktopSession/);
  assert.match(sourceText, /@State isOpeningDesktopSession: boolean = false/);
  assert.match(sourceText, /LoadingProgress\(\)/);
  assert.match(desktopBody, /this\.isOpeningDesktopSession = true/);
  assert.match(desktopBody, /desktop\.session\.open\.requested/);
  assert.match(desktopBody, /finally[\s\S]*this\.isOpeningDesktopSession = false/);
  assert.match(sourceText, /DesktopTakeoverButton\(\)/);
});

test('notifications are privacy-safe, categorized, and deep-link to the target conversation', () => {
  const notificationText = fs.readFileSync(notificationServicePath, 'utf8');
  const abilityText = entryAbilitySource();
  const navigationBody = methodBody('applyPendingNotificationNavigation(): Promise<void>');
  const attentionBody = methodBody('publishTaskAttentionNotification(task: BridgeTask, previousStatus: string): Promise<void>');

  assert.match(notificationText, /approval_required/);
  assert.match(notificationText, /user_input_required/);
  assert.match(notificationText, /connection_error/);
  assert.match(notificationText, /parameters:/);
  assert.doesNotMatch(notificationText, /prompt|command|answer正文|提示词/);
  assert.match(abilityText, /onNewWant/);
  assert.match(abilityText, /applyNotificationTarget/);
  assert.match(navigationBody, /this\.sessions\.find/);
  assert.match(navigationBody, /await this\.openSession\(target\)/);
  assert.match(navigationBody, /this\.showTaskEventDetails/);
  assert.match(attentionBody, /AppNotificationService\.publish/);
});

test('monitoring falls back to a stable privacy-safe notification and an always-on system-brightness dashboard', () => {
  const notificationText = fs.readFileSync(notificationServicePath, 'utf8');
  const panelText = fs.readFileSync(desktopMonitorPanelPath, 'utf8');
  const displayText = fs.readFileSync(desktopMonitorDisplayServicePath, 'utf8');
  const abilityText = entryAbilitySource();
  const indexText = source();

  assert.match(notificationText, /MONITOR_NOTIFICATION_ID:\s*number\s*=\s*31_070/);
  assert.match(notificationText, /syncMonitorSnapshot/);
  assert.match(notificationText, /运行 \$\{snapshot\.runningCount\} · 未读 \$\{snapshot\.unreadCount\}/);
  assert.match(notificationText, /notificationManager\.cancel\(MONITOR_NOTIFICATION_ID\)/);
  assert.match(notificationText, /isAlertOnce:\s*true/);
  assert.match(notificationText, /tapDismissed:\s*false/);
  assert.doesNotMatch(notificationText, /sessionTitles|sessionProjects|prompt|command/);

  assert.match(panelText, /export struct DesktopMonitorPanel/);
  assert.match(panelText, /Codex 小夜灯/);
  assert.match(panelText, /this\.snapshot\.runningCount/);
  assert.match(panelText, /this\.snapshot\.unreadCount/);
  assert.match(panelText, /usagePrimaryValue/);
  assert.match(panelText, /this\.landscape/);
  assert.match(panelText, /this\.snapshot\.shiftIndex/);
  assert.match(panelText, /this\.snapshot\.mirrored/);
  assert.match(panelText, /始终常亮/);
  assert.match(panelText, /跟随系统亮度/);
  assert.match(panelText, /Row\(\{ space: 1 \}\)/);
  assert.doesNotMatch(panelText, /Text\('•ᴗ•'\)/);
  assert.match(panelText, /ENERGY_SEGMENT_COUNT:\s*number\s*=\s*10/);
  assert.match(panelText, /kind === 'running' \|\| kind === 'unread' \|\| kind === 'recent'/);
  assert.match(panelText, /endedSessionCount/);
  assert.match(panelText, /EnergyBar/);
  assert.match(panelText, /quotaPercentText/);
  assert.match(panelText, /this\.landscape \? 68 : 70/);

  assert.match(displayText, /setWindowKeepScreenOn\(true\)/);
  assert.match(displayText, /batteryInfo\.chargingStatus/);
  assert.match(displayText, /setWindowKeepScreenOn\(false\)/);
  assert.match(displayText, /followsSystemBrightness:\s*true/);
  assert.doesNotMatch(displayText, /setWindowBrightness|MONITOR_BRIGHTNESS|originalBrightness/);

  assert.doesNotMatch(abilityText, /LiveViewCapabilityService|LiveViewProbe|LIVE_VIEW_/);
  assert.doesNotMatch(indexText, /LiveViewCapabilityService|syncSnapshot\(context, snapshot\)/);
  assert.match(indexText, /AppNotificationService\.syncMonitorSnapshot\(snapshot\)/);
  assert.match(indexText, /this\.HomeActionMenuItem\('desktop_monitor'/);
  assert.match(indexText, /DesktopMonitorPanel\(/);
  assert.match(indexText, /DesktopMonitorDisplayService\.enter/);
  assert.match(indexText, /DesktopMonitorDisplayService\.leave/);
});

test('history refresh updates an existing native item without moving or duplicating it', () => {
  const body = methodBody('mergeSessionEntryPages');
  const merge = new Function(`${stripTypeScriptTypes(`function merge(older, newer) {${body}}`)}; return merge;`)();
  const old = { syncId: 'item-a', text: 'partial' };
  const other = { syncId: 'item-b', text: 'same text' };
  const updated = { syncId: 'item-a', text: 'complete' };
  const distinct = { syncId: 'item-c', text: 'same text' };
  assert.deepEqual(merge([old, other], [updated, distinct]), [updated, other, distinct]);
});

test('refreshing a recent page with a wider snapshot keeps latest messages at the bottom', () => {
  const body = methodBody('mergeSessionEntryPages');
  const merge = new Function(`${stripTypeScriptTypes(`function merge(older, newer) {${body}}`)}; return merge;`)();
  const history = Array.from({ length: 160 }, (_, index) => ({
    syncId: `message-${index}`, timestamp: new Date(1700000000000 + index * 1000).toISOString(), text: `${index}`
  }));
  const current = history.slice(-2);
  assert.deepEqual(merge(current, history), history);
  assert.deepEqual(merge(merge(current, history), history), history);
  assert.deepEqual(merge(history.slice(0, 80), history.slice(80)), history);
});

test('phone only reports restart success after an executed hard repair', async () => {
  const body = methodBody('repairDesktopLiveHardFromPhone');
  for (const repaired of [false, true]) {
    const system = { repairMode: 'hard', repaired, desktop: { desktopLive: true } };
    const run = new Function('BridgeClient', `${stripTypeScriptTypes(`async function run(source) {${body}}`)}; return run;`)({
      async repairSystemLink() { return system; }
    });
    const state = { desktopLiveRestarting: false, isNewSessionDraft: true, selectedSession: null,
      normalizedBridgeUrl() { return ''; }, log() {}, applySystemRepairStatus() {},
      systemRepairMessageText() { return '本次未执行重启'; }, async refreshDashboard() {} };
    assert.equal(await run.call(state, 'test'), repaired);
    assert.equal(state.message, repaired ? 'Codex 已重启并恢复链路' : '本次未执行重启');
    assert.equal(state.desktopLiveRestarting, false);
  }
});

test('prepending history compensates the retained message displacement exactly once', () => {
  const body = methodBody('restoreHistoryScrollAnchor');
  const restore = new Function(`${stripTypeScriptTypes(`function restore(key, oldArea, newArea) {${body}}`)}; return restore;`)();
  let offset = 48;
  const state = { historyScrollAnchorKey: 'retained-message', sessionAutoFollowBottom: false,
    sessionScroller: { scrollBy(x, delta) { assert.equal(x, 0); offset += delta; } }, log() {} };
  restore.call(state, 'other-message', { position: { y: 100 } }, { position: { y: 1600 } });
  assert.equal(offset, 48);
  restore.call(state, 'retained-message', { position: { y: 100 } }, { position: { y: 1600 } });
  assert.equal(1600 - offset, 100 - 48, 'message stays at the same viewport position');
  restore.call(state, 'retained-message', { position: { y: 100 } }, { position: { y: 1600 } });
  assert.equal(offset, 1548);
  assert.equal(state.sessionAutoFollowBottom, false);
});

test('conversation history loads older cursor pages at the top without re-enabling bottom follow', () => {
  const sourceText = source();
  const clientText = fs.readFileSync(
    path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'),
    'utf8'
  );
  const modelText = bridgeModelsSource();
  const edgeBody = methodBody('handleSessionScrollEdge(edge: Edge): void');
  const olderBody = methodBody('loadOlderSessionEntries(source: string): Promise<void>');
  const refreshBody = methodBody('refreshSelectedSessionDetail(): Promise<void>');

  assert.match(modelText, /export interface CodexSessionSync/);
  assert.match(modelText, /sync\?: CodexSessionSync/);
  assert.match(modelText, /syncId\?: string/);
  assert.match(clientText, /static async getSessionHistoryPage/);
  assert.match(clientText, /\/api\/codex\/threads\/\$\{sessionId\}\/sync/);
  assert.match(sourceText, /this\.SessionHistoryLoader\(\)/);
  assert.match(edgeBody, /edge === Edge\.Top[\s\S]*loadOlderSessionEntries\('scroll_edge_top'\)/);
  assert.match(olderBody, /BridgeClient\.getSessionHistoryPage/);
  assert.match(olderBody, /beforeCursor/);
  assert.match(olderBody, /this\.sessionAutoFollowBottom = false/);
  assert.match(olderBody, /this\.mergeSessionEntryPages/);
  assert.match(refreshBody, /this\.mergeSessionDetailPreservingHistory/);
});

test('the ability owns an idempotent data-transfer background runtime across lifecycle transitions', () => {
  const abilityText = entryAbilitySource();
  const profileText = moduleProfileSource();
  const backgroundText = backgroundRuntimeServiceSource();
  const indexText = source();

  assert.match(profileText, /"backgroundModes":\s*\["dataTransfer"\]/);
  assert.match(profileText, /ohos\.permission\.KEEP_BACKGROUND_RUNNING/);
  assert.match(backgroundText, /export class AppBackgroundRuntimeService/);
  assert.match(backgroundText, /static async ensureRunning/);
  assert.match(backgroundText, /startPromise/);
  assert.match(backgroundText, /backgroundTaskManager\.startBackgroundRunning/);
  assert.match(backgroundText, /backgroundTaskManager\.BackgroundMode\.DATA_TRANSFER/);
  assert.match(abilityText, /onCreate[\s\S]*AppBackgroundRuntimeService\.ensureRunning\(this\.context,\s*'ability_create'\)/);
  assert.match(abilityText, /onForeground[\s\S]*AppBackgroundRuntimeService\.ensureRunning\(this\.context,\s*'ability_foreground'\)/);
  assert.match(abilityText, /onBackground[\s\S]*AppBackgroundRuntimeService\.ensureRunning\(this\.context,\s*'ability_background'\)/);
  assert.match(indexText, /AppBackgroundRuntimeService\.ensureRunning\(context,\s*'index_relay'\)/);
  assert.doesNotMatch(indexText, /backgroundTaskManager\.startBackgroundRunning/);
});

test('notification badges use absolute unread counts and unchanged monitor snapshots do not accumulate', () => {
  const notificationText = fs.readFileSync(notificationServicePath, 'utf8');
  const indexText = source();

  assert.match(notificationText, /static async syncBadgeNumber\(unreadCount: number\): Promise<void>/);
  assert.match(notificationText, /notificationManager\.setBadgeNumber\(normalizedUnreadCount\)/);
  assert.match(notificationText, /badgeNumber:\s*0/);
  assert.doesNotMatch(notificationText, /badgeNumber:\s*snapshot\.unreadCount/);
  assert.match(notificationText, /lastMonitorNotificationKey/);
  assert.match(notificationText, /action:\s*'unchanged'/);
  assert.match(indexText, /AppNotificationService\.syncBadgeNumber\(this\.unreadCompletedSessionIds\.length\)/);
});

test('mobile deletion blocks running sessions and describes archive-safe desktop synchronization', () => {
  const indexText = source();
  const canDeleteBody = methodBody('canDeleteSession(session: CodexSessionSummary): boolean');
  const confirmDeleteBody = methodBody('confirmDeleteSession(session: CodexSessionSummary): void');

  assert.match(canDeleteBody, /!this\.isSessionRunning\(session\.id\)/);
  assert.match(confirmDeleteBody, /会话正在运行/);
  assert.match(confirmDeleteBody, /从手机和桌面会话列表隐藏/);
  assert.doesNotMatch(confirmDeleteBody, /物理删除/);
});

test('mobile document attachments use the system picker and enforce client and server limits', () => {
  const attachmentText = fs.readFileSync(
    path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/AttachmentService.ets'),
    'utf8'
  );
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const composeBody = methodBody('composeOutgoingSessionMessage(text: string, images: PendingSessionImage[], files: PickedMobileFile[]): Promise<ComposedSessionMessage>');

  assert.match(attachmentText, /DocumentViewPicker/);
  assert.match(attachmentText, /10 \* 1024 \* 1024/);
  assert.match(attachmentText, /lower === '\.env'/);
  assert.match(clientText, /static async uploadMobileFile/);
  assert.match(clientText, /\/mobile\/files/);
  assert.match(composeBody, /BridgeClient\.uploadMobileFile/);
  assert.match(composeBody, /AttachmentService\.readAsBase64/);
  assert.match(source(), /PendingSessionFileStrip\(\)/);
});

test('mobile exposes the durable send queue editing contract', () => {
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const panelBody = methodBody('OutboxPanel()');
  const itemBody = methodBody('OutboxItemCard(item: BridgeOutboxItem)');

  assert.match(clientText, /static async listOutbox/);
  assert.match(clientText, /static async updateOutboxItem/);
  assert.match(clientText, /static async moveOutboxItem/);
  assert.match(clientText, /static async cancelOutboxItem/);
  assert.match(clientText, /static async retryOutboxItem/);
  assert.match(panelBody, /每个会话严格按顺序发送/);
  assert.match(itemBody, /saveOutboxItem/);
  assert.match(itemBody, /moveOutboxItem/);
  assert.match(itemBody, /cancelOutboxItem/);
  assert.match(source(), /this\.HomeActionMenuItem\('outbox'/);
});

test('desktop file links require confirmation before downloading and open with a URI grant', () => {
  const sourceText = source();
  const actionText = contentActionServiceSource();
  const clientText = fs.readFileSync(
    path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'),
    'utf8'
  );
  const inlineBody = methodBody(
    'SessionMarkdownInlineText(text: string, isUser: boolean, fontSize: number, lineHeight: number)'
  );

  assert.match(inlineBody, /openSessionMarkdownLink\(segment\.href\)/);
  assert.match(sourceText, /title: '下载电脑端文件？'/);
  assert.match(sourceText, /value: '下载并打开'/);
  assert.match(sourceText, /ContentActionService\.downloadRemoteFile/);
  assert.match(sourceText, /ContentActionService\.openRemoteFile/);
  assert.match(clientText, /static async getRemoteSessionFileMetadata/);
  assert.match(clientText, /\/files\/metadata/);
  assert.match(clientText, /\/files\/download/);
  assert.match(actionText, /ohos\.want\.action\.viewData/);
  assert.match(actionText, /FLAG_AUTH_READ_URI_PERMISSION/);
  assert.match(actionText, /context\.filesDir/);
});

test('desktop file metadata failures are shown as an actionable dialog', () => {
  const openBody = methodBody('openSessionMarkdownLink(href: string)');
  const errorBody = methodBody('showRemoteFileError(title: string, detail: string)');

  assert.match(openBody, /showRemoteFileError\('无法下载文件'/);
  assert.match(errorBody, /AlertDialog\.show/);
  assert.match(errorBody, /value: '知道了'/);
  assert.match(errorBody, /message: detail/);
});

test('session sidebar distinguishes an authorization failure from a genuinely empty conversation list', () => {
  const sidebarBody = methodBody('SessionSidebar()');
  const refreshBody = methodBody('refreshSessions(source: string = \'manual\'): Promise<void>');
  const text = source();

  assert.match(text, /@State sessionsLoadError: string = ''/);
  assert.match(sidebarBody, /this\.sessionsLoadError\.length > 0/);
  assert.match(sidebarBody, /连接会话失败/);
  assert.match(sidebarBody, /检查 Bridge 地址和访问凭证后下拉重试/);
  assert.match(refreshBody, /this\.sessionsLoadError = ''/);
  assert.match(refreshBody, /this\.sessionsLoadError = this\.errorText\(err\)/);
});


test('model header distinguishes automatic choice and shortens known model names', () => {
  const body = methodBody('modelHeaderLabel');
  const label = new Function(body);
  for (const [name, expected] of [['', '自动'], ['GPT-6-Astra', 'Astra'], ['GPT-5.5', '5.5'], ['custom-model', 'custom-model']]) {
    assert.equal(label.call({ sessionModel: name, normalizeModel: x => x, modelShortLabel: x => x }), expected);
  }
});

test('model menu scrolls all options under a viewport height limit', () => {
  const menu = methodBody('ReasoningEffortMenu');
  assert.match(menu, /Scroll\(\)/);
  assert.match(menu, /maxHeight/);
  assert.match(menu, /modelOptionValues/);
  assert.match(menu, /reasoningEffortValues/);
  assert.doesNotMatch(methodBody('ReasoningEffortHeaderButton'), /bindSheet/);
  assert.doesNotMatch(source(), /ModelSettingsContent|shouldShowModelSheet/);
});
