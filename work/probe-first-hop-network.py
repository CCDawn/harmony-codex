import json,os,socket,time,urllib.request,yaml
from pathlib import Path
api=urllib.request.build_opener(urllib.request.ProxyHandler({}))
with api.open('http://127.0.0.1:9090/proxies',timeout=5) as r:proxies=json.load(r)['proxies']
name=proxies['① 第一跳']['now']
config=yaml.safe_load((Path(os.environ['APPDATA'])/'com.follow/clash/config.yaml').read_text(encoding='utf-8'))
node=next(p for p in config['proxies'] if p['name']==name)
measure=[]
for i in range(6):
 begin=time.monotonic()
 try:
  with socket.create_connection((node['server'],node['port']),timeout=4):pass
  measure.append({'ok':True,'ms':round((time.monotonic()-begin)*1000)})
 except Exception as e:measure.append({'ok':False,'errorType':type(e).__name__})
 time.sleep(.2)
print(json.dumps({'firstHopTcp':measure},ensure_ascii=True),flush=True)
