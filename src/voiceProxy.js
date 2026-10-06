import net from 'node:net';
import { once } from 'node:events';

// /voice WebSocket 代理：不解析、不终结 WebSocket——把客户端原始 upgrade 请求
// （请求行 + rawHeaders）原样转发给 127.0.0.1:voicePort 上的 voice_server.py，
// 之后双向裸字节管道。WS 握手（含 Sec-WebSocket-Accept 计算）由上游端到端完成，
// 与手机→中继→桥的纯 TCP 透传形态一致。只记录连接/断开/错误事件，不记帧内容。
const VOICE_PATHNAME = '/voice';

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

    try {
      await supervisor.ensureRunning();
    } catch (error) {
      logEvent(logger, 'error', 'voice.upstream.start_failed', {
        message: error?.message ?? String(error)
      });
      writeRawRejection(socket, 502, 'Bad Gateway');
      return;
    }

    // 懒启动在 spawn 即返回，Python 绑定 voicePort 还需 1-2s；
    // 首连用短退避重试兜住冷启动窗口，避免客户端白白吃一次 502。
    let upstream = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const candidate = net.connect({ host: '127.0.0.1', port: config.voicePort });
      try {
        await once(candidate, 'connect');
        upstream = candidate;
        break;
      } catch {
        candidate.destroy();
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    }
    if (!upstream) {
      logEvent(logger, 'warn', 'voice.upstream.unreachable', {
        voicePort: config.voicePort,
        attempts: 4
      });
      writeRawRejection(socket, 502, 'Bad Gateway');
      return;
    }
    socket.setNoDelay(true);
    upstream.setNoDelay(true);

    upstream.write(buildRawRequestHead(request));
    if (head && head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);

    logEvent(logger, 'info', 'voice.tunnel.opened', {
      remoteAddress: socket.remoteAddress ?? null,
      voicePort: config.voicePort
    });

    socket.on('error', (error) => {
      logEvent(logger, 'warn', 'voice.tunnel.client_error', { message: error?.message ?? String(error) });
      upstream.destroy();
    });
    upstream.on('error', (error) => {
      logEvent(logger, 'warn', 'voice.tunnel.upstream_error', { message: error?.message ?? String(error) });
      socket.destroy();
    });
    const closeTunnel = () => {
      logEvent(logger, 'info', 'voice.tunnel.closed', {
        remoteAddress: socket.remoteAddress ?? null,
        voicePort: config.voicePort
      });
      socket.destroy();
      upstream.destroy();
    };
    socket.once('close', closeTunnel);
    upstream.once('close', closeTunnel);
  } catch (error) {
    logEvent(logger, 'error', 'voice.upgrade.failed', {
      message: error?.message ?? String(error)
    });
    writeRawRejection(socket, 502, 'Bad Gateway');
  }
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
