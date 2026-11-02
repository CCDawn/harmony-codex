import asyncio,sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'voice'))
from companion_session import CompanionSession
class Probe(CompanionSession):
    async def _read_rpc_response(self,process,request_id,timeout_s):
        while True:
            result=json.loads(await asyncio.wait_for(process.stdout.readline(),timeout_s))
            if 'diagnostic' in result:
                print(json.dumps(result),flush=True)
                continue
            print(json.dumps({'rpc':request_id,'ok':not bool(result.get('error')),'error':result.get('error')}),flush=True)
            return result
async def main():
    s=Probe(object(),helper_path=Path(__file__).with_name('diagnostic-companion-helper.mjs'))
    try:
        await s._start_helper();await s._discover_profile();await s.setup_webrtc(None);await s.wait_media_connected()
        print('media_connected',flush=True)
    except Exception as e: print('probe_failed '+type(e).__name__,flush=True)
    finally: await s.cleanup()
asyncio.run(main())
