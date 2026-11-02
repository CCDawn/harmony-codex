from pathlib import Path
import re,json
p=Path('work/companion-patch-voice-hilog.log')
s=p.read_text(encoding='utf-8',errors='replace')
lines=[l for l in s.splitlines() if 'callId' in l and 'rtc_' in l]
for l in lines[:1]:
 print(json.dumps({'timestamp':l[:18],'keys':re.findall(r'"([A-Za-z][A-Za-z0-9_]*)"\s*:',l),'idCount':len(set(re.findall(r'rtc_[A-Za-z0-9_-]+',l)))}))
ids=set(re.findall(r'rtc_[A-Za-z0-9_-]+','\n'.join(lines)))
print('unique_call_ids',len(ids))
if len(ids)==1: Path('work/last-successful-call-id.txt').write_text(next(iter(ids)),encoding='utf-8')
