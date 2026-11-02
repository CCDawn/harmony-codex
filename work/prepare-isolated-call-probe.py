from pathlib import Path
p=Path('work/probe-browser-voice.mjs');s=p.read_text(encoding='utf-8')
s="import {CompanionCallJournal} from '../src/companionCallLifecycle.js';\nimport {fileURLToPath} from 'node:url';\n"+s
s=s.replace('const c=new CompanionDesktopClient();',"const c=new CompanionDesktopClient();\nconst journal=new CompanionCallJournal(fileURLToPath(new URL('../voice/voice-scratch/owned-calls/',import.meta.url)));\nlet allocatedId=null;")
s=s.replace(" console.log(JSON.stringify({stage:'create',allocated:!!call.callId}));", " allocatedId=call.callId;journal.put({version:1,profileId:c.profile.id,roomId:c.profile.roomId,callId:allocatedId,ownerPid:process.pid,createdAt:new Date().toISOString()});\n console.log(JSON.stringify({stage:'create',allocated:!!call.callId}));")
s=s.replace('try{await c.stop();}catch{}', "try{await c.stop();if(allocatedId)journal.remove(allocatedId);console.log(JSON.stringify({stage:'cleanup',confirmed:true,allocated:!!allocatedId}));}catch(e){console.log(JSON.stringify({stage:'cleanup',confirmed:false,status:e.status||0}));}")
Path('work/probe-new-call-isolated.mjs').write_text(s,encoding='utf-8')
