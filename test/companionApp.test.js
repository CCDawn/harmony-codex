import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DiagnosticLogger } from '../src/diagnosticLogger.js';
import { MockCodexAdapter } from '../src/mockCodexAdapter.js';

test('Companion routes use the bridge authentication gate and cannot send messages', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'companion-app-test-'));
  const oldToken=process.env.CODEX_BRIDGE_TOKEN;
  const oldOtp=process.env.CODEX_BRIDGE_TOTP_SECRET;
  process.env.CODEX_BRIDGE_TOKEN='companion-test-token';
  delete process.env.CODEX_BRIDGE_TOTP_SECRET;
  let profileReads=0;
  const config={projects:[],outboxEnabled:false,voiceEnabled:false,desktopLiveDiagnostics:false,
    logger:new DiagnosticLogger({root}),deviceRegistryPath:path.join(root,'devices.json'),
    companionService:{async getProfile(){profileReads++;return {profile:{id:'p',roomId:'r',name:'Bear',avatarUrl:null}};},
      async getMessages(){return {entries:[],nextCursor:null};}}};
  const {server}=createApp({config,adapter:new MockCodexAdapter()});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'X-Codex-Bridge-Token':'companion-test-token'};
  try {
    assert.equal((await fetch(`${base}/companion/profile`)).status,401);
    assert.equal(profileReads,0);
    const response=await fetch(`${base}/companion/profile`,{headers});
    assert.equal(response.status,200);
    assert.equal((await response.json()).profile.name,'Bear');
    assert.equal(profileReads,1);
    assert.equal((await fetch(`${base}/companion/messages?profileId=p&roomId=r`,{headers})).status,200);
    assert.equal((await fetch(`${base}/companion/messages`,{method:'POST',headers,body:'{}'})).status,405);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if(oldToken===undefined)delete process.env.CODEX_BRIDGE_TOKEN;else process.env.CODEX_BRIDGE_TOKEN=oldToken;
    if(oldOtp===undefined)delete process.env.CODEX_BRIDGE_TOTP_SECRET;else process.env.CODEX_BRIDGE_TOTP_SECRET=oldOtp;
  }
});
