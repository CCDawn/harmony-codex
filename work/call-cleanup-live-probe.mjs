import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CompanionCallJournal} from '../src/companionCallLifecycle.js';
const j=new CompanionCallJournal(fileURLToPath(new URL('../voice/voice-scratch/owned-calls/',import.meta.url)));
const before=j.list();
await new Promise(resolve=>{
 const ws=new WebSocket('ws://127.0.0.1:8790');
 const timer=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));ws.close();resolve();},55000);
 ws.onopen=()=>ws.send(JSON.stringify({type:'start'}));
 ws.onmessage=event=>{if(typeof event.data!=='string')return;const e=JSON.parse(event.data);
 if(['progress','ready','error','closed','busy'].includes(e.type))console.log(JSON.stringify({type:e.type,stage:e.stage,failureStage:e.failureStage,httpStatus:e.httpStatus}));
 if(e.type==='ready')ws.send(JSON.stringify({type:'stop'}));
 };
 ws.onclose=()=>{clearTimeout(timer);resolve();};
 ws.onerror=()=>{console.log(JSON.stringify({transportError:true}));clearTimeout(timer);resolve();};
});
const after=j.list();
console.log(JSON.stringify({pendingBefore:before.length,pendingAfter:after.length,oldReceiptsRetained:before.every(r=>after.some(a=>a.callId===r.callId))}));
