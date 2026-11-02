import socket from '@ohos.net.socket';

export interface HdcRelayConfig {
  relayHost: string;
  relayPort: number;
  deviceId: string;
  token: string;
  hdcdHost: string;
  hdcdPort: number;
}

export type HdcRelayState = '已停止' | '连接中' | '等待电脑' | '已配对' | '转发中' | '重连中' | '错误';

export type HdcRelayStatusCallback = (state: HdcRelayState, detail: string) => void;
export type HdcRelayMetricCallback = (relayToHdcdBytes: number, hdcdToRelayBytes: number) => void;

interface RelayHello {
  ok?: boolean;
  mode?: string;
  error?: string;
  channelId?: string;
}

interface SocketErrorLike {
  code?: number;
  message?: string;
}

export class HdcRelayTunnel {
  private readonly CONNECT_IN_PROGRESS_CODE: number = 2301115;
  private relaySocket: socket.TCPSocket | null = null;
  private hdcdSocket: socket.TCPSocket | null = null;
  private running: boolean = false;
  private paired: boolean = false;
  private pairing: boolean = false;
  private generation: number = 0;
  private controlBytes: number[] = [];
  private pendingHdcdBytes: ArrayBuffer[] = [];
  private readonly onStatus: HdcRelayStatusCallback;
  private readonly onMetric: HdcRelayMetricCallback;
  private relayToHdcdBytes: number = 0;
  private hdcdToRelayBytes: number = 0;
  private finishRelayConnection: (() => void) | null = null;
  private sleepTimers: Map<number, () => void> = new Map<number, () => void>();

  constructor(onStatus: HdcRelayStatusCallback, onMetric: HdcRelayMetricCallback = () => {}) {
    this.onStatus = onStatus;
    this.onMetric = onMetric;
  }

