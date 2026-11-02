import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
const source=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/SessionActivityPresentation.ets','utf8');
const {sessionActivityOwner:owner,sessionAssistantActivity:status,presentSessionActivities:present,presentSessionEntryContext:withContext,shouldHideSessionActivity:hide}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const assistant={role:'assistant',type:'response_item',text:'正文',timestamp:'t'};
const activity=text=>({role:'system',type:'live_activity',text,timestamp:'t'});
test('adjacent reply progress is represented exactly once in the assistant footer',()=>{
 const entries=[assistant,activity('正在返回内容')];assert.equal(owner(entries,1),0);assert.equal(status(entries,0),'正在回复');
});
test('latest adjacent generic progress wins and streaming without a separate activity still has status',()=>{
 const entries=[assistant,activity('正在思考'),activity('正在返回内容')];assert.equal(status(entries,0),'正在回复');
 assert.equal(status([{...assistant,type:'live_agent_streaming'}],0),'正在回复');
 assert.equal(status([assistant],0),'');
});
test('progress cannot cross a later user message or a tool result',()=>{
 for(const entry of [{role:'user',type:'response_item',text:'新问题'}, {role:'tool',type:'response_item',text:'结果'}]) {
  const entries=[assistant,entry,activity('正在思考')];assert.equal(owner(entries,2),-1);assert.equal(status(entries,0),'');
 }
});
test('tool, approval, error, and unfamiliar statuses remain visible as independent rows',()=>{
 for(const text of ['正在执行命令','等待审批','执行失败','其它状态'])assert.equal(owner([assistant,activity(text)],1),-1);
 assert.equal(owner([activity('正在思考')],0),-1);
});

test('list projection attaches metadata once without mutating canonical history',()=>{
 const entries=[assistant,activity('正在返回内容')]; const projected=present(entries);
 assert.equal(projected[0].footerProgress,'正在回复');assert.equal(projected[1].activityInFooter,true);
 assert.equal(entries[0].footerProgress,undefined);assert.equal(entries[1].activityInFooter,undefined);
 assert.equal(present([assistant])[0],assistant);
});

test('generic status cannot absorb an intervening approval or important operation',()=>{
 for(const text of ['正在执行命令','等待审批','执行失败','请回答是否继续？']) {
  const entries=[assistant,activity(text),activity('正在思考')];
  assert.equal(owner(entries,2),-1);assert.equal(status(entries,0),'');
  assert.equal(hide(present(entries)[1]),false);
 }
});

test('ordinary delivery receipts are hidden while approval requests and user content remain visible',()=>{
 for(const text of ['已发送','已送达','已提交 · 等待确认','已排队','等待连接后发送','消息已进入 Codex 官方会话','已提交 · 正在同步','消息已进入 Codex 官方会话，正在同步会话']) assert.equal(hide(activity(text)),true,text);
 for(const text of ['等待审批','请回答：是否允许执行？','已发送，等待审批','消息已进入 Codex 官方会话，等待审批','已提交 · 正在同步失败','消息已进入 Codex 官方会话，正在同步会话，错误']) assert.equal(hide(activity(text)),false,text);
 assert.equal(hide({...activity('已发送'),role:'user'}),false);
 assert.equal(hide({...assistant,text:'已发送'}),false);
 assert.equal(hide(present([assistant,activity('正在思考')])[1]),true);
});

test('progress cannot attach to a different turn',()=>{
 const entries=[{...assistant,turnId:'a'},{...activity('正在思考'),turnId:'b'}];
 assert.equal(owner(entries,1),-1);assert.equal(status(entries,0),'');
});

test('dispatch confirmation from the screenshot never renders as a separate Codex message',()=>{
 const text='正在确认这条消息是否进入官方会话';
 for(const type of ['live_activity','live_agent_status']) {
  assert.equal(hide({...activity(text),type}),true);
  assert.equal(hide({...activity(text+'，等待审批'),type}),false);
  assert.equal(hide({...activity(text+'，错误'),type}),false);
  assert.equal(hide({...activity(text),type,liveKind:'approval_request'}),false);
 }
 assert.equal(hide({...assistant,text}),false);
});

test('tool data and explicit approval or question kinds remain visible even with generic text',()=>{
 for(const metadata of [{toolItems:[{text:'important operation'}]},{liveKind:'approval_request'},{liveKind:'user_input'},{role:'tool'}]) {
  const operation={...activity('正在思考'),...metadata};
  assert.equal(owner([assistant,operation],1),-1);
  assert.equal(hide({...operation,text:'已发送'}),false);
  assert.equal(status([assistant,operation,activity('正在思考')],0),'');
 }
});

