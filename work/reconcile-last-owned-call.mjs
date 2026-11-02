import fs from 'node:fs';
import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const c=new CompanionDesktopClient();
try {
 const id=fs.readFileSync('work/last-successful-call-id.txt','utf8').trim();
 if(!/^rtc_[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid owned call id');
 await c.discover();c.callId=id;
 const begin=Date.now();
 try{await c.stop();console.log(JSON.stringify({operation:'stop-exact-last-owned-call',confirmed:true,durationMs:Date.now()-begin}));}
 catch(e){console.log(JSON.stringify({operation:'stop-exact-last-owned-call',confirmed:false,status:e.status||0,durationMs:Date.now()-begin}));}
} finally {c.close();}
