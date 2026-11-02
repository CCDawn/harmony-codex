import fs from 'node:fs';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';
import { CompanionCallJournal } from '../src/companionCallLifecycle.js';
import { fileURLToPath } from 'node:url';

const client = new CompanionDesktopClient();
const journal = new CompanionCallJournal(fileURLToPath(new URL('../voice/voice-scratch/owned-calls/', import.meta.url)));
const evidence = [];
let owned = null, installed = false;
const record = data => { evidence.push(data); console.log(JSON.stringify(data)); };
try {
  const profile = await client.discover();
  // Never compete with a helper holding an active allocation.
  for (const receipt of journal.list()) {
    if (receipt.profileId !== profile.id || receipt.roomId !== profile.roomId) continue;
    let live = true; try { process.kill(receipt.ownerPid, 0); } catch(e) { live = e.code !== 'ESRCH'; }
    if (live) throw new Error('active_owned_call');
  }
  await client.invoke(`
if (window.__harmonyCreateTrace) throw Error('Diagnostic already running');
const state = { phase:'offer', started:Date.now(), headersMs:null, status:null, callId:null };
window.__harmonyCreateTrace=state;
const pc=new RTCPeerConnection(); state.pc=pc;
const controller=new AbortController(); state.controller=controller;
const timer=setTimeout(()=>controller.abort(new DOMException('Diagnostic deadline','TimeoutError')),70000);
state.done=(async()=>{
 try {
  pc.addTransceiver('audio',{direction:'sendrecv'}); pc.createDataChannel('oai-events',{ordered:true});
  await pc.setLocalDescription(await pc.createOffer());
  state.phase='request';state.requestAt=Date.now();
  const response=await api.postResponse('/tbo/{tbo_id}/voice/calls',{
    parameters:{path:{tbo_id:params.id}},requestBody:{sdp:pc.localDescription.sdp},retry:false,signal:controller.signal,
    onResponseHeadersReceived:()=>{state.headersMs=Date.now()-state.requestAt;state.phase='headers';}
  });
  state.status=response.status;state.callId=response.headers.get('location')?.split('?')[0]?.split('/').at(-1);
  state.phase='body';
  const sdp=await response.text();state.answerBytes=sdp.length;state.phase='complete';
 } catch(error) {
  state.status=Number.isInteger(error?.status)?error.status:state.status;
  state.errorName=['AbortError','TimeoutError'].includes(error?.name)?error.name:'Error';
  state.failedPhase=state.phase;state.phase='error';
 } finally {clearTimeout(timer);pc.close();state.ended=Date.now();}
})();
return {started:true};`, profile);
  installed = true;
  let last = '';
  for (let i=0;i<85;i++) {
    const s=await client.client.evaluate(`(()=>{const s=window.__harmonyCreateTrace;return s?{phase:s.phase,status:s.status,headersMs:s.headersMs,elapsedMs:Date.now()-s.started,callId:s.callId,answerBytes:s.answerBytes,failedPhase:s.failedPhase,errorName:s.errorName}:null;})()`,5000);
    if(!s) throw new Error('diagnostic_state_missing');
    if(/^rtc_[A-Za-z0-9_-]+$/.test(s.callId||'') && !owned) {
      owned=s.callId; client.callId=owned;
      journal.put({version:1,profileId:profile.id,roomId:profile.roomId,callId:owned,ownerPid:process.pid,createdAt:new Date().toISOString()});
    }
    const {callId,...safe}=s;
    safe.allocated=!!owned;
    if(s.phase!==last || ['complete','error'].includes(s.phase)) { record(safe);last=s.phase; }
    if(['complete','error'].includes(s.phase))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
} catch(e) {record({failed:true,errorCode:['timeout','cdp_connection','http_error'].includes(e.errorCode)?e.errorCode:'diagnostic_error'});}
finally {
  if (installed) {
    await client.client.ensureConnected().catch(()=>{});
    // If polling failed, still collect a known allocation before removing state.
    const s=await client.client.evaluate(`(async()=>{const s=window.__harmonyCreateTrace;if(!s)return null;s.controller.abort();await s.done;return {callId:s.callId};})()`,10000).catch(()=>null);
    if(!owned && /^rtc_[A-Za-z0-9_-]+$/.test(s?.callId||'')) {
      owned=s.callId;client.callId=owned;
      journal.put({version:1,profileId:client.profile.id,roomId:client.profile.roomId,callId:owned,ownerPid:process.pid,createdAt:new Date().toISOString()});
    }
    if(owned){try{await client.stop();journal.remove(owned);record({cleanup:'confirmed'});}catch{record({cleanup:'pending_receipt_retained'});}}
    await client.client.evaluate('delete window.__harmonyCreateTrace',5000).catch(()=>{});
  }
  client.close();
  fs.writeFileSync(new URL('./trace-call-create-20261013.json',import.meta.url),JSON.stringify(evidence,null,2));
}
