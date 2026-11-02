import json,os,urllib.request,urllib.error,time
from pathlib import Path
base='https://chatgpt.com/backend-api'
auth=json.loads((Path(os.environ['USERPROFILE'])/'.codex/auth.json').read_text(encoding='utf-8'))['tokens']
receipt=json.loads(next(Path('voice/voice-scratch/owned-calls').glob('*.json')).read_text(encoding='utf-8-sig'))
http=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}))
headers={'Authorization':'Bearer '+auth['access_token'],'ChatGPT-Account-ID':auth['account_id'],'Content-Type':'application/json','User-Agent':'Codex','Connection':'close'}
def request(route,method='GET'):
 start=time.monotonic()
 try:r=http.open(urllib.request.Request(base+route,method=method,headers=headers,data=b'{}' if method=='POST' else None),timeout=25)
 except urllib.error.HTTPError as e:r=e
 except Exception as e:
  print(json.dumps({'method':method,'status':0,'networkError':type(getattr(e,'reason',e)).__name__,'durationMs':round((time.monotonic()-start)*1000)}),flush=True)
  return 0,b'' 
 with r:
  raw=r.read();status=r.status
  print(json.dumps({'method':method,'route':'profile' if route=='/tbo/primary' else 'owned-call-stop','status':status,'server':r.headers.get('server'),'contentType':r.headers.get('content-type'),'cfLocation':(r.headers.get('cf-ray') or '').split('-')[-1],'durationMs':round((time.monotonic()-start)*1000)}),flush=True)
  return status,raw
status,body=request('/tbo/primary')
if status!=200:raise SystemExit('Profile preflight failed; no call action sent')
profile=json.loads(body).get('profile',{})
if profile.get('id')!=receipt['profileId'] or profile.get('messaging_room_id')!=receipt['roomId']:raise SystemExit('Identity mismatch; no call action sent')
print('same_assistant_verified',flush=True)
request('/tbo/'+receipt['profileId']+'/voice/calls/'+receipt['callId']+'/stop','POST')
