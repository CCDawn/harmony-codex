import { CompanionComputerLifecycle } from '../services/CompanionComputerLifecycle';
import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import {
  NOTIFICATION_EVENT_ID_STORAGE_KEY,
  NOTIFICATION_EVENT_TYPE_STORAGE_KEY,
  NOTIFICATION_REVISION_STORAGE_KEY,
  NOTIFICATION_SESSION_STORAGE_KEY
} from '../services/AppNotificationService';
import { AppBackgroundRuntimeService } from '../services/AppBackgroundRuntimeService';

const WINDOW_WIDTH_STORAGE_KEY = 'codexRemoteWindowWidth';
const WINDOW_HEIGHT_STORAGE_KEY = 'codexRemoteWindowHeight';
const ACTIVE_SESSION_STORAGE_KEY = 'codexRemoteActiveSessionId';
const SESSION_NAVIGATION_STORAGE_KEY = 'codexRemoteSessionNavigationState';
const SESSION_DRAFT_STORAGE_KEY = 'codexRemoteSessionDraft';
const SESSION_SIDEBAR_WIDTH_STORAGE_KEY = 'codexRemoteSessionSidebarWidth';
const PREVIEW_IMAGE_URL_STORAGE_KEY = 'codexRemotePreviewImageUrl';
const DESKTOP_PREVIEW_IMAGE_URL_STORAGE_KEY = 'codexRemoteDesktopPreviewImageUrl';
const IMAGE_PREVIEW_SCALE_STORAGE_KEY = 'codexRemoteImagePreviewScale';
const IMAGE_PREVIEW_ROTATION_STORAGE_KEY = 'codexRemoteImagePreviewRotation';
const IMAGE_PREVIEW_OFFSET_X_STORAGE_KEY = 'codexRemoteImagePreviewOffsetX';
const IMAGE_PREVIEW_OFFSET_Y_STORAGE_KEY = 'codexRemoteImagePreviewOffsetY';

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | null = null;
  private readonly windowSizeChangeHandler = (size: window.Size): void => {
    this.syncWindowSize(size.width, size.height);
  };

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.syncSystemDarkMode(this.context.config.colorMode);
    AppStorage.setOrCreate<number>(WINDOW_WIDTH_STORAGE_KEY, 0);
    AppStorage.setOrCreate<number>(WINDOW_HEIGHT_STORAGE_KEY, 0);
    AppStorage.setOrCreate<string>(ACTIVE_SESSION_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(SESSION_NAVIGATION_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(SESSION_DRAFT_STORAGE_KEY, '');
    AppStorage.setOrCreate<number>(SESSION_SIDEBAR_WIDTH_STORAGE_KEY, 304);
    AppStorage.setOrCreate<string>(PREVIEW_IMAGE_URL_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(DESKTOP_PREVIEW_IMAGE_URL_STORAGE_KEY, '');
    AppStorage.setOrCreate<number>(IMAGE_PREVIEW_SCALE_STORAGE_KEY, 1);
    AppStorage.setOrCreate<number>(IMAGE_PREVIEW_ROTATION_STORAGE_KEY, 0);
    AppStorage.setOrCreate<number>(IMAGE_PREVIEW_OFFSET_X_STORAGE_KEY, 0);
    AppStorage.setOrCreate<number>(IMAGE_PREVIEW_OFFSET_Y_STORAGE_KEY, 0);
    AppStorage.setOrCreate<string>(NOTIFICATION_SESSION_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(NOTIFICATION_EVENT_TYPE_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(NOTIFICATION_EVENT_ID_STORAGE_KEY, '');
    AppStorage.setOrCreate<string>(NOTIFICATION_REVISION_STORAGE_KEY, '');
    this.applyNotificationTarget(want);
    void AppBackgroundRuntimeService.ensureRunning(this.context, 'ability_create')
      .then(() => {
        console.info('[CodexRemote] Background runtime ready: ability_create');
      })
      .catch((error: Error) => {
        console.error('[CodexRemote] Background runtime failed: ability_create: ' + error.message);
      });
    console.info('[CodexRemote] EntryAbility onCreate');
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.applyNotificationTarget(want);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.syncSystemDarkMode(newConfig.colorMode);
  }

  onForeground(): void {
    CompanionComputerLifecycle.setForeground(true);
    void AppBackgroundRuntimeService.ensureRunning(this.context, 'ability_foreground')
      .catch((error: Error) => {
        console.error('[CodexRemote] Background runtime failed: ability_foreground: ' + error.message);
      });
  }

  onBackground(): void {
    CompanionComputerLifecycle.setForeground(false);
    void AppBackgroundRuntimeService.ensureRunning(this.context, 'ability_background')
      .catch((error: Error) => {
        console.error('[CodexRemote] Background runtime failed: ability_background: ' + error.message);
      });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    void windowStage.getMainWindow()
      .then((mainWindow: window.Window) => {
        this.mainWindow = mainWindow;
        mainWindow.on('windowSizeChange', this.windowSizeChangeHandler);
        const windowRect = mainWindow.getWindowProperties().windowRect;
        this.syncWindowSize(windowRect.width, windowRect.height);
      })
      .catch((error: Error) => {
        console.error('[CodexRemote] Failed to observe window size: ' + error.message);
      });

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error('[CodexRemote] Failed to load Index: ' + JSON.stringify(err));
        return;
      }
      console.info('[CodexRemote] Index loaded');
    });
  }

  onWindowStageDestroy(): void {
    if (this.mainWindow !== null) {
      this.mainWindow.off('windowSizeChange', this.windowSizeChangeHandler);
      this.mainWindow = null;
    }
  }

  private syncSystemDarkMode(colorMode?: ConfigurationConstant.ColorMode): void {
    AppStorage.setOrCreate(
      'codexRemoteSystemDarkMode',
      colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK
    );
  }

  private syncWindowSize(width: number, height: number): void {
    AppStorage.set<number>(WINDOW_WIDTH_STORAGE_KEY, width);
    AppStorage.set<number>(WINDOW_HEIGHT_STORAGE_KEY, height);
  }

  private applyNotificationTarget(want: Want): void {
    const parameters = want.parameters;
    if (!parameters) {
      return;
    }
    const sessionId = String(parameters['codexRemoteNotificationSessionId'] ?? '').trim();
    const eventType = String(parameters['codexRemoteNotificationEventType'] ?? '').trim();
    const eventId = String(parameters['codexRemoteNotificationEventId'] ?? '').trim();
    const revision = String(parameters['codexRemoteNotificationRevision'] ?? Date.now());
    if (sessionId.length === 0 && eventType.length === 0) {
      return;
    }
    AppStorage.set<string>(NOTIFICATION_SESSION_STORAGE_KEY, sessionId);
    AppStorage.set<string>(NOTIFICATION_EVENT_TYPE_STORAGE_KEY, eventType);
    AppStorage.set<string>(NOTIFICATION_EVENT_ID_STORAGE_KEY, eventId);
    AppStorage.set<string>(NOTIFICATION_REVISION_STORAGE_KEY, revision);
  }
}
