import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
const root='HarmonyCodexRemote/entry/src/main/ets/';
const index=fs.readFileSync(root+'pages/Index.ets','utf8');
function method(name){const start=index.search(new RegExp(`^  private (?:async )?${name}\\(`,'m'));assert.ok(start>=0);
 const end=index.indexOf('\n  }',start)+4;return index.slice(start,end);}
const services=['SessionLiveEntries.ets','StreamUiBatch.ets'].map(file=>fs.readFileSync(root+'services/'+file,'utf8')
 .replace(/^import .*;\s*$/gm,'').replaceAll('export ','')).join('\n');
function setup(){const connections=[];const logs=[];class Stream{constructor(options){this.options=options;this.stopped=false;connections.push(this);}start(){this.stopped=false;this.options.onState('open');}stop(){this.stopped=true;}isRunning(){return !this.stopped;}}
 const c=vm.createContext({BridgeEventStream:Stream,setTimeout,clearTimeout});vm.runInContext(stripTypeScriptTypes(services+'\nclass Page {'+
  ['stopSessionEventStream','sessionStreamDiagnosticMatch','syncSessionEventStream','refreshSessionEventHistory','appForegroundChanged'].map(method).join('\n')+'}\nglobalThis.Page=Page;globalThis.mergeSessionLiveEntries=mergeSessionLiveEntries;'),c);
 const page=Object.assign(new c.Page(),{selectedSession:{id:'s',entries:[]},currentTask:null,appForeground:true,activeTab:'sessions',
  companionSelected:false,isNewSessionDraft:false,sessionStreamEntries:[],bridgeToken:'pair-one',sessionEventStream:null,
  sessionEventStreamKey:'',sessionStreamDiagnosticAt:0,sessionAutoFollowBottom:true,sessionStreamRefreshing:false,taskEventStream:null,companionEventStream:null,
  syncTaskEventStream(){this.syncSessionEventStream();},syncPushRegistration(){},async refreshDashboard(){},
  async refreshContinueStatus(){},syncRuntimeEventStream(){},async applyPendingNotificationNavigation(){this.notificationNavigationAttempts=(this.notificationNavigationAttempts??0)+1;},
  normalizedBridgeUrl:()=> 'https://fixture.test/bridge',taskSessionId:t=>t.codexSessionId,isTaskRunningStatus:s=>s==='running',selectedVisibleTask(){return this.currentTask;},
  readSessionNavigation(){return{revision:1,mode:'session',sessionId:this.selectedSession?.id??''};},
  // This stream harness does not render UI; use the real read-only live/history merge,
  // leaving UI-only normalization to the separate presentation tests.
  visibleSessionEntries(){return c.mergeSessionLiveEntries(this.selectedSession.entries,this.sessionStreamEntries,this.selectedSession.id);},
  scrollSessionToBottomIfFollowing(){},log(level,event,details){logs.push({level,event,details});},async refreshSelectedSessionDetail(){this.reads=(this.reads??0)+1;}});
 const frame=(stream,text,extra={})=>stream.options.onFrame({event:'session.message',data:JSON.stringify({entry:{threadId:'s',turnId:'t',itemId:'a',
  text,role:'assistant',timestamp:'2026-10-22T01:00:00Z',liveKind:'streaming',...extra}})});
 return{page,connections,frame,logs};}
