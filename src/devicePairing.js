import { randomBytes } from 'node:crypto';
import qrcode from './vendor/qrcode-generator.js';

// 去混淆字母表：排除 0/O/1/I/L/U，共 30 个字符。
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIRING_CODE_LENGTH = 10;
export const DEFAULT_PAIRING_TTL_MS = 300_000;
export const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_FAILURE_WINDOW_MS = 60_000;
export const PAIRING_MAX_FAILURES_PER_WINDOW = 5;
export const PAIRING_ENROLL_MAX_BODY_BYTES = 4096;
export const DEVICE_NAME_MAX_LENGTH = 64;
export const APP_VERSION_MAX_LENGTH = 32;

export function normalizePairingCode(value) {
  return String(value ?? '').trim().replace(/[\s-]/g, '').toUpperCase();
}

export function formatPairingCode(code) {
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

// 拒绝采样避免模偏差（256 % 30 != 0）。
export function generatePairingCode() {
  let code = '';
  while (code.length < PAIRING_CODE_LENGTH) {
    const pool = randomBytes(16);
    for (const byte of pool) {
      if (byte >= 240) {
        continue;
      }
      code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
      if (code.length === PAIRING_CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

// 配对会话（内存，不持久化）：create() 作废旧会话，全局只保留一个有效会话。
export function createPairingSessionStore({
  now = () => Date.now(),
  ttlMs = DEFAULT_PAIRING_TTL_MS,
  maxAttempts = DEFAULT_PAIRING_MAX_ATTEMPTS,
  generateCode = generatePairingCode
} = {}) {
  let current = null;
  return {
    create() {
      const nowMs = Number(now());
      current = {
        code: normalizePairingCode(generateCode()),
        createdAt: nowMs,
        expiresAt: nowMs + ttlMs,
        attempts: 0,
        consumed: false
      };
      return { code: current.code, expiresAt: current.expiresAt };
    },
    // 归一化后比对；过期 > 已消费 > 不匹配（attempts+1，达上限会话作废）。
    tryEnroll(code, atMs = null) {
      const nowMs = atMs === null ? Number(now()) : Number(atMs);
      if (!current) {
        return { ok: false, reason: 'code_invalid' };
      }
      if (nowMs >= current.expiresAt) {
        return { ok: false, reason: 'code_expired' };
      }
      if (current.consumed) {
        return { ok: false, reason: 'code_consumed' };
      }
      if (normalizePairingCode(code) !== current.code) {
        current.attempts += 1;
        if (current.attempts >= maxAttempts) {
          current = null;
        }
        return { ok: false, reason: 'code_invalid' };
      }
      current.consumed = true;
      return { ok: true };
    },
    peek() {
      return current
        ? { expiresAt: current.expiresAt, attempts: current.attempts, consumed: current.consumed }
        : null;
    }
  };
}

// v1 两端契约：codexharmony://pair?v=1&u=<encodeURIComponent(bridgeUrl)>&c=<pairingCode>
export function buildPairingPayload({ publicUrl = '', pairingCode }) {
  return `codexharmony://pair?v=1&u=${encodeURIComponent(String(publicUrl ?? ''))}&c=${encodeURIComponent(formatPairingCode(pairingCode))}`;
}

// 零 npm 依赖：使用 src/vendor/qrcode-generator.js（MIT，见文件头许可说明）渲染 SVG。
export function renderPairingQrSvg(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(String(payload ?? ''));
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// 与 authGate 同款的按来源失败限速构件（remoteAddress|x-forwarded-for 桶）。
export function createFailureRateLimiter({
  now = () => Date.now(),
  windowMs = PAIRING_FAILURE_WINDOW_MS,
  maxFailures = PAIRING_MAX_FAILURES_PER_WINDOW,
  resolveSourceKey
} = {}) {
  const recentFailures = new Map();
  function failureTimestamps(request) {
    const key = typeof resolveSourceKey === 'function'
      ? String(resolveSourceKey(request) ?? '')
      : '';
    let timestamps = recentFailures.get(key);
    if (!timestamps) {
      timestamps = [];
      recentFailures.set(key, timestamps);
    }
    return timestamps;
  }
  function pruneFailures(timestamps, nowMs) {
    while (timestamps.length > 0 && nowMs - timestamps[0] >= windowMs) {
      timestamps.shift();
    }
  }
  return {
    isRateLimited(request) {
      const timestamps = failureTimestamps(request);
      pruneFailures(timestamps, now());
      // 累计满 maxFailures 次失败后即进入限流（区别于 authGate 的 > 语义，这里是“满 5 次即拒”）。
      return timestamps.length >= maxFailures;
    },
    retryAfterSeconds(request) {
      const nowMs = now();
      const timestamps = failureTimestamps(request);
      pruneFailures(timestamps, nowMs);
      if (timestamps.length === 0) {
        return Math.ceil(windowMs / 1000);
      }
      return Math.max(1, Math.ceil((timestamps[0] + windowMs - nowMs) / 1000));
    },
    recordFailure(request) {
      const timestamps = failureTimestamps(request);
      pruneFailures(timestamps, now());
      timestamps.push(now());
    }
  };
}

export function validatePairEnrollBody(body) {
  const pairingCode = typeof body?.pairingCode === 'string' ? body.pairingCode.trim() : '';
  const deviceName = typeof body?.deviceName === 'string' ? body.deviceName.trim() : '';
  const appVersion = body?.appVersion === undefined || body?.appVersion === null
    ? ''
    : String(body.appVersion).trim();
  if (!pairingCode || pairingCode.length > 64) {
    return { ok: false };
  }
  if (!deviceName || deviceName.length > DEVICE_NAME_MAX_LENGTH) {
    return { ok: false };
  }
  if (appVersion.length > APP_VERSION_MAX_LENGTH) {
    return { ok: false };
  }
  return { ok: true, pairingCode, deviceName, appVersion };
}

// 配对控制台（单文件内联 HTML）。令牌只存 localStorage 且输入框为 password 型，
// 页面任何位置不回显令牌明文。localStorage key 沿用全仓 hramony 拼写约定。
export function renderPairingConsolePage({ initialPublicUrl = '' } = {}) {
  const embeddedPublicUrl = JSON.stringify(String(initialPublicUrl ?? ''));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Harmony 设备配对</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #1f2933; margin: 0; padding: 24px; }
  main { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #52606d; font-size: 13px; margin: 0 0 12px; }
  section { background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; padding: 16px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  label { display: block; font-size: 12px; color: #52606d; margin: 8px 0 4px; }
  input[type="password"], input[type="text"] { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #cbd2d9; border-radius: 6px; font-size: 13px; }
  button { background: #1660a8; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; margin-top: 8px; }
  button.secondary { background: #334e68; }
  button.danger { background: #c81e1e; }
  button:disabled { background: #9fb3c8; cursor: not-allowed; }
  .hint { font-size: 12px; color: #829ab1; margin-top: 6px; }
  #pair-result { display: none; text-align: center; margin-top: 12px; }
  #qr { display: inline-block; padding: 8px; background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; }
  #qr svg { width: 200px; height: 200px; }
  #code-text { font-size: 22px; letter-spacing: 2px; font-weight: 600; margin-top: 10px; font-family: ui-monospace, Consolas, monospace; }
  #countdown { font-size: 13px; color: #52606d; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { border-bottom: 1px solid #e4e7eb; padding: 8px 6px; text-align: left; word-break: break-all; }
  th { color: #52606d; font-weight: 500; background: #f8fafb; }
  .revoked { color: #c81e1e; }
  .ok { color: #0f7b3c; }
  #message { font-size: 13px; min-height: 18px; }
  #message.error { color: #c81e1e; }
</style>
</head>
<body>
<main>
  <section>
    <h1>Codex Harmony 设备配对</h1>
    <p class="sub">生成一次性配对码，手机 App 扫码或手填后换取设备专用令牌（token + 动态口令）。</p>
    <div id="message"></div>
  </section>

  <section>
    <h2>桥接访问令牌</h2>
    <label for="token-input">主控令牌（仅保存在本机浏览器 localStorage，不会回显）</label>
    <input type="password" id="token-input" autocomplete="off" placeholder="粘贴主控令牌">
    <button id="save-token">保存令牌</button>
    <button id="clear-token" class="danger">清除令牌</button>
    <div class="hint">所有请求通过 X-Codex-Bridge-Token 头携带令牌。</div>
  </section>

  <section>
    <h2>公网地址（可选）</h2>
    <label for="public-url">手机可达的 bridge 地址，例如 https://example.test:8787</label>
    <input type="text" id="public-url" placeholder="留空则二维码不含地址，手机端需手动填写">
    <button id="save-public-url" class="secondary">保存地址</button>
    <div class="hint">保存在本机 localStorage，生成配对码时随请求下发给服务端。</div>
  </section>

  <section>
    <h2>生成配对码</h2>
    <button id="create-btn">生成配对码</button>
    <div id="pair-result">
      <div id="qr"></div>
      <div id="code-text"></div>
      <div id="countdown"></div>
      <div class="hint">配对码 5 分钟内有效且只能使用一次；手机 App 选择“扫码配对”后使用。</div>
    </div>
  </section>

  <section>
    <h2>已配对设备</h2>
    <button id="refresh-btn" class="secondary">刷新设备列表</button>
    <table>
      <thead><tr><th>设备 ID</th><th>名称</th><th>配对时间</th><th>最近活跃</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="device-rows"></tbody>
    </table>
  </section>
</main>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'codex-hramony-bridge-token';
  var PUBLIC_URL_KEY = 'codex-hramony-pair-public-url';
  var INITIAL_PUBLIC_URL = ${embeddedPublicUrl};
  var countdownTimer = null;
  var expiresAtMs = 0;

  var el = function (id) { return document.getElementById(id); };
  var messageEl = el('message');
  var showMessage = function (text, isError) {
    messageEl.textContent = text;
    messageEl.className = isError ? 'error' : '';
  };

  var getToken = function () {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  };
  var getPublicUrl = function () {
    try { return localStorage.getItem(PUBLIC_URL_KEY) || ''; } catch (e) { return ''; }
  };

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'content-type': 'application/json', 'x-codex-bridge-token': getToken() }, options.headers || {});
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  var renderDevices = function (devices) {
    var tbody = el('device-rows');
    tbody.textContent = '';
    if (!devices || devices.length === 0) {
      var empty = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 6;
      emptyCell.textContent = '暂无已配对设备';
      empty.appendChild(emptyCell);
      tbody.appendChild(empty);
      return;
    }
    devices.forEach(function (device) {
      var row = document.createElement('tr');
      [device.deviceId, device.deviceName, formatTime(device.createdAt), formatTime(device.lastSeenAt)].forEach(function (value) {
        var cell = document.createElement('td');
        cell.textContent = value == null || value === '' ? '-' : value;
        row.appendChild(cell);
      });
      var statusCell = document.createElement('td');
      statusCell.textContent = device.revoked ? '已吊销' : '正常';
      statusCell.className = device.revoked ? 'revoked' : 'ok';
      row.appendChild(statusCell);
      var actionCell = document.createElement('td');
      if (!device.revoked) {
        var btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = '吊销';
        btn.addEventListener('click', function () {
          if (!window.confirm('确定吊销设备 ' + device.deviceName + ' 吗？吊销后该设备将无法访问 bridge。')) {
            return;
          }
          api('/desktop/pair/revoke', { method: 'POST', body: JSON.stringify({ deviceId: device.deviceId }) })
            .then(function (res) {
              if (res.ok) { showMessage('设备已吊销'); } else { explainFailure(res); }
              refreshDevices();
            });
        });
        actionCell.appendChild(btn);
      } else {
        actionCell.textContent = '-';
      }
      row.appendChild(actionCell);
      tbody.appendChild(row);
    });
  };

  var formatTime = function (value) {
    if (!value) { return '-'; }
    var ms = Date.parse(value);
    if (!isFinite(ms)) { return value; }
    return new Date(ms).toLocaleString();
  };

  var explainFailure = function (res) {
    if (res.status === 401) { showMessage('请求失败（401）：请先保存正确的主控令牌', true); }
    else if (res.status === 403) { showMessage('请求失败（403）：设备令牌不能执行主控操作', true); }
    else if (res.status === 429) { showMessage('请求过于频繁，请稍后重试', true); }
    else { showMessage('请求失败（' + res.status + '）', true); }
  };

  var refreshDevices = function () {
    return api('/desktop/pair/devices').then(function (res) {
      if (res.ok) { renderDevices(res.data.devices || []); } else { explainFailure(res); }
    });
  };

  var stopCountdown = function () {
    if (countdownTimer) { window.clearInterval(countdownTimer); countdownTimer = null; }
  };

  var tickCountdown = function () {
    var remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      el('countdown').textContent = '已过期，请重新生成';
      stopCountdown();
      return;
    }
    var totalSeconds = Math.floor(remainingMs / 1000);
    var minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    var seconds = String(totalSeconds % 60).padStart(2, '0');
    el('countdown').textContent = '有效期剩余 ' + minutes + ':' + seconds;
  };

  el('save-token').addEventListener('click', function () {
    var value = el('token-input').value;
    try { localStorage.setItem(TOKEN_KEY, value); } catch (e) {}
    el('token-input').value = '';
    showMessage(value ? '令牌已保存到本机' : '令牌已清除');
  });
  el('clear-token').addEventListener('click', function () {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    el('token-input').value = '';
    showMessage('令牌已清除');
  });
  el('save-public-url').addEventListener('click', function () {
    var value = el('public-url').value.trim().replace(/\\/+$/, '');
    try { localStorage.setItem(PUBLIC_URL_KEY, value); } catch (e) {}
    showMessage(value ? '公网地址已保存' : '公网地址已清空');
  });

  el('create-btn').addEventListener('click', function () {
    stopCountdown();
    el('pair-result').style.display = 'none';
    api('/desktop/pair/create', { method: 'POST', body: JSON.stringify({ publicUrl: getPublicUrl() }) })
      .then(function (res) {
        if (!res.ok) { explainFailure(res); return; }
        el('qr').innerHTML = res.data.qrSvg || '';
        el('code-text').textContent = res.data.pairingCode || '';
        expiresAtMs = Number(res.data.expiresAt) || 0;
        el('pair-result').style.display = 'block';
        tickCountdown();
        countdownTimer = window.setInterval(tickCountdown, 1000);
        showMessage('配对码已生成，请在 5 分钟内完成扫码');
      });
  });

  el('refresh-btn').addEventListener('click', function () { refreshDevices(); });

  el('public-url').value = getPublicUrl() || INITIAL_PUBLIC_URL;
  refreshDevices();
})();
</script>
</body>
</html>`;
}
