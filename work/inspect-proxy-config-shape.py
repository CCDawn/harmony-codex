from pathlib import Path
import os,yaml,json,urllib.request
p=Path(os.environ['APPDATA'])/'com.follow/clash/config.yaml'
d=yaml.safe_load(p.read_text(encoding='utf-8'))
print(json.dumps({'configKeys':list(d.keys()),'proxyCount':len(d.get('proxies',[])),'groupCount':len(d.get('proxy-groups',[])),'ruleCount':len(d.get('rules',[])),'usProxyPresent':any(x.get('name')=='🇺🇸 美国 01' for x in d.get('proxies',[]))},ensure_ascii=False))
