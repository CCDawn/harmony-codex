import fs from 'node:fs';
import {CodexDesktopCdpClient} from '../src/codexDesktopCdpClient.js';
const c=new CodexDesktopCdpClient();
try {
 await c.ensureConnected();
 const data=await c.evaluate(`(async()=>{
 const entry=[...document.scripts].find(s=>s.type==='module'&&s.src);
 const source=await (await fetch(entry.src)).text();
 const assets=[...new Set(source.match(/[A-Za-z0-9_-]+\\.js/g)||[])]; assets.push(entry.src.split("/").at(-1));
 const names=assets.filter(n=>/-[a-f0-9]{12}[.]js$/.test(n));
 names.push('app-primary-2b28b2369958.js');
 const seen=new Set(),sources=[];
 for(let i=0;i<names.length&&i<3000;i++){
 const name=names[i];if(seen.has(name))continue;seen.add(name);
 let s;try{s=await(await fetch(new URL(name,entry.src))).text();}catch{continue;}
 for(const ref of s.match(/[A-Za-z0-9_-]+-[a-f0-9]{12}[.]js/g)||[])if(/call|orbit|aeon|voice|messag|transcript|summary|app-/i.test(ref)&&!seen.has(ref)&&!names.includes(ref))names.push(ref);
 const hits=[...s.matchAll(/transcript_status|voice.calls|turn[.]done|summarizing|connected_at|ended_at|call_id/g)].map(m=>s.slice(Math.max(0,m.index-700),m.index+2000));
 if(hits.length)sources.push({name,source:hits.join("\\n---\\n")});
 }
 return {assets:[...seen],sources};
 })()`,60000);
 fs.mkdirSync('work/official-companion-contract',{recursive:true});
 for(const item of data.sources)fs.writeFileSync('work/official-companion-contract/'+item.name,item.source);
 console.log(JSON.stringify({assets:data.assets,bytes:data.sources.map(x=>({name:x.name,bytes:x.source.length}))}));
}finally{c.close();}






