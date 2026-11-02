import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const root='HarmonyCodexRemote/entry/src/main/ets/';
const index=fs.readFileSync(root+'pages/Index.ets','utf8');
const service=['OptimisticMessageService.ets','SessionActivityPresentation.ets','SessionTimeline.ets','SessionRenderWindow.ets','SessionLiveEntries.ets'].map(name=>fs.readFileSync(root+'services/'+name,'utf8').replace(/^import .*;\s*$/gm,'').replaceAll('export ','')).join('\n');
function method(name){const start=index.search(new RegExp(`^  private (?:async )?${name}\\(`,'m'));assert.ok(start>=0,name);let end=index.indexOf('{',start)+1, depth=1;while(depth){if(index[end]==='{')depth++;if(index[end]==='}')depth--;end++;}return index.slice(start,end);}
function setup(){const context=vm.createContext({});vm.runInContext(stripTypeScriptTypes(`${service}\nclass Page { ${['handoffPendingSessionSend','rememberPendingSessionSend','recordSessionInputAcknowledgements','beginOptimisticSessionSend','acknowledgeOptimisticSessionSend','reconcileVisibleSessionMessages','visibleOptimisticSessionMessages','taskLiveEntries','sessionEntryKey','sessionTimelineRows','allSessionTimelineRows','failedSessionMessageHasCanonicalEntry','updateFailedSessionMessageNextRetryAt'].map(method).join('\n')} } globalThis.Page=Page;`),context);const p=new context.Page();p.currentSessionDraftScope=()=>null;Object.assign(p,{sessionTimelineStartKey:'',optimisticSessionMessages:[],sessionStreamEntries:[],pendingSessionSendsByTaskId:{},selectedSession:{id:'thread',entries:[]},canonicalKey:context.stableCanonicalMessageKey,failedSessionMessages:[],selectedVisibleTask:()=>null,visibleNewSessionEntries:()=>[],visibleSessionEntries:()=>[],visibleFailedSessionMessages:()=>[],isNewSessionDraft:false,newSessionTaskId:'',log(){},scrollSessionToBottom(){},taskSessionId:t=>t.codexSessionId||'',taskIsFailedMessageRetry:()=>false,isSubmittedOutboxReceipt:()=>true,streamingAgentTextForTask:()=>'',sessionAssistantHeaderStatus:()=>'',workingStatusTextForTask:()=>'',serverUserHistoryCoversTaskMessage:()=>false});return p;}
function begin(p,id,text='hello'){p.beginOptimisticSessionSend('thread',false,'project',id,text,[],[],'');}
function acknowledge(p,id,text='hello'){const t={id:'shared-task',codexSessionId:'thread',activeCodexTurnId:'turn',status:'submitted',prompt:text,createdAt:new Date().toISOString(),events:[]};p.acknowledgeOptimisticSessionSend(id,t,text);return t;}
test('each submission stays visible across a shared task being steered twice until its own official user record arrives',()=>{
 const p=setup();begin(p,'one','first');assert.equal(p.visibleOptimisticSessionMessages().length,1);
 const first=acknowledge(p,'one','first');assert.equal(p.taskLiveEntries(first).filter(e=>e.role==='user').length,0);
 begin(p,'two','second');const second=acknowledge(p,'two','second');
 assert.deepEqual(Array.from(p.visibleOptimisticSessionMessages(),m=>m.text),['first','second']);
 assert.equal(p.taskLiveEntries(second).filter(e=>e.role==='user').length,0);
 p.selectedSession={id:'other',entries:[]};p.reconcileVisibleSessionMessages();assert.equal(p.visibleOptimisticSessionMessages().length,0);
 p.selectedSession={id:'thread',entries:[{role:'user',type:'response_item',text:'first',timestamp:new Date(Date.now()+1000).toISOString(),turnId:'turn',itemId:'u1'}]};p.reconcileVisibleSessionMessages();
 assert.deepEqual(Array.from(p.visibleOptimisticSessionMessages(),m=>m.text),['second']);
 p.selectedSession.entries.push({role:'user',type:'response_item',text:'second',timestamp:new Date(Date.now()+2000).toISOString(),turnId:'turn',itemId:'u2'});p.reconcileVisibleSessionMessages();
 assert.equal(p.visibleOptimisticSessionMessages().length,0);
});
test('history arriving before receipt retires only that submission and retains identical newer drafts',()=>{
 const p=setup();begin(p,'one');const time=new Date(Date.now()+1000).toISOString();p.selectedSession.entries=[{role:'user',type:'response_item',text:'hello',timestamp:time,itemId:'u1'}];p.reconcileVisibleSessionMessages();assert.equal(p.optimisticSessionMessages.length,1);acknowledge(p,'one');assert.equal(p.optimisticSessionMessages.length,0);
 begin(p,'two');acknowledge(p,'two');assert.equal(p.optimisticSessionMessages.length,1);
});
test('message updates retain timeline and scroll anchor identity while carrying the new body',()=>{
 const p=setup();const a={timestamp:'2026-10-31T00:00:00Z',type:'assistant_message',role:'assistant',threadId:'thread',itemId:'item',text:'part'},b={...a,text:'part continued'};
 p.visibleSessionEntries=()=>[a];const before=p.sessionTimelineRows()[0];
 p.visibleSessionEntries=()=>[b];const after=p.sessionTimelineRows()[0];
 assert.equal(p.sessionEntryKey(a),p.sessionEntryKey(b));assert.equal(before.key,after.key);
 assert.equal(before.entry.text,'part');assert.equal(after.entry.text,'part continued');
});
test('outbox to live task handoff preserves the local bubble without creating a second user echo',()=>{
 const p=setup();begin(p,'one');
 const queued={id:'outbox-one',codexSessionId:'thread',status:'queued',prompt:'hello',events:[]};
 p.acknowledgeOptimisticSessionSend('one',queued,'hello');
 const live={...queued,id:'live-task',status:'running',activeCodexTurnId:'turn-one'};
 p.handoffPendingSessionSend(queued.id,live);
 assert.equal(p.optimisticSessionMessages[0].taskId,'live-task');
 assert.equal(p.optimisticSessionMessages[0].turnId,'turn-one');
 assert.equal(p.visibleOptimisticSessionMessages().length,1);
 assert.equal(p.taskLiveEntries(live).filter(e=>e.role==='user').length,0);
 p.selectedSession.entries=[{role:'user',type:'response_item',text:'hello',timestamp:new Date(Date.now()+1000).toISOString(),turnId:'turn-one'}];
 p.reconcileVisibleSessionMessages();assert.equal(p.optimisticSessionMessages.length,0);
});

