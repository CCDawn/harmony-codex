import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pipeBoth, readJsonLine, writeJsonLine } from './framing.js';

export function createBridgeProxy({
  relayHost,
  relayPort = 19078,
  token = '',
  role = 'bridge-pc',
  targetId,
  deviceId = '',
  instanceId = '',
  localBridgeHost = '127.0.0.1',
  localBridgePort = 8787,
  poolSize = 4,
  reconnectMs = 1000,
  waitingSocketTtlMs = 30000
} = {}) {
  if (!relayHost) {
    throw new Error('relayHost is required');
  }
  if (role !== 'bridge-pc' && role !== 'control-pc') {
    throw new Error('role must be bridge-pc or control-pc');
  }
  if (role === 'control-pc' && (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(targetId))) {
    throw new Error('control-pc targetId must match [a-zA-Z0-9_-]{1,64}');
  }
  // 2026-11-02 anti-zombie: identity per process so the relay can evict stale
  // waiting entries left by previous process instances of the same device.
  if (!instanceId) {
    instanceId = `inst_${randomUUID()}`;
  }

  const sockets = new Set();
  const timers = new Set();
  let stopped = false;

  function schedule(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function cancelTimer(timer) {
    clearTimeout(timer);
    timers.delete(timer);
  }

  function trackSocket(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }

  function start() {
    for (let i = 0; i < poolSize; i += 1) {
      connectSlot(i);
    }
  }

  function connectSlot(slot) {
    if (stopped) {
      return;
    }

    let paired = false;
    const relaySocket = trackSocket(net.createConnection({ host: relayHost, port: relayPort }));
    relaySocket.setNoDelay(true);
    relaySocket.setKeepAlive(true, 15000);

    const waitingTimer = schedule(() => {
      if (!paired && !relaySocket.destroyed) {
        relaySocket.destroy();
      }
    }, waitingSocketTtlMs);

    relaySocket.on('connect', () => {
      writeJsonLine(relaySocket, {
        role,
        token,
        targetId,
        deviceId,
        instanceId
      });
    });

    relaySocket.on('error', () => {});
    relaySocket.on('close', () => {
      cancelTimer(waitingTimer);
      if (!stopped && !paired) {
        schedule(() => connectSlot(slot), reconnectMs);
      }
    });

    void waitForPaired(relaySocket)
      .then(({ hello, rest }) => {
        if (stopped || relaySocket.destroyed) return;
        if (!hello.ok) {
          relaySocket.destroy();
          return;
        }
        if (hello.mode !== 'paired') {
          return;
        }
        paired = true;
        cancelTimer(waitingTimer);
        schedule(() => connectSlot(slot), 0);
        const bridgeSocket = trackSocket(net.createConnection({ host: localBridgeHost, port: localBridgePort }));
        bridgeSocket.setNoDelay(true);
        bridgeSocket.on('connect', () => {
          pipeBoth(relaySocket, bridgeSocket, rest);
        });
        bridgeSocket.on('error', () => relaySocket.destroy());
        relaySocket.once('close', () => bridgeSocket.destroy());
      })
      .catch(() => {
        relaySocket.destroy();
      });
  }

  async function waitForPaired(socket) {
    while (true) {
      const parsed = await readJsonLine(socket, { timeoutMs: 0 });
      if (!parsed.hello.ok || parsed.hello.mode === 'paired') {
        return parsed;
      }
    }
  }

  async function close() {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const closed = [];
    for (const socket of sockets) {
      closed.push(new Promise((resolve) => socket.once('close', resolve)));
      socket.destroy();
    }
    await Promise.all(closed);
  }

  return { start, close };
}
