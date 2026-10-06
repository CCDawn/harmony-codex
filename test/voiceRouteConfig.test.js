import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETS_DIR = path.join(__dirname, '..', 'HarmonyCodexRemote', 'entry', 'src', 'main', 'ets');
const SERVICE_PATH = path.join(ETS_DIR, 'services', 'VoiceCallService.ets');
const LOCAL_CONFIG_PATH = path.join(ETS_DIR, 'config', 'VoiceRouteConfig.ets');
const EXAMPLE_CONFIG_PATH = path.join(ETS_DIR, 'config', 'VoiceRouteConfig.example.ets');

function readConfiguredVoiceBaseUrl() {
  const localConfig = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  const match = localConfig.match(/voiceHttpsBaseUrl\s*:\s*string\s*=\s*'([^']*)'/);
  assert.ok(match, 'local ignored config should contain the voice base URL');
  return match[1];
}

function loadService() {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8')
    .replace(/^import\s+.*?;\s*$/gm, '')
    .replace(/export\s+class\s+VoiceCallService/, 'class VoiceCallService');
  const executable = `${stripTypeScriptTypes(source, { mode: 'strip' })}\n` +
    'globalThis.VoiceCallService = VoiceCallService;';
  const context = vm.createContext({
    VoiceRouteConfig: { voiceHttpsBaseUrl: '' },
    url: { URL },
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { info() {}, warn() {}, error() {} },
    Uint8Array,
    ArrayBuffer,
    Promise,
    Error,
    Object,
    JSON,
    Math
  });
  vm.runInContext(executable, context, { filename: SERVICE_PATH });
  return context.VoiceCallService;
}

test('an empty local route preserves the existing Bridge URL derivation', () => {
  const service = loadService();
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.example:8080/base/', ''), 'ws://bridge.example:8080/base/voice');
  assert.equal(service.resolveVoiceWebSocketUrl('https://bridge.example/base', ''), 'wss://bridge.example/base/voice');
});

test('HTTPS voice override preserves the optional base path and adds only the voice path', () => {
  const service = loadService();
  const configuredBaseUrl = readConfiguredVoiceBaseUrl() || 'https://fixture.example';
  const parsedBaseUrl = new URL(configuredBaseUrl);
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.example:8080', configuredBaseUrl), `wss://${parsedBaseUrl.host}/voice`);
  assert.equal(
    service.resolveVoiceWebSocketUrl('http://bridge.example:8080', 'https://voice.example:9443/edge/'),
    'wss://voice.example:9443/edge/voice'
  );
});

test('non-HTTPS routes and URLs carrying userinfo or query credentials are rejected', () => {
  const service = loadService();
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.local:8080', 'http://voice.example'), '');
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.local:8080', 'wss://voice.example'), '');
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.local:8080', 'https://user:secret@voice.example'), '');
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.local:8080', 'https://voice.example/?token=secret'), '');
  assert.equal(service.resolveVoiceWebSocketUrl('http://bridge.local:8080', 'not a URL'), '');
});

test('the endpoint is confined to the ignored local config and the public example has no host or secret', () => {
  const localConfig = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  const exampleConfig = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  const ignoreRules = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  const configuredBaseUrl = readConfiguredVoiceBaseUrl() || 'https://fixture.example';
  const configuredHost = new URL(configuredBaseUrl).host;
  assert.ok(ignoreRules.includes('/HarmonyCodexRemote/entry/src/main/ets/config/VoiceRouteConfig.ets'));
  assert.ok(exampleConfig.includes("voiceHttpsBaseUrl: string = ''"));
  assert.equal(/https?:\/\/[^\s'\"]+/.test(exampleConfig), false);
  assert.equal(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(exampleConfig), false);
  assert.equal(/(?:token|secret|password)\s*[:=]/i.test(localConfig), false);
  for (const pathToCheck of [SERVICE_PATH, EXAMPLE_CONFIG_PATH, path.join(__dirname, '..', '.gitignore'), fileURLToPath(import.meta.url)]) {
    if (readConfiguredVoiceBaseUrl()) assert.equal(fs.readFileSync(pathToCheck, 'utf8').includes(configuredHost), false, `${path.basename(pathToCheck)} must not publish the endpoint`);
  }
});
