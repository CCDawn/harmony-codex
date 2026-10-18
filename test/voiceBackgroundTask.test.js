import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
function harness({start,stop,supported=true,register}={}) {
  const requests=[],stops=[],listeners=new Set(),registrations=[],unregistrations=[];
  class ContinuousTaskRequest {isModeSupported(){return supported;}}
  const backgroundTaskManager={ContinuousTaskRequest,
    BackgroundTaskMode:{MODE_AV_PLAYBACK_AND_RECORD:10},
    BackgroundTaskSubmode:{SUBMODE_VOICE_CHAT_NORMAL_NOTIFICATION:2},
    async startBackgroundRunning(context,request){requests.push(request);return start?await start():{continuousTaskId:requests.length+100};},
    async stopBackgroundRunning(context,id){stops.push(id);if(stop)await stop({id,emit});},
    on(type,listener){assert.equal(type,'continuousTaskCancel');listeners.add(listener);registrations.push(listener);if(register)register({listener,listeners});},
    off(type,listener){assert.equal(type,'continuousTaskCancel');listeners.delete(listener);unregistrations.push(listener);}
  };
  function emit(info){for(const listener of [...listeners])listener(info);}
  const wantAgent={OperationType:{START_ABILITY:1},WantAgentFlags:{UPDATE_PRESENT_FLAG:1},getWantAgent:async()=>({})};
  const source=fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/services/VoiceBackgroundTaskService.ets',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace('export class','class');
  const context=vm.createContext({backgroundTaskManager,wantAgent});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.service=VoiceBackgroundTaskService;',context);
  return {service:context.service,requests,stops,listeners,registrations,unregistrations,emit};
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

test('canceling this voice task clears ownership and notifies its generation once',async()=>{
  const {service,stops,listeners,emit}=harness();const cancelled=[];
  const id=await service.start({},12,generation=>cancelled.push(generation));
  emit({id:id+500,reason:1});
  assert.deepEqual(cancelled,[]);assert.equal(listeners.size,1);
  emit({id,reason:1});emit({id,reason:1});
  assert.deepEqual(cancelled,[12]);assert.equal(listeners.size,0);
  await service.stop(12);assert.deepEqual(stops,[]);
});

test('canceling another task leaves the owned voice task active',async()=>{
  const {service,listeners,emit}=harness();const cancelled=[];
  const id=await service.start({},22,generation=>cancelled.push(generation));
  emit({id:id+1,reason:2});
  assert.deepEqual(cancelled,[]);assert.equal(listeners.size,1);
  await service.stop(22);
});

test('a queued callback from an old task cannot affect the next generation',async()=>{
  const {service,registrations,emit}=harness();const cancelled=[];
  const oldId=await service.start({},31,generation=>cancelled.push(generation));
  const oldListener=registrations[0];
  await service.stop(31);
  const newId=await service.start({},32,generation=>cancelled.push(generation));
  oldListener({id:oldId,reason:1});
  emit({id:oldId,reason:1});
  assert.deepEqual(cancelled,[]);
  emit({id:newId,reason:1});
  assert.deepEqual(cancelled,[32]);
});

test('normal stop suppresses its cancellation notification and unregisters the listener',async()=>{
  const {service,listeners,stops}=harness({stop:async({id,emit})=>emit({id,reason:0})});const cancelled=[];
  const id=await service.start({},41,generation=>cancelled.push(generation));
  await service.stop(41);
  assert.deepEqual(stops,[id]);assert.deepEqual(cancelled,[]);assert.equal(listeners.size,0);
});

test('failed start unregisters its cancellation listener',async()=>{
  const {service,listeners,registrations,unregistrations}=harness({start:async()=>{throw new Error('start failed');}});
  await assert.rejects(()=>service.start({},51));
  assert.equal(listeners.size,0);assert.equal(registrations.length,1);assert.equal(unregistrations.length,1);
});

test('failed cancellation-listener registration is cleaned up and reported',async()=>{
  const {service,listeners,requests,registrations,unregistrations}=harness({register:()=>{throw new Error('listener registration failed');}});
  await assert.rejects(()=>service.start({},61),/listener registration failed/);
  assert.equal(listeners.size,0);assert.equal(requests.length,0);assert.equal(registrations.length,1);assert.equal(unregistrations.length,1);
});

test('failed normal stop restores cancellation handling and retains ownership',async()=>{
  const {service,listeners,emit}=harness({stop:async()=>{throw new Error('stop failed');}});const cancelled=[];
  const id=await service.start({},71,generation=>cancelled.push(generation));
  await assert.rejects(()=>service.stop(71),/stop failed/);
  assert.equal(listeners.size,1);emit({id,reason:1});
  assert.deepEqual(cancelled,[71]);assert.equal(listeners.size,0);
});