test('a desktop-originated conversation streams without creating a phone task',()=>{
 const h=setup();h.page.syncSessionEventStream();assert.equal(h.page.currentTask,null);assert.equal(h.connections.length,1);
 const s=h.connections[0];assert.match(s.options.url,/\/threads\/s\/events$/);assert.equal(s.options.cursorEnabled,false);
 h.frame(s,'逐');h.frame(s,'逐字');h.frame(s,'逐字显示');
 h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.sessionStreamEntries.length,1);assert.equal(h.page.sessionStreamEntries[0].text,'逐字显示');
 assert.equal(h.page.sessionStreamEntries[0].type,'live_agent_streaming');
 const sample=h.logs.find(log=>log.event==='session.stream.message');assert.ok(sample);
 assert.match(sample.details,/committedLength=1/);assert.match(sample.details,/historyLength=-1/);assert.match(sample.details,/visibleLength=1/);
 assert.doesNotMatch(sample.details,/逐/);
 h.page.sessionStreamDiagnosticAt=0;
 h.frame(s,'逐字显示',{liveKind:'completed'});assert.equal(h.page.sessionStreamEntries[0].type,'agentMessage');
 const terminal=h.logs.filter(log=>log.event==='session.stream.message').at(-1);
 assert.match(terminal.details,/committedLength=4/);assert.match(terminal.details,/visibleLength=4/);assert.match(terminal.details,/committedPhase=completed/);
 assert.doesNotMatch(terminal.details,/逐/);
});
test('navigation and pairing changes release the old stream and reject all late frames',()=>{
 const h=setup();h.page.syncSessionEventStream();const old=h.connections[0];h.frame(old,'old');
 h.page.bridgeToken='changed-before-resync';h.frame(old,'untrusted late text');
 assert.equal(h.page.sessionStreamEntries[0].text,'old');
 h.page.selectedSession={id:'other',entries:[]};h.page.syncSessionEventStream();assert.equal(old.stopped,true);
 h.frame(old,'late');assert.equal(h.page.sessionStreamEntries.length,0);
 h.page.selectedSession={id:'s',entries:[]};h.page.bridgeToken='pair-two';h.page.syncSessionEventStream();
 h.frame(old,'old identity');assert.equal(h.page.sessionStreamEntries.length,0);
});
test('reconnection retains a longer displayed stream until a new snapshot catches up',()=>{
 const h=setup();h.page.syncSessionEventStream();const s=h.connections[0];
 h.frame(s,'已显示的完整前缀');s.options.onReconnect();
 h.frame(s,'已显示');h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.visibleSessionEntries()[0].text,'已显示的完整前缀');
 h.frame(s,'已显示的完整前缀后续');h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.visibleSessionEntries()[0].text,'已显示的完整前缀后续');
 h.frame(s,'最终结果',{liveKind:'completed'});
 assert.equal(h.page.visibleSessionEntries()[0].text,'最终结果');
});

test('a live Codex subscription continues receiving while the application is in the background',()=>{
 const h=setup();h.page.syncSessionEventStream();const stream=h.connections[0];
 h.page.appForeground=false;h.page.syncSessionEventStream();
 assert.equal(stream.stopped,false);
 h.frame(stream,'background output');h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.sessionStreamEntries[0].text,'background output');
 h.page.appForeground=true;h.page.syncSessionEventStream();
 assert.equal(h.connections.length,1);
});

test('returning foreground replaces an auth-stopped owner, preserves text and rejects its late frames',()=>{
 const h=setup();h.page.syncSessionEventStream();const old=h.connections[0];h.frame(old,'existing prefix');
 old.stop();h.page.appForeground=false;h.page.appForegroundChanged();assert.equal(h.connections.length,1);
 h.page.appForeground=true;h.page.appForegroundChanged();assert.equal(h.connections.length,2);
 assert.equal(h.page.notificationNavigationAttempts,1,'foreground also processes a pending notification without waiting for dashboard cadence');
 assert.equal(h.page.sessionStreamEntries[0].text,'existing prefix');
 h.frame(old,'late invalid body');h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.sessionStreamEntries[0].text,'existing prefix');
 h.frame(h.connections[1],'existing prefix continued');h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.sessionStreamEntries[0].text,'existing prefix continued');
 h.page.appForegroundChanged();assert.equal(h.connections.length,2);
});

