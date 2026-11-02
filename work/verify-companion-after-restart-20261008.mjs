import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTotp } from '../src/totp.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=fs.readFileSync(path.join(root,'HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets'),'utf8');
const value=name=>config.match(new RegExp(`${name}:\\s*string\\s*=\\s*['"]([^'"]*)['"]`))?.[1]||'';
const headers={'X-Codex-Bridge-Token':value('DEFAULT_BRIDGE_TOKEN'),'X-Codex-Bridge-OTP':generateTotp(value('DEFAULT_BRIDGE_TOTP_SECRET'))};
const output={verifiedAt:new Date().toISOString(),readOnly:true};
try {
  const started=Date.now();
  const response=await fetch('http://127.0.0.1:8787/companion/profile',{headers,signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  output.profileHttp=response.status;
  output.assistantName=response.ok ? body.profile?.name : null;
  output.assistantDiscovered=response.ok && typeof body.profile?.name==='string' && !!body.profile.name.trim();
  output.avatarPresent=!!body.profile?.avatarUrl;
  output.bindingPresent=!!body.profile?.id && !!body.profile?.roomId;
  output.elapsedMs=Date.now()-started;
} catch { output.profileHttp=0;output.expectedAssistant=false;output.failure='request-failed'; }
fs.writeFileSync(path.join(root,'work/companion-after-restart-verification-20261008.json'),JSON.stringify(output,null,2));
process.stdout.write(JSON.stringify(output));
