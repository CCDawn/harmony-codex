import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const base = 'HarmonyCodexRemote/entry/src/main/ets/services/';
const sources = ['OptimisticMessageService.ets', 'SessionActivityPresentation.ets', 'SessionTimeline.ets']
  .map(name => fs.readFileSync(base + name, 'utf8').replace(/^import .*;\s*$/gm, '').replaceAll('export ', '')).join('\n');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(sources + '\nglobalThis.api = { buildSessionTimeline, reconcileOptimisticSessionMessages, stableCanonicalMessageKey };'), context);
const { buildSessionTimeline: build, reconcileOptimisticSessionMessages: reconcile, stableCanonicalMessageKey: key } = context.api;
const at = seconds => new Date(Date.UTC(2026, 9, 20, 10, 0, seconds)).toISOString();
const user = (id, seconds, overrides={}) => ({ role:'user', type:'response_item', text:'hello', timestamp:at(seconds), threadId:'s', itemId:id, ...overrides });
const assistant = (id, seconds, overrides={}) => ({...user(id,seconds), role:'assistant', text:'reply', ...overrides});
const local = (id, seconds, overrides={}) => ({id, submissionId:id, sessionId:'s', projectId:'p', isNewSession:false, text:'hello', images:[],files:[],createdAt:at(seconds),state:'submitted',submittedText:'hello',baselineEntryKeys:[],...overrides});
const kinds = rows => Array.from(rows, row=>row.kind);

test('projection alone replaces an accepted optimistic echo when a history poll arrives',()=>{
 const pending=local('one',0), official=user('u',1);
 assert.equal(build('s',[],[pending],[]).length,1);
 const rows=build('s',[official],[pending],[]);
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'entry');assert.equal(rows[0].entry.itemId,'u');
 assert.equal(pending.baselineEntryKeys.length,0);
});

test('interleaves sends and failures at original positions and preserves official order',()=>{
 const entries=[user('u0',0),assistant('a0',3),assistant('a1',7)];
 const pending=local('later',6,{baselineEntryKeys:[key(entries[0])]}), failure=local('failed',2,{baselineEntryKeys:[key(entries[0])]});
 const rows=build('s',entries,[pending],[failure]);
 assert.deepEqual(kinds(rows),['entry','failed','entry','optimistic','entry']);
 assert.equal(rows[1].failedId,'failed');assert.equal(rows[3].optimistic.id,'later');
});

test('optimistic to failed transition keeps the same row identity and only one bubble',()=>{
 const pending=local('send',2,{state:'sending'}), failure={...pending,id:'failed-record'};
 const before=build('s',[],[pending],[]), after=build('s',[],[pending],[failure]);
 assert.equal(after.length,1);assert.equal(after[0].kind,'failed');assert.equal(after[0].key,before[0].key);
 assert.equal(after[0].timestamp,before[0].timestamp);
});

test('repeated real sends remain distinct and official rows are never globally deduplicated by text',()=>{
 const messages=[local('one',0),local('two',2)];
 const one=user('u1',1);
 const rows=build('s',[one],messages,[]);
 assert.deepEqual(kinds(rows),['entry','optimistic']);assert.equal(rows[1].optimistic.id,'two');
 const remaining=reconcile(messages,'s',[one]);
 assert.equal(build('s',[one],remaining,[]).length,2);
 assert.equal(build('s',[one,user('u2',3)],messages,[]).length,2);
 const duplicateRows=build('s',[user(undefined,1),user(undefined,1)],[],[]);
 assert.equal(duplicateRows.length,2);assert.notEqual(duplicateRows[0].key,duplicateRows[1].key);
});

test('submission and item identities reserve official items ahead of text fallbacks',()=>{
 const fallback=local('fallback',0), exact=local('exact',0);
 let rows=build('s',[user('u',1,{submissionId:'exact'})],[fallback,exact],[]);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.kind==='optimistic').optimistic.id,'fallback');
 rows=build('s',[user('u',1)],[fallback,local('exact',0,{itemId:'u'})],[]);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.kind==='optimistic').optimistic.id,'fallback');
});

test('conflicting send identities cannot fall back to equal text',()=>{
 const message=local('one',0,{turnId:'turn',itemId:'expected'});
 assert.equal(build('s',[user('other',1,{turnId:'turn'})],[message],[]).length,2);
 assert.equal(build('s',[user('expected',1,{submissionId:'other'})],[message],[]).length,2);
 assert.equal(build('s',[user(undefined,1,{turnId:'other'})],[message],[]).length,2);
});

test('bounded clock skew requires a captured baseline and never acknowledges known old history',()=>{
 const official=user('u',-30), message=local('one',0);
 assert.equal(build('s',[official],[message],[]).length,1);
 assert.equal(build('s',[official],[{...message,baselineEntryKeys:undefined}],[]).length,2);
 assert.equal(build('s',[official],[{...message,baselineEntryKeys:[key(official)]}],[]).length,2);
 assert.equal(build('s',[user('old',-121)],[message],[]).length,2);
 assert.equal(build('s',[user('far-future',901)],[message],[]).length,2);
});

test('failed prose alone never consumes old history and explicit confirmation removes only its own failure',()=>{
 const old=user('old',0), failure={id:'failure',submissionId:'send',sessionId:'s',text:'hello',createdAt:at(2)};
 assert.equal(build('s',[old],[],[failure]).filter(r=>r.kind==='failed').length,1);
 assert.equal(build('s',[old,user('new',3,{submissionId:'send'})],[],[failure]).filter(r=>r.kind==='failed').length,0);
 const withBaseline={...failure,baselineEntryKeys:[key(old)]};
 assert.equal(build('s',[old],[],[withBaseline]).filter(r=>r.kind==='failed').length,1);
});

