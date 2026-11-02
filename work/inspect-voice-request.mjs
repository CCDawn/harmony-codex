import {CodexDesktopCdpClient} from '../src/codexDesktopCdpClient.js';
import {spawn} from 'node:child_process';
const c=new CodexDesktopCdpClient();
try {
 await c.ensureConnected();
 const voiceRequests=new Set();
 c.socket.addEventListener('message',event=>{
  const m=JSON.parse(event.data), p=m.params;
  if(m.method==='Network.responseReceived' && /\/voice\/calls/.test(p.response.url)) {
    voiceRequests.add(p.requestId);
    const r=p.response, headers=Object.fromEntries(Object.entries(r.headers).filter(([k])=>['server','content-type','via','cf-cache-status'].includes(k.toLowerCase())));
    console.log(JSON.stringify({event:'voice-http-response',status:r.status,origin:new URL(r.url).origin,headers,protocol:r.protocol,fromServiceWorker:r.fromServiceWorker}));
  }
  if(m.method==='Network.loadingFailed' && voiceRequests.has(p.requestId)) console.log(JSON.stringify({event:'voice-loading-failed',error:p.errorText}));
 });
 await c.call('Network.enable',{});
 const proc=spawn('.venv/Scripts/python.exe',['work/probe-assistant-preparation.py'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 proc.stdout.pipe(process.stdout);
 proc.stderr.on('data',()=>{});
 await new Promise(resolve=>proc.on('exit',resolve));
} finally {await c.call('Network.disable',{}).catch(()=>{});c.close();}