test('dashboard adoption rebinds an outbox echo even when the summary already names the real task',()=>{
 const p=setup();begin(p,'phone-send','hello');
 const queued={id:'outbox-send',codexSessionId:'thread',submissionId:'phone-send',status:'queued',prompt:'hello',events:[]};
 p.acknowledgeOptimisticSessionSend('phone-send',queued,'hello');
 p.pendingSessionSendsByTaskId[queued.id]=[{sessionId:'thread',submissionId:'phone-send',text:'hello',images:[]}];
 const live={...queued,id:'real-task',status:'running',activeCodexTurnId:'turn-one'};
 // Dashboard /tasks exposes the real task, not the outbox id being polled.
 p.handoffPendingSessionSend(live.id,live);
 assert.equal(p.optimisticSessionMessages[0].taskId,live.id);
 assert.equal(p.pendingSessionSendsByTaskId[queued.id],undefined);
 assert.equal(p.pendingSessionSendsByTaskId[live.id][0].submissionId,'phone-send');
 assert.equal(p.taskLiveEntries(live).filter(e=>e.role==='user').length,0);
});

test('matching submission prevents a second live echo before outbox handoff runs',()=>{
 const p=setup();begin(p,'phone-send','hello');
 p.acknowledgeOptimisticSessionSend('phone-send',{id:'outbox-send',codexSessionId:'thread',status:'queued'},'hello');
 const live={id:'real-task',codexSessionId:'thread',submissionId:'phone-send',status:'running',prompt:'hello',createdAt:new Date().toISOString(),events:[]};
 assert.equal(p.taskLiveEntries(live).filter(e=>e.role==='user').length,0);
 // Equal text is insufficient when the submission or target differs.
 assert.equal(p.taskLiveEntries({...live,submissionId:'other-send'}).filter(e=>e.role==='user').length,1);
 assert.equal(p.taskLiveEntries({...live,codexSessionId:'other'}).filter(e=>e.role==='user').length,1);
});

test('new-thread queued receipt without a thread id retains exactly one user bubble',()=>{
 const p=setup();p.isNewSessionDraft=true;p.selectedSession=null;
 p.beginOptimisticSessionSend('__new_session__',true,'project','new-queued','hello',[],[],'');
 const queued={id:'outbox-new',submissionId:'new-queued',status:'queued',runtime:{kind:'durable_outbox',state:'dispatching'},prompt:'hello',createdAt:new Date().toISOString(),events:[]};
 p.acknowledgeOptimisticSessionSend('new-queued',queued,'hello');p.selectedVisibleTask=()=>queued;p.newSessionTaskId=queued.id;
 assert.equal(p.visibleOptimisticSessionMessages().length,1);
 assert.equal(p.taskLiveEntries(queued).filter(e=>e.role==='user').length,0);
 assert.equal(p.taskLiveEntries({...queued,submissionId:'different',id:'different-task'}).filter(e=>e.role==='user').length,1);
});

