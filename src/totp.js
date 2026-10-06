import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const OTP_DIGITS = 6;
const STEP_SECONDS = 30;
const WINDOW_TOLERANCE = 1;

export function decodeBase32(value) {
  const text = String(value ?? '')
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!text) {
    throw new Error('base32 secret is empty');
  }
  const bytes = [];
  let bits = 0;
  let buffer = 0;
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('secret is not valid base32');
    }
    buffer = ((buffer << 5) | index) & 0xffffffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length === 0) {
    throw new Error('base32 secret is empty');
  }
  return Buffer.from(bytes);
}

// 与 decodeBase32 互逆；不补 padding（decodeBase32 会剥离 '='）。
export function encodeBase32(buffer) {
  const bytes = Buffer.from(buffer ?? '');
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffffffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function generateTotp(secret, options = {}) {
  const {
    counter = null,
    offsetSteps = 0,
    nowMs = Date.now()
  } = options;
  const key = secret instanceof Uint8Array ? secret : decodeBase32(secret);
  const step = counter ?? Math.floor(nowMs / 1000 / STEP_SECONDS) + offsetSteps;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** OTP_DIGITS).padStart(OTP_DIGITS, '0');
}

// 返回命中的绝对时间窗（number），无效码返回 null。
export function verifyTotp(secret, code, options = {}) {
  const { nowMs = Date.now(), tolerance = WINDOW_TOLERANCE } = options;
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return null;
  }
  const key = secret instanceof Uint8Array ? secret : decodeBase32(secret);
  const currentStep = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (let offset = -tolerance; offset <= tolerance; offset += 1) {
    const step = currentStep + offset;
    if (generateTotp(key, { counter: step }) === normalized) {
      return step;
    }
  }
  return null;
}

// 滑动窗口重放防护：同一窗口可重复使用；一旦出现更新窗口的有效码，更旧窗口立即作废。
export function createTotpVerifier({ secret, now = () => Date.now() } = {}) {
  const rawSecret = String(secret ?? '').trim();
  const configured = rawSecret.length > 0;
  let key = null;
  if (configured) {
    try {
      key = decodeBase32(rawSecret);
    } catch {
      key = null;
    }
  }
  // 配置了 secret 但无法解码时保持启用并拒绝所有码（fail closed），避免静默退回单因子。
  const enabled = configured;
  let highestAcceptedStep = null;

  return {
    enabled,
    verify(code) {
      if (!enabled || key === null) {
        return false;
      }
      const matched = verifyTotp(key, code, { nowMs: now() });
      if (matched === null) {
        return false;
      }
      if (highestAcceptedStep !== null && matched < highestAcceptedStep) {
        return false;
      }
      highestAcceptedStep = matched;
      return true;
    }
  };
}