  start(config: HdcRelayConfig): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.loop(config, this.generation);
  }

  restart(config: HdcRelayConfig): void {
    this.generation += 1;
    this.running = true;
    this.paired = false;
    this.closeSockets();
    this.onStatus('重连中', '正在自动重启无线 HDC 中继');
    this.loop(config, this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.paired = false;
    this.closeSockets();
    this.onStatus('已停止', '中继已手动停止');
  }

  private async loop(config: HdcRelayConfig, generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      try {
        await this.connectOnce(config, generation);
      } catch (error) {
        if (this.generation === generation) {
          this.onStatus('错误', this.errorText(error));
        }
      }
      if (this.running && this.generation === generation) {
        this.onStatus('重连中', '1.5 秒后自动重连');
        await this.sleep(1500);
      }
    }
  }

  private async connectOnce(config: HdcRelayConfig, generation: number): Promise<void> {
    this.paired = false;
    this.pairing = false;
    this.controlBytes = [];
    this.pendingHdcdBytes = [];
    this.relayToHdcdBytes = 0;
    this.hdcdToRelayBytes = 0;
    this.emitMetric();
    this.closeSockets();

    this.onStatus('连接中', `连接 Relay ${config.relayHost}:${config.relayPort}`);
    const relay = socket.constructTCPSocketInstance();
    this.relaySocket = relay;
    // Register completion before connect/send: either operation can emit close first.
    const closed = new Promise<void>((resolve) => {
      this.finishRelayConnection = resolve;
      relay.on('close', () => {
        resolve();
        if (this.isCurrentRelay(relay, generation)) {
          this.onStatus('重连中', 'Relay 连接已关闭');
          this.closeSockets();
        }
      });
    });
    relay.on('message', (info: socket.SocketMessageInfo) => {
      void this.handleRelayMessage(config, info.message, relay, generation);
    });
    relay.on('error', (error: Error) => {
      if (this.isCurrentRelay(relay, generation)) {
        this.onStatus('错误', `Relay 错误：${this.errorText(error)}`);
        this.closeSockets();
      }
    });

    try {
      await Promise.race([relay.connect({
        address: {
          address: config.relayHost,
          port: config.relayPort,
          family: 1
        },
        timeout: 8000
      }), closed]);
      if (!this.isCurrentRelay(relay, generation)) {
        return;
      }
      await Promise.race([relay.send({
        data: JSON.stringify({
          role: 'phone',
          deviceId: config.deviceId,
          token: config.token
        }) + '\n',
        encoding: 'utf-8'
      }), closed]);
    } catch (error) {
      if (!this.isCurrentRelay(relay, generation)) {
        return;
      }
      this.closeSockets();
      throw new Error(`连接 Relay 失败：${this.errorText(error)}`);
    }
    if (!this.isCurrentRelay(relay, generation)) {
      return;
    }
    this.onStatus('等待电脑', '已连接 Relay，等待本地电脑接入');

    await closed;
  }

  private async handleRelayMessage(config: HdcRelayConfig, data: ArrayBuffer,
    relay: socket.TCPSocket, generation: number): Promise<void> {
    if (!this.isCurrentRelay(relay, generation)) {
      return;
    }
    try {
      await this.handleRelayMessageInner(config, data, relay, generation);
    } catch (error) {
      if (this.isCurrentRelay(relay, generation)) {
        this.onStatus('错误', this.errorText(error));
        this.closeSockets();
      }
    }
  }

  private async handleRelayMessageInner(config: HdcRelayConfig, data: ArrayBuffer,
    relay: socket.TCPSocket, generation: number): Promise<void> {
    if (this.paired) {
      await this.sendToHdcd(data, relay, generation);
      return;
    }
    if (this.pairing) {
      this.pendingHdcdBytes.push(data);
      return;
    }

    const incoming = new Uint8Array(data);
    for (let index = 0; index < incoming.length; index += 1) {
      this.controlBytes.push(incoming[index]);
    }
    const newlineIndex = this.controlBytes.indexOf(0x0a);
    if (newlineIndex < 0) {
      return;
    }

    const lineBytes = this.controlBytes.slice(0, newlineIndex);
    const restBytes = this.controlBytes.slice(newlineIndex + 1);
    const line = this.bytesToString(lineBytes).trim();
    const rest = this.bytesToArrayBuffer(restBytes);
    this.controlBytes = [];
    const hello = JSON.parse(line) as RelayHello;
    if (!hello.ok) {
      throw new Error(hello.error ?? 'Relay 拒绝连接');
    }
    if (hello.mode === 'waiting') {
      this.onStatus('等待电脑', 'Relay 在线，等待电脑代理连接');
      return;
    }
    if (hello.mode !== 'paired') {
      throw new Error(`未知 Relay 状态：${hello.mode ?? ''}`);
    }

    this.onStatus('已配对', `通道 ${hello.channelId ?? ''}`);
    this.pairing = true;
    await this.connectHdcd(config, relay, generation);
    if (!this.isCurrentRelay(relay, generation)) {
      return;
    }
    this.paired = true;
    this.pairing = false;
    this.onStatus('转发中', '电脑 HDC 已接入，正在转发 hdcd 字节流');
    if (rest.byteLength > 0) {
      await this.sendToHdcd(rest, relay, generation);
    }
    await this.flushPendingHdcdBytes(relay, generation);
  }

  private async connectHdcd(config: HdcRelayConfig, relay: socket.TCPSocket, generation: number): Promise<void> {
    const hdcd = socket.constructTCPSocketInstance();
    this.hdcdSocket = hdcd;
    hdcd.on('message', (info: socket.SocketMessageInfo) => {
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        void this.sendToRelay(info.message, hdcd, relay, generation);
      }
    });
    hdcd.on('close', () => {
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.onStatus('重连中', '本机 hdcd 连接已关闭');
        this.closeSockets();
      }
    });
    hdcd.on('error', (error: Error) => {
      if (this.isConnectInProgress(error)) {
        return;
      }
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.onStatus('错误', `hdcd 错误：${this.errorText(error)}`);
        this.closeSockets();
      }
    });
    try {
      await hdcd.connect({
        address: {
          address: config.hdcdHost,
          port: config.hdcdPort,
          family: 1
        },
        timeout: 5000
      });
    } catch (error) {
      if (!this.isCurrentHdcd(hdcd, relay, generation)) {
        return;
      }
      if (this.isConnectInProgress(error)) {
        await this.waitForSocketConnected(hdcd, generation, 5000);
        return;
      }
      throw new Error(`连接本机 hdcd 失败：${this.errorText(error)}`);
    }
  }

  private async waitForSocketConnected(hdcd: socket.TCPSocket, generation: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.running || this.generation !== generation || this.hdcdSocket !== hdcd) {
        throw new Error('本机 hdcd 连接已取消');
      }
      try {
        const state = await hdcd.getState();
        if (state.isConnected && this.running && this.generation === generation && this.hdcdSocket === hdcd) {
          return;
        }
      } catch (_) {
      }
      if (!this.running || this.generation !== generation || this.hdcdSocket !== hdcd) {
        throw new Error('本机 hdcd 连接已取消');
      }
      await this.sleep(50);
    }
    throw new Error('连接本机 hdcd 超时');
  }

  private isConnectInProgress(error: Error | Object | string): boolean {
    if (typeof error !== 'string') {
      const socketError = error as SocketErrorLike;
      if (Number(socketError.code ?? 0) === this.CONNECT_IN_PROGRESS_CODE) {
        return true;
      }
    }
    const detail = this.errorText(error);
    return detail.includes(`${this.CONNECT_IN_PROGRESS_CODE}`) || detail.includes('Operation in progress');
  }

  private isCurrentRelay(relay: socket.TCPSocket, generation: number): boolean {
    return this.running && this.generation === generation && this.relaySocket === relay;
  }

  private isCurrentHdcd(hdcd: socket.TCPSocket, relay: socket.TCPSocket, generation: number): boolean {
    return this.isCurrentRelay(relay, generation) && this.hdcdSocket === hdcd;
  }

  private async sendToRelay(data: ArrayBuffer, hdcd: socket.TCPSocket,
    relay: socket.TCPSocket, generation: number): Promise<void> {
    if (!this.isCurrentHdcd(hdcd, relay, generation)) {
      return;
    }
    try {
      await relay.send({ data });
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.hdcdToRelayBytes += data.byteLength;
        this.emitMetric();
      }
    } catch (error) {
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.onStatus('错误', `发送到 Relay 失败：${this.errorText(error)}`);
        this.closeSockets();
      }
    }
  }

  private async sendToHdcd(data: ArrayBuffer, relay: socket.TCPSocket, generation: number): Promise<void> {
    const hdcd = this.hdcdSocket;
    if (!hdcd || !this.isCurrentHdcd(hdcd, relay, generation)) {
      return;
    }
    try {
      await hdcd.send({ data });
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.relayToHdcdBytes += data.byteLength;
        this.emitMetric();
      }
    } catch (error) {
      if (this.isCurrentHdcd(hdcd, relay, generation)) {
        this.onStatus('错误', `发送到 hdcd 失败：${this.errorText(error)}`);
        this.closeSockets();
      }
    }
  }

  private async flushPendingHdcdBytes(relay: socket.TCPSocket, generation: number): Promise<void> {
    if (!this.isCurrentRelay(relay, generation)) {
      return;
    }
    const pending = this.pendingHdcdBytes;
    this.pendingHdcdBytes = [];
    for (let index = 0; index < pending.length; index += 1) {
      await this.sendToHdcd(pending[index], relay, generation);
    }
  }

  private closeSockets(): void {
    // Detach first so synchronous or delayed close callbacks cannot own another connection.
    const relay = this.relaySocket;
    const hdcd = this.hdcdSocket;
    const finish = this.finishRelayConnection;
    this.relaySocket = null;
    this.hdcdSocket = null;
    this.finishRelayConnection = null;
    this.paired = false;
    this.pairing = false;
    this.pendingHdcdBytes = [];
    this.sleepTimers.forEach((resolve: () => void, timer: number) => {
      clearTimeout(timer);
      resolve();
    });
    this.sleepTimers.clear();
    if (finish) {
      finish();
    }
    try {
      relay?.close();
    } catch (_) {
    }
    try {
      hdcd?.close();
    } catch (_) {
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepTimers.delete(timer);
        resolve();
      }, ms);
      this.sleepTimers.set(timer, resolve);
    });
  }

  private emitMetric(): void {
    this.onMetric(this.relayToHdcdBytes, this.hdcdToRelayBytes);
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

  private arrayBufferToString(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value);
    return this.bytesToString(Array.from(bytes));
  }

  private bytesToString(bytes: number[]): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index]);
    }
    return text;
  }

  private bytesToArrayBuffer(value: number[]): ArrayBuffer {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value[index] & 0xff;
    }
    return bytes.buffer;
  }
}
