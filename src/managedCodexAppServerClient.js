import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveCodexBin } from './codexAppServerClient.js';

export class ManagedCodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin = options.codexBin ?? process.env.CODEX_BRIDGE_CODEX_BIN ?? resolveCodexBin();
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? Number.parseInt(process.env.CODEX_APP_SERVER_TIMEOUT_MS ?? '30000', 10);
    this.spawnProcess = options.spawnProcess ?? (() => spawn(
      this.codexBin,
      ['app-server', '--listen', 'stdio://'],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
      }
    ));
    this.clientInfo = options.clientInfo ?? {
      name: 'codex-harmony-stability-probe',
      title: 'Codex Harmony App Server Stability Probe',
      version: '0.1.0'
    };
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextRequestId = 1;
    this.initialized = null;
    this.generation = 0;
    this.autoReconnect = options.autoReconnect
      ?? process.env.CODEX_APP_SERVER_AUTO_RECONNECT !== '0';
    this.reconnectDelayMs = Math.max(0, Number(
      options.reconnectDelayMs
      ?? process.env.CODEX_APP_SERVER_RECONNECT_DELAY_MS
      ?? 1_000
    ) || 0);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.lastDisconnect = null;
    this.state = 'idle';
    this.closing = false;
  }

  async request(method, params = {}) {
    await this.ensureStarted();
    return this.requestRaw(method, params);
  }

  async initialize() {
    return await this.ensureStarted();
  }

  async notify(method, params = {}) {
    await this.ensureStarted();
    this.writeJson(Object.keys(params).length > 0 ? { method, params } : { method });
  }

  respond(id, result = {}, error = null) {
    if (error) {
      this.writeJson({ id, error });
      return;
    }
    this.writeJson({ id, result });
  }

  async restart() {
    this.cancelReconnect();
    const previous = this.child;
    this.child = null;
    this.initialized = null;
    this.stdoutBuffer = '';
    this.state = 'restarting';
    this.rejectAll(new Error('Codex app-server restarted'));
    if (previous) {
      previous.__codexProbeIntentionalClose = true;
      previous.kill();
    }
    return this.ensureStarted();
  }

  async close() {
    this.closing = true;
    this.cancelReconnect();
    const previous = this.child;
    this.child = null;
    this.initialized = null;
    this.rejectAll(new Error('Codex app-server client closed'));
    if (previous) {
      previous.__codexProbeIntentionalClose = true;
      previous.kill();
    }
    this.state = 'closed';
  }

  health() {
    return {
      state: this.state,
      generation: this.generation,
      pendingRequests: this.pending.size,
      reconnectAttempts: this.reconnectAttempts,
      reconnectScheduled: this.reconnectTimer !== null,
      lastDisconnect: this.lastDisconnect
    };
  }

  async ensureStarted() {
    if (this.closing) {
      throw new Error('Codex app-server client is closed');
    }
    if (this.initialized) {
      return this.initialized;
    }
    const started = this.start();
    this.initialized = started;
    try {
      return await started;
    } catch (error) {
      if (this.initialized === started) {
        this.initialized = null;
      }
      throw error;
    }
  }

  async start() {
    this.state = this.generation > 0 ? 'reconnecting' : 'connecting';
    const child = this.spawnProcess();
    const generation = ++this.generation;
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    child.on('error', (error) => this.handleDisconnect(child, error));
    child.on('close', (exitCode, signal) => {
      this.handleDisconnect(
        child,
        new Error(`Codex app-server exited with code ${exitCode}${signal ? ` (${signal})` : ''}`)
      );
    });

    const response = await this.requestRaw('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true
      }
    });
    if (this.child !== child) {
      throw new Error('Codex app-server changed during initialization');
    }
    this.writeJson({ method: 'initialized' });
    this.state = 'ready';
    this.reconnectAttempts = 0;
    const event = { generation, initialize: response };
    this.emit(generation === 1 ? 'connected' : 'reconnected', event);
    return event;
  }

  requestRaw(method, params) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.writeJson({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  writeJson(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const message = parseJsonLine(line);
      if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
        this.resolveResponse(message);
      } else if (message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.emit('serverRequest', message);
      } else if (message?.method) {
        this.emit('notification', message);
      } else {
        this.emit('message', message);
      }
    }
  }

  resolveResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? `Codex app-server request failed: ${pending.method}`);
      error.code = message.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  handleDisconnect(child, error) {
    if (child !== this.child || child.__codexProbeDisconnectHandled) {
      return;
    }
    child.__codexProbeDisconnectHandled = true;
    const intentional = child.__codexProbeIntentionalClose === true || this.closing;
    this.child = null;
    this.initialized = null;
    this.stdoutBuffer = '';
    this.rejectAll(error);
    if (!intentional) {
      this.state = 'disconnected';
      this.lastDisconnect = {
        generation: this.generation,
        message: error?.message ?? String(error),
        at: new Date().toISOString()
      };
      this.emit('disconnected', {
        generation: this.generation,
        error
      });
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.autoReconnect || this.closing || this.reconnectTimer !== null) {
      return;
    }
    this.state = 'reconnecting';
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted().catch((error) => {
        if (this.closing) {
          return;
        }
        this.lastDisconnect = {
          generation: this.generation,
          message: error?.message ?? String(error),
          at: new Date().toISOString()
        };
        this.initialized = null;
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  cancelReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return {
      method: 'raw',
      params: { line }
    };
  }
}

