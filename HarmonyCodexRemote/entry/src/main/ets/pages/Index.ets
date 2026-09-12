import { AppLogPayload, BridgeClient } from '../services/BridgeClient';
import { BridgeEvent, BridgeOutboxItem, BridgeProject, BridgeRuntimeStatus, BridgeTask, BridgeTaskSummary, BridgeUserInput, BridgeUserInputOption, BridgeUserInputQuestion, CodexAccountUsage, CodexAccountUsageItem, CodexModelOption, CodexRuntimeSnapshot, CodexSessionDetail, CodexSessionEntry, CodexSessionFingerprint, CodexSessionSummary, CodexSessionSync, DesktopLiveStatus, DesktopScreenshotImage, MobileFileUpload, MobileImageUpload, RemoteSessionFile, SlashIndexItem, SystemLinkStatus, SystemRepairStatus } from '../model/BridgeModels';
import { HdcRelayConfig, HdcRelayState, HdcRelayTunnel } from '../services/HdcRelayTunnel';
import { ContentActionService } from '../services/ContentActionService';
import { AttachmentService, PickedMobileFile } from '../services/AttachmentService';
import { MarkdownReader } from '../components/MarkdownReader';
import {
  MarkdownDocumentService,
  MarkdownReaderDocument
} from '../services/MarkdownDocumentService';
import {
  compactAdjacentSessionToolEntries,
  parseSessionMarkdownInline,
  parseSessionMarkdownTable,
  sessionToolPresentationItems,
  SessionMarkdownInlineSegment,
  SessionMarkdownTableData,
  SessionToolPresentationItem
} from '../services/SessionPresentationService';
import {
  appendOptimisticSessionMessage,
  OptimisticSessionMessage,
  optimisticSessionMessagesForTarget,
  removeOptimisticSessionMessage
} from '../services/OptimisticMessageService';
import {
  AppNotificationService,
  MonitorNotificationSyncResult,
  NOTIFICATION_EVENT_ID_STORAGE_KEY,
  NOTIFICATION_EVENT_TYPE_STORAGE_KEY,
  NOTIFICATION_REVISION_STORAGE_KEY,
  NOTIFICATION_SESSION_STORAGE_KEY
} from '../services/AppNotificationService';
import { DesktopMonitorPanel } from '../components/DesktopMonitorPanel';
import {
  DesktopMonitorDisplayService,
  DesktopMonitorDisplayState
} from '../services/DesktopMonitorDisplayService';
import { StandbyMonitorSnapshot } from '../model/StandbyMonitorModels';
import { StandbyMonitorSnapshotService } from '../services/StandbyMonitorSnapshotService';
import { SessionRuntimeStore } from '../services/SessionRuntimeStore';
import { AppBackgroundRuntimeService } from '../services/AppBackgroundRuntimeService';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { KeyboardAvoidMode } from '@kit.ArkUI';
import {
  DEFAULT_BRIDGE_TOKEN,
  DEFAULT_BRIDGE_URL,
  DEFAULT_DEVICE_ID,
  DEFAULT_EMBEDDED_RELAY_ENABLED,
  DEFAULT_HDCD_HOST,
  DEFAULT_HDCD_PORT,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  DEFAULT_RELAY_TOKEN
} from '../config/BridgeConfig';
import {
  AppThemeTokens,
  appThemeTokens,
  DEFAULT_THEME_MODE,
  normalizeThemeMode,
  resolveThemeColor,
  THEME_MODE_STORAGE_KEY,
  themeModeLabel
} from '../theme/AppTheme';
import {
  DEFAULT_FONT_SCALE_MODE,
  FONT_SCALE_STORAGE_KEY,
  fontScaleLabel,
  fontScalePercent,
  normalizeFontScaleMode,
  scaleFontSize
} from '../theme/AppTypography';

PersistentStorage.persistProp(THEME_MODE_STORAGE_KEY, DEFAULT_THEME_MODE);
PersistentStorage.persistProp(FONT_SCALE_STORAGE_KEY, DEFAULT_FONT_SCALE_MODE);

interface PendingSessionImage {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
}

interface ComposedSessionMessage {
  text: string;
  uploadedImages: PendingSessionImage[];
  failedImages: PendingSessionImage[];
  uploadedFiles: PickedMobileFile[];
  failedFiles: PickedMobileFile[];
}

interface FailedSessionMessage {
  id: string;
  sessionId: string;
  isNewSession: boolean;
  projectId: string;
  submissionId: string;
  text: string;
  images: PendingSessionImage[];
  files: PickedMobileFile[];
  error: string;
  createdAt: string;
  retrying: boolean;
  retryCount: number;
  retryLimit: number;
  autoRetryEnabled: boolean;
  nextRetryAt: string;
}

interface FailedSessionMessageRecordInput {
  failedId: string;
  sessionId: string;
  isNewSession: boolean;
  projectId: string;
  submissionId: string;
  text: string;
  images: PendingSessionImage[];
  files: PickedMobileFile[];
  error: string;
}

interface PendingSessionSend {
  sessionId: string;
  isNewSession: boolean;
  projectId: string;
  submissionId: string;
  text: string;
  images: PendingSessionImage[];
  files: PickedMobileFile[];
  retryFailedMessageId: string;
}

interface SessionMarkdownBlock {
  id: string;
  kind: string;
  text: string;
  level: number;
  checked: boolean;
  ordered: boolean;
  language: string;
}

interface SessionStructuredField {
  label: string;
  value: string;
  meta: string;
  kind: string;
}

interface SessionNavigationSnapshot {
  revision: number;
  mode: string;
  sessionId: string;
}

@Entry
@Component
struct Index {
  @StorageLink('codexRemoteThemeMode') themeMode: string = DEFAULT_THEME_MODE;
  @StorageLink('codexRemoteSystemDarkMode') systemDarkMode: boolean = false;
  @StorageLink('codexRemoteFontScaleMode') fontScaleMode: string = DEFAULT_FONT_SCALE_MODE;
  @StorageLink('codexRemoteWindowWidth') sessionWindowWidth: number = 0;
  @StorageLink('codexRemoteWindowHeight') sessionWindowHeight: number = 0;
  @StorageLink('codexRemoteActiveSessionId') activeSessionId: string = '';
  @StorageLink('codexRemoteSessionNavigationState') sessionNavigationState: string = '';
  @StorageLink('codexRemoteSessionDraft') sessionMessage: string = '';
  @StorageLink('codexRemoteSessionSidebarWidth') sessionSidebarWidth: number = 304;
  @StorageLink('codexRemotePreviewImageUrl') previewImageUrl: string = '';
  @StorageLink('codexRemoteDesktopPreviewImageUrl') desktopScreenshotPreviewUrl: string = '';
  @StorageLink('codexRemoteImagePreviewScale') desktopScreenshotScale: number = 1;
  @StorageLink('codexRemoteImagePreviewRotation') desktopScreenshotRotation: number = 0;
  @StorageLink('codexRemoteImagePreviewOffsetX') desktopScreenshotOffsetX: number = 0;
  @StorageLink('codexRemoteImagePreviewOffsetY') desktopScreenshotOffsetY: number = 0;
  @StorageLink(NOTIFICATION_SESSION_STORAGE_KEY) notificationTargetSessionId: string = '';
  @StorageLink(NOTIFICATION_EVENT_TYPE_STORAGE_KEY) notificationTargetEventType: string = '';
  @StorageLink(NOTIFICATION_EVENT_ID_STORAGE_KEY) notificationTargetEventId: string = '';
  @StorageLink(NOTIFICATION_REVISION_STORAGE_KEY) notificationTargetRevision: string = '';
  @State bridgeUrl: string = DEFAULT_BRIDGE_URL;
  @State bridgeToken: string = DEFAULT_BRIDGE_TOKEN;
  @State prompt: string = '请检查当前项目，修复发现的问题，并用中文说明改动和验证结果';
  @State projects: BridgeProject[] = [];
  @State tasks: BridgeTaskSummary[] = [];
  @State sessions: CodexSessionSummary[] = [];
  @State sessionsLoadError: string = '';
  @State lastGoodSessionCount: number = 0;
  @State selectedSession: CodexSessionDetail | null = null;
  @State selectedProjectId: string = 'probe';
  @State currentTask: BridgeTask | null = null;
  @State message: string = '就绪';
  @State isBusy: boolean = false;
  @State activeTab: string = 'sessions';
  @State logSessionId: string = `app-${Date.now()}`;
  @State sessionSidebarCollapsed: boolean = false;
  @State sessionSidebarUserCollapsed: boolean = false;
  @State collapsedSessionProjects: string[] = [];
  @State sessionModel: string = '';
  @State desktopDefaultModel: string = '';
  @State availableModels: CodexModelOption[] = [];
  @State sessionReasoningEffort: string = '';
  @State desktopDefaultReasoningEffort: string = '';
  @State reasoningEffortMenuVisible: boolean = false;
  @State isSavingReasoningEffort: boolean = false;
  @State isNewSessionDraft: boolean = false;
  @State newSessionTaskId: string = '';
  @State activeSessionTaskId: string = '';
  @State activeSessionTaskTitle: string = '';
  @State expandedSessionEntries: string[] = [];
  @State runningSessionIds: string[] = [];
  @State unreadCompletedSessionIds: string[] = [];
  @State locallyClearedRunningSessionIds: string[] = [];
  @State sessionMonitorRevision: number = 0;
  @State showTaskEventDetails: boolean = false;
  @State relayStateText: HdcRelayState = '已停止';
  @State relayDetailText: string = '中继待启动';
  @State relayToHdcdBytes: number = 0;
  @State hdcdToRelayBytes: number = 0;
  @State desktopLiveState: string = 'unknown';
  @State desktopLiveMessage: string = '未检测';
  @State desktopLiveReason: string = '';
  @State desktopLiveCurrentSessionId: string = '';
  @State desktopLiveTargetSessionId: string = '';
  @State desktopLiveSessionVerified: boolean = false;
  @State desktopLiveChecking: boolean = false;
  @State desktopLiveRestarting: boolean = false;
  @State isOpeningDesktopSession: boolean = false;
  @State desktopLiveRequiresDesktopCdp: boolean = false;
  @State desktopLiveMobileRecoverable: boolean = true;
  @State desktopLiveFailureClass: string = '';
  @State desktopLiveRecoveryHint: string = '';
  @State desktopLiveProcessMode: string = '';
  @State desktopLiveCdpPort: number = 0;
  @State systemRepairAction: string = '';
  @State systemRepairMessage: string = '';
  @State systemLinkSeverity: string = '';
  @State systemLinkRecoverableFromPhone: boolean = true;
  @State homeActionMenuVisible: boolean = false;
  @State homeActionMenuSource: string = '';
  @State themeModeChooserVisible: boolean = false;
  @State fontScaleChooserVisible: boolean = false;
  @State accountUsagePanelVisible: boolean = false;
  @State isLoadingAccountUsage: boolean = false;
  @State accountUsage: CodexAccountUsage | null = null;
  @State accountUsageError: string = '';
  @State desktopMonitorVisible: boolean = false;
  @State desktopMonitorSnapshot: StandbyMonitorSnapshot =
    StandbyMonitorSnapshotService.defaultSnapshot();
  @State desktopMonitorCharging: boolean = false;
  @State desktopMonitorKeepScreenOn: boolean = false;
  @State desktopMonitorBatteryPercent: number = 0;
  @State outboxPanelVisible: boolean = false;
  @State isLoadingOutbox: boolean = false;
  @State outboxItems: BridgeOutboxItem[] = [];
  @State outboxDrafts: Record<string, string> = {};
  @State isUploadingImage: boolean = false;
  @State isCapturingDesktopScreenshot: boolean = false;
  @State isAttachingDesktopScreenshot: boolean = false;
  @State isSendingSessionMessage: boolean = false;
  @State sendingSessionTargetId: string = '';
  @State isInterruptingTask: boolean = false;
  @State interruptingSessionTargetId: string = '';
  @State composerActionMenuExpanded: boolean = false;
  @State pendingSessionImages: PendingSessionImage[] = [];
  @State pendingSessionFiles: PickedMobileFile[] = [];
  @State isPickingFile: boolean = false;
  @State failedSessionMessages: FailedSessionMessage[] = [];
  @State optimisticSessionMessages: OptimisticSessionMessage[] = [];
  @State sessionComposerFocused: boolean = false;
  @State desktopScreenshotMetaText: string = '';
  @State sessionAutoFollowBottom: boolean = true;
  @State isLoadingOlderSessionEntries: boolean = false;
  @State sessionStatusExpanded: boolean = false;
  @State slashCommandPanelVisible: boolean = false;
  @State slashIndexItems: SlashIndexItem[] = [];
  @State slashIndexLoadedAt: string = '';
  @State isPullRefreshingSessions: boolean = false;
  @State deletingSessionId: string = '';
  @State swipedSessionId: string = '';
  @State swipedSessionOffsetX: number = 0;
  @State userInputAnswers: Record<string, string> = {};
  @State remoteFileActionBusy: boolean = false;
  @State markdownReaderDocument: MarkdownReaderDocument | null = null;

  private sessionScroller: Scroller = new Scroller();
  private sessionScrollGeneration: number = 0;
  private historyScrollAnchorKey: string = '';
  private pollTimer: number = -1;
  private dashboardTimer: number = -1;
  private desktopMonitorTimer: number = -1;
  private logFlushTimer: number = -1;
  private relayWatchdogTimer: number = -1;
  private pendingLogs: AppLogPayload[] = [];
  private isFlushingLogs: boolean = false;
  private isRefreshingDashboard: boolean = false;
  private appForeground: boolean = true;
  private taskPollStartedAt: number = 0;
  private taskPollLastStatus: string = '';
  private taskPollLastEventCount: number = -1;
  private taskPollDelayMs: number = 2000;
  private lastProjectsRefreshAt: number = 0;
  private lastTasksRefreshAt: number = 0;
  private lastSessionsRefreshAt: number = 0;
  private lastSystemLinkRefreshAt: number = 0;
  private lastRuntimeContractRefreshAt: number = 0;
  private lastSelectedSessionDetailRefreshAt: number = 0;
  private lastHomeActionToggleAt: number = 0;
  private lastHomeActionToggleSource: string = '';
  private lastHomeActionMenuActionAt: number = 0;
  private lastHomeActionMenuActionKey: string = '';
  private homeActionMenuOpenedAt: number = 0;
  private accountUsagePanelOpenedAt: number = 0;
  private lastDesktopMonitorUsageRefreshAt: number = 0;
  private lastComposerActionToggleAt: number = 0;
  private sessionDetailRequestSeq: number = 0;
  private sampledLogSignatureByEvent: Record<string, string> = {};
  private sampledLogAtByEvent: Record<string, number> = {};
  private dashboardFailureCount: number = 0;
  private sessionTextAreaController: TextAreaController = new TextAreaController();
  private desktopScreenshotGestureStartScale: number = 1;
  private desktopScreenshotGestureStartOffsetX: number = 0;
  private desktopScreenshotGestureStartOffsetY: number = 0;
  private sessionSidebarResizeStartWidth: number = 304;
  private adaptiveImagePreviewLandscape: boolean = false;
  private lastDesktopSyncWarningTaskId: string = '';
  private relayAutoStarted: boolean = false;
  private relayRunning: boolean = false;
  private relayBackgroundRunning: boolean = false;
  private relayStateChangedAt: number = Date.now();
  private relayLastRestartAt: number = 0;
  private taskStatusById: Record<string, string> = {};
  private taskSessionById: Record<string, string> = {};
  private latestTaskIdBySessionId: Record<string, string> = {};
  private pendingSessionSendsByTaskId: Record<string, PendingSessionSend> = {};
  private failedSessionRetryTimersById: Record<string, number> = {};
  private canceledFailedSessionRetryIds: string[] = [];
  private failedSessionAutoRetryLimit: number = 5;
  private failedSessionAutoRetryDelayMs: number = 1800;
  private sessionActivityStatusById: Record<string, string> = {};
  private sessionUpdatedAtById: Record<string, string> = {};
  private clearedRunningSessionUpdatedAtById: Record<string, string> = {};
  private sessionRuntimeStore: SessionRuntimeStore = new SessionRuntimeStore();
  private latestRuntimeSnapshot: CodexRuntimeSnapshot | null = null;
  private reasoningEffortLoadedSessionId: string = '';
  private reasoningEffortLoadedAt: number = 0;
  private desktopModelDefaultsLoadedAt: number = 0;
  private modelSettingsCacheTtlMs: number = 10000;
  private notifiedTaskIds: string[] = [];
  private notifiedSessionCompletionKeys: string[] = [];
  private notifiedAttentionKeys: string[] = [];
  private lastHandledNotificationRevision: string = '';
  private lastConnectionNotificationAt: number = 0;
  private relayTunnel: HdcRelayTunnel = new HdcRelayTunnel((state: HdcRelayState, detail: string) => {
    if (this.relayStateText !== state || this.relayDetailText !== detail) {
      this.relayStateChangedAt = Date.now();
    }
    this.relayStateText = state;
    this.relayDetailText = detail;
    this.relayRunning = !(state === '已停止' || state === '错误');
    this.log('info', 'hdc_relay.state', `state=${state}; detail=${detail}; relayToHdcdBytes=${this.relayToHdcdBytes}; hdcdToRelayBytes=${this.hdcdToRelayBytes}`);
  }, (relayToHdcdBytes: number, hdcdToRelayBytes: number) => {
    this.relayToHdcdBytes = relayToHdcdBytes;
    this.hdcdToRelayBytes = hdcdToRelayBytes;
  });

  aboutToAppear(): void {
    this.themeMode = normalizeThemeMode(this.themeMode);
    this.fontScaleMode = normalizeFontScaleMode(this.fontScaleMode);
    this.applyThemeMode();
    this.appForeground = true;
    this.applyKeyboardAvoidMode();
    this.startLogFlusher();
    this.startDashboardRefresh();
    void this.refreshSlashIndex();
    void this.loadDesktopReasoningDefaults(true);
    void this.startRelayBackgroundRunning();
    void this.requestNotificationPermission();
    void this.applyPendingNotificationNavigation();
    if (this.desktopMonitorVisible) {
      this.startDesktopMonitorRefresh();
      void this.syncDesktopMonitorDisplay('foreground');
    }
    if (DEFAULT_EMBEDDED_RELAY_ENABLED) {
      this.startRelayWatchdog();
      this.startEmbeddedRelayOnce();
    }
    this.log('info', 'app.appear', `bridgeUrl=${this.bridgeUrl}; sessionId=${this.logSessionId}`);
  }

  aboutToDisappear(): void {
    this.appForeground = false;
    this.stopDesktopMonitorRefresh();
    void this.suspendDesktopMonitorDisplay('background');
    this.log('info', 'app.disappear', `taskId=${this.currentTask?.id ?? ''}; status=${this.currentTask?.status ?? 'idle'}`);
    void this.flushLogQueue();
    this.log('info', 'app.background.monitoring.keep_alive', `dashboardTimer=${this.dashboardTimer}; pollTimer=${this.pollTimer}; logFlushTimer=${this.logFlushTimer}`);
  }

  onBackPress(): boolean {
    if (this.hasOpenImagePreview()) {
      this.closeOpenImagePreview('system_back');
      return true;
    }
    if (this.markdownReaderDocument !== null) {
      this.closeMarkdownReader('system_back');
      return true;
    }
    if (this.outboxPanelVisible) {
      this.outboxPanelVisible = false;
      return true;
    }
    if (this.desktopMonitorVisible) {
      this.closeDesktopMonitor('system_back');
      return true;
    }
    if (this.activeTab === 'sessions' && !this.sessionSidebarCollapsed) {
      this.closeSessionSidebar('system_back');
      return true;
    }
    if (this.activeTab === 'sessions' && this.isNewSessionDraft) {
      this.returnToSessionHome('system_back_new_session');
      return true;
    }
    if (this.activeTab === 'sessions' && this.selectedSession !== null) {
      this.returnToSessionHome('system_back_conversation');
      return true;
    }
    return false;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (this.activeTab === 'sessions') {
        this.SessionWorkspace()
      } else {
        Scroll() {
          Column({ space: 12 }) {
            this.Header()
            this.SummaryStrip()
            this.TabBar()
            if (this.activeTab === 'overview') {
            this.ConnectionPanel()
            this.DashboardPanel()
            } else {
              this.TaskPanel()
              this.StatusPanel()
              this.EventPanel()
            }
          }
          .width('100%')
          .padding({ left: this.contentLeftPadding(), right: 14, top: 16, bottom: 24 })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Auto)
        .edgeEffect(EdgeEffect.Spring)
      }

      if (this.previewImageUrl.length > 0) {
        this.ImagePreviewOverlay()
      }

      if (this.desktopScreenshotPreviewUrl.length > 0) {
        this.DesktopScreenshotPreviewOverlay()
      }

      if (this.accountUsagePanelVisible) {
        this.AccountUsagePanel()
      }

      if (this.outboxPanelVisible) {
        this.OutboxPanel()
      }

      if (this.markdownReaderDocument !== null) {
        this.MarkdownReaderOverlay()
      }

      if (this.desktopMonitorVisible) {
        this.DesktopMonitorOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeColor('#F7F8FA'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.BOTTOM])
  }

  @Builder
  DesktopMonitorOverlay() {
    DesktopMonitorPanel({
      snapshot: this.desktopMonitorSnapshot,
      landscape: this.isLandscapeSessionLayout(),
      charging: this.desktopMonitorCharging,
      keepScreenOn: this.desktopMonitorKeepScreenOn,
      batteryPercent: this.desktopMonitorBatteryPercent,
      onClose: () => {
        this.closeDesktopMonitor('header_close');
      },
      onRefresh: () => {
        this.refreshDesktopMonitor('manual');
      }
    })
      .width('100%')
      .height('100%')
      .zIndex(120)
  }

  @Builder
  MarkdownReaderOverlay() {
    if (this.markdownReaderDocument !== null) {
      MarkdownReader({
        document: this.markdownReaderDocument,
        darkMode: this.usesDarkTheme(),
        fontScaleMode: this.fontScaleMode,
        landscape: this.isLandscapeSessionLayout(),
        onClose: () => {
          this.closeMarkdownReader('header_back');
        },
        onCopy: () => {
          void this.copyMarkdownReaderText();
        },
        onShare: () => {
          void this.shareMarkdownReaderFile();
        },
        onOpenExternal: () => {
          void this.openMarkdownReaderInOtherApp();
        },
        onLinkClick: (href: string) => {
          this.handleMarkdownReaderLink(href);
        },
        onFontScaleChange: (mode: string) => {
          this.changeFontScaleMode(mode);
        }
      })
    }
  }

  @Builder
  Header() {
    Row() {
      Column({ space: 4 }) {
        Text('Codex 远程控制')
          .fontSize(this.scaledFontSize(22))
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeColor('#17202A'))
        Text(this.headerMessageText())
          .fontSize(this.scaledFontSize(13))
          .fontColor(this.themeColor('#68717D'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)

      Blank()

      Text(this.statusLabel(this.currentTask?.status ?? 'idle'))
        .fontSize(this.scaledFontSize(12))
        .fontColor(this.theme().textOnAccent)
        .padding({ left: 10, right: 10, top: 5, bottom: 5 })
        .backgroundColor(this.statusColor(this.currentTask?.status ?? 'idle'))
        .borderRadius(6)
    }
    .width('100%')
  }

  @Builder
  SummaryStrip() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        this.SummaryMetric('项目', `${this.projects.length}`)
        this.SummaryMetric('任务', `${this.tasks.length}`)
        this.SummaryMetric('会话', `${this.sessions.length}`)
      }
      Text(this.relaySummaryText())
        .fontSize(this.scaledFontSize(12))
        .fontColor(this.relaySummaryColor())
        .width('100%')
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(this.currentTaskSummaryText())
        .fontSize(this.scaledFontSize(12))
        .fontColor(this.themeColor('#68717D'))
        .width('100%')
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding(12)
    .backgroundColor(this.themeColor('#FFFFFF'))
    .borderRadius(8)
  }

  @Builder
  SummaryMetric(label: string, value: string) {
    Column({ space: 3 }) {
      Text(value)
        .fontSize(this.scaledFontSize(18))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.themeColor('#17202A'))
      Text(label)
        .fontSize(this.scaledFontSize(11))
        .fontColor(this.themeColor('#68717D'))
    }
    .layoutWeight(1)
    .height(54)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.themeColor('#F7F8FA'))
    .borderRadius(6)
  }

  @Builder
  TabBar() {
    Row({ space: 8 }) {
      this.TabButton('overview', '总览')
      this.TabButton('sessions', '会话')
      this.TabButton('tasks', '任务')
    }
    .width('100%')
  }

  @Builder
  TabButton(tab: string, label: string) {
    Button(label)
      .height(38)
      .layoutWeight(1)
      .fontSize(this.scaledFontSize(13))
      .fontColor(this.activeTab === tab ? this.theme().textOnAccent : this.themeColor('#17202A'))
      .backgroundColor(this.activeTab === tab ? this.themeColor('#1F6FEB') : this.themeColor('#FFFFFF'))
      .onClick(() => {
        this.activeTab = tab;
        this.log('info', 'ui.tab.changed', `tab=${tab}`);
      })
  }

  @Builder
  ConnectionPanel() {
    Column({ space: 10 }) {
      Text('桥接地址')
        .fontSize(this.scaledFontSize(15))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.themeColor('#17202A'))

      TextInput({ text: this.bridgeUrl, placeholder: 'http://电脑地址:8787' })
        .height(44)
        .fontSize(this.scaledFontSize(14))
        .backgroundColor(this.themeColor('#FFFFFF'))
        .borderRadius(6)
        .onChange((value: string) => {
          this.bridgeUrl = value.trim();
          this.log('info', 'bridge.url.changed', `bridgeUrl=${this.bridgeUrl}`);
        })

      TextInput({ text: this.bridgeToken, placeholder: '公网访问令牌（本地 USB 可留空）' })
        .height(44)
        .fontSize(this.scaledFontSize(14))
        .backgroundColor(this.themeColor('#FFFFFF'))
        .borderRadius(6)
        .type(InputType.Password)
        .onChange((value: string) => {
          this.bridgeToken = value.trim();
          this.log('info', 'bridge.token.changed', `hasToken=${this.bridgeToken.length > 0}`);
        })

      Row({ space: 10 }) {
        Button('加载项目')
          .height(40)
          .layoutWeight(1)
          .enabled(!this.isBusy)
          .onClick(() => {
            this.log('info', 'ui.click.load_projects', '');
            void this.loadProjects();
          })

        Button('刷新任务')
          .height(40)
          .layoutWeight(1)
          .enabled(!this.isBusy)
          .onClick(() => {
            this.log('info', 'ui.click.refresh_task', `taskId=${this.currentTask?.id ?? ''}`);
            void this.refreshDashboard(true);
          })
      }
    }
    .cardStyle(this.theme().surface)
  }

  @Builder
  DashboardPanel() {
    Column({ space: 10 }) {
      Row() {
        Text('项目实时状态')
          .fontSize(this.scaledFontSize(15))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#17202A'))
        Blank()
        Text(`${this.projects.length} 项目 / ${this.tasks.length} 任务 / ${this.sessions.length} 会话`)
          .fontSize(this.scaledFontSize(12))
          .fontColor(this.themeColor('#68717D'))
      }

      if (this.projects.length === 0) {
        Text('暂无项目，点击“加载项目”或等待自动刷新')
          .fontSize(this.scaledFontSize(13))
          .fontColor(this.themeColor('#68717D'))
      } else {
        ForEach(this.projects, (project: BridgeProject) => {
          Column({ space: 4 }) {
            Row() {
              Text(project.name)
                .fontSize(this.scaledFontSize(14))
                .fontWeight(FontWeight.Medium)
                .fontColor(this.themeColor('#17202A'))
              Blank()
              Text(project.id)
                .fontSize(this.scaledFontSize(12))
                .fontColor(this.themeColor('#68717D'))
            }
            Text(project.root)
              .fontSize(this.scaledFontSize(11))
              .fontColor(this.themeColor('#68717D'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .padding(10)
          .backgroundColor(project.id === this.selectedProjectId ? this.themeColor('#EAF2FF') : this.themeColor('#F7F8FA'))
          .borderRadius(6)
          .onClick(() => {
            this.selectedProjectId = project.id;
          })
        }, (project: BridgeProject) => project.id)
      }

      if (this.tasks.length > 0) {
        Text('最近任务')
          .fontSize(this.scaledFontSize(13))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#17202A'))
        ForEach(this.tasks.slice(0, 5), (task: BridgeTaskSummary) => {
          Column({ space: 4 }) {
            Row() {
              Text(this.statusLabel(task.status))
                .fontSize(this.scaledFontSize(12))
                .fontColor(this.theme().textOnAccent)
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor(this.statusColor(task.status))
                .borderRadius(5)
              Blank()
              Text(task.projectId)
                .fontSize(this.scaledFontSize(12))
                .fontColor(this.themeColor('#68717D'))
            }
            Text(task.prompt)
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#17202A'))
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(`事件 ${task.eventCount} · ${task.updatedAt}`)
              .fontSize(this.scaledFontSize(11))
              .fontColor(this.themeColor('#68717D'))
          }
          .width('100%')
          .padding(10)
          .backgroundColor(this.themeColor('#F7F8FA'))
          .borderRadius(6)
        }, (task: BridgeTaskSummary) => task.id)
      }
    }
    .cardStyle(this.theme().surface)
  }

  @Builder
  SessionWorkspace() {
    if (this.isLandscapeSessionLayout()) {
      Row() {
        if (!this.sessionSidebarUserCollapsed) {
          Column() {
            this.SessionSidebar()
          }
          .width(this.sessionLandscapeSidebarWidth())
          .height('100%')

          this.SessionSidebarResizeHandle()
        }

        Column() {
          this.SessionPanel()
        }
        .layoutWeight(1)
        .height('100%')
      }
      .width('100%')
      .height('100%')
      .alignItems(VerticalAlign.Top)
    } else {
      Stack({ alignContent: Alignment.TopStart }) {
        this.SessionPanel()

        if (!this.sessionSidebarCollapsed) {
          this.SessionSidebar()
        }
      }
      .width('100%')
      .height('100%')
    }
  }

  @Builder
  SessionPanel() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column({ space: 8 }) {
        if (this.selectedSession !== null || this.isNewSessionDraft) {
          Row({ space: 8 }) {
            if (this.shouldShowSessionHeaderSidebarToggle()) {
              this.SessionSidebarHeaderToggleButton()
            }

            Column({ space: 3 }) {
              Text(this.sessionPageTitle())
                .fontSize(this.scaledFontSize(16))
                .fontWeight(FontWeight.Bold)
                .fontColor(this.themeColor('#17202A'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.sessionPageSubtitle())
                .fontSize(this.scaledFontSize(10))
                .fontColor(this.themeColor('#68717D'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            this.ReasoningEffortHeaderButton()

            this.DesktopTakeoverButton()
          }
          .width('100%')
          .height(40)
        } else {
          Row({ space: 8 }) {
            if (this.shouldShowSessionHeaderSidebarToggle()) {
              this.SessionSidebarHeaderToggleButton()
            }

            Column({ space: 3 }) {
              Text('Codex 远程')
                .fontSize(this.scaledFontSize(16))
                .fontWeight(FontWeight.Bold)
                .fontColor(this.themeColor('#17202A'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.sessionMonitorSummaryText())
                .fontSize(this.scaledFontSize(10))
                .fontColor(this.themeColor('#68717D'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            if (this.sessionSidebarCollapsed) {
              this.HomeActionButton('home_header')
            }
          }
          .width('100%')
          .height(40)
        }

        Column() {
          this.SessionConversationPanel()
        }
          .layoutWeight(1)
          .width('100%')
      }
      .width('100%')
      .height('100%')

      if (this.shouldShowReasoningEffortMenu()) {
        this.ReasoningEffortMenu()
      }

      if (this.shouldShowHomeActionMenuInSessionPanel()) {
        this.HomeActionMenu('home_header')
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 0 })
    .backgroundColor(this.themeColor('#F7F8FA'))
  }

  @Builder
  SessionSidebarHeaderToggleButton() {
    Button() {
      if (this.isLandscapeSessionLayout() && !this.sessionSidebarUserCollapsed) {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(18)
          .fontColor([this.themeColor('#68717D')])
      } else {
        SymbolGlyph($r('sys.symbol.open_sidebar'))
          .fontSize(18)
          .fontColor([this.themeColor('#68717D')])
      }
    }
    .width(34)
    .height(34)
    .backgroundColor(this.themeColor('#F0F2F5'))
    .borderRadius(17)
    .onClick(() => {
      this.toggleSessionSidebarFromHeader();
    })
  }

  @Builder
  DesktopTakeoverButton() {
    Button() {
      Row({ space: 4 }) {
        if (this.isOpeningDesktopSession) {
          LoadingProgress()
            .width(12)
            .height(12)
            .color(this.themeColor('#1F6FEB'))
        }
        Text('桌面')
          .fontSize(this.scaledFontSize(10))
          .fontColor(this.themeColor('#1F6FEB'))
          .maxLines(1)
      }
      .justifyContent(FlexAlign.Center)
    }
      .width(58)
      .height(30)
      .backgroundColor(this.themeColor('#EAF2FF'))
      .border({ width: 1, color: this.themeColor('#BBD2FF') })
      .borderRadius(15)
      .enabled(this.selectedSession !== null && !this.isOpeningDesktopSession)
      .onClick(() => {
        void this.openDesktopSelectedSession('conversation_header');
      })
  }

  @Builder
  SessionSidebarResizeHandle() {
    Stack({ alignContent: Alignment.Center }) {
      Row()
        .width(2)
        .height(52)
        .backgroundColor(this.themeColor('#DDE3EA'))
        .borderRadius(1)
    }
    .width(12)
    .height('100%')
    .backgroundColor(this.themeColor('#F7F8FA'))
    .gesture(
      PanGesture({ direction: PanDirection.Horizontal })
        .onActionStart(() => {
          this.sessionSidebarResizeStartWidth = this.sessionLandscapeSidebarWidth();
          this.homeActionMenuVisible = false;
          this.homeActionMenuSource = '';
        })
        .onActionUpdate((event: GestureEvent) => {
          this.resizeSessionLandscapeSidebar(event.offsetX);
        })
        .onActionEnd(() => {
          this.log('info', 'ui.session_sidebar.resized', `width=${this.sessionSidebarWidth}`);
        })
    )
  }

  @Builder
  ReasoningEffortHeaderButton() {
    Button() {
      Row({ space: 6 }) {
        if (this.isSavingReasoningEffort) {
          LoadingProgress()
            .width(12)
            .height(12)
            .color(this.themeColor('#1F6FEB'))
        } else {
          Text(this.modelHeaderLabel())
            .fontSize(this.scaledFontSize(11))
            .fontWeight(FontWeight.Bold)
            .fontColor(this.themeColor('#17202A'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        Text(`· ${this.reasoningEffortShortLabel(this.sessionReasoningEffort)}`)
          .fontSize(this.scaledFontSize(10))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#1F6FEB'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
    }
      .width(132)
      .height(30)
      .backgroundColor(this.reasoningEffortMenuVisible ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
      .border({ width: 1, color: this.reasoningEffortMenuVisible ? this.themeColor('#BBD2FF') : this.themeColor('#DDE3EA') })
      .borderRadius(15)
      .enabled(this.canChangeReasoningEffort())
      .onClick(() => {
        this.reasoningEffortMenuVisible = !this.reasoningEffortMenuVisible;
        this.composerActionMenuExpanded = false;
        this.slashCommandPanelVisible = false;
        this.log('info', 'ui.model_settings.toggle', `visible=${this.reasoningEffortMenuVisible}; sessionId=${this.reasoningEffortSessionId()}; model=${this.sessionModel || 'auto'}; effort=${this.sessionReasoningEffort || 'auto'}`);
      })
  }

  @Builder
  ReasoningEffortMenu() {
    Scroll() {
    Column({ space: 8 }) {
      Text('模型')
        .fontSize(this.scaledFontSize(11))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.themeColor('#68717D'))
        .width('100%')
      ForEach(this.modelOptionValues(), (option: CodexModelOption) => {
        Button() {
          Row({ space: 8 }) {
            Text(this.sessionModel === this.normalizeModel(option.id) ? '✓' : '')
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#1F6FEB'))
              .width(12)
            Column({ space: 1 }) {
              Text(this.modelLabel(option))
                .fontSize(this.scaledFontSize(12))
                .fontWeight(FontWeight.Medium)
                .fontColor(this.themeColor('#17202A'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.modelDescription(option))
                .fontSize(this.scaledFontSize(9))
                .fontColor(this.themeColor('#68717D'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .alignItems(VerticalAlign.Center)
        }
          .width(210)
          .height(40)
          .padding({ left: 8, right: 8 })
          .backgroundColor(this.sessionModel === this.normalizeModel(option.id) ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
          .border({ width: this.sessionModel === this.normalizeModel(option.id) ? 1 : 0, color: this.sessionModel === this.normalizeModel(option.id) ? this.themeColor('#BBD2FF') : this.themeColor('#FFFFFF') })
          .borderRadius(9)
          .enabled(!this.isSavingReasoningEffort)
          .onClick(() => {
            void this.changeSessionModel(option.id);
          })
      }, (option: CodexModelOption) => option.id.length > 0 ? option.id : 'auto-model')

      Row()
        .width('100%')
        .height(1)
        .backgroundColor(this.themeColor('#E6EAF0'))

      Text('思考强度')
        .fontSize(this.scaledFontSize(11))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.themeColor('#68717D'))
        .width('100%')
      ForEach(this.reasoningEffortValues(), (effort: string) => {
        Button() {
          Row({ space: 8 }) {
            Text(this.sessionReasoningEffort === effort ? '✓' : '')
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#1F6FEB'))
              .width(12)
            Column({ space: 1 }) {
              Text(this.reasoningEffortLabel(effort))
                .fontSize(this.scaledFontSize(12))
                .fontWeight(FontWeight.Medium)
                .fontColor(this.themeColor('#17202A'))
              Text(this.reasoningEffortDescription(effort))
                .fontSize(this.scaledFontSize(9))
                .fontColor(this.themeColor('#68717D'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .alignItems(VerticalAlign.Center)
        }
          .width(210)
          .height(38)
          .padding({ left: 8, right: 8 })
          .backgroundColor(this.sessionReasoningEffort === effort ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
          .border({ width: this.sessionReasoningEffort === effort ? 1 : 0, color: this.sessionReasoningEffort === effort ? this.themeColor('#BBD2FF') : this.themeColor('#FFFFFF') })
          .borderRadius(9)
          .enabled(!this.isSavingReasoningEffort)
          .onClick(() => {
            void this.changeReasoningEffort(effort);
          })
      }, (effort: string) => effort.length > 0 ? effort : 'auto')
    }
    .width('100%')
    .padding(8)
    }
    .width(226)
    .constraintSize({ maxHeight: Math.max(120, this.sessionWindowHeightVp() - 120) })
    .scrollBar(BarState.Auto)
    .backgroundColor(this.themeColor('#FFFFFF'))
    .border({ width: 1, color: this.themeColor('#DDE3EA') })
    .borderRadius(14)
    .shadow({ radius: 14, color: this.themeColor('#1F232824'), offsetX: 0, offsetY: 5 })
    .margin({ top: 42, right: 0 })
    .zIndex(9)
  }

  private modelHeaderLabel(): string {
    if (this.normalizeModel(this.sessionModel).length === 0) { return '自动'; }
    return this.modelShortLabel(this.sessionModel).replace(/^GPT-[0-9.]+-/i, '').replace(/^GPT-/i, '');
  }

  @Builder
  HomeActionButton(source: string) {
    Button() {
      if (this.desktopLiveRestarting || this.isLoadingAccountUsage || this.isPullRefreshingSessions) {
        LoadingProgress()
          .width(17)
          .height(17)
          .color(this.themeColor('#1F6FEB'))
      } else {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(20)
          .fontColor([this.homeActionMenuVisible ? this.themeColor('#1F6FEB') : this.themeColor('#17202A')])
      }
    }
      .width(36)
      .height(36)
      .backgroundColor(this.homeActionMenuVisible ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
      .border({ width: 1, color: this.homeActionMenuVisible ? this.themeColor('#BBD2FF') : this.themeColor('#DDE3EA') })
      .borderRadius(18)
      .enabled(!this.isBusy)
      .onClick(() => {
        this.toggleHomeActionMenu(source);
      })
  }

  @Builder
  HomeActionMenu(source: string) {
    Column({ space: 6 }) {
      this.HomeActionMenuItem('theme', '主题', `当前：${themeModeLabel(this.themeMode)}`, this.theme().accent, source)
      if (this.themeModeChooserVisible) {
        this.ThemeModeSelector()
      }
      this.HomeActionMenuItem(
        'font_size',
        '字体大小',
        `当前：${fontScaleLabel(this.fontScaleMode)} · ${fontScalePercent(this.fontScaleMode)}%`,
        this.theme().accent,
        source
      )
      if (this.fontScaleChooserVisible) {
        this.FontScaleSelector()
      }
      this.HomeActionMenuItem('desktop_monitor', '桌面监控', '常亮显示任务、未读与额度', '#5FC7FF', source)
      this.HomeActionMenuItem('usage', '账号用量', '读取 Codex 桌面当前可见套餐信息', this.themeColor('#1F6FEB'), source)
      this.HomeActionMenuItem('outbox', '发送队列', '查看、编辑、排序或取消待发送消息', this.themeColor('#7C3AED'), source)
      this.HomeActionMenuItem('new_session', '新建会话', '创建一个真实 Codex 新线程', this.themeColor('#14853D'), source)
      this.HomeActionMenuItem('refresh', '刷新会话', '重新读取会话列表和状态', this.themeColor('#68717D'), source)
      this.HomeActionMenuItem('soft_repair', '恢复链路', '检测 bridge、CDP 与无线 HDC', this.themeColor('#B68A00'), source)
      this.HomeActionMenuItem('hard_restart', '重启 Codex', '需要确认，会重启桌面 Codex', this.themeColor('#B42318'), source)
    }
    .width(248)
    .padding(8)
    .backgroundColor(this.themeColor('#FFFFFF'))
    .border({ width: 1, color: this.themeColor('#DDE3EA') })
    .borderRadius(14)
    .shadow({ radius: 16, color: this.themeColor('#1F232824'), offsetX: 0, offsetY: 6 })
    .margin({ top: source === 'sidebar_header' ? 60 : 42, right: source === 'sidebar_header' ? 14 : 0 })
    .zIndex(60)
  }

  @Builder
  ThemeModeSelector() {
    Column({ space: 6 }) {
      Text('选择外观')
        .fontSize(this.scaledFontSize(10))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.theme().textSecondary)
        .width('100%')
      Row({ space: 6 }) {
        this.ThemeModeButton('dark', '夜晚')
        this.ThemeModeButton('light', '浅色')
        this.ThemeModeButton('system', '跟随系统')
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 2, bottom: 4 })
  }

  @Builder
  ThemeModeButton(mode: string, label: string) {
    Button(label)
      .layoutWeight(1)
      .height(30)
      .fontSize(this.scaledFontSize(10))
      .fontColor(this.themeMode === mode ? this.theme().textOnAccent : this.theme().textSecondary)
      .backgroundColor(this.themeMode === mode ? this.theme().accent : this.theme().surfaceMuted)
      .border({ width: 1, color: this.themeMode === mode ? this.theme().accent : this.theme().border })
      .borderRadius(8)
      .onClick(() => {
        this.changeThemeMode(mode);
      })
  }

  @Builder
  FontScaleSelector() {
    Column({ space: 6 }) {
      Text('整体字体大小')
        .fontSize(this.scaledFontSize(10))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.theme().textSecondary)
        .width('100%')
      Row({ space: 6 }) {
        this.FontScaleButton('small', '小')
        this.FontScaleButton('standard', '标准')
        this.FontScaleButton('large', '大')
        this.FontScaleButton('extra_large', '特大')
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 2, bottom: 4 })
  }

  @Builder
  FontScaleButton(mode: string, label: string) {
    Button(label)
      .layoutWeight(1)
      .height(30)
      .fontSize(this.scaledFontSize(10))
      .fontColor(this.fontScaleMode === mode ? this.theme().textOnAccent : this.theme().textSecondary)
      .backgroundColor(this.fontScaleMode === mode ? this.theme().accent : this.theme().surfaceMuted)
      .border({ width: 1, color: this.fontScaleMode === mode ? this.theme().accent : this.theme().border })
      .borderRadius(8)
      .onClick(() => {
        this.changeFontScaleMode(mode);
      })
  }

  @Builder
  HomeActionMenuItem(action: string, title: string, description: string, color: string, source: string) {
    Button() {
      Row({ space: 8 }) {
        this.HomeActionIcon(action, color)
        Column({ space: 1 }) {
          Text(title)
            .fontSize(this.scaledFontSize(12))
            .fontWeight(FontWeight.Medium)
            .fontColor(this.themeColor('#17202A'))
          Text(description)
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#68717D'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .alignItems(VerticalAlign.Center)
    }
      .width('100%')
      .height(42)
      .padding({ left: 8, right: 8 })
      .backgroundColor(this.themeColor('#FFFFFF'))
      .borderRadius(9)
      .enabled(this.canRunHomeAction(action))
      .onClick(() => {
        this.handleHomeAction(action, source);
      })
  }

  @Builder
  HomeActionIcon(action: string, color: string) {
    Stack({ alignContent: Alignment.Center }) {
      if (action === 'theme') {
        Text('◐')
          .fontSize(this.scaledFontSize(14))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else if (action === 'font_size') {
        Text('Aa')
          .fontSize(this.scaledFontSize(10))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else if (action === 'desktop_monitor') {
        Text('☾')
          .fontSize(this.scaledFontSize(14))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else if (action === 'usage') {
        Text('¥')
          .fontSize(this.scaledFontSize(13))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else if (action === 'outbox') {
        Text('列')
          .fontSize(this.scaledFontSize(11))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else if (action === 'new_session') {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(16)
          .fontColor([color])
      } else if (action === 'refresh') {
        Text('↻')
          .fontSize(this.scaledFontSize(15))
          .fontColor(color)
      } else if (action === 'soft_repair') {
        Text('链')
          .fontSize(this.scaledFontSize(12))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      } else {
        Text('重')
          .fontSize(this.scaledFontSize(12))
          .fontWeight(FontWeight.Bold)
          .fontColor(color)
      }
    }
    .width(26)
    .height(26)
    .backgroundColor(this.themeColor('#F7F8FA'))
    .borderRadius(13)
  }

  @Builder
  AccountUsagePanel() {
    Stack({ alignContent: Alignment.Bottom }) {
      Row()
        .width('100%')
        .height('100%')
        .backgroundColor(this.themeColor('#00000020'))
        .onClick(() => {
          this.closeAccountUsagePanel('backdrop');
        })

      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Text('Codex 账号用量')
              .fontSize(this.scaledFontSize(16))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#17202A'))
            Text(this.accountUsageSubtitle())
              .fontSize(this.scaledFontSize(10))
              .fontColor(this.themeColor('#68717D'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Button() {
            if (this.isLoadingAccountUsage) {
              LoadingProgress()
                .width(16)
                .height(16)
                .color(this.themeColor('#1F6FEB'))
            } else {
              Text('↻')
                .fontSize(this.scaledFontSize(16))
                .fontColor(this.themeColor('#1F6FEB'))
            }
          }
            .width(34)
            .height(34)
            .backgroundColor(this.themeColor('#EAF2FF'))
            .borderRadius(17)
            .enabled(!this.isLoadingAccountUsage)
            .onClick(() => {
              void this.loadCodexAccountUsage('panel_refresh');
            })

          Button() {
            Text('×')
              .fontSize(this.scaledFontSize(20))
              .fontColor(this.themeColor('#68717D'))
          }
            .width(34)
            .height(34)
            .backgroundColor(this.themeColor('#F0F2F5'))
            .borderRadius(17)
            .onClick(() => {
              this.closeAccountUsagePanel('close_button');
            })
        }
        .width('100%')

        if (this.accountUsageError.length > 0) {
          Text(this.accountUsageError)
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#B42318'))
            .width('100%')
            .padding(10)
            .backgroundColor(this.themeColor('#FFF2F0'))
            .border({ width: 1, color: this.themeColor('#F2C7C3') })
            .borderRadius(8)
        }

        if (this.accountUsage !== null && this.accountUsage.items.length > 0) {
          Column({ space: 6 }) {
            ForEach(this.accountUsage.items, (item: CodexAccountUsageItem) => {
              this.AccountUsageItemView(item)
            }, (item: CodexAccountUsageItem) => `${item.kind}-${item.value}`)
          }
          .width('100%')
        } else if (!this.isLoadingAccountUsage && this.accountUsageError.length === 0) {
          Text('点击刷新读取 Codex 桌面当前可见的套餐和用量信息。')
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#68717D'))
            .width('100%')
            .padding(10)
            .backgroundColor(this.themeColor('#F7F8FA'))
            .borderRadius(8)
        }
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 22 })
      .backgroundColor(this.themeColor('#FFFFFF'))
      .borderRadius({ topLeft: 18, topRight: 18 })
      .shadow({ radius: 18, color: this.themeColor('#1F232824'), offsetX: 0, offsetY: -4 })
    }
    .width('100%')
    .height('100%')
    .zIndex(80)
  }

  @Builder
  AccountUsageItemView(item: CodexAccountUsageItem) {
    Row({ space: 8 }) {
      Text(item.label)
        .fontSize(this.scaledFontSize(11))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.themeColor('#1F6FEB'))
        .width(58)
      Text(item.value)
        .fontSize(this.scaledFontSize(12))
        .fontColor(this.themeColor('#17202A'))
        .layoutWeight(1)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor(this.themeColor('#F7F8FA'))
    .borderRadius(8)
  }

  @Builder
  DesktopScreenshotButtonIcon() {
    Stack({ alignContent: Alignment.Center }) {
      Row()
        .width(18)
        .height(13)
        .border({ width: 2, color: this.themeColor('#17202A') })
        .borderRadius(3)

      Row()
        .width(8)
        .height(2)
        .backgroundColor(this.themeColor('#17202A'))
        .translate({ x: 0, y: 8 })

      Row()
        .width(4)
        .height(4)
        .backgroundColor(this.themeColor('#1F6FEB'))
        .borderRadius(2)
        .translate({ x: 7, y: -4 })
    }
    .width(22)
    .height(22)
  }

  @Builder
  DesktopScreenshotAttachButtonIcon() {
    Stack({ alignContent: Alignment.Center }) {
      this.DesktopScreenshotButtonIcon()

      Row() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(8)
          .fontColor([this.theme().textOnAccent])
      }
      .width(12)
      .height(12)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.themeColor('#14853D'))
      .borderRadius(6)
      .translate({ x: 8, y: 7 })
    }
    .width(22)
    .height(22)
  }

  @Builder
  SessionSidebar() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Column({ space: 3 }) {
            Text('会话')
              .fontSize(this.scaledFontSize(24))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#17202A'))
            Text(this.sessionMonitorSummaryText())
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#68717D'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Button() {
            SymbolGlyph($r('sys.symbol.chevron_left'))
              .fontSize(20)
              .fontColor([this.themeColor('#17202A')])
          }
            .width(36)
            .height(36)
            .backgroundColor(this.themeColor('#F0F2F5'))
            .borderRadius(18)
            .enabled(this.isLandscapeSessionLayout() || this.selectedSession !== null || this.isNewSessionDraft)
            .onClick(() => {
              this.closeSessionSidebar('header_button');
            })

          this.HomeActionButton('sidebar_header')
        }
        .width('100%')

        Text(this.sessionRefreshHintText())
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#8A95A3'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        Refresh({ refreshing: $$this.isPullRefreshingSessions }) {
          if (this.sessions.length === 0) {
            Column({ space: 8 }) {
              if (this.sessionsLoadError.length > 0) {
                Text('连接会话失败')
                  .fontSize(this.scaledFontSize(18))
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.themeColor('#D74848'))
                Text('检查 Bridge 地址和访问凭证后下拉重试。')
                  .fontSize(this.scaledFontSize(13))
                  .fontColor(this.themeColor('#68717D'))
                  .textAlign(TextAlign.Center)
                Text(this.sessionsLoadError)
                  .fontSize(this.scaledFontSize(11))
                  .fontColor(this.themeColor('#8A95A3'))
                  .textAlign(TextAlign.Center)
                  .maxLines(3)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              } else {
                Text('暂无会话')
                  .fontSize(this.scaledFontSize(18))
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.themeColor('#17202A'))
                Text('下拉重新读取 Codex 会话。')
                  .fontSize(this.scaledFontSize(13))
                  .fontColor(this.themeColor('#68717D'))
                  .textAlign(TextAlign.Center)
              }
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else {
            Scroll() {
              Column({ space: 0 }) {
                this.PinnedSessionGroup()
                if (this.sessionProjectLabels().length > 0) {
                  this.SessionSectionLabel('项目')
                  ForEach(this.sessionProjectLabels(), (projectLabel: string) => {
                    this.SessionProjectGroup(projectLabel)
                  }, (projectLabel: string) => projectLabel)
                }
                this.RecentSessionGroup()
              }
              .width('100%')
            }
            .layoutWeight(1)
            .scrollBar(BarState.Auto)
            .edgeEffect(EdgeEffect.Spring)
          }
        }
        .layoutWeight(1)
        .onRefreshing(() => {
          this.log('info', 'ui.pull_refresh.sessions', '');
          void this.refreshSessions('pull');
        })
      }
      .width('100%')
      .height('100%')
      .padding({ left: 14, right: 14, top: 18, bottom: 14 })
      .backgroundColor(this.themeColor('#FFFFFF'))

      if (this.shouldShowHomeActionMenuInSidebar()) {
        this.HomeActionMenu('sidebar_header')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeColor('#FFFFFF'))
    .zIndex(20)
  }

  @Builder
  SessionSectionLabel(label: string) {
    Text(label)
      .fontSize(this.scaledFontSize(12))
      .fontWeight(FontWeight.Medium)
      .fontColor(this.themeColor('#8A95A3'))
      .width('100%')
      .height(30)
      .padding({ left: 8, top: 8 })
  }

  @Builder
  RecentSessionGroup() {
    if (this.recentSessions().length > 0) {
      Column({ space: 0 }) {
        this.SessionSectionLabel('最近')
        ForEach(this.recentSessions(), (session: CodexSessionSummary) => {
          this.SessionSidebarItem(session)
        }, (session: CodexSessionSummary) => this.sessionSidebarItemKey(session))
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  PinnedSessionGroup() {
    if (this.pinnedSessions().length > 0) {
      Column({ space: 0 }) {
        Row({ space: 8 }) {
          Text('置顶')
            .fontSize(this.scaledFontSize(13))
            .fontWeight(FontWeight.Bold)
            .fontColor(this.themeColor('#9A6700'))
            .maxLines(1)
          Blank()
          Text(this.pinnedGroupMetaText())
            .fontSize(this.scaledFontSize(11))
            .fontColor(this.themeColor('#B68A00'))
        }
        .width('100%')
        .height(34)
        .padding({ left: 8, right: 6 })
        .backgroundColor(this.themeColor('#FFF8E5'))
        .borderRadius(8)
        .margin({ bottom: 3 })

        ForEach(this.pinnedSessions(), (session: CodexSessionSummary) => {
          this.SessionSidebarItem(session)
        }, (session: CodexSessionSummary) => this.sessionSidebarItemKey(session))

        Row()
          .width('100%')
          .height(8)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  SessionProjectGroup(projectLabel: string) {
    Column({ space: 0 }) {
      Row({ space: 8 }) {
        if (this.isSessionProjectCollapsed(projectLabel)) {
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(14)
            .fontColor([this.themeColor('#8A95A3')])
        } else {
          SymbolGlyph($r('sys.symbol.chevron_down'))
            .fontSize(14)
            .fontColor([this.themeColor('#8A95A3')])
        }
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(15)
          .fontColor([this.themeColor('#8A95A3')])
        Text(projectLabel)
          .fontSize(this.scaledFontSize(13))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#68717D'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Blank()
        Text(this.projectGroupMetaText(projectLabel))
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#A0A6AD'))
      }
      .width('100%')
      .height(34)
      .padding({ left: 4, right: 6 })
      .onClick(() => {
        this.toggleSessionProject(projectLabel);
      })

      if (!this.isSessionProjectCollapsed(projectLabel)) {
        ForEach(this.sessionsForProject(projectLabel), (session: CodexSessionSummary) => {
          this.SessionSidebarItem(session)
        }, (session: CodexSessionSummary) => this.sessionSidebarItemKey(session))
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  SessionSidebarItem(session: CodexSessionSummary) {
    Stack({ alignContent: Alignment.End }) {
      Row() {
        Button() {
          if (this.deletingSessionId === session.id) {
            LoadingProgress()
              .width(16)
              .height(16)
              .color(this.theme().textOnAccent)
          } else {
            SymbolGlyph($r('sys.symbol.trash'))
              .fontSize(17)
              .fontColor([this.theme().textOnAccent])
          }
        }
          .width(64)
          .height(38)
          .backgroundColor(this.canDeleteSession(session) ? this.themeColor('#D92D20') : this.themeColor('#D0D5DD'))
          .borderRadius(8)
          .enabled(this.canDeleteSession(session))
          .onClick(() => {
            this.confirmDeleteSession(session);
          })
      }
      .width('100%')
      .height(40)
      .justifyContent(FlexAlign.End)

      Row({ space: 8 }) {
        this.SessionActivityBadge(session)
        Column({ space: 0 }) {
          Text(session.title)
            .fontSize(this.scaledFontSize(16))
            .fontWeight(FontWeight.Medium)
            .fontColor(this.themeColor('#17202A'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Row({ space: 8 }) {
          if (this.deletingSessionId === session.id) {
            LoadingProgress()
              .width(14)
              .height(14)
              .color(this.themeColor('#D92D20'))
          }
          Text(this.sessionTimeLabel(session))
            .fontSize(this.scaledFontSize(13))
            .fontColor(this.isSessionRunning(session.id) ? this.themeColor('#68717D') : this.themeColor('#8A95A3'))
            .maxLines(1)
            .textAlign(TextAlign.End)
        }
        .width(this.sessionSidebarTimeWidth())
        .justifyContent(FlexAlign.End)
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(40)
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .backgroundColor(this.selectedSession?.id === session.id ? this.themeColor('#F0ECE9') : this.themeColor('#FFFFFF'))
      .borderRadius(8)
      .alignItems(VerticalAlign.Center)
      .translate({ x: this.sessionSwipeOffset(session.id), y: 0 })
      .onClick(() => {
        if (this.swipedSessionId === session.id) {
          this.closeSessionSwipe();
          return;
        }
        this.closeSessionSwipe();
        void this.openSession(session);
      })
      .gesture(
        PanGesture({ direction: PanDirection.Horizontal })
          .onActionUpdate((event: GestureEvent) => {
            this.handleSessionSwipeUpdate(session.id, event.offsetX);
          })
          .onActionEnd(() => {
            this.handleSessionSwipeEnd(session.id);
          })
      )
    }
    .width('100%')
    .height(40)
    .margin({ bottom: 2 })
    .clip(true)
  }

  @Builder
  SessionActivityBadge(session: CodexSessionSummary) {
    if (this.isSessionRunning(session.id)) {
      Row() {
        LoadingProgress()
          .width(18)
          .height(18)
          .color(this.themeColor('#1F6FEB'))
      }
      .width(22)
      .height(22)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
    } else if (this.isSessionUnreadCompleted(session.id)) {
      Circle()
        .width(12)
        .height(12)
        .fill(this.themeColor('#1F6FEB'))
    } else {
      Row()
        .width(22)
        .height(22)
    }
  }

  @Builder
  SessionConversationPanel() {
    Column({ space: 6 }) {
      if (this.isNewSessionDraft) {
        if (this.visibleNewSessionEntries().length > 0 || this.visibleFailedSessionMessages().length > 0) {
          Column({ space: 6 }) {
            Text('新建会话')
              .fontSize(this.scaledFontSize(14))
              .fontWeight(FontWeight.Medium)
              .fontColor(this.themeColor('#17202A'))
            Stack({ alignContent: Alignment.BottomEnd }) {
              Scroll(this.sessionScroller) {
                Column({ space: 3 }) {
                  ForEach(this.visibleNewSessionEntries(), (entry: CodexSessionEntry) => {
                    this.SessionEntryCard(entry)
                  }, (entry: CodexSessionEntry) => this.sessionEntryKey(entry))
                  ForEach(this.visibleOptimisticSessionMessages(), (message: OptimisticSessionMessage) => {
                    this.OptimisticSessionMessageCard(message)
                  }, (message: OptimisticSessionMessage) => message.id)
                  ForEach(this.visibleFailedSessionMessages(), (message: FailedSessionMessage) => {
                    this.FailedSessionMessageCard(message)
                  }, (message: FailedSessionMessage) => message.id)
                }
                .width('100%')
              }
              .height('100%')
              .scrollBar(BarState.Auto)
              .edgeEffect(EdgeEffect.Spring)
              .onWillScroll((xOffset: number, yOffset: number, scrollState: ScrollState, scrollSource: ScrollSource) => {
                this.handleSessionWillScroll(yOffset, scrollSource);
              })
              .onScrollEdge((edge: Edge) => {
                this.handleSessionScrollEdge(edge);
              })
              this.SessionJumpToBottomButton()
            }
            .layoutWeight(1)
            .width('100%')
          }
          .layoutWeight(1)
          .width('100%')
        } else {
          Column({ space: 8 }) {
            Text('新建 Codex 会话')
              .fontSize(this.scaledFontSize(20))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#17202A'))
            Text('输入第一条消息后会启动一个真实 Codex 新线程，完成后自动进入新会话。')
              .fontSize(this.scaledFontSize(13))
              .fontColor(this.themeColor('#68717D'))
              .textAlign(TextAlign.Center)
          }
          .layoutWeight(1)
          .width('100%')
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
        }

        if (this.shouldShowSessionFloatingStatus()) {
          this.SessionFloatingStatusPanel()
        }

        this.SessionComposer()
      } else if (this.selectedSession === null) {
        Column({ space: 10 }) {
          Text('会话列表')
            .fontSize(this.scaledFontSize(20))
            .fontWeight(FontWeight.Bold)
            .fontColor(this.themeColor('#17202A'))
          Text('请选择一个会话继续操作。')
            .fontSize(this.scaledFontSize(13))
            .fontColor(this.themeColor('#68717D'))
            .textAlign(TextAlign.Center)
          Button() {
            SymbolGlyph($r('sys.symbol.open_sidebar'))
              .fontSize(20)
              .fontColor([this.theme().textOnAccent])
          }
            .width(42)
            .height(42)
            .backgroundColor(this.themeColor('#1F6FEB'))
            .borderRadius(21)
            .onClick(() => {
              this.sessionSidebarCollapsed = false;
              this.sessionSidebarUserCollapsed = false;
              this.log('info', 'ui.session_sidebar.toggle', 'collapsed=false; source=empty_state');
            })
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else {
        Stack({ alignContent: Alignment.BottomEnd }) {
          Scroll(this.sessionScroller) {
            Column({ space: 3 }) {
              this.SessionHistoryLoader()
              ForEach(this.visibleSessionEntries(), (entry: CodexSessionEntry) => {
                Column() {
                  this.SessionEntryCard(entry)
                }
                .width('100%')
                .onAreaChange((oldArea: Area, newArea: Area) => {
                  this.restoreHistoryScrollAnchor(this.sessionEntryKey(entry), oldArea, newArea);
                })
              }, (entry: CodexSessionEntry) => this.sessionEntryKey(entry))
              ForEach(this.visibleOptimisticSessionMessages(), (message: OptimisticSessionMessage) => {
                this.OptimisticSessionMessageCard(message)
              }, (message: OptimisticSessionMessage) => message.id)
              ForEach(this.visibleFailedSessionMessages(), (message: FailedSessionMessage) => {
                this.FailedSessionMessageCard(message)
              }, (message: FailedSessionMessage) => message.id)
            }
            .width('100%')
          }
          .height('100%')
          .scrollBar(BarState.Auto)
          .edgeEffect(EdgeEffect.Spring)
          .onWillScroll((xOffset: number, yOffset: number, scrollState: ScrollState, scrollSource: ScrollSource) => {
            this.handleSessionWillScroll(yOffset, scrollSource);
          })
          .onScrollEdge((edge: Edge) => {
            this.handleSessionScrollEdge(edge);
          })
          this.SessionJumpToBottomButton()
        }
        .layoutWeight(1)
        .width('100%')

        if (this.shouldShowSessionFloatingStatus()) {
          this.SessionFloatingStatusPanel()
        }

        this.SessionComposer()
      }
    }
    .layoutWeight(1)
    .width('100%')
    .height('100%')
  }

  @Builder
  SessionJumpToBottomButton() {
    if (!this.sessionAutoFollowBottom) {
      Button() {
        Row({ space: 6 }) {
          Text('↓')
            .fontSize(this.scaledFontSize(20))
            .fontColor(this.themeColor('#1F6FEB'))
          Text('回到底部')
            .fontSize(this.scaledFontSize(13))
            .fontColor(this.themeColor('#17202A'))
        }
        .padding({ left: 14, right: 14 })
      }
      .height(44)
      .backgroundColor(this.themeColor('#FFFFFF'))
      .border({ width: 1, color: this.themeColor('#DDE3EA') })
      .borderRadius(22)
      .margin({ right: 12, bottom: 12 })
      .accessibilityText('回到底部，跟随最新消息')
      .onClick(() => {
        this.scrollSessionToBottom(0);
        this.log('info', 'ui.session_scroll.jump_to_bottom', 'source=button');
      })
    }
  }

  @Builder
  OptimisticSessionMessageCard(message: OptimisticSessionMessage) {
    Row() {
      Blank()

      Column({ space: 5 }) {
        Row({ space: 6 }) {
          Text(this.sessionEntryTimeText({
            timestamp: message.createdAt,
            type: 'optimistic_user_message',
            role: 'user',
            text: message.text
          }))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#8A95A3'))
          Text('你')
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#4E6278'))
          LoadingProgress()
            .width(11)
            .height(11)
            .color(this.themeColor('#1F6FEB'))
        }
        .width('100%')
        .justifyContent(FlexAlign.End)

        if (message.images.length > 0) {
          ForEach(message.images, (image: PendingSessionImage) => {
            Row() {
              Blank()
              Image(image.uri)
                .width(72)
                .height(72)
                .objectFit(ImageFit.Contain)
                .backgroundColor('#00000000')
                .borderRadius(8)
                .onClick(() => {
                  this.openImagePreview(image.uri, `optimistic:${message.id}:${image.id}`);
                })
            }
            .width('100%')
          }, (image: PendingSessionImage) => `${message.id}-${image.id}`)
        }

        if (message.text.trim().length > 0) {
          Text(message.text)
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#17202A'))
            .width('100%')
            .padding({ left: 12, right: 12, top: 9, bottom: 10 })
            .backgroundColor(this.themeColor('#EAF4FF'))
            .border({ width: 1, color: this.themeColor('#CFE3FF') })
            .borderRadius(10)
            .copyOption(CopyOptions.LocalDevice)
        }
      }
      .width(this.userTextBubbleWidth(message.text))
      .constraintSize({ maxWidth: '82%' })
    }
    .width('100%')
    .padding({ top: 3, bottom: 3 })
  }

  @Builder
  FailedSessionMessageCard(message: FailedSessionMessage) {
    Row({ space: 8 }) {
      Blank()

      Button() {
        if (message.retrying) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(this.theme().textOnAccent)
        } else {
          SymbolGlyph($r('sys.symbol.arrow_up'))
            .fontSize(16)
            .fontColor([this.theme().textOnAccent])
        }
      }
        .width(32)
        .height(32)
        .backgroundColor(message.retrying ? this.themeColor('#8A95A3') : this.themeColor('#14853D'))
        .borderRadius(16)
        .enabled(this.canRetryFailedSessionMessage(message))
        .onClick(() => {
          void this.retryFailedSessionMessage(message, 'manual');
        })

      Row({ space: 6 }) {
        Column({ space: 5 }) {
          Row({ space: 6 }) {
            Text(this.failedSessionMessageTimeText(message))
              .fontSize(this.scaledFontSize(9))
              .fontColor(this.themeColor('#B42318'))
            Text(this.failedSessionMessageStatusText(message))
              .fontSize(this.scaledFontSize(10))
              .fontColor(this.themeColor('#B42318'))
              .fontWeight(FontWeight.Regular)
          }
          .width('100%')
          .justifyContent(FlexAlign.End)

          if (message.images.length > 0) {
            Row({ space: 6 }) {
              Blank()
              ForEach(message.images, (image: PendingSessionImage) => {
                Image(image.uri)
                  .width(54)
                  .height(54)
                  .objectFit(ImageFit.Cover)
                  .backgroundColor(this.themeColor('#ECEFF3'))
                  .borderRadius(8)
                  .onClick(() => {
                    this.openImagePreview(image.uri, `failed:${message.id}:${image.id}`);
                  })
              }, (image: PendingSessionImage) => `${message.id}-${image.id}`)
            }
            .width('100%')
          }

          if (message.text.trim().length > 0) {
            Text(message.text)
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#17202A'))
              .fontWeight(FontWeight.Regular)
              .width('100%')
              .maxLines(8)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .copyOption(CopyOptions.LocalDevice)
          }

          Text(this.compactDisplayText(message.error, 90))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#B42318'))
            .width('100%')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .copyOption(CopyOptions.LocalDevice)
        }
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 8, bottom: 9 })
        .backgroundColor(this.themeColor('#FFF1F0'))
        .border({ width: 1, color: this.themeColor('#FDA29B') })
        .borderRadius(10)

        Column({ space: 6 }) {
          Button() {
            SymbolGlyph($r('sys.symbol.xmark'))
              .fontSize(14)
              .fontColor([this.themeColor('#667085')])
          }
            .width(28)
            .height(28)
            .backgroundColor(this.themeColor('#FFFFFF'))
            .border({ width: 1, color: this.themeColor('#DDE3EA') })
            .borderRadius(14)
            .enabled(true)
            .onClick(() => {
              this.cancelFailedSessionAutoRetry(message.id);
            })
        }
        .justifyContent(FlexAlign.Center)
      }
      .width('78%')
    }
    .width('100%')
    .padding({ top: 3, bottom: 3 })
  }

  @Builder
  SessionEntryCard(entry: CodexSessionEntry) {
    if (entry.type === 'live_activity') {
      Column({ space: 3 }) {
        Row({ space: 6 }) {
          LoadingProgress()
            .width(11)
            .height(11)
            .color(this.themeColor('#1F6FEB'))

          Text(this.sessionEntryDisplayText(entry))
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#52606D'))
            .fontWeight(FontWeight.Regular)
            .layoutWeight(1)
            .maxLines(4)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .copyOption(CopyOptions.LocalDevice)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('88%')
      .padding({ left: 12, right: 0, top: 0, bottom: 4 })
    } else if (entry.type === 'live_agent_status') {
      Column({ space: 5 }) {
        Row({ space: 6 }) {
          Text('Codex')
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#8A95A3'))
            .fontWeight(FontWeight.Regular)
          Text(this.sessionEntryTimeText(entry))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#8A95A3'))
          LoadingProgress()
            .width(12)
            .height(12)
            .color(this.themeColor('#1F6FEB'))
        }
        .width('100%')

        Text(this.sessionEntryDisplayText(entry))
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#344054'))
          .fontWeight(FontWeight.Regular)
          .width('100%')
          .maxLines(4)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('88%')
      .padding({ left: 12, right: 0, top: 1, bottom: 5 })
    } else if (entry.role === 'tool') {
      this.SessionToolEntryView(entry)
    } else if (this.isSessionMetaEntry(entry)) {
      Column({ space: 1 }) {
        Row({ space: 7 }) {
          if (this.isActiveSessionMetaEntry(entry)) {
            LoadingProgress()
              .width(11)
              .height(11)
              .color(this.themeColor('#8A949F'))
          } else {
            Text(this.sessionMetaEntryMark(entry))
              .fontSize(this.scaledFontSize(10))
              .fontColor(this.sessionMetaEntryColor(entry))
              .width(14)
              .textAlign(TextAlign.Center)
          }

          Text(this.sessionMetaEntrySummaryText(entry))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.sessionMetaEntryColor(entry))
            .fontWeight(FontWeight.Regular)
            .layoutWeight(1)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .copyOption(CopyOptions.LocalDevice)

          if (this.hasExpandableSessionMetaEntry(entry)) {
            Text(this.isSessionEntryExpanded(entry) ? '⌃' : '⌄')
              .fontSize(this.scaledFontSize(10))
              .fontColor(this.themeColor('#8A949F'))
              .width(14)
              .textAlign(TextAlign.Center)
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        if (this.isSessionEntryExpanded(entry) && this.sessionMetaEntryDetailText(entry).length > 0) {
          Text(this.sessionMetaEntryDetailText(entry))
            .fontSize(this.scaledFontSize(8))
            .fontColor(this.themeColor('#667085'))
            .lineHeight(this.scaledLineHeight(12))
            .padding({ left: 21, right: 2, top: 1 })
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
        }
      }
      .width('88%')
      .padding({ left: 12, right: 0, top: 0, bottom: 0 })
      .onClick(() => {
        if (this.hasExpandableSessionMetaEntry(entry)) {
          this.toggleSessionEntry(entry);
        }
      })
    } else if (entry.role === 'user') {
      Row() {
        Blank()
        Column({ space: 5 }) {
          Row({ space: 6 }) {
            Text(this.sessionEntryTimeText(entry))
              .fontSize(this.scaledFontSize(9))
              .fontColor(this.themeColor('#8A95A3'))
            Text('你')
              .fontSize(this.scaledFontSize(10))
              .fontColor(this.themeColor('#4E6278'))
              .fontWeight(FontWeight.Regular)
          }
          .width('100%')
          .justifyContent(FlexAlign.End)

          if (this.sessionEntryImages(entry).length > 0) {
            ForEach(this.sessionEntryImages(entry), (imageUrl: string) => {
              Row() {
                Blank()
                Image(imageUrl)
                  .width(this.userImageEntryWidth(entry))
                  .height(this.userImageEntryHeight(entry))
                  .objectFit(ImageFit.Contain)
                  .backgroundColor('#00000000')
                  .borderRadius(8)
                  .onClick(() => {
                    this.openImagePreview(imageUrl, 'user_entry');
                  })
              }
              .width('100%')
              Row() {
                Blank()
                this.SessionContentActionRow(entry, imageUrl)
              }
              .width('100%')
            }, (imageUrl: string) => imageUrl)
          }

          if (this.shouldRenderUserTextBubble(entry)) {
            Column() {
              this.SessionMarkdownContent(entry, true)
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 9, bottom: 10 })
            .backgroundColor(this.themeColor('#EAF4FF'))
            .border({ width: 1, color: this.themeColor('#CFE3FF') })
            .borderRadius(10)
            Row() {
              Blank()
              this.SessionContentActionRow(entry, '')
            }
            .width('100%')
          }
        }
        .width(this.userSessionEntryWidth(entry))
        .constraintSize({ maxWidth: '82%' })
      }
      .width('100%')
    } else {
      Column({ space: 5 }) {
        Row({ space: 6 }) {
          Row()
            .width(6)
            .height(6)
            .backgroundColor(this.theme().accent)
            .borderRadius(3)
          Text(this.sessionAssistantEntryLabel(entry))
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#8A95A3'))
            .fontWeight(FontWeight.Regular)
          Text(this.sessionEntryTimeText(entry))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#8A95A3'))
          if (entry.type === 'live_agent_streaming') {
            LoadingProgress()
              .width(12)
              .height(12)
              .color(this.themeColor('#1F6FEB'))
          }
        }
        .width('100%')

        if (this.sessionEntryImages(entry).length > 0) {
          ForEach(this.sessionEntryImages(entry), (imageUrl: string) => {
            Row() {
              Image(imageUrl)
                .width(this.assistantImageEntryWidth())
                .height(this.assistantImageEntryHeight())
                .objectFit(ImageFit.Contain)
                .backgroundColor('#00000000')
                .borderRadius(8)
                .onClick(() => {
                  this.openImagePreview(imageUrl, 'assistant_entry');
                })
              Blank()
            }
            .width('100%')
            Row() {
              this.SessionContentActionRow(entry, imageUrl)
              Blank()
            }
            .width('100%')
          }, (imageUrl: string) => imageUrl)
        }

        this.SessionMarkdownContent(entry, false)
        if (this.sessionEntryVisibleText(entry).length > 0) {
          Row() {
            this.SessionContentActionRow(entry, '')
            Blank()
          }
          .width('100%')
        }
      }
      .width('88%')
      .padding({ left: 12, right: 0, top: 3, bottom: 8 })
    }
  }

  @Builder
  SessionContentActionRow(entry: CodexSessionEntry, imageUrl: string) {
    Row({ space: 4 }) {
      Button(imageUrl.length > 0 ? '复制图片' : '复制')
        .type(ButtonType.Normal)
        .height(24)
        .padding({ left: 8, right: 8 })
        .fontSize(this.scaledFontSize(9))
        .fontColor(this.themeColor('#8A95A3'))
        .backgroundColor(Color.Transparent)
        .borderRadius(6)
        .onClick(() => {
          if (imageUrl.length > 0) {
            void this.copySessionImage(imageUrl);
          } else {
            void this.copySessionText(entry);
          }
        })
      Button(imageUrl.length > 0 ? '分享图片' : '分享')
        .type(ButtonType.Normal)
        .height(24)
        .padding({ left: 8, right: 8 })
        .fontSize(this.scaledFontSize(9))
        .fontColor(this.theme().accent)
        .backgroundColor(Color.Transparent)
        .borderRadius(6)
        .onClick(() => {
          if (imageUrl.length > 0) {
            void this.shareSessionImage(imageUrl);
          } else {
            void this.shareSessionText(entry);
          }
        })
    }
  }

  @Builder
  SessionToolEntryView(entry: CodexSessionEntry) {
    Column({ space: 1 }) {
      if (this.isSessionToolGroup(entry)) {
        Row({ space: 8 }) {
          if (this.sessionToolGroupIsRunning(entry)) {
            LoadingProgress()
              .width(11)
              .height(11)
              .color(this.sessionToolGroupColor(entry))
          } else {
            Text('●')
              .fontSize(this.scaledFontSize(7))
              .fontColor(this.sessionToolGroupColor(entry))
              .width(11)
              .textAlign(TextAlign.Center)
          }

          Text(this.sessionToolGroupTitle(entry))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#667085'))
            .fontWeight(FontWeight.Medium)
            .lineHeight(this.scaledLineHeight(13))
            .layoutWeight(1)

          if (this.sessionToolGroupIsCollapsible(entry)) {
            Button(this.isSessionToolGroupExpanded(entry) ? '收起' : '全部展开')
              .type(ButtonType.Normal)
              .height(24)
              .fontSize(this.scaledFontSize(8))
              .fontColor(this.themeColor('#667085'))
              .backgroundColor(Color.Transparent)
              .padding({ left: 4, right: 4 })
              .onClick(() => {
                this.toggleSessionToolGroup(entry);
              })
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }

      if (this.shouldShowSessionToolGroupItems(entry)) {
        ForEach(sessionToolPresentationItems(entry), (item: SessionToolPresentationItem) => {
          Column({ space: 2 }) {
            Row({ space: 7 }) {
              if (item.status === 'running') {
                LoadingProgress()
                  .width(12)
                  .height(12)
                  .color(this.themeColor('#8A949F'))
              } else {
                Text(this.sessionToolItemMark(item))
                  .fontSize(this.scaledFontSize(10))
                  .fontColor(this.sessionToolItemColor(item))
                  .width(14)
                  .textAlign(TextAlign.Center)
              }

              Text(item.verb)
                .fontSize(this.scaledFontSize(9))
                .fontColor(this.sessionToolItemColor(item))
                .fontWeight(FontWeight.Medium)
                .lineHeight(this.scaledLineHeight(13))

              Text(item.target)
                .fontSize(this.scaledFontSize(9))
                .fontColor(this.themeColor('#667085'))
                .fontFamily('monospace')
                .lineHeight(this.scaledLineHeight(13))
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .copyOption(CopyOptions.LocalDevice)

              Text(this.sessionToolItemStatusText(item))
                .fontSize(this.scaledFontSize(8))
                .fontColor(this.sessionToolItemColor(item))
                .lineHeight(this.scaledLineHeight(12))

              if (this.hasExpandableSessionToolItem(item)) {
                Text(this.isSessionToolItemExpanded(entry, item) ? '⌃' : '⌄')
                  .fontSize(this.scaledFontSize(10))
                  .fontColor(this.themeColor('#8A949F'))
                  .width(14)
                  .textAlign(TextAlign.Center)
              }
            }
            .width('100%')
            .height(34)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              if (this.hasExpandableSessionToolItem(item)) {
                this.toggleSessionToolItem(entry, item);
              }
            })

            if (this.isSessionToolItemExpanded(entry, item)) {
              Column({ space: 5 }) {
                Text(item.target)
                  .fontSize(this.scaledFontSize(8))
                  .fontColor(this.themeColor('#475467'))
                  .fontFamily('monospace')
                  .lineHeight(this.scaledLineHeight(12))
                  .width('100%')
                  .copyOption(CopyOptions.LocalDevice)

                if (item.detail.length > 0) {
                  Text(item.detail)
                    .fontSize(this.scaledFontSize(8))
                    .fontColor(this.themeColor('#667085'))
                    .lineHeight(this.scaledLineHeight(12))
                    .width('100%')
                    .copyOption(CopyOptions.LocalDevice)
                }

                Button('复制')
                  .type(ButtonType.Normal)
                  .height(24)
                  .fontSize(this.scaledFontSize(8))
                  .fontColor(this.themeColor('#1F6FEB'))
                  .backgroundColor(Color.Transparent)
                  .padding({ left: 0, right: 6 })
                  .onClick(() => {
                    void this.copySessionPresentationText(item.target, '工具目标');
                  })
              }
              .width('100%')
              .padding({ left: 21, right: 6, top: 2, bottom: 7 })
              .backgroundColor(this.themeColor('#F8FAFC'))
              .borderRadius(7)
            }
          }
          .width('100%')
          .border({ width: { top: 1 }, color: this.themeColor('#E4E7EC') })
        }, (item: SessionToolPresentationItem) => this.sessionToolItemKey(entry, item))
      }
    }
    .width('88%')
    .padding({ left: 12, right: 0, top: 2, bottom: 3 })
  }

  @Builder
  SessionMarkdownContent(entry: CodexSessionEntry, isUser: boolean) {
    Column({ space: 4 }) {
      ForEach(this.sessionEntryMarkdownBlocks(entry), (block: SessionMarkdownBlock) => {
        this.SessionMarkdownBlockView(entry, block, isUser)
      }, (block: SessionMarkdownBlock) => block.id)
    }
    .width('100%')
  }

  @Builder
  SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean) {
    if (block.kind === 'heading') {
      this.SessionMarkdownInlineText(
        block.text,
        isUser,
        this.markdownHeadingFontSize(block.level, isUser),
        this.markdownHeadingLineHeight(block.level, isUser),
        true
      )
    } else if (block.kind === 'code') {
      Column({ space: 3 }) {
        Row({ space: 6 }) {
          Text(block.language.length > 0 ? block.language : '代码')
            .fontSize(this.scaledFontSize(8))
            .fontColor(this.themeColor('#667085'))
            .fontWeight(FontWeight.Regular)

          Blank()

          Button('复制')
            .type(ButtonType.Normal)
            .height(22)
            .fontSize(this.scaledFontSize(8))
            .fontColor(this.themeColor('#1F6FEB'))
            .backgroundColor(Color.Transparent)
            .padding({ left: 4, right: 4 })
            .onClick(() => {
              void this.copySessionPresentationText(block.text, '代码');
            })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text(block.text)
          .fontSize(this.scaledFontSize(10))
          .fontColor(this.themeColor('#101828'))
          .fontFamily('monospace')
          .lineHeight(this.scaledLineHeight(14))
          .width('100%')
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .backgroundColor(isUser ? this.themeColor('#DDEEFF') : this.themeColor('#F2F4F7'))
      .border({ width: 1, color: isUser ? this.themeColor('#C2DAF8') : this.themeColor('#E4E7EC') })
      .borderRadius(7)
    } else if (block.kind === 'quote') {
      Row({ space: 7 }) {
        Column()
          .width(3)
          .alignSelf(ItemAlign.Stretch)
          .backgroundColor(this.themeColor('#98A2B3'))
          .borderRadius(2)
        Column() {
          this.SessionMarkdownInlineText(block.text, isUser, isUser ? 11 : 10, isUser ? 16 : 15, false)
        }
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ top: 2, bottom: 2 })
    } else if (block.kind === 'list') {
      Row({ space: 6 }) {
        Text(block.ordered ? `${block.level}.` : '•')
          .fontSize(this.scaledFontSize(isUser ? 11 : 10))
          .fontColor(isUser ? this.themeColor('#426384') : this.themeColor('#667085'))
          .width(16)
          .textAlign(TextAlign.Center)
        Column() {
          this.SessionMarkdownInlineText(block.text, isUser, isUser ? 12 : 11, isUser ? 17 : 16, false)
        }
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === 'task') {
      Row({ space: 6 }) {
        Text(block.checked ? '☑' : '☐')
          .fontSize(this.scaledFontSize(isUser ? 11 : 10))
          .fontColor(block.checked ? this.themeColor('#1F6FEB') : this.themeColor('#8A95A3'))
          .width(16)
          .textAlign(TextAlign.Center)
        Column() {
          this.SessionMarkdownInlineText(block.text, isUser, isUser ? 12 : 11, isUser ? 17 : 16, false)
        }
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === 'table') {
      this.SessionMarkdownTableView(block, isUser)
    } else if (block.kind === 'codex_directive') {
      this.CodexDirectiveBlockView(entry, block)
    } else if (block.kind === 'directive') {
      Column({ space: 4 }) {
        Row({ space: 6 }) {
          Column() {
            Text('<>')
              .fontSize(this.scaledFontSize(9))
              .fontColor(this.themeColor('#1F6FEB'))
              .fontWeight(FontWeight.Medium)
          }
          .width(28)
          .height(28)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .backgroundColor(this.themeColor('#EAF4FF'))
          .borderRadius(8)

          Text(this.markdownDirectiveTitle(block.language))
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#344054'))
            .fontWeight(FontWeight.Medium)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })

          SymbolGlyph(this.isSessionMarkdownBlockExpanded(entry, block) ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(14)
            .fontColor([this.themeColor('#667085')])
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        if (this.isSessionMarkdownBlockExpanded(entry, block)) {
          this.MarkdownDirectiveDetailView(block)
        } else {
          Text(this.markdownDirectiveSummary(block))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#667085'))
            .lineHeight(this.scaledLineHeight(13))
            .width('100%')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .copyOption(CopyOptions.LocalDevice)
        }
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .backgroundColor(this.themeColor('#F8FAFC'))
      .border({ width: 1, color: this.themeColor('#E4E7EC') })
      .borderRadius(8)
      .onClick(() => {
        this.toggleSessionMarkdownBlock(entry, block);
      })
    } else if (block.kind === 'rule') {
      Row()
        .height(1)
        .width('100%')
        .backgroundColor(isUser ? this.themeColor('#CFE3FF') : this.themeColor('#E4E7EC'))
        .margin({ top: 3, bottom: 3 })
    } else {
      this.SessionMarkdownInlineText(block.text, isUser, isUser ? 12 : 11, isUser ? 17 : 16, false)
    }
  }

  @Builder
  SessionMarkdownInlineText(
    text: string,
    isUser: boolean,
    fontSize: number,
    lineHeight: number,
    isHeading: boolean
  ) {
    Text() {
      ForEach(parseSessionMarkdownInline(text), (segment: SessionMarkdownInlineSegment) => {
        if (segment.kind === 'strong') {
          Span(segment.text)
            .fontWeight(FontWeight.Bold)
        } else if (segment.kind === 'emphasis') {
          Span(segment.text)
            .fontStyle(FontStyle.Italic)
        } else if (segment.kind === 'strike') {
          Span(segment.text)
            .decoration({ type: TextDecorationType.LineThrough })
        } else if (segment.kind === 'code') {
          Span(segment.text)
            .fontFamily('monospace')
            .fontColor(isUser ? this.themeColor('#173B63') : this.themeColor('#344054'))
            .textBackgroundStyle({
              color: isUser ? this.themeColor('#CFE3FF') : this.themeColor('#F2F4F7'),
              radius: 4
            })
        } else if (segment.kind === 'link') {
          Span(segment.text)
            .fontColor(this.themeColor('#1F6FEB'))
            .decoration({ type: TextDecorationType.Underline })
            .onClick(() => {
              void this.openSessionMarkdownLink(segment.href);
            })
        } else {
          Span(segment.text)
        }
      }, (segment: SessionMarkdownInlineSegment) => segment.id)
    }
    .fontSize(this.scaledFontSize(fontSize))
    .fontColor(isUser ? this.themeColor('#17202A') : this.themeColor('#22272E'))
    .fontWeight(isHeading ? FontWeight.Medium : FontWeight.Regular)
    .lineHeight(this.scaledLineHeight(lineHeight))
    .width('100%')
    .copyOption(CopyOptions.LocalDevice)
  }

  @Builder
  SessionMarkdownTableView(block: SessionMarkdownBlock, isUser: boolean) {
    Column() {
      Scroll() {
        Column({ space: 0 }) {
          Row() {
            ForEach(parseSessionMarkdownTable(block.text).headers, (cell: string) => {
              Column() {
                this.SessionMarkdownInlineText(cell, isUser, isUser ? 10 : 9, isUser ? 15 : 14, true)
              }
              .width(this.sessionMarkdownTableColumnWidth(block))
              .constraintSize({ minHeight: 34 })
              .alignSelf(ItemAlign.Stretch)
              .padding({ left: 7, right: 7, top: 6, bottom: 6 })
              .justifyContent(FlexAlign.Center)
              .border({ width: 1, color: this.themeColor('#D0D5DD') })
              .backgroundColor(isUser ? this.themeColor('#DDEEFF') : this.themeColor('#F2F4F7'))
            }, (cell: string, index: number) => `table-header-${index}-${cell}`)
          }

          ForEach(parseSessionMarkdownTable(block.text).rows, (row: string[], rowIndex: number) => {
            Row() {
              ForEach(row, (cell: string, cellIndex: number) => {
                Column() {
                  this.SessionMarkdownInlineText(cell, isUser, isUser ? 10 : 9, isUser ? 15 : 14, false)
                }
                .width(this.sessionMarkdownTableColumnWidth(block))
                .constraintSize({ minHeight: 34 })
                .alignSelf(ItemAlign.Stretch)
                .padding({ left: 7, right: 7, top: 6, bottom: 6 })
                .justifyContent(FlexAlign.Center)
                .border({ width: 1, color: this.themeColor('#D0D5DD') })
              }, (cell: string, cellIndex: number) => `table-${rowIndex}-${cellIndex}-${cell}`)
            }
          }, (row: string[], rowIndex: number) => `table-row-${rowIndex}-${row.join('|')}`)
        }
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Auto)
      .width('100%')
    }
    .width('100%')
    .borderRadius(7)
  }

  private sessionMarkdownTableColumnWidth(block: SessionMarkdownBlock): number {
    const columnCount = Math.max(1, parseSessionMarkdownTable(block.text).headers.length);
    const windowWidth = this.sessionWindowWidthVp();
    const panelWidth = this.isLandscapeSessionLayout() && !this.sessionSidebarUserCollapsed
      ? Math.max(0, windowWidth - this.sessionLandscapeSidebarWidth() - 18)
      : windowWidth;
    const messageWidth = Math.max(0, panelWidth - 24) * 0.88;
    const fittedWidth = Math.floor(messageWidth / columnCount);
    return Math.max(112, Math.min(220, fittedWidth > 0 ? fittedWidth : 128));
  }

  @Builder
  CodexDirectiveBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock) {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Column() {
          this.CodexDirectiveIconView(block.language)
        }
          .width(30)
          .height(30)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .backgroundColor(this.codexDirectiveAccentBackground(block.language))
          .borderRadius(8)

        Column({ space: 2 }) {
          Text(this.codexDirectiveTitle(block.language))
            .fontSize(this.scaledFontSize(11))
            .fontColor(this.themeColor('#1F2937'))
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Text(this.codexDirectiveSummary(block))
            .fontSize(this.scaledFontSize(9))
            .fontColor(this.themeColor('#667085'))
            .lineHeight(this.scaledLineHeight(13))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .copyOption(CopyOptions.LocalDevice)
            .width('100%')
        }
        .layoutWeight(1)

        SymbolGlyph(this.isSessionMarkdownBlockExpanded(entry, block) ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
          .fontSize(14)
          .fontColor([this.themeColor('#667085')])
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.isSessionMarkdownBlockExpanded(entry, block)) {
        this.CodexDirectiveDetailView(block)
      }
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .backgroundColor(this.themeColor('#F8FAFC'))
    .border({ width: 1, color: this.themeColor('#E4E7EC') })
    .borderRadius(8)
    .onClick(() => {
      this.toggleSessionMarkdownBlock(entry, block);
    })
  }

  @Builder
  CodexDirectiveIconView(name: string) {
    if (name === 'git-create-branch') {
      SymbolGlyph($r('sys.symbol.folder'))
        .fontSize(16)
        .fontColor([this.codexDirectiveAccentColor(name)])
    } else if (name === 'git-stage') {
      SymbolGlyph($r('sys.symbol.plus'))
        .fontSize(17)
        .fontColor([this.codexDirectiveAccentColor(name)])
    } else if (name === 'git-commit') {
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(17)
        .fontColor([this.codexDirectiveAccentColor(name)])
    } else if (name === 'git-push') {
      SymbolGlyph($r('sys.symbol.arrow_up'))
        .fontSize(16)
        .fontColor([this.codexDirectiveAccentColor(name)])
    } else if (name === 'git-merge' || name === 'git-checkout') {
      SymbolGlyph($r('sys.symbol.open_sidebar'))
        .fontSize(16)
        .fontColor([this.codexDirectiveAccentColor(name)])
    } else {
      Text('<>')
        .fontSize(this.scaledFontSize(10))
        .fontColor(this.codexDirectiveAccentColor(name))
        .fontWeight(FontWeight.Medium)
    }
  }

  @Builder
  CodexDirectiveDetailView(block: SessionMarkdownBlock) {
    Column({ space: 5 }) {
      ForEach(this.codexDirectiveDetailFields(block), (field: SessionStructuredField) => {
        this.StructuredFieldView(field)
      }, (field: SessionStructuredField) => `${field.label}-${field.kind}-${field.value}`)
    }
    .width('100%')
    .padding({ left: 38, right: 2, top: 1 })
  }

  @Builder
  MarkdownDirectiveDetailView(block: SessionMarkdownBlock) {
    Column({ space: 5 }) {
      ForEach(this.markdownDirectiveDetailFields(block), (field: SessionStructuredField) => {
        this.StructuredFieldView(field)
      }, (field: SessionStructuredField) => `${field.label}-${field.kind}-${field.value}`)
    }
    .width('100%')
    .padding({ left: 36, right: 2, top: 1 })
  }

  @Builder
  StructuredFieldView(field: SessionStructuredField) {
    Column({ space: 2 }) {
      Row({ space: 5 }) {
        Text(field.label)
          .fontSize(this.scaledFontSize(8))
          .fontColor(this.structuredFieldLabelColor(field.kind))
          .fontWeight(FontWeight.Medium)
          .padding({ left: 5, right: 5, top: 1, bottom: 1 })
          .backgroundColor(this.structuredFieldLabelBackground(field.kind))
          .borderRadius(5)

        Text(field.value)
          .fontSize(this.scaledFontSize(field.kind === 'code' || field.kind === 'path' ? 9 : 10))
          .fontColor(this.themeColor('#1F2937'))
          .fontWeight(FontWeight.Regular)
          .layoutWeight(1)
          .lineHeight(this.scaledLineHeight(14))
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      if (field.meta.length > 0) {
        Text(field.meta)
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#667085'))
          .lineHeight(this.scaledLineHeight(13))
          .width('100%')
          .padding({ left: 48 })
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .width('100%')
    .padding({ left: 0, right: 0, top: 2, bottom: 2 })
  }

  @Builder
  SessionTaskPanel() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(this.statusLabel(this.selectedVisibleTask()?.status ?? 'idle'))
          .fontSize(this.scaledFontSize(10))
          .fontColor(this.theme().textOnAccent)
          .padding({ left: 7, right: 7, top: 2, bottom: 2 })
          .backgroundColor(this.statusColor(this.selectedVisibleTask()?.status ?? 'idle'))
          .borderRadius(4)

        Text(this.selectedTaskSummaryText())
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#68717D'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      if (this.pendingApprovalId().length > 0) {
        Column({ space: 8 }) {
          Text('需要你确认')
            .fontSize(this.scaledFontSize(13))
            .fontWeight(FontWeight.Medium)
            .fontColor(this.themeColor('#B42318'))
          Text(this.pendingApprovalSummary())
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#68717D'))
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Row({ space: 8 }) {
            Button('同意')
              .height(36)
              .layoutWeight(1)
              .backgroundColor(this.themeColor('#137333'))
              .onClick(() => {
                this.log('info', 'ui.click.session_approval', `approvalId=${this.pendingApprovalId()}; decision=approved`);
                void this.decideApproval(this.pendingApprovalId(), 'approved');
              })
            Button('拒绝')
              .height(36)
              .layoutWeight(1)
              .backgroundColor(this.themeColor('#B42318'))
              .onClick(() => {
                this.log('info', 'ui.click.session_approval', `approvalId=${this.pendingApprovalId()}; decision=denied`);
                void this.decideApproval(this.pendingApprovalId(), 'denied');
              })
          }
        }
        .width('100%')
        .padding(10)
        .backgroundColor(this.themeColor('#FFF4F2'))
        .borderRadius(8)
      }

      if (this.pendingUserInput() !== null) {
        this.UserInputForm()
      }

      if (this.selectedSessionTaskEventCount() > 0) {
        Row() {
          Text(`任务事件 ${this.selectedSessionTaskEventCount()} 条`)
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#68717D'))
          Blank()
          Button(this.showTaskEventDetails ? '收起详情' : '展开详情')
            .height(26)
            .fontSize(this.scaledFontSize(10))
            .fontColor(this.themeColor('#1F6FEB'))
            .backgroundColor(this.themeColor('#EAF2FF'))
            .onClick(() => {
              this.showTaskEventDetails = !this.showTaskEventDetails;
              this.log('info', 'ui.session_task_events.toggle', `expanded=${this.showTaskEventDetails}`);
            })
        }
        .width('100%')
      }

      if (this.showTaskEventDetails && this.visibleSessionTaskEvents().length > 0) {
        Column({ space: 6 }) {
          ForEach(this.visibleSessionTaskEvents(), (event: BridgeEvent) => {
            Row({ space: 8 }) {
              Text(this.eventLabel(event.type))
                .fontSize(this.scaledFontSize(11))
                .fontColor(this.themeColor('#17202A'))
                .width(74)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.eventSummary(event))
                .fontSize(this.scaledFontSize(11))
                .fontColor(this.themeColor('#68717D'))
                .layoutWeight(1)
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .width('100%')
          }, (event: BridgeEvent) => event.id)
        }
        .width('100%')
      }

    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 7, bottom: 7 })
    .backgroundColor(this.themeColor('#FFFFFF'))
    .borderRadius(7)
  }

  @Builder
  SessionFloatingStatusPanel() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        if (this.sessionFloatingStatusIsRunning()) {
          LoadingProgress()
            .width(14)
            .height(14)
            .color(this.themeColor('#1F6FEB'))
        }
        Text(this.sessionFloatingStatusTitle())
          .fontSize(this.scaledFontSize(11))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.sessionFloatingStatusColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)

        if (this.pendingApprovalId().length > 0) {
          Button('同意')
            .height(24)
            .fontSize(this.scaledFontSize(10))
            .backgroundColor(this.themeColor('#137333'))
            .onClick(() => {
              this.log('info', 'ui.click.floating_approval', `approvalId=${this.pendingApprovalId()}; decision=approved`);
              void this.decideApproval(this.pendingApprovalId(), 'approved');
            })
          Button('拒绝')
            .height(24)
            .fontSize(this.scaledFontSize(10))
            .backgroundColor(this.themeColor('#B42318'))
            .onClick(() => {
              this.log('info', 'ui.click.floating_approval', `approvalId=${this.pendingApprovalId()}; decision=denied`);
              void this.decideApproval(this.pendingApprovalId(), 'denied');
            })
        }

        Button() {
          SymbolGlyph(this.sessionStatusExpanded ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(14)
            .fontColor([this.themeColor('#68717D')])
        }
          .width(26)
          .height(26)
          .backgroundColor(this.themeColor('#F0F2F5'))
          .borderRadius(13)
          .onClick(() => {
            this.sessionStatusExpanded = !this.sessionStatusExpanded;
            this.log('info', 'ui.session_status.toggle', `expanded=${this.sessionStatusExpanded}`);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.sessionStatusExpanded) {
        Text(this.sessionFloatingStatusDetail())
          .fontSize(this.scaledFontSize(10))
          .fontColor(this.themeColor('#68717D'))
          .width('100%')
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('92%')
    .padding({ left: 10, right: 8, top: 7, bottom: 7 })
    .backgroundColor(this.themeColor('#F9FAFB'))
    .border({ width: 1, color: this.themeColor('#E5EAF0') })
    .borderRadius(18)
    .shadow({ radius: 8, color: this.themeColor('#1F232812'), offsetX: 0, offsetY: 2 })
    .alignSelf(ItemAlign.Center)
  }

  @Builder
  SlashCommandPanel() {
    Column({ space: 8 }) {
      Row() {
        Text(this.slashPanelTitle())
          .fontSize(this.scaledFontSize(12))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#17202A'))
        Blank()
        Text(`${this.visibleSlashItems().length}`)
          .fontSize(this.scaledFontSize(11))
          .fontColor(this.themeColor('#8A95A3'))
          .margin({ right: 8 })
        Button() {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(12)
            .fontColor([this.themeColor('#68717D')])
        }
          .width(24)
          .height(24)
          .backgroundColor(this.themeColor('#F0F2F5'))
          .borderRadius(12)
          .onClick(() => {
            this.slashCommandPanelVisible = false;
            this.log('info', 'ui.slash_command.close', `sessionId=${this.selectedSession?.id ?? ''}`);
          })
      }
      .width('100%')

      Scroll() {
        Column({ space: 6 }) {
          if (this.visibleSlashItems().length === 0) {
            Column({ space: 4 }) {
              Text('没有匹配项')
                .fontSize(this.scaledFontSize(12))
                .fontWeight(FontWeight.Medium)
                .fontColor(this.themeColor('#17202A'))
              Text('换个关键词试试，例如 /brt 或 $brt')
                .fontSize(this.scaledFontSize(10))
                .fontColor(this.themeColor('#68717D'))
            }
            .width('100%')
            .height(72)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .backgroundColor(this.themeColor('#F7F8FA'))
            .borderRadius(8)
          } else {
            ForEach(this.visibleSlashItems(), (item: SlashIndexItem) => {
              Row({ space: 8 }) {
                Text(item.insertText)
                  .fontSize(this.scaledFontSize(12))
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.slashItemPrimaryColor(item))
                  .width(92)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Column({ space: 2 }) {
                  Text(item.title)
                    .fontSize(this.scaledFontSize(11))
                    .fontWeight(FontWeight.Medium)
                    .fontColor(this.slashItemTitleColor(item))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(item.description)
                    .fontSize(this.scaledFontSize(10))
                    .fontColor(this.slashItemDescriptionColor(item))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                Text(item.type === 'skill' ? '技能' : '命令')
                  .fontSize(this.scaledFontSize(10))
                  .fontColor(this.isActiveSlashItem(item) ? this.theme().textOnAccent : (item.type === 'skill' ? this.themeColor('#9A6700') : this.themeColor('#1F6FEB')))
                  .padding({ left: 5, right: 5, top: 2, bottom: 2 })
                  .backgroundColor(this.isActiveSlashItem(item) ? this.themeColor('#1F6FEB') : (item.type === 'skill' ? this.themeColor('#FFF8E1') : this.themeColor('#E8F0FE')))
                  .borderRadius(6)
              }
              .width('100%')
              .height(42)
              .padding({ left: 8, right: 8 })
              .backgroundColor(this.isActiveSlashItem(item) ? this.themeColor('#E8F0FE') : this.themeColor('#F7F8FA'))
              .border({ width: this.isActiveSlashItem(item) ? 1 : 0, color: this.isActiveSlashItem(item) ? this.themeColor('#1F6FEB') : this.themeColor('#F7F8FA') })
              .borderRadius(8)
              .onClick(() => {
                this.applySlashItem(item);
              })
            }, (item: SlashIndexItem) => item.id)
          }
        }
        .width('100%')
      }
      .height(this.slashPanelListHeight())
      .scrollBar(BarState.Auto)
    }
    .width('100%')
    .padding(10)
    .backgroundColor(this.themeColor('#FFFFFF'))
    .border({ width: 1, color: this.themeColor('#DDE3EA') })
    .borderRadius(12)
    .shadow({ radius: 12, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 4 })
    .margin({ bottom: 2 })
  }

  @Builder
  SessionComposer() {
    Column({ space: 4 }) {
      if (this.shouldShowSlashCommandPanel()) {
        this.SlashCommandPanel()
      }

      if (this.hasActiveComposerToken()) {
        this.ActiveComposerTokenChip()
      }

      this.PendingSessionImageStrip()
      this.PendingSessionFileStrip()

      Column({ space: 4 }) {
        Row({ space: 6 }) {
          TextArea({ text: this.sessionMessage, placeholder: '', controller: this.sessionTextAreaController })
            .height(this.sessionComposerTextAreaHeight())
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#17202A'))
            .backgroundColor(this.themeColor('#FFFFFF'))
            .border({ width: this.hasActiveComposerToken() ? 1 : 0, color: this.hasActiveComposerToken() ? this.themeColor('#1F6FEB') : this.themeColor('#FFFFFF') })
            .borderRadius(8)
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .layoutWeight(1)
            .onFocus(() => {
              this.sessionComposerFocused = true;
              this.scrollSessionToBottom(80);
            })
            .onBlur(() => {
              this.sessionComposerFocused = false;
            })
            .onChange((value: string) => {
              this.sessionMessage = value;
              this.composerActionMenuExpanded = false;
              this.slashCommandPanelVisible = this.shouldOpenSlashCommandPanel(value);
            })

          Stack({ alignContent: Alignment.Bottom }) {
            if (this.composerActionMenuExpanded) {
              Row() {
                this.ComposerActionPopup()
              }
                .translate({ x: 0, y: -234 })
                .zIndex(1)
            }

            Column({ space: 5 }) {
              Button() {
                SymbolGlyph($r('sys.symbol.plus'))
                  .fontSize(16)
                  .fontColor([this.composerActionMenuExpanded ? this.themeColor('#1F6FEB') : this.themeColor('#17202A')])
              }
                .width(32)
                .height(32)
                .backgroundColor(this.composerActionMenuExpanded ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
                .border({ width: 1, color: this.composerActionMenuExpanded ? this.themeColor('#BBD2FF') : this.themeColor('#DDE3EA') })
                .borderRadius(16)
                .enabled(this.canOpenComposerActionMenu())
                .onClick(() => {
                  if (this.shouldIgnoreComposerActionToggle()) {
                    return;
                  }
                  this.composerActionMenuExpanded = !this.composerActionMenuExpanded;
                  if (this.composerActionMenuExpanded) {
                    this.slashCommandPanelVisible = false;
                  }
                  this.log('info', 'ui.composer_action_menu.toggle', `expanded=${this.composerActionMenuExpanded}; sessionId=${this.selectedSession?.id ?? ''}; isNewSession=${this.isNewSessionDraft}`);
                })

              Button() {
                this.SessionPrimaryActionSymbol()
              }
                .width(32)
                .height(32)
                .backgroundColor(this.sessionPrimaryActionColor())
                .borderRadius(16)
                .enabled(this.canUseSessionPrimaryAction())
                .onClick(() => {
                  if (this.shouldUseSessionInterruptAction()) {
                    this.log('info', 'ui.click.session_primary_interrupt', `sessionId=${this.selectedSession?.id ?? ''}; taskId=${this.selectedSessionInterruptTaskId()}`);
                    this.confirmSelectedSessionInterrupt();
                  } else {
                    this.log('info', 'ui.click.session_primary_send', `sessionId=${this.selectedSession?.id ?? ''}; prompt=${this.sessionMessage}; images=${this.pendingSessionImages.length}`);
                    this.slashCommandPanelVisible = false;
                    this.composerActionMenuExpanded = false;
                    void this.sendMessageToSelectedSession();
                  }
                })
            }
            .alignItems(HorizontalAlign.Center)
            .zIndex(2)
          }
          .width(34)
          .height(this.sessionComposerTextAreaHeight())
        }
        .width('100%')
        .alignItems(VerticalAlign.Bottom)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 6, right: 6, top: 4, bottom: 1 })
    .backgroundColor(this.themeColor('#F7F8FA'))
    .borderRadius(8)
    .margin({ bottom: this.sessionComposerBottomMargin() })
    .translate({ y: this.sessionComposerBottomShift() })
  }

  @Builder
  ComposerActionPopup() {
    Column({ space: 6 }) {
      Button() {
        if (this.isCapturingDesktopScreenshot) {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(this.themeColor('#17202A'))
        } else {
          this.DesktopScreenshotButtonIcon()
        }
      }
        .width(32)
        .height(32)
        .backgroundColor(this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.canCaptureDesktopScreenshot())
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          this.log('info', 'ui.click.desktop_screenshot', `sessionId=${this.selectedSession?.id ?? ''}; isNewSession=${this.isNewSessionDraft}; source=plus_menu`);
          void this.captureDesktopScreenshotPreview();
        })

      Button() {
        if (this.isAttachingDesktopScreenshot) {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(this.themeColor('#17202A'))
        } else {
          this.DesktopScreenshotAttachButtonIcon()
        }
      }
        .width(32)
        .height(32)
        .backgroundColor(this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.canAttachDesktopScreenshotDraft())
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          this.log('info', 'ui.click.desktop_screenshot_attach', `sessionId=${this.selectedSession?.id ?? ''}; isNewSession=${this.isNewSessionDraft}; source=plus_menu`);
          void this.attachDesktopScreenshotDraft();
        })

      Button() {
        Text('↻')
          .fontSize(this.scaledFontSize(18))
          .fontColor(this.themeColor('#17202A'))
      }
        .width(32)
        .height(32)
        .backgroundColor(this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.selectedSession !== null && !this.isNewSessionDraft)
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          if (this.selectedSession !== null) {
            this.log('info', 'ui.click.refresh_session', `sessionId=${this.selectedSession.id}; source=plus_menu`);
            void this.loadSessionDetail(this.selectedSession.id);
          }
        })

      Button() {
        Text('/')
          .fontSize(this.scaledFontSize(15))
          .fontWeight(FontWeight.Bold)
          .fontColor(this.slashCommandPanelVisible ? this.theme().textOnAccent : this.themeColor('#17202A'))
      }
        .width(32)
        .height(32)
        .backgroundColor(this.slashCommandPanelVisible ? this.themeColor('#1F6FEB') : this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.slashCommandPanelVisible ? this.themeColor('#1F6FEB') : this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.selectedSession !== null || this.isNewSessionDraft)
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          this.openSlashCommandPanelFromButton();
        })

      Button() {
        if (this.isUploadingImage) {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(this.themeColor('#17202A'))
        } else {
          SymbolGlyph($r('sys.symbol.ohos_photo'))
            .fontSize(15)
            .fontColor([this.themeColor('#17202A')])
        }
      }
        .width(32)
        .height(32)
        .backgroundColor(this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.canPickSessionImage())
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          this.log('info', 'ui.click.pick_image', `sessionId=${this.selectedSession?.id ?? ''}; isNewSession=${this.isNewSessionDraft}; source=plus_menu`);
          void this.pickSessionImageDraft();
        })

      Button() {
        if (this.isPickingFile) {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(this.themeColor('#17202A'))
        } else {
          Text('文')
            .fontSize(this.scaledFontSize(12))
            .fontWeight(FontWeight.Bold)
            .fontColor(this.themeColor('#17202A'))
        }
      }
        .width(32)
        .height(32)
        .backgroundColor(this.themeColor('#FFFFFF'))
        .border({ width: 1, color: this.themeColor('#DDE3EA') })
        .borderRadius(16)
        .shadow({ radius: 8, color: this.themeColor('#1F232820'), offsetX: 0, offsetY: 2 })
        .enabled(this.canPickSessionFile())
        .onClick(() => {
          this.composerActionMenuExpanded = false;
          void this.pickSessionFileDraft();
        })
    }
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  ActiveComposerTokenChip() {
    Row({ space: 6 }) {
      Text('已激活')
        .fontSize(this.scaledFontSize(10))
        .fontColor(this.themeColor('#68717D'))
      Text(this.activeComposerToken())
        .fontSize(this.scaledFontSize(11))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.themeColor('#1F6FEB'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Blank()
    }
    .width('100%')
    .height(24)
    .padding({ left: 8, right: 8 })
    .backgroundColor(this.themeColor('#E8F0FE'))
    .borderRadius(8)
  }

  @Builder
  PendingSessionImageStrip() {
    if (this.pendingSessionImages.length > 0) {
      Row({ space: 8 }) {
        ForEach(this.pendingSessionImages, (image: PendingSessionImage) => {
          Stack({ alignContent: Alignment.TopEnd }) {
            Image(image.uri)
              .width(44)
              .height(44)
              .objectFit(ImageFit.Cover)
              .backgroundColor(this.themeColor('#ECEFF3'))
              .borderRadius(8)
              .onClick(() => {
                this.openImagePreview(image.uri, `pending:${image.id}`);
              })

            Button() {
              SymbolGlyph($r('sys.symbol.xmark'))
                .fontSize(12)
                .fontColor([this.theme().textOnAccent])
            }
              .width(22)
              .height(22)
              .backgroundColor(this.themeColor('#B42318'))
              .borderRadius(11)
              .onClick(() => {
                this.removePendingSessionImage(image.id);
              })
          }
          .width(48)
          .height(48)
        }, (image: PendingSessionImage) => image.id)
      }
      .width('100%')
      .height(50)
    }
  }

  @Builder
  SessionPrimaryActionSymbol() {
    if (this.sessionPrimaryActionMode() === 'interrupt') {
      SymbolGlyph($r('sys.symbol.xmark'))
        .fontSize(18)
        .fontColor([this.theme().textOnAccent])
    } else if (this.sessionPrimaryActionMode() === 'sending' || this.sessionPrimaryActionMode() === 'interrupting') {
      LoadingProgress()
        .width(18)
        .height(18)
        .color(this.theme().textOnAccent)
    } else {
      SymbolGlyph($r('sys.symbol.arrow_up'))
        .fontSize(18)
        .fontColor([this.theme().textOnAccent])
    }
  }

  @Builder
  ImagePreviewOverlay() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#000000')
        .opacity(0.78)
        .onClick(() => {
          this.closeImagePreview('backdrop');
        })

      this.AdaptiveImagePreviewContent(this.previewImageUrl)

      this.AdaptiveImagePreviewRotateButton('image')

      Button() {
        SymbolGlyph($r('sys.symbol.xmark'))
          .fontSize(18)
          .fontColor([this.theme().textOnAccent])
      }
        .width(40)
        .height(40)
        .backgroundColor(this.themeColor('#1F2328'))
        .borderRadius(20)
        .position({ x: this.adaptiveImagePreviewCloseButtonX(), y: 20 })
        .onClick(() => {
          this.closeImagePreview('button');
        })
    }
    .width('100%')
    .height('100%')
    .zIndex(99)
  }

  @Builder
  DesktopScreenshotPreviewOverlay() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#000000')
        .opacity(0.78)
        .onClick(() => {
          this.closeDesktopScreenshotPreview('backdrop');
        })

      this.AdaptiveImagePreviewContent(this.desktopScreenshotPreviewUrl)

      this.AdaptiveImagePreviewRotateButton('desktop_screenshot')

      Button() {
        SymbolGlyph($r('sys.symbol.xmark'))
          .fontSize(16)
          .fontColor([this.themeColor('#1F2328')])
      }
        .width(34)
        .height(34)
        .backgroundColor('rgba(255, 255, 255, 0.72)')
        .borderRadius(17)
        .position({ x: this.adaptiveImagePreviewCloseButtonX(), y: 18 })
        .onClick(() => {
          this.closeDesktopScreenshotPreview('button');
        })
    }
    .width('100%')
    .height('100%')
    .zIndex(100)
  }

  @Builder
  PendingSessionFileStrip() {
    if (this.pendingSessionFiles.length > 0) {
      Column({ space: 5 }) {
        ForEach(this.pendingSessionFiles, (file: PickedMobileFile) => {
          Row({ space: 7 }) {
            Text('文')
              .fontSize(this.scaledFontSize(10))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#1F6FEB'))
              .width(24)
              .height(24)
              .textAlign(TextAlign.Center)
              .backgroundColor(this.themeColor('#EAF2FF'))
              .borderRadius(6)
            Column({ space: 1 }) {
              Text(file.fileName)
                .fontSize(this.scaledFontSize(10))
                .fontColor(this.themeColor('#17202A'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.formatAttachmentBytes(file.bytes))
                .fontSize(this.scaledFontSize(8))
                .fontColor(this.themeColor('#68717D'))
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            Button('移除')
              .height(26)
              .fontSize(this.scaledFontSize(9))
              .fontColor(this.themeColor('#B42318'))
              .backgroundColor(this.themeColor('#FFF4F2'))
              .onClick(() => {
                this.removePendingSessionFile(file.id);
              })
          }
          .width('100%')
          .padding({ left: 7, right: 7, top: 5, bottom: 5 })
          .backgroundColor(this.themeColor('#FFFFFF'))
          .border({ width: 1, color: this.themeColor('#DDE3EA') })
          .borderRadius(7)
        }, (file: PickedMobileFile) => file.id)
      }
      .width('100%')
    }
  }

  @Builder
  UserInputForm() {
    Column({ space: 10 }) {
      Row() {
        Text('需要你回答')
          .fontSize(this.scaledFontSize(13))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#1F6FEB'))
        Blank()
        Text(`${this.pendingUserInput()?.questions.length ?? 0} 个问题`)
          .fontSize(this.scaledFontSize(10))
          .fontColor(this.themeColor('#68717D'))
      }
      .width('100%')

      ForEach(this.pendingUserInput()?.questions ?? [], (question: BridgeUserInputQuestion) => {
        Column({ space: 7 }) {
          if (question.header.length > 0) {
            Text(question.header)
              .fontSize(this.scaledFontSize(10))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#68717D'))
              .width('100%')
          }
          Text(question.question)
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#17202A'))
            .width('100%')

          if (question.options !== null) {
            ForEach(question.options, (option: BridgeUserInputOption) => {
              Button() {
                Row({ space: 8 }) {
                  Text(this.userInputAnswer(question.id) === option.label ? '●' : '○')
                    .fontSize(this.scaledFontSize(11))
                    .fontColor(this.themeColor('#1F6FEB'))
                  Column({ space: 1 }) {
                    Text(option.label)
                      .fontSize(this.scaledFontSize(11))
                      .fontWeight(FontWeight.Medium)
                      .fontColor(this.themeColor('#17202A'))
                      .width('100%')
                    if (option.description.length > 0) {
                      Text(option.description)
                        .fontSize(this.scaledFontSize(9))
                        .fontColor(this.themeColor('#68717D'))
                        .width('100%')
                    }
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                }
                .width('100%')
              }
              .width('100%')
              .height(option.description.length > 0 ? 46 : 36)
              .backgroundColor(this.userInputAnswer(question.id) === option.label ? this.themeColor('#EAF2FF') : this.themeColor('#FFFFFF'))
              .border({ width: 1, color: this.userInputAnswer(question.id) === option.label ? this.themeColor('#8AB4F8') : this.themeColor('#DDE3EA') })
              .borderRadius(7)
              .onClick(() => {
                this.setUserInputAnswer(question.id, option.label);
              })
            }, (option: BridgeUserInputOption) => `${question.id}:${option.label}`)
          }

          if (question.options === null || question.isOther) {
            TextInput({
              text: this.userInputAnswer(question.id),
              placeholder: question.isSecret ? '请输入保密答案' : '请输入答案'
            })
              .height(40)
              .fontSize(this.scaledFontSize(11))
              .type(question.isSecret ? InputType.Password : InputType.Normal)
              .backgroundColor(this.themeColor('#FFFFFF'))
              .border({ width: 1, color: this.themeColor('#DDE3EA') })
              .borderRadius(7)
              .onChange((value: string) => {
                this.setUserInputAnswer(question.id, value);
              })
          }
        }
        .width('100%')
        .padding(9)
        .backgroundColor(this.themeColor('#F9FAFB'))
        .borderRadius(7)
      }, (question: BridgeUserInputQuestion) => question.id)

      Button('提交回答')
        .width('100%')
        .height(38)
        .enabled(this.canAnswerPendingUserInput())
        .backgroundColor(this.canAnswerPendingUserInput() ? this.themeColor('#1F6FEB') : this.themeColor('#8A95A3'))
        .onClick(() => {
          void this.answerPendingUserInput();
        })
    }
    .width('100%')
    .padding(10)
    .backgroundColor(this.themeColor('#F2F7FF'))
    .border({ width: 1, color: this.themeColor('#BBD2FF') })
    .borderRadius(8)
  }

  @Builder
  OutboxPanel() {
    Stack({ alignContent: Alignment.Bottom }) {
      Row()
        .width('100%')
        .height('100%')
        .backgroundColor(this.themeColor('#00000030'))
        .onClick(() => {
          this.outboxPanelVisible = false;
        })

      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Text('发送队列')
              .fontSize(this.scaledFontSize(16))
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeColor('#17202A'))
            Text('每个会话严格按顺序发送；修改只影响尚未提交的消息')
              .fontSize(this.scaledFontSize(9))
              .fontColor(this.themeColor('#68717D'))
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          Button('刷新')
            .height(32)
            .fontSize(this.scaledFontSize(10))
            .enabled(!this.isLoadingOutbox)
            .onClick(() => {
              void this.loadOutbox();
            })
          Button('关闭')
            .height(32)
            .fontSize(this.scaledFontSize(10))
            .onClick(() => {
              this.outboxPanelVisible = false;
            })
        }
        .width('100%')

        if (this.isLoadingOutbox) {
          LoadingProgress()
            .width(28)
            .height(28)
            .color(this.themeColor('#1F6FEB'))
        } else if (this.outboxItems.length === 0) {
          Text('当前没有待发送消息')
            .fontSize(this.scaledFontSize(12))
            .fontColor(this.themeColor('#68717D'))
            .width('100%')
            .padding(16)
            .textAlign(TextAlign.Center)
        } else {
          Scroll() {
            Column({ space: 8 }) {
              ForEach(this.outboxItems, (item: BridgeOutboxItem) => {
                this.OutboxItemCard(item)
              }, (item: BridgeOutboxItem) => item.id)
            }
            .width('100%')
          }
          .width('100%')
          .height(this.isLandscapeSessionLayout() ? 320 : 480)
          .scrollBar(BarState.Auto)
        }
      }
      .width(this.isLandscapeSessionLayout() ? '72%' : '100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 22 })
      .backgroundColor(this.themeColor('#FFFFFF'))
      .borderRadius({ topLeft: 18, topRight: 18 })
      .shadow({ radius: 18, color: this.themeColor('#1F232824'), offsetX: 0, offsetY: -4 })
    }
    .width('100%')
    .height('100%')
    .zIndex(90)
  }

  @Builder
  OutboxItemCard(item: BridgeOutboxItem) {
    Column({ space: 7 }) {
      Row({ space: 7 }) {
        Text(this.outboxStatusLabel(item.status))
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#1F6FEB'))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(this.themeColor('#EAF2FF'))
          .borderRadius(5)
        Text(item.threadId.length > 0 ? this.shortSessionId(item.threadId) : '新会话')
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#68717D'))
        Blank()
        Text(`尝试 ${item.attemptCount}`)
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#68717D'))
      }
      .width('100%')

      TextArea({ text: this.outboxDraft(item), placeholder: '待发送消息' })
        .width('100%')
        .height(72)
        .fontSize(this.scaledFontSize(11))
        .backgroundColor(this.themeColor('#F7F8FA'))
        .borderRadius(7)
        .enabled(item.status === 'queued' || item.status === 'failed')
        .onChange((value: string) => {
          this.setOutboxDraft(item.id, value);
        })

      if (item.error.length > 0) {
        Text(item.error)
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#B42318'))
          .width('100%')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      Row({ space: 6 }) {
        Button('保存')
          .height(30)
          .fontSize(this.scaledFontSize(9))
          .enabled(this.outboxDraft(item).trim().length > 0 && this.outboxDraft(item) !== item.text)
          .onClick(() => {
            void this.saveOutboxItem(item);
          })
        Button('上移')
          .height(30)
          .fontSize(this.scaledFontSize(9))
          .onClick(() => {
            void this.moveOutboxItem(item, 'up');
          })
        Button('下移')
          .height(30)
          .fontSize(this.scaledFontSize(9))
          .onClick(() => {
            void this.moveOutboxItem(item, 'down');
          })
        if (item.status === 'failed' || item.status === 'uncertain') {
          Button('重试')
            .height(30)
            .fontSize(this.scaledFontSize(9))
            .onClick(() => {
              void this.retryOutboxItem(item);
            })
        }
        Button('取消')
          .height(30)
          .fontSize(this.scaledFontSize(9))
          .fontColor(this.themeColor('#B42318'))
          .onClick(() => {
            void this.cancelOutboxItem(item);
          })
      }
      .width('100%')
    }
    .width('100%')
    .padding(10)
    .backgroundColor(this.themeColor('#FFFFFF'))
    .border({ width: 1, color: this.themeColor('#DDE3EA') })
    .borderRadius(9)
  }

  @Builder
  AdaptiveImagePreviewContent(imageUrl: string) {
    Stack({ alignContent: Alignment.Center }) {
      Image(imageUrl)
        .width('100%')
        .height('100%')
        .objectFit(ImageFit.Contain)
        .backgroundColor(this.themeColor('#111111'))
        .borderRadius(8)
        .scale({ x: this.desktopScreenshotScale, y: this.desktopScreenshotScale })
        .translate({ x: this.desktopScreenshotOffsetX, y: this.desktopScreenshotOffsetY })
        .rotate({ angle: this.desktopScreenshotRotation })
    }
    .width(this.adaptiveImagePreviewWidth())
    .height(this.adaptiveImagePreviewHeight())
    .clip(true)
    .onAreaChange(() => {
      this.handleAdaptiveImagePreviewAreaChange();
    })
    .gesture(
      GestureGroup(GestureMode.Parallel,
        PinchGesture()
          .onActionStart(() => {
            this.desktopScreenshotGestureStartScale = this.desktopScreenshotScale;
          })
          .onActionUpdate((event: GestureEvent) => {
            this.setDesktopScreenshotScale(this.desktopScreenshotGestureStartScale * event.scale);
          }),
        PanGesture()
          .onActionStart(() => {
            this.desktopScreenshotGestureStartOffsetX = this.desktopScreenshotOffsetX;
            this.desktopScreenshotGestureStartOffsetY = this.desktopScreenshotOffsetY;
          })
          .onActionUpdate((event: GestureEvent) => {
            this.desktopScreenshotOffsetX = this.desktopScreenshotGestureStartOffsetX + event.offsetX;
            this.desktopScreenshotOffsetY = this.desktopScreenshotGestureStartOffsetY + event.offsetY;
          })
      )
    )
    .gesture(
      TapGesture({ count: 2 })
        .onAction(() => {
          this.resetDesktopScreenshotPreviewTransform();
          this.log('info', 'image.preview.reset', 'source=double_tap');
        })
    )
  }

  @Builder
  AdaptiveImagePreviewRotateButton(source: string) {
    Button() {
      Text('↻')
        .fontSize(this.scaledFontSize(18))
        .fontWeight(FontWeight.Bold)
        .fontColor(this.theme().textOnAccent)
    }
    .width(36)
    .height(36)
    .backgroundColor(this.themeColor('#1F2328'))
    .borderRadius(18)
    .position({ x: this.adaptiveImagePreviewRotateButtonX(), y: 20 })
    .onClick(() => {
      this.rotateDesktopScreenshot(90);
      this.log('info', 'image.preview.manual_rotate', `source=${source}; rotation=${this.desktopScreenshotRotation}`);
    })
  }

  @Builder
  TaskPanel() {
    Column({ space: 10 }) {
      Row() {
        Text('任务')
          .fontSize(this.scaledFontSize(15))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.themeColor('#17202A'))
        Blank()
        Text(this.selectedProjectId)
          .fontSize(this.scaledFontSize(12))
          .fontColor(this.themeColor('#68717D'))
      }

      if (this.projects.length > 0) {
        ForEach(this.projects, (project: BridgeProject) => {
          Row() {
            Text(project.name)
              .fontSize(this.scaledFontSize(14))
              .fontColor(project.id === this.selectedProjectId ? this.theme().textOnAccent : this.themeColor('#17202A'))
            Blank()
            Text(project.id)
              .fontSize(this.scaledFontSize(12))
              .fontColor(project.id === this.selectedProjectId ? this.themeColor('#DDEBFF') : this.themeColor('#68717D'))
          }
          .width('100%')
          .padding(10)
          .backgroundColor(project.id === this.selectedProjectId ? this.themeColor('#1F6FEB') : this.themeColor('#F0F2F5'))
          .borderRadius(6)
          .onClick(() => {
            this.selectedProjectId = project.id;
          })
        }, (project: BridgeProject) => project.id)
      }

      TextArea({ text: this.prompt, placeholder: '请输入要交给 Codex 的代码任务' })
        .height(108)
        .fontSize(this.scaledFontSize(14))
        .backgroundColor(this.themeColor('#FFFFFF'))
        .borderRadius(6)
        .onChange((value: string) => {
          this.prompt = value;
        })

      Button('创建任务')
        .height(44)
        .width('100%')
        .enabled(this.canCreateTask())
        .onClick(() => {
          this.log('info', 'ui.click.create_task', `projectId=${this.selectedProjectId}; prompt=${this.prompt}`);
          void this.createTask();
        })
    }
    .cardStyle(this.theme().surface)
  }

  @Builder
  StatusPanel() {
    Column({ space: 10 }) {
      Text('状态')
        .fontSize(this.scaledFontSize(15))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.themeColor('#17202A'))

      Text(this.message)
        .fontSize(this.scaledFontSize(13))
        .fontColor(this.themeColor('#68717D'))
        .width('100%')

      if (this.currentTask !== null) {
        Text(`任务：${this.currentTask.id}`)
          .fontSize(this.scaledFontSize(12))
          .fontColor(this.themeColor('#68717D'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (this.pendingApprovalId().length > 0) {
          Column({ space: 8 }) {
            Text('需要确认')
              .fontSize(this.scaledFontSize(14))
              .fontWeight(FontWeight.Medium)
              .fontColor(this.themeColor('#B42318'))

            Text(this.pendingApprovalSummary())
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#68717D'))

            Row({ space: 10 }) {
              Button('同意')
                .height(38)
                .layoutWeight(1)
                .backgroundColor(this.themeColor('#137333'))
                .onClick(() => {
                  this.log('info', 'ui.click.approval', `approvalId=${this.pendingApprovalId()}; decision=approved`);
                  void this.decideApproval(this.pendingApprovalId(), 'approved');
                })
              Button('拒绝')
                .height(38)
                .layoutWeight(1)
                .backgroundColor(this.themeColor('#B42318'))
                .onClick(() => {
                  this.log('info', 'ui.click.approval', `approvalId=${this.pendingApprovalId()}; decision=denied`);
                  void this.decideApproval(this.pendingApprovalId(), 'denied');
                })
            }
          }
          .width('100%')
          .padding(12)
          .backgroundColor(this.themeColor('#FFF4F2'))
          .borderRadius(6)
        }
      }
    }
    .cardStyle(this.theme().surface)
  }

  @Builder
  EventPanel() {
    Column({ space: 8 }) {
      Text('事件')
        .fontSize(this.scaledFontSize(15))
        .fontWeight(FontWeight.Medium)
        .fontColor(this.themeColor('#17202A'))

      if (this.currentTask === null || this.currentTask.events.length === 0) {
        Text('暂无任务事件')
          .fontSize(this.scaledFontSize(13))
          .fontColor(this.themeColor('#68717D'))
      } else {
        ForEach(this.visibleEvents(), (event: BridgeEvent) => {
          Column({ space: 3 }) {
            Text(this.eventLabel(event.type))
              .fontSize(this.scaledFontSize(13))
              .fontWeight(FontWeight.Medium)
              .fontColor(this.themeColor('#17202A'))
            Text(this.eventSummary(event))
              .fontSize(this.scaledFontSize(12))
              .fontColor(this.themeColor('#68717D'))
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
          .backgroundColor(this.themeColor('#F7F8FA'))
          .borderRadius(6)
        }, (event: BridgeEvent) => event.id)
      }
    }
    .layoutWeight(1)
    .cardStyle(this.theme().surface)
  }

  private async loadProjects(): Promise<void> {
    await this.guard('loadProjects', async () => {
      const now = Date.now();
      this.projects = await BridgeClient.listProjects(this.normalizedBridgeUrl(), this.bridgeToken);
      this.lastProjectsRefreshAt = now;
      if (this.projects.length > 0) {
        this.selectedProjectId = this.projects[0].id;
      }
      this.tasks = await BridgeClient.listTasks(this.normalizedBridgeUrl(), this.bridgeToken);
      this.lastTasksRefreshAt = now;
      this.applyLatestSessions(await this.loadCanonicalSessionSummaries('loadProjects'), 'loadProjects');
      this.lastSessionsRefreshAt = now;
      await this.refreshSlashIndex();
      this.message = `已加载 ${this.projects.length} 个项目`;
      this.log('info', 'projects.loaded', `count=${this.projects.length}; selectedProjectId=${this.selectedProjectId}`);
    });
  }

  private async refreshSlashIndex(): Promise<void> {
    try {
      this.slashIndexItems = await BridgeClient.getSlashIndex(this.normalizedBridgeUrl(), this.bridgeToken);
      this.slashIndexLoadedAt = new Date().toISOString();
      this.log('info', 'slash.index.loaded', `count=${this.slashIndexItems.length}`);
    } catch (error) {
      this.slashIndexItems = this.defaultSlashIndexItems();
      this.log('warn', 'slash.index.failed', `message=${this.errorText(error)}; fallback=${this.slashIndexItems.length}`);
    }
  }

  private async createTask(): Promise<void> {
    if (!this.canCreateTask()) {
      this.message = '当前任务仍在运行，请完成后再创建新任务';
      this.log('info', 'task.create.blocked', `reason=task_active; currentTaskId=${this.currentTask?.id ?? ''}`);
      return;
    }
    await this.guard('createTask', async () => {
      this.currentTask = await BridgeClient.createTask(
        this.normalizedBridgeUrl(),
        this.selectedProjectId,
        this.rawPrompt(),
        this.bridgeToken,
        '',
        null,
        this.sessionReasoningEffort,
        this.sessionModel
      );
      this.lastDesktopSyncWarningTaskId = '';
      this.message = '任务已创建';
      this.showTaskEventDetails = false;
      this.log('info', 'task.created.client', `taskId=${this.currentTask.id}; status=${this.currentTask.status}; projectId=${this.currentTask.projectId}`);
      this.startPolling();
    });
  }

  private async createTaskFromSelectedSession(): Promise<void> {
    if (this.selectedSession === null) {
      this.message = '请先选择一个 Codex 会话';
      this.log('info', 'session.resume.blocked', 'reason=no_session');
      return;
    }
    if (!this.canCreateTask()) {
      this.message = '当前任务仍在运行，请完成后再继续会话';
      this.log('info', 'session.resume.blocked', `reason=task_active; currentTaskId=${this.currentTask?.id ?? ''}`);
      return;
    }
    await this.guard('resumeSession', async () => {
      this.currentTask = await BridgeClient.createTask(
        this.normalizedBridgeUrl(),
        this.selectedProjectId,
        this.rawPrompt(),
        this.bridgeToken,
        this.selectedSession?.id ?? '',
        this.selectedSessionFingerprint(),
        this.sessionReasoningEffort,
        this.sessionModel
      );
      this.lastDesktopSyncWarningTaskId = '';
      this.message = `正在继续会话：${this.selectedSession?.title ?? ''}`;
      this.showTaskEventDetails = false;
      this.log('info', 'session.resume.created', `taskId=${this.currentTask.id}; sessionId=${this.selectedSession?.id ?? ''}; status=${this.currentTask.status}`);
      this.scrollSessionToBottom(80);
      this.startPolling();
    });
  }

  private async sendMessageToSelectedSession(retryFailedMessageId: string = ''): Promise<boolean> {
    if (this.tryRunSlashCommandFromComposer()) {
      return true;
    }
    if (this.isNewSessionDraft) {
      return await this.sendNewSessionMessage(retryFailedMessageId);
    }
    if (this.selectedSession === null) {
      this.message = '请先选择一个 Codex 会话';
      this.log('info', 'session.send.blocked', 'reason=no_session');
      return false;
    }
    if (this.selectedSession.detailAvailable === false) {
      this.message = '这个会话缺少本地历史文件，不能继续发送。请换一个可查看会话，或新建会话。';
      this.log('warn', 'session.send.blocked', `reason=missing_session_file; sessionId=${this.selectedSession.id}`);
      return false;
    }
    const navigation = this.readSessionNavigation();
    if (navigation.mode !== 'session' || navigation.sessionId !== this.selectedSession.id) {
      this.message = '会话导航状态已变化，已阻止发送。请重新打开目标会话后再试。';
      this.log('error', 'session.send.blocked', `reason=navigation_target_mismatch; selectedSessionId=${this.selectedSession.id}; navigationMode=${navigation.mode}; navigationSessionId=${navigation.sessionId}; navigationRevision=${navigation.revision}`);
      return false;
    }
    if (!this.canSendSessionMessage()) {
      this.message = '当前任务仍在运行，完成后才能继续发送';
      this.log('info', 'session.send.blocked', `reason=task_active_or_empty; currentTaskId=${this.currentTask?.id ?? ''}`);
      return false;
    }
    const targetSessionId = this.selectedSession.id;
    const targetSessionTitle = this.selectedSession.title;
    const targetProjectLabel = this.selectedSession.projectLabel ?? '未归类';
    const outgoing = this.sessionMessage.trim();
    const draftImages = this.pendingSessionImages.slice();
    const draftFiles = this.pendingSessionFiles.slice();
    const guidanceSend = this.hasRunningTaskForSession(targetSessionId);
    let targetFingerprint: CodexSessionFingerprint | null = this.selectedSessionFingerprint();
    const submissionId = this.submissionIdForRetry(retryFailedMessageId);
    let sent = false;
    this.isSendingSessionMessage = true;
    this.sendingSessionTargetId = targetSessionId;
    this.beginOptimisticSessionSend(
      targetSessionId,
      false,
      this.selectedProjectId,
      submissionId,
      outgoing,
      draftImages,
      retryFailedMessageId
    );
    try {
      await this.guard('sendSessionMessage', async () => {
        if (this.selectedSession === null || this.selectedSession.id !== targetSessionId) {
          this.message = '会话目标已变化，已阻止发送。请重新确认当前会话。';
          this.log('warn', 'session.send.blocked', `reason=session_changed; targetSessionId=${targetSessionId}; currentSessionId=${this.selectedSession?.id ?? ''}`);
          return;
        }
        this.message = guidanceSend
          ? `正在追加引导：${targetProjectLabel} / ${targetSessionTitle}`
          : `正在发送到 Codex 官方会话：${targetProjectLabel} / ${targetSessionTitle}`;
        if (targetFingerprint === null || targetFingerprint.filePath.length === 0) {
          const refreshed = await BridgeClient.getSession(this.normalizedBridgeUrl(), targetSessionId, this.bridgeToken);
          if (this.selectedSession === null || this.selectedSession.id !== targetSessionId) {
            this.message = '会话目标已变化，已阻止发送。请重新确认当前会话。';
            this.log('warn', 'session.send.blocked', `reason=session_changed_after_fingerprint_refresh; targetSessionId=${targetSessionId}; currentSessionId=${this.selectedSession?.id ?? ''}`);
            return;
          }
          this.selectedSession = refreshed;
          targetFingerprint = this.sessionFingerprintFromDetail(refreshed);
          this.log('info', 'session.fingerprint.refreshed', `sessionId=${targetSessionId}; filePath=${targetFingerprint.filePath}; entryCount=${targetFingerprint.entryCount}`);
        }
        if (targetFingerprint === null || targetFingerprint.filePath.length === 0) {
          this.message = '当前会话缺少本地文件指纹，已阻止发送。请重新打开会话后再试。';
          this.log('error', 'session.send.blocked', `reason=missing_fingerprint; sessionId=${targetSessionId}`);
          return;
        }
        const requiresDesktopLive = await this.requiresDesktopLiveForSend(targetSessionId, 'send_session');
        if (requiresDesktopLive) {
          const desktopReady = await this.ensureDesktopLiveReadyForSend(targetSessionId, 'send_session');
          if (!desktopReady) {
            this.log('warn', 'session.send.blocked', `reason=desktop_live_not_ready_after_mobile_repair; sessionId=${targetSessionId}; state=${this.desktopLiveState}; verified=${this.desktopLiveSessionVerified}`);
            return;
          }
        }
        const composed = await this.composeOutgoingSessionMessage(outgoing, draftImages, draftFiles);
        const messageText = composed.text;
        this.clearLocalRunningOverride(targetSessionId);
        this.currentTask = await BridgeClient.sendCodexThreadMessage(
          this.normalizedBridgeUrl(),
          targetSessionId,
          messageText,
          this.selectedProjectId,
          this.bridgeToken,
          targetFingerprint,
          this.sessionReasoningEffort,
          this.sessionModel,
          submissionId
        );
        this.completeOptimisticSessionSend(submissionId);
        this.applyTaskExecutionContract(this.currentTask, targetSessionId, 'send_session_created');
        sent = true;
        this.lastDesktopSyncWarningTaskId = '';
        this.activeSessionTaskId = this.currentTask.id;
        this.activeSessionTaskTitle = targetSessionTitle;
        this.rememberPendingSessionSend(this.currentTask.id, {
          sessionId: targetSessionId,
          isNewSession: false,
          projectId: this.selectedProjectId,
          submissionId,
          text: outgoing,
          images: draftImages,
          files: draftFiles,
          retryFailedMessageId
        });
        this.rememberTaskForSession(targetSessionId, this.currentTask.id, this.currentTask.status);
        this.markSessionRunning(targetSessionId);
        this.message = this.currentTask.runtime?.kind === 'durable_outbox'
          ? '消息已排队，将在当前回合结束后按顺序自动发送'
          : guidanceSend
            ? `引导已提交，正在确认 Codex 接收`
            : `消息已提交，正在确认 Codex 接收`;
        this.sessionMessage = '';
        this.restoreUnsentSessionAttachments(composed.failedImages, composed.failedFiles);
        if (composed.failedImages.length > 0 || composed.failedFiles.length > 0) {
          this.message = `文字已发送，${composed.failedImages.length} 张图片、${composed.failedFiles.length} 个文件上传失败，附件已保留`;
        }
        this.dismissSessionKeyboardAfterSend('send_session');
        this.showTaskEventDetails = false;
        this.log('info', 'session.message.sent', `taskId=${this.currentTask.id}; sessionId=${targetSessionId}; project=${targetProjectLabel}; title=${targetSessionTitle}; status=${this.currentTask.status}; mode=${guidanceSend ? 'guidance_send' : 'send'}; model=${this.sessionModel || 'auto'}; effort=${this.sessionReasoningEffort || 'auto'}; uploadedImages=${composed.uploadedImages.length}; failedImages=${composed.failedImages.length}`);
        this.scrollSessionToBottom(80);
        this.startPolling();
      });
      if (sent) {
        if (retryFailedMessageId.length > 0) {
          this.updateFailedSessionMessage(retryFailedMessageId, true, '消息已重新提交，等待 Codex 确认');
        }
        return true;
      }
      if (!sent) {
        this.completeOptimisticSessionSend(submissionId);
        this.rememberFailedSessionMessageAfterSendFailure({
          failedId: retryFailedMessageId,
          sessionId: targetSessionId,
          isNewSession: false,
          projectId: this.selectedProjectId,
          submissionId,
          text: outgoing,
          images: draftImages,
          files: draftFiles,
          error: this.message
        });
      }
      return false;
    } finally {
      this.isSendingSessionMessage = false;
      this.sendingSessionTargetId = '';
    }
  }

  private async sendNewSessionMessage(retryFailedMessageId: string = ''): Promise<boolean> {
    if (this.tryRunSlashCommandFromComposer()) {
      return true;
    }
    if (!this.canSendSessionMessage()) {
      this.message = '请输入新会话的第一条消息';
      this.log('info', 'session.new.blocked', `reason=empty_or_task_active; currentTaskId=${this.currentTask?.id ?? ''}`);
      return false;
    }
    const outgoing = this.sessionMessage.trim();
    const draftImages = this.pendingSessionImages.slice();
    const draftFiles = this.pendingSessionFiles.slice();
    const submissionId = this.submissionIdForRetry(retryFailedMessageId);
    let sent = false;
    this.isSendingSessionMessage = true;
    this.sendingSessionTargetId = '__new_session__';
    this.beginOptimisticSessionSend(
      '__new_session__',
      true,
      this.selectedProjectId,
      submissionId,
      outgoing,
      draftImages,
      retryFailedMessageId
    );
    try {
      const guardOk = await this.guard('sendNewSessionMessage', async () => {
        this.message = '正在创建 Codex 官方会话';
        const composed = await this.composeOutgoingSessionMessage(outgoing, draftImages, draftFiles);
        const messageText = composed.text;
        this.currentTask = await BridgeClient.startCodexThread(
          this.normalizedBridgeUrl(),
          this.selectedProjectId,
          messageText,
          this.bridgeToken,
          this.sessionReasoningEffort,
          this.sessionModel,
          submissionId
        );
        this.completeOptimisticSessionSend(submissionId);
        sent = true;
        this.lastDesktopSyncWarningTaskId = '';
        this.rememberPendingSessionSend(this.currentTask.id, {
          sessionId: '__new_session__',
          isNewSession: true,
          projectId: this.selectedProjectId,
          submissionId,
          text: outgoing,
          images: draftImages,
          files: draftFiles,
          retryFailedMessageId
        });
        this.message = '新会话已发送，正在唤醒 Codex';
        this.sessionMessage = '';
        this.restoreUnsentSessionAttachments(composed.failedImages, composed.failedFiles);
        if (composed.failedImages.length > 0 || composed.failedFiles.length > 0) {
          this.message = `新会话文字已发送，${composed.failedImages.length} 张图片、${composed.failedFiles.length} 个文件上传失败，附件已保留`;
        }
        this.dismissSessionKeyboardAfterSend('send_new_session');
        this.newSessionTaskId = this.currentTask.id;
        this.activeSessionTaskId = this.currentTask.id;
        this.activeSessionTaskTitle = '新建会话';
        this.syncSessionTaskMarkers(this.currentTask);
        this.showTaskEventDetails = false;
        this.log('info', 'session.new.sent', `taskId=${this.currentTask.id}; status=${this.currentTask.status}; model=${this.sessionModel || 'auto'}; effort=${this.sessionReasoningEffort || 'auto'}; uploadedImages=${composed.uploadedImages.length}; failedImages=${composed.failedImages.length}`);
        this.scrollSessionToBottom(80);
        this.startPolling();
      });
      if (sent) {
        if (retryFailedMessageId.length > 0) {
          this.updateFailedSessionMessage(retryFailedMessageId, true, '消息已重新提交，等待 Codex 确认');
        }
        return true;
      }
      if (!guardOk) {
        this.completeOptimisticSessionSend(submissionId);
        this.rememberFailedSessionMessageAfterSendFailure({
          failedId: retryFailedMessageId,
          sessionId: '__new_session__',
          isNewSession: true,
          projectId: this.selectedProjectId,
          submissionId,
          text: outgoing,
          images: draftImages,
          files: draftFiles,
          error: this.message
        });
      }
      return false;
    } finally {
      this.isSendingSessionMessage = false;
      this.sendingSessionTargetId = '';
    }
  }

  private async refreshTask(): Promise<void> {
    if (this.currentTask === null) {
      return;
    }
    const activeTask = this.currentTask;
    const activeTaskId = activeTask.id;
    const activeSessionId = this.taskSessionId(activeTask);
    const afterSeq = this.currentTaskEventCursor(activeTask);
    let task: BridgeTask;
    try {
      task = this.taskUsesCodexRunApi(activeTask)
        ? await BridgeClient.getCodexRun(this.normalizedBridgeUrl(), activeTaskId, this.bridgeToken, afterSeq)
        : await BridgeClient.getTask(this.normalizedBridgeUrl(), activeTaskId, this.bridgeToken, afterSeq);
    } catch (error) {
      if (this.errorText(error).indexOf('Unknown task') >= 0 || this.errorText(error).indexOf('HTTP 404') >= 0) {
        if (this.currentTask === null || this.currentTask.id !== activeTaskId) {
          this.log('info', 'task.refresh.missing_ignored', `taskId=${activeTaskId}; sessionId=${activeSessionId}; reason=stale_request`);
          return;
        }
        if (activeSessionId.length > 0) {
          this.markSessionRunningLocallyCleared(activeSessionId);
        }
        this.currentTask = null;
        this.activeSessionTaskId = '';
        this.activeSessionTaskTitle = '';
        this.stopPolling();
        this.message = '运行状态已随桥接重启重置，正在重新同步会话';
        this.log('warn', 'task.refresh.missing_cleared', `taskId=${activeTaskId}; sessionId=${activeSessionId}`);
        await this.refreshAfterMissingTask(activeSessionId, activeTaskId);
        return;
      }
      throw new Error(this.errorText(error));
    }
    if (this.currentTask === null || this.currentTask.id !== activeTaskId) {
      this.log('info', 'task.refresh.result_ignored', `taskId=${activeTaskId}; sessionId=${activeSessionId}; reason=stale_request`);
      return;
    }
    this.handoffPendingSessionSend(activeTaskId, task);
    task = this.mergeTaskEventPage(activeTask, task);
    if (task.eventGap === true) {
      this.log('warn', 'task.event_cursor.gap', `taskId=${activeTaskId}; sessionId=${activeSessionId}; afterSeq=${afterSeq}; nextSeq=${task.eventCursor ?? 0}`);
      if (activeSessionId.length > 0 && this.selectedSession?.id === activeSessionId) {
        await this.loadSessionDetail(activeSessionId);
      }
    }
    const previousStatus = this.currentTask.status;
    const previousEventCount = this.currentTaskEventCount(this.currentTask);
    this.currentTask = task;
    this.applyTaskExecutionContract(task, activeSessionId, 'task_refresh');
    this.syncSessionTaskMarkers(task);
    this.message = `任务${this.statusLabel(task.status)}：${this.currentTaskSummaryText()}`;
    const nextEventCount = this.currentTaskEventCount(task);
    const taskChanged = previousStatus !== task.status || nextEventCount !== previousEventCount;
    this.updateTaskPollCadence(taskChanged, task.status, nextEventCount);
    if (task.hasMoreEvents === true) {
      this.taskPollDelayMs = 50;
    }
    if (nextEventCount !== previousEventCount) {
      this.scrollSessionToBottomIfFollowing(30, 'task_events');
    }
    if (task.desktopSync && !this.taskUsesAppServer(task) && task.desktopSync.desktopLive === false && this.lastDesktopSyncWarningTaskId !== task.id) {
      this.lastDesktopSyncWarningTaskId = task.id;
      this.log('warn', 'desktop.sync.file_only', `taskId=${task.id}; status=${task.desktopSync.status}; message=${task.desktopSync.message ?? ''}`);
    }
    if (previousStatus !== task.status) {
      this.log('info', 'task.status.changed', `taskId=${task.id}; previousStatus=${previousStatus}; status=${task.status}; eventCount=${nextEventCount}`);
      void this.publishTaskAttentionNotification(task, previousStatus);
    }
    if (this.isTaskTerminalStatus(task.status)) {
      this.markSessionRunningLocallyCleared(this.taskSessionId(task));
      void this.handleTaskTerminalForSession(task, previousStatus, 'refreshTask');
      this.stopPolling();
      const appliedLiveSession = this.applyTaskSessionSnapshot(task);
      if (previousStatus !== task.status && this.isNewSessionDraft && task.createdCodexSessionId && task.createdCodexSessionId.length > 0) {
        this.log('info', 'session.new.created.open', `taskId=${task.id}; sessionId=${task.createdCodexSessionId}; status=${task.status}`);
        this.isNewSessionDraft = false;
        this.newSessionTaskId = '';
        this.activeSessionTaskId = '';
        this.activeSessionTaskTitle = '';
        await this.refreshSessions();
        if (!appliedLiveSession) {
          await this.loadSessionDetail(task.createdCodexSessionId);
        }
        return;
      }
      if (previousStatus !== task.status && task.codexSessionId && this.selectedSession !== null && task.codexSessionId === this.selectedSession.id) {
        this.log('info', 'session.task.finished.refresh', `taskId=${task.id}; sessionId=${this.selectedSession.id}; status=${task.status}`);
        if (!appliedLiveSession) {
          await this.loadSessionDetail(this.selectedSession.id);
        }
      }
    }
  }

  private applyTaskSessionSnapshot(task: BridgeTask): boolean {
    if (!task.session || !Array.isArray(task.session.entries) || task.session.entries.length === 0) {
      return false;
    }
    if (this.isNewSessionDraft) {
      this.selectedSession = task.session;
      this.isNewSessionDraft = false;
      this.newSessionTaskId = '';
      this.activeSessionTaskId = '';
      this.activeSessionTaskTitle = '';
      this.expandedSessionEntries = [];
      this.markSessionRead(task.session.id);
      this.message = `已进入新会话：${task.session.title}`;
      this.log('info', 'session.live_snapshot.applied', `taskId=${task.id}; sessionId=${task.session.id}; entries=${task.session.entryCount}; mode=new`);
      this.scrollSessionToBottomIfFollowing(80, 'live_snapshot_new');
      return true;
    }
    if (this.selectedSession !== null && task.codexSessionId === this.selectedSession.id) {
      this.selectedSession = task.session;
      this.markSessionRead(task.session.id);
      this.message = `已同步会话：${task.session.title}`;
      this.log('info', 'session.live_snapshot.applied', `taskId=${task.id}; sessionId=${task.session.id}; entries=${task.session.entryCount}; mode=resume`);
      this.scrollSessionToBottomIfFollowing(80, 'live_snapshot_resume');
      return true;
    }
    return false;
  }

  private async decideApproval(approvalId: string, decision: string): Promise<void> {
    await this.guard('decideApproval', async () => {
      await BridgeClient.decideApproval(this.normalizedBridgeUrl(), approvalId, decision, this.bridgeToken);
      this.message = `确认结果：${this.decisionLabel(decision)}`;
      this.log('info', 'approval.decided.client', `approvalId=${approvalId}; decision=${decision}`);
      await this.refreshTask();
      this.startPolling();
    });
  }

  private async interruptCurrentTask(): Promise<void> {
    if (!this.canInterruptCurrentTask() || this.currentTask === null) {
      this.message = '当前没有可中断的会话任务';
      this.log('info', 'task.interrupt.blocked', `taskId=${this.currentTask?.id ?? ''}; status=${this.currentTask?.status ?? 'idle'}`);
      return;
    }
    const taskId = this.currentTask.id;
    this.isInterruptingTask = true;
    try {
      await this.guard('interruptTask', async () => {
        this.message = '正在中断当前会话';
        const interrupted = this.currentTask !== null && this.taskUsesCodexRunApi(this.currentTask)
          ? await BridgeClient.interruptCodexRun(this.normalizedBridgeUrl(), taskId, this.bridgeToken)
          : await BridgeClient.interruptTask(this.normalizedBridgeUrl(), taskId, this.bridgeToken);
        this.currentTask = interrupted;
        this.syncSessionTaskMarkers(interrupted);
        if (this.isTaskTerminalStatus(interrupted.status)) {
          this.stopPolling();
        } else {
          this.startPolling();
        }
        this.message = this.interruptResultMessage(interrupted);
        this.log('info', 'task.interrupted.client', `taskId=${interrupted.id}; status=${interrupted.status}`);
        this.scrollSessionToBottom(40);
        if (this.selectedSession !== null && interrupted.codexSessionId === this.selectedSession.id) {
          await this.refreshSelectedSessionDetail();
        }
      });
    } finally {
      this.isInterruptingTask = false;
    }
  }

  private async interruptSelectedSessionTask(): Promise<void> {
    if (!this.canInterruptSelectedSessionTask()) {
      this.message = '当前会话没有可中断的桥接任务，正在刷新状态';
      this.log('info', 'session.interrupt.blocked', `sessionId=${this.selectedSession?.id ?? ''}; taskId=${this.selectedSessionInterruptTaskId()}`);
      await this.refreshRunningSelectedSessionStatus();
      return;
    }
    const targetSessionId = this.selectedSession?.id ?? '';
    const taskId = this.selectedSessionInterruptTaskId();
    if (taskId.length === 0 && !this.isSelectedSessionActivityRunning()) {
      this.message = '当前会话还没有进入可中断阶段，正在刷新状态';
      this.log('info', 'session.interrupt.no_ready_task', `sessionId=${targetSessionId}`);
      await this.refreshRunningSelectedSessionStatus();
      return;
    }
    this.isInterruptingTask = true;
    this.interruptingSessionTargetId = targetSessionId;
    try {
      await this.guard('interruptSelectedSessionTask', async () => {
        this.message = '正在中断当前会话';
        let interrupted: BridgeTask;
        if (this.currentTask !== null && taskId.length > 0 && this.currentTask.id === taskId) {
          interrupted = this.taskUsesCodexRunApi(this.currentTask)
            ? await BridgeClient.interruptCodexRun(this.normalizedBridgeUrl(), taskId, this.bridgeToken)
            : await BridgeClient.interruptTask(this.normalizedBridgeUrl(), taskId, this.bridgeToken);
        } else if (taskId.length > 0) {
          const taskSummary = this.tasks.find((task: BridgeTaskSummary) => task.id === taskId);
          interrupted = taskSummary !== undefined && this.taskUsesCodexRunApi(taskSummary)
            ? await BridgeClient.interruptCodexRun(this.normalizedBridgeUrl(), taskId, this.bridgeToken)
            : await BridgeClient.interruptTask(this.normalizedBridgeUrl(), taskId, this.bridgeToken);
        } else {
          interrupted = await BridgeClient.interruptCodexThread(this.normalizedBridgeUrl(), targetSessionId, this.bridgeToken);
        }
        this.currentTask = interrupted;
        this.activeSessionTaskId = interrupted.id;
        this.syncSessionTaskMarkers(interrupted);
        if (this.isTaskTerminalStatus(interrupted.status)) {
          if (!this.isSyntheticInterruptFailure(interrupted)) {
            this.markSessionRunningLocallyCleared(targetSessionId);
          }
          this.stopPolling();
        } else {
          this.startPolling();
        }
        this.message = this.interruptResultMessage(interrupted);
        this.log('info', 'session.interrupted.client', `sessionId=${targetSessionId}; taskId=${interrupted.id}; status=${interrupted.status}`);
        await this.refreshSessions();
        if (this.selectedSession !== null && this.selectedSession.id === targetSessionId) {
          await this.refreshSelectedSessionDetail();
        }
      });
    } finally {
      this.isInterruptingTask = false;
      this.interruptingSessionTargetId = '';
    }
  }

  @Builder
  SessionHistoryLoader() {
    if (this.selectedSession?.sync?.hasMoreBefore === true) {
      Row({ space: 8 }) {
        if (this.isLoadingOlderSessionEntries) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(this.themeColor('#1F6FEB'))
        }
        Text(this.isLoadingOlderSessionEntries ? '正在加载更早消息' : '加载更早消息')
          .fontSize(this.scaledFontSize(12))
          .fontColor(this.themeColor('#1F6FEB'))
      }
      .width('100%')
      .height(38)
      .justifyContent(FlexAlign.Center)
      .onClick(() => {
        void this.loadOlderSessionEntries('history_button');
      })
    }
  }

  private confirmSelectedSessionInterrupt(): void {
    const sessionId = this.selectedSession?.id ?? '';
    const taskId = this.selectedSessionInterruptTaskId();
    this.log('info', 'ui.interrupt.confirmation.shown', `sessionId=${sessionId}; taskId=${taskId}`);
    AlertDialog.show({
      title: '中断当前会话？',
      message: '中断会停止当前正在执行的回合。你随后发送的新消息会等待中断进入终态，再按顺序提交到同一会话。',
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '取消',
        action: () => {
          this.log('info', 'ui.interrupt.confirmation.cancelled', `sessionId=${sessionId}; taskId=${taskId}`);
        }
      },
      secondaryButton: {
        value: '确认中断',
        fontColor: this.themeColor('#D92D20'),
        action: () => {
          this.log('info', 'ui.interrupt.confirmation.confirmed', `sessionId=${sessionId}; taskId=${taskId}`);
          void this.interruptSelectedSessionTask();
        }
      }
    });
  }

  private async refreshRunningSelectedSessionStatus(): Promise<void> {
    await this.guard('refreshRunningSelectedSessionStatus', async () => {
      await this.refreshDashboard(true);
      this.message = '已刷新当前会话状态';
    });
  }

  private async pickSessionImageDraft(): Promise<void> {
    if (!this.canPickSessionImage()) {
      this.message = '当前不能添加图片，请先选择一个可发送的会话';
      this.log('info', 'session.image.blocked', `currentTaskId=${this.currentTask?.id ?? ''}; status=${this.currentTask?.status ?? 'idle'}`);
      return;
    }
    this.isUploadingImage = true;
    try {
      const uri = await this.selectImageUri();
      if (uri.length === 0) {
        this.message = '已取消选择图片';
        this.log('info', 'session.image.cancelled', '');
        return;
      }
      const fileName = this.fileNameFromUri(uri);
      const mimeType = this.mimeTypeFromFileName(fileName);
      this.pendingSessionImages = [
        ...this.pendingSessionImages,
        {
          id: `img-${Date.now()}-${this.pendingSessionImages.length}`,
          uri,
          fileName,
          mimeType
        }
      ];
      this.message = `已添加图片：${fileName}`;
      this.log('info', 'session.image.pending_added', `fileName=${fileName}; mimeType=${mimeType}; count=${this.pendingSessionImages.length}`);
    } catch (error) {
      this.message = `添加图片失败：${this.errorText(error)}`;
      this.log('error', 'session.image.failed', `message=${this.message}`);
    } finally {
      this.isUploadingImage = false;
    }
  }

  private async attachDesktopScreenshotDraft(): Promise<void> {
    if (!this.canAttachDesktopScreenshotDraft()) {
      this.message = '当前不能附加桌面截图，请先选择会话或等待当前截图完成';
      this.log('info', 'desktop.screenshot.draft.blocked', `sessionId=${this.selectedSession?.id ?? ''}; isNewSession=${this.isNewSessionDraft}; capturing=${this.isCapturingDesktopScreenshot}; attaching=${this.isAttachingDesktopScreenshot}`);
      return;
    }
    this.isAttachingDesktopScreenshot = true;
    try {
      const startedAt = Date.now();
      const image: DesktopScreenshotImage = await BridgeClient.captureDesktopScreenshot(this.normalizedBridgeUrl(), this.bridgeToken);
      if (image.base64.trim().length === 0) {
        throw new Error('桌面截图为空');
      }
      const mimeType = this.normalizedDesktopScreenshotMimeType(image.mimeType);
      const fileName = this.desktopScreenshotDraftFileName(image);
      this.pendingSessionImages = [
        ...this.pendingSessionImages,
        {
          id: `desktop-shot-${Date.now()}-${this.pendingSessionImages.length}`,
          uri: this.desktopScreenshotDataUri(image),
          fileName,
          mimeType
        }
      ];
      const sizeText = image.width && image.height ? `${image.width}x${image.height}` : '主显示器';
      this.message = `已附加桌面截图：${sizeText}`;
      this.log('info', 'desktop.screenshot.draft_added', `fileName=${fileName}; bytes=${image.bytes}; width=${image.width ?? 0}; height=${image.height ?? 0}; count=${this.pendingSessionImages.length}; durationMs=${Date.now() - startedAt}`);
    } catch (error) {
      this.message = `附加桌面截图失败：${this.errorText(error)}`;
      this.log('error', 'desktop.screenshot.draft.failed', `message=${this.errorText(error)}`);
    } finally {
      this.isAttachingDesktopScreenshot = false;
    }
  }

  private async pickSessionFileDraft(): Promise<void> {
    if (!this.canPickSessionFile()) {
      this.message = '当前不能添加文件';
      return;
    }
    this.isPickingFile = true;
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const file = await AttachmentService.pickDocument(context);
      if (file === null) {
        this.message = '已取消选择文件';
        return;
      }
      this.pendingSessionFiles = [...this.pendingSessionFiles, file];
      this.message = `已添加文件：${file.fileName}`;
      this.log('info', 'session.file.pending_added', `fileName=${file.fileName}; bytes=${file.bytes}; count=${this.pendingSessionFiles.length}`);
    } catch (error) {
      this.message = `添加文件失败：${this.errorText(error)}`;
      this.log('error', 'session.file.failed', `message=${this.errorText(error)}`);
    } finally {
      this.isPickingFile = false;
    }
  }

  private removePendingSessionFile(fileId: string): void {
    this.pendingSessionFiles = this.pendingSessionFiles.filter((file: PickedMobileFile) => file.id !== fileId);
    this.message = '已移除文件';
  }

  private clearPendingSessionFiles(sentFiles: PickedMobileFile[]): void {
    const sentIds = sentFiles.map((file: PickedMobileFile) => file.id);
    this.pendingSessionFiles = this.pendingSessionFiles.filter((file: PickedMobileFile) => sentIds.indexOf(file.id) < 0);
  }

  private formatAttachmentBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private removePendingSessionImage(imageId: string): void {
    const before = this.pendingSessionImages.length;
    this.pendingSessionImages = this.pendingSessionImages.filter((image: PendingSessionImage) => image.id !== imageId);
    this.message = this.pendingSessionImages.length < before ? '已移除图片' : this.message;
    this.log('info', 'session.image.pending_removed', `id=${imageId}; count=${this.pendingSessionImages.length}`);
  }

  private clearPendingSessionImages(sentImages: PendingSessionImage[]): void {
    if (sentImages.length === 0) {
      return;
    }
    const sentIds = sentImages.map((image: PendingSessionImage) => image.id);
    this.pendingSessionImages = this.pendingSessionImages.filter((image: PendingSessionImage) => sentIds.indexOf(image.id) < 0);
  }

  private async composeOutgoingSessionMessage(text: string, images: PendingSessionImage[], files: PickedMobileFile[]): Promise<ComposedSessionMessage> {
    const parts: string[] = [];
    const uploadedImages: PendingSessionImage[] = [];
    const failedImages: PendingSessionImage[] = [];
    const uploadedFiles: PickedMobileFile[] = [];
    const failedFiles: PickedMobileFile[] = [];
    if (text.trim().length > 0) {
      parts.push(text.trim());
    }
    if (images.length > 0) {
      this.message = `正在上传 ${images.length} 张图片`;
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        try {
          const base64 = this.readPendingImageAsBase64(image.uri);
          const uploaded: MobileImageUpload = await BridgeClient.uploadMobileImage(
            this.normalizedBridgeUrl(),
            image.fileName,
            image.mimeType,
            base64,
            this.bridgeToken
          );
          parts.push(uploaded.messageText);
          uploadedImages.push(image);
          this.log('info', 'session.image.uploaded', `filePath=${uploaded.filePath}; bytes=${uploaded.bytes}; mimeType=${uploaded.mimeType}; index=${index}`);
        } catch (error) {
          failedImages.push(image);
          const message = this.errorText(error);
          this.log('error', 'session.image.upload.failed', `fileName=${image.fileName}; index=${index}; message=${message}`);
        }
      }
    }
    if (failedImages.length > 0) {
      parts.push(`手机端有 ${failedImages.length} 张图片上传失败，未附加到本次消息。请直接说明无法查看这些失败图片，不要假设图片内容。`);
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        this.message = `正在上传文件 ${index + 1}/${files.length}`;
        const uploaded: MobileFileUpload = await BridgeClient.uploadMobileFile(
          this.normalizedBridgeUrl(),
          file.fileName,
          file.mimeType,
          AttachmentService.readAsBase64(file.uri),
          this.bridgeToken
        );
        parts.push(uploaded.messageText);
        uploadedFiles.push(file);
        this.log('info', 'session.file.uploaded', `filePath=${uploaded.filePath}; bytes=${uploaded.bytes}; mimeType=${uploaded.mimeType}; index=${index}`);
      } catch (error) {
        failedFiles.push(file);
        this.log('error', 'session.file.upload.failed', `fileName=${file.fileName}; index=${index}; message=${this.errorText(error)}`);
      }
    }
    if (failedFiles.length > 0) {
      parts.push(`手机端有 ${failedFiles.length} 个文件上传失败，未附加到本次消息。`);
    }
    const joined = parts.join('\n\n').trim();
    if (joined.length === 0) {
      throw new Error('图片上传失败，且没有可发送的文字内容');
    }
    return {
      text: this.rawSessionMessage(joined),
      uploadedImages,
      failedImages,
      uploadedFiles,
      failedFiles
    };
  }

  private async selectImageUri(): Promise<string> {
    const photoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    photoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    photoSelectOptions.maxSelectNumber = 1;
    const result: photoAccessHelper.PhotoSelectResult = await new photoAccessHelper.PhotoViewPicker().select(photoSelectOptions);
    if (!result.photoUris || result.photoUris.length === 0) {
      return '';
    }
    return result.photoUris[0];
  }

  private readPendingImageAsBase64(uri: string): string {
    if (uri.startsWith('data:')) {
      const commaIndex = uri.indexOf(',');
      if (commaIndex < 0) {
        throw new Error('图片数据格式错误');
      }
      const metadata = uri.slice(0, commaIndex).toLowerCase();
      if (metadata.indexOf(';base64') < 0) {
        throw new Error('图片数据不是 base64');
      }
      const base64 = uri.slice(commaIndex + 1).trim();
      if (base64.length === 0) {
        throw new Error('图片数据为空');
      }
      if (base64.length > 24 * 1024 * 1024) {
        throw new Error('桌面截图超过上传限制，请缩小桌面内容后重试');
      }
      return base64;
    }
    return this.readFileAsBase64(uri);
  }

  private readFileAsBase64(uri: string): string {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = fileIo.statSync(file.fd);
      const size = Number(stat.size);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error('图片文件为空');
      }
      if (size > 15 * 1024 * 1024) {
        throw new Error('图片超过 15MB，请先压缩后再发送');
      }
      const buffer = new ArrayBuffer(size);
      const readSize = fileIo.readSync(file.fd, buffer);
      return this.base64Encode(new Uint8Array(buffer.slice(0, readSize)));
    } finally {
      fileIo.closeSync(file);
    }
  }

  private base64Encode(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const triple = (first << 16) | (second << 8) | third;
      output += alphabet.charAt((triple >> 18) & 63);
      output += alphabet.charAt((triple >> 12) & 63);
      output += index + 1 < bytes.length ? alphabet.charAt((triple >> 6) & 63) : '=';
      output += index + 2 < bytes.length ? alphabet.charAt(triple & 63) : '=';
    }
    return output;
  }

  private appendToSessionMessage(text: string): string {
    const current = this.sessionMessage.trim();
    if (current.length === 0) {
      return text;
    }
    return `${current}\n\n${text}`;
  }

  private fileNameFromUri(uri: string): string {
    const clean = uri.split('?')[0];
    const name = clean.split('/').pop() ?? '';
    return name.length > 0 ? name : `phone-image-${Date.now()}.jpg`;
  }

  private mimeTypeFromFileName(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }

  private desktopScreenshotDataUri(image: DesktopScreenshotImage): string {
    const base64 = image.base64.trim();
    if (base64.startsWith('data:')) {
      return base64;
    }
    return `data:${this.normalizedDesktopScreenshotMimeType(image.mimeType)};base64,${base64}`;
  }

  private desktopScreenshotDraftFileName(image: DesktopScreenshotImage): string {
    const sizeText = image.width && image.height ? `${image.width}x${image.height}` : 'primary';
    return `desktop-screenshot-${sizeText}-${Date.now()}.${this.extensionFromMimeType(this.normalizedDesktopScreenshotMimeType(image.mimeType))}`;
  }

  private normalizedDesktopScreenshotMimeType(mimeType: string): string {
    const normalized = mimeType.trim().toLowerCase();
    if (normalized === 'image/png') return 'image/png';
    if (normalized === 'image/jpg') return 'image/jpeg';
    if (normalized === 'image/jpeg') return 'image/jpeg';
    if (normalized === 'image/webp') return 'image/webp';
    if (normalized === 'image/gif') return 'image/gif';
    return 'image/png';
  }

  private extensionFromMimeType(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    return 'png';
  }

  private async guard(name: string, action: () => Promise<void>): Promise<boolean> {
    this.isBusy = true;
    this.log('info', 'action.started', `name=${name}`);
    try {
      await action();
      this.log('info', 'action.completed', `name=${name}`);
      return true;
    } catch (err) {
      const recovered = await this.recoverAfterGuardError(name, err);
      if (recovered) {
        this.log('warn', 'action.recovered', `name=${name}; message=${this.errorText(err)}`);
        return true;
      }
      this.message = this.errorText(err);
      this.log('error', 'action.failed', `name=${name}; message=${this.message}`);
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  private submissionIdForRetry(retryFailedMessageId: string): string {
    if (retryFailedMessageId.length > 0) {
      const failed = this.failedSessionMessages.find((message: FailedSessionMessage) => message.id === retryFailedMessageId);
      if (failed && failed.submissionId.length > 0) {
        return failed.submissionId;
      }
    }
    return this.createSessionSubmissionId();
  }

  private createSessionSubmissionId(): string {
    return `phone-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  private beginOptimisticSessionSend(
    sessionId: string,
    isNewSession: boolean,
    projectId: string,
    submissionId: string,
    text: string,
    images: PendingSessionImage[],
    retryFailedMessageId: string
  ): string {
    if (retryFailedMessageId.length > 0) {
      return '';
    }
    const optimistic: OptimisticSessionMessage = {
      id: `optimistic-${submissionId}`,
      sessionId,
      isNewSession,
      projectId,
      submissionId,
      text,
      images: images.slice(),
      createdAt: new Date().toISOString()
    };
    this.optimisticSessionMessages = appendOptimisticSessionMessage(this.optimisticSessionMessages, optimistic);
    this.sessionMessage = '';
    this.pendingSessionImages = [];
    this.pendingSessionFiles = [];
    this.log('info', 'session.message.optimistic.created', `submissionId=${submissionId}; sessionId=${sessionId}; isNew=${isNewSession}; images=${images.length}`);
    this.scrollSessionToBottom(20);
    return optimistic.id;
  }

  private completeOptimisticSessionSend(submissionId: string): void {
    const before = this.optimisticSessionMessages.length;
    this.optimisticSessionMessages = removeOptimisticSessionMessage(this.optimisticSessionMessages, submissionId);
    if (this.optimisticSessionMessages.length < before) {
      this.log('info', 'session.message.optimistic.completed', `submissionId=${submissionId}`);
    }
  }

  private restoreUnsentSessionAttachments(images: PendingSessionImage[], files: PickedMobileFile[]): void {
    this.pendingSessionImages = images.slice();
    this.pendingSessionFiles = files.slice();
  }

  private rememberFailedSessionMessageAfterSendFailure(input: FailedSessionMessageRecordInput): void {
    if (input.failedId.length > 0) {
      if (this.isFailedSessionRetryCanceled(input.failedId)) {
        this.clearFailedSessionRetryTimer(input.failedId);
        this.log('info', 'session.message.failed.retry_canceled_ignore_failure', `failedId=${input.failedId}; sessionId=${input.sessionId}; error=${input.error}`);
        return;
      }
      this.updateFailedSessionMessage(input.failedId, false, input.error);
      this.scheduleFailedSessionAutoRetry(input.failedId, 'updated_failure');
      return;
    }
    const id = `failed-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    this.removeCanceledFailedSessionRetryId(id);
    const failed: FailedSessionMessage = {
      id,
      sessionId: input.sessionId,
      isNewSession: input.isNewSession,
      projectId: input.projectId,
      submissionId: input.submissionId.length > 0 ? input.submissionId : this.createSessionSubmissionId(),
      text: input.text,
      images: input.images.slice(),
      files: input.files.slice(),
      error: input.error,
      createdAt: new Date().toISOString(),
      retrying: false,
      retryCount: 0,
      retryLimit: this.failedSessionAutoRetryLimit,
      autoRetryEnabled: true,
      nextRetryAt: ''
    };
    this.failedSessionMessages = [
      ...this.failedSessionMessages,
      failed
    ];
    this.sessionMessage = '';
    this.pendingSessionImages = [];
    this.pendingSessionFiles = [];
    this.message = '发送失败，已保留消息，将自动重传，点 X 可取消';
    this.log('warn', 'session.message.failed.remembered', `failedId=${id}; sessionId=${input.sessionId}; isNew=${input.isNewSession}; images=${input.images.length}; error=${input.error}`);
    this.scheduleFailedSessionAutoRetry(id, 'new_failure');
    this.scrollSessionToBottom(80);
  }

  private rememberPendingSessionSend(taskId: string, pending: PendingSessionSend): void {
    if (taskId.length === 0) {
      return;
    }
    this.pendingSessionSendsByTaskId[taskId] = pending;
    this.log('info', 'session.message.pending.remembered', `taskId=${taskId}; sessionId=${pending.sessionId}; isNew=${pending.isNewSession}; images=${pending.images.length}`);
  }

  private handoffPendingSessionSend(previousTaskId: string, task: BridgeTask): void {
    if (previousTaskId.length === 0 || task.id.length === 0 || previousTaskId === task.id) {
      return;
    }
    const pending = this.pendingSessionSendsByTaskId[previousTaskId];
    if (!pending) {
      return;
    }
    const next: Record<string, PendingSessionSend> = {};
    Object.keys(this.pendingSessionSendsByTaskId).forEach((id: string) => {
      if (id !== previousTaskId) {
        next[id] = this.pendingSessionSendsByTaskId[id];
      }
    });
    next[task.id] = pending;
    this.pendingSessionSendsByTaskId = next;
    if (this.activeSessionTaskId === previousTaskId) {
      this.activeSessionTaskId = task.id;
    }
    if (this.newSessionTaskId === previousTaskId) {
      this.newSessionTaskId = task.id;
    }
    this.log('info', 'session.message.pending.handed_off', `previousTaskId=${previousTaskId}; taskId=${task.id}; sessionId=${pending.sessionId}`);
  }

  private clearPendingSessionSend(taskId: string): void {
    if (taskId.length === 0 || !this.pendingSessionSendsByTaskId[taskId]) {
      return;
    }
    const next: Record<string, PendingSessionSend> = {};
    Object.keys(this.pendingSessionSendsByTaskId).forEach((id: string) => {
      if (id !== taskId) {
        next[id] = this.pendingSessionSendsByTaskId[id];
      }
    });
    this.pendingSessionSendsByTaskId = next;
    this.log('info', 'session.message.pending.cleared', `taskId=${taskId}`);
  }

  private rememberFailedSessionMessageForTerminalTask(task: BridgeTask): void {
    const pending = this.pendingSessionSendsByTaskId[task.id];
    if (!pending) {
      return;
    }
    if (pending.retryFailedMessageId.length > 0 && this.isFailedSessionRetryCanceled(pending.retryFailedMessageId)) {
      this.clearPendingSessionSend(task.id);
      this.log('info', 'session.message.failed.retry_canceled_ignore_terminal', `taskId=${task.id}; failedId=${pending.retryFailedMessageId}; status=${task.status}`);
      return;
    }
    if (task.status === 'completed') {
      if (pending.retryFailedMessageId.length > 0) {
        this.removeFailedSessionMessage(pending.retryFailedMessageId);
      }
      this.clearPendingSessionSend(task.id);
      return;
    }
    if (pending.retryFailedMessageId.length > 0) {
      const canonicalCandidate: FailedSessionMessage = {
        id: pending.retryFailedMessageId,
        sessionId: pending.sessionId,
        isNewSession: pending.isNewSession,
        projectId: pending.projectId,
        submissionId: pending.submissionId,
        text: pending.text,
        images: pending.images,
        files: pending.files,
        error: '',
        createdAt: task.createdAt,
        retrying: false,
        retryCount: 0,
        retryLimit: this.failedSessionAutoRetryLimit,
        autoRetryEnabled: true,
        nextRetryAt: ''
      };
      if (this.failedSessionMessageHasCanonicalEntry(canonicalCandidate)) {
        this.removeFailedSessionMessage(pending.retryFailedMessageId);
        this.clearPendingSessionSend(task.id);
        return;
      }
    }
    const error = task.status === 'failed'
      ? this.taskFailureMessage(task)
      : `任务已${this.statusLabel(task.status)}，消息没有完成投递`;
    this.rememberFailedSessionMessageAfterSendFailure({
      failedId: pending.retryFailedMessageId,
      sessionId: pending.sessionId,
      isNewSession: pending.isNewSession,
      projectId: pending.projectId,
      submissionId: pending.submissionId,
      text: pending.text,
      images: pending.images,
      files: pending.files,
      error
    });
    this.clearPendingSessionSend(task.id);
  }

  private taskFailureMessage(task: BridgeTask): string {
    for (let index = task.events.length - 1; index >= 0; index -= 1) {
      const event = task.events[index];
      if (event.type === 'task.failed') {
        const message = `${event.payload['message'] ?? event.payload['error'] ?? ''}`;
        if (message.length > 0) {
          return message;
        }
      }
    }
    return 'Codex 没有确认接收这条消息';
  }

  private isFailedSessionRetryCanceled(failedId: string): boolean {
    return failedId.length > 0 && this.canceledFailedSessionRetryIds.indexOf(failedId) >= 0;
  }

  private removeCanceledFailedSessionRetryId(failedId: string): void {
    if (failedId.length === 0 || this.canceledFailedSessionRetryIds.indexOf(failedId) < 0) {
      return;
    }
    this.canceledFailedSessionRetryIds = this.canceledFailedSessionRetryIds.filter((id: string) => id !== failedId);
  }

  private canRetryFailedSessionMessage(message: FailedSessionMessage): boolean {
    return !message.retrying && !this.isBusy && !this.isFailedSessionRetryCanceled(message.id);
  }

  private failedSessionMessageStatusText(message: FailedSessionMessage): string {
    if (message.retrying) {
      return '重试中';
    }
    if (!message.autoRetryEnabled || this.isFailedSessionRetryCanceled(message.id)) {
      return '发送失败';
    }
    if (message.retryCount >= message.retryLimit) {
      return `发送失败 · 已重试 ${message.retryCount}/${message.retryLimit}`;
    }
    return `发送失败 · 将自动重试 ${message.retryCount}/${message.retryLimit}`;
  }

  private failedSessionRetryDelayMs(message: FailedSessionMessage): number {
    const attempt = Math.max(0, message.retryCount);
    return this.failedSessionAutoRetryDelayMs * Math.min(4, attempt + 1);
  }

  private forgetFailedSessionRetryTimer(failedId: string): void {
    if (!this.failedSessionRetryTimersById[failedId]) {
      return;
    }
    const next: Record<string, number> = {};
    Object.keys(this.failedSessionRetryTimersById).forEach((id: string) => {
      if (id !== failedId) {
        next[id] = this.failedSessionRetryTimersById[id];
      }
    });
    this.failedSessionRetryTimersById = next;
  }

  private clearFailedSessionRetryTimer(failedId: string): void {
    const timer = this.failedSessionRetryTimersById[failedId];
    if (timer !== undefined && timer >= 0) {
      clearInterval(timer);
    }
    this.forgetFailedSessionRetryTimer(failedId);
  }

  private updateFailedSessionMessageNextRetryAt(failedId: string, nextRetryAt: string): void {
    this.failedSessionMessages = this.failedSessionMessages.map((message: FailedSessionMessage) => {
      if (message.id !== failedId) {
        return message;
      }
      return {
        id: message.id,
        sessionId: message.sessionId,
        isNewSession: message.isNewSession,
        projectId: message.projectId,
        submissionId: message.submissionId,
        text: message.text,
        images: message.images,
        files: message.files,
        error: message.error,
        createdAt: message.createdAt,
        retrying: message.retrying,
        retryCount: message.retryCount,
        retryLimit: message.retryLimit,
        autoRetryEnabled: message.autoRetryEnabled,
        nextRetryAt
      };
    });
  }

  private scheduleFailedSessionAutoRetry(failedId: string, source: string): void {
    const message = this.failedSessionMessages.find((item: FailedSessionMessage) => item.id === failedId);
    if (!message || !message.autoRetryEnabled || message.retrying || this.isFailedSessionRetryCanceled(failedId)) {
      return;
    }
    if (message.retryCount >= message.retryLimit) {
      this.log('warn', 'session.message.failed.retry_limit_reached', `failedId=${failedId}; source=${source}; retryCount=${message.retryCount}; retryLimit=${message.retryLimit}`);
      return;
    }
    this.clearFailedSessionRetryTimer(failedId);
    const delayMs = this.failedSessionRetryDelayMs(message);
    this.updateFailedSessionMessageNextRetryAt(failedId, new Date(Date.now() + delayMs).toISOString());
    this.failedSessionRetryTimersById[failedId] = setTimeout(() => {
      this.forgetFailedSessionRetryTimer(failedId);
      void this.autoRetryFailedSessionMessage(failedId);
    }, delayMs);
    this.log('info', 'session.message.failed.retry_scheduled', `failedId=${failedId}; source=${source}; retryCount=${message.retryCount}; retryLimit=${message.retryLimit}; delayMs=${delayMs}`);
  }

  private beginFailedSessionRetryAttempt(failedId: string, source: string): FailedSessionMessage | null {
    const message = this.failedSessionMessages.find((item: FailedSessionMessage) => item.id === failedId);
    if (!message || message.retrying || this.isFailedSessionRetryCanceled(failedId)) {
      return null;
    }
    if (message.retryCount >= message.retryLimit) {
      this.updateFailedSessionMessage(failedId, false, `自动重试已达到上限 ${message.retryLimit} 次，请手动重试或取消`);
      this.log('warn', 'session.message.failed.retry_limit_blocked', `failedId=${failedId}; source=${source}; retryCount=${message.retryCount}; retryLimit=${message.retryLimit}`);
      return null;
    }
    this.clearFailedSessionRetryTimer(failedId);
    const attempt: FailedSessionMessage = {
      id: message.id,
      sessionId: message.sessionId,
      isNewSession: message.isNewSession,
      projectId: message.projectId,
      submissionId: message.submissionId,
      text: message.text,
      images: message.images.slice(),
      files: message.files.slice(),
      error: message.error,
      createdAt: message.createdAt,
      retrying: true,
      retryCount: message.retryCount + 1,
      retryLimit: message.retryLimit,
      autoRetryEnabled: source !== 'manual' ? message.autoRetryEnabled : true,
      nextRetryAt: ''
    };
    this.failedSessionMessages = this.failedSessionMessages.map((item: FailedSessionMessage) => item.id === failedId ? attempt : item);
    this.log('info', 'session.message.failed.retry_attempt', `failedId=${failedId}; source=${source}; retryCount=${attempt.retryCount}; retryLimit=${attempt.retryLimit}`);
    return attempt;
  }

  private failedSessionMessageNeedsRetry(failedId: string): boolean {
    const message = this.failedSessionMessages.find((item: FailedSessionMessage) => item.id === failedId);
    return !!message && !message.retrying && message.autoRetryEnabled && !this.isFailedSessionRetryCanceled(failedId) && message.retryCount < message.retryLimit && !this.failedSessionMessageHasCanonicalEntry(message);
  }

  private async autoRetryFailedSessionMessage(failedId: string): Promise<void> {
    if (!this.failedSessionMessageNeedsRetry(failedId)) {
      this.log('info', 'session.message.failed.auto_retry_skipped', `failedId=${failedId}`);
      return;
    }
    const message = this.failedSessionMessages.find((item: FailedSessionMessage) => item.id === failedId);
    if (!message) {
      return;
    }
    await this.retryFailedSessionMessage(message, 'auto');
  }

  private cancelFailedSessionAutoRetry(failedId: string): void {
    this.clearFailedSessionRetryTimer(failedId);
    if (this.canceledFailedSessionRetryIds.indexOf(failedId) < 0) {
      this.canceledFailedSessionRetryIds = this.canceledFailedSessionRetryIds.concat([failedId]);
    }
    this.removeFailedSessionMessage(failedId);
    this.message = '已取消失败消息重传';
    this.log('info', 'session.message.failed.retry_canceled', `failedId=${failedId}`);
  }

  private updateFailedSessionMessage(failedId: string, retrying: boolean, error: string = ''): void {
    this.failedSessionMessages = this.failedSessionMessages.map((message: FailedSessionMessage) => {
      if (message.id !== failedId) {
        return message;
      }
      return {
        id: message.id,
        sessionId: message.sessionId,
        isNewSession: message.isNewSession,
        projectId: message.projectId,
        submissionId: message.submissionId,
        text: message.text,
        images: message.images,
        files: message.files,
        error: error.length > 0 ? error : message.error,
        createdAt: message.createdAt,
        retrying,
        retryCount: message.retryCount,
        retryLimit: message.retryLimit,
        autoRetryEnabled: message.autoRetryEnabled,
        nextRetryAt: retrying ? '' : message.nextRetryAt
      };
    });
  }

  private removeFailedSessionMessage(failedId: string): void {
    this.clearFailedSessionRetryTimer(failedId);
    const before = this.failedSessionMessages.length;
    this.failedSessionMessages = this.failedSessionMessages.filter((message: FailedSessionMessage) => message.id !== failedId);
    if (this.failedSessionMessages.length < before) {
      this.log('info', 'session.message.failed.removed', `failedId=${failedId}`);
    }
  }

  private async retryFailedSessionMessage(message: FailedSessionMessage, source: string = 'manual'): Promise<void> {
    if (this.isBusy && source === 'manual') {
      return;
    }
    const attempt = this.beginFailedSessionRetryAttempt(message.id, source);
    if (attempt === null) {
      return;
    }
    if (!message.isNewSession && (this.selectedSession === null || this.selectedSession.id !== message.sessionId)) {
      this.message = '请先回到这条失败消息所属会话后再重试';
      this.updateFailedSessionMessage(attempt.id, false, this.message);
      this.scheduleFailedSessionAutoRetry(attempt.id, 'wrong_session');
      return;
    }
    const previousText = this.sessionMessage;
    const previousImages = this.pendingSessionImages.slice();
    const previousFiles = this.pendingSessionFiles.slice();
    this.sessionMessage = attempt.text;
    this.pendingSessionImages = attempt.images.slice();
    this.pendingSessionFiles = attempt.files.slice();
    this.log('info', 'session.message.failed.retry', `failedId=${attempt.id}; source=${source}; sessionId=${attempt.sessionId}; isNew=${attempt.isNewSession}; images=${attempt.images.length}; files=${attempt.files.length}`);
    const ok = attempt.isNewSession
      ? await this.sendNewSessionMessage(attempt.id)
      : await this.sendMessageToSelectedSession(attempt.id);
    if (!ok) {
      this.sessionMessage = previousText;
      this.pendingSessionImages = previousImages;
      this.pendingSessionFiles = previousFiles;
      this.updateFailedSessionMessage(attempt.id, false, this.message);
      this.scheduleFailedSessionAutoRetry(attempt.id, 'retry_failed');
    }
  }

  private async recoverAfterGuardError(name: string, error: Object): Promise<boolean> {
    const message = this.errorText(error);
    if (name === 'interruptSelectedSessionTask' && this.isEndedTaskInterruptConflict(message)) {
      await this.clearSelectedSessionRunningAfterEndedInterruptConflict();
      return true;
    }
    if (name !== 'sendSessionMessage' && name !== 'sendNewSessionMessage') {
      return false;
    }
    if (!this.isBridgeRequestTimeout(message)) {
      return false;
    }
    const targetSessionId = this.sendingSessionTargetId;
    const adopted = await this.adoptTaskAfterSendTimeout(targetSessionId, name);
    if (adopted) {
      return true;
    }
    return false;
  }

  private isBridgeRequestTimeout(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.indexOf('operation timeout') >= 0
      || normalized.indexOf('timeout') >= 0
      || normalized.indexOf('timed out') >= 0;
  }

  private isEndedTaskInterruptConflict(message: string): boolean {
    return message.indexOf('HTTP 409') >= 0
      && message.indexOf('已经结束') >= 0
      && message.indexOf('不能中断') >= 0;
  }

  private async clearSelectedSessionRunningAfterEndedInterruptConflict(): Promise<void> {
    const sessionId = this.selectedSession?.id ?? '';
    const taskId = this.selectedSessionInterruptTaskId();
    if (sessionId.length > 0) {
      this.markSessionRunningLocallyCleared(sessionId);
    }
    if (taskId.length > 0) {
      this.taskStatusById[taskId] = 'interrupted';
      if (sessionId.length > 0) {
        this.taskSessionById[taskId] = sessionId;
        this.latestTaskIdBySessionId[sessionId] = taskId;
      }
    }
    if (this.currentTask !== null && (this.currentTask.id === taskId || this.taskSessionId(this.currentTask) === sessionId)) {
      this.currentTask.status = 'interrupted';
      this.currentTask.updatedAt = new Date().toISOString();
      this.currentTask = this.currentTask;
    }
    this.stopPolling();
    this.message = '任务已结束，已同步为可发送状态';
    this.log('warn', 'session.interrupt.ended_conflict_recovered', `sessionId=${sessionId}; taskId=${taskId}`);
    await this.refreshSessions();
    if (sessionId.length > 0 && this.selectedSession !== null && this.selectedSession.id === sessionId) {
      await this.refreshSelectedSessionDetail();
    }
  }

  private async adoptTaskAfterSendTimeout(targetSessionId: string, source: string): Promise<boolean> {
    try {
      const tasks = await BridgeClient.listTasks(this.normalizedBridgeUrl(), this.bridgeToken);
      this.tasks = tasks;
      this.reconcileSessionTaskMonitor(tasks);
      const summary = this.latestTaskSummaryForSession(tasks, targetSessionId);
      if (summary === null) {
        this.log('warn', 'task.timeout_adopt.none', `source=${source}; targetSessionId=${targetSessionId}`);
        return false;
      }
      const task = this.taskUsesCodexRunApi(summary)
        ? await BridgeClient.getCodexRun(this.normalizedBridgeUrl(), summary.id, this.bridgeToken)
        : await BridgeClient.getTask(this.normalizedBridgeUrl(), summary.id, this.bridgeToken);
      this.handoffPendingSessionSend(summary.id, task);
      this.currentTask = task;
      this.activeSessionTaskId = task.id;
      this.activeSessionTaskTitle = this.activeTaskTitleFromSummary(summary);
      this.syncSessionTaskMarkers(task);
      this.message = this.isTaskTerminalStatus(task.status) ? '消息已提交，已同步完成状态' : '消息已提交，已恢复运行状态';
      this.showTaskEventDetails = false;
      if (this.isTaskTerminalStatus(task.status)) {
        await this.handleTaskTerminalForSession(task, '', 'timeout_adopt');
        const appliedLiveSession = this.applyTaskSessionSnapshot(task);
        if (!appliedLiveSession && targetSessionId.length > 0 && targetSessionId !== '__new_session__') {
          await this.loadSessionDetail(targetSessionId);
        }
      } else {
        this.startPolling();
      }
      this.log('warn', 'task.timeout_adopted', `source=${source}; taskId=${task.id}; status=${task.status}; sessionId=${this.taskSessionId(task)}`);
      return true;
    } catch (adoptError) {
      this.log('error', 'task.timeout_adopt.failed', `source=${source}; targetSessionId=${targetSessionId}; message=${this.errorText(adoptError)}`);
      return false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.taskPollStartedAt = Date.now();
    this.taskPollLastStatus = this.currentTask?.status ?? '';
    this.taskPollLastEventCount = this.currentTaskEventCount(this.currentTask);
    this.taskPollDelayMs = 2000;
    this.scheduleNextTaskPoll(250);
  }

  private scheduleNextTaskPoll(delayMs: number): void {
    if (this.currentTask === null || !this.isTaskRunningStatus(this.currentTask.status)) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = -1;
      void this.refreshTaskFromTimer();
    }, delayMs);
  }

  private async refreshTaskFromTimer(): Promise<void> {
    try {
      await this.refreshTask();
    } catch (error) {
      this.log('warn', 'task.poll.failed', `taskId=${this.currentTask?.id ?? ''}; message=${this.errorText(error)}`);
    }
    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status)) {
      this.scheduleNextTaskPoll(this.taskPollDelayMs);
    }
  }

  private startDashboardRefresh(): void {
    this.stopDashboardRefresh();
    this.scheduleNextDashboardRefresh(500);
  }

  private scheduleNextDashboardRefresh(delayMs: number): void {
    if (this.dashboardTimer >= 0) {
      clearInterval(this.dashboardTimer);
    }
    this.dashboardTimer = setTimeout(() => {
      this.dashboardTimer = -1;
      void this.refreshDashboardFromTimer();
    }, delayMs);
  }

  private async refreshDashboardFromTimer(): Promise<void> {
    await this.refreshDashboard(false);
    this.scheduleNextDashboardRefresh(this.nextDashboardRefreshDelayMs());
  }

  private nextDashboardRefreshDelayMs(): number {
    if (!this.appForeground) {
      return 60000;
    }
    if (this.hasRunningSessionTask()) {
      return 10000;
    }
    return 20000;
  }

  private stopDashboardRefresh(): void {
    if (this.dashboardTimer >= 0) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = -1;
    }
  }

  private async refreshDashboard(force: boolean = false): Promise<void> {
    if (this.isRefreshingDashboard) {
      return;
    }
    this.isRefreshingDashboard = true;
    try {
      const now = Date.now();
      if (force || now - this.lastRuntimeContractRefreshAt > 60000) {
        const targetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
        const runtime = await BridgeClient.getRuntimeStatus(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId);
        this.lastRuntimeContractRefreshAt = now;
        this.log('info', 'runtime.contract.negotiated', `mode=${runtime.mode}; execution=${runtime.existingThreadExecution}; protocol=${runtime.protocol?.protocolVersion ?? 0}; bridgeVersion=${runtime.protocol?.bridgeVersion ?? ''}`);
      }
      const shouldRefreshProjects = force || this.projects.length === 0 || now - this.lastProjectsRefreshAt > 120000;
      const hasAnyRunning = this.hasAnyRunningSession();
      const shouldRefreshTasks = force || this.tasks.length === 0 || now - this.lastTasksRefreshAt > (hasAnyRunning ? 10000 : 20000);
      const shouldRefreshSessions = force || this.sessions.length === 0 || now - this.lastSessionsRefreshAt > (hasAnyRunning ? 10000 : 20000);
      if (shouldRefreshProjects) {
        try {
          this.projects = await BridgeClient.listProjects(this.normalizedBridgeUrl(), this.bridgeToken);
          this.lastProjectsRefreshAt = now;
        } catch (error) {
          this.log('warn', 'dashboard.projects.refresh.skipped', `message=${this.errorText(error)}`);
        }
      }
      if (shouldRefreshTasks) {
        try {
          this.tasks = await BridgeClient.listTasks(this.normalizedBridgeUrl(), this.bridgeToken);
          this.lastTasksRefreshAt = now;
        } catch (error) {
          this.log('warn', 'dashboard.tasks.refresh.skipped', `message=${this.errorText(error)}; kept=${this.tasks.length}`);
        }
      }
      this.reconcileSessionTaskMonitor(this.tasks);
      await this.adoptSelectedSessionTaskFromSummaries(this.tasks);
      await this.adoptRunningTaskFromSummaries(this.tasks);
      if (shouldRefreshSessions) {
        const latestSessions = await this.loadCanonicalSessionSummaries('dashboard');
        this.lastSessionsRefreshAt = now;
        this.reconcileSessionActivityMonitor(latestSessions);
        this.applyLatestSessions(latestSessions, 'dashboard');
        void this.publishStandbyMonitorSnapshot('sessions_dashboard', true);
        await this.restoreActiveSessionIfNeeded();
        await this.applyPendingNotificationNavigation();
      }
      if (force || now - this.lastSystemLinkRefreshAt > 60000) {
        try {
          const targetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
          const link = await BridgeClient.getSystemLinkStatus(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId);
          this.applySystemLinkStatus(link, targetSessionId);
        } catch (error) {
          this.log('warn', 'system.link.dashboard_refresh.skipped', `message=${this.errorText(error)}`);
        }
      }
      const hadDashboardFailure = this.dashboardFailureCount > 0;
      this.dashboardFailureCount = 0;
      if (this.currentTask === null || this.currentTask.status === 'idle') {
        this.message = hadDashboardFailure
          ? `桥接已恢复，已同步 ${this.sessions.length} 个会话`
          : `已同步 ${this.sessions.length} 个会话`;
      }
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      this.dashboardFailureCount += 1;
      if (this.dashboardFailureCount === 1) {
        void this.publishConnectionNotification();
      }
      if (this.dashboardFailureCount <= 3 || this.dashboardFailureCount % 10 === 0) {
        this.log('error', 'dashboard.refresh.failed', `count=${this.dashboardFailureCount}; message=${this.message}`);
      }
      return;
    } finally {
      this.isRefreshingDashboard = false;
    }
    if (this.activeTab === 'sessions' && this.selectedSession !== null && !this.isNewSessionDraft) {
      try {
        const now = Date.now();
        if (force || now - this.lastSelectedSessionDetailRefreshAt > (this.selectedSessionNeedsFastRefresh() ? 5000 : 15000)) {
          await this.refreshSelectedSessionDetail();
          this.lastSelectedSessionDetailRefreshAt = now;
        }
      } catch (error) {
        this.log('warn', 'dashboard.session_detail.refresh.skipped', `sessionId=${this.selectedSession?.id ?? ''}; message=${this.errorText(error)}`);
      }
    }
    if (this.hasRunningSessionTask() && this.pollTimer < 0) {
      try {
        await this.refreshTask();
      } catch (error) {
        this.log('warn', 'dashboard.task.refresh.skipped', `taskId=${this.currentTask?.id ?? ''}; message=${this.errorText(error)}`);
      }
    }
  }

  private async publishStandbyMonitorSnapshot(source: string, connected: boolean): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const previous = await StandbyMonitorSnapshotService.loadSnapshot(context);
      const snapshot = StandbyMonitorSnapshotService.buildSnapshot(
        this.sessions,
        this.runningSessionIds,
        this.unreadCompletedSessionIds,
        this.accountUsage,
        connected,
        previous.layoutMode,
        previous.formLocation,
        this.latestRuntimeSnapshot,
        this.sessionMonitorRevision
      );
      const nextDesktopMonitorSnapshot = StandbyMonitorSnapshotService.buildSnapshot(
        this.sessions,
        this.runningSessionIds,
        this.unreadCompletedSessionIds,
        this.accountUsage,
        connected,
        this.isLandscapeSessionLayout() ? 'landscape' : 'portrait',
        'app_monitor',
        this.latestRuntimeSnapshot,
        this.sessionMonitorRevision
      );
      if (!StandbyMonitorSnapshotService.isSameAppMonitorRender(
        this.desktopMonitorSnapshot,
        nextDesktopMonitorSnapshot
      )) {
        this.desktopMonitorSnapshot = nextDesktopMonitorSnapshot;
      }
      await StandbyMonitorSnapshotService.publish(context, snapshot);
      let notificationResult: MonitorNotificationSyncResult = {
        action: 'skipped',
        state: 'not_attempted'
      };
      try {
        notificationResult = await AppNotificationService.syncMonitorSnapshot(snapshot);
      } catch (notificationError) {
        this.log(
          'warn',
          'standby_monitor.notification.failed',
          `source=${source}; message=${this.errorText(notificationError)}`
        );
      }
      this.log(
        'info',
        'standby_monitor.snapshot.published',
        `source=${source}; running=${snapshot.runningCount}; unread=${snapshot.unreadCount}; connected=${connected}; notificationAction=${notificationResult.action}; notificationState=${notificationResult.state}; liveView=disabled`
      );
    } catch (error) {
      this.log(
        'warn',
        'standby_monitor.snapshot.skipped',
        `source=${source}; message=${this.errorText(error)}`
      );
    }
  }

  private async loadCanonicalSessionSummaries(source: string): Promise<CodexSessionSummary[]> {
    const sessions = await BridgeClient.listSessions(this.normalizedBridgeUrl(), this.bridgeToken);
    try {
      const runtime = await BridgeClient.getRuntimeSnapshot(this.normalizedBridgeUrl(), this.bridgeToken);
      const applied = this.sessionRuntimeStore.apply(runtime);
      this.latestRuntimeSnapshot = this.sessionRuntimeStore.snapshot();
      this.log(
        'info',
        'runtime.snapshot.synced',
        `source=${source}; epoch=${runtime.epoch}; revision=${runtime.revision}; applied=${applied}; sessions=${runtime.sessions.length}`
      );
      return this.sessionRuntimeStore.mergeSessions(sessions);
    } catch (error) {
      this.sessionRuntimeStore.markStale();
      this.latestRuntimeSnapshot = this.sessionRuntimeStore.snapshot();
      this.log('warn', 'runtime.snapshot.refresh.failed', `source=${source}; message=${this.errorText(error)}`);
      return this.latestRuntimeSnapshot === null
        ? sessions
        : this.sessionRuntimeStore.mergeSessions(sessions);
    }
  }

  private async refreshSessions(source: string = 'manual'): Promise<void> {
    if (source === 'pull') {
      this.isPullRefreshingSessions = true;
    }
    try {
      const latestSessions = await this.loadCanonicalSessionSummaries(source);
      this.sessionsLoadError = '';
      this.lastSessionsRefreshAt = Date.now();
      this.reconcileSessionActivityMonitor(latestSessions);
      this.applyLatestSessions(latestSessions, source);
      void this.publishStandbyMonitorSnapshot(`sessions_${source}`, true);
      await this.restoreActiveSessionIfNeeded();
      await this.applyPendingNotificationNavigation();
      this.message = `已刷新 ${this.sessions.length} 个会话`;
      this.log('info', 'sessions.loaded', `source=${source}; count=${this.sessions.length}`);
    } catch (err) {
      this.sessionsLoadError = this.errorText(err);
      this.message = this.sessionsLoadError;
      void this.publishStandbyMonitorSnapshot(`sessions_${source}`, false);
      this.log('error', 'sessions.load.failed', `message=${this.message}`);
    } finally {
      if (source === 'pull') {
        this.isPullRefreshingSessions = false;
      }
    }
  }

  private async refreshAfterMissingTask(sessionId: string, taskId: string): Promise<void> {
    try {
      await this.refreshSessions('missing_task');
      if (sessionId.length > 0 && this.selectedSession !== null && this.selectedSession.id === sessionId) {
        await this.refreshSelectedSessionDetail();
      }
      this.message = '运行状态已重置，会话已同步到最新内容';
      this.log('info', 'task.refresh.missing_synced', `taskId=${taskId}; sessionId=${sessionId}`);
    } catch (error) {
      this.message = `运行状态已重置，会话刷新失败：${this.errorText(error)}`;
      this.log('warn', 'task.refresh.missing_sync_failed', `taskId=${taskId}; sessionId=${sessionId}; message=${this.errorText(error)}`);
    }
  }

  private async loadSessionDetail(sessionId: string): Promise<void> {
    const requestSeq = ++this.sessionDetailRequestSeq;
    try {
      const detail = await BridgeClient.getSessionHistoryPage(
        this.normalizedBridgeUrl(),
        sessionId,
        this.bridgeToken,
        160
      );
      if (requestSeq !== this.sessionDetailRequestSeq) {
        this.log('warn', 'session.detail.stale_ignored', `sessionId=${sessionId}; requestSeq=${requestSeq}; latestSeq=${this.sessionDetailRequestSeq}`);
        return;
      }
      this.selectedSession = detail;
      this.activeSessionId = sessionId;
      this.applySessionActivitySnapshot(detail, 'detail');
      this.lastSelectedSessionDetailRefreshAt = Date.now();
      this.markSessionRead(sessionId);
      this.message = `已打开会话：${this.selectedSession.title}`;
      this.log('info', 'session.detail.loaded', `sessionId=${sessionId}; entries=${this.selectedSession.entryCount}`);
      await this.loadSessionReasoningEffort(sessionId);
      this.scrollSessionToBottom(80);
    } catch (err) {
      if (requestSeq !== this.sessionDetailRequestSeq) {
        this.log('warn', 'session.detail.stale_error_ignored', `sessionId=${sessionId}; requestSeq=${requestSeq}; latestSeq=${this.sessionDetailRequestSeq}; message=${this.errorText(err)}`);
        return;
      }
      this.message = err instanceof Error ? err.message : String(err);
      this.log('error', 'session.detail.failed', `sessionId=${sessionId}; message=${this.message}`);
    }
  }

  private readSessionNavigation(): SessionNavigationSnapshot {
    if (this.sessionNavigationState.length > 0) {
      try {
        const parsed = JSON.parse(this.sessionNavigationState) as SessionNavigationSnapshot;
        if (parsed && Number.isFinite(parsed.revision) && parsed.revision >= 0) {
          return {
            revision: parsed.revision,
            mode: parsed.mode ?? 'home',
            sessionId: parsed.sessionId ?? ''
          };
        }
      } catch (error) {
        this.log('warn', 'session.navigation.invalid_state', `message=${this.errorText(error)}; rawLength=${this.sessionNavigationState.length}`);
      }
    }
    return {
      revision: 0,
      mode: this.activeSessionId.length > 0 ? 'session' : 'home',
      sessionId: this.activeSessionId
    };
  }

  private commitSessionNavigation(mode: string, sessionId: string, source: string): void {
    const current = this.readSessionNavigation();
    const next: SessionNavigationSnapshot = {
      revision: current.revision + 1,
      mode,
      sessionId
    };
    this.sessionNavigationState = JSON.stringify(next);
    this.activeSessionId = mode === 'session' ? sessionId : '';
    this.log('info', 'session.navigation.committed', `source=${source}; mode=${mode}; sessionId=${sessionId}; revision=${next.revision}`);
  }

  private isSessionNavigationCurrent(revision: number, sessionId: string): boolean {
    const current = this.readSessionNavigation();
    return current.revision === revision
      && current.mode === 'session'
      && current.sessionId === sessionId;
  }

  private async restoreActiveSessionIfNeeded(): Promise<void> {
    const navigation = this.readSessionNavigation();
    if (navigation.mode !== 'session' || navigation.sessionId.length === 0 || this.isNewSessionDraft) {
      return;
    }
    const sessionId = navigation.sessionId;
    const restoreRevision = navigation.revision;
    if (this.selectedSession !== null && this.selectedSession.id === sessionId) {
      return;
    }
    this.log('info', 'session.rotation_restore.started', `sessionId=${sessionId}; revision=${restoreRevision}`);
    await this.loadSessionDetail(sessionId);
    if (!this.isSessionNavigationCurrent(restoreRevision, sessionId)
      || this.selectedSession === null
      || this.selectedSession.id !== sessionId) {
      this.log('warn', 'session.rotation_restore.stale_ignored', `sessionId=${sessionId}; revision=${restoreRevision}; activeSessionId=${this.activeSessionId}`);
      return;
    }
    this.sessionSidebarCollapsed = !this.isLandscapeSessionLayout();
    this.sessionSidebarUserCollapsed = false;
    this.log('info', 'session.rotation_restore.completed', `sessionId=${sessionId}; layout=${this.isLandscapeSessionLayout() ? 'landscape' : 'portrait'}`);
  }

  private async refreshSelectedSessionDetail(): Promise<void> {
    if (this.selectedSession === null) {
      return;
    }
    const previousSessionId = this.selectedSession.id;
    const previousEntryCount = this.selectedSession.entryCount;
    const previousBottomSignature = this.sessionBottomSignature(this.selectedSession);
    const refreshed = await BridgeClient.getSession(this.normalizedBridgeUrl(), previousSessionId, this.bridgeToken);
    this.lastSelectedSessionDetailRefreshAt = Date.now();
    if (this.selectedSession === null || this.selectedSession.id !== previousSessionId) {
      return;
    }
    const refreshedBottomSignature = this.sessionBottomSignature(refreshed);
    this.selectedSession = this.mergeSessionDetailPreservingHistory(this.selectedSession, refreshed);
    this.applySessionActivitySnapshot(refreshed, 'detail_refresh');
    this.markSessionRead(previousSessionId);
    if (refreshed.entryCount !== previousEntryCount || refreshedBottomSignature !== previousBottomSignature) {
      this.log('info', 'session.detail.auto_refreshed', `sessionId=${previousSessionId}; previousEntries=${previousEntryCount}; entries=${refreshed.entryCount}; bottomChanged=${refreshedBottomSignature !== previousBottomSignature}`);
      this.scrollSessionToBottomIfFollowing(60, 'session_detail_refresh');
    }
  }

  private scrollSessionToBottom(delayMs: number = 50): void {
    this.historyScrollAnchorKey = '';
    this.sessionAutoFollowBottom = true;
    const generation = this.bumpSessionScrollGeneration();
    [delayMs, delayMs + 180, delayMs + 520, delayMs + 1050, delayMs + 1800].forEach((delay: number) => {
      setTimeout(() => {
        if (this.sessionAutoFollowBottom && generation === this.sessionScrollGeneration) {
          this.sessionScroller.scrollEdge(Edge.Bottom);
        }
      }, delay);
    });
  }

  private scrollSessionToBottomIfFollowing(delayMs: number = 50, source: string = 'auto_refresh'): void {
    if (!this.sessionAutoFollowBottom) {
      this.log('info', 'ui.session_scroll.follow_skipped', `source=${source}`);
      return;
    }
    const generation = this.sessionScrollGeneration;
    [delayMs, delayMs + 180, delayMs + 520].forEach((delay: number) => {
      setTimeout(() => {
        if (this.sessionAutoFollowBottom && generation === this.sessionScrollGeneration) {
          this.sessionScroller.scrollEdge(Edge.Bottom);
        }
      }, delay);
    });
  }

  private bumpSessionScrollGeneration(): number {
    this.sessionScrollGeneration += 1;
    return this.sessionScrollGeneration;
  }

  private handleSessionWillScroll(yOffset: number, scrollSource: ScrollSource): void {
    if (scrollSource === ScrollSource.SCROLLER || scrollSource === ScrollSource.SCROLLER_ANIMATION) {
      return;
    }
    if (Math.abs(yOffset) < 0.5) {
      return;
    }
    if (this.sessionAutoFollowBottom) {
      this.log('info', 'ui.session_scroll.manual_detach', `source=${scrollSource}; yOffset=${yOffset}`);
    }
    this.sessionAutoFollowBottom = false;
    this.bumpSessionScrollGeneration();
  }

  private handleSessionScrollEdge(edge: Edge): void {
    if (edge === Edge.Top) {
      void this.loadOlderSessionEntries('scroll_edge_top');
      return;
    }
    if (edge !== Edge.Bottom) {
      return;
    }
    if (!this.sessionAutoFollowBottom) {
      this.log('info', 'ui.session_scroll.follow_resumed', 'edge=bottom');
    }
    this.sessionAutoFollowBottom = true;
  }

  private async loadOlderSessionEntries(source: string): Promise<void> {
    if (this.isLoadingOlderSessionEntries || this.selectedSession === null) {
      return;
    }
    const sessionId = this.selectedSession.id;
    const beforeCursor = this.selectedSession.sync?.cursorStart ?? '';
    if (this.selectedSession.sync?.hasMoreBefore !== true || beforeCursor.length === 0) {
      return;
    }
    this.isLoadingOlderSessionEntries = true;
    this.sessionAutoFollowBottom = false;
    this.bumpSessionScrollGeneration();
    try {
      const older = await BridgeClient.getSessionHistoryPage(
        this.normalizedBridgeUrl(),
        sessionId,
        this.bridgeToken,
        120,
        beforeCursor
      );
      if (this.selectedSession === null || this.selectedSession.id !== sessionId) {
        return;
      }
      const current = this.selectedSession;
      const entries = this.mergeSessionEntryPages(older.entries, current.entries);
      const mergedSync: CodexSessionSync | undefined = older.sync ? {
        mode: older.sync.mode,
        source: older.sync.source,
        filePath: older.sync.filePath,
        fileSize: older.sync.fileSize,
        fileUpdatedAt: older.sync.fileUpdatedAt,
        cursorStart: older.sync.cursorStart,
        cursorEnd: current.sync?.cursorEnd ?? older.sync.cursorEnd,
        hasMoreBefore: older.sync.hasMoreBefore,
        hasMoreAfter: current.sync?.hasMoreAfter ?? older.sync.hasMoreAfter,
        entryCount: entries.length
      } : current.sync;
      const visibleEntries = this.visibleSessionEntries();
      this.historyScrollAnchorKey = entries.length > current.entries.length && visibleEntries.length > 0
        ? this.sessionEntryKey(visibleEntries[0]) : '';
      this.selectedSession = this.sessionDetailWithEntries(current, entries, mergedSync);
      this.log(
        'info',
        'session.history.older_loaded',
        `source=${source}; sessionId=${sessionId}; before=${beforeCursor}; added=${entries.length - current.entries.length}; hasMoreBefore=${this.selectedSession.sync?.hasMoreBefore === true}`
      );
    } catch (error) {
      this.message = `加载更早消息失败：${this.errorText(error)}`;
      this.log(
        'warn',
        'session.history.older_failed',
        `source=${source}; sessionId=${sessionId}; before=${beforeCursor}; message=${this.errorText(error)}`
      );
    } finally {
      this.isLoadingOlderSessionEntries = false;
    }
  }

  private restoreHistoryScrollAnchor(key: string, oldArea: Area, newArea: Area): void {
    if (this.historyScrollAnchorKey !== key) {
      return;
    }
    const delta = Number(newArea.position.y) - Number(oldArea.position.y);
    this.historyScrollAnchorKey = '';
    this.sessionScroller.scrollBy(0, delta);
    this.log('info', 'session.history.anchor_restored', `delta=${delta}`);
  }

  private mergeSessionDetailPreservingHistory(
    current: CodexSessionDetail,
    refreshed: CodexSessionDetail
  ): CodexSessionDetail {
    if (!current.sync || current.entries.length === 0) {
      return refreshed;
    }
    const entries = this.mergeSessionEntryPages(current.entries, refreshed.entries);
    const mergedSync: CodexSessionSync = {
      mode: current.sync.mode,
      source: current.sync.source,
      filePath: current.sync.filePath,
      fileSize: refreshed.sync?.fileSize ?? current.sync.fileSize,
      fileUpdatedAt: refreshed.sync?.fileUpdatedAt ?? current.sync.fileUpdatedAt,
      cursorStart: current.sync.cursorStart,
      cursorEnd: refreshed.sync?.cursorEnd ?? current.sync.cursorEnd,
      hasMoreBefore: current.sync.hasMoreBefore,
      hasMoreAfter: refreshed.sync?.hasMoreAfter ?? current.sync.hasMoreAfter,
      entryCount: entries.length
    };
    return this.sessionDetailWithEntries(refreshed, entries, mergedSync);
  }

  private sessionDetailWithEntries(
    base: CodexSessionDetail,
    entries: CodexSessionEntry[],
    sync: CodexSessionSync | undefined
  ): CodexSessionDetail {
    return {
      id: base.id,
      title: base.title,
      updatedAt: base.updatedAt,
      relativeTime: base.relativeTime,
      projectRoot: base.projectRoot,
      projectLabel: base.projectLabel,
      source: base.source,
      activitySource: base.activitySource,
      activityStatus: base.activityStatus,
      activityUpdatedAt: base.activityUpdatedAt,
      runtimeState: base.runtimeState,
      runtimeSource: base.runtimeSource,
      runtimeUpdatedAt: base.runtimeUpdatedAt,
      activeTurnId: base.activeTurnId,
      canInterrupt: base.canInterrupt,
      terminalReason: base.terminalReason,
      lastVisibleRole: base.lastVisibleRole,
      pinned: base.pinned,
      detailAvailable: base.detailAvailable,
      filePath: base.filePath,
      entries,
      entryCount: base.entryCount,
      sync
    };
  }

  private mergeSessionEntryPages(
    older: CodexSessionEntry[],
    newer: CodexSessionEntry[]
  ): CodexSessionEntry[] {
    const merged: CodexSessionEntry[] = [];
    const positions: Record<string, number> = {};
    [...older, ...newer].forEach((entry: CodexSessionEntry) => {
      const key = entry.syncId && entry.syncId.length > 0
        ? `sync:${entry.syncId}`
        : `entry:${entry.timestamp}:${entry.role}:${entry.type}:${entry.text}`;
      if (positions[key] !== undefined) {
        merged[positions[key]] = entry;
        return;
      }
      positions[key] = merged.length;
      merged.push(entry);
    });
    // A refresh can include history older than the currently loaded recent page.
    return merged.sort((left: CodexSessionEntry, right: CodexSessionEntry): number =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp));
  }

  private applyKeyboardAvoidMode(): void {
    try {
      this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE_WITH_CARET);
      this.log('info', 'ui.keyboard_avoid.enabled', 'mode=RESIZE_WITH_CARET');
    } catch (error) {
      this.log('warn', 'ui.keyboard_avoid.failed', `message=${this.errorText(error)}`);
    }
  }

  private dismissSessionKeyboardAfterSend(source: string): void {
    this.sessionComposerFocused = false;
    this.slashCommandPanelVisible = false;
    this.composerActionMenuExpanded = false;
    try {
      this.sessionTextAreaController.stopEditing();
      this.log('info', 'ui.keyboard.dismissed', `source=${source}; method=text_area_stop_editing`);
      return;
    } catch (error) {
      this.log('warn', 'ui.keyboard.dismiss.stop_editing_failed', `source=${source}; message=${this.errorText(error)}`);
    }
    try {
      this.getUIContext().getFocusController().clearFocus();
      this.log('info', 'ui.keyboard.dismissed', `source=${source}; method=clear_focus`);
    } catch (error) {
      this.log('warn', 'ui.keyboard.dismiss.clear_focus_failed', `source=${source}; message=${this.errorText(error)}`);
    }
  }

  private sessionComposerBottomMargin(): number {
    return 0;
  }

  private sessionComposerBottomShift(): number {
    return this.sessionComposerFocused ? 0 : 16;
  }

  private sessionComposerTextAreaHeight(): number {
    if (this.pendingSessionImages.length > 0 || this.pendingSessionFiles.length > 0 || this.hasActiveComposerToken()) {
      return 78;
    }
    if (this.sessionComposerFocused || this.sessionMessage.trim().length > 0) {
      return 72;
    }
    return 66;
  }

  private sessionBottomSignature(session: CodexSessionDetail): string {
    const last = session.entries.length > 0 ? session.entries[session.entries.length - 1] : null;
    if (last === null) {
      return `${session.entryCount}:empty`;
    }
    return `${session.entryCount}:${last.timestamp}:${last.role}:${last.type}:${last.text.slice(0, 80)}`;
  }

  private syncSessionTaskMarkers(task: BridgeTask | null): void {
    if (task === null) {
      return;
    }
    const sessionId = this.taskSessionId(task);
    if (sessionId.length === 0) {
      return;
    }
    this.rememberTaskForSession(sessionId, task.id, task.status);
    if (this.isTaskRunningStatus(task.status)) {
      this.markSessionRunning(sessionId);
      return;
    }
    if (this.isSyntheticInterruptFailure(task)) {
      this.rememberTaskForSession(sessionId, task.id, task.status);
      return;
    }
    if (this.isTaskTerminalStatus(task.status)) {
      this.unmarkSessionRunning(sessionId);
      if (this.isSessionCurrentlyRead(sessionId)) {
        this.markSessionRead(sessionId);
      } else {
        this.markSessionUnreadCompleted(sessionId);
      }
    }
  }

  private reconcileSessionTaskMonitor(tasks: BridgeTaskSummary[]): void {
    const runningIds: string[] = [];
    tasks.forEach((task: BridgeTaskSummary) => {
      const sessionId = this.taskSummarySessionId(task);
      if (sessionId.length === 0) {
        this.taskStatusById[task.id] = task.status;
        return;
      }

      this.taskSessionById[task.id] = sessionId;
      if ((this.latestTaskIdBySessionId[sessionId] ?? '').length === 0) {
        this.latestTaskIdBySessionId[sessionId] = task.id;
      }

      if (this.isTaskRunningStatus(task.status)) {
        const previousStatus = this.taskStatusById[task.id] ?? '';
        if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
          if (this.isTaskTerminalStatus(previousStatus)) {
            this.taskStatusById[task.id] = previousStatus;
          }
          return;
        }
        this.taskStatusById[task.id] = task.status;
        if (runningIds.indexOf(sessionId) < 0) {
          runningIds.push(sessionId);
        }
        this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => id !== sessionId);
        return;
      }

      const previousStatus = this.taskStatusById[task.id] ?? '';
      this.taskStatusById[task.id] = task.status;
      if (this.isTaskTerminalStatus(task.status) && this.wasTaskPreviouslyRunning(previousStatus)) {
        this.unmarkSessionRunning(sessionId);
        if (this.isSessionCurrentlyRead(sessionId)) {
          this.markSessionRead(sessionId);
        } else {
          this.markSessionUnreadCompleted(sessionId);
        }
        void this.publishTaskCompletionNotificationForSummary(task, sessionId, previousStatus);
      }
    });

    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status)) {
      const currentSessionId = this.taskSessionId(this.currentTask);
      if (currentSessionId.length > 0
        && !this.shouldIgnoreRunningTaskForSession(currentSessionId, this.currentTask.createdAt, this.currentTask.id)
        && runningIds.indexOf(currentSessionId) < 0) {
        runningIds.push(currentSessionId);
      }
    }
    this.setRunningSessionIds(this.mergeKnownRunningSessionIds(runningIds), 'dashboard');
  }

  private reconcileSessionActivityMonitor(sessions: CodexSessionSummary[]): void {
    const taskRunningIds: string[] = [];
    this.tasks.forEach((task: BridgeTaskSummary) => {
      if (!this.isTaskRunningStatus(task.status)) {
        return;
      }
      const sessionId = this.taskSummarySessionId(task);
      if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
        return;
      }
      if (sessionId.length > 0 && taskRunningIds.indexOf(sessionId) < 0) {
        taskRunningIds.push(sessionId);
      }
    });
    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status)) {
      const sessionId = this.taskSessionId(this.currentTask);
      if (sessionId.length > 0
        && !this.shouldIgnoreRunningTaskForSession(sessionId, this.currentTask.createdAt, this.currentTask.id)
        && taskRunningIds.indexOf(sessionId) < 0) {
        taskRunningIds.push(sessionId);
      }
    }

    const runningIds: string[] = [...taskRunningIds];
    const visibleSessionIds: string[] = [...taskRunningIds];
    const previousActivityStatusById = this.sessionActivityStatusById;
    const previousUpdatedAtById = this.sessionUpdatedAtById;
    const nextActivityStatusById: Record<string, string> = {};
    const nextUpdatedAtById: Record<string, string> = {};
    sessions.forEach((session: CodexSessionSummary) => {
      if (visibleSessionIds.indexOf(session.id) < 0) {
        visibleSessionIds.push(session.id);
      }
      const status = this.normalizedSessionActivityStatus(session.activityStatus ?? '');
      const previousStatus = previousActivityStatusById[session.id] ?? '';
      const previousUpdatedAt = previousUpdatedAtById[session.id] ?? '';
      const currentUpdatedAt = session.activityUpdatedAt && session.activityUpdatedAt.length > 0
        ? session.activityUpdatedAt
        : session.updatedAt;
      nextActivityStatusById[session.id] = status;
      nextUpdatedAtById[session.id] = currentUpdatedAt;
      const clearedUpdatedAt = this.clearedRunningSessionUpdatedAtById[session.id] ?? '';

      if (status === 'running' && !(clearedUpdatedAt.length > 0 && clearedUpdatedAt === currentUpdatedAt)) {
        this.clearLocalRunningOverride(session.id);
        if (runningIds.indexOf(session.id) < 0) {
          runningIds.push(session.id);
        }
        this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => id !== session.id);
        return;
      }

      if (status === 'completed') {
        this.clearLocalRunningOverride(session.id);
        if (!this.hasFreshRunningTaskForSession(session.id, currentUpdatedAt)) {
          this.removeSessionIdFromList(runningIds, session.id);
          this.clearStaleCurrentTaskForCompletedSession(session.id, currentUpdatedAt, 'session_activity_completed');
        }
        if (previousStatus.length > 0) {
          const changed = currentUpdatedAt.length > 0 && previousUpdatedAt.length > 0 && currentUpdatedAt !== previousUpdatedAt;
          const justCompleted = previousStatus === 'running';
          if (justCompleted) {
            void this.publishSessionCompletionNotification(session, currentUpdatedAt, previousStatus);
          }
          if ((changed || justCompleted) && !this.isSessionCurrentlyRead(session.id)) {
            this.markSessionUnreadCompleted(session.id);
          }
        }
      }
    });

    this.sessionActivityStatusById = nextActivityStatusById;
    this.sessionUpdatedAtById = nextUpdatedAtById;
    this.pruneSessionMonitorRuntimeState(visibleSessionIds, 'activity');
    this.setRunningSessionIds(this.mergeKnownRunningSessionIds(runningIds), 'activity');
  }

  private syncRunningSessionMarkersFromTaskSummaries(tasks: BridgeTaskSummary[]): void {
    const runningIds: string[] = [];
    tasks.forEach((task: BridgeTaskSummary) => {
      if (!this.isTaskRunningStatus(task.status)) {
        return;
      }
      const sessionId = this.taskSummarySessionId(task);
      if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
        return;
      }
      if (sessionId.length > 0 && runningIds.indexOf(sessionId) < 0) {
        runningIds.push(sessionId);
      }
    });
    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status)) {
      const currentSessionId = this.taskSessionId(this.currentTask);
      if (currentSessionId.length > 0
        && !this.shouldIgnoreRunningTaskForSession(currentSessionId, this.currentTask.createdAt, this.currentTask.id)
        && runningIds.indexOf(currentSessionId) < 0) {
        runningIds.push(currentSessionId);
      }
    }
    this.setRunningSessionIds(runningIds, 'summary');
  }

  private async handleTaskTerminalForSession(task: BridgeTask, previousStatus: string, source: string): Promise<void> {
    this.rememberFailedSessionMessageForTerminalTask(task);
    const sessionId = this.taskSessionId(task);
    if (sessionId.length === 0) {
      return;
    }
    this.taskStatusById[task.id] = task.status;
    this.taskSessionById[task.id] = sessionId;
    this.latestTaskIdBySessionId[sessionId] = task.id;
    this.unmarkSessionRunning(sessionId);
    if (this.isSessionCurrentlyRead(sessionId)) {
      this.markSessionRead(sessionId);
    } else {
      this.markSessionUnreadCompleted(sessionId);
    }
    if (this.wasTaskPreviouslyRunning(previousStatus)) {
      await this.publishTaskCompletionNotificationForTask(task, sessionId, previousStatus, source);
    }
  }

  private wasTaskPreviouslyRunning(status: string): boolean {
    return this.isTaskRunningStatus(status);
  }

  private async adoptRunningTaskFromSummaries(tasks: BridgeTaskSummary[]): Promise<void> {
    if (this.selectedSession !== null || this.isNewSessionDraft) {
      return;
    }
    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status)) {
      return;
    }
    const running = this.latestRunningTaskSummary(tasks);
    if (running === null) {
      return;
    }
    try {
      const task = this.taskUsesCodexRunApi(running)
        ? await BridgeClient.getCodexRun(this.normalizedBridgeUrl(), running.id, this.bridgeToken)
        : await BridgeClient.getTask(this.normalizedBridgeUrl(), running.id, this.bridgeToken);
      this.handoffPendingSessionSend(running.id, task);
      this.currentTask = task;
      this.activeSessionTaskId = task.id;
      this.activeSessionTaskTitle = this.activeTaskTitleFromSummary(running);
      this.syncSessionTaskMarkers(task);
      this.startPolling();
      this.log('info', 'task.running.adopted', `taskId=${task.id}; status=${task.status}; sessionId=${this.taskSessionId(task)}`);
    } catch (error) {
      this.log('error', 'task.running.adopt.failed', `taskId=${running.id}; message=${this.errorText(error)}`);
    }
  }

  private async adoptSelectedSessionTaskFromSummaries(tasks: BridgeTaskSummary[]): Promise<void> {
    if (this.isNewSessionDraft || this.selectedSession === null) {
      return;
    }
    const summary = this.latestTaskSummaryForSession(tasks, this.selectedSession.id);
    if (summary === null) {
      return;
    }
    if (this.currentTask !== null && this.currentTask.id === summary.id) {
      return;
    }
    const currentSelected = this.selectedSession.id;
    if (this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && this.taskSessionId(this.currentTask) === currentSelected
      && this.isTaskNewerThanSummary(this.currentTask, summary)) {
      this.log('info', 'task.selected_session.adopt.skipped_current_newer', `currentTaskId=${this.currentTask.id}; summaryTaskId=${summary.id}; sessionId=${currentSelected}`);
      return;
    }
    const shouldAdopt = this.isTaskRunningStatus(summary.status)
      || (this.currentTask === null
        && this.latestTaskIdBySessionId[currentSelected] === summary.id
        && this.shouldShowTaskPanelForStatus(summary.status));
    if (!shouldAdopt) {
      return;
    }
    try {
      const task = this.taskUsesCodexRunApi(summary)
        ? await BridgeClient.getCodexRun(this.normalizedBridgeUrl(), summary.id, this.bridgeToken)
        : await BridgeClient.getTask(this.normalizedBridgeUrl(), summary.id, this.bridgeToken);
      this.handoffPendingSessionSend(summary.id, task);
      if (this.selectedSession === null || this.selectedSession.id !== currentSelected) {
        return;
      }
      if (this.failedTaskHasCanonicalCompletion(task)) {
        this.currentTask = task;
        this.log('info', 'task.selected_session.adopt.skipped_canonical_completion', `taskId=${task.id}; sessionId=${currentSelected}`);
        return;
      }
      this.currentTask = task;
      this.activeSessionTaskId = task.id;
      this.activeSessionTaskTitle = this.activeTaskTitleFromSummary(summary);
      this.syncSessionTaskMarkers(task);
      if (this.isTaskRunningStatus(task.status)) {
        this.startPolling();
      }
      this.log('info', 'task.selected_session.adopted', `taskId=${task.id}; status=${task.status}; sessionId=${this.taskSessionId(task)}`);
    } catch (error) {
      this.log('warn', 'task.selected_session.adopt.failed', `taskId=${summary.id}; sessionId=${currentSelected}; message=${this.errorText(error)}`);
    }
  }

  private latestRunningTaskSummary(tasks: BridgeTaskSummary[]): BridgeTaskSummary | null {
    let latest: BridgeTaskSummary | null = null;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const sessionId = this.taskSummarySessionId(task);
      if (this.isTaskRunningStatus(task.status)
        && !this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
        if (latest === null || this.isTaskSummaryNewer(task, latest)) {
          latest = task;
        }
      }
    }
    return latest;
  }

  private latestTaskSummaryForSession(tasks: BridgeTaskSummary[], sessionId: string): BridgeTaskSummary | null {
    const normalizedSessionId = sessionId === '__new_session__' ? '' : sessionId;
    let latestRunning: BridgeTaskSummary | null = null;
    let latestAny: BridgeTaskSummary | null = null;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const taskSessionId = this.taskSummarySessionId(task);
      if (normalizedSessionId.length > 0 && taskSessionId !== normalizedSessionId) {
        continue;
      }
      const ignoreRunning = this.isTaskRunningStatus(task.status)
        && this.shouldIgnoreRunningTaskForSession(taskSessionId, task.createdAt, task.id);
      if (this.isTaskRunningStatus(task.status) && !ignoreRunning) {
        if (latestRunning === null || this.isTaskSummaryNewer(task, latestRunning)) {
          latestRunning = task;
        }
      }
      if (ignoreRunning) {
        continue;
      }
      if (latestAny === null || this.isTaskSummaryNewer(task, latestAny)) {
        latestAny = task;
      }
    }
    return latestRunning !== null ? latestRunning : latestAny;
  }

  private isTaskSummaryNewer(left: BridgeTaskSummary, right: BridgeTaskSummary): boolean {
    const leftUpdated = left.updatedAt && left.updatedAt.length > 0 ? left.updatedAt : left.createdAt;
    const rightUpdated = right.updatedAt && right.updatedAt.length > 0 ? right.updatedAt : right.createdAt;
    if (leftUpdated !== rightUpdated) {
      return this.isIsoAfter(leftUpdated, rightUpdated);
    }
    if (left.createdAt !== right.createdAt) {
      return this.isIsoAfter(left.createdAt, right.createdAt);
    }
    return left.id.localeCompare(right.id) > 0;
  }

  private isTaskNewerThanSummary(task: BridgeTask, summary: BridgeTaskSummary): boolean {
    const taskUpdated = task.updatedAt && task.updatedAt.length > 0 ? task.updatedAt : task.createdAt;
    const summaryUpdated = summary.updatedAt && summary.updatedAt.length > 0 ? summary.updatedAt : summary.createdAt;
    if (taskUpdated !== summaryUpdated) {
      return this.isIsoAfter(taskUpdated, summaryUpdated);
    }
    if (task.createdAt !== summary.createdAt) {
      return this.isIsoAfter(task.createdAt, summary.createdAt);
    }
    return task.id.localeCompare(summary.id) > 0;
  }

  private taskSessionId(task: BridgeTask): string {
    const created = task.createdCodexSessionId ?? '';
    if (created.length > 0) {
      return created;
    }
    const existing = task.codexSessionId ?? '';
    return existing.length > 0 ? existing : '';
  }

  private taskSummarySessionId(task: BridgeTaskSummary): string {
    const created = task.createdCodexSessionId ?? '';
    if (created.length > 0) {
      return created;
    }
    const existing = task.codexSessionId ?? '';
    return existing.length > 0 ? existing : '';
  }

  private currentTaskEventCount(task: BridgeTask | null): number {
    if (task === null) {
      return -1;
    }
    if (typeof task.eventCount === 'number') {
      return task.eventCount;
    }
    return task.events.length;
  }

  private currentTaskEventCursor(task: BridgeTask | null): number {
    if (task === null) {
      return 0;
    }
    if (typeof task.eventCursor === 'number') {
      return task.eventCursor;
    }
    let cursor = 0;
    task.events.forEach((event: BridgeEvent) => {
      if (typeof event.seq === 'number' && event.seq > cursor) {
        cursor = event.seq;
      }
    });
    return cursor;
  }

  private mergeTaskEventPage(previous: BridgeTask, incoming: BridgeTask): BridgeTask {
    if (incoming.eventGap === true) {
      return incoming;
    }
    const events: BridgeEvent[] = [];
    const ids: Set<string> = new Set<string>();
    previous.events.concat(incoming.events).forEach((event: BridgeEvent) => {
      if (ids.has(event.id)) {
        return;
      }
      ids.add(event.id);
      events.push(event);
    });
    incoming.events = events;
    return incoming;
  }

  private updateTaskPollCadence(changed: boolean, status: string, eventCount: number): void {
    this.taskPollLastStatus = status;
    this.taskPollLastEventCount = eventCount;
    if (changed || Date.now() - this.taskPollStartedAt < 30000) {
      this.taskPollDelayMs = 2000;
      return;
    }
    this.taskPollDelayMs = 5000;
  }

  private rememberTaskForSession(sessionId: string, taskId: string, status: string): void {
    if (sessionId.length === 0 || taskId.length === 0) {
      return;
    }
    this.taskStatusById[taskId] = status;
    this.taskSessionById[taskId] = sessionId;
    this.latestTaskIdBySessionId[sessionId] = taskId;
  }

  private activeTaskTitleFromSummary(task: BridgeTaskSummary): string {
    if (task.session?.title && task.session.title.length > 0) {
      return task.session.title;
    }
    const sessionId = this.taskSummarySessionId(task);
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index];
      if (session.id === sessionId) {
        return session.title;
      }
    }
    return task.prompt.length > 0 ? task.prompt.slice(0, 18) : '会话任务';
  }

  private markSessionRunning(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    const beforeRunning = this.runningSessionIds.length;
    if (this.runningSessionIds.indexOf(sessionId) < 0) {
      this.runningSessionIds = [...this.runningSessionIds, sessionId];
    }
    const beforeUnread = this.unreadCompletedSessionIds.length;
    this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => id !== sessionId);
    if (beforeRunning !== this.runningSessionIds.length || beforeUnread !== this.unreadCompletedSessionIds.length) {
      this.bumpSessionMonitorRevision();
      this.log('info', 'session.running.marked', `sessionId=${sessionId}; running=${this.runningSessionIds.join(',')}; unread=${this.unreadCompletedSessionIds.join(',')}; revision=${this.sessionMonitorRevision}`);
    }
  }

  private unmarkSessionRunning(sessionId: string): void {
    const before = this.runningSessionIds.length;
    this.runningSessionIds = this.runningSessionIds.filter((id: string) => id !== sessionId);
    if (before !== this.runningSessionIds.length) {
      this.bumpSessionMonitorRevision();
      this.log('info', 'session.running.cleared', `sessionId=${sessionId}; running=${this.runningSessionIds.join(',')}; revision=${this.sessionMonitorRevision}`);
    }
  }

  private markSessionRunningLocallyCleared(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    const updatedAt = this.sessionUpdatedAtById[sessionId] ?? '';
    if (updatedAt.length > 0) {
      this.clearedRunningSessionUpdatedAtById[sessionId] = updatedAt;
    }
    if (this.locallyClearedRunningSessionIds.indexOf(sessionId) < 0) {
      this.locallyClearedRunningSessionIds = [...this.locallyClearedRunningSessionIds, sessionId];
    }
    this.unmarkSessionRunning(sessionId);
    this.bumpSessionMonitorRevision();
    this.log('info', 'session.running.local_cleared', `sessionId=${sessionId}; activityUpdatedAt=${updatedAt}; revision=${this.sessionMonitorRevision}`);
  }

  private clearLocalRunningOverride(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    const before = this.locallyClearedRunningSessionIds.length;
    this.locallyClearedRunningSessionIds = this.locallyClearedRunningSessionIds.filter((id: string) => id !== sessionId);
    const nextCleared: Record<string, string> = {};
    Object.keys(this.clearedRunningSessionUpdatedAtById).forEach((id: string) => {
      if (id !== sessionId) {
        nextCleared[id] = this.clearedRunningSessionUpdatedAtById[id];
      }
    });
    this.clearedRunningSessionUpdatedAtById = nextCleared;
    if (before !== this.locallyClearedRunningSessionIds.length) {
      this.bumpSessionMonitorRevision();
      this.log('info', 'session.running.local_clear_removed', `sessionId=${sessionId}; revision=${this.sessionMonitorRevision}`);
    }
  }

  private markSessionUnreadCompleted(sessionId: string): void {
    if (sessionId.length === 0 || this.unreadCompletedSessionIds.indexOf(sessionId) >= 0) {
      return;
    }
    this.unreadCompletedSessionIds = [...this.unreadCompletedSessionIds, sessionId];
    this.bumpSessionMonitorRevision();
    this.log('info', 'session.unread.marked', `sessionId=${sessionId}; unread=${this.unreadCompletedSessionIds.join(',')}; revision=${this.sessionMonitorRevision}`);
  }

  private markSessionRead(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    const before = this.unreadCompletedSessionIds.length;
    this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => id !== sessionId);
    if (before !== this.unreadCompletedSessionIds.length) {
      this.bumpSessionMonitorRevision();
      this.log('info', 'session.unread.cleared', `sessionId=${sessionId}; unread=${this.unreadCompletedSessionIds.join(',')}; revision=${this.sessionMonitorRevision}`);
    }
  }

  private isSessionRunning(sessionId: string): boolean {
    if (sessionId.length === 0) {
      return false;
    }
    const activityStatus = this.normalizedSessionActivityStatus(this.sessionActivityStatusById[sessionId] ?? '');
    if (activityStatus === 'completed' && !this.hasFreshRunningTaskForSession(sessionId, this.sessionUpdatedAtById[sessionId] ?? '')) {
      return false;
    }
    if (activityStatus === 'running') {
      if (this.locallyClearedRunningSessionIds.indexOf(sessionId) >= 0) {
        return false;
      }
      return true;
    }
    if (this.runningSessionIds.indexOf(sessionId) >= 0) {
      return true;
    }
    if (this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status) && this.taskSessionId(this.currentTask) === sessionId) {
      if (this.shouldIgnoreRunningTaskForSession(sessionId, this.currentTask.createdAt, this.currentTask.id)) {
        return false;
      }
      return true;
    }
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (this.isTaskRunningStatus(task.status) && this.taskSummarySessionId(task) === sessionId) {
        if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  private normalizedSessionActivityStatus(status: string): string {
    const normalized = status.trim().toLowerCase();
    if (normalized === 'running' || normalized === 'inprogress' || normalized === 'in_progress' || normalized === 'queued' || normalized === 'waiting_approval' || normalized === 'waiting_input' || normalized === 'recovering') {
      return 'running';
    }
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'failed' || normalized === 'interrupted') {
      return 'completed';
    }
    return 'idle';
  }

  private sessionActivityUpdatedAt(session: CodexSessionSummary | CodexSessionDetail): string {
    return session.activityUpdatedAt && session.activityUpdatedAt.length > 0 ? session.activityUpdatedAt : session.updatedAt;
  }

  private isLocallyClearedSessionActivity(sessionId: string, activityUpdatedAt: string): boolean {
    if (this.locallyClearedRunningSessionIds.indexOf(sessionId) < 0) {
      return false;
    }
    const clearedUpdatedAt = this.clearedRunningSessionUpdatedAtById[sessionId] ?? '';
    return clearedUpdatedAt.length === 0 || activityUpdatedAt.length === 0 || clearedUpdatedAt === activityUpdatedAt;
  }

  private applySessionActivitySnapshot(session: CodexSessionSummary | CodexSessionDetail, source: string): void {
    const sessionId = session.id;
    if (sessionId.length === 0) {
      return;
    }
    const status = this.normalizedSessionActivityStatus(session.activityStatus ?? '');
    const activityUpdatedAt = this.sessionActivityUpdatedAt(session);
    const previousStatus = this.sessionActivityStatusById[sessionId] ?? '';
    const previousUpdatedAt = this.sessionUpdatedAtById[sessionId] ?? '';
    if (previousStatus !== status || previousUpdatedAt !== activityUpdatedAt) {
      const nextActivityStatusById: Record<string, string> = {};
      Object.keys(this.sessionActivityStatusById).forEach((id: string) => {
        nextActivityStatusById[id] = this.sessionActivityStatusById[id];
      });
      nextActivityStatusById[sessionId] = status;
      this.sessionActivityStatusById = nextActivityStatusById;
      const nextUpdatedAtById: Record<string, string> = {};
      Object.keys(this.sessionUpdatedAtById).forEach((id: string) => {
        nextUpdatedAtById[id] = this.sessionUpdatedAtById[id];
      });
      nextUpdatedAtById[sessionId] = activityUpdatedAt;
      this.sessionUpdatedAtById = nextUpdatedAtById;
      this.log('info', 'session.activity.snapshot', `source=${source}; sessionId=${sessionId}; status=${status}; updatedAt=${activityUpdatedAt}`);
    }
    if (status === 'running' && !this.isLocallyClearedSessionActivity(sessionId, activityUpdatedAt)) {
      this.clearLocalRunningOverride(sessionId);
      this.markSessionRunning(sessionId);
      return;
    }
    if (status === 'completed') {
      this.clearLocalRunningOverride(sessionId);
      this.unmarkSessionRunning(sessionId);
      this.clearStaleCurrentTaskForCompletedSession(sessionId, activityUpdatedAt, `session_activity_${source}`);
      if (this.isSessionCurrentlyRead(sessionId)) {
        this.markSessionRead(sessionId);
      }
    }
  }

  private isSelectedSessionActivityRunning(): boolean {
    if (this.selectedSession === null) {
      return false;
    }
    const sessionId = this.selectedSession.id;
    const cachedStatus = this.normalizedSessionActivityStatus(this.sessionActivityStatusById[sessionId] ?? '');
    const cachedUpdatedAt = this.sessionUpdatedAtById[sessionId] ?? '';
    const activityUpdatedAt = cachedUpdatedAt.length > 0 ? cachedUpdatedAt : this.sessionActivityUpdatedAt(this.selectedSession);
    if (this.isLocallyClearedSessionActivity(sessionId, activityUpdatedAt)) {
      return false;
    }
    if (cachedStatus !== 'idle') {
      return cachedStatus === 'running';
    }
    return this.normalizedSessionActivityStatus(this.selectedSession.activityStatus ?? '') === 'running';
  }

  private isSessionUnreadCompleted(sessionId: string): boolean {
    return this.unreadCompletedSessionIds.indexOf(sessionId) >= 0;
  }

  private sessionActivityState(sessionId: string): string {
    if (this.isSessionRunning(sessionId)) {
      return 'running';
    }
    if (this.isSessionUnreadCompleted(sessionId)) {
      return 'unread';
    }
    return 'idle';
  }

  private sessionSidebarItemKey(session: CodexSessionSummary): string {
    return `${session.id}:${this.sessionActivityState(session.id)}:${this.sessionMonitorRevision}`;
  }

  private setRunningSessionIds(nextIds: string[], source: string): void {
    const uniqueIds: string[] = [];
    nextIds.forEach((id: string) => {
      if (id.length > 0 && uniqueIds.indexOf(id) < 0 && this.shouldKeepRunningSessionCandidate(id)) {
        uniqueIds.push(id);
      }
    });
    uniqueIds.sort();
    const previous = this.runningSessionIds.join(',');
    const next = uniqueIds.join(',');
    if (previous === next) {
      return;
    }
    this.runningSessionIds = uniqueIds;
    this.bumpSessionMonitorRevision();
    this.log('info', 'session.running.reconciled', `source=${source}; running=${next}; revision=${this.sessionMonitorRevision}`);
  }

  private pruneSessionMonitorRuntimeState(validSessionIds: string[], source: string): void {
    const validIds: string[] = [];
    validSessionIds.forEach((id: string) => {
      if (id.length > 0 && validIds.indexOf(id) < 0) {
        validIds.push(id);
      }
    });
    const beforeRunning = this.runningSessionIds.join(',');
    const beforeUnread = this.unreadCompletedSessionIds.join(',');
    const beforeCleared = this.locallyClearedRunningSessionIds.join(',');
    this.runningSessionIds = this.runningSessionIds.filter((id: string) => validIds.indexOf(id) >= 0);
    this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => validIds.indexOf(id) >= 0);
    this.locallyClearedRunningSessionIds = this.locallyClearedRunningSessionIds.filter((id: string) => validIds.indexOf(id) >= 0);
    const nextCleared: Record<string, string> = {};
    Object.keys(this.clearedRunningSessionUpdatedAtById).forEach((id: string) => {
      if (validIds.indexOf(id) >= 0) {
        nextCleared[id] = this.clearedRunningSessionUpdatedAtById[id];
      }
    });
    this.clearedRunningSessionUpdatedAtById = nextCleared;
    const changed = beforeRunning !== this.runningSessionIds.join(',')
      || beforeUnread !== this.unreadCompletedSessionIds.join(',')
      || beforeCleared !== this.locallyClearedRunningSessionIds.join(',');
    if (changed) {
      this.bumpSessionMonitorRevision();
      this.log('info', 'session.monitor.pruned', `source=${source}; valid=${validIds.length}; running=${this.runningSessionIds.join(',')}; unread=${this.unreadCompletedSessionIds.join(',')}; revision=${this.sessionMonitorRevision}`);
    }
  }

  private mergeKnownRunningSessionIds(nextIds: string[]): string[] {
    const merged: string[] = [];
    nextIds.forEach((id: string) => {
      if (id.length > 0 && merged.indexOf(id) < 0 && this.shouldKeepRunningSessionCandidate(id)) {
        merged.push(id);
      }
    });
    Object.keys(this.sessionActivityStatusById).forEach((sessionId: string) => {
      if (this.locallyClearedRunningSessionIds.indexOf(sessionId) >= 0) {
        return;
      }
      if (this.normalizedSessionActivityStatus(this.sessionActivityStatusById[sessionId] ?? '') === 'running' && merged.indexOf(sessionId) < 0) {
        merged.push(sessionId);
      }
    });
    return merged;
  }

  private shouldKeepRunningSessionCandidate(sessionId: string): boolean {
    if (sessionId.length === 0) {
      return false;
    }
    if (this.locallyClearedRunningSessionIds.indexOf(sessionId) >= 0) {
      return false;
    }
    const activityStatus = this.normalizedSessionActivityStatus(this.sessionActivityStatusById[sessionId] ?? '');
    if (activityStatus !== 'completed') {
      return true;
    }
    return this.hasFreshRunningTaskForSession(sessionId, this.sessionUpdatedAtById[sessionId] ?? '');
  }

  private isTaskLocallyTerminalForSession(taskId: string, sessionId: string): boolean {
    if (taskId.length === 0) {
      return false;
    }
    const status = this.taskStatusById[taskId] ?? '';
    if (!this.isTaskTerminalStatus(status)) {
      return false;
    }
    const localSessionId = this.taskSessionById[taskId] ?? '';
    return localSessionId.length === 0 || sessionId.length === 0 || localSessionId === sessionId;
  }

  private shouldIgnoreRunningTaskForSession(sessionId: string, taskCreatedAt: string, taskId: string = ''): boolean {
    if (this.isTaskLocallyTerminalForSession(taskId, sessionId)) {
      return true;
    }
    if (sessionId.length === 0) {
      return false;
    }
    if (this.locallyClearedRunningSessionIds.indexOf(sessionId) >= 0) {
      return true;
    }
    const activityStatus = this.normalizedSessionActivityStatus(this.sessionActivityStatusById[sessionId] ?? '');
    if (activityStatus !== 'completed') {
      return false;
    }
    const sessionUpdatedAt = this.sessionUpdatedAtById[sessionId] ?? '';
    if (sessionUpdatedAt.length === 0 || taskCreatedAt.length === 0) {
      return false;
    }
    return !this.isIsoAfter(taskCreatedAt, sessionUpdatedAt);
  }

  private hasFreshRunningTaskForSession(sessionId: string, sessionUpdatedAt: string): boolean {
    if (sessionId.length === 0 || sessionUpdatedAt.length === 0) {
      return false;
    }
    if (this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && this.taskSessionId(this.currentTask) === sessionId
      && this.isIsoAfter(this.currentTask.createdAt, sessionUpdatedAt)) {
      return true;
    }
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (this.isTaskRunningStatus(task.status)
        && this.taskSummarySessionId(task) === sessionId
        && this.isIsoAfter(task.createdAt, sessionUpdatedAt)) {
        return true;
      }
    }
    return false;
  }

  private removeSessionIdFromList(values: string[], sessionId: string): void {
    let index = values.indexOf(sessionId);
    while (index >= 0) {
      values.splice(index, 1);
      index = values.indexOf(sessionId);
    }
  }

  private isIsoAfter(leftIso: string, rightIso: string): boolean {
    const left = new Date(leftIso).getTime();
    const right = new Date(rightIso).getTime();
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return leftIso.localeCompare(rightIso) > 0;
    }
    return left > right;
  }

  private clearStaleCurrentTaskForCompletedSession(sessionId: string, completedAt: string, source: string): void {
    if (this.currentTask === null || sessionId.length === 0 || completedAt.length === 0) {
      return;
    }
    if (!this.isTaskRunningStatus(this.currentTask.status) || this.taskSessionId(this.currentTask) !== sessionId) {
      return;
    }
    if (this.isIsoAfter(this.currentTask.createdAt, completedAt)) {
      return;
    }
    const taskId = this.currentTask.id;
    this.taskStatusById[taskId] = 'completed';
    this.taskSessionById[taskId] = sessionId;
    this.latestTaskIdBySessionId[sessionId] = taskId;
    this.currentTask = null;
    if (this.activeSessionTaskId === taskId) {
      this.activeSessionTaskId = '';
      this.activeSessionTaskTitle = '';
    }
    this.unmarkSessionRunning(sessionId);
    this.stopPolling();
    this.message = '会话已完成，运行状态已同步';
    this.log('warn', 'task.running.stale_cleared', `source=${source}; taskId=${taskId}; sessionId=${sessionId}; completedAt=${completedAt}`);
  }

  private bumpSessionMonitorRevision(): void {
    this.sessionMonitorRevision = this.sessionMonitorRevision + 1;
    this.syncNotificationBadge('session_monitor_revision');
  }

  private isSessionCurrentlyRead(sessionId: string): boolean {
    return this.selectedSession !== null && this.selectedSession.id === sessionId && this.activeTab === 'sessions' && this.sessionSidebarCollapsed;
  }

  private isTaskRunningStatus(status: string): boolean {
    return status === 'running' || status === 'queued' || status === 'waiting_approval' || status === 'waiting_input' || status === 'recovering';
  }

  private taskUsesAppServer(task: BridgeTask | BridgeTaskSummary): boolean {
    return task.runtime?.kind === 'app_server'
      || task.desktopSync?.status === 'app_server_official'
      || task.desktopSync?.status === 'app_server_fallback';
  }

  private taskUsesCodexRunApi(task: BridgeTask | BridgeTaskSummary): boolean {
    return this.taskUsesAppServer(task)
      || task.runtime?.kind === 'durable_outbox';
  }

  private isTaskTerminalStatus(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'interrupted';
  }

  private applyLatestSessions(latestSessions: CodexSessionSummary[], source: string): void {
    if (this.shouldKeepExistingSessions(latestSessions.length)) {
      this.log('warn', 'sessions.empty_ignored', `source=${source}; current=${this.sessions.length}; lastGood=${this.lastGoodSessionCount}`);
      return;
    }
    if (source === 'dashboard' && this.shouldFreezeSessionList(latestSessions.length)) {
      this.lastGoodSessionCount = Math.max(this.lastGoodSessionCount, latestSessions.length);
      return;
    }
    this.sessions = latestSessions;
    if (this.selectedSession !== null) {
      const selectedSessionId = this.selectedSession.id;
      const latestSelected = latestSessions.find((session: CodexSessionSummary) => session.id === selectedSessionId);
      if (latestSelected !== undefined) {
        this.selectedSession.activityStatus = latestSelected.activityStatus;
        this.selectedSession.activityUpdatedAt = latestSelected.activityUpdatedAt;
        this.selectedSession.runtimeState = latestSelected.runtimeState;
        this.selectedSession.runtimeSource = latestSelected.runtimeSource;
        this.selectedSession.runtimeUpdatedAt = latestSelected.runtimeUpdatedAt;
        this.selectedSession.activeTurnId = latestSelected.activeTurnId;
        this.selectedSession.canInterrupt = latestSelected.canInterrupt;
        this.selectedSession.terminalReason = latestSelected.terminalReason;
        this.selectedSession.updatedAt = latestSelected.updatedAt;
        this.selectedSession.lastVisibleRole = latestSelected.lastVisibleRole;
        this.applySessionActivitySnapshot(latestSelected, source);
      }
    }
    if (latestSessions.length > 0) {
      this.lastGoodSessionCount = latestSessions.length;
    }
  }

  private shouldKeepExistingSessions(latestCount: number): boolean {
    return this.sessions.length > 0 && this.lastGoodSessionCount > 0 && latestCount === 0;
  }

  private shouldFreezeSessionList(latestCount: number): boolean {
    return this.activeTab === 'sessions'
      && !this.sessionSidebarCollapsed
      && this.sessions.length > 0
      && latestCount > 0;
  }

  private stopPolling(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
    this.taskPollStartedAt = 0;
    this.taskPollLastStatus = '';
    this.taskPollLastEventCount = -1;
    this.taskPollDelayMs = 2000;
  }

  private startLogFlusher(): void {
    if (this.logFlushTimer >= 0) {
      return;
    }
    this.logFlushTimer = setInterval(() => {
      void this.flushLogQueue();
    }, 10000);
  }

  private stopLogFlusher(): void {
    if (this.logFlushTimer >= 0) {
      clearInterval(this.logFlushTimer);
      this.logFlushTimer = -1;
    }
  }

  private normalizedBridgeUrl(): string {
    return this.bridgeUrl.trim().replace(/\/$/, '');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve: () => void) => {
      setTimeout(resolve, ms);
    });
  }

  private reasoningEffortValues(): string[] {
    return ['', 'low', 'medium', 'high', 'xhigh'];
  }

  private normalizeReasoningEffort(value: string): string {
    const normalized = value.trim().toLowerCase();
    return this.reasoningEffortValues().indexOf(normalized) >= 0 ? normalized : '';
  }

  private normalizeModel(value: string): string {
    const normalized = value.trim();
    const lower = normalized.toLowerCase();
    if (lower === 'auto' || lower === 'default' || lower === 'none' || lower === 'null') {
      return '';
    }
    return /^[A-Za-z0-9._:/-]+$/.test(normalized) ? normalized : '';
  }

  private modelOptionValues(): CodexModelOption[] {
    const result: CodexModelOption[] = [{
      id: '',
      model: '',
      displayName: '自动',
      description: this.desktopDefaultModel.length > 0 ? `跟随桌面默认：${this.modelDisplayName(this.desktopDefaultModel)}` : '跟随 Codex 桌面默认模型',
      isDefault: false,
      defaultReasoningEffort: '',
      supportedReasoningEfforts: []
    }];
    const seen: string[] = [];
    for (let i = 0; i < this.availableModels.length; i++) {
      const option = this.availableModels[i];
      const id = this.normalizeModel(option.id.length > 0 ? option.id : (option.model ?? ''));
      if (id.length === 0 || seen.indexOf(id) >= 0) {
        continue;
      }
      seen.push(id);
      result.push({
        id,
        model: this.normalizeModel(option.model ?? id) || id,
        displayName: option.displayName.length > 0 ? option.displayName : id,
        description: option.description ?? '',
        isDefault: option.isDefault === true,
        defaultReasoningEffort: this.normalizeReasoningEffort(option.defaultReasoningEffort ?? ''),
        supportedReasoningEfforts: option.supportedReasoningEfforts ?? []
      });
    }
    if (this.desktopDefaultModel.length > 0 && this.availableModels.length === 0) {
      result.push({
        id: this.desktopDefaultModel,
        model: this.desktopDefaultModel,
        displayName: this.desktopDefaultModel,
        description: '当前 Codex 桌面默认模型',
        isDefault: true,
        defaultReasoningEffort: '',
        supportedReasoningEfforts: []
      });
    } else if (this.desktopDefaultModel.length > 0 && seen.indexOf(this.desktopDefaultModel) < 0) {
      result.push({
        id: this.desktopDefaultModel,
        model: this.desktopDefaultModel,
        displayName: this.desktopDefaultModel,
        description: '当前 Codex 桌面默认模型',
        isDefault: true,
        defaultReasoningEffort: '',
        supportedReasoningEfforts: []
      });
    }
    return result;
  }

  private normalizeModelOptions(values: CodexModelOption[]): CodexModelOption[] {
    const result: CodexModelOption[] = [];
    const seen: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const option = values[i];
      const id = this.normalizeModel(option.id.length > 0 ? option.id : (option.model ?? ''));
      if (id.length === 0 || seen.indexOf(id) >= 0) {
        continue;
      }
      seen.push(id);
      result.push({
        id,
        model: this.normalizeModel(option.model ?? id) || id,
        displayName: option.displayName.length > 0 ? option.displayName : id,
        description: option.description ?? '',
        isDefault: option.isDefault === true,
        defaultReasoningEffort: this.normalizeReasoningEffort(option.defaultReasoningEffort ?? ''),
        supportedReasoningEfforts: option.supportedReasoningEfforts ?? []
      });
    }
    return result;
  }

  private modelDisplayName(value: string): string {
    const model = this.normalizeModel(value);
    if (model.length === 0) {
      return '';
    }
    for (let i = 0; i < this.availableModels.length; i++) {
      const option = this.availableModels[i];
      const id = this.normalizeModel(option.id.length > 0 ? option.id : (option.model ?? ''));
      if (id === model) {
        return option.displayName.length > 0 ? option.displayName : model;
      }
    }
    return model;
  }

  private modelShortLabel(value: string): string {
    const model = this.normalizeModel(value);
    if (model.length > 0) {
      return this.modelDisplayName(model);
    }
    if (this.desktopDefaultModel.length > 0) {
      return this.modelDisplayName(this.desktopDefaultModel);
    }
    return '自动模型';
  }

  private modelLabel(option: CodexModelOption): string {
    const id = this.normalizeModel(option.id);
    if (id.length === 0) {
      return '自动';
    }
    return option.displayName.length > 0 ? option.displayName : id;
  }

  private modelDescription(option: CodexModelOption): string {
    const id = this.normalizeModel(option.id);
    if (id.length === 0) {
      return this.desktopDefaultModel.length > 0 ? `跟随桌面默认：${this.modelDisplayName(this.desktopDefaultModel)}` : '跟随 Codex 桌面默认模型';
    }
    if ((option.description ?? '').length > 0) {
      return option.description ?? '';
    }
    return option.isDefault === true ? 'Codex 桌面默认模型' : id;
  }

  private reasoningEffortLabel(value: string): string {
    const effort = this.normalizeReasoningEffort(value);
    if (effort === 'low') {
      return '低';
    }
    if (effort === 'medium') {
      return '中';
    }
    if (effort === 'high') {
      return '高';
    }
    if (effort === 'xhigh') {
      return '极高';
    }
    return '自动';
  }

  private reasoningEffortShortLabel(value: string): string {
    const effort = this.normalizeReasoningEffort(value);
    if (effort.length > 0) {
      return this.reasoningEffortLabel(effort);
    }
    const desktopDefault = this.normalizeReasoningEffort(this.desktopDefaultReasoningEffort);
    if (desktopDefault.length > 0) {
      return this.reasoningEffortLabel(desktopDefault);
    }
    return '自动';
  }

  private reasoningEffortDescription(value: string): string {
    const effort = this.normalizeReasoningEffort(value);
    if (effort === 'low') {
      return '轻量推理，响应更快';
    }
    if (effort === 'medium') {
      return '常规任务平衡';
    }
    if (effort === 'high') {
      return '复杂代码和排障';
    }
    if (effort === 'xhigh') {
      return '重型任务更深入';
    }
    const desktopDefault = this.normalizeReasoningEffort(this.desktopDefaultReasoningEffort);
    if (desktopDefault.length > 0) {
      return `跟随桌面默认：${this.reasoningEffortLabel(desktopDefault)}`;
    }
    return '跟随桌面默认';
  }

  private reasoningEffortDisplayLabel(value: string): string {
    const effort = this.normalizeReasoningEffort(value);
    if (effort.length > 0) {
      return this.reasoningEffortLabel(effort);
    }
    const desktopDefault = this.normalizeReasoningEffort(this.desktopDefaultReasoningEffort);
    if (desktopDefault.length > 0) {
      return `自动·${this.reasoningEffortLabel(desktopDefault)}`;
    }
    return '自动';
  }

  private reasoningEffortSessionId(): string {
    if (this.isNewSessionDraft) {
      return '__new_session__';
    }
    return this.selectedSession?.id ?? '';
  }

  private canChangeReasoningEffort(): boolean {
    return (this.selectedSession !== null || this.isNewSessionDraft) && !this.isSavingReasoningEffort;
  }

  private shouldShowReasoningEffortMenu(): boolean {
    return this.reasoningEffortMenuVisible && (this.selectedSession !== null || this.isNewSessionDraft);
  }

  private async loadSessionReasoningEffort(sessionId: string, force: boolean = false): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    if (!force
      && this.reasoningEffortLoadedSessionId === sessionId
      && Date.now() - this.reasoningEffortLoadedAt < this.modelSettingsCacheTtlMs) {
      return;
    }
    try {
      const settings = await BridgeClient.getSessionSettings(this.normalizedBridgeUrl(), sessionId, this.bridgeToken);
      if (this.selectedSession === null || this.selectedSession.id !== sessionId) {
        return;
      }
      this.sessionModel = this.normalizeModel(settings.model ?? '');
      this.desktopDefaultModel = this.normalizeModel(settings.defaultModel ?? settings.effectiveModel ?? this.desktopDefaultModel);
      this.availableModels = this.normalizeModelOptions(settings.modelOptions ?? this.availableModels);
      this.sessionReasoningEffort = this.normalizeReasoningEffort(settings.reasoningEffort ?? '');
      this.desktopDefaultReasoningEffort = this.normalizeReasoningEffort(settings.defaultReasoningEffort ?? settings.effectiveReasoningEffort ?? this.desktopDefaultReasoningEffort);
      this.reasoningEffortLoadedSessionId = sessionId;
      this.reasoningEffortLoadedAt = Date.now();
      this.log('info', 'session.model_catalog.loaded', `sessionId=${sessionId}; force=${force}; source=${settings.modelCatalogSource ?? 'unknown'}; revision=${settings.modelCatalogRevision ?? 'unknown'}; model=${this.sessionModel || 'auto'}; defaultModel=${this.desktopDefaultModel || 'auto'}; modelCount=${this.availableModels.length}; effort=${this.sessionReasoningEffort || 'auto'}; defaultEffort=${this.desktopDefaultReasoningEffort || 'auto'}; display=${this.modelShortLabel(this.sessionModel)} ${this.reasoningEffortDisplayLabel(this.sessionReasoningEffort)}`);
    } catch (error) {
      this.sessionModel = '';
      this.sessionReasoningEffort = '';
      this.reasoningEffortLoadedSessionId = '';
      this.reasoningEffortLoadedAt = 0;
      this.log('warn', 'session.model_catalog.load_failed', `sessionId=${sessionId}; force=${force}; message=${this.errorText(error)}`);
    }
  }

  private async loadDesktopReasoningDefaults(force: boolean = false): Promise<void> {
    if (!force
      && this.desktopModelDefaultsLoadedAt > 0
      && Date.now() - this.desktopModelDefaultsLoadedAt < this.modelSettingsCacheTtlMs) {
      return;
    }
    try {
      const settings = await BridgeClient.getCodexSettings(this.normalizedBridgeUrl(), this.bridgeToken);
      this.desktopDefaultModel = this.normalizeModel(settings.defaultModel ?? settings.effectiveModel ?? '');
      this.availableModels = this.normalizeModelOptions(settings.modelOptions ?? []);
      this.desktopDefaultReasoningEffort = this.normalizeReasoningEffort(settings.defaultReasoningEffort ?? settings.effectiveReasoningEffort ?? '');
      this.desktopModelDefaultsLoadedAt = Date.now();
      this.log('info', 'session.model_catalog.refreshed', `force=${force}; source=${settings.modelCatalogSource ?? 'unknown'}; revision=${settings.modelCatalogRevision ?? 'unknown'}; defaultModel=${this.desktopDefaultModel || 'auto'}; modelCount=${this.availableModels.length}; defaultEffort=${this.desktopDefaultReasoningEffort || 'auto'}; display=${this.modelShortLabel(this.sessionModel)} ${this.reasoningEffortDisplayLabel(this.sessionReasoningEffort)}`);
    } catch (error) {
      this.desktopModelDefaultsLoadedAt = 0;
      this.log('warn', 'session.model_catalog.refresh_failed', `force=${force}; message=${this.errorText(error)}`);
    }
  }

  private async changeSessionModel(value: string): Promise<void> {
    if (!this.canChangeReasoningEffort()) {
      return;
    }
    const nextModel = this.normalizeModel(value);
    const previousModel = this.sessionModel;
    const sessionId = this.reasoningEffortSessionId();
    this.sessionModel = nextModel;
    this.reasoningEffortMenuVisible = false;
    if (this.isNewSessionDraft || sessionId === '__new_session__') {
      this.message = `新会话模型：${this.modelShortLabel(nextModel)}`;
      this.log('info', 'session.model.draft_changed', `model=${nextModel || 'auto'}; display=${this.modelShortLabel(nextModel)}`);
      return;
    }
    if (sessionId.length === 0) {
      return;
    }
    this.isSavingReasoningEffort = true;
    try {
      const settings = await BridgeClient.updateSessionSettings(
        this.normalizedBridgeUrl(),
        sessionId,
        { model: nextModel, reasoningEffort: this.sessionReasoningEffort },
        this.bridgeToken
      );
      this.sessionModel = this.normalizeModel(settings.model ?? nextModel);
      this.desktopDefaultModel = this.normalizeModel(settings.defaultModel ?? settings.effectiveModel ?? this.desktopDefaultModel);
      this.availableModels = this.normalizeModelOptions(settings.modelOptions ?? this.availableModels);
      this.sessionReasoningEffort = this.normalizeReasoningEffort(settings.reasoningEffort ?? this.sessionReasoningEffort);
      this.desktopDefaultReasoningEffort = this.normalizeReasoningEffort(settings.defaultReasoningEffort ?? settings.effectiveReasoningEffort ?? this.desktopDefaultReasoningEffort);
      this.reasoningEffortLoadedSessionId = sessionId;
      this.message = `模型已设为：${this.modelShortLabel(this.sessionModel)}`;
      this.log('info', 'session.model.saved', `sessionId=${sessionId}; model=${this.sessionModel || 'auto'}; defaultModel=${this.desktopDefaultModel || 'auto'}; display=${this.modelShortLabel(this.sessionModel)}`);
    } catch (error) {
      this.sessionModel = previousModel;
      this.message = `保存模型失败：${this.errorText(error)}`;
      this.log('error', 'session.model.save_failed', `sessionId=${sessionId}; message=${this.errorText(error)}`);
    } finally {
      this.isSavingReasoningEffort = false;
    }
  }

  private async changeReasoningEffort(value: string): Promise<void> {
    if (!this.canChangeReasoningEffort()) {
      return;
    }
    const nextEffort = this.normalizeReasoningEffort(value);
    const previousEffort = this.sessionReasoningEffort;
    const sessionId = this.reasoningEffortSessionId();
    this.sessionReasoningEffort = nextEffort;
    this.reasoningEffortMenuVisible = false;
    if (this.isNewSessionDraft || sessionId === '__new_session__') {
      this.message = `新会话思考强度：${this.reasoningEffortDisplayLabel(nextEffort)}`;
      this.log('info', 'session.reasoning_effort.draft_changed', `effort=${nextEffort || 'auto'}`);
      return;
    }
    if (sessionId.length === 0) {
      return;
    }
    this.isSavingReasoningEffort = true;
    try {
      const settings = await BridgeClient.updateSessionSettings(
        this.normalizedBridgeUrl(),
        sessionId,
        { reasoningEffort: nextEffort },
        this.bridgeToken
      );
      this.sessionReasoningEffort = this.normalizeReasoningEffort(settings.reasoningEffort ?? nextEffort);
      this.sessionModel = this.normalizeModel(settings.model ?? this.sessionModel);
      this.desktopDefaultModel = this.normalizeModel(settings.defaultModel ?? settings.effectiveModel ?? this.desktopDefaultModel);
      this.availableModels = this.normalizeModelOptions(settings.modelOptions ?? this.availableModels);
      this.desktopDefaultReasoningEffort = this.normalizeReasoningEffort(settings.defaultReasoningEffort ?? settings.effectiveReasoningEffort ?? this.desktopDefaultReasoningEffort);
      this.reasoningEffortLoadedSessionId = sessionId;
      this.message = `思考强度已设为：${this.reasoningEffortDisplayLabel(this.sessionReasoningEffort)}`;
      this.log('info', 'session.reasoning_effort.saved', `sessionId=${sessionId}; effort=${this.sessionReasoningEffort || 'auto'}; default=${this.desktopDefaultReasoningEffort || 'auto'}; display=${this.reasoningEffortDisplayLabel(this.sessionReasoningEffort)}`);
    } catch (error) {
      this.sessionReasoningEffort = previousEffort;
      this.message = `保存思考强度失败：${this.errorText(error)}`;
      this.log('error', 'session.reasoning_effort.save_failed', `sessionId=${sessionId}; message=${this.errorText(error)}`);
    } finally {
      this.isSavingReasoningEffort = false;
    }
  }

  private async refreshDesktopLiveStatus(source: string): Promise<void> {
    if (this.desktopLiveChecking) {
      return;
    }
    this.desktopLiveChecking = true;
    try {
      const targetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
      const link: SystemLinkStatus = await BridgeClient.getSystemLinkStatus(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId);
      this.applySystemLinkStatus(link, targetSessionId);
      const status = link.desktop;
      this.log(this.desktopLiveSessionVerified || (status?.desktopLive && !targetSessionId) ? 'info' : 'warn', 'desktop.live.status', `source=${source}; linkSeverity=${this.systemLinkSeverity}; action=${this.systemRepairAction}; state=${this.desktopLiveState}; verified=${this.desktopLiveSessionVerified}; mobileRecoverable=${this.desktopLiveMobileRecoverable}; failureClass=${this.desktopLiveFailureClass}; processMode=${this.desktopLiveProcessMode}; cdpPort=${this.desktopLiveCdpPort}; current=${this.desktopLiveCurrentSessionId}; target=${this.desktopLiveTargetSessionId}; message=${this.desktopLiveMessage}; reason=${this.desktopLiveReason}; hdc=${this.relayStateText}`);
    } catch (error) {
      this.desktopLiveState = 'unavailable';
      this.desktopLiveMessage = '检测桌面实时通道失败';
      this.desktopLiveReason = this.errorText(error);
      this.desktopLiveCurrentSessionId = '';
      this.desktopLiveTargetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
      this.desktopLiveSessionVerified = false;
      this.desktopLiveRequiresDesktopCdp = false;
      this.desktopLiveMobileRecoverable = true;
      this.desktopLiveFailureClass = '';
      this.desktopLiveRecoveryHint = '';
      this.desktopLiveProcessMode = '';
      this.desktopLiveCdpPort = 0;
      this.log('error', 'desktop.live.status.failed', `source=${source}; message=${this.desktopLiveReason}`);
    } finally {
      this.desktopLiveChecking = false;
    }
  }

  private async repairDesktopLiveFromPhone(source: string): Promise<boolean> {
    if (!this.canRepairDesktopLive()) {
      return false;
    }
    const targetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
    this.desktopLiveRestarting = true;
    this.message = '正在从手机端恢复链路';
    this.log('warn', 'system.link.recover.requested', `source=${source}; sessionId=${targetSessionId}`);
    try {
      const link: SystemLinkStatus = await BridgeClient.recoverSystemLink(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId, 'auto');
      this.applySystemLinkStatus(link, targetSessionId);
      const status = link.desktop;
      this.message = link.severity === 'ok'
        ? '链路已恢复，可以继续发送'
        : this.systemLinkMessageText(link);
      this.log(status?.desktopLive ? 'info' : 'warn', 'system.link.recover.completed', `source=${source}; action=${link.recommendedAction ?? ''}; mode=${link.repairMode ?? ''}; repaired=${link.repaired === true}; severity=${link.severity ?? ''}; desktopLive=${status?.desktopLive === true}; state=${this.desktopLiveState}; verified=${this.desktopLiveSessionVerified}; mobileRecoverable=${this.desktopLiveMobileRecoverable}; failureClass=${this.desktopLiveFailureClass}; processMode=${this.desktopLiveProcessMode}; cdpPort=${this.desktopLiveCdpPort}; reason=${this.desktopLiveReason}; hdc=${this.relayStateText}`);
      await this.refreshDashboard(true);
      if (this.selectedSession !== null) {
        await this.loadSessionDetail(this.selectedSession.id);
      }
      return link.severity !== 'blocked' && status?.desktopLive === true;
    } catch (error) {
      this.message = `链路恢复失败：${this.errorText(error)}`;
      this.log('error', 'system.link.recover.failed', `source=${source}; message=${this.errorText(error)}`);
      return false;
    } finally {
      this.desktopLiveRestarting = false;
    }
  }

  private toggleHomeActionMenu(source: string): void {
    if (this.shouldIgnoreHomeActionToggle(source)) {
      return;
    }
    const shouldClose = this.homeActionMenuVisible && this.homeActionMenuSource === source;
    this.homeActionMenuVisible = !shouldClose;
    this.homeActionMenuSource = this.homeActionMenuVisible ? source : '';
    if (this.homeActionMenuVisible) {
      this.homeActionMenuOpenedAt = Date.now();
      this.reasoningEffortMenuVisible = false;
      this.composerActionMenuExpanded = false;
      this.slashCommandPanelVisible = false;
    } else {
      this.homeActionMenuOpenedAt = 0;
      this.themeModeChooserVisible = false;
      this.fontScaleChooserVisible = false;
    }
    this.log('info', 'ui.home_action_menu.toggle', `visible=${this.homeActionMenuVisible}; source=${source}; owner=${this.homeActionMenuSource}`);
  }

  private shouldShowHomeActionMenuInSessionPanel(): boolean {
    return this.homeActionMenuVisible && this.homeActionMenuSource === 'home_header' && this.sessionSidebarCollapsed && this.selectedSession === null && !this.isNewSessionDraft;
  }

  private shouldShowHomeActionMenuInSidebar(): boolean {
    return this.homeActionMenuVisible && this.homeActionMenuSource === 'sidebar_header' && this.isSessionSidebarVisible();
  }

  private shouldIgnoreHomeActionToggle(source: string): boolean {
    const now = Date.now();
    if (this.lastHomeActionToggleSource === source && now - this.lastHomeActionToggleAt < 280) {
      this.log('warn', 'ui.home_action_menu.toggle_ignored', `source=${source}; delta=${now - this.lastHomeActionToggleAt}`);
      return true;
    }
    this.lastHomeActionToggleAt = now;
    this.lastHomeActionToggleSource = source;
    return false;
  }

  private shouldIgnoreHomeActionMenuAction(action: string, source: string): boolean {
    const now = Date.now();
    const key = `${source}:${action}`;
    if (this.homeActionMenuOpenedAt > 0 && now - this.homeActionMenuOpenedAt < 220) {
      this.log('warn', 'ui.home_action_menu.action_ignored', `action=${action}; source=${source}; reason=just_opened; delta=${now - this.homeActionMenuOpenedAt}`);
      return true;
    }
    if (this.lastHomeActionMenuActionKey === key && now - this.lastHomeActionMenuActionAt < 500) {
      this.log('warn', 'ui.home_action_menu.action_ignored', `action=${action}; source=${source}; reason=duplicate; delta=${now - this.lastHomeActionMenuActionAt}`);
      return true;
    }
    this.lastHomeActionMenuActionAt = now;
    this.lastHomeActionMenuActionKey = key;
    return false;
  }

  private canRunHomeAction(action: string): boolean {
    if (action === 'usage') {
      return !this.isLoadingAccountUsage;
    }
    if (action === 'outbox') {
      return !this.isLoadingOutbox;
    }
    if (action === 'new_session') {
      return this.canStartNewSessionDraft();
    }
    if (action === 'refresh') {
      return !this.isPullRefreshingSessions;
    }
    if (action === 'soft_repair') {
      return this.canRepairDesktopLive();
    }
    if (action === 'hard_restart') {
      return !this.desktopLiveRestarting;
    }
    return true;
  }

  private handleHomeAction(action: string, source: string): void {
    if (this.shouldIgnoreHomeActionMenuAction(action, source)) {
      return;
    }
    if (action === 'theme') {
      this.themeModeChooserVisible = !this.themeModeChooserVisible;
      this.fontScaleChooserVisible = false;
      this.log('info', 'ui.theme.menu.toggle', `visible=${this.themeModeChooserVisible}; source=${source}`);
      return;
    }
    if (action === 'font_size') {
      this.fontScaleChooserVisible = !this.fontScaleChooserVisible;
      this.themeModeChooserVisible = false;
      this.log('info', 'ui.font_scale.menu.toggle', `visible=${this.fontScaleChooserVisible}; source=${source}`);
      return;
    }
    this.homeActionMenuVisible = false;
    this.homeActionMenuSource = '';
    this.homeActionMenuOpenedAt = 0;
    this.themeModeChooserVisible = false;
    this.fontScaleChooserVisible = false;
    this.log('info', 'ui.home_action_menu.action', `action=${action}; source=${source}`);
    if (action === 'desktop_monitor') {
      this.openDesktopMonitor(source);
      return;
    }
    if (action === 'usage') {
      this.openAccountUsagePanel(source);
      return;
    }
    if (action === 'outbox') {
      this.openOutboxPanel(source);
      return;
    }
    if (action === 'new_session') {
      this.startNewSessionDraft();
      return;
    }
    if (action === 'refresh') {
      void this.refreshSessions(`home_action_${source}`);
      return;
    }
    if (action === 'soft_repair') {
      void this.repairDesktopLiveFromPhone(`home_action_${source}`);
      return;
    }
    if (action === 'hard_restart') {
      this.confirmHardRestartCodexFromPhone(`home_action_${source}`);
    }
  }

  private openDesktopMonitor(source: string): void {
    this.accountUsagePanelVisible = false;
    this.outboxPanelVisible = false;
    this.reasoningEffortMenuVisible = false;
    this.composerActionMenuExpanded = false;
    this.desktopMonitorVisible = true;
    this.startDesktopMonitorRefresh();
    void this.syncDesktopMonitorDisplay(`open_${source}`);
    this.refreshDesktopMonitor(`open_${source}`);
    this.log('info', 'desktop_monitor.opened', `source=${source}`);
  }

  private closeDesktopMonitor(source: string): void {
    this.desktopMonitorVisible = false;
    this.desktopMonitorKeepScreenOn = false;
    this.stopDesktopMonitorRefresh();
    void this.suspendDesktopMonitorDisplay(`close_${source}`);
    this.log('info', 'desktop_monitor.closed', `source=${source}`);
  }

  private startDesktopMonitorRefresh(): void {
    this.stopDesktopMonitorRefresh();
    if (!this.desktopMonitorVisible || !this.appForeground) {
      return;
    }
    this.desktopMonitorTimer = setInterval(() => {
      void this.refreshDesktopMonitorCycle('timer');
    }, 10_000);
  }

  private stopDesktopMonitorRefresh(): void {
    if (this.desktopMonitorTimer >= 0) {
      clearInterval(this.desktopMonitorTimer);
      this.desktopMonitorTimer = -1;
    }
  }

  private refreshDesktopMonitor(source: string): void {
    void this.refreshDesktopMonitorCycle(source);
  }

  private async refreshDesktopMonitorCycle(source: string): Promise<void> {
    if (!this.desktopMonitorVisible) {
      return;
    }
    const now = Date.now();
    if (this.accountUsage === null || now - this.lastDesktopMonitorUsageRefreshAt >= 60_000) {
      await this.loadCodexAccountUsage(`desktop_monitor_${source}`);
    }
    await this.refreshDashboard(true);
    await this.publishStandbyMonitorSnapshot(`desktop_monitor_${source}`, true);
    await this.syncDesktopMonitorDisplay(`refresh_${source}`);
  }

  private async syncDesktopMonitorDisplay(source: string): Promise<void> {
    if (!this.desktopMonitorVisible || !this.appForeground) {
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const state: DesktopMonitorDisplayState =
        await DesktopMonitorDisplayService.enter(context);
      this.desktopMonitorCharging = state.charging;
      this.desktopMonitorKeepScreenOn = state.keepScreenOn;
      this.desktopMonitorBatteryPercent = state.batteryPercent;
      this.log(
        'info',
        'desktop_monitor.display.ready',
        `source=${source}; charging=${state.charging}; keepScreenOn=${state.keepScreenOn}; battery=${state.batteryPercent}; brightness=system`
      );
    } catch (error) {
      this.desktopMonitorKeepScreenOn = false;
      this.log(
        'warn',
        'desktop_monitor.display.failed',
        `source=${source}; message=${this.errorText(error)}`
      );
    }
  }

  private async suspendDesktopMonitorDisplay(source: string): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      await DesktopMonitorDisplayService.leave(context);
      this.desktopMonitorKeepScreenOn = false;
      this.log('info', 'desktop_monitor.display.suspended', `source=${source}`);
    } catch (error) {
      this.log(
        'warn',
        'desktop_monitor.display.suspend_failed',
        `source=${source}; message=${this.errorText(error)}`
      );
    }
  }

  private usesDarkTheme(): boolean {
    const mode = normalizeThemeMode(this.themeMode);
    if (mode === 'light') {
      return false;
    }
    if (mode === 'system') {
      return this.systemDarkMode;
    }
    return true;
  }

  private theme(): AppThemeTokens {
    return appThemeTokens(this.usesDarkTheme());
  }

  private themeColor(lightColor: string): string {
    return resolveThemeColor(lightColor, this.usesDarkTheme());
  }

  private scaledFontSize(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  private scaledLineHeight(size: number): number {
    return scaleFontSize(size, this.fontScaleMode);
  }

  private applyThemeMode(): void {
    const context = getContext(this) as common.UIAbilityContext;
    let colorMode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    if (this.themeMode === 'light') {
      colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
    } else if (this.themeMode === 'system') {
      colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    }
    context.setColorMode(colorMode);
    this.log('info', 'ui.theme.apply', `mode=${this.themeMode}; dark=${this.usesDarkTheme()}`);
  }

  private changeThemeMode(mode: string): void {
    this.themeMode = normalizeThemeMode(mode);
    this.applyThemeMode();
    this.themeModeChooserVisible = false;
    this.homeActionMenuVisible = false;
    this.homeActionMenuSource = '';
    this.homeActionMenuOpenedAt = 0;
    this.message = `已切换为${themeModeLabel(this.themeMode)}主题`;
    this.log('info', 'ui.theme.changed', `mode=${this.themeMode}`);
  }

  private changeFontScaleMode(mode: string): void {
    this.fontScaleMode = normalizeFontScaleMode(mode);
    this.message = `字体大小：${fontScaleLabel(this.fontScaleMode)} · ${fontScalePercent(this.fontScaleMode)}%`;
    this.log('info', 'ui.font_scale.changed', `mode=${this.fontScaleMode}; percent=${fontScalePercent(this.fontScaleMode)}`);
  }

  private openAccountUsagePanel(source: string): void {
    this.accountUsagePanelVisible = true;
    this.accountUsagePanelOpenedAt = Date.now();
    this.accountUsageError = '';
    this.log('info', 'codex.account_usage.panel.open', `source=${source}`);
    void this.loadCodexAccountUsage(`open_${source}`);
  }

  private closeAccountUsagePanel(source: string): void {
    if (source === 'backdrop' && this.accountUsagePanelOpenedAt > 0 && Date.now() - this.accountUsagePanelOpenedAt < 280) {
      this.log('warn', 'codex.account_usage.panel.close_ignored', `source=${source}; reason=just_opened`);
      return;
    }
    this.accountUsagePanelVisible = false;
    this.accountUsagePanelOpenedAt = 0;
    this.log('info', 'codex.account_usage.panel.close', `source=${source}`);
  }

  private async loadCodexAccountUsage(source: string): Promise<void> {
    if (this.isLoadingAccountUsage) {
      return;
    }
    this.isLoadingAccountUsage = true;
    this.accountUsageError = '';
    try {
      const usage = await BridgeClient.getCodexAccountUsage(this.normalizedBridgeUrl(), this.bridgeToken);
      this.accountUsage = usage;
      this.lastDesktopMonitorUsageRefreshAt = Date.now();
      void this.publishStandbyMonitorSnapshot(`usage_${source}`, true);
      if (usage.ok) {
        this.message = 'Codex 账号用量已刷新';
      } else {
        this.accountUsageError = usage.message ?? '当前无法读取 Codex 账号用量';
        this.message = this.accountUsageError;
      }
      this.log(usage.ok ? 'info' : 'warn', 'codex.account_usage.loaded', `source=${source}; ok=${usage.ok}; status=${usage.status}; provider=${usage.source}; items=${usage.items.length}`);
    } catch (error) {
      this.accountUsageError = `账号用量读取失败：${this.errorText(error)}`;
      this.message = this.accountUsageError;
      this.log('error', 'codex.account_usage.load_failed', `source=${source}; message=${this.errorText(error)}`);
    } finally {
      this.isLoadingAccountUsage = false;
    }
  }

  private openOutboxPanel(source: string): void {
    this.outboxPanelVisible = true;
    this.log('info', 'outbox.panel.open', `source=${source}`);
    void this.loadOutbox();
  }

  private async loadOutbox(): Promise<void> {
    if (this.isLoadingOutbox) {
      return;
    }
    this.isLoadingOutbox = true;
    try {
      const threadId = this.selectedSession?.id ?? '';
      this.outboxItems = await BridgeClient.listOutbox(this.normalizedBridgeUrl(), threadId, this.bridgeToken);
      const drafts: Record<string, string> = {};
      this.outboxItems.forEach((item: BridgeOutboxItem) => {
        drafts[item.id] = item.text;
      });
      this.outboxDrafts = drafts;
      this.log('info', 'outbox.loaded', `threadId=${threadId}; count=${this.outboxItems.length}`);
    } catch (error) {
      this.message = `发送队列读取失败：${this.errorText(error)}`;
      this.log('error', 'outbox.load.failed', this.errorText(error));
    } finally {
      this.isLoadingOutbox = false;
    }
  }

  private outboxDraft(item: BridgeOutboxItem): string {
    return this.outboxDrafts[item.id] ?? item.text;
  }

  private setOutboxDraft(itemId: string, value: string): void {
    const next: Record<string, string> = {};
    Object.keys(this.outboxDrafts).forEach((key: string) => {
      next[key] = this.outboxDrafts[key];
    });
    next[itemId] = value;
    this.outboxDrafts = next;
  }

  private async saveOutboxItem(item: BridgeOutboxItem): Promise<void> {
    try {
      await BridgeClient.updateOutboxItem(this.normalizedBridgeUrl(), item.id, this.outboxDraft(item).trim(), this.bridgeToken);
      await this.loadOutbox();
    } catch (error) {
      this.message = `队列保存失败：${this.errorText(error)}`;
    }
  }

  private async moveOutboxItem(item: BridgeOutboxItem, direction: string): Promise<void> {
    try {
      await BridgeClient.moveOutboxItem(this.normalizedBridgeUrl(), item.id, direction, this.bridgeToken);
      await this.loadOutbox();
    } catch (error) {
      this.message = `队列排序失败：${this.errorText(error)}`;
    }
  }

  private async cancelOutboxItem(item: BridgeOutboxItem): Promise<void> {
    try {
      await BridgeClient.cancelOutboxItem(this.normalizedBridgeUrl(), item.id, this.bridgeToken);
      await this.loadOutbox();
    } catch (error) {
      this.message = `取消失败：${this.errorText(error)}`;
    }
  }

  private async retryOutboxItem(item: BridgeOutboxItem): Promise<void> {
    try {
      await BridgeClient.retryOutboxItem(this.normalizedBridgeUrl(), item.id, this.bridgeToken);
      await this.loadOutbox();
    } catch (error) {
      this.message = `重试失败：${this.errorText(error)}`;
    }
  }

  private outboxStatusLabel(status: string): string {
    if (status === 'queued') return '待发送';
    if (status === 'dispatching') return '发送中';
    if (status === 'failed') return '失败';
    if (status === 'uncertain') return '待核对';
    return status;
  }

  private accountUsageSubtitle(): string {
    if (this.isLoadingAccountUsage) {
      return '正在读取官方 Codex 桌面可见信息';
    }
    if (this.accountUsage === null) {
      return '只读展示，不保存账号凭据';
    }
    const checkedAt = this.accountUsage.checkedAt ?? '';
    if (checkedAt.length === 0) {
      return this.accountUsage.source;
    }
    return `${this.accountUsage.source} · ${this.shortTimeText(checkedAt)}`;
  }

  private confirmHardRestartCodexFromPhone(source: string): void {
    AlertDialog.show({
      title: '重启 Codex 桌面',
      message: '此操作会重启桌面 Codex 并尝试重新注入 CDP。只在普通软恢复无效时使用。',
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '重启',
        action: () => {
          void this.repairDesktopLiveHardFromPhone(source);
        }
      },
      secondaryButton: {
        value: '取消',
        action: () => {
          this.log('info', 'system.repair.hard_cancelled', `source=${source}`);
        }
      }
    });
  }

  private async repairDesktopLiveHardFromPhone(source: string): Promise<boolean> {
    if (this.desktopLiveRestarting) {
      return false;
    }
    const targetSessionId = (!this.isNewSessionDraft && this.selectedSession !== null) ? this.selectedSession.id : '';
    this.desktopLiveRestarting = true;
    this.message = '正在重启 Codex 桌面并恢复链路';
    this.log('warn', 'system.repair.hard_requested', `source=${source}; sessionId=${targetSessionId}`);
    try {
      const system: SystemRepairStatus = await BridgeClient.repairSystemLink(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId, 'hard', true);
      this.applySystemRepairStatus(system, targetSessionId);
      const status = system.desktop;
      const restarted = system.repairMode === 'hard' && system.repaired === true && status?.desktopLive === true;
      this.message = restarted ? 'Codex 已重启并恢复链路' : this.systemRepairMessageText(system);
      this.log(status?.desktopLive ? 'info' : 'warn', 'system.repair.hard_completed', `source=${source}; action=${system.recommendedAction ?? ''}; mode=${system.repairMode ?? ''}; repaired=${system.repaired === true}; desktopLive=${status?.desktopLive === true}; state=${this.desktopLiveState}; cdpPort=${this.desktopLiveCdpPort}; reason=${this.desktopLiveReason}`);
      await this.refreshDashboard(true);
      if (this.selectedSession !== null) {
        await this.loadSessionDetail(this.selectedSession.id);
      }
      return restarted;
    } catch (error) {
      this.message = `重启 Codex 失败：${this.errorText(error)}`;
      this.log('error', 'system.repair.hard_failed', `source=${source}; message=${this.errorText(error)}`);
      return false;
    } finally {
      this.desktopLiveRestarting = false;
    }
  }

  private applySystemRepairStatus(system: SystemRepairStatus, targetSessionId: string): void {
    this.systemRepairAction = system.recommendedAction ?? '';
    this.systemRepairMessage = system.message ?? '';
    this.systemLinkSeverity = system.severity ?? '';
    this.systemLinkRecoverableFromPhone = system.recoverableFromPhone !== false;
    if (system.desktop) {
      this.applyDesktopLiveStatus(system.desktop, targetSessionId);
    }
  }

  private applySystemLinkStatus(link: SystemLinkStatus, targetSessionId: string): void {
    this.systemRepairAction = link.recommendedAction ?? '';
    this.systemRepairMessage = link.message ?? '';
    this.systemLinkSeverity = link.severity ?? '';
    this.systemLinkRecoverableFromPhone = link.recoverableFromPhone !== false;
    this.lastSystemLinkRefreshAt = Date.now();
    if (link.executionMode === 'app_server' || link.desktopRequired === false) {
      this.desktopLiveState = 'not_required';
      this.desktopLiveMessage = 'App Server 主链路已就绪，无需桌面 CDP';
      this.desktopLiveReason = '';
      this.desktopLiveCurrentSessionId = '';
      this.desktopLiveTargetSessionId = targetSessionId;
      this.desktopLiveSessionVerified = false;
      this.desktopLiveRequiresDesktopCdp = false;
      this.desktopLiveMobileRecoverable = true;
      this.desktopLiveFailureClass = '';
      this.desktopLiveRecoveryHint = '';
      this.desktopLiveProcessMode = '';
      this.desktopLiveCdpPort = 0;
    } else if (link.desktop) {
      this.applyDesktopLiveStatus(link.desktop, targetSessionId);
    }
    this.applyRelayStatusFromSystemLink(link);
  }

  private systemRepairMessageText(system: SystemRepairStatus): string {
    if ((system.message ?? '').length > 0) {
      return system.message ?? '';
    }
    if ((system.recommendedAction ?? '').length > 0) {
      return `链路仍需处理：${system.recommendedAction}`;
    }
    return this.desktopLiveStatusText();
  }

  private systemLinkMessageText(link: SystemLinkStatus): string {
    if ((link.recoveryMessage ?? '').length > 0) {
      return link.recoveryMessage ?? '';
    }
    if ((link.message ?? '').length > 0) {
      return link.message ?? '';
    }
    if ((link.recommendedAction ?? '').length > 0) {
      return `链路仍需处理：${link.recommendedAction}`;
    }
    return this.desktopLiveStatusText();
  }

  private applyRelayStatusFromSystemLink(link: SystemLinkStatus): void {
    const hdc = link.hdc ?? {};
    const relay = link.relay ?? {};
    const hdcOk = this.recordBoolean(hdc, 'ok');
    const shellReady = this.recordBoolean(hdc, 'shellReady');
    const proxyListening = this.recordBoolean(hdc, 'proxyListening');
    const connected = this.recordBoolean(hdc, 'connected');
    const relayOk = this.recordBoolean(relay, 'ok');
    const hdcActive = this.recordBoolean(relay, 'hdcActive');
    const phoneWaiting = this.recordBoolean(relay, 'phoneWaiting');
    const pcWaiting = this.recordBoolean(relay, 'pcWaiting');
    const hdcMessage = this.recordString(hdc, 'message');
    const relayMessage = this.recordString(relay, 'message');
    if (hdcOk || shellReady || hdcActive) {
      this.setRelayStateFromBackend('转发中', hdcMessage.length > 0 ? hdcMessage : '电脑 HDC 已接入，shell 可用');
      return;
    }
    if (connected) {
      this.setRelayStateFromBackend('已配对', hdcMessage.length > 0 ? hdcMessage : 'HDC 已连接，正在确认 shell');
      return;
    }
    if (phoneWaiting) {
      this.setRelayStateFromBackend('等待电脑', relayMessage.length > 0 ? relayMessage : '手机在线，等待电脑代理连接');
      return;
    }
    if (pcWaiting) {
      this.setRelayStateFromBackend('重连中', relayMessage.length > 0 ? relayMessage : '电脑在线，等待手机中继重新接入');
      return;
    }
    if (proxyListening || relayOk) {
      this.setRelayStateFromBackend('重连中', hdcMessage.length > 0 ? hdcMessage : relayMessage);
      return;
    }
    if (this.systemLinkSeverity === 'degraded' || this.systemLinkSeverity === 'blocked') {
      const detail = hdcMessage.length > 0 ? hdcMessage : (relayMessage.length > 0 ? relayMessage : '链路状态异常');
      this.setRelayStateFromBackend('错误', detail);
    }
  }

  private setRelayStateFromBackend(state: HdcRelayState, detail: string): void {
    if (detail.length === 0) {
      return;
    }
    if (this.relayStateText !== state || this.relayDetailText !== detail) {
      this.relayStateChangedAt = Date.now();
    }
    this.relayStateText = state;
    this.relayDetailText = detail;
  }

  private recordBoolean(record: Record<string, Object>, key: string): boolean {
    const value = record[key];
    return value === true || `${value}` === 'true';
  }

  private recordString(record: Record<string, Object>, key: string): string {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
    if (value === undefined || value === null) {
      return '';
    }
    return `${value}`;
  }

  private shouldUseHardDesktopLiveRecovery(): boolean {
    return this.desktopLiveRequiresDesktopCdp
      || this.desktopLiveFailureClass === 'codex_plain_no_cdp'
      || this.desktopLiveFailureClass === 'codex_not_running'
      || this.desktopLiveProcessMode === 'plain'
      || this.desktopLiveProcessMode === 'missing';
  }

  private async requiresDesktopLiveForSend(targetSessionId: string, source: string): Promise<boolean> {
    try {
      const runtime: BridgeRuntimeStatus = await BridgeClient.getRuntimeStatus(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId);
      const requiresDesktop = runtime.existingThreadExecution !== 'app_server';
      if (!requiresDesktop) {
        this.applyAppServerPrimaryStatus(targetSessionId, source, runtime.existingThreadExecution);
      }
      this.log('info', 'runtime.send.contract', `source=${source}; sessionId=${targetSessionId}; mode=${runtime.mode}; execution=${runtime.existingThreadExecution}; appServerState=${runtime.appServer?.state ?? ''}; requiresDesktop=${requiresDesktop}`);
      return requiresDesktop;
    } catch (error) {
      const message = this.errorText(error);
      if (message.indexOf('Bridge 协议不兼容') >= 0) {
        this.message = message;
        this.log('error', 'runtime.send.contract.incompatible', `source=${source}; sessionId=${targetSessionId}; message=${message}`);
        throw new Error(message);
      }
      this.log('warn', 'runtime.send.contract.fallback_desktop', `source=${source}; sessionId=${targetSessionId}; message=${message}`);
      return true;
    }
  }

  private async ensureDesktopLiveReadyForSend(targetSessionId: string, source: string): Promise<boolean> {
    this.message = '正在检查并恢复桌面链路';
    try {
      const status: DesktopLiveStatus = await BridgeClient.getDesktopLiveStatus(this.normalizedBridgeUrl(), this.bridgeToken, targetSessionId, true);
      this.applyDesktopLiveStatus(status, targetSessionId);
      const targetReady = status.sessionVerified === true || status.targetVerified === true;
      this.log(status.desktopLive && targetReady ? 'info' : 'warn', 'desktop.live.preflight', `source=${source}; state=${this.desktopLiveState}; visibleSessionVerified=${status.sessionVerified === true}; targetVerified=${status.targetVerified === true}; sendReady=${this.desktopLiveSessionVerified}; recoveryAttempted=${status.recoveryAttempted === true}; recoveryOk=${status.recoveryOk === true}; mobileRecoverable=${this.desktopLiveMobileRecoverable}; failureClass=${this.desktopLiveFailureClass}; processMode=${this.desktopLiveProcessMode}; cdpPort=${this.desktopLiveCdpPort}; reason=${this.desktopLiveReason}`);
      if (status.desktopLive === true && targetReady) {
        return true;
      }
      this.message = this.desktopLiveBlockedText();
      return false;
    } catch (error) {
      this.desktopLiveState = 'unavailable';
      this.desktopLiveMessage = '发送前恢复链路失败';
      this.desktopLiveReason = this.errorText(error);
      this.desktopLiveCurrentSessionId = '';
      this.desktopLiveTargetSessionId = targetSessionId;
      this.desktopLiveSessionVerified = false;
      this.desktopLiveRequiresDesktopCdp = false;
      this.desktopLiveMobileRecoverable = true;
      this.desktopLiveFailureClass = '';
      this.desktopLiveRecoveryHint = '';
      this.desktopLiveProcessMode = '';
      this.desktopLiveCdpPort = 0;
      this.message = `发送前恢复链路失败：${this.desktopLiveReason}`;
      this.log('error', 'desktop.live.preflight.failed', `source=${source}; sessionId=${targetSessionId}; message=${this.desktopLiveReason}`);
      return false;
    }
  }

  private applyDesktopLiveStatus(status: DesktopLiveStatus, targetSessionId: string): void {
    this.desktopLiveState = status.status ?? (status.desktopLive ? 'ready' : 'unavailable');
    this.desktopLiveMessage = status.message ?? (status.desktopLive ? '已连接' : '未连接');
    this.desktopLiveReason = status.reason ?? status.recoveryError ?? '';
    this.desktopLiveCurrentSessionId = status.currentSessionId ?? '';
    this.desktopLiveTargetSessionId = status.targetSessionId ?? targetSessionId;
    this.desktopLiveSessionVerified = status.sessionVerified === true || status.targetVerified === true;
    this.desktopLiveRequiresDesktopCdp = status.requiresDesktopCdp === true;
    this.desktopLiveMobileRecoverable = status.mobileRecoverable !== false;
    this.desktopLiveFailureClass = status.failureClass ?? '';
    this.desktopLiveRecoveryHint = status.recoveryHint ?? '';
    this.desktopLiveProcessMode = status.desktopProcessMode ?? '';
    this.desktopLiveCdpPort = status.cdpPort ?? 0;
  }

  private applyTaskExecutionContract(task: BridgeTask, targetSessionId: string, source: string): void {
    if (this.taskUsesAppServer(task)) {
      this.applyAppServerPrimaryStatus(targetSessionId, source, 'app_server');
      return;
    }
    const sync = task.desktopSync;
    if (sync && sync.desktopLive === true) {
      this.desktopLiveState = sync.sessionVerified === false && sync.targetVerified !== true ? 'ready' : 'verified';
      this.desktopLiveMessage = sync.message ?? '桌面实时通道已连接';
      this.desktopLiveReason = '';
      this.desktopLiveCurrentSessionId = sync.currentSessionId ?? targetSessionId;
      this.desktopLiveTargetSessionId = sync.targetSessionId ?? targetSessionId;
      this.desktopLiveSessionVerified = sync.sessionVerified !== false || sync.targetVerified === true;
      this.desktopLiveRequiresDesktopCdp = false;
      this.desktopLiveMobileRecoverable = true;
      this.desktopLiveFailureClass = '';
      this.desktopLiveRecoveryHint = '';
      this.desktopLiveProcessMode = sync.mode ?? this.desktopLiveProcessMode;
      this.log('info', 'desktop.live.task_contract_applied', `source=${source}; taskId=${task.id}; sessionId=${targetSessionId}; status=${sync.status}; verified=${this.desktopLiveSessionVerified}`);
    }
  }

  private applyAppServerPrimaryStatus(targetSessionId: string, source: string, execution: string): void {
    this.desktopLiveState = 'not_required';
    this.desktopLiveMessage = 'App Server 主链路已就绪，无需桌面 CDP';
    this.desktopLiveReason = '';
    this.desktopLiveCurrentSessionId = targetSessionId;
    this.desktopLiveTargetSessionId = targetSessionId;
    this.desktopLiveSessionVerified = false;
    this.desktopLiveRequiresDesktopCdp = false;
    this.desktopLiveMobileRecoverable = true;
    this.desktopLiveFailureClass = '';
    this.desktopLiveRecoveryHint = '';
    this.desktopLiveProcessMode = execution;
    this.desktopLiveCdpPort = 0;
    this.log('info', 'desktop.live.not_required', `source=${source}; execution=${execution}; sessionId=${targetSessionId}`);
  }

  private async syncDesktopAndRefresh(source: string): Promise<void> {
    if (!this.isNewSessionDraft && this.selectedSession !== null) {
      await this.openDesktopSelectedSession(`${source}_sync`);
      await this.sleep(900);
    }
    await this.refreshDesktopLiveStatus(`${source}_refresh`);
  }

  private async openDesktopSelectedSession(source: string): Promise<void> {
    if (this.selectedSession === null || this.isOpeningDesktopSession) {
      return;
    }
    const sessionId = this.selectedSession.id;
    this.isOpeningDesktopSession = true;
    this.message = '正在请求桌面打开当前会话';
    this.log('info', 'desktop.session.open.requested', `source=${source}; sessionId=${sessionId}`);
    try {
      await BridgeClient.openDesktopSession(this.normalizedBridgeUrl(), sessionId, this.bridgeToken);
      this.message = '已请求桌面 Codex 切到当前会话';
      this.log('info', 'desktop.session.opened', `source=${source}; sessionId=${sessionId}`);
    } catch (error) {
      this.message = `桌面会话同步失败：${this.errorText(error)}`;
      this.log('error', 'desktop.session.open.failed', `source=${source}; sessionId=${sessionId}; message=${this.errorText(error)}`);
    } finally {
      this.isOpeningDesktopSession = false;
    }
  }

  private contentLeftPadding(): number {
    if (this.activeTab !== 'sessions') {
      return 14;
    }
    return this.sessionSidebarCollapsed ? 72 : 186;
  }

  private canCreateTask(): boolean {
    if (this.isBusy || this.prompt.trim().length <= 2) {
      return false;
    }
    if (this.currentTask === null) {
      return true;
    }
    return this.isTaskTerminalStatus(this.currentTask.status);
  }

  private canSendSessionMessage(): boolean {
    if ((!this.isNewSessionDraft && this.selectedSession === null) || this.isBusy || !this.hasSessionDraftContent()) {
      return false;
    }
    if (this.isSendingCurrentSessionMessage()) {
      return false;
    }
    if (!this.isNewSessionDraft && this.selectedSession?.detailAvailable === false) {
      return false;
    }
    if (this.isNewSessionDraft && this.currentTask !== null && this.isTaskRunningStatus(this.currentTask.status) && this.taskSessionId(this.currentTask).length === 0) {
      return false;
    }
    if (this.currentTask === null) {
      return true;
    }
    return true;
  }

  private canPickSessionImage(): boolean {
    if (this.isUploadingImage || this.isBusy) {
      return false;
    }
    if (!this.isNewSessionDraft && this.selectedSession === null) {
      return false;
    }
    if (!this.isNewSessionDraft && this.selectedSession?.detailAvailable === false) {
      return false;
    }
    if (this.currentTask === null) {
      return true;
    }
    return true;
  }

  private canPickSessionFile(): boolean {
    return !this.isPickingFile && this.canPickSessionImage();
  }

  private canOpenComposerActionMenu(): boolean {
    return this.selectedSession !== null || this.isNewSessionDraft;
  }

  private shouldIgnoreComposerActionToggle(): boolean {
    const now = Date.now();
    if (now - this.lastComposerActionToggleAt < 220) {
      this.log('warn', 'ui.composer_action_menu.toggle_ignored', `delta=${now - this.lastComposerActionToggleAt}`);
      return true;
    }
    this.lastComposerActionToggleAt = now;
    return false;
  }

  private adaptiveImagePreviewWidth(): string {
    return this.isLandscapeSessionLayout() ? '88%' : '92%';
  }

  private adaptiveImagePreviewHeight(): string {
    return this.isLandscapeSessionLayout() ? '90%' : '75%';
  }

  private adaptiveImagePreviewRotateButtonX(): string {
    return this.isLandscapeSessionLayout() ? '89%' : '78%';
  }

  private adaptiveImagePreviewCloseButtonX(): string {
    return this.isLandscapeSessionLayout() ? '94%' : '86%';
  }

  private openImagePreview(imageUrl: string, source: string): void {
    this.resetDesktopScreenshotPreviewTransform();
    this.adaptiveImagePreviewLandscape = this.isLandscapeSessionLayout();
    this.previewImageUrl = imageUrl;
    this.log('info', 'ui.image.preview.open', `source=${source}; landscape=${this.adaptiveImagePreviewLandscape}`);
  }

  private closeImagePreview(source: string): void {
    this.previewImageUrl = '';
    this.resetDesktopScreenshotPreviewTransform();
    this.log('info', 'ui.image.preview.close', `source=${source}`);
  }

  private hasOpenImagePreview(): boolean {
    return this.previewImageUrl.length > 0 || this.desktopScreenshotPreviewUrl.length > 0;
  }

  private closeOpenImagePreview(source: string): void {
    if (this.desktopScreenshotPreviewUrl.length > 0) {
      this.closeDesktopScreenshotPreview(source);
      return;
    }
    this.closeImagePreview(source);
  }

  private handleAdaptiveImagePreviewAreaChange(): void {
    const landscape = this.isLandscapeSessionLayout();
    if (landscape === this.adaptiveImagePreviewLandscape) {
      return;
    }
    this.adaptiveImagePreviewLandscape = landscape;
    this.desktopScreenshotOffsetX = 0;
    this.desktopScreenshotOffsetY = 0;
    this.log('info', 'image.preview.orientation_changed', `landscape=${landscape}; scale=${this.desktopScreenshotScale}; rotation=${this.desktopScreenshotRotation}`);
  }

  private canCaptureDesktopScreenshot(): boolean {
    return !this.isCapturingDesktopScreenshot;
  }

  private canAttachDesktopScreenshotDraft(): boolean {
    return !this.isAttachingDesktopScreenshot && !this.isCapturingDesktopScreenshot && this.canPickSessionImage();
  }

  private canRepairDesktopLive(): boolean {
    return !this.desktopLiveRestarting && !this.isSendingSessionMessage;
  }

  private canRestartDesktopLive(): boolean {
    return this.canRepairDesktopLive();
  }

  private async captureDesktopScreenshotPreview(): Promise<void> {
    if (!this.canCaptureDesktopScreenshot()) {
      return;
    }
    this.isCapturingDesktopScreenshot = true;
    this.resetDesktopScreenshotPreviewTransform();
    try {
      const startedAt = Date.now();
      const image: DesktopScreenshotImage = await BridgeClient.captureDesktopScreenshot(this.normalizedBridgeUrl(), this.bridgeToken);
      if (image.base64.trim().length === 0) {
        throw new Error('桌面截图为空');
      }
      this.desktopScreenshotPreviewUrl = this.desktopScreenshotDataUri(image);
      this.adaptiveImagePreviewLandscape = this.isLandscapeSessionLayout();
      const sizeText = image.width && image.height ? `${image.width}x${image.height}` : '主显示器';
      this.desktopScreenshotMetaText = `桌面截图 ${sizeText}，${image.bytes} 字节`;
      this.message = '已获取桌面截图';
      this.log('info', 'desktop.screenshot.preview.open', `bytes=${image.bytes}; width=${image.width ?? 0}; height=${image.height ?? 0}; durationMs=${Date.now() - startedAt}`);
    } catch (error) {
      this.message = `获取桌面截图失败：${this.errorText(error)}`;
      this.log('error', 'desktop.screenshot.preview.failed', `message=${this.errorText(error)}`);
    } finally {
      this.isCapturingDesktopScreenshot = false;
    }
  }

  private closeDesktopScreenshotPreview(source: string): void {
    this.desktopScreenshotPreviewUrl = '';
    this.desktopScreenshotMetaText = '';
    this.resetDesktopScreenshotPreviewTransform();
    this.log('info', 'desktop.screenshot.preview.close', `source=${source}`);
  }

  private zoomDesktopScreenshot(delta: number): void {
    this.setDesktopScreenshotScale(this.desktopScreenshotScale + delta);
    this.log('info', 'desktop.screenshot.preview.zoom', `scale=${this.desktopScreenshotScale}`);
  }

  private setDesktopScreenshotScale(value: number): void {
    const nextScale = Math.max(0.5, Math.min(6, value));
    this.desktopScreenshotScale = Math.round(nextScale * 100) / 100;
  }

  private rotateDesktopScreenshot(delta: number): void {
    const nextRotation = (this.desktopScreenshotRotation + delta) % 360;
    this.desktopScreenshotRotation = nextRotation < 0 ? nextRotation + 360 : nextRotation;
    this.log('info', 'desktop.screenshot.preview.rotate', `rotation=${this.desktopScreenshotRotation}`);
  }

  private resetDesktopScreenshotPreviewTransform(): void {
    this.desktopScreenshotScale = 1;
    this.desktopScreenshotRotation = 0;
    this.desktopScreenshotOffsetX = 0;
    this.desktopScreenshotOffsetY = 0;
  }

  private canInterruptCurrentTask(): boolean {
    return !this.isSendingSessionMessage
      && !this.isInterruptingTask
      && this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && !this.shouldIgnoreRunningTaskForSession(this.taskSessionId(this.currentTask), this.currentTask.createdAt, this.currentTask.id);
  }

  private canInterruptSelectedSessionTask(): boolean {
    if (this.isSendingCurrentSessionMessage() || this.isInterruptingSelectedSessionTask() || this.selectedSession === null || this.isNewSessionDraft) {
      return false;
    }
    return this.selectedSessionInterruptTaskId().length > 0 || this.isSelectedSessionActivityRunning();
  }

  private shouldUseSessionInterruptAction(): boolean {
    return this.canInterruptSelectedSessionTask() && !this.hasSessionDraftContent();
  }

  private isInterruptingSelectedSessionTask(): boolean {
    if (!this.isInterruptingTask) {
      return false;
    }
    if (this.interruptingSessionTargetId.length === 0) {
      return true;
    }
    return this.selectedSession !== null && this.interruptingSessionTargetId === this.selectedSession.id;
  }

  private hasSessionDraftContent(): boolean {
    return this.sessionMessage.trim().length > 1
      || this.pendingSessionImages.length > 0
      || this.pendingSessionFiles.length > 0;
  }

  private isSendingCurrentSessionMessage(): boolean {
    if (!this.isSendingSessionMessage) {
      return false;
    }
    if (this.isNewSessionDraft) {
      return this.sendingSessionTargetId === '__new_session__';
    }
    return this.selectedSession !== null && this.sendingSessionTargetId === this.selectedSession.id;
  }

  private hasInterruptibleSelectedSessionTask(): boolean {
    if (this.selectedSession === null || this.isNewSessionDraft) {
      return false;
    }
    return this.selectedSessionInterruptTaskId().length > 0;
  }

  private selectedSessionInterruptTaskId(): string {
    if (this.selectedSession === null) {
      return '';
    }
    const sessionId = this.selectedSession.id;
    if (this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && this.taskSessionId(this.currentTask) === sessionId) {
      if (this.shouldIgnoreRunningTaskForSession(sessionId, this.currentTask.createdAt, this.currentTask.id)) {
        return '';
      }
      return this.currentTask.id;
    }
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (this.isTaskRunningStatus(task.status) && this.taskSummarySessionId(task) === sessionId) {
        if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
          continue;
        }
        return task.id;
      }
    }
    return '';
  }

  private interruptResultMessage(task: BridgeTask): string {
    if (this.isInterruptFailureTask(task)) {
      const detail = this.interruptFailureText(task);
      return detail.length > 0 ? `中断失败：${detail}` : '中断失败，请先恢复桌面实时连接后重试';
    }
    if (task.interruptDispatching === true) {
      return '已发送中断请求，等待桌面确认';
    }
    if (task.status === 'interrupted') {
      return '已中断当前会话';
    }
    return '已发送中断请求；可以继续输入，新消息会在中断确认后按顺序发送';
  }

  private isInterruptFailureTask(task: BridgeTask): boolean {
    return this.interruptFailureText(task).length > 0
      || (task.latestEvent?.type ?? '') === 'task.interrupt.failed'
      || ((task.latestEvent?.type ?? '') === 'task.failed' && task.syntheticInterrupt === true);
  }

  private isSyntheticInterruptFailure(task: BridgeTask): boolean {
    return task.syntheticInterrupt === true && this.isInterruptFailureTask(task);
  }

  private interruptFailureText(task: BridgeTask): string {
    if (typeof task.interruptError === 'string' && task.interruptError.length > 0) {
      return task.interruptError;
    }
    if (typeof task.error === 'string' && task.error.indexOf('中断失败') >= 0) {
      return task.error.replace(/^中断失败[:：]\s*/, '');
    }
    const latest = task.latestEvent;
    if (latest !== null && latest !== undefined
      && (latest.type === 'task.interrupt.failed' || latest.type === 'task.failed')) {
      const message = latest.payload['message'];
      if (typeof message === 'string' && message.length > 0) {
        return message.replace(/^中断失败[:：]\s*/, '');
      }
    }
    return '';
  }

  private isBridgeTaskInterruptReady(task: BridgeTask): boolean {
    return task.interruptReady === true || this.hasNonEmptyText(task.activeCodexTurnId);
  }

  private isTaskSummaryInterruptReady(task: BridgeTaskSummary): boolean {
    return task.interruptReady === true || this.hasNonEmptyText(task.activeCodexTurnId);
  }

  private hasNonEmptyText(value: string | null | undefined): boolean {
    return value !== undefined && value !== null && value.length > 0;
  }

  private hasRunningTaskForSession(sessionId: string): boolean {
    return this.runningTaskIdForSession(sessionId).length > 0 || this.isSessionRunning(sessionId);
  }

  private hasBridgeRunningTaskForSession(sessionId: string): boolean {
    return this.runningTaskIdForSession(sessionId).length > 0;
  }

  private runningTaskIdForSession(sessionId: string): string {
    if (sessionId.length === 0) {
      return '';
    }
    if (this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && this.taskSessionId(this.currentTask) === sessionId) {
      if (this.shouldIgnoreRunningTaskForSession(sessionId, this.currentTask.createdAt, this.currentTask.id)) {
        return '';
      }
      return this.currentTask.id;
    }
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (this.isTaskRunningStatus(task.status) && this.taskSummarySessionId(task) === sessionId) {
        if (this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
          continue;
        }
        return task.id;
      }
    }
    return '';
  }

  private hasRunningSessionTask(): boolean {
    if (this.currentTask !== null
      && this.isTaskRunningStatus(this.currentTask.status)
      && !this.shouldIgnoreRunningTaskForSession(this.taskSessionId(this.currentTask), this.currentTask.createdAt, this.currentTask.id)) {
      return true;
    }
    return false;
  }

  private hasAnyRunningSession(): boolean {
    if (this.hasRunningSessionTask() || this.runningSessionIds.length > 0) {
      return true;
    }
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (this.isTaskRunningStatus(task.status)) {
        const sessionId = this.taskSummarySessionId(task);
        if (sessionId.length === 0 || !this.shouldIgnoreRunningTaskForSession(sessionId, task.createdAt, task.id)) {
          return true;
        }
      }
    }
    return false;
  }

  private selectedSessionNeedsFastRefresh(): boolean {
    if (this.selectedSession === null || this.isNewSessionDraft) {
      return false;
    }
    return this.hasRunningTaskForSession(this.selectedSession.id)
      || this.normalizedSessionActivityStatus(this.selectedSession.activityStatus ?? '') === 'running';
  }

  private rawPrompt(): string {
    return this.prompt.trim();
  }

  private rawSessionMessage(message: string): string {
    return message.trim();
  }

  private startEmbeddedRelayOnce(): void {
    if (this.relayAutoStarted) {
      return;
    }
    this.relayAutoStarted = true;
    setTimeout(() => {
      this.startEmbeddedRelay();
    }, 300);
  }

  private startRelayWatchdog(): void {
    if (this.relayWatchdogTimer >= 0) {
      return;
    }
    this.relayWatchdogTimer = setInterval(() => {
      this.ensureEmbeddedRelayHealthy();
    }, 10000);
  }

  private startEmbeddedRelay(): void {
    if (this.relayRunning) {
      return;
    }
    const relayPort = Number(DEFAULT_RELAY_PORT);
    const hdcdPort = Number(DEFAULT_HDCD_PORT);
    if (!Number.isFinite(relayPort) || relayPort <= 0 || !Number.isFinite(hdcdPort) || hdcdPort <= 0) {
      this.relayStateText = '错误';
      this.relayDetailText = '中继端口配置无效';
      this.log('error', 'hdc_relay.config.invalid', `relayPort=${DEFAULT_RELAY_PORT}; hdcdPort=${DEFAULT_HDCD_PORT}`);
      return;
    }
    const config = this.currentRelayConfig(relayPort, hdcdPort);
    this.relayRunning = true;
    void this.startRelayBackgroundRunning();
    this.relayTunnel.start(config);
    this.log('info', 'hdc_relay.auto_start', `relay=${config.relayHost}:${config.relayPort}; deviceId=${config.deviceId}; hdcd=${config.hdcdHost}:${config.hdcdPort}`);
  }

  private ensureEmbeddedRelayHealthy(): void {
    const now = Date.now();
    const stateAgeMs = now - this.relayStateChangedAt;
    if (!this.shouldRestartRelay(stateAgeMs)) {
      return;
    }
    if (now - this.relayLastRestartAt < 15000) {
      return;
    }
    const relayPort = Number(DEFAULT_RELAY_PORT);
    const hdcdPort = Number(DEFAULT_HDCD_PORT);
    if (!Number.isFinite(relayPort) || relayPort <= 0 || !Number.isFinite(hdcdPort) || hdcdPort <= 0) {
      this.log('error', 'hdc_relay.watchdog.config_invalid', `relayPort=${DEFAULT_RELAY_PORT}; hdcdPort=${DEFAULT_HDCD_PORT}`);
      return;
    }
    const config = this.currentRelayConfig(relayPort, hdcdPort);
    this.relayLastRestartAt = now;
    this.relayRunning = true;
    this.log('warn', 'hdc_relay.watchdog.restart', `state=${this.relayStateText}; ageMs=${stateAgeMs}; detail=${this.relayDetailText}`);
    void this.startRelayBackgroundRunning();
    this.relayTunnel.restart(config);
  }

  private shouldRestartRelay(stateAgeMs: number): boolean {
    if (this.relayStateText === '已停止' || this.relayStateText === '错误') {
      return true;
    }
    if (this.relayStateText === '连接中' && stateAgeMs > 30000) {
      return true;
    }
    if (this.relayStateText === '重连中' && stateAgeMs > 30000) {
      return true;
    }
    if (this.relayStateText === '等待电脑' && stateAgeMs > 120000) {
      return true;
    }
    return false;
  }

  private currentRelayConfig(relayPort: number, hdcdPort: number): HdcRelayConfig {
    return {
      relayHost: DEFAULT_RELAY_HOST,
      relayPort,
      deviceId: DEFAULT_DEVICE_ID.trim().length > 0 ? DEFAULT_DEVICE_ID.trim() : 'default',
      token: DEFAULT_RELAY_TOKEN,
      hdcdHost: DEFAULT_HDCD_HOST.trim().length > 0 ? DEFAULT_HDCD_HOST.trim() : '127.0.0.1',
      hdcdPort
    };
  }

  private async requestNotificationPermission(): Promise<void> {
    try {
      const enabled = await AppNotificationService.requestPermission();
      await AppNotificationService.syncBadgeNumber(this.unreadCompletedSessionIds.length);
      this.log('info', 'notification.permission.ready', `enabled=${enabled}`);
    } catch (error) {
      this.log('warn', 'notification.permission.failed', this.errorText(error));
    }
  }

  private async publishTaskCompletionNotificationForSummary(task: BridgeTaskSummary, sessionId: string, previousStatus: string): Promise<void> {
    if (this.notifiedTaskIds.indexOf(task.id) >= 0) {
      return;
    }
    const title = task.session?.title ?? this.sessionTitleById(sessionId);
    const failed = task.status === 'failed';
    if (task.status === 'interrupted') {
      return;
    }
    await this.publishTaskCompletionNotification(task.id, sessionId, title, failed, previousStatus, 'dashboard');
  }

  private async publishTaskCompletionNotificationForTask(task: BridgeTask, sessionId: string, previousStatus: string, source: string): Promise<void> {
    if (this.notifiedTaskIds.indexOf(task.id) >= 0) {
      return;
    }
    const title = task.session?.title ?? this.sessionTitleById(sessionId);
    if (task.status === 'interrupted') {
      return;
    }
    await this.publishTaskCompletionNotification(task.id, sessionId, title, task.status === 'failed', previousStatus, source);
  }

  private async publishSessionCompletionNotification(session: CodexSessionSummary, completedAt: string, previousStatus: string): Promise<void> {
    const key = `${session.id}:${completedAt.length > 0 ? completedAt : session.updatedAt}`;
    if (this.notifiedSessionCompletionKeys.indexOf(key) >= 0) {
      return;
    }
    this.notifiedSessionCompletionKeys = [...this.notifiedSessionCompletionKeys, key].slice(-80);
    await this.publishBasicCompletionNotification(session.id, session.title, false, previousStatus, 'session-activity');
  }

  private async publishTaskCompletionNotification(taskId: string, sessionId: string, title: string, failed: boolean, previousStatus: string, source: string): Promise<void> {
    if (this.notifiedTaskIds.indexOf(taskId) >= 0) {
      return;
    }
    this.notifiedTaskIds = [...this.notifiedTaskIds, taskId];
    await this.publishBasicCompletionNotification(sessionId, title, failed, previousStatus, source);
  }

  private async publishBasicCompletionNotification(sessionId: string, title: string, failed: boolean, previousStatus: string, source: string): Promise<void> {
    try {
      await AppNotificationService.publish({
        type: failed ? 'failed' : 'completed',
        sessionId,
        eventId: ''
      }, this.unreadCompletedSessionIds.length);
      this.log('info', 'notification.session.completed', `sessionId=${sessionId}; failed=${failed}; previous=${previousStatus}; source=${source}; privacy=generic`);
    } catch (error) {
      this.log('error', 'notification.session.failed', `sessionId=${sessionId}; source=${source}; message=${this.errorText(error)}`);
    }
  }

  private async publishTaskAttentionNotification(task: BridgeTask, previousStatus: string): Promise<void> {
    if (task.status !== 'waiting_approval' && task.status !== 'waiting_input') {
      return;
    }
    const sessionId = this.taskSessionId(task);
    const requestId = task.status === 'waiting_input'
      ? (task.pendingUserInput?.id ?? task.id)
      : (this.pendingApprovalId() || task.id);
    const type = task.status === 'waiting_input' ? 'user_input_required' : 'approval_required';
    const key = `${type}:${sessionId}:${requestId}`;
    if (this.notifiedAttentionKeys.indexOf(key) >= 0) {
      return;
    }
    this.notifiedAttentionKeys = [...this.notifiedAttentionKeys, key].slice(-100);
    try {
      await AppNotificationService.publish(
        { type, sessionId, eventId: requestId },
        this.unreadCompletedSessionIds.length
      );
      this.log('info', 'notification.attention.published', `type=${type}; sessionId=${sessionId}; eventId=${requestId}; previous=${previousStatus}`);
    } catch (error) {
      this.log('warn', 'notification.attention.failed', `type=${type}; sessionId=${sessionId}; message=${this.errorText(error)}`);
    }
  }

  private async publishConnectionNotification(): Promise<void> {
    if (Date.now() - this.lastConnectionNotificationAt < 300000) {
      return;
    }
    this.lastConnectionNotificationAt = Date.now();
    try {
      await AppNotificationService.publish({
        type: 'connection_error',
        sessionId: this.selectedSession?.id ?? '',
        eventId: ''
      }, this.unreadCompletedSessionIds.length);
      this.log('warn', 'notification.connection.published', 'privacy=generic');
    } catch (error) {
      this.log('warn', 'notification.connection.failed', this.errorText(error));
    }
  }

  private async applyPendingNotificationNavigation(): Promise<void> {
    const revision = this.notificationTargetRevision.trim();
    const sessionId = this.notificationTargetSessionId.trim();
    if (revision.length === 0 || revision === this.lastHandledNotificationRevision || sessionId.length === 0) {
      return;
    }
    const target = this.sessions.find((session: CodexSessionSummary) => session.id === sessionId);
    if (!target) {
      return;
    }
    this.lastHandledNotificationRevision = revision;
    this.activeTab = 'sessions';
    this.showTaskEventDetails = this.notificationTargetEventId.trim().length > 0;
    await this.openSession(target);
    this.scrollSessionToBottomIfFollowing(80, 'notification_deep_link');
    this.log('info', 'notification.deep_link.opened', `sessionId=${sessionId}; type=${this.notificationTargetEventType}; eventId=${this.notificationTargetEventId}`);
    this.notificationTargetSessionId = '';
    this.notificationTargetEventType = '';
    this.notificationTargetEventId = '';
  }

  private syncNotificationBadge(source: string): void {
    void AppNotificationService.syncBadgeNumber(this.unreadCompletedSessionIds.length)
      .catch((error: Error) => {
        this.log(
          'warn',
          'notification.badge.sync_failed',
          `source=${source}; unread=${this.unreadCompletedSessionIds.length}; message=${this.errorText(error)}`
        );
      });
  }

  private async startRelayBackgroundRunning(): Promise<void> {
    if (this.relayBackgroundRunning) {
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const state = await AppBackgroundRuntimeService.ensureRunning(context, 'index_relay');
      this.relayBackgroundRunning = state.running;
      this.log(
        'info',
        'hdc_relay.background.started',
        `source=${state.source}; startedAt=${state.startedAt}; detail=${state.detail}`
      );
    } catch (error) {
      this.log('error', 'hdc_relay.background.failed', this.errorText(error));
    }
  }

  private relaySummaryText(): string {
    return `无线 HDC：${this.relayStateText} · ${this.relayDetailText} · ${this.relayToHdcdBytes}/${this.hdcdToRelayBytes} B`;
  }

  private relaySummaryColor(): string {
    if (this.relayStateText === '转发中' || this.relayStateText === '已配对') {
      return this.themeColor('#137333');
    }
    if (this.relayStateText === '错误') {
      return this.themeColor('#B42318');
    }
    if (this.relayStateText === '等待电脑' || this.relayStateText === '连接中' || this.relayStateText === '重连中') {
      return this.themeColor('#A15C00');
    }
    return this.themeColor('#68717D');
  }

  private async copySessionText(entry: CodexSessionEntry): Promise<void> {
    const text = this.sessionEntryVisibleText(entry);
    try {
      await ContentActionService.copyText(text);
      this.message = '文本已复制';
      this.log('info', 'session.content.text_copied', `length=${text.length}`);
    } catch (error) {
      this.message = `复制文本失败：${this.errorText(error)}`;
      this.log('error', 'session.content.text_copy_failed', `message=${this.errorText(error)}`);
    }
  }

  private async copySessionPresentationText(text: string, label: string): Promise<void> {
    try {
      await ContentActionService.copyText(text);
      this.message = `${label}已复制`;
      this.log('info', 'session.presentation.text_copied', `label=${label}; length=${text.length}`);
    } catch (error) {
      this.message = `复制${label}失败：${this.errorText(error)}`;
      this.log('error', 'session.presentation.text_copy_failed', `label=${label}; message=${this.errorText(error)}`);
    }
  }

  private async shareSessionText(entry: CodexSessionEntry): Promise<void> {
    const text = this.sessionEntryVisibleText(entry);
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await ContentActionService.shareText(context, text, this.selectedSession?.title ?? 'Codex 消息');
      this.message = '已打开系统分享';
      this.log('info', 'session.content.text_shared', `length=${text.length}`);
    } catch (error) {
      this.message = `分享文本失败：${this.errorText(error)}`;
      this.log('error', 'session.content.text_share_failed', `message=${this.errorText(error)}`);
    }
  }

  private async copySessionImage(imageUrl: string): Promise<void> {
    try {
      await ContentActionService.copyImage(imageUrl, this.bridgeToken);
      this.message = '图片已复制';
      this.log('info', 'session.content.image_copied', `url=${imageUrl}`);
    } catch (error) {
      this.message = `复制图片失败：${this.errorText(error)}`;
      this.log('error', 'session.content.image_copy_failed', `url=${imageUrl}; message=${this.errorText(error)}`);
    }
  }

  private async shareSessionImage(imageUrl: string): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await ContentActionService.shareImage(
        context,
        imageUrl,
        this.bridgeToken,
        this.selectedSession?.title ?? 'Codex 图片'
      );
      this.message = '已打开系统分享';
      this.log('info', 'session.content.image_shared', `url=${imageUrl}`);
    } catch (error) {
      this.message = `分享图片失败：${this.errorText(error)}`;
      this.log('error', 'session.content.image_share_failed', `url=${imageUrl}; message=${this.errorText(error)}`);
    }
  }

  private async openSessionMarkdownLink(href: string): Promise<void> {
    const remotePath = String(href ?? '').trim();
    const sessionId = this.selectedSession?.id ?? '';
    if (this.remoteFileActionBusy) {
      this.message = '正在处理另一个电脑端文件';
      return;
    }
    if (sessionId.length === 0) {
      this.message = '请先打开文件所在的会话';
      return;
    }
    if (!this.isDesktopFileLink(remotePath)) {
      this.message = '当前只支持下载会话中的电脑端本地文件';
      this.log('warn', 'session.remote_file.unsupported_link', `scheme=${this.linkScheme(remotePath)}`);
      return;
    }

    this.remoteFileActionBusy = true;
    this.message = '正在读取电脑端文件信息';
    try {
      const file = await BridgeClient.getRemoteSessionFileMetadata(
        this.normalizedBridgeUrl(),
        sessionId,
        remotePath,
        this.bridgeToken
      );
      this.confirmRemoteFileDownload(file, remotePath, sessionId);
      this.message = '';
    } catch (error) {
      const detail = this.errorText(error);
      this.message = `无法下载文件：${detail}`;
      this.showRemoteFileError('无法下载文件', detail);
      this.log('error', 'session.remote_file.metadata_failed', `message=${detail}`);
    } finally {
      this.remoteFileActionBusy = false;
    }
  }

  private showRemoteFileError(title: string, detail: string): void {
    AlertDialog.show({
      title,
      message: detail,
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '知道了',
        action: () => {}
      }
    });
  }

  private confirmRemoteFileDownload(file: RemoteSessionFile, remotePath: string, sessionId: string): void {
    const markdownFile = MarkdownDocumentService.isMarkdownFile(file);
    AlertDialog.show({
      title: '下载电脑端文件？',
      message: markdownFile
        ? `文件：${file.fileName}\n大小：${this.formatAttachmentBytes(file.bytes)}\n来源：当前 Codex 会话\n\n确认后将下载到手机，并在应用内 Markdown 阅读器中打开。远程图片不会自动加载。`
        : `文件：${file.fileName}\n大小：${this.formatAttachmentBytes(file.bytes)}\n来源：当前 Codex 会话\n\n确认后将下载到手机，并打开支持该格式的应用。`,
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '取消',
        action: () => {
          this.log('info', 'session.remote_file.cancelled', `fileName=${file.fileName}`);
        }
      },
      secondaryButton: {
        value: '下载并打开',
        action: () => {
          void this.downloadAndOpenRemoteFile(file, remotePath, sessionId);
        }
      }
    });
  }

  private async downloadAndOpenRemoteFile(
    file: RemoteSessionFile,
    remotePath: string,
    sessionId: string
  ): Promise<void> {
    if (this.remoteFileActionBusy) {
      this.message = '正在处理另一个电脑端文件';
      return;
    }
    this.remoteFileActionBusy = true;
    this.message = `正在下载 ${file.fileName}`;
    const context = getContext(this) as common.UIAbilityContext;
    try {
      const downloadUrl = BridgeClient.remoteSessionFileDownloadUrl(
        this.normalizedBridgeUrl(),
        sessionId,
        remotePath
      );
      const downloaded = await ContentActionService.downloadRemoteFile(
        context,
        downloadUrl,
        this.bridgeToken,
        file
      );
      this.log('info', 'session.remote_file.downloaded', `fileName=${file.fileName}; bytes=${downloaded.bytes}`);
      this.message = `${file.fileName} 已下载到手机`;
      if (MarkdownDocumentService.isMarkdownFile(downloaded)) {
        try {
          const document = MarkdownDocumentService.readDownloadedMarkdown(downloaded);
          document.sourceRemotePath = remotePath;
          document.sourceSessionId = sessionId;
          this.markdownReaderDocument = document;
          this.message = `${file.fileName} 已在 Markdown 阅读器中打开`;
          this.log(
            'info',
            'session.remote_file.markdown_opened',
            `fileName=${file.fileName}; bytes=${downloaded.bytes}; headings=${document.outline.length}`
          );
          return;
        } catch (error) {
          this.log(
            'warn',
            'session.remote_file.markdown_open_failed',
            `fileName=${file.fileName}; message=${this.errorText(error)}`
          );
          this.message = `${file.fileName} 已下载，应用内阅读失败，正在尝试其他应用`;
        }
      }
      try {
        await ContentActionService.openRemoteFile(context, downloaded);
        this.message = `${file.fileName} 已下载并打开`;
        this.log('info', 'session.remote_file.opened', `fileName=${file.fileName}; openType=${file.openType}`);
      } catch (error) {
        this.message = `${file.fileName} 已下载，但没有找到可打开此格式的应用`;
        this.log('warn', 'session.remote_file.open_failed', `fileName=${file.fileName}; message=${this.errorText(error)}`);
      }
    } catch (error) {
      this.message = `下载文件失败：${this.errorText(error)}`;
      this.log('error', 'session.remote_file.download_failed', `fileName=${file.fileName}; message=${this.errorText(error)}`);
    } finally {
      this.remoteFileActionBusy = false;
    }
  }

  private closeMarkdownReader(source: string): void {
    const fileName = this.markdownReaderDocument?.fileName ?? '';
    this.markdownReaderDocument = null;
    this.log('info', 'session.remote_file.markdown_closed', `source=${source}; fileName=${fileName}`);
  }

  private async copyMarkdownReaderText(): Promise<void> {
    const document = this.markdownReaderDocument;
    if (document === null) {
      return;
    }
    try {
      await ContentActionService.copyText(document.content);
      this.message = 'Markdown 全文已复制';
      this.log('info', 'session.remote_file.markdown_copied', `fileName=${document.fileName}; length=${document.content.length}`);
    } catch (error) {
      this.message = `复制 Markdown 失败：${this.errorText(error)}`;
      this.log('error', 'session.remote_file.markdown_copy_failed', `message=${this.errorText(error)}`);
    }
  }

  private async shareMarkdownReaderFile(): Promise<void> {
    const document = this.markdownReaderDocument;
    if (document === null) {
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await ContentActionService.shareRemoteFile(context, document, document.fileName);
      this.message = '已打开系统分享';
      this.log('info', 'session.remote_file.markdown_shared', `fileName=${document.fileName}`);
    } catch (error) {
      this.message = `分享 Markdown 失败：${this.errorText(error)}`;
      this.log('error', 'session.remote_file.markdown_share_failed', `message=${this.errorText(error)}`);
    }
  }

  private async openMarkdownReaderInOtherApp(): Promise<void> {
    const document = this.markdownReaderDocument;
    if (document === null) {
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await ContentActionService.openRemoteFile(context, document);
      this.message = '已交给其他应用打开';
      this.log('info', 'session.remote_file.markdown_external_opened', `fileName=${document.fileName}`);
    } catch (error) {
      this.message = `没有找到可打开此文件的应用：${this.errorText(error)}`;
      this.log('warn', 'session.remote_file.markdown_external_open_failed', `message=${this.errorText(error)}`);
    }
  }

  private handleMarkdownReaderLink(href: string): void {
    const normalized = String(href ?? '').trim().replace(/^<|>$/g, '');
    if (normalized.length === 0) {
      return;
    }
    if (this.isDesktopFileLink(normalized)) {
      void this.openSessionMarkdownLink(normalized);
      return;
    }
    const scheme = this.linkScheme(normalized);
    if (scheme === 'http' || scheme === 'https') {
      this.confirmExternalMarkdownLink(normalized);
      return;
    }
    this.message = `为保护设备，未打开 ${scheme} 链接`;
    this.log('warn', 'session.remote_file.markdown_link_blocked', `scheme=${scheme}`);
  }

  private confirmExternalMarkdownLink(url: string): void {
    AlertDialog.show({
      title: '打开外部链接？',
      message: `该链接来自电脑端 Markdown 文件：\n${url}\n\n确认后将交给系统浏览器打开。`,
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '取消',
        action: () => {
          this.log('info', 'session.remote_file.markdown_link_cancelled', `scheme=${this.linkScheme(url)}`);
        }
      },
      secondaryButton: {
        value: '继续打开',
        action: () => {
          void this.openConfirmedExternalMarkdownLink(url);
        }
      }
    });
  }

  private async openConfirmedExternalMarkdownLink(url: string): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await ContentActionService.openExternalLink(context, url);
      this.message = '已打开外部链接';
      this.log('info', 'session.remote_file.markdown_link_opened', `scheme=${this.linkScheme(url)}`);
    } catch (error) {
      this.message = `无法打开链接：${this.errorText(error)}`;
      this.log('error', 'session.remote_file.markdown_link_failed', `message=${this.errorText(error)}`);
    }
  }

  private isDesktopFileLink(value: string): boolean {
    const normalized = String(value ?? '').trim().replace(/^<|>$/g, '');
    return /^[A-Za-z]:[\\/]/.test(normalized) || /^file:\/\/\/[A-Za-z]:\//i.test(normalized);
  }

  private linkScheme(value: string): string {
    const match = String(value ?? '').trim().match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    return match ? match[1].toLowerCase() : 'relative';
  }

  private errorText(error: Error | Object | string): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return JSON.stringify(error);
  }

  private log(level: string, event: string, detail: string): void {
    if (this.shouldSkipSampledLog(level, event, detail)) {
      return;
    }
    const payload = new AppLogPayload();
    payload.source = 'harmony-app';
    payload.level = level;
    payload.event = event;
    payload.data = `sessionId=${this.logSessionId}; appMessage=${this.message}; currentTaskId=${this.currentTask?.id ?? ''}; currentTaskStatus=${this.currentTask?.status ?? 'idle'}; ${detail}`;
    this.pendingLogs.push(payload);
    if (this.pendingLogs.length > 100) {
      this.pendingLogs.shift();
    }
    if (level === 'error') {
      console.error(`[CodexRemote] ${event} ${payload.data}`);
    } else {
      console.info(`[CodexRemote] ${event} ${payload.data}`);
    }
    if (level === 'error') {
      void this.flushLogQueue();
    }
  }

  private async flushLogQueue(): Promise<void> {
    if (this.isFlushingLogs || this.pendingLogs.length === 0) {
      return;
    }

    this.isFlushingLogs = true;
    try {
      while (this.pendingLogs.length > 0) {
        const batch = this.pendingLogs.slice(0, 50);
        await this.uploadLogBatchWithFallback(batch);
        this.pendingLogs.splice(0, batch.length);
      }
    } catch (err) {
      console.warn(`[CodexRemote] log upload pending: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isFlushingLogs = false;
    }
  }

  private async uploadLogBatchWithFallback(batch: AppLogPayload[]): Promise<void> {
    try {
      await BridgeClient.uploadLogs(this.normalizedBridgeUrl(), batch, this.bridgeToken);
      return;
    } catch (_) {
    }
    for (let index = 0; index < batch.length; index += 1) {
      await BridgeClient.uploadLog(this.normalizedBridgeUrl(), batch[index], this.bridgeToken);
    }
  }

  private shouldSkipSampledLog(level: string, event: string, detail: string): boolean {
    if (level === 'error') {
      return false;
    }
    if (event.startsWith('ui.session_scroll.')) {
      return true;
    }
    if (event === 'hdc_relay.state') {
      return !this.shouldKeepSampledLog(event, this.hdcRelayStateLogSignature(detail), 60000);
    }
    if (event === 'session.detail.auto_refreshed') {
      return detail.indexOf('bottomChanged=true') < 0 && !this.shouldKeepSampledLog(event, detail, 60000);
    }
    return false;
  }

  private shouldKeepSampledLog(event: string, signature: string, minIntervalMs: number): boolean {
    const now = Date.now();
    const previousSignature = this.sampledLogSignatureByEvent[event] ?? '';
    const previousAt = this.sampledLogAtByEvent[event] ?? 0;
    if (signature !== previousSignature || now - previousAt >= minIntervalMs) {
      this.sampledLogSignatureByEvent[event] = signature;
      this.sampledLogAtByEvent[event] = now;
      return true;
    }
    return false;
  }

  private hdcRelayStateLogSignature(detail: string): string {
    return String(detail ?? '')
      .replace(/; relayToHdcdBytes=\d+/g, '')
      .replace(/; hdcdToRelayBytes=\d+/g, '');
  }

  private visibleEvents(): BridgeEvent[] {
    if (this.currentTask === null) {
      return [];
    }
    return this.visibleTaskEvents().slice(-8).reverse();
  }

  private visibleSessionTaskEvents(): BridgeEvent[] {
    const task = this.selectedVisibleTask();
    if (task === null) {
      return [];
    }
    return this.visibleTaskEventsForTask(task).slice(-4).reverse();
  }

  private visibleTaskEvents(): BridgeEvent[] {
    if (this.currentTask === null) {
      return [];
    }
    return this.visibleTaskEventsForTask(this.currentTask);
  }

  private visibleTaskEventsForTask(task: BridgeTask): BridgeEvent[] {
    return task.events.filter((event: BridgeEvent) => !this.isDiagnosticOnlyEvent(event));
  }

  private isDiagnosticOnlyEvent(event: BridgeEvent): boolean {
    if (event.payload['diagnosticOnly'] === true) {
      return true;
    }
    return event.type === 'codex.desktop_live.poll_failed'
      || event.type === 'codex.desktop_live.thread_poll_failed'
      || event.type === 'codex.app_server.thread.final_read_failed'
      || event.type === 'codex.desktop_live.noise_clear_failed';
  }

  private hasSelectedSessionTask(): boolean {
    return this.selectedVisibleTask() !== null;
  }

  private hasNewSessionTask(): boolean {
    return this.isNewSessionDraft
      && this.currentTask !== null
      && this.currentTask.id === this.newSessionTaskId
      && !this.shouldIgnoreRunningTaskForSession(this.taskSessionId(this.currentTask), this.currentTask.createdAt, this.currentTask.id);
  }

  private selectedVisibleTask(): BridgeTask | null {
    if (this.currentTask === null) {
      return null;
    }
    if (this.isTaskRunningStatus(this.currentTask.status)
      && this.shouldIgnoreRunningTaskForSession(this.taskSessionId(this.currentTask), this.currentTask.createdAt, this.currentTask.id)) {
      return null;
    }
    if (this.isNewSessionDraft) {
      return this.currentTask.id === this.newSessionTaskId ? this.currentTask : null;
    }
    if (this.selectedSession === null) {
      return null;
    }
    if (this.taskSessionId(this.currentTask) !== this.selectedSession.id) {
      return null;
    }
    if (this.failedTaskHasCanonicalCompletion(this.currentTask)) {
      return null;
    }
    return this.currentTask;
  }

  private failedTaskHasCanonicalCompletion(task: BridgeTask): boolean {
    if (task.status !== 'failed' || this.selectedSession === null || this.taskSessionId(task) !== this.selectedSession.id) {
      return false;
    }
    const expected = this.normalizedFailedMessageText(task.prompt);
    if (expected.length === 0) {
      return false;
    }
    const entries = this.selectedSession.entries;
    let promptIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role !== 'user') {
        continue;
      }
      if (this.normalizedFailedMessageText(entry.text) === expected) {
        promptIndex = index;
        break;
      }
    }
    if (promptIndex < 0) {
      return false;
    }
    return entries.some((entry: CodexSessionEntry, index: number) => {
      return index > promptIndex
        && entry.role === 'assistant'
        && this.normalizedFailedMessageText(entry.text).length > 0;
    });
  }

  private shouldShowSessionFloatingStatus(): boolean {
    if (this.selectedSession === null && !this.isNewSessionDraft) {
      return false;
    }
    return this.pendingApprovalId().length > 0
      || this.desktopLiveState === 'mismatch'
      || this.desktopLiveState === 'unverified'
      || this.desktopLiveState === 'unavailable'
      || this.isInterruptingTask;
  }

  private shouldShowSelectedSessionTaskPanel(): boolean {
    return this.hasSelectedSessionTask() && this.shouldShowTaskPanelForTask(this.selectedVisibleTask());
  }

  private shouldShowNewSessionTaskPanel(): boolean {
    return this.hasNewSessionTask() && this.shouldShowTaskPanel();
  }

  private shouldShowTaskPanelForTask(task: BridgeTask | null): boolean {
    if (task === null) {
      return false;
    }
    return this.shouldShowTaskPanelForStatus(task.status);
  }

  private shouldShowTaskPanelForStatus(status: string): boolean {
    return status === 'running'
      || status === 'queued'
      || status === 'waiting_approval'
      || status === 'waiting_input'
      || status === 'recovering'
      || status === 'failed';
  }

  private sessionFloatingStatusIsRunning(): boolean {
    if (this.isInterruptingTask) {
      return true;
    }
    const task = this.selectedVisibleTask();
    return task !== null
      && this.isTaskRunningStatus(task.status)
      && !this.shouldIgnoreRunningTaskForSession(this.taskSessionId(task), task.createdAt, task.id);
  }

  private sessionFloatingStatusTitle(): string {
    if (this.isInterruptingTask) {
      return '正在中断当前会话';
    }
    if (this.pendingApprovalId().length > 0) {
      return '需要你确认';
    }
    const task = this.selectedVisibleTask();
    if (task !== null
      && this.isTaskRunningStatus(task.status)
      && !this.shouldIgnoreRunningTaskForSession(this.taskSessionId(task), task.createdAt, task.id)) {
      return `Codex ${this.statusLabel(task.status)}`;
    }
    if (this.desktopLiveState === 'mismatch' || this.desktopLiveState === 'unverified' || this.desktopLiveState === 'unavailable') {
      return this.desktopLiveStatusText();
    }
    return this.compactDisplayText(this.message, 60);
  }

  private sessionFloatingStatusDetail(): string {
    if (this.pendingApprovalId().length > 0) {
      return this.pendingApprovalSummary();
    }
    const task = this.selectedVisibleTask();
    if (task !== null) {
      return this.taskSummaryText(task);
    }
    return this.desktopLiveStatusText();
  }

  private sessionFloatingStatusColor(): string {
    if (this.pendingApprovalId().length > 0 || this.isInterruptingTask) {
      return this.themeColor('#B42318');
    }
    const task = this.selectedVisibleTask();
    if (task !== null && task.status === 'failed') {
      return this.themeColor('#B42318');
    }
    if (task !== null && task.status === 'interrupted') {
      return this.themeColor('#68717D');
    }
    if (this.sessionFloatingStatusIsRunning()) {
      return this.themeColor('#1F6FEB');
    }
    return this.desktopLiveStatusColor();
  }

  private selectedSessionTaskEventCount(): number {
    const task = this.selectedVisibleTask();
    return task === null ? 0 : task.events.length;
  }

  private shouldOpenSlashCommandPanel(value: string): boolean {
    const trimmed = value.trimStart();
    return (trimmed.startsWith('/') || trimmed.startsWith('$')) && trimmed.indexOf('\n') < 0 && trimmed.length <= 60;
  }

  private openSlashCommandPanelFromButton(): void {
    if (this.selectedSession === null && !this.isNewSessionDraft) {
      return;
    }
    if (this.slashIndexItems.length === 0) {
      void this.refreshSlashIndex();
    }
    if (!this.sessionMessage.trimStart().startsWith('/')) {
      this.sessionMessage = '/';
    }
    this.slashCommandPanelVisible = true;
    this.log('info', 'ui.slash_command.open_button', `sessionId=${this.selectedSession?.id ?? ''}; isNew=${this.isNewSessionDraft}`);
  }

  private shouldShowSlashCommandPanel(): boolean {
    return this.slashCommandPanelVisible
      && (this.selectedSession !== null || this.isNewSessionDraft);
  }

  private slashCommandQuery(): string {
    const trimmed = this.sessionMessage.trimStart();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('$')) {
      return '';
    }
    const first = trimmed.split(/\s+/)[0];
    return first.toLowerCase();
  }

  private visibleSlashItems(): SlashIndexItem[] {
    const items = this.slashIndexItems.length > 0 ? this.slashIndexItems : this.defaultSlashIndexItems();
    const query = this.slashCommandQuery();
    const trigger = this.slashCommandTrigger();
    const candidateItems = trigger === '$' ? items.filter((item: SlashIndexItem) => item.type === 'skill') : items;
    if (query.length <= 1) {
      return candidateItems.slice(0, 40);
    }
    const keyword = this.normalizeSlashSearchKeyword(query);
    return candidateItems
      .filter((item: SlashIndexItem) => this.slashItemMatches(item, keyword))
      .slice(0, 40);
  }

  private slashPanelListHeight(): number {
    const itemCount = this.visibleSlashItems().length;
    if (itemCount === 0) {
      return 76;
    }
    const rowHeight = 48;
    const maxHeight = this.sessionComposerFocused ? 154 : 218;
    return Math.min(maxHeight, Math.max(58, itemCount * rowHeight));
  }

  private activeComposerToken(): string {
    const trimmed = this.sessionMessage.trimStart();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('$')) {
      return '';
    }
    return trimmed.split(/\s+/)[0].toLowerCase();
  }

  private hasActiveComposerToken(): boolean {
    const token = this.activeComposerToken();
    if (token.length <= 1) {
      return false;
    }
    const items = this.slashIndexItems.length > 0 ? this.slashIndexItems : this.defaultSlashIndexItems();
    return items.some((item: SlashIndexItem) => item.insertText.toLowerCase() === token);
  }

  private isActiveSlashItem(item: SlashIndexItem): boolean {
    const activeToken = this.activeComposerToken();
    return activeToken.length > 1 && item.insertText.toLowerCase() === activeToken;
  }

  private slashItemPrimaryColor(item: SlashIndexItem): string {
    if (this.isActiveSlashItem(item)) {
      return this.themeColor('#1F6FEB');
    }
    return item.type === 'skill' ? this.themeColor('#7A4D00') : this.themeColor('#17202A');
  }

  private slashItemTitleColor(item: SlashIndexItem): string {
    return this.isActiveSlashItem(item) ? this.themeColor('#1F6FEB') : this.themeColor('#17202A');
  }

  private slashItemDescriptionColor(item: SlashIndexItem): string {
    return this.isActiveSlashItem(item) ? this.themeColor('#2F6FBE') : this.themeColor('#68717D');
  }

  private slashPanelTitle(): string {
    return this.slashCommandTrigger() === '$' ? '技能补全' : '命令与技能';
  }

  private slashCommandTrigger(): string {
    const trimmed = this.sessionMessage.trimStart();
    if (trimmed.startsWith('$')) {
      return '$';
    }
    return '/';
  }

  private normalizeSlashSearchKeyword(value: string): string {
    let keyword = value.trim().toLowerCase();
    while (keyword.startsWith('/') || keyword.startsWith('$')) {
      keyword = keyword.slice(1);
    }
    return keyword;
  }

  private slashItemMatches(item: SlashIndexItem, keyword: string): boolean {
    const normalized = this.normalizeSlashSearchKeyword(keyword);
    if (normalized.length === 0) {
      return true;
    }
    return item.name.toLowerCase().indexOf(normalized) >= 0
      || item.insertText.toLowerCase().indexOf(normalized) >= 0
      || item.title.toLowerCase().indexOf(normalized) >= 0
      || item.description.toLowerCase().indexOf(normalized) >= 0;
  }

  private allSlashCommands(): string[] {
    const commands: string[] = [];
    const items = this.slashIndexItems.length > 0 ? this.slashIndexItems : this.defaultSlashIndexItems();
    items.forEach((item: SlashIndexItem) => {
      if (item.type === 'command') {
        commands.push(item.insertText);
      }
    });
    return commands;
  }

  private defaultSlashIndexItems(): SlashIndexItem[] {
    const names = ['/help', '/new', '/sessions', '/refresh', '/status', '/sync', '/interrupt', '/stop', '/approve', '/deny', '/image', '/clear'];
    const descriptions = ['显示所有可用斜杠指令', '新建一个 Codex 会话', '返回会话列表', '刷新当前会话和会话列表', '刷新并显示当前链路状态', '请求桌面端切到当前会话', '中断当前正在运行的会话', '中断当前正在运行的会话', '同意当前待确认操作', '拒绝当前待确认操作', '选择图片，先放入发送区', '清空输入框和待发送图片'];
    const titles = ['帮助', '新建会话', '会话列表', '刷新', '状态', '同步桌面', '中断', '停止', '同意', '拒绝', '图片', '清空'];
    const items: SlashIndexItem[] = [];
    names.forEach((name: string, index: number) => {
      items.push({
        id: `cmd:${name.slice(1)}`,
        type: 'command',
        name,
        insertText: name,
        title: titles[index],
        description: descriptions[index]
      });
    });
    return items;
  }

  private tryRunSlashCommandFromComposer(): boolean {
    const trimmed = this.sessionMessage.trim();
    if (!trimmed.startsWith('/')) {
      return false;
    }
    const command = trimmed.split(/\s+/)[0].toLowerCase();
    if (this.allSlashCommands().indexOf(command) < 0) {
      this.message = `未知斜杠指令：${command}`;
      this.slashCommandPanelVisible = true;
      this.log('warn', 'ui.slash_command.unknown', `command=${command}; sessionId=${this.selectedSession?.id ?? ''}; isNew=${this.isNewSessionDraft}`);
      return true;
    }
    this.applySlashCommand(command);
    return true;
  }

  private applySlashItem(item: SlashIndexItem): void {
    if (item.type === 'command') {
      this.applySlashCommand(item.insertText);
      return;
    }
    if (item.type === 'skill') {
      this.sessionMessage = this.replaceComposerLeadingToken(item.insertText);
      this.slashCommandPanelVisible = false;
      this.message = `已插入技能：${item.name}`;
      this.log('info', 'ui.slash_skill.inserted', `name=${item.name}; path=${item.path ?? ''}`);
    }
  }

  private replaceComposerLeadingToken(insertText: string): string {
    const source = this.sessionMessage;
    const leadingLength = source.length - source.trimStart().length;
    const leading = source.slice(0, leadingLength);
    const trimmed = source.trimStart();
    const rest = trimmed.replace(/^[/$]\S*/, '').trimStart();
    return rest.length > 0 ? `${leading}${insertText} ${rest}` : `${leading}${insertText} `;
  }

  private applySlashCommand(command: string): void {
    this.slashCommandPanelVisible = false;
    this.log('info', 'ui.slash_command.apply', `command=${command}; sessionId=${this.selectedSession?.id ?? ''}; isNew=${this.isNewSessionDraft}`);
    if (command === '/help') {
      this.message = `可用指令：${this.allSlashCommands().join(' ')}`;
      return;
    }
    if (command === '/new') {
      this.startNewSessionDraft();
      return;
    }
    if (command === '/sessions') {
      this.returnToSessionHome('slash_sessions');
      return;
    }
    if (command === '/refresh') {
      void this.refreshSessionsAndSelectedSession();
      return;
    }
    if (command === '/status') {
      this.sessionStatusExpanded = true;
      void this.refreshDashboard(true);
      return;
    }
    if (command === '/sync') {
      if (this.selectedSession !== null) {
        void this.syncDesktopAndRefresh('slash_sync');
      }
      return;
    }
    if (command === '/interrupt' || command === '/stop') {
      if (this.canInterruptSelectedSessionTask()) {
        void this.interruptSelectedSessionTask();
      } else {
        this.message = '当前会话没有可中断任务';
      }
      return;
    }
    if (command === '/approve') {
      this.decidePendingApprovalFromSlash('approved');
      return;
    }
    if (command === '/deny') {
      this.decidePendingApprovalFromSlash('denied');
      return;
    }
    if (command === '/image') {
      void this.pickSessionImageDraft();
      return;
    }
    if (command === '/clear') {
      this.sessionMessage = '';
      this.pendingSessionImages = [];
      this.pendingSessionFiles = [];
      this.message = '已清空输入区';
      return;
    }
    this.sessionMessage = `${command} `;
  }

  private async refreshSessionsAndSelectedSession(): Promise<void> {
    await this.refreshSessions();
    if (this.selectedSession !== null) {
      await this.refreshSelectedSessionDetail();
    }
    this.message = '已刷新会话';
    this.log('info', 'ui.slash_command.refresh_done', `sessionId=${this.selectedSession?.id ?? ''}; count=${this.sessions.length}`);
  }

  private decidePendingApprovalFromSlash(decision: string): void {
    const approvalId = this.pendingApprovalId();
    if (approvalId.length <= 0) {
      this.message = '当前没有待确认操作';
      this.log('info', 'ui.slash_command.approval_missing', `decision=${decision}`);
      return;
    }
    void this.decideApproval(approvalId, decision);
  }

  private sessionComposerTargetText(): string {
    if (this.isNewSessionDraft) {
      return '目标：新建 Codex 会话';
    }
    if (this.selectedSession !== null) {
      return `发送目标：${this.selectedSession.projectLabel ?? '未归类'} / ${this.selectedSession.title} / ${this.shortSessionId(this.selectedSession.id)}`;
    }
    return '请先选择目标会话';
  }

  private desktopLiveStatusText(): string {
    if (this.desktopLiveChecking) {
      return '桌面实时连接：检测中';
    }
    if (this.desktopLiveState === 'verified' || this.desktopLiveSessionVerified) {
      return '桌面实时连接：已校验当前会话';
    }
    if (this.desktopLiveState === 'mismatch') {
      const current = this.desktopLiveCurrentSessionId.length > 0 ? this.shortSessionId(this.desktopLiveCurrentSessionId) : '未知';
      return `桌面会话不匹配：当前 ${current}，点同步后重检`;
    }
    if (this.desktopLiveState === 'unverified') {
      return '桌面实时连接：已连接但未确认当前会话，点同步后重检';
    }
    if (this.desktopLiveState === 'ready') {
      return '桌面实时连接：已连接';
    }
    if (this.desktopLiveState === 'not_required') {
      return 'App Server 主链路：已连接（无需桌面 CDP）';
    }
    if (this.desktopLiveState === 'unavailable') {
      if (this.desktopLiveRequiresDesktopCdp || !this.desktopLiveMobileRecoverable) {
        const hint = this.desktopLiveRecoveryHint.length > 0
          ? this.compactDisplayText(this.desktopLiveRecoveryHint, 92)
          : '当前 Codex 未带 CDP 启动，手机端无法软恢复';
        return `桌面实时连接：不可手机恢复，${hint}`;
      }
      const reason = this.desktopLiveReason.length > 0 ? `，原因：${this.compactDisplayText(this.desktopLiveReason, 80)}` : '';
      return `桌面实时连接：未连接${reason}，请先重检或同步`;
    }
    return '桌面实时连接：未检测';
  }

  private desktopLiveStatusColor(): string {
    if (this.desktopLiveState === 'verified' || this.desktopLiveState === 'not_required' || this.desktopLiveSessionVerified) {
      return this.themeColor('#137333');
    }
    if (this.desktopLiveState === 'mismatch' || this.desktopLiveState === 'unverified') {
      return this.themeColor('#9A6700');
    }
    if (this.desktopLiveState === 'unavailable') {
      return this.themeColor('#B42318');
    }
    return this.themeColor('#68717D');
  }

  private desktopLiveBlockedText(): string {
    const reason = this.desktopLiveReason.length > 0 ? `原因：${this.desktopLiveReason}` : this.desktopLiveMessage;
    if (this.desktopLiveState === 'mismatch') {
      return '桌面当前会话与手机选择会话不一致，已阻止发送，避免串线。请点同步桌面后重试。';
    }
    if (this.desktopLiveState === 'unverified') {
      return '桌面实时通道已连接，但还没有校验到当前会话，已阻止发送。请点同步桌面后重试。';
    }
    if (this.desktopLiveRequiresDesktopCdp || !this.desktopLiveMobileRecoverable) {
      return this.desktopLiveRecoveryHint.length > 0
        ? `桌面链路不可手机恢复，已阻止发送。${this.desktopLiveRecoveryHint}`
        : '桌面 Codex 未带 CDP 启动，手机端无法软恢复，已阻止发送。请用桌面一键入口启动后重试。';
    }
    return `桌面实时连接未校验，已阻止发送。${reason}`;
  }

  private canSubmitExistingSessionToDesktop(): boolean {
    return this.desktopLiveSessionVerified;
  }

  private canSubmitNewSessionToDesktop(): boolean {
    return this.desktopLiveState === 'ready'
      || this.desktopLiveState === 'verified'
      || this.desktopLiveSessionVerified;
  }

  private sessionSendButtonText(): string {
    if (this.isNewSessionDraft) {
      return '发送并新建会话';
    }
    if (this.selectedSession !== null) {
      return '发送到当前会话';
    }
    return '发送';
  }

  private sessionPrimaryActionText(): string {
    const mode = this.sessionPrimaryActionMode();
    if (mode === 'interrupt') {
      return '中断当前会话';
    }
    if (mode === 'guidance_send') {
      return '发送引导并打断';
    }
    if (mode === 'sending') {
      return '正在发送';
    }
    if (mode === 'interrupting') {
      return '正在中断';
    }
    return this.sessionSendButtonText();
  }

  private sessionPrimaryActionIcon(): string {
    const mode = this.sessionPrimaryActionMode();
    if (mode === 'interrupt') {
      return '×';
    }
    if (mode === 'sending' || mode === 'interrupting') {
      return '•';
    }
    return '↑';
  }

  private sessionPrimaryActionColor(): string {
    const mode = this.sessionPrimaryActionMode();
    if (mode === 'interrupt') {
      return this.themeColor('#B42318');
    }
    if (mode === 'guidance_send') {
      return this.themeColor('#14853D');
    }
    if (mode === 'sending' || mode === 'interrupting' || mode === 'disabled') {
      return this.themeColor('#8A95A3');
    }
    return this.themeColor('#1F6FEB');
  }

  private canUseSessionPrimaryAction(): boolean {
    const mode = this.sessionPrimaryActionMode();
    return mode === 'interrupt' || mode === 'guidance_send' || mode === 'send';
  }

  private sessionPrimaryActionMode(): string {
    if (this.isSendingCurrentSessionMessage()) {
      return 'sending';
    }
    if (this.canSendSessionMessage()) {
      if (!this.isNewSessionDraft && this.selectedSession !== null && this.hasRunningTaskForSession(this.selectedSession.id)) {
        return 'guidance_send';
      }
      return 'send';
    }
    if (this.isInterruptingSelectedSessionTask()) {
      return 'interrupting';
    }
    if (this.shouldUseSessionInterruptAction()) {
      return 'interrupt';
    }
    return 'disabled';
  }

  private desktopLiveActionButtonText(): string {
    if (this.desktopLiveChecking) {
      return '检测中';
    }
    if (!this.isNewSessionDraft && this.selectedSession !== null
      && (this.desktopLiveState === 'mismatch' || this.desktopLiveState === 'unverified' || this.desktopLiveState === 'unknown')) {
      return '同步';
    }
    return '重检';
  }

  private shortSessionId(sessionId: string): string {
    if (sessionId.length <= 8) {
      return sessionId;
    }
    return sessionId.slice(sessionId.length - 8);
  }

  private shouldShowTaskPanel(): boolean {
    if (this.currentTask === null) {
      return false;
    }
    return this.currentTask.status === 'running'
      || this.currentTask.status === 'queued'
      || this.currentTask.status === 'waiting_approval'
      || this.currentTask.status === 'waiting_input'
      || this.currentTask.status === 'recovering'
      || this.currentTask.status === 'failed';
  }

  private sessionPageTitle(): string {
    if (this.selectedSession !== null) {
      return this.selectedSession.title;
    }
    if (this.isNewSessionDraft) {
      return '新建会话';
    }
    return 'Codex 会话';
  }

  private sessionPageSubtitle(): string {
    if (this.selectedSession !== null) {
      return this.selectedSession.projectLabel ?? '未归类';
    }
    return this.message;
  }

  private sessionHeaderActionText(): string {
    return this.selectedSession !== null || this.isNewSessionDraft ? '换会话' : '会话';
  }

  private visibleSessionEntries(): CodexSessionEntry[] {
    if (this.selectedSession === null) {
      return [];
    }
    const entries = this.selectedSession.entries.slice();
    const task = this.selectedVisibleTask();
    if (task !== null) {
      const liveEntries = this.taskLiveEntries(task);
      liveEntries.forEach((entry: CodexSessionEntry) => {
        if (!this.sessionEntriesContain(entries, entry)) {
          entries.push(entry);
        }
      });
    }
    return this.normalizeVisibleSessionEntries(entries);
  }

  private visibleNewSessionEntries(): CodexSessionEntry[] {
    if (!this.hasNewSessionTask()) {
      return [];
    }
    const task = this.selectedVisibleTask();
    if (task === null) {
      return [];
    }
    return this.normalizeVisibleSessionEntries(this.taskLiveEntries(task));
  }

  private visibleFailedSessionMessages(): FailedSessionMessage[] {
    const sessionId = this.isNewSessionDraft ? '__new_session__' : (this.selectedSession?.id ?? '');
    if (sessionId.length === 0) {
      return [];
    }
    this.pruneResolvedFailedSessionMessages();
    return this.failedSessionMessages.filter((message: FailedSessionMessage) => message.sessionId === sessionId);
  }

  private visibleOptimisticSessionMessages(): OptimisticSessionMessage[] {
    const sessionId = this.isNewSessionDraft ? '__new_session__' : (this.selectedSession?.id ?? '');
    if (sessionId.length === 0) {
      return [];
    }
    return optimisticSessionMessagesForTarget(this.optimisticSessionMessages, sessionId);
  }

  private currentTaskLiveEntries(): CodexSessionEntry[] {
    if (this.currentTask === null) {
      return [];
    }
    return this.taskLiveEntries(this.currentTask);
  }

  private taskLiveEntries(task: BridgeTask): CodexSessionEntry[] {
    if (task.status === 'completed' || task.status === 'interrupted') {
      return [];
    }
    const entries: CodexSessionEntry[] = [];
    if (task.status !== 'failed' && task.prompt.trim().length > 0 && !this.taskBlocksDesktopConversation(task) && !this.taskIsFailedMessageRetry(task)) {
      entries.push({
        timestamp: task.createdAt,
        type: 'live_user_message',
        role: 'user',
        text: task.prompt
      });
    }
    const streamingText = this.streamingAgentTextForTask(task);
    if (streamingText.length > 0) {
      entries.push({
        timestamp: task.updatedAt,
        type: 'live_agent_streaming',
        role: 'assistant',
        text: streamingText
      });
    } else if (task.status === 'running' || task.status === 'queued') {
      entries.push({
        timestamp: task.updatedAt,
        type: 'live_agent_status',
        role: 'system',
        text: this.workingStatusTextForTask(task)
      });
    }
    if (task.status === 'failed') {
      entries.push({
        timestamp: task.updatedAt,
        type: 'live_agent_failed',
        role: 'system',
        text: this.taskSummaryText(task)
      });
    }
    return entries;
  }

  private taskBlocksDesktopConversation(task: BridgeTask): boolean {
    const sync = task.desktopSync;
    if (!sync) {
      return false;
    }
    return sync.desktopLive === false
      && (sync.status === 'desktop_live_required' || sync.status === 'desktop_live_unavailable');
  }

  private taskIsFailedMessageRetry(task: BridgeTask): boolean {
    const pending = this.pendingSessionSendsByTaskId[task.id];
    return !!pending && pending.retryFailedMessageId.length > 0;
  }

  private pruneResolvedFailedSessionMessages(): void {
    const resolvedIds: string[] = [];
    this.failedSessionMessages.forEach((message: FailedSessionMessage) => {
      if (this.failedSessionMessageHasCanonicalEntry(message)) {
        resolvedIds.push(message.id);
      }
    });
    if (resolvedIds.length === 0) {
      return;
    }
    resolvedIds.forEach((failedId: string) => {
      this.clearFailedSessionRetryTimer(failedId);
    });
    this.failedSessionMessages = this.failedSessionMessages.filter((message: FailedSessionMessage) => resolvedIds.indexOf(message.id) < 0);
    this.log('info', 'session.message.failed.pruned_resolved', `failedIds=${resolvedIds.join(',')}`);
  }

  private normalizedFailedMessageText(text: string): string {
    return this.visibleSessionText(text).replace(/\s+/g, ' ').trim();
  }

  private visibleSessionText(text: string): string {
    let visible = this.stripInternalInstructionBlocks(String(text ?? ''));
    visible = this.stripCodexDirectiveBlocks(visible);
    visible = this.stripLeadingSkillToken(visible);
    visible = this.stripMobileImagePromptText(visible);
    return this.markdownPlainDisplayText(visible.replace(/\n{3,}/g, '\n\n').trim());
  }

  private failedSessionMessageHasCanonicalEntry(message: FailedSessionMessage): boolean {
    const expected = this.normalizedFailedMessageText(message.text);
    if (expected.length === 0) {
      return false;
    }
    const entries = message.isNewSession
      ? this.currentTaskLiveEntries()
      : (this.selectedSession?.entries ?? []);
    return entries.some((entry: CodexSessionEntry) => {
      if (entry.role !== 'user') {
        return false;
      }
      return this.normalizedFailedMessageText(entry.text) === expected;
    });
  }

  private sessionEntriesContain(entries: CodexSessionEntry[], candidate: CodexSessionEntry): boolean {
    return entries.some((entry: CodexSessionEntry) => {
      return entry.role === candidate.role && entry.text.trim() === candidate.text.trim();
    });
  }

  private normalizeVisibleSessionEntries(entries: CodexSessionEntry[]): CodexSessionEntry[] {
    const visibleEntries: CodexSessionEntry[] = [];
    let liveActivity: CodexSessionEntry | null = null;
    entries.forEach((entry: CodexSessionEntry) => {
      if (entry.type === 'live_activity') {
        liveActivity = entry;
        return;
      }
      if (!this.shouldHideSessionEntry(entry)) {
        visibleEntries.push(entry);
      }
    });
    const compactedEntries = compactAdjacentSessionToolEntries(visibleEntries);
    if (liveActivity !== null && !this.shouldHideSessionEntry(liveActivity)) {
      compactedEntries.push(liveActivity);
    }
    return compactedEntries;
  }

  private streamingAgentText(): string {
    if (this.currentTask === null) {
      return '';
    }
    return this.streamingAgentTextForTask(this.currentTask);
  }

  private streamingAgentTextForTask(task: BridgeTask): string {
    let deltaText = '';
    let finalText = '';
    task.events.forEach((event: BridgeEvent) => {
      const notificationText = this.notificationAgentText(event);
      if (notificationText.length > 0) {
        finalText = notificationText;
      }
      const delta = this.notificationAgentDelta(event);
      if (delta.length > 0) {
        deltaText += delta;
      }
      const legacyText = this.legacyAgentText(event);
      if (legacyText.length > 0) {
        finalText = legacyText;
      }
    });
    return finalText.length > 0 ? finalText : deltaText.trim();
  }

  private notificationAgentDelta(event: BridgeEvent): string {
    const method = event.payload['method'];
    if (method !== 'item/agentMessage/delta') {
      return '';
    }
    const params = event.payload['params'] as Record<string, Object>;
    if (!params) {
      return '';
    }
    const delta = params['delta'];
    return typeof delta === 'string' ? delta : '';
  }

  private notificationAgentText(event: BridgeEvent): string {
    const method = event.payload['method'];
    if (method !== 'item/completed' && method !== 'turn/completed') {
      return '';
    }
    const params = event.payload['params'] as Record<string, Object>;
    if (!params) {
      return '';
    }
    const item = params['item'] as Record<string, Object>;
    if (item) {
      const itemType = item['type'];
      const text = item['text'];
      if (itemType === 'agentMessage' && typeof text === 'string') {
        return text.trim();
      }
    }
    const turn = params['turn'] as Record<string, Object>;
    if (turn) {
      return this.agentTextFromTurn(turn);
    }
    return '';
  }

  private agentTextFromTurn(turn: Record<string, Object>): string {
    const items = turn['items'] as Object[];
    if (!items) {
      return '';
    }
    let latest = '';
    items.forEach((raw: Object) => {
      const item = raw as Record<string, Object>;
      const itemType = item['type'];
      const text = item['text'];
      if (itemType === 'agentMessage' && typeof text === 'string' && text.trim().length > 0) {
        latest = text.trim();
      }
    });
    return latest;
  }

  private legacyAgentText(event: BridgeEvent): string {
    if (event.type !== 'codex.exec.event') {
      return '';
    }
    const payloadType = event.payload['type'];
    const item = event.payload['item'] as Record<string, Object>;
    if (payloadType !== 'item.completed' || !item) {
      return '';
    }
    const itemType = item['type'];
    const text = item['text'];
    if ((itemType === 'agent_message' || itemType === 'agentMessage') && typeof text === 'string') {
      return text.trim();
    }
    return '';
  }

  private sessionProjectLabels(): string[] {
    const labels: string[] = [];
    this.sessions.forEach((session: CodexSessionSummary) => {
      if (session.pinned === true || session.sidebarSection === 'recent') {
        return;
      }
      const label = session.projectLabel && session.projectLabel.length > 0 ? session.projectLabel : '未归类';
      if (labels.indexOf(label) < 0) {
        labels.push(label);
      }
    });
    return labels;
  }

  private recentSessions(): CodexSessionSummary[] {
    return this.sessions.filter((session: CodexSessionSummary) => {
      return session.pinned !== true && session.sidebarSection === 'recent';
    });
  }

  private async answerPendingUserInput(): Promise<void> {
    const request = this.pendingUserInput();
    if (request === null || !this.canAnswerPendingUserInput()) {
      return;
    }
    const answers: Record<string, string[]> = {};
    request.questions.forEach((question: BridgeUserInputQuestion) => {
      answers[question.id] = [this.userInputAnswer(question.id).trim()];
    });
    await this.guard('answerUserInput', async () => {
      await BridgeClient.answerUserInput(
        this.normalizedBridgeUrl(),
        request.id,
        answers,
        this.bridgeToken
      );
      this.userInputAnswers = {};
      this.message = '回答已提交，Codex 正在继续处理';
      this.log('info', 'user_input.answered.client', `requestId=${request.id}; questionCount=${request.questions.length}`);
      if (this.currentTask !== null) {
        this.currentTask = await BridgeClient.getCodexRun(
          this.normalizedBridgeUrl(),
          this.currentTask.id,
          this.bridgeToken
        );
      }
    });
  }

  private sessionMonitorSummaryText(): string {
    const running = this.runningSessionIds.length;
    const unread = this.unreadCompletedSessionIds.length;
    if (running > 0 && unread > 0) {
      return `共 ${this.sessions.length} 个会话 · ${running} 个进行中 · ${unread} 个未读`;
    }
    if (running > 0) {
      return `共 ${this.sessions.length} 个会话 · ${running} 个进行中`;
    }
    if (unread > 0) {
      return `共 ${this.sessions.length} 个会话 · ${unread} 个未读`;
    }
    return `共 ${this.sessions.length} 个会话`;
  }

  private pinnedSessions(): CodexSessionSummary[] {
    return this.sessions.filter((session: CodexSessionSummary) => session.pinned === true);
  }

  private pinnedRunningCount(): number {
    return this.pinnedSessions().filter((session: CodexSessionSummary) => this.isSessionRunning(session.id)).length;
  }

  private pinnedUnreadCount(): number {
    return this.pinnedSessions().filter((session: CodexSessionSummary) => this.isSessionUnreadCompleted(session.id)).length;
  }

  private pinnedGroupMetaText(): string {
    const running = this.pinnedRunningCount();
    if (running > 0) {
      return `${running} 进行中`;
    }
    const unread = this.pinnedUnreadCount();
    if (unread > 0) {
      return `${unread} 未读`;
    }
    return `${this.pinnedSessions().length}`;
  }

  private sessionsForProject(projectLabel: string): CodexSessionSummary[] {
    return this.sessions
      .filter((session: CodexSessionSummary) => {
        if (session.pinned === true) {
          return false;
        }
        if (session.sidebarSection === 'recent') {
          return false;
        }
        const label = session.projectLabel && session.projectLabel.length > 0 ? session.projectLabel : '未归类';
        return label === projectLabel;
      });
  }

  private projectRunningCount(projectLabel: string): number {
    return this.sessionsForProject(projectLabel).filter((session: CodexSessionSummary) => this.isSessionRunning(session.id)).length;
  }

  private projectUnreadCount(projectLabel: string): number {
    return this.sessionsForProject(projectLabel).filter((session: CodexSessionSummary) => this.isSessionUnreadCompleted(session.id)).length;
  }

  private projectGroupMetaText(projectLabel: string): string {
    const running = this.projectRunningCount(projectLabel);
    if (running > 0) {
      return `${running} 进行中`;
    }
    const unread = this.projectUnreadCount(projectLabel);
    if (unread > 0) {
      return `${unread} 未读`;
    }
    return `${this.sessionsForProject(projectLabel).length}`;
  }

  private sessionTitleById(sessionId: string): string {
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index];
      if (session.id === sessionId) {
        return session.title;
      }
    }
    if (this.selectedSession !== null && this.selectedSession.id === sessionId) {
      return this.selectedSession.title;
    }
    return 'Codex 会话';
  }

  private latestSessionForSelectedProject(): CodexSessionSummary | null {
    if (this.sessions.length === 0 || this.selectedSession === null) {
      return null;
    }
    for (let index = 0; index < this.sessions.length; index++) {
      const session = this.sessions[index];
      if (this.isSameSessionProject(session, this.selectedSession)) {
        return session;
      }
    }
    return null;
  }

  private shouldShowLatestSessionPrompt(): boolean {
    if (this.isNewSessionDraft || this.selectedSession === null) {
      return false;
    }
    const latest = this.latestSessionForSelectedProject();
    return latest !== null && latest.id !== this.selectedSession.id;
  }

  private latestSessionPromptText(): string {
    const latest = this.latestSessionForSelectedProject();
    if (latest === null) {
      return '';
    }
    return `${latest.projectLabel ?? '未归类'} / ${latest.title} / ${this.sessionTimeLabel(latest)}`;
  }

  private async openLatestSession(): Promise<void> {
    const latest = this.latestSessionForSelectedProject();
    if (latest === null) {
      return;
    }
    this.log('info', 'ui.click.open_latest_session', `sessionId=${latest.id}`);
    await this.openSession(latest);
  }

  private isSameSessionProject(summary: CodexSessionSummary, detail: CodexSessionDetail): boolean {
    if (summary.projectRoot && detail.projectRoot) {
      return summary.projectRoot === detail.projectRoot;
    }
    const summaryLabel = summary.projectLabel && summary.projectLabel.length > 0 ? summary.projectLabel : '未归类';
    const detailLabel = detail.projectLabel && detail.projectLabel.length > 0 ? detail.projectLabel : '未归类';
    return summaryLabel === detailLabel;
  }

  private async openSession(session: CodexSessionSummary): Promise<void> {
    this.closeSessionSwipe();
    this.applySessionActivitySnapshot(session, 'open');
    this.isNewSessionDraft = false;
    this.commitSessionNavigation('session', session.id, 'open_session');
    this.expandedSessionEntries = [];
    this.sessionSidebarCollapsed = true;
    this.sessionSidebarUserCollapsed = false;
    this.sessionMessage = '';
    this.pendingSessionImages = [];
    this.pendingSessionFiles = [];
    this.pendingSessionFiles = [];
    this.composerActionMenuExpanded = false;
    this.slashCommandPanelVisible = false;
    this.reasoningEffortMenuVisible = false;
    this.homeActionMenuVisible = false;
    this.homeActionMenuSource = '';
    this.homeActionMenuOpenedAt = 0;
    this.sessionModel = '';
    this.sessionReasoningEffort = '';
    this.reasoningEffortLoadedSessionId = '';
    await this.loadSessionDetail(session.id);
    await this.adoptSelectedSessionTaskFromSummaries(this.tasks);
  }

  private sessionRefreshHintText(): string {
    if (this.isPullRefreshingSessions) {
      return '正在刷新会话列表';
    }
    if (this.deletingSessionId.length > 0) {
      return '正在删除会话';
    }
    return '下拉刷新会话，左滑会话可删除';
  }

  private sessionSwipeOffset(sessionId: string): number {
    if (this.swipedSessionId !== sessionId) {
      return 0;
    }
    return this.swipedSessionOffsetX;
  }

  private handleSessionSwipeUpdate(sessionId: string, offsetX: number): void {
    if (this.deletingSessionId.length > 0) {
      return;
    }
    if (offsetX > 18) {
      this.closeSessionSwipe();
      return;
    }
    const nextOffset = Math.max(-72, Math.min(0, offsetX));
    if (Math.abs(nextOffset) < 4) {
      return;
    }
    this.swipedSessionId = sessionId;
    this.swipedSessionOffsetX = nextOffset;
  }

  private handleSessionSwipeEnd(sessionId: string): void {
    if (this.swipedSessionId !== sessionId) {
      return;
    }
    if (this.swipedSessionOffsetX <= -36) {
      this.swipedSessionOffsetX = -68;
      this.log('info', 'ui.session.swipe_delete.open', `sessionId=${sessionId}`);
      return;
    }
    this.closeSessionSwipe();
  }

  private closeSessionSwipe(): void {
    if (this.swipedSessionId.length === 0 && this.swipedSessionOffsetX === 0) {
      return;
    }
    this.swipedSessionId = '';
    this.swipedSessionOffsetX = 0;
  }

  private canDeleteSession(session: CodexSessionSummary): boolean {
    return this.deletingSessionId.length === 0 && !this.isSessionRunning(session.id);
  }

  private confirmDeleteSession(session: CodexSessionSummary): void {
    if (this.isSessionRunning(session.id)) {
      this.closeSessionSwipe();
      this.message = '会话正在运行，请先中断或等待完成后再删除';
      this.log('warn', 'session.delete.blocked', `sessionId=${session.id}; reason=running`);
      return;
    }
    if (!this.canDeleteSession(session)) {
      this.message = '正在删除其他会话';
      this.log('warn', 'session.delete.blocked', `sessionId=${session.id}; running=${this.isSessionRunning(session.id)}; deleting=${this.deletingSessionId}`);
      return;
    }
    AlertDialog.show({
      title: '删除会话',
      message: `将“${session.title}”从手机和桌面会话列表隐藏，并保留历史文件以避免桌面端打开中的会话损坏。`,
      primaryButton: {
        value: '取消',
        action: () => {
          this.closeSessionSwipe();
          this.log('info', 'session.delete.cancelled', `sessionId=${session.id}`);
        }
      },
      secondaryButton: {
        value: '删除',
        fontColor: this.themeColor('#D92D20'),
        action: () => {
          void this.deleteSession(session);
        }
      }
    });
  }

  private async deleteSession(session: CodexSessionSummary): Promise<void> {
    if (!this.canDeleteSession(session)) {
      this.confirmDeleteSession(session);
      return;
    }
    this.deletingSessionId = session.id;
    this.message = '正在删除会话';
    this.log('warn', 'session.delete.started', `sessionId=${session.id}; title=${session.title}`);
    try {
      await BridgeClient.deleteSession(this.normalizedBridgeUrl(), session.id, this.bridgeToken);
      this.removeDeletedSessionLocalState(session.id);
      this.closeSessionSwipe();
      this.message = '会话已删除';
      this.log('warn', 'session.delete.completed', `sessionId=${session.id}`);
      await this.refreshSessions('delete');
    } catch (error) {
      this.message = `删除失败：${this.errorText(error)}`;
      this.log('error', 'session.delete.failed', `sessionId=${session.id}; message=${this.errorText(error)}`);
    } finally {
      this.deletingSessionId = '';
    }
  }

  private removeDeletedSessionLocalState(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      this.commitSessionNavigation('home', '', 'delete_active_session');
    }
    this.sessions = this.sessions.filter((session: CodexSessionSummary) => session.id !== sessionId);
    this.runningSessionIds = this.runningSessionIds.filter((id: string) => id !== sessionId);
    this.unreadCompletedSessionIds = this.unreadCompletedSessionIds.filter((id: string) => id !== sessionId);
    this.locallyClearedRunningSessionIds = this.locallyClearedRunningSessionIds.filter((id: string) => id !== sessionId);
    const nextActivityStatus: Record<string, string> = {};
    Object.keys(this.sessionActivityStatusById).forEach((id: string) => {
      if (id !== sessionId) {
        nextActivityStatus[id] = this.sessionActivityStatusById[id];
      }
    });
    this.sessionActivityStatusById = nextActivityStatus;
    const nextUpdatedAt: Record<string, string> = {};
    Object.keys(this.sessionUpdatedAtById).forEach((id: string) => {
      if (id !== sessionId) {
        nextUpdatedAt[id] = this.sessionUpdatedAtById[id];
      }
    });
    this.sessionUpdatedAtById = nextUpdatedAt;
    const nextClearedUpdatedAt: Record<string, string> = {};
    Object.keys(this.clearedRunningSessionUpdatedAtById).forEach((id: string) => {
      if (id !== sessionId) {
        nextClearedUpdatedAt[id] = this.clearedRunningSessionUpdatedAtById[id];
      }
    });
    this.clearedRunningSessionUpdatedAtById = nextClearedUpdatedAt;
    if (this.selectedSession !== null && this.selectedSession.id === sessionId) {
      this.selectedSession = null;
      this.isNewSessionDraft = false;
      this.sessionSidebarCollapsed = false;
      this.sessionSidebarUserCollapsed = false;
      this.sessionMessage = '';
      this.pendingSessionImages = [];
      this.pendingSessionFiles = [];
      this.composerActionMenuExpanded = false;
      this.slashCommandPanelVisible = false;
      this.reasoningEffortMenuVisible = false;
      this.sessionModel = '';
      this.sessionReasoningEffort = '';
      this.reasoningEffortLoadedSessionId = '';
      this.expandedSessionEntries = [];
    }
    this.bumpSessionMonitorRevision();
  }

  private sessionWindowWidthVp(): number {
    return this.sessionWindowWidth > 0 ? px2vp(this.sessionWindowWidth) : 0;
  }

  private sessionWindowHeightVp(): number {
    return this.sessionWindowHeight > 0 ? px2vp(this.sessionWindowHeight) : 0;
  }

  private isLandscapeSessionLayout(): boolean {
    const width = this.sessionWindowWidthVp();
    const height = this.sessionWindowHeightVp();
    return width >= 720 && width > height;
  }

  private sessionLandscapeSidebarWidth(): number {
    return Math.max(
      this.sessionLandscapeSidebarMinWidth(),
      Math.min(this.sessionLandscapeSidebarMaxWidth(), this.sessionSidebarWidth)
    );
  }

  private sessionLandscapeSidebarMinWidth(): number {
    return 280;
  }

  private sessionLandscapeSidebarMaxWidth(): number {
    const availableWidth = this.sessionWindowWidthVp() - 420;
    return Math.max(this.sessionLandscapeSidebarMinWidth(), Math.min(440, availableWidth));
  }

  private resizeSessionLandscapeSidebar(offsetX: number): void {
    const nextWidth = this.sessionSidebarResizeStartWidth + offsetX;
    this.sessionSidebarWidth = Math.max(this.sessionLandscapeSidebarMinWidth(), Math.min(this.sessionLandscapeSidebarMaxWidth(), nextWidth));
  }

  private isSessionSidebarVisible(): boolean {
    return this.isLandscapeSessionLayout() ? !this.sessionSidebarUserCollapsed : !this.sessionSidebarCollapsed;
  }

  private shouldShowSessionHeaderSidebarToggle(): boolean {
    return this.sessionSidebarCollapsed;
  }

  private toggleSessionSidebarFromHeader(): void {
    if (this.isLandscapeSessionLayout()) {
      const collapsed = !this.sessionSidebarUserCollapsed;
      this.sessionSidebarUserCollapsed = collapsed;
      this.sessionSidebarCollapsed = collapsed;
      this.homeActionMenuVisible = false;
      this.homeActionMenuSource = '';
      this.log('info', 'ui.session_sidebar.toggle', `collapsed=${collapsed}; source=conversation_header; layout=landscape`);
      return;
    }
    this.sessionSidebarCollapsed = false;
    this.sessionSidebarUserCollapsed = false;
    this.log('info', 'ui.session_sidebar.toggle', 'collapsed=false; source=conversation_header; layout=portrait');
  }

  private closeSessionSidebar(source: string): void {
    if (!this.isLandscapeSessionLayout() && this.selectedSession === null && !this.isNewSessionDraft) {
      this.sessionSidebarCollapsed = false;
      this.sessionSidebarUserCollapsed = false;
      this.message = '请选择一个会话';
      this.log('info', 'ui.session_sidebar.keep_open', `source=${source}; reason=no_session_selected`);
      return;
    }
    this.sessionSidebarCollapsed = true;
    this.sessionSidebarUserCollapsed = this.isLandscapeSessionLayout();
    this.message = this.selectedSession === null && !this.isNewSessionDraft ? '已返回会话主界面' : this.message;
    this.log('info', 'ui.session_sidebar.toggle', `collapsed=true; source=${source}; layout=${this.isLandscapeSessionLayout() ? 'landscape' : 'portrait'}`);
  }

  private returnToSessionHome(source: string): void {
    this.sessionDetailRequestSeq += 1;
    this.selectedSession = null;
    this.commitSessionNavigation('home', '', source);
    this.isNewSessionDraft = false;
    this.newSessionTaskId = '';
    this.sessionSidebarCollapsed = false;
    this.sessionSidebarUserCollapsed = false;
    this.expandedSessionEntries = [];
    this.sessionMessage = '';
    this.pendingSessionImages = [];
    this.pendingSessionFiles = [];
    this.composerActionMenuExpanded = false;
    this.slashCommandPanelVisible = false;
    this.reasoningEffortMenuVisible = false;
    this.homeActionMenuVisible = false;
    this.homeActionMenuSource = '';
    this.homeActionMenuOpenedAt = 0;
    this.sessionModel = '';
    this.sessionReasoningEffort = '';
    this.reasoningEffortLoadedSessionId = '';
    this.message = '请选择一个会话';
    this.desktopLiveState = 'unknown';
    this.desktopLiveCurrentSessionId = '';
    this.desktopLiveTargetSessionId = '';
    this.desktopLiveSessionVerified = false;
    this.log('info', 'ui.session_home.returned', `source=${source}`);
  }

  private startNewSessionDraft(): void {
    if (this.hasRunningSessionTask()) {
      this.message = `当前正在处理：${this.activeSessionTaskTitle.length > 0 ? this.activeSessionTaskTitle : '会话任务'}，完成后才能新建会话`;
      this.log('warn', 'session.new.blocked', `reason=session_task_running; currentTaskId=${this.currentTask?.id ?? ''}; taskSessionId=${this.currentTask?.codexSessionId ?? ''}`);
      return;
    }
    this.selectedSession = null;
    this.commitSessionNavigation('new', '', 'start_new_session');
    this.isNewSessionDraft = true;
    this.newSessionTaskId = '';
    this.sessionSidebarCollapsed = true;
    this.sessionSidebarUserCollapsed = false;
    this.expandedSessionEntries = [];
    this.sessionMessage = '';
    this.pendingSessionImages = [];
    this.pendingSessionFiles = [];
    this.composerActionMenuExpanded = false;
    this.slashCommandPanelVisible = false;
    this.reasoningEffortMenuVisible = false;
    this.homeActionMenuVisible = false;
    this.homeActionMenuSource = '';
    this.homeActionMenuOpenedAt = 0;
    this.sessionModel = '';
    this.sessionReasoningEffort = '';
    this.reasoningEffortLoadedSessionId = '__new_session__';
    this.desktopLiveState = 'unknown';
    this.desktopLiveCurrentSessionId = '';
    this.desktopLiveTargetSessionId = '';
    this.desktopLiveSessionVerified = false;
    this.message = '正在新建会话草稿';
    this.log('info', 'ui.click.new_session', '');
    void this.loadDesktopReasoningDefaults(true);
  }

  private canStartNewSessionDraft(): boolean {
    if (this.isBusy) {
      return false;
    }
    if (this.hasRunningSessionTask()) {
      return false;
    }
    if (this.currentTask === null) {
      return true;
    }
    return this.isTaskTerminalStatus(this.currentTask.status);
  }

  private isSessionProjectCollapsed(projectLabel: string): boolean {
    return this.collapsedSessionProjects.indexOf(projectLabel) >= 0;
  }

  private toggleSessionProject(projectLabel: string): void {
    const index = this.collapsedSessionProjects.indexOf(projectLabel);
    if (index >= 0) {
      this.collapsedSessionProjects.splice(index, 1);
    } else {
      this.collapsedSessionProjects.push(projectLabel);
    }
    this.log('info', 'ui.session_project.toggle', `projectLabel=${projectLabel}; collapsed=${this.isSessionProjectCollapsed(projectLabel)}`);
  }

  private shortProjectLabel(projectLabel: string): string {
    if (projectLabel.length <= 2) {
      return projectLabel;
    }
    return projectLabel.slice(0, 2);
  }

  private sessionInitial(session: CodexSessionSummary): string {
    if (session.title.length === 0) {
      return '会';
    }
    return session.title.slice(0, 1);
  }

  private sessionTimeLabel(session: CodexSessionSummary): string {
    const runtimeState = session.runtimeState ?? session.activityStatus ?? '';
    if (SessionRuntimeStore.isActiveState(runtimeState)) {
      return this.statusLabel(runtimeState);
    }
    if (session.relativeTime && session.relativeTime.length > 0) {
      return session.relativeTime;
    }
    return session.updatedAt;
  }

  private sessionSidebarTimeWidth(): number {
    return Math.ceil(84 * fontScalePercent(this.fontScaleMode) / 100);
  }

  private sessionDetailTimeLabel(): string {
    if (this.selectedSession === null) {
      return '';
    }
    const prefix = this.selectedSession.activitySource === 'session-file' ? '本地历史' : '官方会话';
    const runtimeState = this.selectedSession.runtimeState ?? this.selectedSession.activityStatus ?? '';
    const runtimePrefix = runtimeState.length > 0 ? `${this.statusLabel(runtimeState)} · ` : '';
    if (this.selectedSession.relativeTime && this.selectedSession.relativeTime.length > 0) {
      return `${runtimePrefix}${prefix} · ${this.selectedSession.relativeTime}`;
    }
    return `${runtimePrefix}${prefix} · ${this.selectedSession.updatedAt}`;
  }

  private sessionEntryKey(entry: CodexSessionEntry): string {
    if (entry.type === 'live_activity') {
      return `live-${entry.threadId ?? this.selectedSession?.id ?? 'session'}-${entry.turnId ?? entry.timestamp}`;
    }
    return `${entry.timestamp}-${entry.type}-${entry.role}`;
  }

  private shouldHideSessionEntry(entry: CodexSessionEntry): boolean {
    const text = entry.text.trim();
    if (text.length === 0) {
      return true;
    }
    if (text.indexOf('<turn_aborted>') >= 0 && text.indexOf('</turn_aborted>') >= 0) {
      return true;
    }
    if (entry.type === 'status'
      || entry.type === 'live_reasoning_streaming'
      || entry.type === 'reasoning') {
      return true;
    }
    return false;
  }

  private sessionEntryTimeText(entry: CodexSessionEntry): string {
    const value = entry.timestamp.trim();
    if (value.length === 0) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const now = new Date();
    const hhmm = `${this.pad2(date.getHours())}:${this.pad2(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate()) {
      return hhmm;
    }
    return `${this.pad2(date.getMonth() + 1)}-${this.pad2(date.getDate())} ${hhmm}`;
  }

  private failedSessionMessageTimeText(message: FailedSessionMessage): string {
    return this.sessionEntryTimeText({
      timestamp: message.createdAt,
      type: 'local_failed_user_message',
      role: 'user',
      text: message.text
    });
  }

  private shortTimeText(value: string): string {
    return this.sessionEntryTimeText({
      timestamp: value,
      type: 'time',
      role: 'system',
      text: value
    });
  }

  private pad2(value: number): string {
    return value < 10 ? `0${value}` : `${value}`;
  }

  private isLongSessionEntry(entry: CodexSessionEntry): boolean {
    return entry.text.length > 180;
  }

  private isSessionEntryExpanded(entry: CodexSessionEntry): boolean {
    return this.expandedSessionEntries.indexOf(this.sessionEntryKey(entry)) >= 0;
  }

  private sessionEntryMaxLines(entry: CodexSessionEntry): number {
    if (entry.type === 'live_agent_streaming') {
      return 80;
    }
    if (entry.role === 'assistant' || entry.role === 'user') {
      return 120;
    }
    if (!this.isLongSessionEntry(entry) || this.isSessionEntryExpanded(entry)) {
      return 120;
    }
    if (entry.role === 'tool' || entry.role === 'system') {
      return 3;
    }
    return 5;
  }

  private shouldShowFullSessionEntry(entry: CodexSessionEntry): boolean {
    if (entry.type === 'live_agent_streaming') {
      return true;
    }
    if (entry.role === 'assistant' || entry.role === 'user') {
      return true;
    }
    return this.isSessionEntryExpanded(entry);
  }

  private isSystemLikeSessionEntry(entry: CodexSessionEntry): boolean {
    return entry.role === 'system'
      || entry.role === 'tool'
      || entry.type === 'live_activity'
      || entry.type === 'live_agent_status'
      || entry.type === 'live_agent_failed'
      || entry.type === 'live_reasoning_streaming'
      || entry.type === 'tool_call'
      || entry.type === 'tool_result'
      || entry.type === 'reasoning';
  }

  private isSessionMetaEntry(entry: CodexSessionEntry): boolean {
    return this.isSystemLikeSessionEntry(entry)
      || entry.type === 'live_agent_status'
      || entry.type === 'live_agent_failed';
  }

  private sessionMetaEntryColor(entry: CodexSessionEntry): string {
    if (entry.type === 'live_agent_failed') {
      return this.themeColor('#B42318');
    }
    if (this.isActiveSessionMetaEntry(entry)) {
      return this.themeColor('#667085');
    }
    if (entry.type === 'live_agent_status') {
      return this.themeColor('#667085');
    }
    if (entry.role === 'tool') {
      return this.themeColor('#8A949F');
    }
    return this.themeColor('#A0A8B2');
  }

  private sessionMetaEntryMark(entry: CodexSessionEntry): string {
    if (entry.type === 'live_agent_failed') {
      return '!';
    }
    if (entry.type === 'reasoning') {
      return '◇';
    }
    if (entry.role === 'tool') {
      return '▹';
    }
    return '›';
  }

  private isActiveSessionMetaEntry(entry: CodexSessionEntry): boolean {
    return entry.type === 'live_agent_status'
      || entry.type === 'live_activity'
      || entry.type === 'live_reasoning_streaming'
      || entry.type === 'tool_call';
  }

  private sessionMetaEntryDisplayText(entry: CodexSessionEntry): string {
    return this.sessionEntryDisplayText(entry);
  }

  private sessionMetaEntrySummaryText(entry: CodexSessionEntry): string {
    const visibleText = this.sessionEntryVisibleText(entry);
    const text = visibleText.length > 0 ? visibleText : this.sessionMetaEntryDisplayText(entry);
    const firstLine = this.firstVisibleLine(text);
    return firstLine.length > 0 ? firstLine : this.sessionMetaEntryDisplayText(entry);
  }

  private sessionMetaEntryDetailText(entry: CodexSessionEntry): string {
    const visibleText = this.sessionEntryVisibleText(entry);
    const lines = visibleText.split('\n');
    if (lines.length <= 1) {
      return '';
    }
    return lines.slice(1).join('\n').trim();
  }

  private hasExpandableSessionMetaEntry(entry: CodexSessionEntry): boolean {
    return this.sessionMetaEntryDetailText(entry).length > 0 || this.isLongSessionEntry(entry);
  }

  private firstVisibleLine(text: string): string {
    const lines = String(text ?? '').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.length > 0) {
        return line;
      }
    }
    return '';
  }

  private sessionAssistantEntryLabel(entry: CodexSessionEntry): string {
    if (entry.type === 'live_agent_streaming') {
      return '正在返回';
    }
    return 'Codex';
  }

  private toggleSessionEntry(entry: CodexSessionEntry): void {
    const key = this.sessionEntryKey(entry);
    const index = this.expandedSessionEntries.indexOf(key);
    if (index >= 0) {
      this.expandedSessionEntries = this.expandedSessionEntries.filter((entryKey: string) => entryKey !== key);
    } else {
      this.expandedSessionEntries = this.expandedSessionEntries.concat([key]);
    }
    this.log('info', 'ui.session_entry.toggle', `key=${key}; expanded=${this.isSessionEntryExpanded(entry)}`);
  }

  private sessionToolItemKey(entry: CodexSessionEntry, item: SessionToolPresentationItem): string {
    return `${this.sessionEntryKey(entry)}::tool::${item.id}`;
  }

  private hasExpandableSessionToolItem(item: SessionToolPresentationItem): boolean {
    return item.detail.length > 0 || item.target.length > 56;
  }

  private isSessionToolItemExpanded(entry: CodexSessionEntry, item: SessionToolPresentationItem): boolean {
    return this.expandedSessionEntries.indexOf(this.sessionToolItemKey(entry, item)) >= 0;
  }

  private toggleSessionToolItem(entry: CodexSessionEntry, item: SessionToolPresentationItem): void {
    const key = this.sessionToolItemKey(entry, item);
    const index = this.expandedSessionEntries.indexOf(key);
    if (index >= 0) {
      this.expandedSessionEntries = this.expandedSessionEntries.filter((entryKey: string) => entryKey !== key);
    } else {
      this.expandedSessionEntries = this.expandedSessionEntries.concat([key]);
    }
    this.log('info', 'ui.session_tool_item.toggle', `key=${key}; expanded=${index < 0}`);
  }

  private isSessionToolGroup(entry: CodexSessionEntry): boolean {
    return sessionToolPresentationItems(entry).length > 1;
  }

  private sessionToolGroupKey(entry: CodexSessionEntry): string {
    const items = sessionToolPresentationItems(entry);
    const firstId = items.length > 0 ? items[0].id : 'tool';
    const lastId = items.length > 0 ? items[items.length - 1].id : 'tool';
    return `${entry.threadId ?? this.selectedSession?.id ?? 'session'}::tool-group::${firstId}::${lastId}::${items.length}`;
  }

  private sessionToolGroupIsRunning(entry: CodexSessionEntry): boolean {
    return sessionToolPresentationItems(entry)
      .some((item: SessionToolPresentationItem) => item.status === 'running');
  }

  private sessionToolGroupHasFailure(entry: CodexSessionEntry): boolean {
    return sessionToolPresentationItems(entry)
      .some((item: SessionToolPresentationItem) => item.status === 'failed');
  }

  private sessionToolGroupIsCollapsible(entry: CodexSessionEntry): boolean {
    return this.isSessionToolGroup(entry)
      && !this.sessionToolGroupIsRunning(entry)
      && !this.sessionToolGroupHasFailure(entry);
  }

  private isSessionToolGroupExpanded(entry: CodexSessionEntry): boolean {
    if (!this.isSessionToolGroup(entry)) {
      return true;
    }
    if (!this.sessionToolGroupIsCollapsible(entry)) {
      return true;
    }
    return this.expandedSessionEntries.indexOf(this.sessionToolGroupKey(entry)) >= 0;
  }

  private shouldShowSessionToolGroupItems(entry: CodexSessionEntry): boolean {
    return !this.isSessionToolGroup(entry) || this.isSessionToolGroupExpanded(entry);
  }

  private toggleSessionToolGroup(entry: CodexSessionEntry): void {
    const key = this.sessionToolGroupKey(entry);
    const index = this.expandedSessionEntries.indexOf(key);
    if (index >= 0) {
      this.expandedSessionEntries = this.expandedSessionEntries
        .filter((entryKey: string) => entryKey !== key);
    } else {
      this.expandedSessionEntries = this.expandedSessionEntries.concat([key]);
    }
    this.log('info', 'ui.session_tool_group.toggle', `key=${key}; expanded=${index < 0}`);
  }

  private sessionToolGroupTitle(entry: CodexSessionEntry): string {
    const items = sessionToolPresentationItems(entry);
    const failed = items.filter((item: SessionToolPresentationItem) => item.status === 'failed').length;
    if (this.sessionToolGroupIsRunning(entry)) {
      return `正在执行 ${items.length} 项操作`;
    }
    if (failed > 0) {
      return `${items.length} 项操作中有 ${failed} 项失败`;
    }
    return `已完成 ${items.length} 项操作`;
  }

  private sessionToolGroupColor(entry: CodexSessionEntry): string {
    if (this.sessionToolGroupHasFailure(entry)) {
      return this.themeColor('#B42318');
    }
    if (this.sessionToolGroupIsRunning(entry)) {
      return this.themeColor('#1F6FEB');
    }
    return this.themeColor('#14853D');
  }

  private sessionToolItemStatusText(item: SessionToolPresentationItem): string {
    if ((item.retryCount ?? 0) > 0 && item.status === 'completed') {
      return `重试 ${item.retryCount} 次后成功`;
    }
    if (item.status === 'running') {
      return '进行中';
    }
    if (item.status === 'failed') {
      return '失败';
    }
    if (item.status === 'stopped') {
      return '已停止';
    }
    return '完成';
  }

  private sessionToolItemMark(item: SessionToolPresentationItem): string {
    if (item.status === 'failed') {
      return '!';
    }
    if (item.status === 'stopped') {
      return '×';
    }
    return '▹';
  }

  private sessionToolItemColor(item: SessionToolPresentationItem): string {
    if (item.status === 'failed') {
      return this.themeColor('#B42318');
    }
    if (item.status === 'running') {
      return this.themeColor('#1F6FEB');
    }
    return this.themeColor('#667085');
  }

  private sessionMarkdownBlockKey(entry: CodexSessionEntry, block: SessionMarkdownBlock): string {
    return `${this.sessionEntryKey(entry)}::${block.id}`;
  }

  private isSessionMarkdownBlockExpanded(entry: CodexSessionEntry, block: SessionMarkdownBlock): boolean {
    return this.expandedSessionEntries.indexOf(this.sessionMarkdownBlockKey(entry, block)) >= 0;
  }

  private toggleSessionMarkdownBlock(entry: CodexSessionEntry, block: SessionMarkdownBlock): void {
    const key = this.sessionMarkdownBlockKey(entry, block);
    const index = this.expandedSessionEntries.indexOf(key);
    if (index >= 0) {
      this.expandedSessionEntries = this.expandedSessionEntries.filter((entryKey: string) => entryKey !== key);
    } else {
      this.expandedSessionEntries = this.expandedSessionEntries.concat([key]);
    }
    this.log('info', 'ui.session_markdown_block.toggle', `key=${key}; kind=${block.kind}; language=${block.language}; expanded=${index < 0}`);
  }

  private pendingApprovalId(): string {
    const task = this.approvalContextTask();
    if (task === null) {
      return '';
    }
    for (let index = task.events.length - 1; index >= 0; index -= 1) {
      const event = task.events[index];
      if (event.type === 'approval.required') {
        const approvalId = event.payload['approvalId'];
        return typeof approvalId === 'string' ? approvalId : '';
      }
      if (event.type === 'approval.decided') {
        return '';
      }
    }
    return '';
  }

  private pendingApprovalSummary(): string {
    const task = this.approvalContextTask();
    if (task === null) {
      return '';
    }
    for (let index = task.events.length - 1; index >= 0; index -= 1) {
      const event = task.events[index];
      if (event.type === 'approval.required') {
        const command = event.payload['command'];
        const risk = event.payload['risk'];
        return `${this.riskLabel(typeof risk === 'string' ? risk : 'unknown')}：${typeof command === 'string' ? command : '待确认命令'}`;
      }
    }
    return '';
  }

  private approvalContextTask(): BridgeTask | null {
    const selectedTask = this.selectedVisibleTask();
    if (selectedTask !== null) {
      return selectedTask;
    }
    if (this.selectedSession !== null || this.isNewSessionDraft) {
      return null;
    }
    return this.currentTask;
  }

  private eventSummary(event: BridgeEvent): string {
    if (event.type === 'task.completed') {
      const summary = this.payloadString(event, 'summary');
      if (summary.length > 0) {
        return summary;
      }
      return 'Codex 已完成本次任务';
    }
    if (event.type === 'task.failed') {
      const error = this.payloadString(event, 'error');
      const message = this.payloadString(event, 'message');
      if (error.length > 0) {
        return error;
      }
      return message.length > 0 ? message : '任务执行失败';
    }
    if (event.type === 'task.interrupted') {
      return '已中断当前会话';
    }
    if (event.type === 'task.interrupt.requested') {
      return '中断请求已发送';
    }
    if (event.type === 'task.interrupt.dispatching') {
      return '正在通知桌面 Codex 中断';
    }
    if (event.type === 'task.interrupt.failed') {
      const message = this.payloadString(event, 'message');
      return message.length > 0 ? `中断失败：${message}` : '中断失败';
    }
    const notificationSummary = this.notificationSummary(event);
    if (notificationSummary.length > 0) {
      return notificationSummary;
    }
    if (event.type === 'task.adapter.starting') {
      return '正在准备 Codex 运行环境';
    }
    if (event.type === 'task.interrupt.requested') {
      return '中断请求已发送';
    }
    if (event.type === 'task.interrupt.dispatching') {
      return '正在通知桌面 Codex 中断';
    }
    if (event.type === 'task.interrupt.failed') {
      const message = this.payloadString(event, 'message');
      return message.length > 0 ? `中断失败：${message}` : '中断失败';
    }
    if (event.type === 'codex.desktop_live.probe_started') {
      return '正在连接桌面 Codex';
    }
    if (event.type === 'codex.desktop_live.available') {
      return '已接入桌面实时通道';
    }
    if (event.type === 'codex.desktop_live.unavailable') {
      return '桌面实时通道不可用';
    }
    if (event.type === 'codex.desktop_sync') {
      const status = event.payload['status'];
      if (status === 'desktop_live_required') {
        return '未连接桌面实时通道，已阻止发送';
      }
      if (status === 'desktop_live_unavailable') {
        return '桌面实时通道不可用，已阻止发送';
      }
      const desktopLive = event.payload['desktopLive'];
      return desktopLive === true ? '桌面实时同步中' : '未进入桌面实时通道';
    }
    if (event.type === 'codex.app_server.thread.ready') {
      return 'Codex 会话已连接';
    }
    if (event.type === 'codex.app_server.turn.started') {
      return '消息已提交，等待 Codex 接收';
    }
    if (event.type === 'codex.app_server.user_message.persisted') {
      return '消息已进入 Codex 官方会话';
    }
    if (event.type === 'codex.app_server.user_message.missing') {
      const message = this.payloadString(event, 'message');
      return message.length > 0 ? message : '本次消息没有写入 Codex 官方会话';
    }
    if (event.type === 'codex.app_server.turn.retry_after_compaction') {
      return this.compactionEventText(event, '发送后触发上下文压缩，正在等待并自动重试');
    }
    if (event.type === 'codex.app_server.compaction.detected') {
      return this.compactionEventText(event, 'Codex 正在压缩上下文');
    }
    if (event.type === 'codex.app_server.compaction.waiting') {
      return this.compactionEventText(event, '正在等待 Codex 压缩完成');
    }
    if (event.type === 'codex.session_file.prompt_pending') {
      return '正在等待 Codex 写入这条消息';
    }
    const payloadType = event.payload['type'];
    const item = event.payload['item'] as Record<string, Object>;
    if (payloadType === 'item.completed' && item) {
      const itemType = item['type'];
      const text = item['text'];
      if (itemType === 'agent_message' && typeof text === 'string') {
        return text;
      }
      const command = item['command'];
      if (typeof command === 'string') {
        return command;
      }
    }
    const line = event.payload['line'];
    if (typeof line === 'string') {
      return line;
    }
    const message = event.payload['message'];
    if (typeof message === 'string') {
      return message;
    }
    const payload = JSON.stringify(event.payload);
    return payload === '{}' ? event.createdAt : payload;
  }

  private currentTaskSummaryText(): string {
    if (this.currentTask === null) {
      return '暂无运行任务';
    }
    return this.taskSummaryText(this.currentTask);
  }

  private selectedTaskSummaryText(): string {
    const task = this.selectedVisibleTask();
    if (task === null) {
      return this.compactDisplayText(this.message, 90);
    }
    return this.taskSummaryText(task);
  }

  private taskSummaryText(task: BridgeTask): string {
    const taskEvents = this.visibleTaskEventsForTask(task);
    const latest = taskEvents.length > 0 ? taskEvents[taskEvents.length - 1] : null;
    if (latest === null) {
      return '任务已创建，等待 Codex 输出';
    }
    if (task.status === 'running' || task.status === 'recovering') {
      return this.workingStatusTextForTask(task);
    }
    if (task.status === 'waiting_approval') {
      return `等待确认：${this.pendingApprovalSummary()}`;
    }
    if (task.status === 'waiting_input') {
      return '等待你回答问题';
    }
    if (task.status === 'completed') {
      return 'Codex 已完成本次任务';
    }
    if (task.status === 'interrupted') {
      return '已中断当前会话';
    }
    if (task.status === 'failed') {
      return `失败：${this.eventSummary(latest)}`;
    }
    return this.eventSummary(latest);
  }

  private workingStatusText(): string {
    if (this.currentTask === null) {
      return '暂无运行任务';
    }
    return this.workingStatusTextForTask(this.currentTask);
  }

  private workingStatusTextForTask(task: BridgeTask): string {
    if (task.status === 'queued') {
      return '任务已排队，等待启动';
    }
    const taskEvents = this.visibleTaskEventsForTask(task);
    for (let index = taskEvents.length - 1; index >= 0; index -= 1) {
      const event = taskEvents[index];
      const status = this.eventWorkingStatus(event);
      if (status.length > 0) {
        return status;
      }
    }
    return 'Codex 正在处理当前消息';
  }

  private eventWorkingStatus(event: BridgeEvent): string {
    if (event.type === 'task.running') {
      return 'Codex 正在启动';
    }
    if (event.type === 'task.adapter.starting') {
      return '正在准备 Codex 运行环境';
    }
    if (event.type === 'task.interrupt.failed') {
      return '中断失败，Codex 可能仍在运行';
    }
    if (event.type === 'codex.desktop_live.probe_started') {
      return '正在连接桌面 Codex';
    }
    if (event.type === 'codex.desktop_live.available') {
      return '已接入桌面实时通道';
    }
    if (event.type === 'codex.desktop_live.unavailable') {
      return '桌面实时通道不可用';
    }
    if (event.type === 'codex.desktop_sync') {
      const status = event.payload['status'];
      if (status === 'desktop_live_required') {
        return '未连接桌面实时通道，已阻止发送';
      }
      if (status === 'desktop_live_unavailable') {
        return '桌面实时通道不可用，已阻止发送';
      }
      const desktopLive = event.payload['desktopLive'];
      return desktopLive === true ? '桌面实时同步中' : '未进入桌面实时通道';
    }
    if (event.type === 'codex.turn.started') {
      return 'Codex 正在处理当前消息';
    }
    if (event.type === 'codex.thread.status') {
      const status = event.payload['params'] as Record<string, Object>;
      const rawStatus = status ? status['status'] : '';
      const normalized = typeof rawStatus === 'string'
        ? rawStatus
        : ((rawStatus as Record<string, Object>)?.['type'] ?? '');
      if (normalized === 'active') {
        return 'Codex 正在工作';
      }
      if (normalized === 'idle') {
        return 'Codex 已回到空闲';
      }
      return 'Codex 状态已更新';
    }
    const notificationStatus = this.notificationWorkingStatus(event);
    if (notificationStatus.length > 0) {
      return notificationStatus;
    }
    if (event.type === 'codex.app_server.thread.ready') {
      return 'Codex 会话已连接';
    }
    if (event.type === 'codex.app_server.turn.started') {
      return '消息已提交，等待 Codex 接收';
    }
    if (event.type === 'codex.app_server.user_message.persisted') {
      return '消息已进入 Codex 官方会话';
    }
    if (event.type === 'codex.app_server.user_message.missing') {
      const message = this.payloadString(event, 'message');
      return message.length > 0 ? message : '本次消息没有写入 Codex 官方会话';
    }
    if (event.type === 'codex.app_server.turn.retry_after_compaction') {
      return this.compactionEventText(event, '发送后触发上下文压缩，正在等待并自动重试');
    }
    if (event.type === 'codex.app_server.compaction.detected') {
      return this.compactionEventText(event, 'Codex 正在压缩上下文');
    }
    if (event.type === 'codex.app_server.compaction.waiting') {
      return this.compactionEventText(event, '正在等待 Codex 压缩完成');
    }
    if (event.type === 'codex.session_file.prompt_pending') {
      return '正在等待 Codex 写入这条消息';
    }
    if (event.type === 'codex.exec.event') {
      const payloadType = event.payload['type'];
      const item = event.payload['item'] as Record<string, Object>;
      if (payloadType === 'item.started' && item) {
        return this.itemWorkingStatus(item);
      }
      if (payloadType === 'item.completed' && item) {
        return this.itemCompletedStatus(item);
      }
    }
    return '';
  }

  private notificationSummary(event: BridgeEvent): string {
    const method = event.payload['method'];
    if (typeof method !== 'string') {
      return '';
    }
    const status = this.notificationWorkingStatus(event);
    if (status.length > 0) {
      return status;
    }
    return method;
  }

  private notificationWorkingStatus(event: BridgeEvent): string {
    const method = event.payload['method'];
    if (method === 'turn/started') {
      return 'Codex 正在处理当前消息';
    }
    if (method === 'item/agentMessage/delta') {
      return '正在返回内容';
    }
    if (method === 'turn/completed') {
      return 'Codex 已完成本轮回复';
    }
    if (method === 'thread/status/changed') {
      const params = event.payload['params'] as Record<string, Object>;
      const rawStatus = params ? params['status'] : '';
      const status = typeof rawStatus === 'string'
        ? rawStatus
        : ((rawStatus as Record<string, Object>)?.['type'] ?? '');
      if (status === 'active') {
        return 'Codex 正在工作';
      }
      if (status === 'idle') {
        return 'Codex 已回到空闲';
      }
      return 'Codex 状态已更新';
    }
    if (method === 'item/started') {
      const params = event.payload['params'] as Record<string, Object>;
      const item = params ? params['item'] as Record<string, Object> : null;
      return item ? this.itemWorkingStatus(item) : 'Codex 正在处理';
    }
    if (method === 'item/completed') {
      const params = event.payload['params'] as Record<string, Object>;
      const item = params ? params['item'] as Record<string, Object> : null;
      return item ? this.itemCompletedStatus(item) : 'Codex 已处理一个事件';
    }
    return '';
  }

  private itemWorkingStatus(item: Record<string, Object>): string {
    const itemType = item['type'];
    if (itemType === 'reasoning') {
      return 'Codex 正在思考';
    }
    if (itemType === 'commandExecution' || itemType === 'command_execution') {
      return '正在执行命令';
    }
    if (itemType === 'agentMessage' || itemType === 'agent_message') {
      return '内容已返回';
    }
    return 'Codex 正在处理';
  }

  private itemCompletedStatus(item: Record<string, Object>): string {
    const itemType = item['type'];
    if (itemType === 'agentMessage' || itemType === 'agent_message') {
      return '正在返回内容';
    }
    if (itemType === 'commandExecution' || itemType === 'command_execution') {
      const exitCode = item['exit_code'];
      return exitCode === 0 ? '命令执行成功' : '命令执行结束';
    }
    if (itemType === 'reasoning') {
      return '思考步骤已完成';
    }
    return 'Codex 已处理一个事件';
  }

  private currentTaskResultText(): string {
    if (this.currentTask === null) {
      return '';
    }
    const taskEvents = this.visibleTaskEvents();
    for (let index = taskEvents.length - 1; index >= 0; index -= 1) {
      const event = taskEvents[index];
      if (event.type === 'task.completed') {
        return this.compactDisplayText(this.payloadString(event, 'summary'), 260);
      }
      if (event.type === 'task.failed') {
        const error = this.payloadString(event, 'error');
        const message = this.payloadString(event, 'message');
        return this.compactDisplayText(error.length > 0 ? error : message, 260);
      }
      if (event.type === 'codex.exec.event') {
        const payloadType = event.payload['type'];
        const item = event.payload['item'] as Record<string, Object>;
        if (payloadType === 'item.completed' && item) {
          const itemType = item['type'];
          const text = item['text'];
          if (itemType === 'agent_message' && typeof text === 'string') {
            return this.compactDisplayText(text, 260);
          }
        }
      }
    }
    return '';
  }
  private headerMessageText(): string {
    if (this.currentTask !== null) {
      return this.currentTaskSummaryText();
    }
    return this.compactDisplayText(this.message, 90);
  }

  private payloadString(event: BridgeEvent, key: string): string {
    const value = event.payload[key];
    if (typeof value === 'string') {
      return value;
    }
    if (value === null || value === undefined) {
      return '';
    }
    return JSON.stringify(value);
  }

  private compactionEventText(event: BridgeEvent, fallback: string): string {
    const message = this.payloadString(event, 'message');
    const signal = this.payloadString(event, 'signal');
    const nextAttempt = this.payloadString(event, 'nextAttempt');
    const maxAttempts = this.payloadString(event, 'maxAttempts');
    let text = message.length > 0 ? message : fallback;
    if (signal.length > 0) {
      text = `${text}（${this.compactionSignalLabel(signal)}）`;
    }
    if (nextAttempt.length > 0 && maxAttempts.length > 0) {
      text = `${text}，第 ${nextAttempt}/${maxAttempts} 次提交`;
    }
    return this.compactDisplayText(text, 120);
  }

  private compactionSignalLabel(signal: string): string {
    if (signal === 'post_submit_prewrite_interrupted') {
      return '发送后写入前中断';
    }
    if (signal === 'final_read_prewrite_interrupted') {
      return '最终校验未写入';
    }
    if (signal === 'token_count_near_context_window') {
      return '上下文接近窗口上限';
    }
    if (signal === 'desktop_notification_compaction_text') {
      return '桌面通知压缩';
    }
    if (signal === 'retry_backoff') {
      return '等待稳定';
    }
    return signal;
  }

  private compactDisplayText(value: string, maxLength: number = 160): string {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
  }

  private selectedSessionFingerprint(): CodexSessionFingerprint | null {
    if (this.selectedSession === null) {
      return null;
    }
    return this.sessionFingerprintFromDetail(this.selectedSession);
  }

  private sessionFingerprintFromDetail(session: CodexSessionDetail): CodexSessionFingerprint {
    return {
      id: session.id,
      title: session.title,
      projectRoot: session.projectRoot ?? '',
      projectLabel: session.projectLabel ?? '',
      filePath: session.filePath ?? '',
      entryCount: session.entryCount
    };
  }

  private sessionEntryDisplayText(entry: CodexSessionEntry): string {
    const raw = entry.text.length > 0 ? entry.text : entry.type;
    const imageCleanText = this.sessionEntryVisibleText(entry);
    if (this.isSessionEntryExpanded(entry)) {
      return imageCleanText.length > 0 ? imageCleanText : '图片';
    }
    if (entry.role === 'tool') {
      if (entry.type === 'response_item') {
        if (imageCleanText.indexOf('shell_command') >= 0) {
          return '工具调用：执行本地命令';
        }
        if (imageCleanText.indexOf('Exit code: 0') >= 0) {
          return '工具结果：命令执行成功';
        }
        if (imageCleanText.indexOf('Exit code:') >= 0) {
          return '工具结果：命令执行结束';
        }
      }
      return this.compactDisplayText(imageCleanText.length > 0 ? imageCleanText : raw, 140);
    }
    return imageCleanText.length > 0 ? imageCleanText : '图片';
  }

  private sessionEntryVisibleText(entry: CodexSessionEntry): string {
    if (entry.type === 'live_activity' || entry.type === 'live_agent_status') {
      return this.liveSessionEntryStageText(entry.text.length > 0 ? entry.text : entry.type);
    }
    const raw = entry.text.length > 0 ? entry.text : entry.type;
    return this.markdownPlainDisplayText(this.sessionEntryVisibleMarkdown(entry));
  }

  private liveSessionEntryStageText(value: string): string {
    const text = String(value ?? '').trim();
    if (text.startsWith('正在思考') || text.startsWith('Codex 正在思考')) {
      return '正在思考';
    }
    if (text.startsWith('正在执行命令')) {
      return '正在执行命令';
    }
    if (text.startsWith('正在调用工具')) {
      return '正在调用工具';
    }
    if (text.startsWith('正在返回内容') || text.startsWith('Codex 正在返回内容')) {
      return '正在返回内容';
    }
    if (text.startsWith('执行失败')) {
      return '执行失败';
    }
    return text.length > 0 ? text : 'Codex 正在处理当前消息';
  }

  private sessionEntryVisibleMarkdown(entry: CodexSessionEntry): string {
    const raw = entry.text.length > 0 ? entry.text : entry.type;
    return this.sanitizeSessionVisibleText(entry, this.stripSessionImageText(raw));
  }

  private sessionEntryMarkdownBlocks(entry: CodexSessionEntry): SessionMarkdownBlock[] {
    return this.parseSessionMarkdown(this.sessionEntryVisibleMarkdown(entry));
  }

  private parseSessionMarkdown(text: string): SessionMarkdownBlock[] {
    const blocks: SessionMarkdownBlock[] = [];
    const paragraphLines: string[] = [];
    const codeLines: string[] = [];
    let inCode = false;
    let codeLanguage = '';
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

    const pushBlock = (kind: string, value: string, level: number = 0, checked: boolean = false, ordered: boolean = false, language: string = ''): void => {
      const trimmedValue = kind === 'code' ? value.replace(/\n+$/g, '') : value.trim();
      if (trimmedValue.length === 0 && kind !== 'rule') {
        return;
      }
      blocks.push({
        id: `md-${blocks.length}-${kind}`,
        kind,
        text: trimmedValue,
        level,
        checked,
        ordered,
        language
      });
    };

    const flushParagraph = (): void => {
      if (paragraphLines.length === 0) {
        return;
      }
      pushBlock('paragraph', paragraphLines.join('\n'));
      paragraphLines.length = 0;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();

      if (trimmed.startsWith('```')) {
        if (inCode) {
          pushBlock('code', codeLines.join('\n'), 0, false, false, codeLanguage);
          codeLines.length = 0;
          codeLanguage = '';
          inCode = false;
        } else {
          flushParagraph();
          inCode = true;
          codeLanguage = trimmed.slice(3).trim();
        }
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        continue;
      }

      if (trimmed.length === 0) {
        flushParagraph();
        continue;
      }

      if (index + 1 < lines.length
        && parseSessionMarkdownTable(`${line}\n${lines[index + 1]}`).headers.length > 0) {
        flushParagraph();
        const tableLines: string[] = [line, lines[index + 1]];
        let tableIndex = index + 2;
        while (tableIndex < lines.length) {
          const tableLine = lines[tableIndex].trim();
          if (tableLine.length === 0 || tableLine.indexOf('|') < 0) {
            break;
          }
          tableLines.push(lines[tableIndex]);
          tableIndex += 1;
        }
        pushBlock('table', tableLines.join('\n'));
        index = tableIndex - 1;
        continue;
      }

      const codexDirectiveName = this.markdownCodexDirectiveName(trimmed);
      if (codexDirectiveName.length > 0) {
        flushParagraph();
        pushBlock('codex_directive', trimmed, 0, false, false, codexDirectiveName);
        continue;
      }

      const directiveTag = this.markdownDirectiveOpenTag(trimmed);
      if (directiveTag.length > 0) {
        flushParagraph();
        const directiveLines: string[] = [line];
        const closeTag = `</${directiveTag}>`;
        if (trimmed.indexOf(closeTag) < 0 && !trimmed.endsWith('/>')) {
          let scan = index + 1;
          while (scan < lines.length) {
            directiveLines.push(lines[scan]);
            if (lines[scan].trim() === closeTag) {
              break;
            }
            scan += 1;
          }
          index = scan;
        }
        pushBlock('directive', directiveLines.join('\n'), 0, false, false, directiveTag);
        continue;
      }

      if (this.isMarkdownRuleLine(trimmed)) {
        flushParagraph();
        pushBlock('rule', '-', 0);
        continue;
      }

      const headingLevel = this.markdownHeadingLevel(trimmed);
      if (headingLevel > 0) {
        flushParagraph();
        pushBlock('heading', trimmed.slice(headingLevel + 1), headingLevel);
        continue;
      }

      if (trimmed.startsWith('>')) {
        flushParagraph();
        pushBlock('quote', trimmed.replace(/^>\s?/, ''));
        continue;
      }

      const taskMatch = trimmed.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/);
      if (taskMatch !== null) {
        flushParagraph();
        pushBlock('task', taskMatch[2], 0, taskMatch[1].toLowerCase() === 'x');
        continue;
      }

      const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
      if (bulletMatch !== null) {
        flushParagraph();
        pushBlock('list', bulletMatch[1], 0, false, false);
        continue;
      }

      const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
      if (orderedMatch !== null) {
        flushParagraph();
        pushBlock('list', orderedMatch[2], Number(orderedMatch[1]), false, true);
        continue;
      }

      paragraphLines.push(line);
    }

    if (inCode) {
      pushBlock('code', codeLines.join('\n'), 0, false, false, codeLanguage);
    }
    flushParagraph();

    if (blocks.length === 0) {
      pushBlock('paragraph', this.markdownPlainDisplayText(text));
    }
    return blocks;
  }

  private markdownCodexDirectiveName(trimmedLine: string): string {
    if (!trimmedLine.startsWith('::')) {
      return '';
    }
    const match = trimmedLine.match(/^::([A-Za-z][A-Za-z0-9_.-]*)\{/);
    if (match === null) {
      return '';
    }
    return match[1];
  }

  private codexDirectiveTitle(name: string): string {
    if (name === 'git-create-branch') {
      return '创建 Git 分支';
    }
    if (name === 'git-stage') {
      return '暂存 Git 改动';
    }
    if (name === 'git-commit') {
      return '提交 Git 变更';
    }
    if (name === 'git-push') {
      return '推送 Git 远端';
    }
    if (name === 'git-merge') {
      return '合并 Git 分支';
    }
    if (name === 'git-checkout') {
      return '切换 Git 分支';
    }
    return `Codex 指令：${name}`;
  }

  private codexDirectiveAccentColor(name: string): string {
    if (name === 'git-stage') {
      return this.themeColor('#14853D');
    }
    if (name === 'git-commit') {
      return this.themeColor('#B54708');
    }
    if (name === 'git-push') {
      return this.themeColor('#7A4E00');
    }
    return this.themeColor('#1F6FEB');
  }

  private codexDirectiveAccentBackground(name: string): string {
    if (name === 'git-stage') {
      return this.themeColor('#EAF8EF');
    }
    if (name === 'git-commit') {
      return this.themeColor('#FFF4E5');
    }
    if (name === 'git-push') {
      return this.themeColor('#FFF8D8');
    }
    return this.themeColor('#EAF4FF');
  }

  private codexDirectiveSummary(block: SessionMarkdownBlock): string {
    const text = String(block.text ?? '');
    const parts: string[] = [];
    const branch = this.codexDirectiveAttribute(text, 'branch');
    const cwd = this.codexDirectiveAttribute(text, 'cwd');
    const message = this.codexDirectiveAttribute(text, 'message');
    if (branch.length > 0) {
      parts.push(`分支 ${branch}`);
    }
    if (message.length > 0) {
      parts.push(this.compactDisplayText(message, 44));
    }
    if (cwd.length > 0) {
      parts.push(this.codexDirectivePathSummary(cwd));
    }
    if (parts.length > 0) {
      return parts.join(' · ');
    }
    return this.compactDisplayText(text.replace(/^::[A-Za-z][A-Za-z0-9_.-]*\{/, '').replace(/\}$/g, ''), 80);
  }

  private structuredFieldLabelColor(kind: string): string {
    if (kind === 'code') {
      return this.themeColor('#344054');
    }
    if (kind === 'path') {
      return this.themeColor('#175CD3');
    }
    if (kind === 'source') {
      return this.themeColor('#1F6FEB');
    }
    return this.themeColor('#475467');
  }

  private structuredFieldLabelBackground(kind: string): string {
    if (kind === 'code') {
      return this.themeColor('#F2F4F7');
    }
    if (kind === 'path') {
      return this.themeColor('#EAF4FF');
    }
    if (kind === 'source') {
      return this.themeColor('#EAF4FF');
    }
    return this.themeColor('#F2F4F7');
  }

  private codexDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[] {
    const text = String(block.text ?? '');
    const fields: SessionStructuredField[] = [];
    const cwd = this.codexDirectiveAttribute(text, 'cwd');
    const branch = this.codexDirectiveAttribute(text, 'branch');
    const message = this.codexDirectiveAttribute(text, 'message');
    fields.push({
      label: '操作',
      value: this.codexDirectiveTitle(block.language),
      meta: '',
      kind: 'normal'
    });
    if (message.length > 0) {
      fields.push({
        label: '说明',
        value: message,
        meta: '',
        kind: 'normal'
      });
    }
    if (branch.length > 0) {
      fields.push({
        label: '分支',
        value: branch,
        meta: '',
        kind: 'code'
      });
    }
    if (cwd.length > 0) {
      fields.push({
        label: '工作区',
        value: this.codexDirectivePathSummary(cwd),
        meta: cwd,
        kind: 'path'
      });
    }
    fields.push({
      label: '指令',
      value: this.compactDisplayText(text, 120),
      meta: '',
      kind: 'code'
    });
    return fields;
  }

  private codexDirectiveDetailText(block: SessionMarkdownBlock): string {
    const text = String(block.text ?? '');
    const details: string[] = [];
    const cwd = this.codexDirectiveAttribute(text, 'cwd');
    const branch = this.codexDirectiveAttribute(text, 'branch');
    const message = this.codexDirectiveAttribute(text, 'message');
    details.push(`类型：${this.codexDirectiveTitle(block.language)}`);
    if (cwd.length > 0) {
      details.push(`工作区：${cwd}`);
    }
    if (branch.length > 0) {
      details.push(`分支：${branch}`);
    }
    if (message.length > 0) {
      details.push(`提交信息：${message}`);
    }
    details.push(`原始指令：${text}`);
    return details.join('\n');
  }

  private codexDirectiveAttribute(text: string, name: string): string {
    const quotedPrefix = `${name}="`;
    const quotedStart = text.indexOf(quotedPrefix);
    if (quotedStart >= 0) {
      const valueStart = quotedStart + quotedPrefix.length;
      const valueEnd = text.indexOf('"', valueStart);
      if (valueEnd > valueStart) {
        return text.slice(valueStart, valueEnd);
      }
    }
    const plainPrefix = `${name}=`;
    const plainStart = text.indexOf(plainPrefix);
    if (plainStart < 0) {
      return '';
    }
    let value = text.slice(plainStart + plainPrefix.length).trim();
    const spaceIndex = value.search(/\s/);
    if (spaceIndex >= 0) {
      value = value.slice(0, spaceIndex);
    }
    return value.replace(/[},]$/g, '');
  }

  private codexDirectivePathSummary(pathText: string): string {
    const normalized = pathText.replace(/\\/g, '/');
    const parts = normalized.split('/').filter((part: string) => part.length > 0);
    if (parts.length === 0) {
      return pathText;
    }
    return parts[parts.length - 1];
  }

  private markdownDirectiveOpenTag(trimmedLine: string): string {
    if (!trimmedLine.startsWith('<') || trimmedLine.startsWith('</')) {
      return '';
    }
    const match = trimmedLine.match(/^<([A-Za-z][A-Za-z0-9_.:-]*)(\s[^>]*)?>/);
    if (match === null) {
      return '';
    }
    const tag = match[1];
    if (tag.length === 0 || trimmedLine.indexOf('</') === 0) {
      return '';
    }
    return tag;
  }

  private markdownDirectiveTitle(tag: string): string {
    if (tag === 'oai-mem-citation') {
      return '记忆引用';
    }
    if (tag === 'citation_entries') {
      return '引用条目';
    }
    if (tag === 'rollout_ids') {
      return '历史会话编号';
    }
    if (tag === 'app-context') {
      return '应用上下文';
    }
    if (tag === 'environment_context') {
      return '环境上下文';
    }
    if (tag === 'permissions') {
      return '权限说明';
    }
    return `指令块：${tag}`;
  }

  private markdownDirectiveSummary(block: SessionMarkdownBlock): string {
    const tag = block.language;
    const lines = String(block.text ?? '').split('\n');
    const visibleLines: string[] = [];
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return;
      }
      visibleLines.push(trimmed);
    });
    if (tag === 'oai-mem-citation') {
      const citation = visibleLines.find((line: string) => line.indexOf('MEMORY.md:') >= 0 || line.indexOf('rollout_summaries/') >= 0);
      if (citation !== undefined && citation.length > 0) {
        return this.compactDisplayText(citation.replace('|note=[', ' · ').replace(/\]$/g, ''), 96);
      }
      return '已折叠记忆引用元数据';
    }
    if (visibleLines.length === 0) {
      return '已折叠结构化指令内容';
    }
    return this.compactDisplayText(visibleLines.join(' / '), 96);
  }

  private markdownDirectiveVisibleLines(block: SessionMarkdownBlock): string[] {
    const lines = String(block.text ?? '').split('\n');
    const visibleLines: string[] = [];
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return;
      }
      visibleLines.push(trimmed);
    });
    return visibleLines;
  }

  private markdownDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[] {
    const lines = this.markdownDirectiveVisibleLines(block);
    const fields: SessionStructuredField[] = [];
    if (block.language === 'oai-mem-citation') {
      lines.forEach((line: string) => {
        const noteStart = line.indexOf('|note=[');
        const source = noteStart >= 0 ? line.slice(0, noteStart).trim() : line.trim();
        const note = noteStart >= 0 ? line.slice(noteStart + 7).replace(/\]$/g, '').trim() : '';
        const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source);
        fields.push({
          label: uuidLike ? '会话' : '来源',
          value: source,
          meta: note,
          kind: uuidLike ? 'code' : 'source'
        });
      });
      if (fields.length === 0) {
        fields.push({
          label: '记忆',
          value: '没有可展示的引用条目',
          meta: '',
          kind: 'normal'
        });
      }
      return fields;
    }
    lines.forEach((line: string, index: number) => {
      fields.push({
        label: index === 0 ? '内容' : '补充',
        value: line.replace('|note=[', ' · ').replace(/\]$/g, ''),
        meta: '',
        kind: 'normal'
      });
    });
    if (fields.length === 0) {
      fields.push({
        label: '内容',
        value: this.markdownDirectiveSummary(block),
        meta: '',
        kind: 'normal'
      });
    }
    return fields;
  }

  private markdownDirectiveDetailText(block: SessionMarkdownBlock): string {
    const lines = String(block.text ?? '').split('\n');
    const visibleLines: string[] = [];
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return;
      }
      visibleLines.push(trimmed.replace('|note=[', ' · ').replace(/\]$/g, ''));
    });
    if (visibleLines.length === 0) {
      return this.markdownDirectiveSummary(block);
    }
    return visibleLines.join('\n');
  }

  private markdownHeadingLevel(trimmedLine: string): number {
    let level = 0;
    while (level < trimmedLine.length && trimmedLine.charAt(level) === '#') {
      level += 1;
    }
    if (level < 1 || level > 4) {
      return 0;
    }
    return trimmedLine.length > level && trimmedLine.charAt(level) === ' ' ? level : 0;
  }

  private isMarkdownRuleLine(trimmedLine: string): boolean {
    return /^-{3,}$/.test(trimmedLine) || /^\*{3,}$/.test(trimmedLine) || /^_{3,}$/.test(trimmedLine);
  }

  private markdownHeadingFontSize(level: number, isUser: boolean): number {
    if (level <= 1) {
      return isUser ? 14 : 13;
    }
    if (level === 2) {
      return isUser ? 13 : 12;
    }
    return isUser ? 12 : 11;
  }

  private markdownHeadingLineHeight(level: number, isUser: boolean): number {
    if (level <= 1) {
      return isUser ? 20 : 19;
    }
    if (level === 2) {
      return isUser ? 19 : 18;
    }
    return isUser ? 17 : 16;
  }

  private markdownInlineDisplayText(text: string): string {
    let value = String(text ?? '');
    value = this.replaceMarkdownImagesForDisplay(value);
    value = this.replaceMarkdownLinksForDisplay(value);
    value = this.replaceInlineAngleCommandsForDisplay(value);
    value = value.replace(/\*\*([^*]+)\*\*/g, '$1');
    value = value.replace(/__([^_]+)__/g, '$1');
    value = value.replace(/\*([^*]+)\*/g, '$1');
    value = value.replace(/_([^_]+)_/g, '$1');
    value = value.replace(/`([^`]+)`/g, '$1');
    value = value.replace(/~~([^~]+)~~/g, '$1');
    return value.trim();
  }

  private replaceInlineAngleCommandsForDisplay(text: string): string {
    let value = String(text ?? '');
    value = value.replace(/<\.\.\.>/g, '结构化指令');
    value = value.replace(/<([A-Za-z][A-Za-z0-9_.:-]*)>/g, '指令块：$1');
    value = value.replace(/<\/([A-Za-z][A-Za-z0-9_.:-]*)>/g, '');
    return value;
  }

  private markdownPlainDisplayText(text: string): string {
    const lines = String(text ?? '').split('\n');
    const cleaned: string[] = [];
    let directiveDepth = 0;
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (directiveDepth > 0) {
        if (trimmed.startsWith('</') && trimmed.endsWith('>')) {
          directiveDepth -= 1;
        }
        return;
      }
      const directiveTag = this.markdownDirectiveOpenTag(trimmed);
      if (directiveTag.length > 0) {
        if (trimmed.indexOf(`</${directiveTag}>`) < 0 && !trimmed.endsWith('/>')) {
          directiveDepth += 1;
        }
        cleaned.push(this.markdownDirectiveTitle(directiveTag));
        return;
      }
      const codexDirectiveName = this.markdownCodexDirectiveName(trimmed);
      if (codexDirectiveName.length > 0) {
        cleaned.push(this.codexDirectiveTitle(codexDirectiveName));
        return;
      }
      const headingLevel = this.markdownHeadingLevel(trimmed);
      if (headingLevel > 0) {
        cleaned.push(this.markdownInlineDisplayText(trimmed.slice(headingLevel + 1)));
        return;
      }
      if (trimmed.startsWith('>')) {
        cleaned.push(this.markdownInlineDisplayText(trimmed.replace(/^>\s?/, '')));
        return;
      }
      const taskMatch = trimmed.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/);
      if (taskMatch !== null) {
        cleaned.push(`${taskMatch[1].toLowerCase() === 'x' ? '已完成' : '待完成'}：${this.markdownInlineDisplayText(taskMatch[2])}`);
        return;
      }
      const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
      if (bulletMatch !== null) {
        cleaned.push(this.markdownInlineDisplayText(bulletMatch[1]));
        return;
      }
      const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
      if (orderedMatch !== null) {
        cleaned.push(`${orderedMatch[1]}. ${this.markdownInlineDisplayText(orderedMatch[2])}`);
        return;
      }
      if (!this.isMarkdownRuleLine(trimmed)) {
        cleaned.push(this.markdownInlineDisplayText(line));
      }
    });
    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private sessionEntryImages(entry: CodexSessionEntry): string[] {
    const urls: string[] = [];
    this.sessionEntryImagePaths(entry.text).forEach((imagePath: string) => {
      const url = this.mobileImagePreviewUrl(imagePath);
      if (url.length > 0 && urls.indexOf(url) < 0) {
        urls.push(url);
      }
    });
    return urls;
  }

  private shouldRenderUserTextBubble(entry: CodexSessionEntry): boolean {
    return this.sessionEntryVisibleText(entry).trim().length > 0;
  }

  private userSessionEntryWidth(entry: CodexSessionEntry): string | number {
    if (this.sessionEntryImages(entry).length > 0 && !this.shouldRenderUserTextBubble(entry)) {
      return this.isLandscapeSessionLayout() ? '72%' : '58%';
    }
    return this.userTextBubbleWidth(this.sessionEntryVisibleText(entry));
  }

  private userTextBubbleWidth(text: string): number {
    const lines = text.trim().split('\n');
    let longestLineLength = 0;
    lines.forEach((line: string) => {
      longestLineLength = Math.max(longestLineLength, line.trim().length);
    });
    return Math.max(112, Math.min(620, 32 + longestLineLength * 13));
  }

  private userImageEntryWidth(entry: CodexSessionEntry): string {
    if (!this.shouldRenderUserTextBubble(entry)) {
      return '100%';
    }
    return this.isLandscapeSessionLayout() ? '72%' : '58%';
  }

  private pendingUserInput(): BridgeUserInput | null {
    const task = this.selectedVisibleTask();
    if (task?.pendingUserInput && task.pendingUserInput.status === 'pending') {
      return task.pendingUserInput;
    }
    if (this.selectedSession === null && !this.isNewSessionDraft
      && this.currentTask?.pendingUserInput
      && this.currentTask.pendingUserInput.status === 'pending') {
      return this.currentTask.pendingUserInput;
    }
    return null;
  }

  private userInputAnswer(questionId: string): string {
    return this.userInputAnswers[questionId] ?? '';
  }

  private setUserInputAnswer(questionId: string, value: string): void {
    const next: Record<string, string> = {};
    Object.keys(this.userInputAnswers).forEach((key: string) => {
      next[key] = this.userInputAnswers[key];
    });
    next[questionId] = value;
    this.userInputAnswers = next;
  }

  private canAnswerPendingUserInput(): boolean {
    const request = this.pendingUserInput();
    if (request === null || this.isBusy) {
      return false;
    }
    return request.questions.every((question: BridgeUserInputQuestion) => {
      return this.userInputAnswer(question.id).trim().length > 0;
    });
  }

  private userImageEntryHeight(entry: CodexSessionEntry): number {
    if (!this.shouldRenderUserTextBubble(entry)) {
      return this.isLandscapeSessionLayout() ? 300 : 430;
    }
    return this.isLandscapeSessionLayout() ? 240 : 300;
  }

  private assistantImageEntryWidth(): string {
    return this.isLandscapeSessionLayout() ? '72%' : '64%';
  }

  private assistantImageEntryHeight(): number {
    return this.isLandscapeSessionLayout() ? 300 : 260;
  }

  private sessionEntryImagePaths(text: string): string[] {
    const paths: string[] = [];
    this.collectMarkdownImagePaths(text, paths);
    const lines = String(text ?? '').split('\n');
    lines.forEach((line: string) => {
      const colonIndex = line.indexOf('图片路径：');
      const asciiColonIndex = line.indexOf('图片路径:');
      const markerIndex = colonIndex >= 0 ? colonIndex : asciiColonIndex;
      if (markerIndex >= 0) {
        const markerLength = colonIndex >= 0 ? 5 : 5;
        this.addImagePathCandidate(line.slice(markerIndex + markerLength), paths);
      }
    });
    return paths;
  }

  private stripSessionImageText(text: string): string {
    const kept: string[] = [];
    const lines = String(text ?? '').split('\n');
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (trimmed === '我从手机端发送了一张图片，请查看并结合当前对话回复。') {
        return;
      }
      if (trimmed.startsWith('图片路径：') || trimmed.startsWith('图片路径:')) {
        return;
      }
      if (this.isMarkdownImageOnlyLine(trimmed)) {
        return;
      }
      kept.push(line);
    });
    return kept.join('\n').trim();
  }

  private cleanSessionDisplayMarkdown(text: string): string {
    const lines = String(text ?? '').split('\n');
    const cleaned: string[] = [];
    lines.forEach((line: string) => {
      let value = line;
      value = this.replaceMarkdownLinksForDisplay(value);
      value = value.replace(/\*\*/g, '');
      value = value.replace(/`/g, '');
      cleaned.push(value);
    });
    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private sanitizeSessionVisibleText(entry: CodexSessionEntry, text: string): string {
    let visible = this.stripInternalInstructionBlocks(text);
    visible = this.stripCodexDirectiveBlocks(visible);
    if (entry.role === 'user') {
      visible = this.stripLeadingSkillToken(visible);
    }
    visible = this.stripMobileImagePromptText(visible);
    return visible.replace(/\n{3,}/g, '\n\n').trim();
  }

  private stripMobileImagePromptText(text: string): string {
    const lines = String(text ?? '').split('\n');
    const kept: string[] = [];
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (trimmed === '我从手机端发送了一张图片，请查看并结合当前对话回复。') {
        return;
      }
      if (trimmed.startsWith('图片路径：') || trimmed.startsWith('图片路径:')) {
        return;
      }
      if (this.isMarkdownImageOnlyLine(trimmed)) {
        return;
      }
      kept.push(line);
    });
    return kept.join('\n').trim();
  }

  private stripInternalInstructionBlocks(text: string): string {
    let visible = String(text ?? '');
    const blockNames: string[] = [
      'permissions instructions',
      'environment_context',
      'app-context',
      'collaboration_mode',
      'skills_instructions',
      'plugins_instructions',
      'personality_spec'
    ];
    blockNames.forEach((name: string) => {
      visible = this.stripXmlLikeBlock(visible, name);
    });
    const agentsIndex = visible.indexOf('# AGENTS.md instructions');
    if (agentsIndex >= 0) {
      visible = visible.slice(0, agentsIndex);
    }
    return visible;
  }

  private stripCodexDirectiveBlocks(text: string): string {
    const lines = String(text ?? '').split('\n');
    const kept: string[] = [];
    let skippingDirective = false;
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (!skippingDirective && this.isCodexDirectiveStart(trimmed)) {
        skippingDirective = !this.isCodexDirectiveEnd(trimmed);
        return;
      }
      if (skippingDirective) {
        if (this.isCodexDirectiveEnd(trimmed)) {
          skippingDirective = false;
        }
        return;
      }
      kept.push(line);
    });
    return kept.join('\n');
  }

  private isCodexDirectiveStart(trimmedLine: string): boolean {
    return trimmedLine.startsWith('::code-comment{') || trimmedLine.startsWith('::archive{');
  }

  private isCodexDirectiveEnd(trimmedLine: string): boolean {
    return trimmedLine.endsWith('}');
  }

  private stripXmlLikeBlock(text: string, blockName: string): string {
    let visible = String(text ?? '');
    const open = `<${blockName}>`;
    const close = `</${blockName}>`;
    let guard = 0;
    while (guard < 12) {
      const start = visible.indexOf(open);
      if (start < 0) {
        break;
      }
      const end = visible.indexOf(close, start + open.length);
      if (end < 0) {
        visible = visible.slice(0, start);
        break;
      }
      visible = `${visible.slice(0, start)}${visible.slice(end + close.length)}`;
      guard += 1;
    }
    return visible;
  }

  private stripLeadingSkillToken(text: string): string {
    const visible = String(text ?? '');
    const trimmed = visible.trimStart();
    if (!trimmed.startsWith('$')) {
      return visible;
    }
    const firstSpace = trimmed.search(/\s/);
    const token = firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed;
    if (!/^[$][A-Za-z0-9][A-Za-z0-9_.-]*$/.test(token)) {
      return visible;
    }
    const rest = firstSpace >= 0 ? trimmed.slice(firstSpace).trimStart() : '';
    const leadingLength = visible.length - trimmed.length;
    return `${visible.slice(0, leadingLength)}${rest}`;
  }

  private replaceMarkdownImagesForDisplay(text: string): string {
    let value = text;
    let guard = 0;
    while (guard < 12) {
      const imageStart = value.indexOf('![');
      if (imageStart < 0) {
        break;
      }
      const labelEnd = value.indexOf('](', imageStart);
      if (labelEnd < 0) {
        break;
      }
      const linkEnd = value.indexOf(')', labelEnd + 2);
      if (linkEnd < 0) {
        break;
      }
      const label = value.slice(imageStart + 2, labelEnd).trim();
      const display = label.length > 0 ? label : '图片';
      value = `${value.slice(0, imageStart)}${display}${value.slice(linkEnd + 1)}`;
      guard += 1;
    }
    return value;
  }

  private replaceMarkdownLinksForDisplay(text: string): string {
    let value = text;
    let guard = 0;
    while (guard < 12) {
      const labelStart = value.indexOf('[');
      if (labelStart < 0) {
        break;
      }
      const labelEnd = value.indexOf('](', labelStart);
      if (labelEnd < 0) {
        break;
      }
      const linkEnd = value.indexOf(')', labelEnd + 2);
      if (linkEnd < 0) {
        break;
      }
      const label = value.slice(labelStart + 1, labelEnd);
      value = `${value.slice(0, labelStart)}${label}${value.slice(linkEnd + 1)}`;
      guard += 1;
    }
    return value;
  }

  private isMarkdownImageOnlyLine(text: string): boolean {
    if (!text.startsWith('![')) {
      return false;
    }
    const linkStart = text.indexOf('](');
    if (linkStart < 0 || !text.endsWith(')')) {
      return false;
    }
    const pathText = text.slice(linkStart + 2, text.length - 1);
    return this.isImagePathCandidate(pathText);
  }

  private collectMarkdownImagePaths(text: string, paths: string[]): void {
    const lines = String(text ?? '').split('\n');
    lines.forEach((line: string) => {
      const trimmed = line.trim();
      if (!this.isMarkdownImageOnlyLine(trimmed)) {
        return;
      }
      const linkStart = trimmed.indexOf('](');
      this.addImagePathCandidate(trimmed.slice(linkStart + 2, trimmed.length - 1), paths);
    });
  }

  private addImagePathCandidate(value: string, paths: string[]): void {
    const trimmed = this.normalizedImagePathCandidate(String(value ?? '').trim().replace(/^["']|["']$/g, ''));
    if (!this.isImagePathCandidate(trimmed)) {
      return;
    }
    if (paths.indexOf(trimmed) < 0) {
      paths.push(trimmed);
    }
  }

  private isImagePathCandidate(value: string): boolean {
    const lower = value.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      return true;
    }
    if (lower.indexOf('<') >= 0 || lower.indexOf('>') >= 0) {
      return false;
    }
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      || lower.endsWith('.webp') || lower.endsWith('.gif');
  }

  private normalizedImagePathCandidate(value: string): string {
    const trimmed = String(value ?? '').trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      return trimmed;
    }
    return trimmed.replace(/\\/g, '/');
  }

  private mobileImagePreviewUrl(imagePath: string): string {
    const trimmed = imagePath.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (trimmed.length === 0) {
      return '';
    }
    return `${this.normalizedBridgeUrl()}/mobile/images/file?path=${encodeURIComponent(trimmed)}&token=${encodeURIComponent(this.bridgeToken)}`;
  }

  private eventLabel(type: string): string {
    if (type === 'task.created') {
      return '任务已创建';
    }
    if (type === 'task.running') {
      return '任务运行中';
    }
    if (type === 'task.completed') {
      return '任务已完成';
    }
    if (type === 'task.interrupted') {
      return '任务已中断';
    }
    if (type === 'task.interrupt.requested') {
      return '请求中断';
    }
    if (type === 'task.interrupt.dispatching') {
      return '正在中断';
    }
    if (type === 'task.interrupt.failed') {
      return '中断失败';
    }
    if (type === 'task.failed') {
      return '任务失败';
    }
    if (type === 'approval.required') {
      return '需要确认';
    }
    if (type === 'approval.decided') {
      return '确认已处理';
    }
    if (type === 'codex.exec.started') {
      return 'Codex 已启动';
    }
    if (type === 'codex.exec.event') {
      return 'Codex 事件';
    }
    if (type === 'codex.exec.stderr') {
      return 'Codex 诊断';
    }
    if (type === 'codex.exec.finished') {
      return 'Codex 已结束';
    }
    return type;
  }

  private statusLabel(status: string): string {
    if (status === 'completed') {
      return '已完成';
    }
    if (status === 'failed') {
      return '失败';
    }
    if (status === 'interrupted') {
      return '已中断';
    }
    if (status === 'waiting_approval') {
      return '待确认';
    }
    if (status === 'waiting_input') {
      return '待回答';
    }
    if (status === 'running') {
      return '运行中';
    }
    if (status === 'queued') {
      return '排队中';
    }
    if (status === 'recovering') {
      return '正在恢复';
    }
    return '空闲';
  }

  private decisionLabel(decision: string): string {
    if (decision === 'approved') {
      return '已同意';
    }
    if (decision === 'denied') {
      return '已拒绝';
    }
    return decision;
  }

  private riskLabel(risk: string): string {
    if (risk === 'high') {
      return '高风险';
    }
    if (risk === 'medium') {
      return '中风险';
    }
    if (risk === 'low') {
      return '低风险';
    }
    return '未知风险';
  }

  private roleLabel(role: string): string {
    if (role === 'user') {
      return '你';
    }
    if (role === 'assistant') {
      return '助手';
    }
    if (role === 'tool') {
      return '工具';
    }
    return '系统';
  }

  private statusColor(status: string): string {
    if (status === 'completed') {
      return this.themeColor('#137333');
    }
    if (status === 'failed') {
      return this.themeColor('#B42318');
    }
    if (status === 'interrupted') {
      return this.themeColor('#68717D');
    }
    if (status === 'waiting_approval') {
      return this.themeColor('#A15C00');
    }
    if (status === 'waiting_input') {
      return this.themeColor('#7C3AED');
    }
    if (status === 'running' || status === 'recovering') {
      return this.themeColor('#1F6FEB');
    }
    return this.themeColor('#68717D');
  }
}

@Extend(Column)
function cardStyle(backgroundColor: ResourceColor) {
  .width('100%')
  .padding(14)
  .backgroundColor(backgroundColor)
  .borderRadius(8)
}