test('late SSE and queued batches cannot resurrect an item retired by a full terminal turn',()=>{
 const h=setup();h.page.syncSessionEventStream();const s=h.connections[0];
 h.frame(s,'old body',{itemId:'old'});
 h.page.selectedSession.sync={source:'desktop-official',completedTurnIds:['t']};
 h.page.selectedSession.entries=[{threadId:'s',turnId:'t',itemId:'new',role:'assistant',text:'canonical final',liveKind:'completed'}];
 h.frame(s,'late old body',{itemId:'old',liveKind:'completed'});
 assert.equal(h.page.sessionStreamEntries.length,0);
 assert.deepEqual(h.page.visibleSessionEntries().map(e=>e.text),['canonical final']);
 h.frame(s,'queued late body',{itemId:'orphan'});h.page.sessionStreamUiBatch.flush();
 assert.equal(h.page.sessionStreamEntries.length,0);
});
test('a matching phone task takes over text, while outbox receipts and other tasks do not suppress desktop updates',()=>{
 const h=setup();h.page.syncSessionEventStream();const s=h.connections[0];
 h.page.currentTask={status:'running',codexSessionId:'other'};h.page.syncSessionEventStream();assert.equal(h.connections.length,1);
 h.page.currentTask={status:'running',codexSessionId:'s',runtime:{kind:'durable_outbox'}};h.page.syncSessionEventStream();assert.equal(h.connections.length,1);
 delete h.page.currentTask.runtime;h.page.syncSessionEventStream();assert.equal(s.stopped,true);assert.equal(h.page.sessionEventStream,null);
 h.page.currentTask=null;h.page.syncSessionEventStream();assert.equal(h.connections.length,2);
});
test('companion navigation releases its old subscription while background Codex subscriptions stay active',async()=>{
 const h=setup();h.page.syncSessionEventStream();const s=h.connections[0];
 let finish;h.page.refreshSelectedSessionDetail=()=>new Promise(resolve=>{finish=resolve;h.page.reads=(h.page.reads??0)+1;});
 s.options.onFrame({event:'session.invalidate'});s.options.onFrame({event:'session.invalidate'});assert.equal(h.page.reads,1);finish();
 await new Promise(resolve=>setImmediate(resolve));h.page.companionSelected=true;h.page.syncSessionEventStream();assert.equal(s.stopped,true);
 h.page.companionSelected=false;h.page.appForeground=false;h.page.syncSessionEventStream();assert.equal(h.connections.length,2);
 assert.equal(h.connections[1].stopped,false);
});

test('official running tools render immediately and update status without becoming assistant text',()=>{
 const h=setup();h.page.syncSessionEventStream();const stream=h.connections[0];
 const tool={role:'tool',type:'tool_call',itemId:'exec-live',toolItems:[{id:'exec-live',name:'commandExecution',verb:'Ran',target:'Start-Sleep -Seconds 50',status:'running'}]};
 h.frame(stream,'Start-Sleep -Seconds 50',tool);
 assert.equal(h.page.visibleSessionEntries().length,1);
 assert.equal(h.page.visibleSessionEntries()[0].type,'tool_call');
 assert.equal(h.page.visibleSessionEntries()[0].toolItems[0].status,'running');
 h.frame(stream,'Start-Sleep -Seconds 50',{...tool,type:'tool_result',liveKind:'completed',toolItems:[{...tool.toolItems[0],status:'completed',detail:'DONE'}]});
 assert.equal(h.page.visibleSessionEntries().length,1);
 assert.equal(h.page.visibleSessionEntries()[0].toolItems[0].status,'completed');
 h.frame(stream,'Start-Sleep -Seconds 50',tool);
 assert.equal(h.page.visibleSessionEntries()[0].toolItems[0].status,'completed','late start cannot revive the completed item');
 h.frame(stream,'not a projected tool',{...tool,itemId:'invalid',toolItems:[]});
 h.frame(stream,'untrusted user entry',{role:'user',itemId:'user'});
 assert.equal(h.page.visibleSessionEntries().length,1);
 h.page.stopSessionEventStream();
});
