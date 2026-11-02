import net from 'node:net';
import { pipeBoth, readJsonLine, writeJsonLine } from './framing.js';

export function createLocalProxy({
  listenHost = '127.0.0.1',
  listenPort = 11078,
  relayHost,
  relayPort = 19078,
  deviceId = 'default',
  token = ''
} = {}) {
  if (!relayHost) {
    throw new Error('relayHost is required');
  }

  const server = net.createServer((hdcSocket) => {
    void handleHdcConnection(hdcSocket);
  });
  const activeSockets = new Set();

  async function handleHdcConnection(hdcSocket) {
    hdcSocket.setNoDelay(true);
    const relaySocket = net.createConnection({ host: relayHost, port: relayPort });
    relaySocket.setNoDelay(true);
    activeSockets.add(hdcSocket);
    activeSockets.add(relaySocket);
    hdcSocket.on('close', () => {
      activeSockets.delete(hdcSocket);
      relaySocket.destroy();
    });
    relaySocket.on('close', () => {
      activeSockets.delete(relaySocket);
      hdcSocket.destroy();
    });
    hdcSocket.on('error', () => {
      relaySocket.destroy();
    });
    relaySocket.on('error', () => {
      hdcSocket.destroy();
    });
    relaySocket.on('connect', () => {
      writeJsonLine(relaySocket, {
        role: 'pc',
        deviceId,
        token
      });
    });

    try {
      const { hello, rest } = await waitForPaired(relaySocket);
      if (!hello.ok) {
        throw new Error(hello.error ?? 'relay rejected pc connection');
      }
      pipeBoth(hdcSocket, relaySocket, Buffer.alloc(0), rest);
    } catch (error) {
      hdcSocket.destroy();
      relaySocket.destroy();
    }
  }

  async function waitForPaired(socket) {
    while (true) {
      const parsed = await readJsonLine(socket, { timeoutMs: 120000 });
      if (!parsed.hello.ok || parsed.hello.mode === 'paired') {
        return parsed;
      }
    }
  }

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(listenPort, listenHost, resolve);
      });
    },
    close() {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
