import runpy,asyncio,json
from unittest import mock
m=runpy.run_path('test/companion_session_harness.py',run_name='cleanup_audit')
CS=m['CS']
async def main():
 s=CS.CompanionSession(object());s._owns_call=True;s.call_id='rtc_audit-owned'
 s._rpc=mock.AsyncMock(side_effect=CS.CompanionSessionError('Companion request timed out'))
 s._stop_helper=mock.AsyncMock()
 await s.cleanup()
 print(json.dumps({'stopConfirmed':False,'retainsOwnership':s._owns_call,'retainsCallId':s.call_id is not None,'helperShutdownRequested':s._stop_helper.await_count==1}))
asyncio.run(main())
