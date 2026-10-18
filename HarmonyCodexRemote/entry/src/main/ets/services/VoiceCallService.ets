import { webSocket } from '@kit.NetworkKit';
import { audio } from '@kit.AudioKit';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import url from '@ohos.url';
import { CredentialRuntime } from '../config/CredentialRuntime';
import { VoiceRouteConfig } from '../config/VoiceRouteConfig';
import { TotpGenerator } from '../utils/TotpGenerator';
import { VoiceTranscriptReducer } from './VoiceTranscriptReducer';
import { VoiceBackgroundTaskService } from './VoiceBackgroundTaskService';
import { VoiceCallStatus, VoiceCallStage, VoiceCallFailure, VoiceTranscriptEntry } from '../model/BridgeModels';
import { CompanionVoiceIdentity } from '../model/CompanionModels';

/**
 * 语音通话链路：手机端 WebSocket ↔ 电脑端 Bridge `/voice`。
 * 上行：麦克风 PCM16LE 16kHz 单声道（约 100ms 一批二进制帧）。
 * 下行：服务端二进制帧 = PCM16LE 24kHz 单声道，送 AudioRenderer 播放。
 * 红线：任何日志与错误信息不得输出 token/OTP/secret 明文。
 */

export interface VoiceCallCallbacks {
  onProgress?: (stage: VoiceCallStage, startedAt: number, failure: VoiceCallFailure) => void;
  onMutedChanged?: (muted: boolean) => void;
  onStatus: (status: VoiceCallStatus, detail: string) => void;
  onTranscript: (entry: VoiceTranscriptEntry, identity: CompanionVoiceIdentity | null) => void;
  onHistory: (entries: VoiceTranscriptEntry[]) => void;
  onAssistantName: (name: string) => void;
  onSpeaking: (speaking: boolean) => void;
  onClosed: (reason: string) => void;
}

interface VoiceServerEvent {
  type?: string;
  itemId?: string;
  sessionId?: string;
  profileName?: string;
  profileId?: string;
  roomId?: string;
  callId?: string;
  role?: string;
  text?: string;
  final?: boolean;
  entries?: VoiceTranscriptEntry[];
  state?: string;
  revision?: number;
  source?: string;
  playbackControlVersion?: number;
  bargeInAvailable?: boolean;
  message?: string;
  reason?: string;
  stage?: string;
  failureStage?: string;
  httpStatus?: number;
}

interface VoiceAudioHealthReport {
  readCallbacks: number;
  inputBytes: number;
  maxPcmRms: number;
  bufferMutations: number;
  sendFalse: number;
  sendRejected: number;
  sendMaxMs: number;
  sendInFlight: number;
  sendMaxInFlight: number;
  downlinkReceivedBytes: number;
  downlinkDroppedBytes: number;
  // PCM bytes pulled from the queue into AudioRenderer writeData buffers.
  downlinkWriteConsumeBytes: number;
  // Bytes zero-filled because the renderer requested more PCM than the queue held.
  downlinkSilenceBytes: number;
  downlinkQueueHighWaterMs: number;
  downlinkQueueCurrentMs: number;
  // Maximum interval between received binary PCM WebSocket callbacks.
  wsCallbackGapMaxMs: number;
  rendererCallbackGapMaxMs: number;
  // Zero means the event has not yet been observed; silence is not a fault by itself.
  firstBinaryEpochMs: number;
  firstNonzeroPlayEpochMs: number;
}

class VoiceStartFrame {
  type: string = 'start';
  playbackControlVersion: number = 1;
  voice: string | null = null;
  prompt: string | null = null;
}

class VoiceInterruptFrame {
  type: string = 'interrupt';
}

class VoiceStopFrame {
  type: string = 'stop';
}

const VOICE_CONNECT_TIMEOUT_MS: number = 8000;
const VOICE_CONNECT_RETRY_LIMIT: number = 3;
const VOICE_CONNECT_RETRY_DELAY_MS: number = 1500;
// 16kHz * 16bit * 1ch = 3200 字节 ≈ 100ms 的 PCM 数据。
const VOICE_MIC_BATCH_BYTES: number = 3200;
// Cap queued PCM duration independently of the upstream frame size.
const VOICE_PLAY_QUEUE_LIMIT_MS: number = 1000;
// 下行 PCM16LE 24kHz 单声道：48,000 字节/秒。
const VOICE_PLAYBACK_BYTES_PER_SECOND: number = 48000;
const VOICE_PLAY_SAMPLE_BYTES: number = 2;
const VOICE_PLAY_QUEUE_LIMIT_BYTES: number = VOICE_PLAYBACK_BYTES_PER_SECOND * VOICE_PLAY_QUEUE_LIMIT_MS / 1000;

const NOOP_VOICE_STATUS: (status: VoiceCallStatus, detail: string) => void = () => {};
const NOOP_VOICE_TRANSCRIPT: (entry: VoiceTranscriptEntry, identity: CompanionVoiceIdentity | null) => void = () => {};
const NOOP_VOICE_HISTORY: (entries: VoiceTranscriptEntry[]) => void = () => {};
const NOOP_VOICE_ASSISTANT_NAME: (name: string) => void = () => {};
const NOOP_VOICE_SPEAKING: (speaking: boolean) => void = () => {};
const NOOP_VOICE_CLOSED: (reason: string) => void = () => {};

export class VoiceCallService {
  private static generation: number = 0;
  private static ws: webSocket.WebSocket | null = null;
  private static capturer: audio.AudioCapturer | null = null;
  private static renderer: audio.AudioRenderer | null = null;
  private static micQueue: ArrayBuffer[] = [];
  private static playQueue: ArrayBuffer[] = [];
  private static playCursorBuffer: ArrayBuffer | null = null;
  private static playCursorView: Uint8Array | null = null;
  private static playCursorOffset: number = 0;
  private static rendererActive: boolean = false;
  private static rendererStartingGeneration: number = -1;
  private static rendererFailedGeneration: number = -1;
  private static rendererStartupPromise: Promise<void> | null = null;
  // Output ownership differs from the WebSocket/capture call generation.
  private static rendererRevision: number = 0;
  private static playbackEpoch: number = 0;
  private static playbackFlushing: boolean = false;
  private static playbackFlushOwner: number = 0;
  private static playbackSuppressionSequence: number = 0;
  private static playbackSuppressionTokens: number[] = [];
  private static serverPlaybackRevision: number = -1;
  private static serverPlaybackSuppressionToken: number = 0;
  private static voiceAudioHealthTimer: number = 0;
  private static voiceAudioReadCallbacks: number = 0;
  private static voiceAudioInputBytes: number = 0;
  private static voiceAudioMaxRms: number = 0;
  private static voiceAudioBufferMutations: number = 0;
  private static voiceAudioSendFalse: number = 0;
  private static voiceAudioSendRejected: number = 0;
  private static voiceAudioSendMaxMs: number = 0;
  private static voiceAudioSendInFlight: number = 0;
  private static voiceAudioSendMaxInFlight: number = 0;
  private static voiceAudioDownlinkReceivedBytes: number = 0;
  private static voiceAudioDownlinkDroppedBytes: number = 0;
  private static voiceAudioDownlinkWriteConsumeBytes: number = 0;
  private static voiceAudioDownlinkSilenceBytes: number = 0;
  private static voiceAudioDownlinkQueuedBytes: number = 0;
  private static voiceAudioDownlinkQueueHighWaterMs: number = 0;
  private static voiceAudioWsCallbackGapMaxMs: number = 0;
  private static voiceAudioLastWsCallbackEpochMs: number = 0;
  private static voiceAudioRendererCallbackGapMaxMs: number = 0;
  private static voiceAudioLastRendererCallbackEpochMs: number = 0;
  private static voiceAudioFirstBinaryEpochMs: number = 0;
  private static voiceAudioFirstNonzeroPlayEpochMs: number = 0;
  private static voiceAudioPreviousBuffer: ArrayBuffer | null = null;
  private static voiceAudioPreviousSnapshot: ArrayBuffer | null = null;
  private static muted: boolean = false;
  private static phase: VoiceCallStatus = 'idle';
  private static stage: VoiceCallStage = 'channel';
  private static stageStartedAt: number = 0;
  private static capturerStartingGeneration: number = -1;
  private static ready: boolean = false;
  private static expectedProfileId: string = '';
  private static expectedRoomId: string = '';
  private static transcriptIdentityCandidate: CompanionVoiceIdentity | null = null;
  private static boundTranscriptIdentity: CompanionVoiceIdentity | null = null;
  private static pendingIdentityTranscripts: VoiceTranscriptEntry[] = [];
  private static stopping: boolean = false;
  private static abilityContext: common.UIAbilityContext | null = null;
  private static callbacks: VoiceCallCallbacks = {
    onStatus: NOOP_VOICE_STATUS,
    onTranscript: NOOP_VOICE_TRANSCRIPT,
    onHistory: NOOP_VOICE_HISTORY,
    onAssistantName: NOOP_VOICE_ASSISTANT_NAME,
    onSpeaking: NOOP_VOICE_SPEAKING,
    onClosed: NOOP_VOICE_CLOSED
  };

