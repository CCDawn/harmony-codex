import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const pairingPayloadPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/utils/PairingPayload.ets');
const credentialStorePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeCredentialStore.ets');
const credentialRuntimePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/config/CredentialRuntime.ets');
const pairingServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgePairingService.ets');
const bridgeClientPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets');
const contentActionServicePath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/ContentActionService.ets');
const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');
const formAbilityPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/standbymonitorformability/StandbyMonitorFormAbility.ets');
const moduleProfilePath = path.resolve('HarmonyCodexRemote/entry/src/main/module.json5');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractMethodBody(sourceText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = sourceText.search(new RegExp(`^\\s*(?:private\\s+)?(?:static\\s+)?(?:async\\s+)?${escaped}\\s*\\(`, 'm'));
  assert.notEqual(start, -1, `missing method ${name}`);
  const open = sourceText.indexOf('{', start);
  assert.notEqual(open, -1, `missing method body ${name}`);
  let depth = 0;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(open + 1, index);
      }
    }
  }
  assert.fail(`unterminated method ${name}`);
}

function extractModuleConsts(sourceText) {
  return sourceText.split('\n')
    .filter((line) => /^const [A-Z0-9_]+\s*:/.test(line))
    .map((line) => line.trim())
    .join('\n');
}

function compilePairingHelpers(names) {
  const sourceText = read(pairingPayloadPath);
  const signatures = {
    parse: 'raw',
    normalizeCode: 'value',
    formatCodeDisplay: 'code',
    queryParams: 'query'
  };
  const parts = [stripTypeScriptTypes(extractModuleConsts(sourceText))];
  for (const name of names) {
    const body = extractMethodBody(sourceText, name).replace(/PairingPayload\./g, '');
    parts.push(stripTypeScriptTypes(`function ${name}(${signatures[name]}) {${body}}`));
  }
  return new Function(`${parts.join('\n')};\nreturn { ${names.join(', ')} };`)();
}

function encodePairingPayload(bridgeUrl, pairingCode) {
  return `codexharmony://pair?v=1&u=${encodeURIComponent(bridgeUrl)}&c=${pairingCode}`;
}

test('pairing payload round-trips a valid v1 qr payload', () => {
  const { parse } = compilePairingHelpers(['parse', 'normalizeCode', 'queryParams']);
  assert.deepEqual(
    parse(encodePairingPayload('https://jiaolong.tail6b2a30.ts.net:8787', 'AB2DE-FGH23')),
    { bridgeUrl: 'https://jiaolong.tail6b2a30.ts.net:8787', pairingCode: 'AB2DEFGH23' }
  );
});

test('pairing payload decodes an encoded bridge url with special characters', () => {
  const { parse } = compilePairingHelpers(['parse', 'normalizeCode', 'queryParams']);
  assert.deepEqual(
    parse(encodePairingPayload('http://192.168.1.8:8787/路径 查询?x=1', 'ab2de-fgh23')),
    { bridgeUrl: 'http://192.168.1.8:8787/路径 查询?x=1', pairingCode: 'AB2DEFGH23' }
  );
  assert.deepEqual(
    parse(encodePairingPayload('https://demo.example', 'QRSTUVWXYZ')),
    { bridgeUrl: 'https://demo.example', pairingCode: 'QRSTUVWXYZ' }
  );
});

test('pairing payload rejects malformed input without throwing', () => {
  const { parse } = compilePairingHelpers(['parse', 'normalizeCode', 'queryParams']);
  assert.equal(parse(''), null);
  assert.equal(parse('not-a-payload'), null);
  assert.equal(parse('https://pair?v=1&u=https%3A%2F%2Fdemo&c=AB2DEFGH23'), null, 'wrong scheme');
  assert.equal(parse('codexharmony://other?v=1&u=https%3A%2F%2Fdemo&c=AB2DEFGH23'), null, 'wrong host');
  assert.equal(parse('codexharmony://pair?u=https%3A%2F%2Fdemo&c=AB2DEFGH23'), null, 'missing v');
  assert.equal(parse('codexharmony://pair?v=2&u=https%3A%2F%2Fdemo&c=AB2DEFGH23'), null, 'wrong version');
  assert.equal(parse('codexharmony://pair?v=1&c=AB2DEFGH23'), null, 'missing u');
  assert.equal(parse('codexharmony://pair?v=1&u=https%3A%2F%2Fdemo'), null, 'missing c');
  assert.equal(parse('codexharmony://pair?v=1&u=ftp%3A%2F%2Fdemo&c=AB2DEFGH23'), null, 'bridge url scheme');
  assert.equal(parse('codexharmony://pair?v=1&u=https%3A%2F%2Fdemo&c=012DEFGH23'), null, 'invalid code alphabet');
  assert.equal(parse('codexharmony://pair?v=1&u=https%3A%2F%2Fdemo&c=AB2DEFGH2'), null, 'short code');
  assert.equal(parse('codexharmony://pair?v=1&u=%ZZ&c=AB2DEFGH23'), null, 'broken percent encoding');
});

