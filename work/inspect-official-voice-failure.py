from pathlib import Path
import os,re,json
root=Path(os.environ['LOCALAPPDATA'])/'Codex/Logs'
files=sorted(root.glob('2026/10/*/*.log'),key=lambda p:p.stat().st_mtime,reverse=True)[:5]
for p in files:
 for line in p.read_text(encoding='utf-8',errors='replace').splitlines():
  if 'Orbit voice call failed' in line or 'Orbit voice call cleanup failed' in line:
   print(json.dumps({'timestamp':line[:24],'event':'cleanup_failed' if 'cleanup failed' in line else 'official_voice_failed','http502':bool(re.search(r'502',line)),'errorCode502': 'error code: 502' in line,'errorType':'HTTP' if 'status' in line or '502' in line else 'unspecified'},ensure_ascii=False))
