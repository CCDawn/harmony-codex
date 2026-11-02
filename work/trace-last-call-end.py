import json
from pathlib import Path
p=Path('logs/archive/2026-10-08T15-22-29-525Z_run_de45ae36-5077-43d1-93c5-1da441bf0059/harmony-app.jsonl')
for l in p.read_text(encoding='utf-8').splitlines():
 e=json.loads(l);t=e.get('timestamp',''); event=e.get('event','');d=e.get('data',{})
 if '2026-10-08T16:02'<=t<='2026-10-08T16:05' and any(x in event for x in ['voice','lifecycle','background','foreground']):
  print(json.dumps({'timestamp':t,'event':event,'status':d.get('status'),'detail':d.get('detail'),'reason':d.get('reason')},ensure_ascii=False))
for l in Path('voice/voice-server.log').read_text(encoding='utf-8',errors='replace').splitlines():
 if 'server-boot' in l: print(l)
