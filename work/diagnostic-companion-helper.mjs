import readline from 'node:readline';
import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const client=new CompanionDesktopClient();
const original=client.client.evaluate.bind(client.client);
client.client.evaluate=async(expression,timeout)=>{
 expression=expression.replace('(async()=>{try{','(async()=>{let probeHeaders={};try{').replace('requestBody:{sdp:params.sdp},retry:false','requestBody:{sdp:params.sdp},retry:false,onResponseHeaders:h=>{for(const k of ["server","content-type","via","cf-cache-status"])probeHeaders[k]=h.get(k);probeHeaders.cloudflare=!!h.get("cf-ray")}');
 expression=expression.replace('name:String(error?.name||\'Error\')','name:String(error?.name||\'Error\'),diagnostic:{headers:probeHeaders,messageLength:String(error?.message||"").length,bodyType:String(error?.message||"").trim().startsWith("<")?"html":"other",diagnosticKeys:Object.keys(error?.requestDiagnostics||{}),keys:Object.keys(error),errorCode:error?.errorCode,errorKind:error?.errorKind,responseStatus:error?.responseStatus,networkTerms:["timeout","proxy","upstream","connect","reset","gateway","fetch","SDP","sdp","service","temporarily","capacity","rate"].filter(s=>String(error?.message||"").includes(s))}');
 const result=await original(expression,timeout);
 if(result?.__companionError) process.stdout.write(JSON.stringify({diagnostic:result.diagnostic})+'\n');
 return result;
};
try{for await(const line of readline.createInterface({input:process.stdin,terminal:false})) {
 const request=JSON.parse(line);
 try {const result=await client[request.method](request.params??{});process.stdout.write(JSON.stringify({id:request.id,result})+'\n');}
 catch(e){process.stdout.write(JSON.stringify({id:request.id,error:e?.status?`Companion HTTP ${e.status}`:'Companion request failed'})+'\n');}
}}finally{try{await client.stop();}catch{}client.close();}