  static setCallbacks(callbacks: VoiceCallCallbacks): void {
    VoiceCallService.callbacks = callbacks;
    callbacks.onMutedChanged?.(VoiceCallService.muted);
  }

  static phaseValue(): VoiceCallStatus {
    return VoiceCallService.phase;
  }

  static mutedValue(): boolean {
    return VoiceCallService.muted;
  }

  static async requestMicPermission(context: common.UIAbilityContext, fromSettings: boolean = false): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const permissions: Array<Permissions> = ['ohos.permission.MICROPHONE'];
      const authResults = fromSettings
        ? await atManager.requestPermissionOnSetting(context, permissions)
        : (await atManager.requestPermissionsFromUser(context, permissions)).authResults;
      for (let index = 0; index < authResults.length; index += 1) {
        if (authResults[index] === 0) {
          VoiceCallService.abilityContext = context;
          return true;
        }
      }
      VoiceCallService.abilityContext = null;
      return false;
    } catch (_) {
      VoiceCallService.abilityContext = null;
      return false;
    }
  }

  static async connect(bridgeUrl: string, token: string, profileId: string = '', roomId: string = ''): Promise<void> {
    if (VoiceCallService.phase === 'connecting' || VoiceCallService.phase === 'active' || VoiceCallService.phase === 'ready') {
      return;
    }
    VoiceCallService.generation += 1;
    const generation = VoiceCallService.generation;
    VoiceCallService.ready = false;
    VoiceCallService.expectedProfileId = profileId.trim();
    VoiceCallService.expectedRoomId = roomId.trim();
    VoiceCallService.transcriptIdentityCandidate = null;
    VoiceCallService.boundTranscriptIdentity = null;
    VoiceCallService.pendingIdentityTranscripts = [];
    VoiceCallService.stopping = false;
    VoiceCallService.teardownAudio();
    VoiceCallService.stageStartedAt = 0;
    VoiceCallService.setProgress('channel');
    VoiceCallService.setStatus('connecting', '正在连接语音通道');
    const wsUrl = VoiceCallService.resolveVoiceWebSocketUrl(bridgeUrl, VoiceRouteConfig.voiceHttpsBaseUrl);
    if (wsUrl.length === 0) {
      VoiceCallService.abilityContext = null;
      VoiceCallService.failCall('桥接地址无效，无法建立语音通道', 'channel');
      return;
    }
    const context = VoiceCallService.abilityContext;
    if (context === null) {
      VoiceCallService.failCall('请允许麦克风权限后重试', 'mic');
      return;
    }
    try {
      await VoiceBackgroundTaskService.start(context, generation, (owner: number) => {
        if (owner === VoiceCallService.generation && !VoiceCallService.stopping) {
          VoiceCallService.failCall('系统已结束语音后台任务，通话已结束，请重新接通', 'mic');
        }
      });
    } catch (error) {
      await VoiceCallService.stopVoiceBackgroundTask(generation);
      if (VoiceCallService.generation === generation) {
        VoiceCallService.failCall('无法启动语音后台任务，请重试', 'mic');
      }
      return;
    }
    if (VoiceCallService.generation !== generation) {
      await VoiceCallService.stopVoiceBackgroundTask(generation);
      return;
    }
    VoiceCallService.resetVoiceAudioHealth();
    let lastError: string = '';
    for (let attempt = 1; attempt <= VOICE_CONNECT_RETRY_LIMIT; attempt += 1) {
      if (VoiceCallService.generation !== generation) {
        return;
      }
      try {
        await VoiceCallService.connectOnce(wsUrl, token, generation);
        return;
      } catch (error) {
        lastError = VoiceCallService.errorText(error);
      }
      if (attempt < VOICE_CONNECT_RETRY_LIMIT && VoiceCallService.generation === generation) {
        VoiceCallService.setStatus('connecting', `连接失败，正在重试（${attempt}/${VOICE_CONNECT_RETRY_LIMIT}）`);
        await VoiceCallService.sleep(VOICE_CONNECT_RETRY_DELAY_MS);
      }
    }
    if (VoiceCallService.generation === generation) {
      VoiceCallService.teardownAudio();
      await VoiceCallService.stopVoiceBackgroundTask(generation);
      const authFailed = /401|403|unauthorized|forbidden/i.test(lastError);
      VoiceCallService.failCall(authFailed ? '语音认证失败，请检查配对后重试' : '语音通道连接失败，请检查网络后重试', authFailed ? 'auth' : 'channel');
    }
  }

  static interrupt(): void {
    VoiceCallService.playbackEpoch += 1;
    VoiceCallService.clearPlaybackBuffers(true);
    VoiceCallService.callbacks.onSpeaking(false);
    VoiceCallService.requestPlaybackFlush();
    void VoiceCallService.sendText(JSON.stringify(new VoiceInterruptFrame()));
  }

  // Protocol owners may compose an explicit upstream boundary with the local
  // flush barrier. Tokens carry no inference about which answer a PCM frame owns.
  static beginPlaybackSuppression(): number {
    VoiceCallService.playbackSuppressionSequence += 1;
    const token = VoiceCallService.playbackSuppressionSequence;
    VoiceCallService.playbackSuppressionTokens.push(token);
    VoiceCallService.clearPlaybackBuffers(true);
    VoiceCallService.callbacks.onSpeaking(false);
    return token;
  }

  static endPlaybackSuppression(token: number): void {
    const index = VoiceCallService.playbackSuppressionTokens.indexOf(token);
    if (index >= 0) {
      VoiceCallService.playbackSuppressionTokens.splice(index, 1);
    }
  }

  private static playbackSuppressed(): boolean {
    return VoiceCallService.playbackFlushing || VoiceCallService.playbackSuppressionTokens.length > 0;
  }

  static setMuted(muted: boolean): void {
    // Discard partial capture on either transition; never replay pre-mute audio
    // when the user enables the microphone again.
    VoiceCallService.micQueue = [];
    VoiceCallService.muted = muted;
    VoiceCallService.callbacks.onMutedChanged?.(muted);
    if (VoiceCallService.phase === 'active') {
      VoiceCallService.setStatus('active', muted ? '通话中（已静音）' : '通话中 · 正在聆听');
    }
  }

  static async stop(): Promise<void> {
    const ownerGeneration = VoiceCallService.generation;
    if (VoiceCallService.phase === 'idle' && VoiceCallService.ws === null && VoiceCallService.capturer === null) {
      VoiceCallService.teardownAudio();
      VoiceCallService.flushPendingWithoutIdentity();
      VoiceCallService.abilityContext = null;
      await VoiceCallService.stopVoiceBackgroundTask(ownerGeneration);
      return;
    }
    VoiceCallService.stopping = true;
    VoiceCallService.generation += 1;
    const client = VoiceCallService.ws;
    VoiceCallService.ws = null;
    if (client !== null) {
      try {
        await client.send(JSON.stringify(new VoiceStopFrame()));
      } catch (_) {
      }
      try {
        await client.close();
      } catch (_) {
      }
      VoiceCallService.offWebSocketHandlers(client);
    }
    VoiceCallService.teardownAudio();
    VoiceCallService.ready = false;
    VoiceCallService.flushPendingWithoutIdentity();
    VoiceCallService.transcriptIdentityCandidate = null;
    VoiceCallService.boundTranscriptIdentity = null;
    VoiceCallService.pendingIdentityTranscripts = [];
    VoiceCallService.expectedProfileId = '';
    VoiceCallService.expectedRoomId = '';
    VoiceCallService.callbacks.onSpeaking(false);
    VoiceCallService.abilityContext = null;
    await VoiceCallService.stopVoiceBackgroundTask(ownerGeneration);
    VoiceCallService.setStatus('idle', '通话已结束');
  }

  private static connectOnce(wsUrl: string, token: string, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled: boolean = false;
      const client = webSocket.createWebSocket();
      VoiceCallService.ws = client;
      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        VoiceCallService.offWebSocketHandlers(client);
        try {
          void client.close().catch(() => {});
        } catch (_) {
        }
        if (VoiceCallService.ws === client) {
          VoiceCallService.ws = null;
        }
        reject(new Error(message));
      };
      const timeout = setTimeout(() => {
        fail('连接超时');
      }, VOICE_CONNECT_TIMEOUT_MS);

      client.on('open', () => {
        if (VoiceCallService.generation !== generation) {
          return;
        }
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve();
        }
        VoiceCallService.setProgress('assistant');
        VoiceCallService.setStatus('connecting', '正在准备个人助手');
        void VoiceCallService.sendText(JSON.stringify(new VoiceStartFrame()));
      });
      client.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
        if (VoiceCallService.generation !== generation || err) {
          return;
        }
        if (typeof value === 'string') {
          VoiceCallService.handleServerEvent(value);
        } else {
          VoiceCallService.recordVoiceBinaryWebSocketCallback();
          VoiceCallService.queuePlayback(value);
        }
      });
      client.on('close', () => {
        if (VoiceCallService.generation !== generation) {
          return;
        }
        if (!settled) {
          clearTimeout(timeout);
          fail('连接被服务端关闭');
          return;
        }
        VoiceCallService.handleConnectionDropped();
      });
      client.on('error', (err: BusinessError) => {
        if (VoiceCallService.generation !== generation) {
          return;
        }
        const message = VoiceCallService.errorText(err);
        if (!settled) {
          clearTimeout(timeout);
          fail(message.length > 0 ? message : '连接错误');
          return;
        }
        VoiceCallService.handleConnectionDropped();
      });

      const headers: Record<string, string> = {};
      const trimmedToken = token.trim();
      if (trimmedToken.length > 0) {
        headers['X-Codex-Bridge-Token'] = trimmedToken;
      }
      void TotpGenerator.currentCode(CredentialRuntime.getRuntimeTotpSecret())
        .then((otp: string) => {
          if (VoiceCallService.generation !== generation) {
            fail('连接已取消');
            return;
          }
          if (otp.length > 0) {
            headers['X-Codex-Bridge-OTP'] = otp;
          }
          const options: webSocket.WebSocketRequestOptions = { header: headers };
          try {
            client.connect(wsUrl, options, (err: BusinessError) => {
              if (VoiceCallService.generation !== generation) {
                return;
              }
              if (err && !settled) {
                clearTimeout(timeout);
                fail(VoiceCallService.errorText(err));
              }
            });
          } catch (error) {
            clearTimeout(timeout);
            fail(VoiceCallService.errorText(error));
          }
        })
        .catch((error: Error) => {
          clearTimeout(timeout);
          fail(`动态验证码生成失败：${VoiceCallService.errorText(error)}`);
        });
    });
  }

  private static handleServerEvent(raw: string): void {
    let event: VoiceServerEvent;
    try {
      event = JSON.parse(raw) as VoiceServerEvent;
    } catch (_) {
      return;
    }
    const type = event.type ?? '';
    if (type === 'playback') {
      VoiceCallService.handlePlaybackControl(event);
      return;
    }
    if (type === 'progress') {
      // Ignore unknown, regressive and late stages; server readiness still requires ready.
      if (!VoiceCallService.ready && (event.stage === 'assistant' || event.stage === 'media')) {
        if (VoiceCallService.stage !== 'media' || event.stage === 'media') {
          VoiceCallService.setProgress(event.stage);
          VoiceCallService.setStatus('connecting', event.stage === 'media' ? '正在等待媒体连接' : '正在准备个人助手');
        }
      }
      return;
    }
    if (type === 'ready') {
      if (VoiceCallService.ready) {
        return;
      }
      const profileName = event.profileName?.trim() ?? '';
      if (profileName.length > 0) {
        VoiceCallService.callbacks.onAssistantName(profileName);
      }
      const eventIdentity = VoiceCallService.identityFromEvent(event);
      const identityMatchesExpected = eventIdentity !== null
        && eventIdentity.profileId === VoiceCallService.expectedProfileId
        && eventIdentity.roomId === VoiceCallService.expectedRoomId;
      const identityMatchesCandidate = eventIdentity !== null
        && (VoiceCallService.transcriptIdentityCandidate === null
          || VoiceCallService.sameIdentity(eventIdentity, VoiceCallService.transcriptIdentityCandidate));
      let identityWarning: string = '';
      if (identityMatchesExpected && identityMatchesCandidate) {
        VoiceCallService.boundTranscriptIdentity = eventIdentity;
        VoiceCallService.pendingIdentityTranscripts.forEach((entry: VoiceTranscriptEntry) => {
          VoiceCallService.callbacks.onTranscript(entry, eventIdentity);
        });
      } else if (VoiceCallService.pendingIdentityTranscripts.length > 0) {
        VoiceCallService.pendingIdentityTranscripts.forEach((entry: VoiceTranscriptEntry) => {
          VoiceCallService.callbacks.onTranscript(entry, null);
        });
      }
      if (eventIdentity !== null && (!identityMatchesExpected || !identityMatchesCandidate)) {
        identityWarning = '语音会话身份与当前个人助手不一致；转写未加入助手历史';
      } else if (eventIdentity === null) {
        identityWarning = '语音服务未提供可核验的助手会话身份；转写不会写入助手历史';
      }
      VoiceCallService.pendingIdentityTranscripts = [];
      VoiceCallService.ready = true;
      VoiceCallService.setProgress('mic');
      VoiceCallService.setStatus('ready', identityWarning.length > 0
        ? identityWarning : '媒体已就绪，正在开启麦克风');
      void VoiceCallService.startCapturer();
      return;
    }
    if (type === 'history') {
      VoiceCallService.callbacks.onHistory(VoiceTranscriptReducer.normalizeHistory(event.entries ?? []));
      return;
    }
    if (type === 'transcript') {
      const transcriptText = event.text ?? '';
      const transcriptRole = event.role === 'user' || event.role === 'assistant' ? event.role : 'other';
      console.info('[VoiceTranscriptHealth] ' + JSON.stringify({
        role: transcriptRole,
        chars: transcriptText.length,
        final: event.final === true,
        epochMs: Date.now()
      }));
      const transcript: VoiceTranscriptEntry = {
        itemId: event.itemId,
        role: event.role ?? 'assistant',
        text: transcriptText,
        final: event.final === true
      };
      const identity = VoiceCallService.identityFromEvent(event);
      if (identity === null) {
        // Compatibility path: show the event in the call panel, but never
        // attach the missing identity to the configured assistant ourselves.
        VoiceCallService.callbacks.onTranscript(transcript, null);
      } else if (identity.profileId !== VoiceCallService.expectedProfileId
        || identity.roomId !== VoiceCallService.expectedRoomId) {
        VoiceCallService.reportTranscriptIdentityProblem('收到其他助手或房间的语音转写；已丢弃以防串入当前会话');
      } else if (VoiceCallService.boundTranscriptIdentity !== null) {
        if (VoiceCallService.sameIdentity(identity, VoiceCallService.boundTranscriptIdentity)) {
          VoiceCallService.callbacks.onTranscript(transcript, VoiceCallService.boundTranscriptIdentity);
        } else {
          VoiceCallService.reportTranscriptIdentityProblem('语音通话标识发生变化；该转写未加入当前助手历史');
        }
      } else if (!VoiceCallService.ready) {
        if (VoiceCallService.transcriptIdentityCandidate === null) {
          VoiceCallService.transcriptIdentityCandidate = identity;
        }
        if (VoiceCallService.sameIdentity(identity, VoiceCallService.transcriptIdentityCandidate)) {
          VoiceCallService.pendingIdentityTranscripts.push(transcript);
        } else {
          VoiceCallService.reportTranscriptIdentityProblem('接通前收到不一致的语音通话标识；该转写已丢弃');
        }
      } else {
        VoiceCallService.callbacks.onTranscript(transcript, null);
        VoiceCallService.reportTranscriptIdentityProblem('通话未确认助手会话身份；转写不会写入助手历史');
      }
      return;
    }
    if (type === 'speaking') {
      VoiceCallService.callbacks.onSpeaking(event.state === 'start' && !VoiceCallService.playbackSuppressed());
      return;
    }
    if (type === 'busy') {
      VoiceCallService.failCall('个人助手正忙，请稍后重试', 'assistant');
      return;
    }
    if (type === 'error') {
      const failure: VoiceCallFailure = event.failureStage === 'media' ? 'media' : 'assistant';
      if (VoiceCallService.ready) {
        VoiceCallService.failCall('语音服务异常，通话已结束，请重试', '');
      } else {
        let message = failure === 'media' ? '媒体连接失败，请重试' : '个人助手准备失败，请重试';
        if (event.httpStatus === 502 || event.httpStatus === 503 || event.httpStatus === 504) {
          message = 'Codex 语音服务暂时不可用，请稍后重试';
        } else if (event.httpStatus === 401 || event.httpStatus === 403) {
          message = 'Codex 语音访问被拒绝，请检查电脑端登录状态';
        } else if (event.httpStatus === 429) {
          message = 'Codex 语音请求受限，请稍后重试';
        }
        VoiceCallService.failCall(message, failure);
      }
      return;
    }
    if (type === 'closed') {
      VoiceCallService.flushPendingWithoutIdentity();
      if (event.reason === 'error') {
        VoiceCallService.failCall('语音服务连接失败，请重试', 'assistant');
      } else {
        VoiceCallService.endCall('通话已结束');
      }
    }
  }

  private static handleConnectionDropped(): void {
    if (VoiceCallService.stopping) {
      return;
    }
    const reason = VoiceCallService.ready ? '网络连接中断，通话已结束' : '语音通道已断开';
    VoiceCallService.failCall(reason, 'channel');
  }

  private static handlePlaybackControl(event: VoiceServerEvent): void {
    const boundIdentity = VoiceCallService.boundTranscriptIdentity;
    const identity = VoiceCallService.identityFromEvent(event);
    const revision = event.revision;
    const state = event.state;
    if (!VoiceCallService.ready || boundIdentity === null || identity === null
      || !VoiceCallService.sameIdentity(identity, boundIdentity)
      || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
      || revision <= VoiceCallService.serverPlaybackRevision
      || (state !== 'blocked' && state !== 'resumed')) {
      return;
    }
    if (event.source !== undefined && event.source !== 'manual' && event.source !== 'user_speech'
      && event.source !== 'user_turn' && event.source !== 'assistant_turn') {
      return;
    }
    VoiceCallService.serverPlaybackRevision = revision;
    if (state === 'blocked') {
      if (VoiceCallService.serverPlaybackSuppressionToken === 0) {
        VoiceCallService.serverPlaybackSuppressionToken = VoiceCallService.beginPlaybackSuppression();
      }
      // Clear the platform's buffered PCM too, without sending another interrupt
      // upstream. A later resumed event releases only the server token; the flush
      // barrier remains until its asynchronous work has completed.
      VoiceCallService.playbackEpoch += 1;
      VoiceCallService.requestPlaybackFlush();
    } else {
      VoiceCallService.endPlaybackSuppression(VoiceCallService.serverPlaybackSuppressionToken);
      VoiceCallService.serverPlaybackSuppressionToken = 0;
    }
  }

  private static failCall(reason: string, failure: VoiceCallFailure = 'channel'): void {
    const failedStage = VoiceCallService.stage;
    VoiceCallService.endCall(reason);
    VoiceCallService.setProgress(failedStage, failure);
    VoiceCallService.setStatus('error', reason);
  }

  private static endCall(reason: string): void {
    const ownerGeneration = VoiceCallService.generation;
    VoiceCallService.generation += 1;
    const client = VoiceCallService.ws;
    VoiceCallService.ws = null;
    if (client !== null) {
      VoiceCallService.offWebSocketHandlers(client);
      try {
        void client.close().catch(() => {});
      } catch (_) {
      }
    }
    VoiceCallService.teardownAudio();
    VoiceCallService.ready = false;
    VoiceCallService.flushPendingWithoutIdentity();
    VoiceCallService.transcriptIdentityCandidate = null;
    VoiceCallService.boundTranscriptIdentity = null;
    VoiceCallService.expectedProfileId = '';
    VoiceCallService.expectedRoomId = '';
    VoiceCallService.callbacks.onSpeaking(false);
    VoiceCallService.phase = 'idle';
    VoiceCallService.abilityContext = null;
    void VoiceCallService.stopVoiceBackgroundTask(ownerGeneration);
    VoiceCallService.callbacks.onClosed(reason);
  }

  private static async stopVoiceBackgroundTask(ownerGeneration: number): Promise<void> {
    try {
      await VoiceBackgroundTaskService.stop(ownerGeneration);
    } catch (error) {
      console.warn('[VoiceBackgroundTask] Failed to stop voice task: ' + VoiceCallService.errorText(error));
    } finally {
      if (VoiceCallService.generation === ownerGeneration) {
        VoiceCallService.abilityContext = null;
      }
    }
  }

  private static async startCapturer(): Promise<void> {
    if (VoiceCallService.capturer !== null || VoiceCallService.capturerStartingGeneration === VoiceCallService.generation) {
      return;
    }
    const generation = VoiceCallService.generation;
    VoiceCallService.capturerStartingGeneration = generation;
    let pendingCapturer: audio.AudioCapturer | null = null;
    try {
      const options: audio.AudioCapturerOptions = {
        streamInfo: {
          samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
          channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
          encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
        },
        capturerInfo: {
          // Select the system communication capture path for acoustic echo processing.
          source: audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION,
          capturerFlags: 0
        }
      };
      const capturer = await audio.createAudioCapturer(options);
      pendingCapturer = capturer;
      if (VoiceCallService.generation !== generation) { return; }
      VoiceCallService.micQueue = [];
      capturer.on('audioInterrupt', (event: audio.InterruptEvent) => {
        VoiceCallService.handleAudioInterrupt(event, generation);
      });
      capturer.on('readData', (buffer: ArrayBuffer) => {
        if (VoiceCallService.generation === generation && VoiceCallService.phase === 'active') {
          VoiceCallService.handleMicData(buffer);
        }
      });
      await capturer.start();
      if (VoiceCallService.generation !== generation) { return; }
      VoiceCallService.capturer = capturer;
      pendingCapturer = null;
      if (VoiceCallService.ready) {
        VoiceCallService.setProgress('listening');
        VoiceCallService.setStatus('active', VoiceCallService.muted ? '通话中（已静音）' : '通话中 · 正在聆听');
      }
    } catch (error) {
      if (VoiceCallService.generation === generation) {
        VoiceCallService.failCall('麦克风启动失败，请检查权限后重试', 'mic');
      }
    } finally {
      // Pending startup belongs to this generation, never to a newer call.
      if (pendingCapturer !== null) {
        try { await pendingCapturer.stop(); } catch (_) {}
        try { await pendingCapturer.release(); } catch (_) {}
      }
      if (VoiceCallService.capturerStartingGeneration === generation) {
        VoiceCallService.capturerStartingGeneration = -1;
      }
    }
  }

  private static handleMicData(buffer: ArrayBuffer): void {
    VoiceCallService.recordVoiceAudioInput(buffer);
    if (VoiceCallService.muted || buffer.byteLength <= 0) {
      return;
    }
    VoiceCallService.micQueue.push(buffer.slice(0));
    let total: number = 0;
    for (let index = 0; index < VoiceCallService.micQueue.length; index += 1) {
      total += VoiceCallService.micQueue[index].byteLength;
    }
    if (total >= VOICE_MIC_BATCH_BYTES) {
      const merged = VoiceCallService.mergeBuffers(VoiceCallService.micQueue);
      VoiceCallService.micQueue = [];
      void VoiceCallService.sendBinary(merged);
    }
  }

  private static queuePlayback(buffer: ArrayBuffer): void {
    if (buffer.byteLength <= 0 || VoiceCallService.phase === 'error') {
      return;
    }
    VoiceCallService.voiceAudioDownlinkReceivedBytes += buffer.byteLength;
    if (VoiceCallService.voiceAudioFirstBinaryEpochMs === 0) {
      VoiceCallService.voiceAudioFirstBinaryEpochMs = Date.now();
    }
    if (VoiceCallService.playbackSuppressed()) {
      VoiceCallService.voiceAudioDownlinkDroppedBytes += buffer.byteLength;
      return;
    }
    // Never enqueue a trailing half PCM16 sample.
    const sampleBytes = Math.floor(buffer.byteLength / VOICE_PLAY_SAMPLE_BYTES) * VOICE_PLAY_SAMPLE_BYTES;
    VoiceCallService.voiceAudioDownlinkDroppedBytes += buffer.byteLength - sampleBytes;
    if (sampleBytes === 0) { return; }
    VoiceCallService.playQueue.push(sampleBytes === buffer.byteLength ? buffer : buffer.slice(0, sampleBytes));
    VoiceCallService.voiceAudioDownlinkQueuedBytes += sampleBytes;
    VoiceCallService.trimPlaybackQueue();
    VoiceCallService.recordPlaybackQueueLevel();
    void VoiceCallService.ensureRenderer();
  }

  private static ensureRenderer(recoveringOutput: boolean = false): Promise<void> {
    const generation = VoiceCallService.generation;
    if (VoiceCallService.rendererStartingGeneration === generation && VoiceCallService.rendererStartupPromise !== null) {
      return VoiceCallService.rendererStartupPromise;
    }
    if (VoiceCallService.rendererActive || VoiceCallService.stopping
      || VoiceCallService.rendererFailedGeneration === generation) {
      return Promise.resolve();
    }
    // Set before the first await: incoming PCM must not start a second renderer.
    VoiceCallService.rendererStartingGeneration = generation;
    const revision = VoiceCallService.rendererRevision;
    const startup = VoiceCallService.createRenderer(generation, revision, recoveringOutput);
    VoiceCallService.rendererStartupPromise = startup;
    return startup;
  }

  private static async createRenderer(generation: number, revision: number, recoveringOutput: boolean): Promise<void> {
    let renderer: audio.AudioRenderer | null = null;
    try {
      const options: audio.AudioRendererOptions = {
        streamInfo: {
          samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_24000,
          channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
          encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
        },
        rendererInfo: {
          usage: audio.StreamUsage.STREAM_USAGE_VOICE_COMMUNICATION,
          rendererFlags: 0
        }
      };
      renderer = await audio.createAudioRenderer(options);
      if (!VoiceCallService.ownsRenderer(generation, revision)) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      // Keep hands-free playback while allowing connected headsets to take priority.
      // This preference belongs to this renderer and ends when it is released.
      await renderer.setDefaultOutputDevice(audio.DeviceType.SPEAKER);
      if (!VoiceCallService.ownsRenderer(generation, revision)) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      renderer.on('audioInterrupt', (event: audio.InterruptEvent) => {
        if (VoiceCallService.ownsRenderer(generation, revision)) {
          VoiceCallService.handleAudioInterrupt(event, generation);
        }
      });
      renderer.on('writeData', (data: ArrayBuffer) => {
        if (VoiceCallService.ownsRenderer(generation, revision)) {
          VoiceCallService.handleWriteData(data);
        } else {
          new Uint8Array(data).fill(0);
        }
      });
      await renderer.start();
      if (!VoiceCallService.ownsRenderer(generation, revision)) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      // Publish only after startup; teardown cannot stop/release a pending start.
      VoiceCallService.renderer = renderer;
      VoiceCallService.rendererActive = true;
    } catch (error) {
      if (VoiceCallService.ownsRenderer(generation, revision)) {
        VoiceCallService.rendererFailedGeneration = generation;
      }
      if (renderer !== null) {
        await VoiceCallService.releaseRendererQuietly(renderer);
      }
      if (VoiceCallService.ownsRenderer(generation, revision)) {
        VoiceCallService.rendererActive = false;
        if (recoveringOutput) {
          VoiceCallService.reportOutputStatus('扬声器恢复失败，请重新接通');
        } else {
          VoiceCallService.failCall('扬声器启动失败，请重试', '');
        }
      }
    } finally {
      if (VoiceCallService.generation === generation && VoiceCallService.rendererRevision === revision) {
        VoiceCallService.rendererStartingGeneration = -1;
        VoiceCallService.rendererStartupPromise = null;
      }
    }
  }

  private static ownsRenderer(generation: number, revision: number): boolean {
    return VoiceCallService.generation === generation && VoiceCallService.rendererRevision === revision && !VoiceCallService.stopping;
  }

  private static async releaseRendererQuietly(renderer: audio.AudioRenderer): Promise<void> {
    try { renderer.off('audioInterrupt'); } catch (_) {}
    try {
      renderer.off('writeData');
    } catch (_) {
    }
    try {
      await renderer.stop();
    } catch (_) {
    }
    try {
      await renderer.release();
    } catch (_) {
    }
  }

  /**
   * 系统拉模型：writeData 回调给出待填充的 PCM 缓冲，从下行队列取数填满，
   * 队列不足时补静音，避免播放空洞噪声。
   */
  private static handleWriteData(data: ArrayBuffer): void {
    const callbackEpochMs = Date.now();
    const previousCallbackEpochMs = VoiceCallService.voiceAudioLastRendererCallbackEpochMs;
    if (previousCallbackEpochMs > 0) {
      const gapMs = Math.max(0, callbackEpochMs - previousCallbackEpochMs);
      if (gapMs > VoiceCallService.voiceAudioRendererCallbackGapMaxMs) {
        VoiceCallService.voiceAudioRendererCallbackGapMaxMs = gapMs;
      }
    }
    VoiceCallService.voiceAudioLastRendererCallbackEpochMs = callbackEpochMs;

    const target = new Uint8Array(data);
    if (VoiceCallService.playbackSuppressed()) {
      target.fill(0);
      VoiceCallService.voiceAudioDownlinkSilenceBytes += target.length;
      return;
    }
    const targetSampleBytes = Math.floor(target.length / VOICE_PLAY_SAMPLE_BYTES) * VOICE_PLAY_SAMPLE_BYTES;
    let filled: number = 0;
    while (filled < targetSampleBytes) {
      if (VoiceCallService.playCursorBuffer === null || VoiceCallService.playCursorView === null
        || VoiceCallService.playCursorOffset >= VoiceCallService.playCursorBuffer.byteLength) {
        const next = VoiceCallService.playQueue.shift();
        if (next === undefined) {
          break;
        }
        VoiceCallService.playCursorBuffer = next;
        VoiceCallService.playCursorView = new Uint8Array(next);
        VoiceCallService.playCursorOffset = 0;
        continue;
      }
      const available = VoiceCallService.playCursorView.length - VoiceCallService.playCursorOffset;
      const needed = targetSampleBytes - filled;
      const take = Math.min(available, needed);
      target.set(VoiceCallService.playCursorView.subarray(
        VoiceCallService.playCursorOffset,
        VoiceCallService.playCursorOffset + take
      ), filled);
      VoiceCallService.playCursorOffset += take;
      filled += take;
      VoiceCallService.voiceAudioDownlinkQueuedBytes = Math.max(0, VoiceCallService.voiceAudioDownlinkQueuedBytes - take);
    }
    if (filled < target.length) {
      target.fill(0, filled);
    }
    VoiceCallService.voiceAudioDownlinkWriteConsumeBytes += filled;
    VoiceCallService.voiceAudioDownlinkSilenceBytes += target.length - filled;
    if (VoiceCallService.voiceAudioFirstNonzeroPlayEpochMs === 0) {
      for (let index = 0; index < filled; index += 1) {
        if (target[index] !== 0) {
          VoiceCallService.voiceAudioFirstNonzeroPlayEpochMs = callbackEpochMs;
          break;
        }
      }
    }
    VoiceCallService.recordPlaybackQueueLevel();
  }

  private static recordVoiceBinaryWebSocketCallback(): void {
    const callbackEpochMs = Date.now();
    const previousCallbackEpochMs = VoiceCallService.voiceAudioLastWsCallbackEpochMs;
    if (previousCallbackEpochMs > 0) {
      const gapMs = Math.max(0, callbackEpochMs - previousCallbackEpochMs);
      if (gapMs > VoiceCallService.voiceAudioWsCallbackGapMaxMs) {
        VoiceCallService.voiceAudioWsCallbackGapMaxMs = gapMs;
      }
    }
    VoiceCallService.voiceAudioLastWsCallbackEpochMs = callbackEpochMs;
  }

  private static playbackQueueCurrentMs(): number {
    return Math.round(VoiceCallService.voiceAudioDownlinkQueuedBytes * 1000 / VOICE_PLAYBACK_BYTES_PER_SECOND);
  }

  private static recordPlaybackQueueLevel(): void {
    const queuedMs = VoiceCallService.playbackQueueCurrentMs();
    if (queuedMs > VoiceCallService.voiceAudioDownlinkQueueHighWaterMs) {
      VoiceCallService.voiceAudioDownlinkQueueHighWaterMs = queuedMs;
    }
  }

  private static trimPlaybackQueue(): void {
    let excess = VoiceCallService.voiceAudioDownlinkQueuedBytes - VOICE_PLAY_QUEUE_LIMIT_BYTES;
    while (excess > 0) {
      if (VoiceCallService.playCursorBuffer === null || VoiceCallService.playCursorView === null
        || VoiceCallService.playCursorOffset >= VoiceCallService.playCursorBuffer.byteLength) {
        const next = VoiceCallService.playQueue.shift();
        if (next === undefined) { break; }
        VoiceCallService.playCursorBuffer = next;
        VoiceCallService.playCursorView = new Uint8Array(next);
        VoiceCallService.playCursorOffset = 0;
      }
      const available = VoiceCallService.playCursorBuffer.byteLength - VoiceCallService.playCursorOffset;
      const dropBytes = Math.min(available, Math.ceil(excess / VOICE_PLAY_SAMPLE_BYTES) * VOICE_PLAY_SAMPLE_BYTES);
      VoiceCallService.playCursorOffset += dropBytes;
      VoiceCallService.voiceAudioDownlinkQueuedBytes -= dropBytes;
      VoiceCallService.voiceAudioDownlinkDroppedBytes += dropBytes;
      excess -= dropBytes;
    }
  }

  private static clearPlaybackBuffers(countDiscarded: boolean = false): void {
    if (countDiscarded) {
      VoiceCallService.voiceAudioDownlinkDroppedBytes += VoiceCallService.voiceAudioDownlinkQueuedBytes;
    }
    VoiceCallService.playQueue = [];
    VoiceCallService.playCursorBuffer = null;
    VoiceCallService.playCursorView = null;
    VoiceCallService.playCursorOffset = 0;
    VoiceCallService.voiceAudioDownlinkQueuedBytes = 0;
  }

  private static requestPlaybackFlush(): void {
    if (VoiceCallService.playbackFlushing) { return; }
    // Set the barrier before any await, including pending renderer creation/start.
    VoiceCallService.playbackFlushing = true;
    VoiceCallService.playbackFlushOwner += 1;
    void VoiceCallService.flushPlayback(VoiceCallService.generation, VoiceCallService.playbackFlushOwner);
  }

  private static async flushPlayback(generation: number, owner: number): Promise<void> {
    try {
      let flushedEpoch: number = -1;
      while (VoiceCallService.generation === generation && VoiceCallService.playbackFlushOwner === owner
        && !VoiceCallService.stopping && flushedEpoch !== VoiceCallService.playbackEpoch) {
        const epoch = VoiceCallService.playbackEpoch;
        const startup = VoiceCallService.rendererStartupPromise;
        if (startup !== null) { await startup; }
        if (VoiceCallService.generation !== generation || VoiceCallService.playbackFlushOwner !== owner
          || VoiceCallService.stopping) { return; }
        const renderer = VoiceCallService.renderer;
        if (renderer !== null) {
          try {
            await renderer.flush();
          } catch (_) {
            if (VoiceCallService.generation !== generation || VoiceCallService.playbackFlushOwner !== owner
              || VoiceCallService.stopping) { return; }
            // Revoke callback ownership before any potentially slow stop/release.
            VoiceCallService.renderer = null;
            VoiceCallService.rendererActive = false;
            VoiceCallService.rendererRevision += 1;
            VoiceCallService.rendererStartingGeneration = -1;
            VoiceCallService.rendererStartupPromise = null;
            VoiceCallService.rendererFailedGeneration = -1;
            VoiceCallService.reportOutputStatus('扬声器正在恢复，通话保持连接');
            await VoiceCallService.releaseRendererQuietly(renderer);
            if (VoiceCallService.generation !== generation || VoiceCallService.playbackFlushOwner !== owner
              || VoiceCallService.stopping) { return; }
            await VoiceCallService.ensureRenderer(true);
            if (VoiceCallService.generation !== generation || VoiceCallService.playbackFlushOwner !== owner
              || VoiceCallService.stopping) { return; }
            if (VoiceCallService.rendererActive) {
              VoiceCallService.reportOutputStatus('扬声器已恢复，通话继续');
            }
          }
        }
        flushedEpoch = epoch;
      }
    } finally {
      if (VoiceCallService.generation === generation && VoiceCallService.playbackFlushOwner === owner) {
        VoiceCallService.playbackFlushing = false;
      }
    }
  }

  private static reportOutputStatus(detail: string): void {
    const phase = VoiceCallService.phase;
    if (phase === 'active' || phase === 'ready' || phase === 'connecting') {
      VoiceCallService.callbacks.onStatus(phase, detail);
    }
  }

  private static teardownAudio(): void {
    VoiceCallService.playbackFlushOwner += 1;
    VoiceCallService.playbackFlushing = false;
    VoiceCallService.playbackSuppressionTokens = [];
    VoiceCallService.serverPlaybackSuppressionToken = 0;
    VoiceCallService.serverPlaybackRevision = -1;
    VoiceCallService.rendererRevision += 1;
    VoiceCallService.rendererStartupPromise = null;
    VoiceCallService.rendererStartingGeneration = -1;
    VoiceCallService.clearVoiceAudioHealth();
    VoiceCallService.micQueue = [];
    VoiceCallService.clearPlaybackBuffers();
    VoiceCallService.rendererActive = false;
    const capturer = VoiceCallService.capturer;
    VoiceCallService.capturer = null;
    if (capturer !== null) {
      try { capturer.off('audioInterrupt'); } catch (_) {}
      try {
        capturer.off('readData');
      } catch (_) {
      }
      try {
        void capturer.stop().catch(() => {});
      } catch (_) {
      }
      try {
        void capturer.release().catch(() => {});
      } catch (_) {
      }
    }
    const renderer = VoiceCallService.renderer;
    VoiceCallService.renderer = null;
    if (renderer !== null) {
      void VoiceCallService.releaseRendererQuietly(renderer);
    }
  }

  private static handleAudioInterrupt(event: audio.InterruptEvent, generation: number): void {
    if (generation !== VoiceCallService.generation || VoiceCallService.stopping) {
      return;
    }
    // Screen-off is not an audio interruption. Honor an actual system pause or
    // stop instead of showing "listening" with a capturer that no longer runs.
    if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP
      || event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE) {
      VoiceCallService.failCall('通话被系统音频打断，请在其他通话结束后重新接通', 'mic');
    }
  }

  private static offWebSocketHandlers(client: webSocket.WebSocket): void {
    try {
      client.off('open');
    } catch (_) {
    }
    try {
      client.off('message');
    } catch (_) {
    }
    try {
      client.off('close');
    } catch (_) {
    }
    try {
      client.off('error');
    } catch (_) {
    }
  }

  private static async sendText(payload: string): Promise<void> {
    const client = VoiceCallService.ws;
    if (client === null) {
      return;
    }
    try {
      await client.send(payload);
    } catch (_) {
    }
  }

  private static async sendBinary(payload: ArrayBuffer): Promise<void> {
    const client = VoiceCallService.ws;
    if (client === null || VoiceCallService.muted || VoiceCallService.stopping) {
      return;
    }
    const startedAt = Date.now();
    VoiceCallService.voiceAudioSendInFlight += 1;
    if (VoiceCallService.voiceAudioSendInFlight > VoiceCallService.voiceAudioSendMaxInFlight) {
      VoiceCallService.voiceAudioSendMaxInFlight = VoiceCallService.voiceAudioSendInFlight;
    }
    try {
      const sent = await client.send(payload);
      if (sent === false) {
        VoiceCallService.voiceAudioSendFalse += 1;
      }
    } catch (_) {
      VoiceCallService.voiceAudioSendRejected += 1;
    } finally {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (elapsedMs > VoiceCallService.voiceAudioSendMaxMs) {
        VoiceCallService.voiceAudioSendMaxMs = elapsedMs;
      }
      VoiceCallService.voiceAudioSendInFlight = Math.max(0, VoiceCallService.voiceAudioSendInFlight - 1);
    }
  }

  private static resetVoiceAudioHealth(): void {
    VoiceCallService.clearVoiceAudioHealth();
    VoiceCallService.voiceAudioReadCallbacks = 0;
    VoiceCallService.voiceAudioInputBytes = 0;
    VoiceCallService.voiceAudioMaxRms = 0;
    VoiceCallService.voiceAudioBufferMutations = 0;
    VoiceCallService.voiceAudioSendFalse = 0;
    VoiceCallService.voiceAudioSendRejected = 0;
    VoiceCallService.voiceAudioSendMaxMs = 0;
    VoiceCallService.voiceAudioSendInFlight = 0;
    VoiceCallService.voiceAudioSendMaxInFlight = 0;
    VoiceCallService.voiceAudioDownlinkReceivedBytes = 0;
    VoiceCallService.voiceAudioDownlinkDroppedBytes = 0;
    VoiceCallService.voiceAudioDownlinkWriteConsumeBytes = 0;
    VoiceCallService.voiceAudioDownlinkSilenceBytes = 0;
    VoiceCallService.voiceAudioDownlinkQueueHighWaterMs = 0;
    VoiceCallService.voiceAudioWsCallbackGapMaxMs = 0;
    VoiceCallService.voiceAudioLastWsCallbackEpochMs = 0;
    VoiceCallService.voiceAudioRendererCallbackGapMaxMs = 0;
    VoiceCallService.voiceAudioLastRendererCallbackEpochMs = 0;
    VoiceCallService.voiceAudioFirstBinaryEpochMs = 0;
    VoiceCallService.voiceAudioFirstNonzeroPlayEpochMs = 0;
    VoiceCallService.voiceAudioHealthTimer = setInterval(() => {
      const report: VoiceAudioHealthReport = {
        readCallbacks: VoiceCallService.voiceAudioReadCallbacks,
        inputBytes: VoiceCallService.voiceAudioInputBytes,
        maxPcmRms: VoiceCallService.voiceAudioMaxRms,
        bufferMutations: VoiceCallService.voiceAudioBufferMutations,
        sendFalse: VoiceCallService.voiceAudioSendFalse,
        sendRejected: VoiceCallService.voiceAudioSendRejected,
        sendMaxMs: VoiceCallService.voiceAudioSendMaxMs,
        sendInFlight: VoiceCallService.voiceAudioSendInFlight,
        sendMaxInFlight: VoiceCallService.voiceAudioSendMaxInFlight,
        downlinkReceivedBytes: VoiceCallService.voiceAudioDownlinkReceivedBytes,
        downlinkDroppedBytes: VoiceCallService.voiceAudioDownlinkDroppedBytes,
        downlinkWriteConsumeBytes: VoiceCallService.voiceAudioDownlinkWriteConsumeBytes,
        downlinkSilenceBytes: VoiceCallService.voiceAudioDownlinkSilenceBytes,
        downlinkQueueHighWaterMs: VoiceCallService.voiceAudioDownlinkQueueHighWaterMs,
        downlinkQueueCurrentMs: VoiceCallService.playbackQueueCurrentMs(),
        wsCallbackGapMaxMs: VoiceCallService.voiceAudioWsCallbackGapMaxMs,
        rendererCallbackGapMaxMs: VoiceCallService.voiceAudioRendererCallbackGapMaxMs,
        firstBinaryEpochMs: VoiceCallService.voiceAudioFirstBinaryEpochMs,
        firstNonzeroPlayEpochMs: VoiceCallService.voiceAudioFirstNonzeroPlayEpochMs
      };
      console.info('[VoiceAudioHealth] ' + JSON.stringify(report));
    }, 5000);
  }

  private static clearVoiceAudioHealth(): void {
    if (VoiceCallService.voiceAudioHealthTimer !== 0) {
      clearInterval(VoiceCallService.voiceAudioHealthTimer);
      VoiceCallService.voiceAudioHealthTimer = 0;
    }
    VoiceCallService.voiceAudioPreviousBuffer = null;
    VoiceCallService.voiceAudioPreviousSnapshot = null;
  }

  private static recordVoiceAudioInput(buffer: ArrayBuffer): void {
    try {
      VoiceCallService.voiceAudioReadCallbacks += 1;
      VoiceCallService.voiceAudioInputBytes += buffer.byteLength;

      const previousBuffer = VoiceCallService.voiceAudioPreviousBuffer;
      const previousSnapshot = VoiceCallService.voiceAudioPreviousSnapshot;
      if (previousBuffer !== null && previousSnapshot !== null) {
        const originalBytes = new Uint8Array(previousBuffer);
        const snapshotBytes = new Uint8Array(previousSnapshot);
        if (originalBytes.length !== snapshotBytes.length) {
          VoiceCallService.voiceAudioBufferMutations += 1;
        } else {
          for (let index = 0; index < originalBytes.length; index += 1) {
            if (originalBytes[index] !== snapshotBytes[index]) {
              VoiceCallService.voiceAudioBufferMutations += 1;
              break;
            }
          }
        }
      }

      const sampleCount = Math.floor(buffer.byteLength / 2);
      if (sampleCount > 0) {
        const samples = new DataView(buffer);
        let sumSquares = 0;
        for (let index = 0; index < sampleCount; index += 1) {
          const sample = samples.getInt16(index * 2, true);
          sumSquares += sample * sample;
        }
        const rms = Math.round(Math.sqrt(sumSquares / sampleCount));
        if (rms > VoiceCallService.voiceAudioMaxRms) {
          VoiceCallService.voiceAudioMaxRms = rms;
        }
      }

      VoiceCallService.voiceAudioPreviousBuffer = buffer;
      VoiceCallService.voiceAudioPreviousSnapshot = buffer.slice(0);
    } catch (_) {
      // Diagnostics must never alter or block the original microphone path.
    }
  }

  private static setProgress(stage: VoiceCallStage, failure: VoiceCallFailure = ''): void {
    if (stage !== VoiceCallService.stage || VoiceCallService.stageStartedAt === 0) {
      VoiceCallService.stageStartedAt = Date.now();
    }
    VoiceCallService.stage = stage;
    VoiceCallService.callbacks.onProgress?.(stage, VoiceCallService.stageStartedAt, failure);
  }

  private static setStatus(status: VoiceCallStatus, detail: string): void {
    VoiceCallService.phase = status;
    VoiceCallService.callbacks.onStatus(status, detail);
  }

  private static identityFromEvent(event: VoiceServerEvent): CompanionVoiceIdentity | null {
    const profileId = typeof event.profileId === 'string' ? event.profileId.trim() : '';
    const roomId = typeof event.roomId === 'string' ? event.roomId.trim() : '';
    const callId = typeof event.callId === 'string' ? event.callId.trim() : '';
    if (profileId.length === 0 || roomId.length === 0 || callId.length === 0) {
      return null;
    }
    return { profileId, roomId, callId };
  }

  private static sameIdentity(left: CompanionVoiceIdentity, right: CompanionVoiceIdentity): boolean {
    return left.profileId === right.profileId && left.roomId === right.roomId && left.callId === right.callId;
  }

  private static reportTranscriptIdentityProblem(detail: string): void {
    const status = VoiceCallService.phase;
    if (status === 'connecting' || status === 'ready' || status === 'active') {
      VoiceCallService.callbacks.onStatus(status, detail);
    }
  }

  private static flushPendingWithoutIdentity(): void {
    VoiceCallService.pendingIdentityTranscripts.forEach((entry: VoiceTranscriptEntry) => {
      VoiceCallService.callbacks.onTranscript(entry, null);
    });
    VoiceCallService.pendingIdentityTranscripts = [];
  }

  private static resolveVoiceWebSocketUrl(bridgeUrl: string, voiceHttpsBaseUrl: string): string {
    const override = voiceHttpsBaseUrl.trim();
    if (override.length === 0) {
      return VoiceCallService.deriveVoiceWebSocketUrl(bridgeUrl);
    }
    try {
      const parsed = new url.URL(override);
      if (parsed.protocol !== 'https:' || parsed.host.length === 0
        || parsed.username.length > 0 || parsed.password.length > 0
        || parsed.search.length > 0 || parsed.hash.length > 0) {
        return '';
      }
      const basePath = parsed.pathname.replace(/\/+$/g, '');
      return `wss://${parsed.host}${basePath}/voice`;
    } catch (_) {
      return '';
    }
  }

  private static deriveVoiceWebSocketUrl(bridgeUrl: string): string {
    const trimmed = bridgeUrl.trim().replace(/\/+$/g, '');
    if (trimmed.startsWith('https://')) {
      return `wss://${trimmed.substring('https://'.length)}/voice`;
    }
    if (trimmed.startsWith('http://')) {
      return `ws://${trimmed.substring('http://'.length)}/voice`;
    }
    if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) {
      return `${trimmed}/voice`;
    }
    return '';
  }

  private static mergeBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
    let total: number = 0;
    for (let index = 0; index < buffers.length; index += 1) {
      total += buffers[index].byteLength;
    }
    const merged = new Uint8Array(total);
    let offset: number = 0;
    for (let index = 0; index < buffers.length; index += 1) {
      merged.set(new Uint8Array(buffers[index]), offset);
      offset += buffers[index].byteLength;
    }
    return merged.buffer as ArrayBuffer;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private static errorText(error: Error | Object | string): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch (_) {
      return '未知错误';
    }
  }
}