test('formatCodeDisplay renders XXXXX-XXXXX from raw, dashed, or lowercase input', () => {
  const { formatCodeDisplay } = compilePairingHelpers(['formatCodeDisplay', 'normalizeCode']);
  assert.equal(formatCodeDisplay('AB2DEFGH23'), 'AB2DE-FGH23');
  assert.equal(formatCodeDisplay('AB2DE-FGH23'), 'AB2DE-FGH23');
  assert.equal(formatCodeDisplay('ab2defgh23'), 'AB2DE-FGH23');
  assert.equal(formatCodeDisplay('short'), '');
});

test('pairing payload helpers stay kit-free pure functions', () => {
  const sourceText = read(pairingPayloadPath);
  assert.doesNotMatch(sourceText, /@kit\.|@ohos\./);
  assert.match(sourceText, /export class PairingPayload/);
  assert.match(sourceText, /export interface PairingPayloadInfo/);
});

test('runtime credential accessors prefer device values and fall back to baked constants', () => {
  const runtimeText = read(credentialRuntimePath);
  assert.match(runtimeText, /static setRuntimeCredential\(credential: BridgeCredential \| null\): void/);
  assert.match(runtimeText, /static getRuntimeCredential\(\): BridgeCredential \| null/);
  const totpBody = extractMethodBody(runtimeText, 'getRuntimeTotpSecret');
  assert.match(totpBody, /credential !== null/);
  assert.match(totpBody, /credential\.totpSecret/);
  assert.match(totpBody, /return DEFAULT_BRIDGE_TOTP_SECRET/);
  const tokenBody = extractMethodBody(runtimeText, 'getRuntimeToken');
  assert.match(tokenBody, /return DEFAULT_BRIDGE_TOKEN/);
  const urlBody = extractMethodBody(runtimeText, 'getRuntimeBridgeUrl');
  assert.match(urlBody, /return DEFAULT_BRIDGE_URL/);
});

test('bridge client and content actions no longer import the baked totp secret', () => {
  const clientText = read(bridgeClientPath);
  const contentText = read(contentActionServicePath);
  const indexText = read(indexPath);

  assert.doesNotMatch(clientText, /DEFAULT_BRIDGE_TOTP_SECRET/);
  assert.match(clientText, /TotpGenerator\.currentCode\(CredentialRuntime\.getRuntimeTotpSecret\(\)\)/);
  assert.doesNotMatch(contentText, /DEFAULT_BRIDGE_TOTP_SECRET/);
  const contentMatches = contentText.match(/CredentialRuntime\.getRuntimeTotpSecret\(\)/g) ?? [];
  assert.ok(contentMatches.length >= 2, 'both download paths must draw otp from runtime');
  assert.doesNotMatch(indexText, /DEFAULT_BRIDGE_TOTP_SECRET/);
  assert.match(indexText, /getRuntimeTotpSecret\(\)\.trim\(\)\.length === 0/);
  assert.match(indexText, /TotpGenerator\.currentCode\(CredentialRuntime\.getRuntimeTotpSecret\(\)\)/);
});

test('credential store keeps the secret in asset store without persistence flag', () => {
  const storeText = read(credentialStorePath);
  assert.match(storeText, /from '@kit\.AssetStoreKit'/);
  assert.match(storeText, /'codex_bridge_credential'/);
  assert.match(storeText, /asset\.Tag\.ALIAS/);
  assert.match(storeText, /asset\.Tag\.SECRET/);
  assert.match(storeText, /asset\.Accessibility\.DEVICE_FIRST_UNLOCKED/);
  assert.doesNotMatch(storeText, /IS_PERSISTENT/);
  assert.match(storeText, /static async loadCredential\(context: common\.Context\): Promise<BridgeCredential \| null>/);
  assert.match(storeText, /static async saveCredential\(context: common\.Context, credential: BridgeCredential\): Promise<void>/);
  assert.match(storeText, /static async clearCredential\(context: common\.Context\): Promise<void>/);
  assert.match(storeText, /results\.length === 0/);
  const loadBody = extractMethodBody(storeText, 'loadCredential');
  assert.match(loadBody, /return null/);
});

