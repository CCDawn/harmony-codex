import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
const root = 'HarmonyCodexRemote/entry/src/main/ets/';
const index=fs.readFileSync(root+'pages/Index.ets','utf8');
const methods=index.slice(index.indexOf('  private streamingAgentTextForTask('),index.indexOf('  private searchSessionResults('));
const helperPath=root+'services/SessionStreamPresentation.ets';
const helper=fs.existsSync(helperPath)?fs.readFileSync(helperPath,'utf8').replace(/^import .*;\s*$/gm,'').replaceAll('export ',''):'';
const context=vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`${helper}\nclass Page {${methods}} globalThis.page = new Page();`),context);
const text=events=>context.page.streamingAgentTextForTask({events});
const delta=(itemId,value,turnId='t')=>({type:'codex.app_server.notification',payload:{method:'item/agentMessage/delta',params:{turnId,itemId,delta:value}}});
const done=(id,value,turnId='t')=>({type:'codex.app_server.notification',payload:{method:'item/completed',params:{turnId,item:{id,type:'agentMessage',text:value}}}});

test('new item streams after an earlier completed commentary instead of being covered by it',()=>{
 const events=[delta('a','earlier'),done('a','earlier'),delta('b','new')];
 assert.equal(text(events),'new');
 assert.equal(text(events.concat(delta('b',' answer'))),'new answer');
});
test('different items never concatenate and late completion of older item cannot replace newer stream',()=>{
 assert.equal(text([delta('a','first'),delta('b','second'),done('a','first final')]),'second');
});
test('completed item supersedes its partial text and ignores late duplicate deltas',()=>{
 assert.equal(text([delta('a','par'),done('a','complete'),delta('a','late')]),'complete');
});
test('turn completion and legacy final records remain supported',()=>{
 assert.equal(text([{type:'codex.app_server.notification',payload:{method:'turn/completed',params:{turn:{id:'t',items:[{id:'a',type:'agentMessage',text:'one'},{id:'b',type:'agentMessage',text:'two'}]}}}}]),'two');
 assert.equal(text([{type:'codex.exec.event',payload:{type:'item.completed',item:{id:'legacy',type:'agent_message',text:'legacy result'}}}]),'legacy result');
});
test('old-format delta events without item IDs still stream after a completed message',()=>{
 assert.equal(text([done('a','old'),delta(undefined,'新'),delta(undefined,'回复')]),'新回复');
});
