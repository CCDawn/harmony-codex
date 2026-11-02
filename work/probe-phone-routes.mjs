import fs from 'node:fs';
import { generateTotp } from '../src/totp.js';
const text=fs.readFileSync(new URL('../HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets',import.meta.url),'utf8');
const v=n=>text.match(new RegExp(n+`:\\s*string\\s*=\\s*['"]([^'"]*)['"]`))?.[1]||'';
const headers={'X-Codex-Bridge-Token':v('DEFAULT_BRIDGE_TOKEN')};
if(v('DEFAULT_BRIDGE_TOTP_SECRET'))headers['X-Codex-Bridge-OTP']=generateTotp(v('DEFAULT_BRIDGE_TOTP_SECRET'));
for(const [label,base] of [['local','http://127.0.0.1:8787'],['configured',v('DEFAULT_BRIDGE_URL')],['aliyun-bridge','https://cdawn.xyz/bridge']]) {
 await Promise.all(['/health','/api/codex/threads?limit=50','/api/codex/runtime-snapshot','/companion/profile'].map(async route=>{
  const start=Date.now();try{const r=await fetch(base+route,{headers,signal:AbortSignal.timeout(20000)});const t=await r.text();let b;try{b=JSON.parse(t)}catch{};console.log(JSON.stringify({label,route,status:r.status,ms:Date.now()-start,bytes:t.length,threads:b?.threads?.length,error:typeof b?.error==='string'?b.error.slice(0,160):undefined}));}catch(e){console.log(JSON.stringify({label,route,error:e.name,ms:Date.now()-start}));}
 }));
}


