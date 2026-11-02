from pathlib import Path
p=Path('work/diagnostic-companion-helper.mjs');s=p.read_text(encoding='utf-8')
s=s.replace(" expression=expression.replace("," expression=expression.replace('(async()=>{try{','(async()=>{let probeHeaders={};try{').replace('requestBody:{sdp:params.sdp},retry:false','requestBody:{sdp:params.sdp},retry:false,onResponseHeaders:h=>{for(const k of [\"server\",\"content-type\",\"via\",\"cf-cache-status\"])probeHeaders[k]=h.get(k);probeHeaders.cloudflare=!!h.get(\"cf-ray\")}');\n expression=expression.replace(")
s=s.replace('diagnostic:{keys:Object.keys(error),','diagnostic:{headers:probeHeaders,messageLength:String(error?.message||\"\").length,bodyType:String(error?.message||\"\").trim().startsWith(\"<\")?\"html\":\"other\",diagnosticKeys:Object.keys(error?.requestDiagnostics||{}),keys:Object.keys(error),')
p.write_text(s,encoding='utf-8')
