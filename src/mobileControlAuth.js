import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createAuthGate } from './app.js';

const MAX_REGISTRY_BYTES = 1024 * 1024;
function unauthorized() { return Object.assign(new Error('Unauthorized'), { statusCode: 401 }); }
function sameHash(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left ?? '') || !/^[a-f0-9]{64}$/i.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

// Read the bridge-owned file anew; never cache, touch, normalize revocation away, or write it.
function freshDeviceRegistry(file) {
  async function devices() {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      if ((await handle.stat()).size > MAX_REGISTRY_BYTES) throw unauthorized();
      const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_REGISTRY_BYTES) throw unauthorized();
      const data = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (data?.schemaVersion !== 1 || !Array.isArray(data.devices)) throw unauthorized();
      for (const device of data.devices) {
        if (!device || typeof device.deviceId !== 'string' || !device.deviceId
          || typeof device.totpSecret !== 'string' || !device.totpSecret.trim()
          || !/^[a-f0-9]{64}$/i.test(device.tokenHash ?? '')) throw unauthorized();
      }
      return data.devices;
    } catch (error) { if (error.code === 'ENOENT') return []; throw unauthorized(); }
    finally { await handle?.close(); }
  }
  return {
    async findByTokenHash(hash) { return (await devices()).find((device) => sameHash(device.tokenHash, hash) && (device.revokedAt === null || device.revokedAt === undefined)) ?? null; },
    async findAnyByTokenHash(hash) { return (await devices()).find((device) => sameHash(device.tokenHash, hash)) ?? null; }
  };
}

export function createMobileControlAuth({ repoRoot, logger, now = () => Date.now() } = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  const secret = String(process.env.CODEX_BRIDGE_TOTP_SECRET ?? '');
  const gate = createAuthGate({ logger: logger ?? { async write() {} }, now,
    deviceRegistry: freshDeviceRegistry(path.join(repoRoot, 'logs', 'state', 'device-registry.json')) });
  return async ({ request, url }) => {
    delete request.codexAuth;
    if (!String(process.env.CODEX_BRIDGE_TOKEN ?? '').trim() || !secret.trim()
      || String(process.env.CODEX_BRIDGE_TOTP_SECRET ?? '') !== secret) throw unauthorized();
    await gate.requireAuth({ request, url });
    if (!request.codexAuth || !['master', 'device'].includes(request.codexAuth.kind)) throw unauthorized();
  };
}
