import fs from 'node:fs';
import { generateTotp } from '../src/totp.js';
const config = fs.readFileSync('HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets','utf8');
const value = name => config.match(new RegExp(`${name}:\\s*string\\s*=\\s*['"]([^'"]*)['"]`))?.[1] || '';
const headers = {};
if(value('DEFAULT_BRIDGE_TOKEN')) headers['X-Codex-Bridge-Token']=value('DEFAULT_BRIDGE_TOKEN');
if(value('DEFAULT_BRIDGE_TOTP_SECRET')) headers['X-Codex-Bridge-OTP']=generateTotp(value('DEFAULT_BRIDGE_TOTP_SECRET'));
const get=async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();};
try{
const health=await get('/health');
const {profile}=await get('/companion/profile');
const result=await get(`/companion/messages?profileId=${encodeURIComponent(profile.id)}&roomId=${encodeURIComponent(profile.roomId)}`);
console.log(JSON.stringify({checkedAt:new Date().toISOString(),bridgeHealthy:health.ok,entries:result.entries?.length,callsPresent:Array.isArray(result.calls),calls:result.calls?.length,transcriptStates:[...new Set((result.calls??[]).map(c=>c.transcriptStatus))]}));
}catch(e){console.log(JSON.stringify({failed:true,error:e.message}));process.exitCode=1;}
