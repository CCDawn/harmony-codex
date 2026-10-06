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
import { VoiceCallStatus, VoiceTranscriptEntry } from '../model/BridgeModels';

/**
 * 语音通话链路：手机端 WebSocket ↔ 电脑端 Bridge `/voice`。
 * 上行：麦克风 PCM16LE 16kHz 单声道（约 100ms 一批二进制帧）。
 * 下行：服务端二进制帧 = PCM16LE 24kHz 单声道，送 AudioRenderer 播放。
 * 红线：任何日志与错误信息不得输出 token/OTP/secret 明文。
 */

export interface VoiceCallCallbacks {
  onStatus: (status: VoiceCallStatus, detail: string) => void;
  onTranscript: (entry: VoiceTranscriptEntry) => void;
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
  roomId?: string;
  role?: string;
  text?: string;
  final?: boolean;
  entries?: VoiceTranscriptEntry[];
  state?: string;
  message?: string;
  reason?: string;
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
// 下行播放队列上限（块数），防止渲染卡顿时无限堆积。
const VOICE_PLAY_QUEUE_CHUNK_LIMIT: number = 400;
// 下行 PCM16LE 24kHz 单声道：48,000 字节/秒。
const VOICE_PLAYBACK_BYTES_PER_SECOND: number = 48000;

const NOOP_VOICE_STATUS: (status: VoiceCallStatus, detail: string) => void = () => {};
const NOOP_VOICE_TRANSCRIPT: (entry: VoiceTranscriptEntry) => void = () => {};
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
  private static ready: boolean = false;
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
  }

  static phaseValue(): VoiceCallStatus {
    return VoiceCallService.phase;
  }

  static async requestMicPermission(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const permissions: Array<Permissions> = ['ohos.permission.MICROPHONE'];
      const result = await atManager.requestPermissionsFromUser(context, permissions);
      const authResults = result.authResults;
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

  static async connect(bridgeUrl: string, token: string): Promise<void> {
    if (VoiceCallService.phase === 'connecting' || VoiceCallService.phase === 'active' || VoiceCallService.phase === 'ready') {
      return;
    }
    VoiceCallService.generation += 1;
    const generation = VoiceCallService.generation;
    VoiceCallService.ready = false;
    VoiceCallService.stopping = false;
    VoiceCallService.muted = false;
    VoiceCallService.teardownAudio();
    VoiceCallService.setStatus('connecting', '正在连接语音通道');
    const wsUrl = VoiceCallService.resolveVoiceWebSocketUrl(bridgeUrl, VoiceRouteConfig.voiceHttpsBaseUrl);
    if (wsUrl.length === 0) {
      VoiceCallService.abilityContext = null;
      VoiceCallService.setStatus('error', '桥接地址无效，无法建立语音通道');
      return;
    }
    const context = VoiceCallService.abilityContext;
    if (context === null) {
      VoiceCallService.setStatus('error', '无法获取应用上下文，无法申请语音后台任务');
      return;
    }
    try {
      await VoiceBackgroundTaskService.start(context, generation);
    } catch (error) {
      await VoiceCallService.stopVoiceBackgroundTask(generation);
      if (VoiceCallService.generation === generation) {
        VoiceCallService.setStatus('error', `无法启动语音后台任务：${VoiceCallService.errorText(error)}`);
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
      VoiceCallService.setStatus('error', `语音通道连接失败：${lastError.length > 0 ? lastError : '未知错误'}`);
    }
  }

  static interrupt(): void {
    VoiceCallService.clearPlaybackBuffers();
    VoiceCallService.flushRendererQuietly();
    void VoiceCallService.sendText(JSON.stringify(new VoiceInterruptFrame()));
  }

  static setMuted(muted: boolean): void {
    VoiceCallService.muted = muted;
  }

  static async stop(): Promise<void> {
    const ownerGeneration = VoiceCallService.generation;
    if (VoiceCallService.phase === 'idle' && VoiceCallService.ws === null && VoiceCallService.capturer === null) {
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
    if (type === 'ready') {
      const profileName = event.profileName?.trim() ?? '';
      if (profileName.length > 0) {
        VoiceCallService.callbacks.onAssistantName(profileName);
      }
      VoiceCallService.ready = true;
      VoiceCallService.setStatus('active', '已接通，正在开启麦克风');
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
      VoiceCallService.callbacks.onTranscript({
        itemId: event.itemId,
        role: event.role ?? 'assistant',
        text: transcriptText,
        final: event.final === true
      });
      return;
    }
    if (type === 'speaking') {
      VoiceCallService.callbacks.onSpeaking(event.state === 'start');
      return;
    }
    if (type === 'busy') {
      VoiceCallService.setStatus(VoiceCallService.ready ? 'ready' : 'connecting', 'Codex 正忙，请稍后再试');
      return;
    }
    if (type === 'error') {
      VoiceCallService.failCall(`语音服务错误：${event.message ?? '未知错误'}`);
      return;
    }
    if (type === 'closed') {
      VoiceCallService.endCall(`通话已结束：${event.reason ?? '服务端关闭'}`);
    }
  }

  private static handleConnectionDropped(): void {
    if (VoiceCallService.stopping) {
      return;
    }
    const reason = VoiceCallService.ready ? '网络连接中断，通话已结束' : '语音通道已断开';
    VoiceCallService.endCall(reason);
  }

  private static failCall(reason: string): void {
    VoiceCallService.endCall(reason);
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
    if (VoiceCallService.capturer !== null) {
      return;
    }
    const generation = VoiceCallService.generation;
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
      if (VoiceCallService.generation !== generation) {
        try {
          await capturer.release();
        } catch (_) {
        }
        return;
      }
      VoiceCallService.capturer = capturer;
      VoiceCallService.micQueue = [];
      capturer.on('readData', (buffer: ArrayBuffer) => {
        VoiceCallService.handleMicData(buffer);
      });
      await capturer.start();
      if (VoiceCallService.generation !== generation) {
        VoiceCallService.teardownAudio();
        return;
      }
      if (VoiceCallService.ready) {
        VoiceCallService.setStatus('active', VoiceCallService.muted ? '通话中（已静音）' : '通话中 · 正在聆听');
      }
    } catch (error) {
      if (VoiceCallService.generation === generation) {
        VoiceCallService.failCall(`麦克风启动失败：${VoiceCallService.errorText(error)}`);
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
    VoiceCallService.playQueue.push(buffer);
    VoiceCallService.voiceAudioDownlinkQueuedBytes += buffer.byteLength;
    if (VoiceCallService.playQueue.length > VOICE_PLAY_QUEUE_CHUNK_LIMIT) {
      const dropped = VoiceCallService.playQueue.splice(
        0,
        VoiceCallService.playQueue.length - VOICE_PLAY_QUEUE_CHUNK_LIMIT
      );
      for (let index = 0; index < dropped.length; index += 1) {
        VoiceCallService.voiceAudioDownlinkDroppedBytes += dropped[index].byteLength;
        VoiceCallService.voiceAudioDownlinkQueuedBytes = Math.max(
          0,
          VoiceCallService.voiceAudioDownlinkQueuedBytes - dropped[index].byteLength
        );
      }
    }
    VoiceCallService.recordPlaybackQueueLevel();
    void VoiceCallService.ensureRenderer();
  }

  private static async ensureRenderer(): Promise<void> {
    const generation = VoiceCallService.generation;
    if (VoiceCallService.rendererActive || VoiceCallService.stopping
      || VoiceCallService.rendererStartingGeneration === generation
      || VoiceCallService.rendererFailedGeneration === generation) {
      return;
    }
    // Set before the first await: incoming PCM must not start a second renderer.
    VoiceCallService.rendererStartingGeneration = generation;
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
      if (VoiceCallService.generation !== generation || VoiceCallService.stopping) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      // Keep hands-free playback while allowing connected headsets to take priority.
      // This preference belongs to this renderer and ends when it is released.
      await renderer.setDefaultOutputDevice(audio.DeviceType.SPEAKER);
      if (VoiceCallService.generation !== generation || VoiceCallService.stopping) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      renderer.on('writeData', (data: ArrayBuffer) => {
        if (VoiceCallService.generation === generation && !VoiceCallService.stopping) {
          VoiceCallService.handleWriteData(data);
        } else {
          new Uint8Array(data).fill(0);
        }
      });
      await renderer.start();
      if (VoiceCallService.generation !== generation || VoiceCallService.stopping) {
        await VoiceCallService.releaseRendererQuietly(renderer);
        return;
      }
      // Publish only after startup; teardown cannot stop/release a pending start.
      VoiceCallService.renderer = renderer;
      VoiceCallService.rendererActive = true;
    } catch (error) {
      if (VoiceCallService.generation === generation) {
        VoiceCallService.rendererFailedGeneration = generation;
      }
      if (renderer !== null) {
        await VoiceCallService.releaseRendererQuietly(renderer);
      }
      if (VoiceCallService.generation === generation) {
        VoiceCallService.rendererActive = false;
        VoiceCallService.failCall(`扬声器启动失败：${VoiceCallService.errorText(error)}`);
      }
    } finally {
      if (VoiceCallService.rendererStartingGeneration === generation) {
        VoiceCallService.rendererStartingGeneration = -1;
      }
    }
  }

  private static async releaseRendererQuietly(renderer: audio.AudioRenderer): Promise<void> {
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
    let filled: number = 0;
    while (filled < target.length) {
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
      const needed = target.length - filled;
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

  private static clearPlaybackBuffers(): void {
    VoiceCallService.playQueue = [];
    VoiceCallService.playCursorBuffer = null;
    VoiceCallService.playCursorView = null;
    VoiceCallService.playCursorOffset = 0;
    VoiceCallService.voiceAudioDownlinkQueuedBytes = 0;
  }

  private static flushRendererQuietly(): void {
    const renderer = VoiceCallService.renderer;
    if (renderer === null) {
      return;
    }
    try {
      void renderer.flush().catch(() => {});
    } catch (_) {
    }
  }

  private static teardownAudio(): void {
    VoiceCallService.clearVoiceAudioHealth();
    VoiceCallService.micQueue = [];
    VoiceCallService.clearPlaybackBuffers();
    VoiceCallService.rendererActive = false;
    const capturer = VoiceCallService.capturer;
    VoiceCallService.capturer = null;
    if (capturer !== null) {
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
    if (client === null) {
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

  private static setStatus(status: VoiceCallStatus, detail: string): void {
    VoiceCallService.phase = status;
    VoiceCallService.callbacks.onStatus(status, detail);
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
