import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const root='HarmonyCodexRemote/entry/src/main/ets/';
const index=fs.readFileSync(root+'pages/Index.ets','utf8');
function method(name){const start=index.search(new RegExp(`^  private (?:async )?${name}\\(`,'m'));assert.ok(start>=0);return index.slice(start,index.indexOf('\n  }',start)+4);}
const live=fs.readFileSync(root+'services/SessionLiveEntries.ets','utf8').replace(/^import .*;\s*$/gm,'').replaceAll('export ','');
const context=vm.createContext({});
vm.runInContext(stripTypeScriptTypes(live+'\nclass Page {'+['mergeSessionDetailPreservingHistory','sessionDetailWithEntries','mergeSessionEntryPages'].map(method).join('\n')+'}\nglobalThis.Page=Page;'),context);
const page=new context.Page();
const entry=(turnId,itemId,text)=>({threadId:'s',turnId,itemId,text,role:'assistant',type:'agentMessage',syncId:`official:${turnId}:${itemId}`});
const detail=(entries,completedTurnIds)=>({id:'s',entries,entryCount:entries.length,sync:{source:'desktop-official',completedTurnIds}});
const merge=(older,newer)=>page.mergeSessionDetailPreservingHistory(older,newer);

test('an active turn rewrite becomes one official final and retains older pages',()=>{
 const old=entry('older','history','older page');
 const partial=entry('t','superseded','partial before insertion');
 const final=entry('t','final','full answer after insertion');
 const result=merge(detail([old,partial],['older']),detail([final],['t']));
 assert.deepEqual(Array.from(result.entries,e=>e.itemId),['history','final']);
 assert.deepEqual(Array.from(result.sync.completedTurnIds),['older','t']);
});

test('a late active snapshot cannot reopen or erase a settled turn',()=>{
 const final=entry('t','final','final');
 const result=merge(detail([final],['t']),detail([entry('t','old','late active')],[]));
 assert.deepEqual(Array.from(result.entries,e=>e.itemId),['final']);
 assert.deepEqual(Array.from(result.sync.completedTurnIds),['t']);
});

test('a full terminal empty turn removes old display items and keeps its authority',()=>{
 const empty=merge(detail([entry('t','old','old')],[]),detail([],['t']));
 assert.equal(empty.entries.length,0);
 assert.deepEqual(Array.from(empty.sync.completedTurnIds),['t']);
 const later=merge(empty,detail([entry('t','late','late')],[]));
 assert.equal(later.entries.length,0);
 assert.deepEqual(Array.from(later.sync.completedTurnIds),['t']);
});

test('a later detail refresh supersedes an earlier same-session load, including terminal snapshots', async()=>{
 const pending=[];
 const local=vm.createContext({BridgeClient:{getSessionHistoryPage(){return new Promise(resolve=>pending.push(resolve));},getSession(){return new Promise(resolve=>pending.push(resolve));}}});
 vm.runInContext(stripTypeScriptTypes('class Page {'+['beginSessionDetailSnapshotRead','loadSessionDetail','refreshSelectedSessionDetail','isSessionNavigationCurrent'].map(method).join('\n')+'}\nglobalThis.Page=Page;'),local);
 const p=Object.assign(new local.Page(),{selectedSession:detail([entry('t','initial','initial')],['t']),
   sessionDetailSnapshotRevisions:new Map(),sessionDetailRequestSeq:0,sessionDetailRefreshSeq:0,bridgeToken:'token',
   normalizedBridgeUrl:()=>'',readSessionNavigation:()=>({revision:1,mode:'session',sessionId:'s'}),log(){},async refreshDesktopInteractions(){},
   mergeSessionDetailPreservingHistory:merge,reconcileVisibleSessionMessages(){},applySessionActivitySnapshot(){},markSessionRead(){},
   sessionBottomSignature:d=>d.entries.map(e=>e.itemId).join(','),scrollSessionToBottomIfFollowing(){},syncSessionEventStream(){},
   async loadOutbox(){},async loadSessionReasoningEffort(){}});
 const load=p.loadSessionDetail('s');const refresh=p.refreshSelectedSessionDetail();
 pending[1](detail([entry('t','new','newest terminal')],['t']));await refresh;
 pending[0](detail([entry('t','old','older terminal')],['t']));await load;
 assert.equal(p.selectedSession.entries[0].itemId,'new');
});
