import struct,json,re
from pathlib import Path
p=Path('C:/Program Files/WindowsApps/OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0/app/resources/app.asar')
with p.open('rb') as f:
 head=f.read(16); offset=8+struct.unpack_from('<I',head,4)[0]; n=struct.unpack_from('<I',head,12)[0]; d=json.loads(f.read(n))
 files=d['files']['.vite']['files']['build']['files']
 name=next(k for k in files if k.startswith('main-') and k.endswith('.js'))
 item=files[name]; f.seek(offset+int(item['offset'])); s=f.read(item['size']).decode('utf-8')
 for term in ['backend-api','resolveUrl','proxy-server','setProxy','expectedPrincipal']:
  print('TERM',term)
  for m in list(re.finditer(re.escape(term),s))[:3]: print(s[max(0,m.start()-250):m.end()+450])

