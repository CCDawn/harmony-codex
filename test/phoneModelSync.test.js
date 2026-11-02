import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
const index=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets','utf8');
function body(source,name){const start=source.search(new RegExp(`^  private (?:async )?${name}\\(`,'m'));assert.ok(start>=0,name);const open=source.indexOf('{',start);let depth=1,end=open+1;while(depth){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++;}return source.slice(open+1,end-1);}
function setup(client){const methods=['loadSessionReasoningEffort','changeSessionModel','changeReasoningEffort','loadDesktopReasoningDefaults','changeServiceTier'];const functions=methods.map(name=>`async ${name}(${name==='loadSessionReasoningEffort'?'sessionId,force=false':name==='loadDesktopReasoningDefaults'?'force=false':'value'}) {${body(index,name)}}`).join('\n');const Page=new Function('BridgeClient',(stripTypeScriptTypes(`class Page {${functions} applyServiceTierSettings(settings, includeOverride) {${body(index,'applyServiceTierSettings')}}}`)+';return Page;'))(client);const p=new Page();Object.assign(p,{selectedSession:{id:'thread'},isNewSessionDraft:false,sessionModel:'',sessionReasoningEffort:'',desktopDefaultModel:'',desktopDefaultReasoningEffort:'',availableModels:[],sessionServiceTier:'',desktopDefaultServiceTier:'',availableServiceTiers:[],serviceTierOptionValues:()=>[{id:''},{id:'default'},{id:'priority'}],reasoningEffortLoadedSessionId:'',reasoningEffortLoadedAt:0,desktopModelDefaultsLoadedAt:0,modelSettingsCacheTtlMs:10000,modelSettingsRequestSeq:0,modelSettingsLoadingSessionId:'',isSavingReasoningEffort:false,normalizedBridgeUrl:()=>'',normalizeModel:x=>x||'',normalizeReasoningEffort:x=>x||'',normalizeModelOptions:x=>x,modelShortLabel:x=>x,reasoningEffortDisplayLabel:x=>x,log(){},errorText:String});p.canChangeReasoningEffort=()=>!p.isSavingReasoningEffort;p.reasoningEffortSessionId=()=>p.isNewSessionDraft?'__new_session__':p.selectedSession?.id||'';return p;}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
test('same open conversation picks up changed desktop settings when its cache expires',async()=>{
 let reads=0;const p=setup({async getSessionSettings(){reads++;return{model:'',defaultModel:reads===1?'sol':'astra',reasoningEffort:'',defaultReasoningEffort:reads===1?'high':'medium'};}});
 await p.loadSessionReasoningEffort('thread');assert.equal(p.desktopDefaultModel,'sol');
 await p.loadSessionReasoningEffort('thread');assert.equal(reads,1);
 p.reasoningEffortLoadedAt=Date.now()-10001;await p.loadSessionReasoningEffort('thread');
 assert.equal(p.desktopDefaultModel,'astra');assert.equal(p.desktopDefaultReasoningEffort,'medium');assert.equal(reads,2);
});
test('a slow background read cannot overwrite a newer explicit phone model selection',async()=>{
 const old=deferred();const p=setup({getSessionSettings:()=>old.promise,async updateSessionSettings(){return{model:'new-choice',defaultModel:'sol'};}});
 const read=p.loadSessionReasoningEffort('thread');await p.changeSessionModel('new-choice');old.resolve({model:'old-choice',defaultModel:'astra'});await read;
 assert.equal(p.sessionModel,'new-choice');assert.equal(p.desktopDefaultModel,'sol');assert.equal(p.modelSettingsLoadingSessionId,'');
});
test('a delayed save from a different conversation cannot overwrite the current model or reasoning effort',async()=>{
 for(const method of ['changeSessionModel','changeReasoningEffort']){
  const pending=deferred(),p=setup({updateSessionSettings:()=>pending.promise});const save=p[method]('new-choice');
  p.selectedSession={id:'another-thread'};p.sessionModel='other-model';p.sessionReasoningEffort='other-effort';pending.resolve({model:'old-thread-model',reasoningEffort:'high'});await save;
  assert.equal(p.sessionModel,'other-model');assert.equal(p.sessionReasoningEffort,'other-effort');assert.equal(p.isSavingReasoningEffort,false);
 }
});
test('a late defaults request for a new draft cannot override an opened existing conversation',async()=>{
 const pending=deferred(),p=setup({getCodexSettings:()=>pending.promise});p.isNewSessionDraft=true;p.selectedSession=null;
 const load=p.loadDesktopReasoningDefaults();p.isNewSessionDraft=false;p.selectedSession={id:'thread'};p.desktopDefaultModel='current-thread';pending.resolve({defaultModel:'old-global'});await load;
 assert.equal(p.desktopDefaultModel,'current-thread');
});
test('existing-thread sends omit cached preferences but preserve explicit API auto or overrides',async()=>{
 const source=fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets','utf8');const start=source.indexOf('  static async sendCodexThreadMessage('),open=source.indexOf('{',start);let depth=1,end=open+1;while(depth){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++;}
 const method=source.slice(start,end).replace('static async','static async');const requests=[];const Client=new Function('http',(stripTypeScriptTypes(`class BridgeClient {${method}}`)+';return BridgeClient;'))({RequestMethod:{POST:'POST'}});Client.request=async(_method,_url,text)=>{requests.push(JSON.parse(text));return JSON.stringify({run:{id:'run'}});};
 await Client.sendCodexThreadMessage('','thread','body','project','','fingerprint');assert.equal(Object.hasOwn(requests[0],'model'),false);assert.equal(Object.hasOwn(requests[0],'reasoningEffort'),false);
 await Client.sendCodexThreadMessage('','thread','body','project','','fingerprint','','');assert.equal(requests[1].model,'');assert.equal(requests[1].reasoningEffort,'');
 await Client.sendCodexThreadMessage('','thread','body','project','','fingerprint','high','chosen');assert.equal(requests[2].model,'chosen');assert.equal(requests[2].reasoningEffort,'high');
});


test('desktop speed follows the guarded settings refresh and explicit phone choice survives a stale read', async()=>{
 const pending=deferred(); const p=setup({getSessionSettings:()=>pending.promise,async updateSessionSettings(_base,_id,patch){return{serviceTier:patch.serviceTier,defaultServiceTier:'priority',serviceTierOptions:[{id:'priority',name:'Fast'}]};}});
 const read=p.loadSessionReasoningEffort('thread'); await p.changeServiceTier('default');
 pending.resolve({serviceTier:'',defaultServiceTier:'priority'}); await read;
 assert.equal(p.sessionServiceTier,'default'); assert.equal(p.desktopDefaultServiceTier,'priority');
});

test('speed changes roll back on save failure without changing another conversation', async()=>{
 const p=setup({async updateSessionSettings(){throw Error('offline');}});p.sessionServiceTier='priority';
 await p.changeServiceTier('default');assert.equal(p.sessionServiceTier,'priority');
 const pending=deferred();const q=setup({updateSessionSettings:()=>pending.promise});const save=q.changeServiceTier('priority');
 q.selectedSession={id:'other'};q.sessionServiceTier='default';pending.resolve({serviceTier:'priority'});await save;
 assert.equal(q.sessionServiceTier,'default');
});
