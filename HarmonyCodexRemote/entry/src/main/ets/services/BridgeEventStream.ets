import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { CredentialRuntime } from '../config/CredentialRuntime';
import { TotpGenerator } from '../utils/TotpGenerator';
import { SseFrame, SseParser } from './SseParser';

export interface BridgeEventStreamOptions {
  url: string;
  token: string;
  afterSeq: () => number;
  onFrame: (frame: SseFrame) => void;
  onState: (state: string) => void;
  onReconnect: () => void;
  cursorEnabled?: boolean;
}

/** A cancellable, authenticated stream. Snapshots/polling remain the fallback. */
export class BridgeEventStream {
  private client: http.HttpRequest | null = null;
  private generation: number = 0;
  private stopped: boolean = true;
  private retryTimer: number = -1;
  private idleTimer: number = -1;
  private failures: number = 0;
  private connectedOnce: boolean = false;
  private options: BridgeEventStreamOptions;

  constructor(options: BridgeEventStreamOptions) { this.options = options; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer >= 0) clearTimeout(this.retryTimer);
    this.retryTimer = -1;
    this.closeRequest();
  }

  isRunning(): boolean { return !this.stopped; }

  private closeRequest(): void {
    if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
    this.idleTimer = -1;
    const client = this.client;
    this.client = null;
    try { client?.destroy(); } catch (_) {}
  }

  private matches(generation: number): boolean { return !this.stopped && generation === this.generation; }

  private resetIdle(generation: number): void {
    if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.matches(generation)) return;
      this.closeRequest();
      this.retry(generation);
    }, 45000);
  }

  private retry(generation: number): void {
    if (!this.matches(generation) || this.retryTimer >= 0) return;
    this.options.onState('retrying');
    this.failures += 1;
    const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(this.failures - 1, 4)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = -1;
      if (this.matches(generation)) void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.options.onState('connecting');
    let accepted = false;
    try {
      // Generate a new code on every reconnect; never reuse an expired handshake.
      const otp = await TotpGenerator.currentCode(CredentialRuntime.getRuntimeTotpSecret());
      if (!this.matches(generation)) return;
      const headers: Record<string, string> = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (this.options.token.trim()) headers['X-Codex-Bridge-Token'] = this.options.token.trim();
      if (otp) headers['X-Codex-Bridge-OTP'] = otp;
      const cursor = Math.max(0, this.options.afterSeq());
      const url = this.options.cursorEnabled === false ? this.options.url
        : `${this.options.url}${this.options.url.indexOf('?') >= 0 ? '&' : '?'}afterSeq=${cursor}`;
      if (this.options.cursorEnabled !== false) headers['Last-Event-ID'] = String(cursor);
      const client = http.createHttp();
      this.client = client;
      const parser = new SseParser();
      const decoder = new util.TextDecoder('utf-8');
      client.on('headersReceive', (raw: Object) => {
        if (!this.matches(generation) || this.client !== client) return;
        const values = raw as Record<string, string>;
        accepted = Object.keys(values).some((key: string) => key.toLowerCase() === 'content-type'
          && String(values[key]).toLowerCase().indexOf('text/event-stream') >= 0);
        if (accepted) {
          this.failures = 0;
          this.options.onState('open');
          if (this.connectedOnce) this.options.onReconnect();
          this.connectedOnce = true;
        }
      });
      client.on('dataReceive', (bytes: ArrayBuffer) => {
        if (!this.matches(generation) || this.client !== client) return;
        this.resetIdle(generation);
        if (!accepted) return;
        try {
          const text = decoder.decodeWithStream(new Uint8Array(bytes), { stream: true });
          const frames = parser.push(text);
          for (let index = 0; index < frames.length; index += 1) {
            if (!this.matches(generation)) return;
            this.options.onFrame(frames[index]);
          }
        } catch (_) {
          this.closeRequest();
          this.retry(generation);
        }
      });
      client.on('dataEnd', () => {
        if (!this.matches(generation) || this.client !== client) return;
        this.closeRequest();
        this.retry(generation);
      });
      this.resetIdle(generation);
      // Allow the server's 5-minute lease to end first; resetIdle still bounds silent streams to 45 seconds.
      const status = await client.requestInStream(url, {
        method: http.RequestMethod.GET, header: headers, connectTimeout: 10000, readTimeout: 330000,
        usingCache: false
      });
      if (!this.matches(generation)) return;
      if (status === 401 || status === 403 || status === 404) {
        this.stop();
        this.options.onState(status === 404 ? 'unavailable' : 'auth_error');
        return;
      }
      if (status < 200 || status >= 300) {
        this.closeRequest();
        this.retry(generation);
      }
      // Some SDK versions resolve the status before dataEnd. Only dataEnd
      // closes a successful request; never destroy a live body at headers.
    } catch (_) {
      if (!this.matches(generation)) return;
      this.closeRequest();
      this.retry(generation);
    }
  }
}
