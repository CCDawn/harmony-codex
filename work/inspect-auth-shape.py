from pathlib import Path
import json,os
p=Path(os.environ['USERPROFILE'])/'.codex/auth.json'
if p.exists():
 d=json.loads(p.read_text(encoding='utf-8'));print(json.dumps({'keys':list(d),'tokenKeys':list(d.get('tokens',{})),'hasAccountId':bool(d.get('tokens',{}).get('account_id'))}))
