import { http } from '@kit.NetworkKit';
import { CredentialRuntime } from '../config/CredentialRuntime';
import { TotpGenerator } from '../utils/TotpGenerator';
import { CompanionMessagesResponse, CompanionProfile, CompanionProfileResponse } from '../model/CompanionModels';
import { BridgeOutboxItem, BridgeProject, BridgeRuntimeStatus, BridgeTask, BridgeTaskSummary, BridgeUserInput, CodexAccountUsage, CodexRuntimeSnapshot, CodexSessionDetail, CodexSessionFingerprint, CodexSessionSummary, DesktopLiveStatus, DesktopScreenshotImage, MobileFileUpload, MobileImageUpload, RemoteSessionFile, SessionSettings, SlashIndexItem, SystemLinkStatus, SystemRepairStatus, VoiceTranscriptEntry } from '../model/BridgeModels';

interface ProjectsResponse {
  projects?: BridgeProject[];
}

interface TaskResponse {
  task?: BridgeTask;
}

interface RunResponse {
  run?: BridgeTask;
}

interface StartThreadResponse {
  thread?: CodexSessionDetail;
  run?: BridgeTask | null;
}

interface TasksResponse {
  tasks?: BridgeTaskSummary[];
}

interface ApprovalResponse {
  approval?: Object;
}

interface UserInputResponse {
  userInput?: BridgeUserInput;
}

interface OutboxItemsResponse {
  items?: BridgeOutboxItem[];
}

interface OutboxItemResponse {
  item?: BridgeOutboxItem;
}

class OutboxUpdatePayload {
  text: string;

  constructor(text: string) {
    this.text = text;
  }
}

class OutboxMovePayload {
  direction: string;

  constructor(direction: string) {
    this.direction = direction;
  }
}

interface SessionsResponse {
  sessions?: CodexSessionSummary[];
}

interface ThreadsResponse {
  threads?: CodexSessionSummary[];
}

interface SessionResponse {
  session?: CodexSessionDetail;
}

interface SessionSettingsResponse {
  settings?: SessionSettings;
}

interface DeleteThreadResponse {
  deleted?: Object;
}

interface DesktopLiveStatusResponse {
  desktop?: DesktopLiveStatus;
}

interface SystemRepairStatusResponse {
  system?: SystemRepairStatus;
}

interface SystemLinkStatusResponse {
  link?: SystemLinkStatus;
}

interface CodexAccountUsageResponse {
  usage?: CodexAccountUsage;
}

interface DesktopScreenshotResponse {
  image?: DesktopScreenshotImage;
}

interface MobileImageUploadResponse {
  image?: MobileImageUpload;
}

interface MobileFileUploadResponse {
  file?: MobileFileUpload;
}

interface RemoteSessionFileResponse {
  file?: RemoteSessionFile;
}

interface SlashIndexResponse {
  items?: SlashIndexItem[];
}

interface ErrorResponse {
  error?: string;
  desktop?: DesktopLiveStatus;
}

interface HealthResponse {
  runtime?: BridgeRuntimeStatus;
}

export class AppLogPayload {
  source: string = 'harmony-app';
  level: string = 'info';
  event: string = 'app.event';
  data: string = '';
}

interface BridgeRequestOptions {
  connectTimeout?: number;
  readTimeout?: number;
  retries?: number;
  retryDelayMs?: number;
}

const BRIDGE_CLIENT_PROTOCOL: number = 1;
const BRIDGE_CLIENT_VERSION: string = '1.0.13';

