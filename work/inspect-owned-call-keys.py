from pathlib import Path
import re,json
l=next(l for l in Path('work/companion-patch-voice-hilog.log').read_text(encoding='utf-8',errors='replace').splitlines() if 'callId' in l and 'rtc_' in l)
print(json.dumps({'keys':re.findall(r'([A-Za-z][A-Za-z0-9_]*)=',l)}))
