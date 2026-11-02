import { createBridgeProxy } from '../../src/hdc-relay/bridgeProxy.js';

const relayHost = process.env.HDC_RELAY_HOSTNAME ?? process.env.HDC_RELAY_HOST ?? '';
const relayPort = Number.parseInt(process.env.HDC_RELAY_PORT ?? '19078', 10);
const token = process.env.HDC_RELAY_TOKEN ?? '';
const deviceId = process.env.HDC_RELAY_DEVICE_ID ?? '';
const localBridgeHost = process.env.CODEX_BRIDGE_PROXY_HOST ?? '127.0.0.1';
const localBridgePort = Number.parseInt(process.env.CODEX_BRIDGE_PROXY_PORT ?? '8787', 10);
const poolSize = Number.parseInt(process.env.CODEX_BRIDGE_PROXY_POOL ?? '8', 10);

const proxy = createBridgeProxy({
  relayHost,
  relayPort,
  token,
  deviceId,
  localBridgeHost,
  localBridgePort,
  poolSize
});

proxy.start();
console.log(`Bridge relay proxy connected to ${relayHost}:${relayPort}`);
console.log(`Local bridge target: ${localBridgeHost}:${localBridgePort}`);

process.on('SIGINT', async () => {
  await proxy.close();
  process.exit(0);
});
