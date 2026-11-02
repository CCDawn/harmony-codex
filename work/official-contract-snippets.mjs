import fs from 'node:fs';
import {CodexDesktopCdpClient} from '../src/codexDesktopCdpClient.js';
const c=new CodexDesktopCdpClient();
try{await c.ensureConnected();
 for(const name of ['app-shared-40678a67f0e3.js','app-initial-25361a10f2bf.js','app-primary-2b28b2369958.js']){
 const result=await c.evaluate(`(async()=>{const s=await(await fetch('app://-/assets/${name}')).text();const re=new RegExp(${JSON.stringify(process.argv[2]||'transcript|connected_at|duration_ms|ended_at')},'g');return {length:s.length,hits:[...s.matchAll(re)].slice(0,200).map(m=>({at:m.index,text:s.slice(Math.max(0,m.index-400),m.index+800)}))};})()`,30000);
 fs.writeFileSync('work/official-companion-contract/'+name+'.snippets.json',JSON.stringify(result,null,2));
 console.log(name,result.length,result.hits.length);
 }
}finally{c.close();}
