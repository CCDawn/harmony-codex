import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const code=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SessionLiveEntries.ets','utf8')
  .replace(/^import .*;\s*$/gm,'').replaceAll('export ','');
const c=vm.createContext({});
vm.runInContext(stripTypeScriptTypes(code+'\nglobalThis.api={upsertSessionLiveEntry,mergeSessionLiveEntries,mergeOfficialSessionEntryPages,pruneSessionLiveEntries:typeof pruneSessionLiveEntries === "function" ? pruneSessionLiveEntries : undefined};'),c);
const {upsertSessionLiveEntry:upsert,mergeSessionLiveEntries:merge}=c.api;
const entry=(text,extra={})=>({threadId:'s',turnId:'t',itemId:'a',role:'assistant',type:'live_agent_streaming',
  text,timestamp:'2026-10-22T01:00:00Z',liveKind:'streaming',...extra});
test('successive complete item snapshots replace one bubble and a stale history page cannot roll it back',()=>{
  let live=upsert([],entry('你'));live=upsert(live,entry('你好'));live=upsert(live,entry('你好，世界'));
  assert.equal(live.length,1);assert.equal(live[0].text,'你好，世界');
  assert.equal(merge([entry('你好')],live,'s')[0].text,'你好，世界');
  const canonical=entry('你好，世界',{type:'response_item',liveKind:undefined});
  assert.equal(merge([canonical],live,'s').length,1);
  assert.equal(merge([canonical],live,'s')[0],canonical);
});
test('terminal text wins over a late partial and official identities distinguish identical answers',()=>{
  let live=upsert([],entry('final',{liveKind:'completed'}));
  live=upsert(live,entry('late'));assert.equal(live[0].text,'final');
  live=upsert(live,entry('final',{itemId:'b'}));assert.equal(live.length,2);
  assert.equal(merge([entry('final',{itemId:'different'})],live,'s').length,3);
  assert.equal(merge([],live,'another').length,0);
});
test('reconnecting with an older streaming snapshot does not erase an observed prefix',()=>{
  let live=upsert([],entry('streamed prefix and more'));
  live=upsert(live,entry('streamed prefix'));
  assert.equal(live[0].text,'streamed prefix and more');
  live=upsert(live,entry('streamed prefix and more again'));
  assert.equal(live[0].text,'streamed prefix and more again');
  live=upsert(live,entry('different body'));
  assert.equal(live[0].text,'different body');
  live=upsert(live,entry('authoritative correction',{liveKind:'completed'}));
  assert.equal(live[0].text,'authoritative correction');
  live=upsert(live,entry('other turn',{turnId:'other'}));
  assert.equal(live.length,2);
});
test('legacy history can cover the current answer but an older repeated answer cannot swallow it',()=>{
  const live=entry('same');const legacy=entry('same',{itemId:undefined,turnId:undefined,threadId:undefined});
  assert.equal(merge([legacy],[live],'s').length,1);
  assert.equal(merge([{...legacy,timestamp:'2026-10-21T00:00:00Z'}],[live],'s').length,2);
  assert.equal(merge([entry('same',{turnId:'old'})],[live],'s').length,2);
});

test('complete official turns replace in place across streaming, tools, inserted user messages and terminal refresh',()=>{
  const mergePages=c.api.mergeOfficialSessionEntryPages;
  const message=(id,text,extra={})=>entry(text,{itemId:id,syncId:`official:${id}`,liveKind:'completed',...extra});
  const old=message('old','same',{turnId:'old-turn'});
  let history=[old,message('first','prefix')];
  let live=upsert([],message('first','prefix growing',{liveKind:'streaming'}));
  assert.equal(merge(history,live,'s').filter(e=>e.itemId==='first').length,1);
  const tools=Array.from({length:80},(_,i)=>message(`cmd-${i}`,'command',{role:'tool',type:'tool_result'}));
  const full=[message('first','prefix growing'),...tools,message('steered','follow-up',{role:'user'}),message('second','same')];
  history=mergePages(history,full);
  live=upsert(live,message('second','same',{liveKind:'completed'}));
  const visible=merge(history,live,'s');
  assert.deepEqual(Array.from(visible,e=>e.itemId),['old','first',...tools.map(e=>e.itemId),'steered','second']);
  assert.equal(visible.filter(e=>e.text==='same').length,2,'different official messages with equal text are retained');
  assert.equal(visible.filter(e=>e.role==='tool').length,80);
  assert.equal(mergePages(history,full).length,history.length,'replaying a complete page is idempotent');
});

test('completed official content wins over a late live body and keeps question text',()=>{
  const canonical=entry('Choose\nA\nB',{type:'agentMessage',liveKind:'completed'});
  const late=entry('Choose',{liveKind:'completed'});
  assert.equal(merge([canonical],[late],'s')[0],canonical);
});

