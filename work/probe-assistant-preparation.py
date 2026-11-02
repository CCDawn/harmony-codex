import asyncio,sys,json,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'voice'))
from companion_session import CompanionSession
class Probe(CompanionSession):
    async def _read_rpc_response(self,process,request_id,timeout_s):
        result=await super()._read_rpc_response(process,request_id,timeout_s)
        error=result.get('error')
        print(json.dumps({'rpc':request_id,'ok':not bool(error),'error':error if isinstance(error,str) and (error=='Companion request failed' or __import__('re').fullmatch(r'Companion HTTP [1-5][0-9]{2}',error)) else None}),flush=True)
        return result
async def main():
    s=Probe(object())
    try:
        await s._start_helper()
        await s._discover_profile()
        print('discover_ok',flush=True)
        await s.setup_webrtc(None)
        await s.wait_media_connected()
        print('media_connected',flush=True)
    except Exception as e:
        print('probe_failed '+type(e).__name__,flush=True)
    finally:
        await s.cleanup()
asyncio.run(main())