test('normalizes image labels and file URL encoding without losing attachment identity',()=>{
 const message=local('photo',0,{submittedText:'hello\n\n图片路径：C:\\Uploads\\one photo.png'});
 const official=user('photo',1,{text:'hello\n![桌面端图片](file:///C:/Uploads/one%20photo.png)'});
 assert.equal(build('s',[official],[message],[]).length,1);
 assert.equal(build('s',[{...official,text:official.text.replace('one%20','two%20')}],[message],[]).length,2);
 assert.equal(build('s',[{...official,text:'hello'}],[message],[]).length,2);
 assert.equal(build('s',[{...official,text:official.text+'\n![x](C:/Uploads/one photo.png)'}],[message],[]).length,2);
});

test('filters other sessions and does not use live user echoes as official confirmation',()=>{
 const message=local('one',0);
 assert.equal(build('s',[],[{...message,sessionId:'other'}],[]).length,0);
 assert.equal(build('s',[],[],[{...message,sessionId:'other'}]).length,0);
 assert.equal(build('s',[user('u',1,{type:'live_user_message'})],[message],[]).length,2);
});

test('footer progress and delivery receipts do not produce duplicate Codex bubbles',()=>{
 const progress={...user('p',3),role:'system',type:'live_activity',text:'正在返回内容'};
 const delivery={...progress,itemId:'d',timestamp:at(4),text:'已发送'};
 const rows=build('s',[assistant('a',2),progress,delivery],[],[]);
 assert.equal(rows.length,1);assert.equal(rows[0].entry.footerProgress,'正在回复');
 for(const text of ['正在执行命令','等待审批','执行失败','请回答问题']) {
  const result=build('s',[assistant('a',2),{...progress,text}],[],[]);
  assert.equal(result.length,2,text);
 }
});

test('an unowned initial thinking status remains visible and important operations break attachment',()=>{
 const progress={...user('p',3),role:'system',type:'live_activity',text:'正在思考'};
 assert.equal(build('s',[progress],[],[]).length,1);
 const operation={...progress,itemId:'operation',text:'等待审批'};
 const rows=build('s',[assistant('a',1),operation,progress],[],[]);
 assert.equal(rows.length,3);assert.equal(rows[0].entry.footerProgress,undefined);
});

test('assistant row keys remain stable when streaming text, timestamp, and footer status change',()=>{
 const entry=assistant(undefined,1,{type:'live_agent_streaming',text:'part'});
 const before=build('s',[entry],[],[])[0];
 const after=build('s',[{...entry,text:'part continued',timestamp:at(2)}],[],[])[0];
 assert.equal(before.key,after.key);assert.equal(after.entry.text,'part continued');
 const canonical=assistant(undefined,3);
 assert.equal(build('s',[canonical],[],[])[0].key,build('s',[{...canonical,text:'updated'}],[],[])[0].key);
});

test('failed attachments without the actual submitted image/file identity cannot match prose alone',()=>{
 for(const attachments of [{images:[{id:'photo'}]},{files:[{id:'file'}]}]) {
  const failure={...local('failure',0),submittedText:undefined,...attachments};
  assert.equal(build('s',[user('u',1)],[],[failure]).filter(r=>r.kind==='failed').length,1);
 }
});

test('two legacy official sends with the same timestamp and content each consume one echo',()=>{
 const first=user(undefined,1), second={...first};
 const messages=[local('one',0),local('two',0),local('three',0)];
 const rows=build('s',[first,second],messages,[]);
 assert.deepEqual(kinds(rows),['optimistic','entry','entry']);
 assert.equal(rows[0].optimistic.id,'three');
 const remaining=reconcile(messages,'s',[first,second]);
 assert.equal(remaining.length,1);assert.equal(reconcile(remaining,'s',[first,second]).length,1);
 assert.equal(reconcile(remaining,'s',[first,second,{...first}]).length,0);
 const oldBaseline=[key(first),key(second)];
 assert.equal(reconcile([local('new',0,{baselineEntryKeys:oldBaseline})],'s',[first,second]).length,1);
});

test('parallel initial processing sources yield one visible progress row before assistant content exists',()=>{
 const first={...user('progress-1',1),role:'system',type:'live_agent_status',text:'Codex 正在处理当前消息'};
 const latest={...first,itemId:'progress-2',type:'live_activity',timestamp:at(2)};
 const rows=build('s',[first,latest],[],[]);
 assert.equal(rows.length,1);assert.equal(rows[0].entry.itemId,'progress-2');
 const footer=build('s',[assistant('a',0),first,latest],[],[]);
 assert.equal(footer.length,1);assert.equal(footer[0].entry.footerProgress,'处理中');
 const approval={...first,itemId:'approval',text:'等待审批'};
 assert.equal(build('s',[first,approval,latest],[],[]).length,3);
});

test('optimistic and failed user rows prevent activity merging across their original send positions',()=>{
 const first={...user('p1',1),role:'system',type:'live_agent_status',text:'Codex 正在处理当前消息'};
 const latest={...first,itemId:'p2',type:'live_activity',timestamp:at(3)};
 const pending=local('new-user',2,{state:'sending'});
 const rows=build('s',[first,latest],[pending],[]);
 assert.deepEqual(kinds(rows),['entry','optimistic','entry']);
 const failedRows=build('s',[first,latest],[],[{...pending,id:'failed'}]);
 assert.deepEqual(kinds(failedRows),['entry','failed','entry']);
});
