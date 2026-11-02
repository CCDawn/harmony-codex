import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { EventBus } from '../src/eventBus.js';
import { openTaskEventStream } from '../src/taskEventStream.js';

const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const index = fs.readFileSync(root + 'pages/Index.ets', 'utf8');
function method(name) {
  const start = index.search(new RegExp(`^  private (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  let end = index.indexOf('{', start) + 1, depth = 1;
  while (depth) { if (index[end] === '{') depth++; if (index[end] === '}') depth--; end++; }
  return index.slice(start, end);
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'condition should be reached');
}
async function setup(t) {
  const eventBus = new EventBus();
  const task = {id:'task-1',projectId:'p',prompt:'fixture',status:'running',createdAt:'2026-10-21',updatedAt:'2026-10-21',events:[]};
  let ended = false;
  let connections = 0;
  let snapshotReads = 0;
  const server = http.createServer((request, response) => {
    response.on('finish', () => {ended = true;});
    openTaskEventStream({request, response, eventBus, sourceId:task.id, getSnapshot:()=>task});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const code = ['SseParser.ets','BridgeEventStream.ets','TaskStreamState.ets','SessionStreamPresentation.ets','StreamUiBatch.ets'].map(file =>
    fs.readFileSync(root + 'services/' + file, 'utf8').replace(/^import .*;\s*$/gm,'').replaceAll('export ', '')).join('\n');
  const context = vm.createContext({
    http: {RequestMethod:{GET:'GET'}, createHttp() {
      connections++;
      const handlers = {}, controller = new AbortController();
      return {on(name, callback) {handlers[name] = callback;}, destroy() {controller.abort();},
        async requestInStream(url, options) {
          const response = await fetch(url,{headers:options.header,signal:controller.signal});
          handlers.headersReceive(Object.fromEntries(response.headers));
          const reader = response.body.getReader();
          while (true) {const chunk = await reader.read(); if(chunk.done)break;
            const value = chunk.value;
            handlers.dataReceive(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));}
          handlers.dataEnd(); return response.status;
        }};
    }},
    util:{TextDecoder:class {decoder=new TextDecoder();decodeWithStream(bytes,options){return this.decoder.decode(bytes,options);}}},
    CredentialRuntime:{getRuntimeTotpSecret:()=>''},TotpGenerator:{async currentCode(){return '';}},
    setTimeout,clearTimeout
  });
  vm.runInContext(stripTypeScriptTypes(code+`\nclass Page {${['stopTaskEventStream','syncTaskEventStream','recoverTaskEventStream'].map(method).join('\n')}}
    globalThis.Page=Page; globalThis.text=latestSessionStreamText;`),context);
  const page = Object.assign(new context.Page(),{currentTask:{...task,events:[]},selectedSession:{id:'thread'},companionSelected:false,
    taskEventStream:null,taskEventStreamKey:'',taskEventStreamHealthy:false,taskStreamRecovering:false,bridgeToken:'fixture',
    normalizedBridgeUrl:()=>base,isTaskRunningStatus:s=>s==='running',isSubmittedOutboxReceipt:()=>false,syncSessionEventStream(){},
    taskSessionId:()=> 'thread',taskUsesCodexRunApi:()=>false,
    readSessionNavigation:()=>({revision:1,mode:'session',sessionId:'thread'}),activeTab:'sessions',
    currentTaskEventCursor:task=>task?.eventCursor??0,scrollSessionToBottomIfFollowing(){},log(){},logTaskStreamPresentation(){},
    async refreshTask(){snapshotReads++;this.currentTask={...task,events:task.events.slice(),eventCursor:task.events.length};}
  });
  t.after(async()=>{page.stopTaskEventStream();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const publish=(type,payload={})=>{const event={id:`event-${task.events.length+1}`,seq:task.events.length+1,taskId:task.id,type,payload,createdAt:new Date().toISOString()};task.events.push(event);eventBus.publish(task.id,event);return event;};
  return {page,task,eventBus,publish,text:()=>context.text(page.currentTask.events),ended:()=>ended,connections:()=>connections,
    snapshotReads:()=>snapshotReads};
}

test('queued durable outbox receipts never subscribe before handoff to a real task', async t=>{
  const h=await setup(t);h.page.currentTask.runtime={kind:'durable_outbox'};
  h.page.currentTask.status='running';h.page.syncTaskEventStream();await delay(20);
  assert.equal(h.connections(),0);
  delete h.page.currentTask.runtime;h.page.syncTaskEventStream();await until(()=>h.page.taskEventStreamHealthy);
  assert.equal(h.connections(),1);
});

test('tool deltas and item notifications do not flood snapshot recovery or delay assistant deltas', async t=>{
  const h=await setup(t);h.page.syncTaskEventStream();await until(()=>h.page.taskEventStreamHealthy);
  for(let i=0;i<100;i++) {
    h.publish('codex.desktop_live.notification',{
      method:'item/commandExecution/outputDelta',params:{delta:'fixture output'}});
    // Keep this assertion about metadata recovery, independently of the server's
    // intentionally bounded backpressure/reconnect policy.
    if(i%10===9)await until(()=>h.page.currentTask.eventCursor===i+1);
  }
  h.publish('codex.desktop_live.notification',{method:'item/started',params:{item:{id:'a',type:'agentMessage'}}});
  for(const delta of ['逐','字','显','示']) {
    h.publish('codex.desktop_live.notification',{method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta}});
    await until(()=>h.text().endsWith(delta));
  }
  h.publish('codex.desktop_live.notification',{method:'item/completed',params:{turnId:'t',item:{id:'a',type:'agentMessage',text:'逐字显示'}}});
  await until(()=>h.page.currentTask.eventCursor===106);
  assert.equal(h.snapshotReads(),0);assert.equal(h.text(),'逐字显示');
  assert.ok(Date.parse(h.page.currentTask.updatedAt)>Date.parse(h.task.updatedAt));
  h.task.status='completed';h.publish('task.completed');
  await until(()=>h.page.currentTask.status==='completed');assert.equal(h.snapshotReads(),1);
});

test('actual backend frames update the phone display before completion, then reconcile terminal metadata once', async t=>{
  const h=await setup(t);h.page.syncTaskEventStream();await until(()=>h.page.taskEventStreamHealthy);
  h.publish('codex.app_server.notification',{method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta:'你'}});
  await until(()=>h.text()==='你');assert.equal(h.ended(),false);
  h.publish('codex.app_server.notification',{method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta:'好'}});
  await until(()=>h.text()==='你好');assert.equal(h.page.currentTask.events.length,2);
  h.task.status='completed';h.publish('task.completed');
  await until(()=>h.page.currentTask.status==='completed'&&h.page.taskEventStream===null);
  assert.equal(h.page.currentTask.eventCursor,3);assert.equal(h.text(),'你好');
});

test('changing the visible conversation cancels its subscription and cannot deliver late text into the new page',async t=>{
  const h=await setup(t);h.page.syncTaskEventStream();await until(()=>h.page.taskEventStreamHealthy);
  h.page.selectedSession={id:'other'};h.page.syncTaskEventStream();
  await until(()=>h.eventBus.listeners.size===0);
  h.publish('codex.app_server.notification',{method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta:'late'}});
  await delay(10);assert.equal(h.text(),'');assert.equal(h.page.taskEventStream,null);
});

test('terminal snapshot failure leaves recovery to bounded polling instead of reconnecting in a loop', async t=>{
  const h=await setup(t);h.task.status='completed';let reads=0;
  h.page.refreshTask=async()=>{reads++;throw new Error('fixture offline');};
  h.page.syncTaskEventStream();await until(()=>reads===1);
  await delay(20);
  for(let i=0;i<5;i++)h.page.syncTaskEventStream();
  assert.equal(reads,1);assert.equal(h.connections(),1);
  assert.equal(h.page.taskStreamRepairId,h.task.id);
  assert.equal(h.page.taskEventStream,null);
});
