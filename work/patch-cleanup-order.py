from pathlib import Path
p=Path('voice/companion_session.py');s=p.read_text(encoding='utf-8')
s=s.replace('        await self._stop_owned_call()\n        if self.track:', '        # Release media immediately; upstream cleanup may be slow or unavailable.\n        if self.track:')
s=s.replace('        await self._stop_helper()\n', '        await self._stop_owned_call()\n        await self._stop_helper()\n')
p.write_text(s,encoding='utf-8')
p=Path('test/companion_session_harness.py');s=p.read_text(encoding='utf-8')
needle='    async def test_failed_stop_preserves_ownership_for_reconciliation(self):'
new='''    async def test_media_is_released_before_waiting_for_upstream_stop(self):
        session = CS.CompanionSession(ws=object())
        session._owns_call = True
        session.call_id = "rtc_owned-media"
        session.track = mock.Mock()
        session.pc = mock.Mock(close=mock.AsyncMock())
        async def stop(*args, **kwargs):
            session.track.halt_stream.assert_called_once_with()
            session.pc.close.assert_awaited_once_with()
            return {"ok": True}
        session._rpc = mock.AsyncMock(side_effect=stop)
        session._stop_helper = mock.AsyncMock()
        await session.cleanup()

'''
s=s.replace(needle,new+needle);p.write_text(s,encoding='utf-8')
