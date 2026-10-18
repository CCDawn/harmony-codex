import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source=fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceTranscriptPresentation.ets',import.meta.url),'utf8').replace(/^import\s+.*?;\s*$/gm,'');
const {VoiceTranscriptPresentation:P}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const voice=(text,final=true)=>({itemId:'voice:call:turn',role:'user',text,final,phoneTranscript:true,localStorageStatus:'saved'});
test('observed closed and missing-close sniff markers do not render empty bubbles',()=>{
 for(const text of ['[sniff]','[sniff','[SNIFF]','[sniff].','[sniff][cough][sigh]','[sniff [sniff [sniff']) assert.equal(P.visible([voice(text)]).length,0,text);
});
test('split streaming sound tags stay hidden until a real word appears',()=>{
 for(const text of ['[','[s','[sni','[sniff','[sniff]']) assert.equal(P.text(voice(text,false)),'',text);
 assert.equal(P.text(voice('[science',false)),'[science');
 assert.equal(P.text(voice('[s',true)),'[s');
 assert.equal(P.text(voice('[sniff]你好',false)),'你好');
});
test('mixed speech is visible and original stored entry and metadata remain untouched',()=>{
 const raw=voice('你好 [sniff] 现在进度如何'); const before=JSON.stringify(raw);
 assert.equal(P.text(raw),'你好 现在进度如何');
 assert.equal(P.visible([raw])[0],raw);
 assert.equal(JSON.stringify(raw),before);
});
test('literal words quotes official messages and assistant explanations are preserved',()=>{
 for(const text of ['sniff是什么意思','Please sniff the flower','解释 "[sniff]"','`[sniff]`','“[sniff]”','[unknown]','[1, 2]']) assert.equal(P.text(voice(text)),text);
 const assistant={...voice('[sniff] 表示吸鼻子'),role:'assistant'};
 assert.equal(P.text(assistant),assistant.text);
 const official={...voice('[sniff]'),itemId:'room:message',phoneTranscript:false};
 assert.equal(P.text(official),'[sniff]');
});
test('both views filter originals and render through the same presentation helper',()=>{
 for(const file of ['VoiceCallPanel','CompanionConversationPanel']){
 const component=fs.readFileSync(new URL(`../HarmonyCodexRemote/entry/src/main/ets/components/${file}.ets`,import.meta.url),'utf8');
 assert.match(component,/ForEach\(VoiceTranscriptPresentation\.visible\(this\.(transcripts|entries)\)/);
 assert.match(component,/VoiceTranscriptPresentation\.text\(entry\)/);
 }
});
