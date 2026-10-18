import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';

function fixture(assets) {
  const entry = 'https://desktop.invalid/assets/index-fixture.js';
  const imports = [];
  const api = {safeGet: async () => ({profile:{id:'p',messaging_room_id:'r',aeon_kind:'orbit',status:'active',display_name:'Assistant'}}), postResponse() {}};
  const client = new CompanionDesktopClient({ensureConnected:async()=>{},close(){},evaluate:async expression => {
    const fetch = async url => ({text:async()=>url === entry ? Object.keys(assets).join(',') : assets[new URL(url).pathname.split('/').at(-1)]?.source || ''});
    const loadModule = async url => {const asset=assets[new URL(url).pathname.split('/').at(-1)]; imports.push(url); return asset.exports(api)};
    return new Function('document','fetch','URL','loadModule',`return ${expression.replaceAll('await import(assetUrl)','await loadModule(assetUrl)')}`)(
      {scripts:[{type:'module',src:entry}]},fetch,URL,loadModule);
  }});
  return {client,imports};
}

test('finds Companion API in the legacy shared module', async()=>{
  const {client}=fixture({'app-shared-abc123.js':{source:'q.safeGet(`/tbo/primary`);export {q as apiExport};',exports:api=>({apiExport:api})}});
  assert.equal((await client.discover()).roomId,'r');
});

test('finds relocated Companion API in app-initial after desktop update', async()=>{
  const {client,imports}=fixture({
    'app-shared-abc123.js':{source:'export {value as other};',exports:()=>({})},
    'app-initial-def456.js':{source:'zC.safeGet(`/tbo/primary`);export {zC as activeApi};',exports:api=>({activeApi:api})}
  });
  assert.equal((await client.discover()).id,'p');
  assert.equal(imports.length,1);
  assert.match(imports[0],/app-initial-def456/);
});

test('rejects exports that lack required API methods', async()=>{
  const {client}=fixture({'app-shared-abc123.js':{source:'q.safeGet(`/tbo/primary`);export {q as apiExport};',exports:()=>({apiExport:{safeGet(){}}})}});
  await assert.rejects(client.discover(),/Companion/);
});
