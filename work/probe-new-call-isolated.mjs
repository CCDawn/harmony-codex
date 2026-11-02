import {CompanionCallJournal} from '../src/companionCallLifecycle.js';
import {fileURLToPath} from 'node:url';
import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const c=new CompanionDesktopClient();
const journal=new CompanionCallJournal(fileURLToPath(new URL('../voice/voice-scratch/owned-calls/',import.meta.url)));
let allocatedId=null;
try {
 const sdp=await c.invoke(`if(window.__harmonyVoiceProbe)throw Error('Probe already exists');const pc=new RTCPeerConnection();window.__harmonyVoiceProbe=pc;pc.addTransceiver('audio',{direction:'sendrecv'});pc.createDataChannel('oai-events',{ordered:true});await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>{if(pc.iceGatheringState==='complete')return resolve();let timer=setTimeout(resolve,4000);pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};});return pc.localDescription.sdp;`);
 console.log(JSON.stringify({stage:'browser-offer',bytes:sdp.length}));
 const call=await c.start({sdp});
 allocatedId=call.callId;journal.put({version:1,profileId:c.profile.id,roomId:c.profile.roomId,callId:allocatedId,ownerPid:process.pid,createdAt:new Date().toISOString()});
 console.log(JSON.stringify({stage:'create',allocated:!!call.callId}));
 await c.invoke(`await window.__harmonyVoiceProbe.setRemoteDescription({type:'answer',sdp:params.sdp});return {applied:true};`,{sdp:call.sdp});
 await c.attach();
 console.log(JSON.stringify(await c.invoke(`const pc=window.__harmonyVoiceProbe;await new Promise(resolve=>{const t=setTimeout(resolve,20000);pc.onconnectionstatechange=()=>{if(['connected','failed','closed'].includes(pc.connectionState)){clearTimeout(t);resolve();}};if(pc.connectionState==='connected'){clearTimeout(t);resolve();}});return {stage:'media',state:pc.connectionState};`)));
} catch(e){console.log(JSON.stringify({failed:true,status:e.status||0,name:e.name}));}
finally {try{await c.stop();if(allocatedId)journal.remove(allocatedId);console.log(JSON.stringify({stage:'cleanup',confirmed:true,allocated:!!allocatedId}));}catch(e){console.log(JSON.stringify({stage:'cleanup',confirmed:false,status:e.status||0}));}try{await c.invoke(`window.__harmonyVoiceProbe?.close();delete window.__harmonyVoiceProbe;return {cleaned:true};`);}catch{}c.close();}
