import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
import {CompanionCallJournal} from '../src/companionCallLifecycle.js';
const client=new CompanionDesktopClient();
try {
 const profile=await client.discover();
 const callId=fs.readFileSync('work/last-successful-call-id.txt','utf8').trim();
 const journal=new CompanionCallJournal(fileURLToPath(new URL('../voice/voice-scratch/owned-calls/',import.meta.url)));
 if(!journal.list().some(r=>r.callId===callId))journal.put({version:1,profileId:profile.id,roomId:profile.roomId,callId,ownerPid:process.pid,createdAt:'2026-10-08T15:59:29.613Z'});
 console.log(JSON.stringify({recoveredOwnReceipt:true,pendingReceipts:journal.list().length}));
}finally{client.close();}
