from pathlib import Path
import os, json, re
root = Path(os.environ['LOCALAPPDATA'])/'Codex/Logs/2026/10/13'
for p in root.glob('*.log'):
    for line in p.read_text(encoding='utf-8', errors='replace').splitlines():
        if line[:19] < '2026-10-13T14:00:00':
            continue
        if '/voice/calls' not in line and 'Orbit voice call' not in line:
            continue
        public = line.split('sensitive=')[0]
        fields = {}
        for key in ['status', 'statusCode', 'httpStatus', 'durationMs', 'elapsedMs', 'duration', 'method', 'errorCode']:
            match = re.search(r'\b'+key+r'[=: ]+["\']?([A-Za-z0-9_.-]+)', public)
            if match: fields[key] = match.group(1)
        fields['timestamp'] = line[:24]
        fields['event'] = 'voice_cleanup' if '/stop' in public or 'cleanup' in public else 'voice_attach' if '/attach' in public else 'voice_create'
        fields['httpCodes'] = re.findall(r'\b(?:401|403|429|500|502|503|504)\b', public)
        fields['timeout'] = bool(re.search(r'timeout|timed out|ETIMEDOUT', public, re.I))
        fields['networkErrors'] = re.findall(r'\b(?:ERR_[A-Z_]+|ECONN[A-Z]+|ETIMEDOUT)\b', public)
        print(json.dumps(fields))
