from pathlib import Path
p=Path('test/companion_session_harness.py');s=p.read_text(encoding='utf-8')
needle='    async def test_cleanup_stops_only_a_call_owned_by_this_session(self):'
new='''    async def test_failed_stop_preserves_ownership_for_reconciliation(self):
        session = CS.CompanionSession(ws=object())
        session._owns_call = True
        session.call_id = "rtc_owned-pending"
        session._rpc = mock.AsyncMock(side_effect=CS.CompanionSessionError("Companion request timed out"))
        session._stop_helper = mock.AsyncMock()
        await session.cleanup()
        self.assertTrue(session._owns_call)
        self.assertEqual(session.call_id, "rtc_owned-pending")
        self.assertGreaterEqual(CS.RPC_STOP_TIMEOUT_S, 30)
        session._stop_helper.assert_awaited_once_with()

'''
s=s.replace(needle,new+needle);p.write_text(s,encoding='utf-8')
