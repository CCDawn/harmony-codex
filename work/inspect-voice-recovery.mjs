import fs from 'node:fs';
const tree=JSON.parse(fs.readFileSync('work/phone-voice-recovery/visible-layout.json','utf8'));
const texts=[];
function walk(v){if(!v||typeof v!=='object')return;if(v.attributes?.text)texts.push(v.attributes.text);for(const [k,x]of Object.entries(v)){if(k!=='attributes')if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object')walk(x);}}
walk(tree);
fs.writeFileSync('work/phone-voice-recovery/visible-text.json',JSON.stringify({capturedAt:new Date().toISOString(),source:'phone UI recovery capture, not official history',texts},null,2));
console.log(JSON.stringify({textNodes:texts.length,callActive:texts.some(t=>t.includes('通话中')),listening:texts.some(t=>t.includes('正在聆听')),saveFailureVisible:texts.some(t=>t.includes('保存失败'))}));
