from pathlib import Path
import re,json,os
paths=sorted((Path(os.environ['LOCALAPPDATA'])/'Codex/Logs/2026/10/08').glob('*.log'),key=lambda p:p.stat().st_mtime,reverse=True)[:3]
for p in paths:
 for line in p.read_text(encoding='utf-8',errors='replace').splitlines():
  if '/voice/calls' in line and ('502' in line or 'fail' in line.lower()):
   # Hide request-specific ids and any sensitive payload after its marker.
   line=line.split('sensitive=')[0]
   line=re.sub(r'(?i)(tbo_|rtc_)[a-z0-9_-]+','<id>',line)
   print(line[:1200])
