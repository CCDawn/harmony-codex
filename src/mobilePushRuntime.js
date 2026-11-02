import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HuaweiPushClient } from './huaweiPushClient.js';
import { MobilePushStore } from './mobilePushStore.js';
import { MobilePushMonitor } from './mobilePushMonitor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Paired devices own a server-derived registration. A device cannot select a
// different device's push registration by supplying another installation id.
export function pairedPushInstallationId(deviceId) {
  const hex = createHash('sha256').update(`codex-mobile-push:${deviceId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createMobilePushRuntime({ config, desktopAdapter, desktopInteractions, deviceRegistry, logger }) {
  const store = config.mobilePushStore ?? new MobilePushStore({
    filePath: config.mobilePushStorePath ?? path.join(config.repoRoot ?? process.cwd(), 'logs/state/mobile-push.json')
  });
  let sender = config.mobilePushSender ?? null;
  let setup = 'service_account_missing';
  if (!sender && config.huaweiPushServiceAccountPath) {
    try {
      const account = JSON.parse(fs.readFileSync(config.huaweiPushServiceAccountPath, 'utf8'));
      sender = new HuaweiPushClient({ serviceAccount: account,
        category: config.huaweiPushCategory ?? 'WORK', testMessage: config.huaweiPushTestMessage !== false });
    } catch {
      // Account paths, JSON contents and crypto errors can expose credentials.
      setup = 'service_account_invalid';
    }
  }
  if (sender) setup = 'configured';

  const readTurn = config.mobilePushReadTurn ?? (async threadId => {
    if (typeof desktopAdapter?.client?.request !== 'function') throw unavailable();
    const result = await desktopAdapter.client.request('thread/turns/list', {
      threadId, limit: 50, itemsView: 'notLoaded', sortDirection: 'desc'
    });
    if (!Array.isArray(result?.data)) throw unavailable();
    return result.data;
  });
  const readRequests = config.mobilePushReadRequests ?? (threadId => {
    if (typeof desktopInteractions?.client?.listRequests !== 'function') throw unavailable();
    return desktopInteractions.client.listRequests(threadId, { readOnly: true });
  });
  const subscribe = config.mobilePushSubscribe ?? ((threadId, onChange) => {
    if (typeof desktopAdapter?.startNotificationPolling !== 'function') throw unavailable();
    const queue = [];
    return desktopAdapter.startNotificationPolling(threadId, queue, (_event, notification) => {
      queue.length = 0;
      onChange(notification);
    });
  });
  const deliveryStore = {
    async list() {
      const installations = await store.list();
      const devices = typeof deviceRegistry?.list === 'function' ? await deviceRegistry.list() : [];
      const revoked = new Set(devices.filter(device => device.revoked).map(device => pairedPushInstallationId(device.deviceId)));
      return installations.filter(item => !revoked.has(item.id));
    },
    claim: (...args) => store.claim(...args),
    releaseUnsent: (...args) => store.releaseUnsent(...args),
    settle: (...args) => store.settle(...args)
  };
  const monitor = sender ? new MobilePushMonitor({ store: deliveryStore, sender, readTurn, readRequests, subscribe, logger }) : null;
  let closed = false;
  const mutations = new Map();
  async function exclusive(id, operation) {
    const previous = mutations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    mutations.set(id, current);
    try { return await current; }
    finally { if (mutations.get(id) === current) mutations.delete(id); }
  }
  function refreshMonitor() {
    if (!monitor || closed) return;
    void monitor.start().catch(() => {
      void Promise.resolve(logger?.write?.('mobile-push', 'warn', 'mobile.push.observer.unavailable', {
        code: 'PUSH_OBSERVER_UNAVAILABLE'
      })).catch(() => {});
    });
  }

  return {
    status() { return { version: 1, configured: Boolean(sender), setup, provider: 'huawei', testMessage: config.huaweiPushTestMessage !== false }; },
    async start() {
      if (closed || !monitor) return;
      await monitor.start();
    },
    async register(auth, body) {
      if (closed) throw unavailable();
      validateRegistration(body);
      const id = auth?.kind === 'device' ? pairedPushInstallationId(auth.deviceId) : body.installationId.toLowerCase();
      await exclusive(id, async () => {
        const existing = (await store.list()).find(item => item.id === id);
        const added = body.threadIds.filter(threadId => !existing?.threadIds.includes(threadId));
        const baselineTurns = {};
        // Serialize the native baseline read with DELETE. A slow old POST
        // cannot recreate a registration after its deletion has completed.
        for (const threadId of added) {
          let turn;
          try { turn = await readTurn(threadId); } catch { throw unavailable(); }
          baselineTurns[threadId] = (Array.isArray(turn) ? turn : (turn ? [turn] : []))
            .filter(value => ['completed', 'failed', 'interrupted'].includes(value?.status) && UUID.test(value.id))
            .map(value => value.id);
        }
        await store.upsert(id, { token: body.token, threadIds: body.threadIds, enabled: true, baselineTurns });
      });
      refreshMonitor();
      return { version: 1, registration: { id, registered: true, ready: Boolean(sender), threadCount: body.threadIds.length }, ...this.status() };
    },
    async remove(auth, id) {
      if (!UUID.test(id)) throw badRequest();
      id = id.toLowerCase();
      if (auth?.kind === 'device' && id !== pairedPushInstallationId(auth.deviceId)) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      }
      await exclusive(id, () => store.remove(id));
      refreshMonitor();
      return { version: 1, removed: true };
    },
    async revokeDevice(deviceId) {
      const id = pairedPushInstallationId(deviceId);
      await exclusive(id, () => store.remove(id));
      refreshMonitor();
    },
    close() { closed = true; monitor?.close(); }
  };
}

export async function handleMobilePushRoute({ request, response, url, runtime, readBody, sendJson }) {
  if (request.method === 'GET' && url.pathname === '/api/mobile-push/status') {
    sendJson(response, 200, runtime.status()); return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/mobile-push/registration') {
    sendJson(response, 200, await runtime.register(request.codexAuth, await readBody(request))); return true;
  }
  if (request.method === 'DELETE' && url.pathname === '/api/mobile-push/registration') {
    const body = await readBody(request);
    const id = request.codexAuth?.kind === 'device'
      ? pairedPushInstallationId(request.codexAuth.deviceId) : body?.installationId;
    sendJson(response, 200, await runtime.remove(request.codexAuth, id)); return true;
  }
  const match = url.pathname.match(/^\/api\/mobile-push\/registration\/([0-9a-f-]+)$/i);
  if (request.method === 'DELETE' && match) {
    sendJson(response, 200, await runtime.remove(request.codexAuth, match[1])); return true;
  }
  return false;
}

function validateRegistration(body) {
  if (!body || !UUID.test(body.installationId) || typeof body.token !== 'string'
    || !body.token.trim() || body.token.length > 8192 || /[\u0000-\u001f\u007f]/.test(body.token)
    || !Array.isArray(body.threadIds) || body.threadIds.length > 100
    || body.threadIds.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(body.threadIds).size !== body.threadIds.length) throw badRequest();
}
function badRequest() { return Object.assign(new Error('Invalid mobile push registration'), { statusCode: 400 }); }
function unavailable() { return Object.assign(new Error('Desktop push observation unavailable'), { statusCode: 503 }); }
