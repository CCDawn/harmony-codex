import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const c=new CompanionDesktopClient();
try {
 const auth=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.codex/auth.json'),'utf8'));
 const jwt=JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1],'base64url').toString());
 const claim=jwt['https://api.openai.com/auth']||{};
 console.log(JSON.stringify({identityFields:Object.keys(claim)}));
 const identity={accountId:auth.tokens.account_id,userId:claim.chatgpt_user_id};
 if(!identity.accountId||!identity.userId)throw Error('Identity metadata missing');
 const baseline=await c.discover();
 const checked=await c.invoke(`const r=await api.safeGet('/tbo/primary',{expectedIdentity:params.identity,additionalHeaders:{'ChatGPT-Account-ID':params.identity.accountId},retry:false});return {sameProfile:r?.profile?.id===params.profileId};`,{identity,profileId:baseline.id});
 console.log(JSON.stringify({explicitIdentityCheck:checked}));
 const callId=fs.readFileSync('work/last-successful-call-id.txt','utf8').trim();
 const result=await c.invoke(`await api.safePost('/tbo/{tbo_id}/voice/calls/{call_id}/stop',{parameters:{path:{tbo_id:params.profileId,call_id:params.callId}},expectedIdentity:params.identity,additionalHeaders:{'ChatGPT-Account-ID':params.identity.accountId},keepalive:true,retry:false});return {stopped:true};`,{identity,profileId:baseline.id,callId});
 console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({failed:true,status:e.status||0,name:e.name}));}finally{c.close();}