test('full terminal turn hides the 5133-character orphan while preserving the 5593-character canonical answer',()=>{
  const previous=entry('x'.repeat(5133),{itemId:'old-id',liveKind:'completed'});
  const final=entry('x'.repeat(5593),{itemId:'new-id',type:'agentMessage',liveKind:'completed',syncId:'official:new'});
  const steered=entry('follow up',{itemId:'user-id',role:'user',type:'userMessage',liveKind:undefined});
  const live=[previous,entry('x'.repeat(5000),{itemId:'new-id'})];
  const rows=merge([steered,final],live,'s',['t']);
  assert.deepEqual(Array.from(rows,e=>e.itemId),['user-id','new-id']);
  assert.equal(rows[1].text.length,5593);
  assert.equal(rows[1],final);
  // A late terminal or streaming event for the old ID cannot revive the orphan.
  for(const late of [previous,{...previous,liveKind:'streaming'}]) {
    assert.deepEqual(Array.from(merge([steered,final],upsert(live,late),'s',['t']),e=>e.itemId),['user-id','new-id']);
  }
});

test('terminal turn cleanup is scoped to thread and turn and preserves uncovered, active and unidentified live entries',()=>{
  const terminal=entry('complete',{itemId:'settled',liveKind:'completed'});
  const active=entry('still writing',{itemId:'active',turnId:'active-turn'});
  const other=entry('other thread',{itemId:'other',threadId:'other'});
  const missing=entry('unknown turn',{itemId:'unknown',turnId:undefined});
  const pending=[terminal,active,other,missing];
  assert.equal(typeof c.api.pruneSessionLiveEntries,'function');
  assert.deepEqual(Array.from(c.api.pruneSessionLiveEntries(pending,'s',['t']),e=>e.itemId),['active','other','unknown']);
  assert.deepEqual(Array.from(c.api.pruneSessionLiveEntries(pending,'s',[]),e=>e.itemId),['settled','active','other','unknown']);
  assert.deepEqual(Array.from(c.api.pruneSessionLiveEntries(pending,'', ['t']),e=>e.itemId),['settled','active','other','unknown']);
  assert.deepEqual(Array.from(merge([],pending,'s',['t']),e=>e.itemId),['active','unknown']);
  assert.deepEqual(Array.from(merge([],pending,'s',[]),e=>e.itemId),['settled','active','unknown']);
});

test('terminal snapshot retains each official commentary even when content is identical',()=>{
  const one=entry('same',{itemId:'one',liveKind:'completed'});
  const two=entry('same',{itemId:'two',liveKind:'completed'});
  const stale=entry('same',{itemId:'discarded',liveKind:'completed'});
  const rows=merge([one,two],[one,two,stale],'s',['t']);
  assert.deepEqual(Array.from(rows,e=>e.itemId),['one','two']);
  assert.equal(rows[0],one);assert.equal(rows[1],two);
});

test('full terminal page can remove an empty turn without touching uncovered or other-thread history',()=>{
  const mergePages=c.api.mergeOfficialSessionEntryPages;
  const previous=[entry('old',{itemId:'old'}),entry('keep',{itemId:'keep',turnId:'uncovered'}),
    entry('other',{itemId:'other',threadId:'other'})];
  const page=[entry('updated',{itemId:'keep',turnId:'uncovered'})];
  assert.deepEqual(Array.from(mergePages(previous,page,['t'],'s'),e=>e.itemId),['keep','other']);
  assert.deepEqual(Array.from(mergePages(previous,page,[],'s'),e=>e.itemId),['old','keep','other']);
  assert.deepEqual(Array.from(mergePages(previous,page,['t'],''),e=>e.itemId),['old','keep','other']);
  assert.deepEqual(Array.from(mergePages(previous,[],['t'],'s'),e=>e.itemId),['keep','other']);
  const terminalWithItems=[entry('final',{itemId:'new',liveKind:'completed'})];
  assert.deepEqual(Array.from(mergePages(previous,terminalWithItems,['t'],'s'),e=>e.itemId),['new','keep','other']);
});

test('official live tools keep identity through status-only updates, history handoff and replay',()=>{
 const running=entry('same command',{role:'tool',type:'tool_call',itemId:'exec',toolItems:[{id:'exec',name:'commandExecution',status:'running'}]});
 const completed={...running,type:'tool_result',liveKind:'completed',toolItems:[{...running.toolItems[0],status:'completed',detail:'output'}]};
 const live=upsert(upsert([],running),completed);
 assert.equal(live.length,1);
 assert.equal(merge([running],live,'s')[0].toolItems[0].status,'completed','a status change does not require different title text');
 assert.equal(upsert(live,running)[0],completed,'late replay cannot revive a terminal tool');
 assert.equal(upsert(live,{...running,liveKind:undefined})[0],completed,'legacy status-only starts cannot revive a terminal tool either');
 assert.equal(merge([completed],[running],'s')[0],completed,'official terminal history owns the settled item');
 const other={...running,itemId:'another',toolItems:[{...running.toolItems[0],id:'another'}]};
 assert.deepEqual(Array.from(merge([],upsert(live,other),'s'),e=>e.itemId),['exec','another'],'identical commands with distinct official IDs remain distinct');
 assert.equal(merge([],live,'s',['t']).length,0,'a full terminal turn retires its live tools');
 assert.equal(merge([],live,'other').length,0,'a tool cannot appear in a different thread');
});