test('pairing service posts enroll without auth headers and maps failure reasons', () => {
  const serviceText = read(pairingServicePath);
  assert.match(serviceText, /pair\/enroll/);
  const enrollBody = extractMethodBody(serviceText, 'enroll');
  assert.doesNotMatch(enrollBody, /X-Codex-Bridge-Token/);
  assert.doesNotMatch(enrollBody, /X-Codex-Bridge-OTP/);
  assert.match(enrollBody, /pairingCode/);
  assert.match(enrollBody, /deviceName/);

  const parts = [stripTypeScriptTypes(extractModuleConsts(serviceText))];
  for (const name of ['pairingFailureMessage', 'failureMessage']) {
    const body = extractMethodBody(serviceText, name).replace(/BridgePairingService\./g, '');
    parts.push(stripTypeScriptTypes(
      `function ${name}(${name === 'failureMessage' ? 'responseCode, rawBody, retryAfterSeconds' : 'rawBody'}) {${body}}`
    ));
  }
  const helpers = new Function(`${parts.join('\n')};\nreturn { failureMessage, pairingFailureMessage };`)();

  assert.equal(
    helpers.failureMessage(401, JSON.stringify({ error: 'pairing_failed', reason: 'code_invalid' }), ''),
    '配对码不正确，请核对后重新输入'
  );
  assert.equal(
    helpers.failureMessage(401, JSON.stringify({ error: 'pairing_failed', reason: 'code_expired' }), ''),
    '配对码已过期，请在电脑端重新生成后再试'
  );
  assert.equal(
    helpers.failureMessage(401, JSON.stringify({ error: 'pairing_failed', reason: 'code_consumed' }), ''),
    '配对码已被使用，请在电脑端重新生成后再试'
  );
  assert.equal(
    helpers.failureMessage(401, '{}', ''),
    '配对码不正确，请核对后重新输入'
  );
  assert.match(helpers.failureMessage(429, '', '7'), /7 秒后再试/);
  assert.equal(helpers.failureMessage(429, '', ''), '配对尝试过于频繁，请稍后再试');
  assert.match(helpers.failureMessage(400, '', ''), /配对请求无效/);
  assert.match(helpers.failureMessage(500, '', ''), /HTTP 500/);
});

