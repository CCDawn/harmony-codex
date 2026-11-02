from pathlib import Path
import re,json
for name in ['companion-patch-voice-hilog.log','companion-voice-device-hilog.log']:
 p=Path('work')/name
 lines=p.read_text(encoding='utf-8',errors='replace').splitlines()
 hits=[{'timestamp':l[:18],'ids':len(re.findall(r'rtc_[A-Za-z0-9_-]+',l)),'callIdField':'callId' in l} for l in lines if re.search(r'rtc_|callId|call_id',l)]
 print(json.dumps({'file':name,'hits':hits[:8]}))
