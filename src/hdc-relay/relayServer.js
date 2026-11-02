import net from 'node:net';
import { createChannelId, pipeBoth, readLine, writeJsonLine } from './framing.js';

export function createRelayServer({
  host = '0.0.0.0',
  port = 19078,
  token = ''
} = {}) {
  const phones = new Map();
  const pendingPc = new Map();
  const activeHdc = new Map();
  const bridgePc = [];
  const controlPc = new Map();
  const sockets = new Set();
  // 2026-11-02 anti-zombie: waiting pool entries have a hard TTL. Live clients
  // recycle their waiting sockets every <=30s (bridgeProxy waitingSocketTtlMs),
  // so any entry older than bridgeGraceMs is a dead peer that never sent FIN.
  const bridgeGraceMs = 75000;
  let reapTimer = null;

  function reapStaleBridgeEntries() {
    const now = Date.now();
    const reapPool = (pool) => {
      for (const item of [...pool]) {
        if (item.registeredAt && now - item.registeredAt > bridgeGraceMs) {
          if (process.env.HDC_RELAY_DEBUG === '1') {
            console.error(`[hdc-relay] reap stale waiting entry device=${item.deviceId ?? 'default'} ageMs=${now - item.registeredAt}`);
          }
          item.socket.destroy();
          removeBridgePc(item, pool);
        }
      }
    };
    reapPool(bridgePc);
    for (const pool of controlPc.values()) {
      reapPool(pool);
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void handleConnection(socket);
  });

  async function handleConnection(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.on('error', () => {});
    let parsed;
    try {
      parsed = await readLine(socket);
    } catch (error) {
      socket.destroy();
      return;
    }

    const { line, lineBuffer, rest } = parsed;
    let hello;
    try {
      hello = JSON.parse(line);
    } catch {
      if (isHttpRequestLine(line)) {
        if (isRelayAdminRequest(line)) {
          registerRelayAdminHttp(socket, line);
          return;
        }
        registerBridgeHttp(socket, line, Buffer.concat([lineBuffer, rest]));
        return;
      }
      socket.destroy();
      return;
    }

    if (!isAuthorized(hello)) {
      writeJsonLine(socket, { ok: false, error: 'unauthorized' });
      socket.destroy();
      return;
    }

    if (hello.role === 'phone') {
      registerPhone(socket, hello, rest);
      return;
    }
    if (hello.role === 'pc') {
      registerPc(socket, hello, rest);
      return;
    }
    if (hello.role === 'bridge-pc') {
      registerBridgePc(socket, hello, rest);
      return;
    }
    if (hello.role === 'control-pc') {
      if (typeof hello.targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(hello.targetId)) {
        socket.end(`${JSON.stringify({ ok: false, error: 'invalid targetId' })}\n`);
        return;
      }
      const pool = controlPc.get(hello.targetId) ?? [];
      controlPc.set(hello.targetId, pool);
      registerBridgePc(socket, hello, rest, pool);
      return;
    }

    writeJsonLine(socket, { ok: false, error: 'unknown role' });
    socket.destroy();
  }

  function isHttpRequestLine(line) {
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/1\.[01]$/i.test(line);
  }

  function isRelayAdminRequest(line) {
    const match = line.match(/^(GET|HEAD)\s+(\S+)\s+HTTP\/1\.[01]$/i);
    if (!match) {
      return false;
    }
    const url = new URL(match[2], 'http://relay.local');
    return url.pathname === '/__relay/state' || url.pathname === '/__relay/health';
  }

  function isAuthorized(hello) {
    if (!token) {
      return true;
    }
    return hello?.token === token;
  }

  function registerRelayAdminHttp(socket, line) {
    socket.on('error', () => {});
    const match = line.match(/^(GET|HEAD)\s+(\S+)\s+HTTP\/1\.[01]$/i);
    const url = new URL(match?.[2] ?? '/', 'http://relay.local');
    const queryToken = url.searchParams.get('token') ?? '';
    if (token && queryToken !== token) {
      writeHttpJson(socket, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    writeHttpJson(socket, 200, {
      ok: true,
      now: new Date().toISOString(),
      state: currentState()
    });
  }

  function writeHttpJson(socket, statusCode, body) {
    const text = JSON.stringify(body);
    const statusText = { 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 503: 'Service Unavailable' }[statusCode];
    socket.end([
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${Buffer.byteLength(text)}`,
      'cache-control: no-store',
      'connection: close',
      '',
      text
    ].join('\r\n'));
  }

  function currentState() {
    const now = Date.now();
    const describe = (item) => ({
      deviceId: item.deviceId ?? 'default',
      instanceId: item.instanceId ?? '',
      ageMs: now - (item.registeredAt ?? now)
    });
    return {
      phones: [...phones.keys()],
      pendingPc: [...pendingPc.keys()],
      activeHdc: [...activeHdc.keys()],
      bridgePc: bridgePc.length,
      bridgePool: bridgePc.map(describe),
      controlPc: [...controlPc.values()].reduce((count, pool) => count + pool.length, 0),
      controlPool: Object.fromEntries([...controlPc.entries()].map(([targetId, pool]) => [targetId, pool.map(describe)]))
    };
  }

  function registerPhone(socket, hello, rest) {
    socket.on('error', () => {});
    const deviceId = String(hello.deviceId ?? 'default');
    if (process.env.HDC_RELAY_DEBUG === '1') {
      console.error(`[hdc-relay] phone hello device=${deviceId} rest=${rest.byteLength}`);
    }
    const waiting = pendingPc.get(deviceId);
    if (waiting) {
      pendingPc.delete(deviceId);
      writeJsonLine(socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
      writeJsonLine(waiting.socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
      rememberActiveHdc(deviceId, socket, waiting.socket);
      pipeBoth(waiting.socket, socket, waiting.rest, rest);
      return;
    }

    const existing = phones.get(deviceId);
    if (existing) {
      existing.destroy();
    }
    phones.set(deviceId, socket);
    writeJsonLine(socket, { ok: true, mode: 'waiting', deviceId });

    socket.on('close', () => {
      if (phones.get(deviceId) === socket) {
        phones.delete(deviceId);
      }
    });
    socket.on('error', () => {
      if (phones.get(deviceId) === socket) {
        phones.delete(deviceId);
      }
    });
  }

  function registerPc(socket, hello, rest) {
    socket.on('error', () => {});
    const deviceId = String(hello.deviceId ?? 'default');
    if (process.env.HDC_RELAY_DEBUG === '1') {
      console.error(`[hdc-relay] pc hello device=${deviceId} rest=${rest.byteLength}`);
    }
    const phone = phones.get(deviceId);
    const channelId = createChannelId();
    if (phone) {
      phones.delete(deviceId);
      writeJsonLine(socket, { ok: true, mode: 'paired', channelId });
      writeJsonLine(phone, { ok: true, mode: 'paired', channelId });
      rememberActiveHdc(deviceId, phone, socket);
      pipeBoth(socket, phone, rest);
      return;
    }

    const existing = pendingPc.get(deviceId);
    if (existing) {
      existing.socket.destroy();
    }
    pendingPc.set(deviceId, { socket, rest, channelId });
    writeJsonLine(socket, { ok: true, mode: 'waiting', deviceId, channelId });
    socket.on('close', () => {
      if (pendingPc.get(deviceId)?.socket === socket) {
        pendingPc.delete(deviceId);
      }
    });
    socket.on('error', () => {
      if (pendingPc.get(deviceId)?.socket === socket) {
        pendingPc.delete(deviceId);
      }
    });
  }

  function registerBridgePc(socket, hello, rest, pool = bridgePc) {
    socket.on('error', () => {});
    const channelId = createChannelId();
    const deviceId = String(hello.deviceId ?? 'default');
    const instanceId = String(hello.instanceId ?? '');
    // 2026-11-02 anti-zombie: a fresh process for the same device evicts every
    // waiting entry left by an older process instance. Prevents ghost piles
    // after stack restarts (client recycles sockets every 30s with the same
    // instanceId, so this never touches a live pool).
    if (instanceId) {
      for (const otherPool of [bridgePc, ...controlPc.values()]) {
        for (const other of [...otherPool]) {
          if (other.deviceId === deviceId && other.instanceId && other.instanceId !== instanceId) {
            other.socket.destroy();
            removeBridgePc(other, otherPool);
          }
        }
      }
    }
    const item = { socket, rest, channelId, deviceId, instanceId, registeredAt: Date.now() };
    pool.push(item);
    writeJsonLine(socket, { ok: true, mode: 'waiting', channelId });

    const cleanup = () => {
      removeBridgePc(item, pool);
      if (hello.role === 'control-pc' && pool.length === 0 && controlPc.get(hello.targetId) === pool) {
        controlPc.delete(hello.targetId);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  function rememberActiveHdc(deviceId, phoneSocket, pcSocket) {
    const existing = activeHdc.get(deviceId);
    if (existing) {
      existing.phoneSocket.destroy();
      existing.pcSocket.destroy();
    }
    const item = { phoneSocket, pcSocket };
    activeHdc.set(deviceId, item);
    const cleanup = () => {
      if (activeHdc.get(deviceId) === item) {
        activeHdc.delete(deviceId);
      }
    };
    phoneSocket.on('close', cleanup);
    phoneSocket.on('error', cleanup);
    pcSocket.on('close', cleanup);
    pcSocket.on('error', cleanup);
  }

  function registerBridgeHttp(socket, line, initialData) {
    socket.on('error', () => {});
    const requestTarget = line.split(/\s+/)[1];
    // Match the raw origin-form path: URL normalization must never change a target.
    const controlMatch = requestTarget.match(/^\/control\/v1\/targets\/([a-zA-Z0-9_-]{1,64})\/[^\s?#]*(?:\?[^\s#]*)?$/);
    let isControl = requestTarget.startsWith('/control');
    try {
      const pathname = new URL(requestTarget, 'http://relay.local').pathname;
      isControl ||= pathname.startsWith('/control');
      isControl ||= decodeURIComponent(pathname).startsWith('/control');
      if (controlMatch && (pathname !== requestTarget.split('?')[0] || /[\\]/.test(decodeURIComponent(pathname)))) {
        writeHttpJson(socket, 400, { ok: false, code: 'invalid_control_path' });
        return;
      }
    } catch {
      if (isControl) {
        writeHttpJson(socket, 400, { ok: false, code: 'invalid_control_path' });
        return;
      }
    }
    if (isControl && !controlMatch) {
      writeHttpJson(socket, 400, { ok: false, code: 'invalid_control_path' });
      return;
    }
    const pool = controlMatch ? controlPc.get(controlMatch[1]) : bridgePc;
    const waiting = pool?.shift();
    if (controlMatch && pool?.length === 0) controlPc.delete(controlMatch[1]);
    if (!waiting) {
      if (isControl) {
        writeHttpJson(socket, 503, { ok: false, code: 'control_agent_offline' });
        return;
      }
      socket.end([
        'HTTP/1.1 503 Service Unavailable',
        'content-type: application/json; charset=utf-8',
        'connection: close',
        '',
        JSON.stringify({ error: 'Desktop bridge tunnel is offline' })
      ].join('\r\n'));
      return;
    }

    writeJsonLine(waiting.socket, { ok: true, mode: 'paired', channelId: waiting.channelId });
    pipeBoth(socket, waiting.socket, initialData, waiting.rest);
  }

  function removeBridgePc(item, pool) {
    const index = pool.indexOf(item);
    if (index >= 0) {
      pool.splice(index, 1);
    }
  }

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, resolve);
        if (!reapTimer) {
          reapTimer = setInterval(() => reapStaleBridgeEntries(), 20000);
          reapTimer.unref?.();
        }
      });
    },
    close() {
      if (reapTimer) {
        clearInterval(reapTimer);
        reapTimer = null;
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      phones.clear();
      pendingPc.clear();
      activeHdc.clear();
      bridgePc.length = 0;
      controlPc.clear();
      return new Promise((resolve) => server.close(resolve));
    },
    state() {
      return currentState();
    }
  };
}
