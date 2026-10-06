import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase32 } from './totp.js';

const REGISTRY_SCHEMA_VERSION = 1;
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOTP_SECRET_BYTES = 20;
const DEVICE_ID_BYTES = 6;
const DEVICE_NAME_MAX_LENGTH = 64;
const TOUCH_PERSIST_THROTTLE_MS = 60_000;
const DEFAULT_SCOPES = ['full'];

export function hashDeviceToken(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

// 设备凭证注册表：明文 token 与 totpSecret 只在配对响应里出现一次；
// 落盘只保存 tokenHash（SHA-256 hex）与 totpSecret（服务端校验 OTP 需要明文）。
// 持久化纪律与 DurableOutbox 一致：load 容忍 ENOENT、串行 persistPromise、
// 临时文件（0o600）+ rename 原子替换。
export class DeviceRegistry {
  constructor({
    filePath,
    now = () => Date.now(),
    logger = null
  }) {
    if (!filePath) {
      throw new Error('Device registry requires a file path');
    }
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.logger = logger;
    this.devices = [];
    this.initialized = null;
    this.persistPromise = Promise.resolve();
    // lastSeenAt 的节流基准（仅内存）：距上次落盘超过阈值才触发 persist。
    this.touchPersistedAtMs = new Map();
  }

  async initialize() {
    if (this.initialized) {
      return await this.initialized;
    }
    this.initialized = this.load();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  async load() {
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await this.log('error', 'device_registry.load.failed', {
          message: error?.message ?? String(error)
        });
      }
    }
    this.devices = (Array.isArray(parsed?.devices) ? parsed.devices : [])
      .map(normalizePersistedDevice)
      .filter(Boolean);
  }

  // 返回明文 token / totpSecret（仅在配对成功响应中出现一次），不落盘明文 token。
  async createDevice({ deviceName } = {}) {
    await this.initialize();
    const nowMs = Number(this.now());
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex');
    const totpSecret = encodeBase32(randomBytes(DEVICE_TOTP_SECRET_BYTES));
    const createdAt = isoAt(nowMs);
    const device = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      deviceId: `dev_${randomBytes(DEVICE_ID_BYTES).toString('hex')}`,
      tokenHash: hashDeviceToken(token),
      totpSecret,
      deviceName: normalizeDeviceName(deviceName),
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
      scopes: [...DEFAULT_SCOPES]
    };
    this.devices.push(device);
    await this.persist();
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      token,
      totpSecret,
      pairedAt: device.createdAt
    };
  }

  // 命中未吊销设备；已吊销与未知一律返回 null。
  async findByTokenHash(tokenHash) {
    await this.initialize();
    const device = this.devices.find((candidate) => sameHash(candidate.tokenHash, tokenHash));
    if (!device || device.revokedAt !== null) {
      return null;
    }
    return { ...device };
  }

  // 不区分吊销状态的查找，用于把“已吊销凭证”与“未知 token”在审计里区分开。
  async findAnyByTokenHash(tokenHash) {
    await this.initialize();
    const device = this.devices.find((candidate) => sameHash(candidate.tokenHash, tokenHash));
    return device ? { ...device } : null;
  }

  // 幂等；返回 { changed } 表示本次调用是否真正发生了状态迁移。
  async revoke(deviceId) {
    await this.initialize();
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || device.revokedAt !== null) {
      return { changed: false };
    }
    device.revokedAt = Number(this.now());
    await this.persist();
    return { changed: true };
  }

  // 列表视图：绝不返回 tokenHash / totpSecret。
  async list() {
    await this.initialize();
    return this.devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revoked: device.revokedAt !== null
    }));
  }

  // lastSeenAt 节流：内存即时更新；距上次落盘 >60s 才 persist（鉴权热路径调用，不 await 落盘）。
  touch(deviceId, nowMs = Number(this.now())) {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || device.revokedAt !== null) {
      return;
    }
    const atMs = Number(nowMs);
    if (!Number.isFinite(atMs)) {
      return;
    }
    device.lastSeenAt = isoAt(atMs);
    const persistedAt = this.touchPersistedAtMs.get(deviceId) ?? Date.parse(device.createdAt);
    if (Number.isFinite(persistedAt) && atMs - persistedAt > TOUCH_PERSIST_THROTTLE_MS) {
      this.touchPersistedAtMs.set(deviceId, atMs);
      void this.persist().catch(() => {});
    }
  }

  async persist() {
    const snapshot = JSON.stringify({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      updatedAt: isoAt(Number(this.now())),
      devices: this.devices
    }, null, 2);
    this.persistPromise = this.persistPromise.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    });
    return await this.persistPromise;
  }

  async log(level, event, payload) {
    await this.logger?.write?.('security', level, event, payload).catch(() => {});
  }
}

function sameHash(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (leftText.length !== rightText.length || leftText.length === 0) {
    return false;
  }
  try {
    return timingSafeEqualHex(leftText, rightText);
  } catch {
    return leftText === rightText;
  }
}

function timingSafeEqualHex(left, right) {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function normalizeDeviceName(deviceName) {
  const text = String(deviceName ?? '').trim().slice(0, DEVICE_NAME_MAX_LENGTH);
  return text || '未命名设备';
}

function normalizePersistedDevice(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const deviceId = String(item.deviceId ?? '').trim();
  const tokenHash = String(item.tokenHash ?? '').trim();
  const totpSecret = String(item.totpSecret ?? '').trim();
  if (!deviceId || !tokenHash || !totpSecret) {
    return null;
  }
  const revokedRaw = item.revokedAt;
  const revokedAt = revokedRaw === null || revokedRaw === undefined
    ? null
    : (Number.isFinite(Number(revokedRaw)) ? Number(revokedRaw) : null);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    deviceId,
    tokenHash,
    totpSecret,
    deviceName: normalizeDeviceName(item.deviceName),
    createdAt: String(item.createdAt ?? ''),
    lastSeenAt: String(item.lastSeenAt ?? item.createdAt ?? ''),
    revokedAt,
    scopes: Array.isArray(item.scopes) && item.scopes.length > 0
      ? item.scopes.map((scope) => String(scope))
      : [...DEFAULT_SCOPES]
  };
}

function isoAt(nowMs) {
  return new Date(Number(nowMs)).toISOString();
}
