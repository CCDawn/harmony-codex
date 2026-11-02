import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createMobileControlServer } from '../../src/mobileControlServer.js';
import { createMobileControlAuth } from '../../src/mobileControlAuth.js';
import { createMobileControlExecutor } from '../../src/mobileControlExecutor.js';
import { createBridgeProxy } from '../../src/hdc-relay/bridgeProxy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const normalizedRoot = repoRoot.replace(/[\\/]+$/, '').toLowerCase();
const targetId = `desktop-${createHash('sha256').update(normalizedRoot, 'utf8').digest('hex').slice(0, 16)}`;
// The wrapper alone owns the encrypted forward. Never accept a remote hostname
// here: failure to create SSH must not fall back to unencrypted relay traffic.
const controlPort = 8788;
const relayPort = 11978;
let control;
let proxy;
async function shutdown() {
  await proxy?.close();
  await control?.close();
}
try {
  if (![process.env.HDC_RELAY_TOKEN, process.env.CODEX_BRIDGE_TOKEN, process.env.CODEX_BRIDGE_TOTP_SECRET]
    .every((value) => typeof value === 'string' && value.trim())) throw new Error('Control configuration unavailable');
  control = createMobileControlServer({ targetId, stateDir: path.join(repoRoot, 'logs', 'state'),
    authorize: createMobileControlAuth({ repoRoot }), executeRepair: createMobileControlExecutor({ repoRoot }) });
  await control.initialize();
  await new Promise((resolve, reject) => {
    control.server.once('error', reject);
    control.server.listen(controlPort, '127.0.0.1', resolve);
  });
  proxy = createBridgeProxy({ relayHost: '127.0.0.1', relayPort, token: process.env.HDC_RELAY_TOKEN,
    role: 'control-pc', targetId, deviceId: process.env.HDC_RELAY_DEVICE_ID ?? '',
    localBridgeHost: '127.0.0.1', localBridgePort: controlPort, poolSize: 4 });
  proxy.start();
  const ownerPid = Number(process.env.MOBILE_CONTROL_OWNER_PID);
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    const ownerWatch = setInterval(() => {
      try { process.kill(ownerPid, 0); }
      catch { shutdown().finally(() => process.exit(1)); }
    }, 5000);
    ownerWatch.unref();
  }
  console.log('Mobile control agent ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    shutdown().finally(() => process.exit(0));
  });
} catch {
  console.error('Mobile control agent unavailable');
  await shutdown();
  process.exitCode = 1;
}
