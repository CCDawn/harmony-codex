"""Connection lifetime is independent of muted microphone uploads."""
import asyncio
import time
import unittest
from unittest import mock

from companion_session_harness import VS, CS


class ProbeSocket:
    def __init__(self, responding=True):
        self.responding = responding
        self.probes = []
        self.closed = False

    async def ping(self):
        pong = asyncio.get_running_loop().create_future()
        self.probes.append(pong)
        if self.responding:
            pong.set_result(0.001)
        return pong

    async def close(self):
        self.closed = True


class VoiceLivenessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.patch = mock.patch.multiple(VS, IDLE_TIMEOUT_S=0.2,
                                        CLIENT_PING_INTERVAL_S=0.02,
                                        HEALTH_INTERVAL_S=0.01)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.socket = ProbeSocket()
        # Exercise the production Companion subclass, not only the media base.
        self.session = CS.CompanionSession(self.socket)
        self.session.finish = mock.AsyncMock()
        self.task = None

    def start_watch(self):
        self.task = asyncio.create_task(self.session.idle_watch())

    async def asyncTearDown(self):
        self.task.cancel()
        await self.task

    async def test_muted_phone_survives_multiple_idle_windows_without_audio(self):
        self.start_watch()
        await asyncio.sleep(0.65)
        self.assertEqual(self.session.audio_bytes_in, 0)
        self.assertGreater(time.monotonic() - self.session.last_client_audio, 0.6)
        self.assertGreater(len(self.socket.probes), 3)
        self.session.finish.assert_not_awaited()
        self.assertFalse(self.socket.closed)

    async def test_no_audio_and_no_pong_still_expires(self):
        self.socket.responding = False
        self.start_watch()
        await asyncio.wait_for(self.task, 1)
        self.session.finish.assert_awaited_once_with('idle')
        self.assertTrue(self.socket.closed)
        self.assertEqual(self.session.last_client_pong, 0)

    async def test_old_pong_does_not_keep_a_disconnected_phone_alive(self):
        self.start_watch()
        await asyncio.sleep(0.06)
        self.assertGreater(self.session.last_client_pong, 0)
        self.socket.responding = False
        await asyncio.wait_for(self.task, 1)
        self.session.finish.assert_awaited_once_with('idle')

    async def test_arriving_audio_tolerates_delayed_control_pongs(self):
        self.socket.responding = False
        self.start_watch()
        for _ in range(30):
            self.session.last_client_audio = time.monotonic()
            await asyncio.sleep(0.02)
        self.session.finish.assert_not_awaited()
        self.assertFalse(self.socket.closed)

    async def test_teardown_cancels_outstanding_probe(self):
        self.socket.responding = False
        self.start_watch()
        await asyncio.sleep(0.03)
        self.task.cancel()
        await self.task
        self.assertTrue(self.socket.probes)
        self.assertTrue(all(probe.done() for probe in self.socket.probes))
        self.session.finish.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