test('processing is a generic footer status and standalone duplicate sources keep only the latest',()=>{
 const first={...activity('Codex 正在处理当前消息'),type:'live_agent_status',timestamp:'2026-10-20T10:00:00Z'};
 const latest={...activity('Codex 正在处理当前消息'),timestamp:'2026-10-20T10:00:01Z'};
 assert.equal(status([assistant,latest],0),'处理中');
 const entries=[first,latest];
 const projected=present(entries);
 assert.deepEqual(projected.map(hide),[true,false]);
 assert.equal(projected[0].activitySuperseded,true);assert.equal(first.activitySuperseded,undefined);
 // A stale task overlay may be appended after the newest official activity.
 assert.deepEqual(present([latest,first]).map(hide),[false,true]);
 assert.equal(status([assistant,latest,{...first,text:'正在思考'}],0),'处理中');
});

test('standalone generic progress cannot merge across user, tool, approval, error, or unknown activity',()=>{
 const generic=activity('Codex 正在处理当前消息');
 for(const boundary of [
  {...assistant,role:'user'}, {...assistant,role:'tool'}, activity('正在执行命令'),
  activity('等待审批'),activity('执行失败'),activity('未知状态'),
  {...generic,toolItems:[{text:'operation'}]},{...generic,liveKind:'question_request'}
 ]) {
  const projected=present([generic,boundary,{...generic,type:'live_agent_status'}]);
  assert.deepEqual(projected.map(hide),[false,false,false]);
 }
 const differentTurns=present([{...generic,turnId:'a'},{...generic,turnId:'b'}]);
 assert.deepEqual(differentTurns.map(hide),[false,false]);
});

test('unknown turn metadata cannot bridge two different known turns into an assistant footer',()=>{
 const entries=[{...assistant,turnId:'a'},{...activity('Codex 正在处理当前消息'),turnId:'b'},activity('正在思考')];
 assert.equal(owner(entries,2),-1);assert.equal(status(entries,0),'');
});

test('reprojection clears stale metadata when a user boundary is inserted',()=>{
 const first=activity('Codex 正在处理当前消息'), second={...first,type:'live_agent_status'};
 const initially=present([first,second]);
 assert.equal(hide(initially[0]),true);
 const boundary={...assistant,role:'user'};
 const projected=present([initially[0],boundary,initially[1]]);
 assert.deepEqual(projected.map(hide),[false,false,false]);
 assert.equal(initially[0].activitySuperseded,true);
});

test('entry context follows list order across assistant, tool, and user boundaries',()=>{
 assert.deepEqual(withContext([]),[]);
 const entries=[assistant,{...assistant,itemId:'a2'},
  {...assistant,role:'tool'}, {...assistant,itemId:'a3'},
  {...assistant,role:'user'}, {...assistant,itemId:'a4'}];
 const projected=withContext(entries);
 assert.deepEqual(projected.map(entry=>entry.previousVisibleRole),['','assistant','assistant','tool','assistant','user']);
 assert.deepEqual(projected.map(entry=>entry.lastVisibleAssistant),[false,false,false,false,false,true]);
 assert.deepEqual(withContext([{...assistant,role:'user'}]).map(entry=>entry.lastVisibleAssistant),[false]);
 for(let index=0;index<entries.length;index++) {
  assert.notEqual(projected[index],entries[index]);
  assert.equal(entries[index].previousVisibleRole,undefined);
  assert.equal(entries[index].lastVisibleAssistant,undefined);
 }
});

test('entry context recomputes the last assistant after append and removal without mutating earlier projections',()=>{
 const initial=withContext([assistant,{...assistant,role:'user'}]);
 const appended=withContext([...initial,{...assistant,itemId:'new'}]);
 assert.deepEqual(initial.map(entry=>entry.lastVisibleAssistant),[true,false]);
 assert.deepEqual(appended.map(entry=>entry.lastVisibleAssistant),[false,false,true]);
 const removed=withContext(appended.slice(0,2));
 assert.deepEqual(removed.map(entry=>entry.lastVisibleAssistant),[true,false]);
 assert.deepEqual(appended.map(entry=>entry.lastVisibleAssistant),[false,false,true]);
 assert.deepEqual(withContext(appended.filter(entry=>entry.role!=='assistant')).map(entry=>entry.lastVisibleAssistant),[false]);
});

test('equal timestamps and content never conflate distinct item contexts',()=>{
 const entries=[{...assistant,itemId:'first'}, {...assistant,role:'user',itemId:'user'},
  {...assistant,itemId:'last'}, {...assistant,role:'tool',itemId:'tool'}];
 const projected=withContext(entries);
 assert.deepEqual(projected.map(entry=>entry.itemId),['first','user','last','tool']);
 assert.deepEqual(projected.map(entry=>entry.previousVisibleRole),['','assistant','user','assistant']);
 assert.deepEqual(projected.map(entry=>entry.lastVisibleAssistant),[false,false,true,false]);
});

test('entry context preserves canonical identity, tool data, and all activity metadata',()=>{
 const canonical=Object.freeze({...assistant,syncId:'sync',syncStartOffset:10,syncEndOffset:20,
  liveKind:'agent_message',threadId:'thread',turnId:'turn',itemId:'item',toolItems:[{text:'operation'}],
  footerProgress:'处理中',activityInFooter:false,activitySuperseded:true});
 const projected=withContext(Object.freeze([canonical]));
 for(const field of Object.keys(canonical)) assert.equal(projected[0][field],canonical[field],field);
 assert.equal(projected[0].previousVisibleRole,'');assert.equal(projected[0].lastVisibleAssistant,true);
 assert.equal(canonical.previousVisibleRole,undefined);assert.equal(canonical.lastVisibleAssistant,undefined);
});

