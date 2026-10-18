import net from 'node:net';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

// /voice WebSocket 代理：不解析、不终结 WebSocket——把客户端原始 upgrade 请求
// （请求行 + rawHeaders）原样转发给 127.0.0.1:voicePort 上的 voice_server.py，
// 之后双向裸字节管道。WS 握手（含 Sec-WebSocket-Accept 计算）由上游端到端完成，
// 与手机→中继→桥的纯 TCP 透传形态一致。只记录连接/断开/错误事件，不记帧内容。
const VOICE_PATHNAME = '/voice';
// Keep the entire lazy-start budget below the phone's eight-second WS timeout.
const UPSTREAM_START_TIMEOUT_MS = 6_000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
const CONNECT_RETRY_DELAY_MS = 150;

export function attachVoiceUpgrade({ server, config, logger, authGate, supervisor }) {
  server.on('upgrade', (request, socket, head) => {
    void handleVoiceUpgrade({ request, socket, head, config, logger, authGate, supervisor });
  });
}

async function handleVoiceUpgrade({ request, socket, head, config, logger, authGate, supervisor }) {
  let url;
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    writeRawRejection(socket, 400, 'Bad Request');
    return;
  }

  if (url.pathname !== VOICE_PATHNAME) {
    writeRawRejection(socket, 404, 'Not Found');
    return;
  }

  const abort = new AbortController();
  const cancel = () => abort.abort();
  socket.once('close', cancel);
  socket.once('end', cancel);
  socket.on('error', cancel);
  socket.read(0);
  let pending = null;
  let upstream = null;
  let timer = null;
  let timedOut = false;
  let attempts = 0;
  let startedAt = null;
  let connected = false;
  try {
    // /voice 不在 loopback 豁免名单内：走与普通路由一致的完整鉴权闸门
    // （token + TOTP 开启时的动态码）。失败路径由这里改成裸 TCP 响应，
    // 因为升级 socket 已脱离 HTTP 响应对象。
    try {
      await authGate.requireAuth({ request, url });
    } catch (error) {
      const statusCode = error?.statusCode === 429 ? 429 : 401;
      writeRawRejection(
        socket,
        statusCode,
        statusCode === 429 ? 'Too Many Requests' : 'Unauthorized'
      );
      return;
    }

    abort.signal.throwIfAborted();
    // Consume EOF while starting, with bounded stream backpressure for any early
    // bytes. Preserve them until the upstream receives the original upgrade head.
    pending = new PassThrough();
    socket.pipe(pending);
    startedAt = performance.now();
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, UPSTREAM_START_TIMEOUT_MS);
    try {
      await withAbort(supervisor.ensureRunning(), abort.signal);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      logEvent(logger, 'error', 'voice.upstream.start_failed', {
        message: error?.message ?? String(error)
      });
      writeRawRejection(socket, 502, 'Bad Gateway');
      return;
    }

    while (!upstream) {
      abort.signal.throwIfAborted();
      attempts += 1;
      const candidate = net.connect({ host: '127.0.0.1', port: config.voicePort });
      candidate.on('error', () => {});
      candidate.setTimeout(CONNECT_ATTEMPT_TIMEOUT_MS, () => {
        candidate.destroy(new Error('voice upstream connect timed out'));
      });
      try {
        await once(candidate, 'connect', { signal: abort.signal });
        abort.signal.throwIfAborted();
        candidate.setTimeout(0);
        upstream = candidate;
      } catch (error) {
        candidate.destroy();
        if (abort.signal.aborted) throw error;
        await delay(CONNECT_RETRY_DELAY_MS, undefined, { signal: abort.signal });
      }
    }
    socket.setNoDelay(true);
    upstream.setNoDelay(true);

    upstream.write(buildRawRequestHead(request));
    if (head && head.length > 0) {
      upstream.write(head);
    }
    pending.pipe(upstream);
    upstream.pipe(socket);

    logEvent(logger, 'info', 'voice.tunnel.opened', {
      remoteAddress: socket.remoteAddress ?? null,
      voicePort: config.voicePort,
      attempts,
      startupMs: Math.round(performance.now() - startedAt)
    });

    socket.on('error', (error) => {
      logEvent(logger, 'warn', 'voice.tunnel.client_error', { message: error?.message ?? String(error) });
      upstream.destroy();
    });
    upstream.on('error', (error) => {
      logEvent(logger, 'warn', 'voice.tunnel.upstream_error', { message: error?.message ?? String(error) });
      socket.destroy();
    });
    let closed = false;
    const closeTunnel = () => {
      if (closed) return;
      closed = true;
      logEvent(logger, 'info', 'voice.tunnel.closed', {
        remoteAddress: socket.remoteAddress ?? null,
        voicePort: config.voicePort
      });
      socket.destroy();
      upstream.destroy();
      pending.destroy();
    };
    socket.once('close', closeTunnel);
    upstream.once('close', closeTunnel);
    connected = true;
  } catch (error) {
    if (abort.signal.aborted) {
      if (timedOut) {
        logEvent(logger, 'warn', 'voice.upstream.unreachable', {
          voicePort: config.voicePort, attempts,
          startupMs: Math.round(performance.now() - startedAt)
        });
        writeRawRejection(socket, 502, 'Bad Gateway');
      } else {
        socket.destroy();
      }
      return;
    }
    logEvent(logger, 'error', 'voice.upgrade.failed', {
      message: error?.message ?? String(error)
    });
    writeRawRejection(socket, 502, 'Bad Gateway');
  } finally {
    clearTimeout(timer);
    socket.off('close', cancel);
    socket.off('end', cancel);
    socket.off('error', cancel);
    if (!connected) {
      if (pending) socket.unpipe(pending);
      pending?.destroy();
      upstream?.destroy();
    }
  }
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) onAbort();
  });
}

// 从 upgrade request 重建原始请求头字节（method 行 + rawHeaders 原样拼回），
// 供上游 Python WS 服务端自己完成 101 握手。
function buildRawRequestHead(request) {
  const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
  const rawHeaders = request.rawHeaders ?? [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
}

function writeRawRejection(socket, statusCode, reasonPhrase) {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.end(
    `HTTP/1.1 ${statusCode} ${reasonPhrase}\r\nConnection: close\r\n\r\n`,
    () => {
      socket.destroy();
    }
  );
}

function logEvent(logger, level, event, data = {}) {
  void Promise.resolve(logger?.write?.('voice', level, event, data)).catch(() => {});
}
