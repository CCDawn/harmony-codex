import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const modelsPath = 'HarmonyCodexRemote/entry/src/main/ets/model/BridgeModels.ets';
const bridgeClientPath = 'HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets';
const presentationPath = 'HarmonyCodexRemote/entry/src/main/ets/services/ServiceTierPresentation.ets';

function extractBlock(source, start, opening = '{') {
  const open = source.indexOf(opening, start);
  assert.ok(open >= 0, 'block opening was not found');
  let depth = 1;
  let end = open + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0, 'block was not closed');
  return source.slice(start, end);
}

function instantiateMethod(filePath, signature, dependencies = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} was not found`);
  const method = extractBlock(source, start);
  const classSource = stripTypeScriptTypes(`class BridgeClient { ${method} }`);
  const Client = new Function('http', `${classSource}; return BridgeClient;`)(
    dependencies.http ?? { RequestMethod: { POST: 'POST' } }
  );
  return Client;
}

function getFastTierPredicate() {
  const source = fs.readFileSync(presentationPath, 'utf8');
  const start = source.indexOf('export function isFastServiceTier(');
  assert.ok(start >= 0, 'isFastServiceTier was not found');
  const declaration = extractBlock(source, start).replace(/^export\s+/, '');
  const functionSource = stripTypeScriptTypes(declaration);
  return new Function(`${functionSource}; return isFastServiceTier;`)();
}

test('service tier bridge models include desktop resolution and dynamic catalogs', () => {
  const source = fs.readFileSync(modelsPath, 'utf8');
  assert.match(source, /export interface CodexServiceTier\s*\{\s*id: string;\s*name: string;\s*description: string;/);
  assert.match(source, /export interface SessionSettingsPatch\s*\{[\s\S]*?serviceTier\?: string;/);
  assert.match(source, /serviceTiers\?: CodexServiceTier\[\];/);
  assert.match(source, /serviceTier\?: string;/);
  assert.match(source, /defaultServiceTier\?: string;/);
  assert.match(source, /effectiveServiceTier\?: string;/);
  assert.match(source, /serviceTierSource\?: 'session' \| 'desktop';/);
  assert.match(source, /serviceTierOptions\?: CodexServiceTier\[\];/);
});

test('fast service tiers require a recognized id supported by the catalog', () => {
  const isFastServiceTier = getFastTierPredicate();
  const catalog = [
    { id: 'priority', name: 'Priority', description: 'Fast' },
    { id: 'standard', name: 'Standard', description: 'Default' }
  ];
  assert.equal(isFastServiceTier('priority', catalog), true);
  assert.equal(isFastServiceTier(' PRIORITY ', catalog), true);
  assert.equal(isFastServiceTier('fast', catalog), false);
  assert.equal(isFastServiceTier('standard', catalog), false);
  assert.equal(isFastServiceTier('unknown', catalog), false);
  assert.equal(isFastServiceTier('priority', undefined), false);
  assert.equal(isFastServiceTier('', catalog), false);
});

test('model catalog service tiers retain full id, name, and description options', () => {
  const option = { id: 'priority', name: 'Fast', description: 'Prioritized response' };
  const modelCatalog = [{ id: 'gpt-model', displayName: 'GPT model', serviceTiers: [option] }];
  assert.deepEqual(modelCatalog[0].serviceTiers, [option]);
  const source = fs.readFileSync(modelsPath, 'utf8');
  assert.match(source, /serviceTiers\?: CodexServiceTier\[\];/);
});

test('session settings updates serialize only explicit patch fields', async () => {
  const requests = [];
  const Client = instantiateMethod(bridgeClientPath, 'static async updateSessionSettings(', {
    http: { RequestMethod: { POST: 'POST' } }
  });
  Client.request = async (_method, _url, body) => {
    requests.push(JSON.parse(body));
    return JSON.stringify({ settings: { reasoningEffort: '', serviceTier: 'priority' } });
  };

  await Client.updateSessionSettings('', 'thread', { reasoningEffort: '' });
  assert.equal(Object.hasOwn(requests[0], 'serviceTier'), false);

  await Client.updateSessionSettings('', 'thread', { serviceTier: '' });
  assert.equal(requests[1].serviceTier, '');

  await Client.updateSessionSettings('', 'thread', { serviceTier: 'priority' });
  assert.equal(requests[2].serviceTier, 'priority');
});

test('new thread sends carry a service tier only when explicitly selected', async () => {
  const requests = [];
  const Client = instantiateMethod(bridgeClientPath, 'static async startCodexThread(', {
    http: { RequestMethod: { POST: 'POST' } }
  });
  Client.request = async (_method, _url, body) => {
    requests.push(JSON.parse(body));
    return JSON.stringify({ run: { id: 'run' } });
  };

  await Client.startCodexThread('', 'project', 'message');
  assert.equal(Object.hasOwn(requests[0], 'serviceTier'), false);
  await Client.startCodexThread('', 'project', 'message', '', '', '', '', '');
  assert.equal(Object.hasOwn(requests[1], 'serviceTier'), true);
  assert.equal(requests[1].serviceTier, '');
  await Client.startCodexThread('', 'project', 'message', '', '', '', '', 'priority');
  assert.equal(requests[2].serviceTier, 'priority');
});

test('existing thread message sends leave service tier resolution to the server', async () => {
  const requests = [];
  const Client = instantiateMethod(bridgeClientPath, 'static async sendCodexThreadMessage(', {
    http: { RequestMethod: { POST: 'POST' } }
  });
  Client.request = async (_method, _url, body) => {
    requests.push(JSON.parse(body));
    return JSON.stringify({ run: { id: 'run' } });
  };

  await Client.sendCodexThreadMessage('', 'thread', 'message', 'project', '', null);
  assert.equal(Object.hasOwn(requests[0], 'serviceTier'), false);
});