test('index pairs through scan kit with manual fallback and runtime credential seeding', () => {
  const indexText = read(indexPath);

  assert.match(indexText, /from '@kit\.ScanKit'/);
  assert.match(indexText, /scanBarcode\.startScanForResult\(context, options\)/);
  assert.match(indexText, /enableMultiMode: false/);
  assert.match(indexText, /enableAlbum: true/);
  assert.match(indexText, /SystemCapability\.Multimedia\.Scan/);
  assert.match(indexText, /result\.originalValue/);
  assert.match(indexText, /PairingPayload\.parse\(rawPayload\)/);
  assert.match(indexText, /BridgePairingService\.enroll\(/);
  assert.match(indexText, /BridgeCredentialStore\.saveCredential\(context, credential\)/);
  assert.match(indexText, /BridgeCredentialStore\.clearCredential\(context\)/);
  assert.match(indexText, /CredentialRuntime\.setRuntimeCredential\(credential\)/);
  assert.match(indexText, /CredentialRuntime\.setRuntimeCredential\(null\)/);
  assert.match(indexText, /BridgeClient\.getRuntimeStatus\(this\.normalizedBridgeUrl\(\), this\.bridgeToken\)/);
  assert.match(indexText, /PairingPayload\.normalizeCode\(this\.pairingManualCode\)/);

  const appearBody = extractMethodBody(indexText, 'aboutToAppear');
  assert.match(appearBody, /initializeBridgeCredential/);
  const initBody = extractMethodBody(indexText, 'initializeBridgeCredential');
  assert.match(initBody, /loadCredential/);
  assert.match(initBody, /pairingGuideVisible = CredentialRuntime\.getRuntimeToken\(\)\.trim\(\)\.length === 0/);
  assert.match(initBody, /startBridgeOtpRefresh\(\)/);

  const applyBody = extractMethodBody(indexText, 'applyRuntimeCredential');
  assert.match(applyBody, /this\.bridgeToken = credential\.token;/);
  const applyTokenRefs = applyBody.match(/credential\.token/g) ?? [];
  assert.equal(applyTokenRefs.length, 1, 'token value must only flow into state, never into logs');
  assert.doesNotMatch(applyBody, /totpSecret/);
  const enrollPairingBody = extractMethodBody(indexText, 'enrollPairing');
  assert.doesNotMatch(enrollPairingBody, /credential\.token/);
  assert.doesNotMatch(enrollPairingBody, /totpSecret/);
  assert.match(enrollPairingBody, /credential\.deviceId/);
  // busy 互锁归属：enrollPairing 不得读写 pairingBusy，否则扫码入口置位后会被其早退守卫吞掉
  assert.doesNotMatch(enrollPairingBody, /pairingBusy/, 'busy must be owned by entry points only');
  const scanBody = extractMethodBody(indexText, 'startScanPairing');
  assert.match(scanBody, /this\.pairingBusy = true/);
  assert.match(scanBody, /finally/);
  assert.doesNotMatch(scanBody, /token=|totpSecret/);
  const manualPairingBody = extractMethodBody(indexText, 'pairWithManualCode');
  assert.match(manualPairingBody, /this\.pairingBusy = true/);
  assert.match(manualPairingBody, /finally/);
  assert.match(manualPairingBody, /await this\.enrollPairing\(bridgeUrl, pairingCode, 'manual'\)/);
  const unpairBody = extractMethodBody(indexText, 'unpairBridgeCredential');
  assert.match(unpairBody, /this\.bridgeUrl = DEFAULT_BRIDGE_URL/);
  assert.match(unpairBody, /this\.bridgeToken = DEFAULT_BRIDGE_TOKEN/);
});

test('connection panel exposes scan pairing, manual fallback, and unpair entries', () => {
  const indexText = read(indexPath);
  const panelBody = extractMethodBody(indexText, 'ConnectionPanel');

  assert.match(panelBody, /'扫码配对'/);
  assert.match(panelBody, /'解除配对'/);
  assert.match(panelBody, /'使用配对码配对'/);
  assert.match(panelBody, /this\.pairingManualCode/);
  assert.match(panelBody, /this\.pairingStatusText/);
  assert.match(panelBody, /this\.pairingGuideVisible/);
  assert.match(panelBody, /this\.startScanPairing\(\)/);
  assert.match(panelBody, /this\.unpairBridgeCredential\('panel'\)/);
  assert.match(panelBody, /this\.pairWithManualCode\(\)/);
  assert.match(panelBody, /本机不支持系统扫码/);
});

test('standby form ability loads the device credential before bridge refresh', () => {
  const formText = read(formAbilityPath);
  assert.doesNotMatch(formText, /DEFAULT_BRIDGE_TOKEN|DEFAULT_BRIDGE_URL/);
  assert.match(formText, /BridgeClient\.getRuntimeSnapshot\(\s*CredentialRuntime\.getRuntimeBridgeUrl\(\),\s*CredentialRuntime\.getRuntimeToken\(\)\s*\)/);
  assert.match(formText, /BridgeClient\.getCodexAccountUsage\(\s*CredentialRuntime\.getRuntimeBridgeUrl\(\),\s*CredentialRuntime\.getRuntimeToken\(\)\s*\)/);
  const ensureBody = extractMethodBody(formText, 'ensureRuntimeCredential');
  assert.match(ensureBody, /BridgeCredentialStore\.loadCredential/);
  assert.match(ensureBody, /CredentialRuntime\.setRuntimeCredential\(credential\)/);
  const refreshBody = extractMethodBody(formText, 'refreshFromBridge');
  assert.match(refreshBody, /ensureRuntimeCredential/);
});

test('pairing keeps module permissions unchanged', () => {
  const moduleText = read(moduleProfilePath);
  assert.doesNotMatch(moduleText, /ohos\.permission\.CAMERA/);
  const moduleProfile = Function(`"use strict"; return (${moduleText});`)();
  const permissions = (moduleProfile.module.requestPermissions ?? []).map((entry) => entry.name).sort();
  assert.deepEqual(permissions, [
    'ohos.permission.ACCELEROMETER',
    'ohos.permission.GET_NETWORK_INFO',
    'ohos.permission.INTERNET',
    'ohos.permission.KEEP_BACKGROUND_RUNNING',
    'ohos.permission.MICROPHONE'
  ]);
});