test('matching new-thread submission owns its echo while the acknowledgement is still arriving',()=>{
 const p=setup();p.isNewSessionDraft=true;p.selectedSession=null;
 p.beginOptimisticSessionSend('__new_session__',true,'project','pending-ack','hello',[],[],'');
 const live={id:'new-real-task',codexSessionId:'created-thread',submissionId:'pending-ack',status:'running',prompt:'hello',createdAt:new Date().toISOString(),events:[]};
 assert.equal(p.taskLiveEntries(live).filter(e=>e.role==='user').length,0);
 assert.equal(p.taskLiveEntries({...live,submissionId:'other'}).filter(e=>e.role==='user').length,1);
});

test('an initial submission id cannot suppress a later different steering prompt',()=>{
 const p=setup();begin(p,'initial','first');
 p.acknowledgeOptimisticSessionSend('initial',{id:'outbox-first',codexSessionId:'thread',status:'queued'},'first');
 const live={id:'shared-task',codexSessionId:'thread',submissionId:'initial',status:'running',prompt:'second',createdAt:new Date().toISOString(),events:[]};
 assert.equal(p.taskLiveEntries(live).filter(e=>e.role==='user').length,1);
});

test('assistant header status changes without changing timeline and scroll anchor identity',()=>{
 const p=setup(), entry={role:'assistant',type:'response_item',timestamp:'2026-10-31T00:00:00Z',threadId:'thread',itemId:'item',text:'正文'};
 p.visibleSessionEntries=()=>[entry];p.sessionAssistantHeaderStatus=()=> '思考中';
 const before=p.sessionTimelineRows()[0], anchor=p.sessionEntryKey(entry);
 assert.equal(p.sessionAssistantHeaderStatus(before.entry),'思考中');
 p.sessionAssistantHeaderStatus=()=> '正在回复';const after=p.sessionTimelineRows()[0];
 assert.equal(p.sessionAssistantHeaderStatus(after.entry),'正在回复');
 assert.equal(after.key,before.key);assert.equal(p.sessionEntryKey(entry),anchor);
});


test('new-session acknowledgement retains its first bubble through the official history gap',()=>{
 const p=setup();p.isNewSessionDraft=true;p.selectedSession=null;
 p.beginOptimisticSessionSend('__new_session__',true,'project','one','hello',[],[],'');
 const task={id:'new-task',codexSessionId:'created-thread',status:'running',prompt:'hello',createdAt:new Date().toISOString(),events:[]};
 p.acknowledgeOptimisticSessionSend('one',task,'hello');p.selectedVisibleTask=()=>task;p.newSessionTaskId=task.id;
 assert.equal(p.visibleOptimisticSessionMessages().length,1);
 assert.deepEqual(Array.from(p.sessionTimelineRows(),row=>row.kind),['optimistic']);
});

test('old matching history and other sessions cannot erase a failed draft with attachments',()=>{
 const p=setup();const original={role:'user',type:'response_item',text:'hello',timestamp:new Date(Date.now()-30000).toISOString(),itemId:'older'};
 p.selectedSession={id:'thread',entries:[original]};const failure={id:'failed',sessionId:'thread',submissionId:'one',text:'hello',isNewSession:false,createdAt:new Date().toISOString(),baselineEntryKeys:[p.canonicalKey(original)],images:[{id:'image'}]};
 p.failedSessionMessages=[failure];assert.equal(p.failedSessionMessageHasCanonicalEntry(failure),false);
 p.selectedSession={id:'other',entries:[{...original,timestamp:new Date().toISOString()}]};
 assert.equal(p.failedSessionMessageHasCanonicalEntry(failure),false);
});

test('retry scheduling preserves canonical identity for an image submission',()=>{
 const p=setup();const failure={id:'failed',sessionId:'thread',submissionId:'one',text:'',isNewSession:false,createdAt:new Date().toISOString(),submittedText:'image input',baselineEntryKeys:['baseline'],turnId:'turn',itemId:'u1',images:[{id:'image'}]};
 p.failedSessionMessages=[failure];p.updateFailedSessionMessageNextRetryAt('failed','later');
 for(const field of ['submittedText','baselineEntryKeys','turnId','itemId'])assert.deepEqual(p.failedSessionMessages[0][field],failure[field]);
});

test('running task does not recreate an echo covered by official history',()=>{
 const p=setup();p.serverUserHistoryCoversTaskMessage=()=>true;
 const task={id:'task',codexSessionId:'thread',status:'running',prompt:'hello',createdAt:new Date().toISOString(),events:[]};
 assert.equal(p.taskLiveEntries(task).filter(entry=>entry.role==='user').length,0);
});
