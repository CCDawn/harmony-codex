import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
const source=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets','utf8');
const methods=['inlineDesktopInteractions','footerDesktopInteractions','shouldShowPendingInteractionFooter'].map(name=>{
  const start=source.indexOf(`  private ${name}(`);
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n  }',start)+4);
}).join('\n');
const Page=new Function(stripTypeScriptTypes(`class Page {${methods}};`)+'return Page;')();
const entry={role:'assistant',threadId:'thread',turnId:'turn',itemId:'question'};
const request={id:'ticket',threadId:'thread',turnId:'turn',itemId:'question'};
function page(entries=[entry],requests=[request]){
  return Object.assign(new Page(),{visibleSessionEntries:()=>entries,visibleDesktopInteractions:()=>requests,
    pendingUserInput:()=>null,pendingApprovalId:()=>'',pendingInteractionNotice:()=>''});
}
test('an async card has exactly one owner at its corresponding message',()=>{
  const view=page();
  assert.deepEqual(view.inlineDesktopInteractions(entry),[request]);
  assert.deepEqual(view.footerDesktopInteractions(),[]);
  assert.equal(view.shouldShowPendingInteractionFooter(),false);
});
test('a missing timeline item and synchronous requests retain the footer form',()=>{
  assert.deepEqual(page([]).footerDesktopInteractions(),[request]);
  const sync={id:'sync',threadId:'thread'};
  assert.deepEqual(page([entry],[sync]).footerDesktopInteractions(),[sync]);
});
test('an item ID in another turn or thread cannot own the card',()=>{
  for(const other of [{...entry,turnId:'other'},{...entry,threadId:'other'},{...entry,role:'user'}]){
    const view=page([other]);
    assert.deepEqual(view.inlineDesktopInteractions(other),[]);
    assert.deepEqual(view.footerDesktopInteractions(),[request]);
  }
});
