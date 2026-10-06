import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
function harness({start,stop,supported=true}={}) {
  const requests=[],stops=[];
  class ContinuousTaskRequest {isModeSupported(){return supported;}}
  const backgroundTaskManager={ContinuousTaskRequest,
    BackgroundTaskMode:{MODE_AV_PLAYBACK_AND_RECORD:10},
    BackgroundTaskSubmode:{SUBMODE_VOICE_CHAT_NORMAL_NOTIFICATION:2},
    async startBackgroundRunning(context,request){requests.push(request);return start?await start():{continuousTaskId:requests.length+100};},
    async stopBackgroundRunning(context,id){stops.push(id);if(stop)await stop();}
  };
  const wantAgent={OperationType:{START_ABILITY:1},WantAgentFlags:{UPDATE_PRESENT_FLAG:1},getWantAgent:async()=>({})};
  const source=fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceBackgroundTaskService.ets',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace('export class','class');
  const context=vm.createContext({backgroundTaskManager,wantAgent});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.service=VoiceBackgroundTaskService;',context);
  return {service:context.service,requests,stops};
}
test('voice task is shared within a call and stops only its own id',async()=>{
  const {service,requests,stops}=harness();
  const ids=await Promise.all([service.start({},1),service.start({},1)]);
  assert.deepEqual(ids,[101,101]);assert.equal(requests.length,1);
  await service.stop(0);assert.equal(stops.length,0);
  await service.stop(1);assert.deepEqual(stops,[101]);
});
test('old cleanup cannot stop the next call background task',async()=>{
  const {service,stops}=harness();await service.start({},1);await service.stop(1);
  await service.start({},2);await service.stop(1);assert.deepEqual(stops,[101]);
  await service.stop(2);assert.deepEqual(stops,[101,102]);
});
test('hangup while task is starting waits and releases the allocated id',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);
  const {service,stops}=harness({start:()=>gate});
  const start=service.start({},1);const stop=service.stop(1);
  finish({continuousTaskId:155});await Promise.all([start,stop]);assert.deepEqual(stops,[155]);
});
test('unsupported mode never allocates a task',async()=>{
  const {service,requests}=harness({supported:false});await assert.rejects(()=>service.start({},1));assert.equal(requests.length,0);
});