test('activity reprojection preserves context when footer and hidden activity entries are cloned again',()=>{
 const initial=withContext(present([assistant,activity('正在思考'),activity('正在返回内容')]));
 const projected=present(initial);
 assert.deepEqual(projected.map(entry=>entry.previousVisibleRole),['','assistant','system']);
 assert.deepEqual(projected.map(entry=>entry.lastVisibleAssistant),[true,false,false]);
 assert.deepEqual(projected.map(hide),[false,true,true]);
 for(let index=0;index<initial.length;index++) assert.notEqual(projected[index],initial[index]);
 const plain=withContext([assistant])[0];
 assert.equal(present([plain])[0],plain);
 assert.equal(present([assistant])[0],assistant);
 const boundary={...assistant,role:'user'};
 const changed=present([initial[0],boundary,initial[2]]);
 assert.equal(changed[0].footerProgress,'');assert.equal(changed[2].activityInFooter,false);
 assert.equal(changed[0].lastVisibleAssistant,true);assert.equal(changed[2].previousVisibleRole,'system');
});

test('context role reads grow linearly with list size',()=>{
 for(const length of [500,2000]) {
  let roleReads=0;
  const entries=Array.from({length},(_,index)=>({...assistant,itemId:String(index),
   get role(){roleReads++;return index%3===0?'assistant':'user';}}));
  const projected=withContext(entries);
  assert.ok(roleReads<=length*2,`${length} entries read roles ${roleReads} times`);
  assert.equal(projected.length,length);
  assert.equal(projected.filter(entry=>entry.lastVisibleAssistant).length,1);
 }
});

test('timeline activity reprojection retains context on the rendered assistant rows',()=>{
 const base='HarmonyCodexRemote/entry/src/main/ets/services/';
 const timelineSources=['OptimisticMessageService.ets','SessionActivityPresentation.ets','SessionTimeline.ets']
  .map(name=>fs.readFileSync(base+name,'utf8').replace(/^import .*;\s*$/gm,'').replaceAll('export ','')).join('\n');
 const build=vm.runInNewContext(stripTypeScriptTypes(timelineSources+'\nbuildSessionTimeline;'),{});
 const entries=withContext(present([{...assistant,itemId:'first'},activity('正在思考'),
  {...assistant,role:'user',itemId:'user'}, {...assistant,type:'live_agent_streaming',itemId:'last'}]));
 const rows=build('session',entries,[],[]);
 assert.deepEqual(Array.from(rows,row=>row.entry.itemId),['first','user','last']);
 assert.deepEqual(Array.from(rows,row=>row.entry.previousVisibleRole),['','system','user']);
 assert.deepEqual(Array.from(rows,row=>row.entry.lastVisibleAssistant),[false,false,true]);
 assert.equal(rows[0].entry.footerProgress ?? '','');assert.equal(rows[2].entry.footerProgress,'正在回复');
 assert.equal(rows[0].entry,entries[0],'unchanged historical content retains its reference');
 assert.notEqual(rows[2].entry,entries[3]);
});

test('many stale streaming commentary entries expose one current footer and clear older metadata',()=>{
 const entries=Array.from({length:6},(_,index)=>({...assistant,type:'live_agent_streaming',itemId:String(index),
  turnId:'same-running-turn',footerProgress:'正在回复'}));
 const projected=present(entries);
 assert.deepEqual(projected.map(entry=>entry.footerProgress),['','','','','','正在回复']);
 assert.deepEqual(present(projected).map(entry=>entry.footerProgress),['','','','','','正在回复']);
 assert.ok(entries.every(entry=>entry.footerProgress==='正在回复'),'canonical inputs remain unchanged');
});

test('later completed content, user input, tools, and approvals stop an old streaming footer',()=>{
 const streaming={...assistant,type:'live_agent_streaming',itemId:'old',footerProgress:'正在回复'};
 for(const next of [
  {...assistant,itemId:'done'}, {...assistant,role:'user'}, {...assistant,role:'tool'},
  {...activity('等待审批'),liveKind:'approval_request'}
 ]) {
  const result=present([streaming,next]);
  assert.equal(result[0].footerProgress,'');
  assert.equal(result.filter(entry=>entry.footerProgress).length,0);
  assert.equal(hide(result[1]),false,'meaningful content must remain visible');
 }
});

test('old generic progress is not carried forward across a later assistant message',()=>{
 const rows=present([assistant,activity('正在返回内容'),{...assistant,itemId:'new'},activity('正在思考')]);
 assert.equal(rows[0].footerProgress ?? '','');
 assert.equal(rows[2].footerProgress,'思考中');
 assert.equal(rows.filter(entry=>entry.footerProgress).length,1);
});