export class BridgeClient {
  private static async request(method: http.RequestMethod, url: string, payload: string = '', token: string = '', options: BridgeRequestOptions = {}): Promise<string> {
    const retries = Math.max(0, options.retries ?? 0);
    const retryDelayMs = Math.max(200, options.retryDelayMs ?? 700);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await BridgeClient.requestOnce(method, url, payload, token, options);
      } catch (error) {
        const err = error as Error;
        lastError = err;
        if (attempt >= retries || !BridgeClient.isTransientBridgeError(err.message)) {
          throw err;
        }
        await BridgeClient.delay(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError ?? new Error('桥接请求失败：未知错误');
  }

  private static async requestOnce(method: http.RequestMethod, url: string, payload: string = '', token: string = '', options: BridgeRequestOptions = {}): Promise<string> {
    const client = http.createHttp();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8'
    };
    if (token.trim().length > 0) {
      headers['X-Codex-Bridge-Token'] = token.trim();
    }
    const bridgeOtp = await TotpGenerator.currentCode(CredentialRuntime.getRuntimeTotpSecret());
    if (bridgeOtp.length > 0) {
      headers['X-Codex-Bridge-OTP'] = bridgeOtp;
    }
    try {
      const response = await client.request(url, {
          method,
          header: headers,
          extraData: payload,
          connectTimeout: options.connectTimeout ?? 5000,
          readTimeout: options.readTimeout ?? 15000
        })
        .catch((err: Error) => {
          throw new Error(`桥接请求失败：${err.message}`);
        });
      const raw = typeof response.result === 'string' ? response.result : String(response.result ?? '');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        if (response.responseCode === 401 && BridgeClient.is2faRequired(response.header)) {
          throw new Error('桥接返回异常 HTTP 401：动态验证码缺失或不正确，请核对手机端与电脑端的 TOTP 密钥配置');
        }
        throw new Error(`桥接返回异常 HTTP ${response.responseCode}：${BridgeClient.formatErrorBody(raw)}`);
      }
      return raw;
    } finally {
      try {
        client.destroy();
      } catch (_) {
      }
    }
  }

  private static is2faRequired(header: Object | undefined): boolean {
    if (!header) {
      return false;
    }
    try {
      const headers = header as Record<string, string>;
      const keys = Object.keys(headers);
      for (const key of keys) {
        if (key.toLowerCase() === 'x-codex-bridge-2fa') {
          return String(headers[key] ?? '').trim().toLowerCase() === 'required';
        }
      }
    } catch (_) {
    }
    return false;
  }

  private static formatErrorBody(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as ErrorResponse;
      const parts: string[] = [];
      if (parsed.error && parsed.error.length > 0) {
        parts.push(parsed.error);
      }
      if (parsed.desktop?.status && parsed.desktop.status.length > 0) {
        parts.push(`桌面状态=${parsed.desktop.status}`);
      }
      if (parsed.desktop?.currentSessionId && parsed.desktop.currentSessionId.length > 0) {
        parts.push(`桌面会话=${parsed.desktop.currentSessionId}`);
      }
      if (parsed.desktop?.targetSessionId && parsed.desktop.targetSessionId.length > 0) {
        parts.push(`目标会话=${parsed.desktop.targetSessionId}`);
      }
      if (parsed.desktop?.reason && parsed.desktop.reason.length > 0) {
        parts.push(`原因=${parsed.desktop.reason}`);
      }
      return parts.length > 0 ? parts.join('；') : raw;
    } catch (_) {
      return raw;
    }
  }

  private static isTransientBridgeError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.indexOf('operation timeout') >= 0
      || normalized.indexOf('timed out') >= 0
      || normalized.indexOf('timeout') >= 0
      || normalized.indexOf('server returned nothing') >= 0
      || normalized.indexOf('no header or data') >= 0
      || normalized.indexOf('desktop bridge tunnel is offline') >= 0;
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  static async listProjects(baseUrl: string, token: string = ''): Promise<BridgeProject[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/projects`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as ProjectsResponse;
    return parsed.projects ?? [];
  }

  static async getRuntimeStatus(baseUrl: string, token: string = '', threadId: string = ''): Promise<BridgeRuntimeStatus> {
    const params: string[] = [
      `clientProtocol=${BRIDGE_CLIENT_PROTOCOL}`,
      `clientVersion=${encodeURIComponent(BRIDGE_CLIENT_VERSION)}`
    ];
    if (threadId.trim().length > 0) {
      params.push(`threadId=${encodeURIComponent(threadId.trim())}`);
    }
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/health?${params.join('&')}`, '', token, { connectTimeout: 8000, readTimeout: 20000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as HealthResponse;
    if (!parsed.runtime) {
      throw new Error('桥接服务没有返回运行时能力');
    }
    if (!parsed.runtime.protocol) {
      throw new Error('Bridge 协议不兼容：桥接服务版本过旧，请先更新电脑端 Bridge');
    }
    if (parsed.runtime.protocol.compatible !== true) {
      throw new Error(`Bridge 协议不兼容：${parsed.runtime.protocol.reason}，手机协议=${BRIDGE_CLIENT_PROTOCOL}，Bridge 协议=${parsed.runtime.protocol.protocolVersion}`);
    }
    return parsed.runtime;
  }

  static async listTasks(baseUrl: string, token: string = ''): Promise<BridgeTaskSummary[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/tasks`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as TasksResponse;
    return parsed.tasks ?? [];
  }

  static async getSlashIndex(baseUrl: string, token: string = ''): Promise<SlashIndexItem[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/slash/index`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SlashIndexResponse;
    return parsed.items ?? [];
  }

  static async listSessions(baseUrl: string, token: string = ''): Promise<CodexSessionSummary[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads?limit=50`, '', token, { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 });
    const parsed = JSON.parse(raw) as ThreadsResponse;
    return parsed.threads ?? [];
  }

  static async getRuntimeSnapshot(baseUrl: string, token: string = ''): Promise<CodexRuntimeSnapshot> {
    const raw = await BridgeClient.request(
      http.RequestMethod.GET,
      `${baseUrl}/api/codex/runtime-snapshot`,
      '',
      token,
      { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 }
    );
    return JSON.parse(raw) as CodexRuntimeSnapshot;
  }

  static async getSession(baseUrl: string, sessionId: string, token: string = ''): Promise<CodexSessionDetail> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads/${sessionId}?tail=160`, '', token, { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 });
    const parsed = JSON.parse(raw) as SessionResponse;
    if (!parsed.session) {
      throw new Error('桥接服务没有返回会话详情');
    }
    return parsed.session;
  }

  static async getSessionHistoryPage(
    baseUrl: string,
    sessionId: string,
    token: string = '',
    limit: number = 160,
    beforeCursor: string = '',
    afterCursor: string = ''
  ): Promise<CodexSessionDetail> {
    const params: string[] = [`limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`];
    if (beforeCursor.trim().length > 0) {
      params.push(`before=${encodeURIComponent(beforeCursor.trim())}`);
    }
    if (afterCursor.trim().length > 0) {
      params.push(`after=${encodeURIComponent(afterCursor.trim())}`);
    }
    const raw = await BridgeClient.request(
      http.RequestMethod.GET,
      `${baseUrl}/api/codex/threads/${sessionId}/sync?${params.join('&')}`,
      '',
      token,
      { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 }
    );
    const parsed = JSON.parse(raw) as SessionResponse;
    if (!parsed.session) {
      throw new Error('桥接服务没有返回会话历史');
    }
    return parsed.session;
  }

  static async getCompanionComputerStatus(baseUrl: string, assistantId: string, roomId: string, token: string): Promise<string> {
    return BridgeClient.request(http.RequestMethod.GET,
      `${baseUrl}/companion/computer/status?assistantId=${encodeURIComponent(assistantId)}&roomId=${encodeURIComponent(roomId)}`,
      '', token, { connectTimeout: 10000, readTimeout: 35000, retries: 0 });
  }

  static async startCompanionComputerSession(baseUrl: string, assistantId: string, roomId: string,
    threadId: string, environmentId: string, sdp: string, token: string): Promise<string> {
    return BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/companion/computer/sessions`,
      JSON.stringify({ assistantId, roomId, threadId, environmentId, sdp }), token,
      { connectTimeout: 10000, readTimeout: 45000, retries: 0 });
  }

  static async getCompanionProfile(baseUrl: string, token: string = ''): Promise<CompanionProfile> {
    const raw = await BridgeClient.request(
      http.RequestMethod.GET,
      `${baseUrl}/companion/profile`,
      '',
      token,
      { connectTimeout: 10000, readTimeout: 30000, retries: 1, retryDelayMs: 800 }
    );
    const parsed = JSON.parse(raw) as CompanionProfileResponse;
    const profile = parsed.profile;
    if (!profile || typeof profile.id !== 'string' || profile.id.trim().length === 0
      || typeof profile.name !== 'string' || profile.name.trim().length === 0
      || typeof profile.roomId !== 'string' || profile.roomId.trim().length === 0) {
      throw new Error('桥接服务没有返回熊大个人助手资料');
    }
    return {
      id: profile.id.trim(),
      name: profile.name.trim(),
      roomId: profile.roomId.trim(),
      avatarUrl: typeof profile.avatarUrl === 'string' && profile.avatarUrl.trim().length > 0
        ? profile.avatarUrl.trim() : null
    };
  }

  static async getCompanionMessages(
    baseUrl: string,
    profileId: string,
    roomId: string,
    token: string = '',
    beforeCursor: string = ''
  ): Promise<CompanionMessagesResponse> {
    const params = [
      `profileId=${encodeURIComponent(profileId.trim())}`,
      `roomId=${encodeURIComponent(roomId.trim())}`
    ];
    if (beforeCursor.trim().length > 0) {
      params.push(`before=${encodeURIComponent(beforeCursor.trim())}`);
    }
    const raw = await BridgeClient.request(
      http.RequestMethod.GET,
      `${baseUrl}/companion/messages?${params.join('&')}`,
      '',
      token,
      { connectTimeout: 10000, readTimeout: 30000, retries: 1, retryDelayMs: 800 }
    );
    const parsed = JSON.parse(raw) as CompanionMessagesResponse;
    const entries: VoiceTranscriptEntry[] = (parsed.entries ?? [])
      .filter((entry: VoiceTranscriptEntry) => typeof entry.itemId === 'string'
        && entry.itemId.trim().length > 0 && typeof entry.text === 'string')
      .map((entry: VoiceTranscriptEntry): VoiceTranscriptEntry => ({
        itemId: entry.itemId,
        role: entry.role === 'user' ? 'user' : 'assistant',
        text: entry.text,
        final: entry.final === true
      }));
    return {
      entries,
      nextCursor: typeof parsed.nextCursor === 'string' && parsed.nextCursor.trim().length > 0
        ? parsed.nextCursor : null
    };
  }

  static async deleteSession(baseUrl: string, sessionId: string, token: string = ''): Promise<void> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${sessionId}/delete`, '{}', token);
    const parsed = JSON.parse(raw) as DeleteThreadResponse;
    if (!parsed.deleted) {
      throw new Error('桥接服务没有返回删除结果');
    }
  }

  static async getDesktopLiveStatus(baseUrl: string, token: string = '', sessionId: string = '', recover: boolean = false): Promise<DesktopLiveStatus> {
    const params: string[] = [];
    if (sessionId.trim().length > 0) {
      params.push(`sessionId=${encodeURIComponent(sessionId.trim())}`);
    }
    if (recover) {
      params.push('recover=1');
    }
    const suffix = params.length > 0 ? `?${params.join('&')}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/desktop/live/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as DesktopLiveStatusResponse;
    if (!parsed.desktop) {
      throw new Error('桥接服务没有返回桌面实时连接状态');
    }
    return parsed.desktop;
  }

  static async repairDesktopLive(baseUrl: string, token: string = '', sessionId: string = '', hard: boolean = false): Promise<DesktopLiveStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_repair_button', mode: hard ? 'hard' : 'soft' });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/desktop/live/recover`, body, token, { connectTimeout: 10000, readTimeout: hard ? 150000 : 90000 });
    const parsed = JSON.parse(raw) as DesktopLiveStatusResponse;
    if (!parsed.desktop) {
      throw new Error('桥接服务没有返回桌面链路恢复状态');
    }
    return parsed.desktop;
  }

  static async getSystemRepairStatus(baseUrl: string, token: string = '', sessionId: string = ''): Promise<SystemRepairStatus> {
    const suffix = sessionId.trim().length > 0 ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/system/repair/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SystemRepairStatusResponse;
    if (!parsed.system) {
      throw new Error('桥接服务没有返回系统链路状态');
    }
    return parsed.system;
  }

  static async repairSystemLink(baseUrl: string, token: string = '', sessionId: string = '', mode: string = 'auto', confirmHardRestart: boolean = false): Promise<SystemRepairStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_system_repair_button', mode, confirmHardRestart });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/system/repair/run`, body, token, { connectTimeout: 10000, readTimeout: mode === 'hard' ? 150000 : 120000 });
    const parsed = JSON.parse(raw) as SystemRepairStatusResponse;
    if (!parsed.system) {
      throw new Error('桥接服务没有返回系统链路恢复状态');
    }
    return parsed.system;
  }

  static async getSystemLinkStatus(baseUrl: string, token: string = '', sessionId: string = ''): Promise<SystemLinkStatus> {
    const suffix = sessionId.trim().length > 0 ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/system/link/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SystemLinkStatusResponse;
    if (!parsed.link) {
      throw new Error('桥接服务没有返回统一链路状态');
    }
    return parsed.link;
  }

  static async recoverSystemLink(baseUrl: string, token: string = '', sessionId: string = '', mode: string = 'auto'): Promise<SystemLinkStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_link_recover_button', mode });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/system/link/recover`, body, token, { connectTimeout: 10000, readTimeout: 120000 });
    const parsed = JSON.parse(raw) as SystemLinkStatusResponse;
    if (!parsed.link) {
      throw new Error('桥接服务没有返回统一链路恢复状态');
    }
    return parsed.link;
  }

  static async getCodexAccountUsage(baseUrl: string, token: string = ''): Promise<CodexAccountUsage> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/account/usage`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as CodexAccountUsageResponse;
    if (!parsed.usage) {
      throw new Error('桥接服务没有返回 Codex 账号用量');
    }
    return parsed.usage;
  }

  static async openDesktopSession(baseUrl: string, sessionId: string, token: string = ''): Promise<void> {
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/codex/sessions/${sessionId}/open`, '{}', token);
  }

  static async captureDesktopScreenshot(baseUrl: string, token: string = ''): Promise<DesktopScreenshotImage> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/desktop/screenshot/primary`, '{}', token);
    const parsed = JSON.parse(raw) as DesktopScreenshotResponse;
    if (!parsed.image) {
      throw new Error('桥接服务没有返回桌面截图');
    }
    return parsed.image;
  }

  static async createTask(baseUrl: string, projectId: string, prompt: string, token: string = '', codexSessionId: string = '', sessionFingerprint: CodexSessionFingerprint | null = null, reasoningEffort: string = '', model: string = ''): Promise<BridgeTask> {
    const body = codexSessionId.trim().length > 0
      ? JSON.stringify({ projectId, prompt, codexSessionId: codexSessionId.trim(), sessionFingerprint, reasoningEffort, model })
      : JSON.stringify({ projectId, prompt, reasoningEffort, model });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/tasks`, body, token);
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回任务');
    }
    return parsed.task;
  }

  static async startCodexThread(baseUrl: string, projectId: string, text: string, token: string = '', reasoningEffort: string = '', model: string = '', submissionId: string = ''): Promise<BridgeTask> {
    const body = JSON.stringify({ projectId, text, reasoningEffort, model, submissionId });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads?afterSeq=0&eventLimit=100`, body, token, { readTimeout: 45000 });
    const parsed = JSON.parse(raw) as StartThreadResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回新会话运行状态');
    }
    return parsed.run;
  }

  static async sendCodexThreadMessage(baseUrl: string, threadId: string, text: string, projectId: string, token: string = '', sessionFingerprint: CodexSessionFingerprint | null = null, reasoningEffort: string = '', model: string = '', submissionId: string = ''): Promise<BridgeTask> {
    const body = JSON.stringify({ projectId, text, sessionFingerprint, reasoningEffort, model, submissionId });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/messages?afterSeq=0&eventLimit=100`, body, token, { connectTimeout: 10000, readTimeout: 90000, retries: 2, retryDelayMs: 900 });
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回会话运行状态');
    }
    return parsed.run;
  }

  static async getSessionSettings(baseUrl: string, threadId: string, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads/${threadId}/settings`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? { reasoningEffort: '' };
  }

  static async getCodexSettings(baseUrl: string, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/settings`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? { reasoningEffort: '' };
  }

  static async updateSessionSettings(baseUrl: string, threadId: string, settings: SessionSettings, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/settings`, JSON.stringify(settings), token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? settings;
  }

  static async getCodexRun(baseUrl: string, runId: string, token: string = '', afterSeq: number = 0): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/runs/${runId}?afterSeq=${afterSeq}&eventLimit=100`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回运行详情');
    }
    return parsed.run;
  }

  static async interruptCodexRun(baseUrl: string, runId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/runs/${runId}/interrupt`, '{}', token);
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回中断后的运行状态');
    }
    return parsed.run;
  }

  static async interruptCodexThread(baseUrl: string, threadId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/interrupt`, '{}', token);
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回会话中断状态');
    }
    return parsed.run;
  }

  static async getTask(baseUrl: string, taskId: string, token: string = '', afterSeq: number = 0): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/tasks/${taskId}?afterSeq=${afterSeq}&eventLimit=100`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回任务');
    }
    return parsed.task;
  }

  static async interruptTask(baseUrl: string, taskId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/tasks/${taskId}/interrupt`, '{}', token);
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回中断后的任务状态');
    }
    return parsed.task;
  }

  static async decideApproval(baseUrl: string, approvalId: string, decision: string, token: string = ''): Promise<void> {
    const body = JSON.stringify({ decision });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/approvals/${approvalId}`, body, token);
    const parsed = JSON.parse(raw) as ApprovalResponse;
    if (!parsed.approval) {
      throw new Error('桥接服务没有返回确认结果');
    }
  }

  static async answerUserInput(baseUrl: string, requestId: string, answers: Record<string, string[]>, token: string = ''): Promise<BridgeUserInput> {
    const body = JSON.stringify({ answers });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/user-inputs/${requestId}`, body, token);
    const parsed = JSON.parse(raw) as UserInputResponse;
    if (!parsed.userInput) {
      throw new Error('桥接服务没有返回问题表单处理结果');
    }
    return parsed.userInput;
  }

  static async listOutbox(baseUrl: string, threadId: string = '', token: string = ''): Promise<BridgeOutboxItem[]> {
    const params: string[] = ['active=1'];
    if (threadId.trim().length > 0) {
      params.push(`threadId=${encodeURIComponent(threadId.trim())}`);
    }
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/outbox?${params.join('&')}`, '', token);
    return (JSON.parse(raw) as OutboxItemsResponse).items ?? [];
  }

  static async updateOutboxItem(baseUrl: string, itemId: string, text: string, token: string = ''): Promise<BridgeOutboxItem> {
    const raw = await BridgeClient.request(http.RequestMethod.PUT, `${baseUrl}/api/outbox/${itemId}`, JSON.stringify(new OutboxUpdatePayload(text)), token);
    const item = (JSON.parse(raw) as OutboxItemResponse).item;
    if (!item) {
      throw new Error('桥接服务没有返回队列项');
    }
    return item;
  }

  static async moveOutboxItem(baseUrl: string, itemId: string, direction: string, token: string = ''): Promise<BridgeOutboxItem> {
    return await BridgeClient.outboxAction(baseUrl, itemId, 'move', JSON.stringify(new OutboxMovePayload(direction)), token);
  }

  static async cancelOutboxItem(baseUrl: string, itemId: string, token: string = ''): Promise<BridgeOutboxItem> {
    return await BridgeClient.outboxAction(baseUrl, itemId, 'cancel', '{}', token);
  }

  static async retryOutboxItem(baseUrl: string, itemId: string, token: string = ''): Promise<BridgeOutboxItem> {
    return await BridgeClient.outboxAction(baseUrl, itemId, 'retry', '{}', token);
  }

  private static async outboxAction(baseUrl: string, itemId: string, action: string, payload: string, token: string): Promise<BridgeOutboxItem> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/outbox/${itemId}/${action}`, payload, token);
    const item = (JSON.parse(raw) as OutboxItemResponse).item;
    if (!item) {
      throw new Error('桥接服务没有返回队列操作结果');
    }
    return item;
  }

  static async uploadLog(baseUrl: string, payload: AppLogPayload, token: string = ''): Promise<void> {
    const body = JSON.stringify(payload);
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs`, body, token);
  }

  static async uploadLogs(baseUrl: string, payloads: AppLogPayload[], token: string = ''): Promise<void> {
    const body = JSON.stringify({ logs: payloads });
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs/batch`, body, token);
  }

  static async uploadMobileImage(baseUrl: string, fileName: string, mimeType: string, base64: string, token: string = ''): Promise<MobileImageUpload> {
    const body = JSON.stringify({ fileName, mimeType, base64 });
    const raw = await BridgeClient.request(
      http.RequestMethod.POST,
      `${baseUrl}/mobile/images`,
      body,
      token,
      { connectTimeout: 15000, readTimeout: 120000, retries: 2, retryDelayMs: 1200 }
    );
    const parsed = JSON.parse(raw) as MobileImageUploadResponse;
    if (!parsed.image) {
      throw new Error('桥接服务没有返回图片上传结果');
    }
    return parsed.image;
  }

  static async uploadMobileFile(baseUrl: string, fileName: string, mimeType: string, base64: string, token: string = ''): Promise<MobileFileUpload> {
    const body = JSON.stringify({ fileName, mimeType, base64 });
    const raw = await BridgeClient.request(
      http.RequestMethod.POST,
      `${baseUrl}/mobile/files`,
      body,
      token,
      { connectTimeout: 15000, readTimeout: 120000, retries: 2, retryDelayMs: 1200 }
    );
    const parsed = JSON.parse(raw) as MobileFileUploadResponse;
    if (!parsed.file) {
      throw new Error('桥接服务没有返回文件上传结果');
    }
    return parsed.file;
  }

  static async getRemoteSessionFileMetadata(
    baseUrl: string,
    threadId: string,
    remotePath: string,
    token: string = ''
  ): Promise<RemoteSessionFile> {
    const url = `${baseUrl}/api/codex/threads/${encodeURIComponent(threadId)}/files/metadata?path=${encodeURIComponent(remotePath)}`;
    const raw = await BridgeClient.request(
      http.RequestMethod.GET,
      url,
      '',
      token,
      { connectTimeout: 10000, readTimeout: 30000, retries: 1, retryDelayMs: 600 }
    );
    const parsed = JSON.parse(raw) as RemoteSessionFileResponse;
    if (!parsed.file) {
      throw new Error('桥接服务没有返回电脑端文件信息');
    }
    return parsed.file;
  }

  static remoteSessionFileDownloadUrl(baseUrl: string, threadId: string, remotePath: string): string {
    return `${baseUrl}/api/codex/threads/${encodeURIComponent(threadId)}/files/download?path=${encodeURIComponent(remotePath)}`;
  }

  static async startLogRun(baseUrl: string, label: string, token: string = ''): Promise<void> {
    const body = JSON.stringify({ label });
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs/run`, body, token);
  }
}
