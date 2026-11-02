import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createApp} from '../src/app.js';
import {DiagnosticLogger} from '../src/diagnosticLogger.js';
const threadId='11111111-1111-1111-1111-111111111111';
test('desktop view route authenticates and streams real deltas using a bounded official turn page, without submitting a task',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-view-route-'));
 const oldToken=process.env.CODEX_BRIDGE_TOKEN,oldOtp=process.env.CODEX_BRIDGE_TOTP_SECRET;
 process.env.CODEX_BRIDGE_TOKEN='fixture-session-token';delete process.env.CODEX_BRIDGE_TOTP_SECRET;
 t.after(()=>{if(oldToken===undefined)delete process.env.CODEX_BRIDGE_TOKEN;else process.env.CODEX_BRIDGE_TOKEN=oldToken;
  if(oldOtp===undefined)delete process.env.CODEX_BRIDGE_TOTP_SECRET;else process.env.CODEX_BRIDGE_TOTP_SECRET=oldOtp;});
 let subscriber,reads=0,stops=0;
 const cdp={startNotificationPolling(id,events,emit){assert.equal(id,threadId);subscriber=emit;return{stop(){stops++;}};},
  client:{async readRetainedNotifications(id){assert.equal(id,threadId);return[];},async request(method,params){
   assert.equal(method,'thread/turns/list');assert.deepEqual(params,{threadId,limit:1,itemsView:'full'});reads++;
   return{data:[{id:'turn',status:'inProgress',items:[]}]};}}};
 const adapter={cdpDesktopAdapter:cdp,run(){assert.fail('Viewing a thread must never create a task');}};
 const {server,store,logger}=createApp({config:{projects:[],repoRoot:root,outboxEnabled:false,appServerRuntimeMode:'desktop',desktopLiveDiagnostics:false,
  deviceRegistryPath:path.join(root,'devices.json'),logger:new DiagnosticLogger({root})},adapter});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 let controller;
 t.after(async()=>{
  controller?.abort();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await logger.writeChain;await logger.flushAnalysis();
  await fs.rm(root,{recursive:true,force:true});
 });
 const url=`http://127.0.0.1:${server.address().port}/api/codex/threads/${threadId}/events`;
 assert.equal((await fetch(url)).status,401);assert.equal(reads,0);
 controller=new AbortController();
 const response=await fetch(url,{headers:{'x-codex-bridge-token':'fixture-session-token'},signal:controller.signal});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
 for(let i=0;i<100&&reads===0;i++)await delay(5);await delay(10);
 assert.equal(reads,1);
 const notify=(id,method,params)=>subscriber('codex.desktop_live.notification',{notificationId:id,method,params:{threadId,turnId:'turn',...params}});
 notify('fixture:1','item/started',{item:{id:'assistant',type:'agentMessage',text:''}});
 notify('fixture:2','item/agentMessage/delta',{itemId:'assistant',delta:'逐'});
 notify('fixture:3','item/agentMessage/delta',{itemId:'assistant',delta:'字显示'});
 const reader=response.body.getReader(),decoder=new TextDecoder();let raw='';
 while(!raw.includes('逐字显示')){const next=await Promise.race([reader.read(),delay(2000).then(()=>{throw Error('No partial session frame');})]);
  assert.equal(next.done,false);raw+=decoder.decode(next.value,{stream:true});}
 assert.match(raw,/session.message/);assert.equal(store.listTasks().length,0);
 controller.abort();for(let i=0;i<100&&stops===0;i++)await delay(5);assert.equal(stops,1);
});
