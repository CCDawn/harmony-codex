"""Offline startup cancellation tests: no microphone or real upstream calls."""
import asyncio
import json
import unittest
from unittest import mock
from companion_session_harness import CS, VS


class Socket:
    def __init__(self):
        self.frames = asyncio.Queue()
        self.sent = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.frames.get()
        if item is None:
            raise StopAsyncIteration
        return json.dumps(item)

    async def send(self, raw):
        self.sent.append(json.loads(raw))


class StartupCancellation(unittest.IsolatedAsyncioTestCase):
    async def test_handler_does_not_release_busy_gate_after_incomplete_cleanup(self):
        ws = Socket()
        ws.recv = mock.AsyncMock(return_value='{"type":"start"}')
        previous = VS._active
        VS._active = None
        pending = mock.Mock(cleanup_pending=True, close_sent=True, stopped=True,
                            run=mock.AsyncMock(side_effect=RuntimeError('cleanup incomplete')))
        try:
            with mock.patch.object(CS, 'CompanionSession', return_value=pending):
                await VS.handler(ws)
            self.assertIs(VS._active, pending)
        finally:
            VS._active = previous

    async def test_media_release_exception_does_not_skip_owned_call_cleanup(self):
        session = CS.CompanionSession(Socket())
        session._owns_call = True
        session.call_id = 'rtc_cleanup'
        session.track = mock.Mock()
        session.track.halt_stream.side_effect = RuntimeError('private')
        session.pc = mock.Mock(close=mock.AsyncMock())
        session._rpc = mock.AsyncMock(return_value={'ok': True})
        session._stop_helper = mock.AsyncMock()
        await session.cleanup()
        session.pc.close.assert_awaited_once()
        session._rpc.assert_awaited_once_with('stop', {}, timeout_s=CS.RPC_STOP_TIMEOUT_S)
        session._stop_helper.assert_awaited_once()

    async def test_safe_error_category_and_stage_survive_rpc_without_private_text(self):
        from companion_session_harness import FakeHelperProcess
        for code, stage, expected in [('timeout', 'create', 'timeout'),
                                      ('private-token', 'private-sdp', 'unknown_error')]:
            session = CS.CompanionSession(Socket())
            session.helper = FakeHelperProcess(lambda _: {})
            session._read_rpc_response = mock.AsyncMock(return_value={
                'id': 1, 'error': 'private upstream body', 'errorCode': code, 'stage': stage})
            with self.assertRaises(CS.CompanionSessionError) as caught:
                await session._rpc('start')
            self.assertEqual(caught.exception.error_code, expected)
            self.assertEqual(caught.exception.stage, stage if stage == 'create' else 'unknown')
            self.assertNotIn('private', str(caught.exception))

    async def test_rpc_timeout_is_classified_with_operation(self):
        from companion_session_harness import FakeHelperProcess
        session = CS.CompanionSession(Socket())
        session.helper = FakeHelperProcess(lambda _: {})
        session._read_rpc_response = mock.AsyncMock(side_effect=TimeoutError())
        with self.assertRaises(CS.CompanionSessionError) as caught:
            await session._rpc('start')
        self.assertEqual(caught.exception.operation, 'start')
        self.assertEqual(caught.exception.error_code, 'timeout')

    async def test_new_connection_is_busy_while_old_call_cleanup_is_pending(self):
        ws = Socket()
        ws.recv = mock.AsyncMock(return_value='{"type":"start"}')
        ws.close = mock.AsyncMock()
        previous = VS._active
        VS._active = mock.Mock(close_sent=True, stopped=True, cleanup_pending=True)
        try:
            with mock.patch.object(CS, 'CompanionSession') as factory:
                await VS.handler(ws)
                factory.assert_not_called()
            self.assertEqual(ws.sent, [{'type': 'busy'}])
            ws.close.assert_awaited_once()
        finally:
            VS._active = previous

    async def test_stop_or_disconnect_during_discovery_prevents_call_creation(self):
        for frame in ({"type": "stop"}, None):
            with self.subTest(frame=frame):
                ws = Socket()
                session = CS.CompanionSession(ws)
                entered = asyncio.Event()
                async def discover():
                    entered.set()
                    await asyncio.Event().wait()
                session._start_helper = mock.AsyncMock()
                session._discover_profile = discover
                session.setup_webrtc = mock.AsyncMock()
                session._stop_helper = mock.AsyncMock()
                running = asyncio.create_task(session.run())
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    await ws.frames.put(frame)
                    await asyncio.wait_for(asyncio.shield(running), .2)
                    session.setup_webrtc.assert_not_awaited()
                    self.assertFalse(any(e['type'] in ('ready', 'error') for e in ws.sent))
                finally:
                    running.cancel()
                    await asyncio.gather(running, return_exceptions=True)

    async def test_cancel_during_create_releases_media_then_cleans_late_receipt(self):
        ws = Socket()
        session = CS.CompanionSession(ws)
        entered, release, media_closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        session._start_helper = mock.AsyncMock()
        session._discover_profile = mock.AsyncMock()
        session._stop_helper = mock.AsyncMock()
        session.track = mock.Mock()
        session.pc = mock.Mock(close=mock.AsyncMock(side_effect=media_closed.set))
        async def rpc(method, *args, **kwargs):
            if method == 'start':
                entered.set()
                await release.wait()
                return {'callId': 'rtc_late', 'sdp': 'v=0\r\nanswer'}
            return {'ok': True}
        session._rpc = mock.AsyncMock(side_effect=rpc)
        session.after_remote_description = mock.AsyncMock()
        async def setup(_):
            await session.exchange_offer(None, 'v=0\r\noffer')
            await session.after_remote_description()
        session.setup_webrtc = setup
        running = asyncio.create_task(session.run())
        try:
            await asyncio.wait_for(entered.wait(), 1)
            await ws.frames.put({'type': 'stop'})
            await asyncio.wait_for(media_closed.wait(), .2)
            self.assertTrue(session.cleanup_pending)
            session.track.halt_stream.assert_called_once()
            release.set()
            await asyncio.wait_for(running, 1)
            session.after_remote_description.assert_not_awaited()
            self.assertEqual([c.args[0] for c in session._rpc.await_args_list], ['start', 'stop'])
            self.assertFalse(session._owns_call)
            self.assertFalse(session.cleanup_pending)
            self.assertFalse(any(e['type'] in ('ready', 'error') for e in ws.sent))
        finally:
            release.set()
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


if __name__ == '__main__':
    unittest.main()
