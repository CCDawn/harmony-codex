from pathlib import Path
import os,json,yaml,urllib.request,urllib.parse,subprocess,time,sys
sys.stdout.reconfigure(encoding='utf-8')
api='http://127.0.0.1:9090'
http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def request(route,data=None,method='GET'):
 payload=None if data is None else json.dumps(data,ensure_ascii=False).encode()
 with http.open(urllib.request.Request(api+route,data=payload,method=method,headers={'Content-Type':'application/json'}),timeout=15) as response:
  body=response.read();return json.loads(body) if body else None
p=Path(os.environ['APPDATA'])/'com.follow/clash/config.yaml'
original=p.read_text(encoding='utf-8');config=yaml.safe_load(original)
current=request('/configs')
for key in ['mixed-port','port','socks-port','mode','allow-lan','ipv6']:
 if current.get(key)!=config.get(key):raise RuntimeError('Live config mismatch: '+key)
proxies=request('/proxies')['proxies']
selected={name:item['now'] for name,item in proxies.items() if item.get('type')=='Selector' and 'now' in item and name!='GLOBAL'}
route='🇺🇸 美国 01'
if not any(x.get('name')==route for x in config.get('proxies',[])):raise RuntimeError('Alternative unavailable')
def restore_selection():
 for name,value in selected.items():request('/proxies/'+urllib.parse.quote(name,safe=''),{'name':value},'PUT')
def traffic():
 return {x['id']:{'host':x['metadata'].get('host'),'chains':x.get('chains',[]),'upload':x.get('upload',0)} for x in request('/connections')['connections'] if x['metadata'].get('host') in ['chatgpt.com','chat.openai.com']}
config['rules']=['DOMAIN,chatgpt.com,'+route,'DOMAIN,chat.openai.com,'+route]+config['rules']
try:
 request('/configs?force=false',{'payload':yaml.safe_dump(config,allow_unicode=True)},'PUT')
 restore_selection()
 applied=request('/rules')['rules'][:2]
 print(json.dumps({'temporaryRules':applied},ensure_ascii=False),flush=True)
 before=traffic()
 result=subprocess.run(['python','work/probe-fresh-http-voice.py'],capture_output=True,text=True,timeout=70)
 print(result.stdout,flush=True)
 print(json.dumps({"probeExitCode":result.returncode}),flush=True)
 after=traffic()
 changed=[{'host':v['host'],'chains':v['chains'],'uploadedBytes':v['upload']-before.get(k,{}).get('upload',0)} for k,v in after.items() if v['upload']>before.get(k,{}).get('upload',0)]
 print(json.dumps({'observedTraffic':changed},ensure_ascii=False),flush=True)
finally:
 request('/configs?force=false',{'payload':original},'PUT');restore_selection()
 restored=request('/rules')['rules']
 print(json.dumps({'restored':len(restored)==len(yaml.safe_load(original)['rules']) and restored[0]!=applied[0] if 'applied' in locals() else True,'ruleCount':len(restored)},ensure_ascii=False),flush=True)


