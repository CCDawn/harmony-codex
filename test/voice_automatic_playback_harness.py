"""Automatic input must not permanently gate a still-running upstream reply."""
import asyncio
import json
import types
import unittest
from unittest import mock

from companion_session_harness import CS


class AutomaticPlaybackTests(unittest.IsolatedAsyncioTestCase):
    def session(self):
        s = CS.CompanionSession(types.SimpleNamespace(send=mock.AsyncMock()))
        s.playback_control_enabled = True
        s._phone_ready = True
        s.speaking = True
        s.send_json = mock.AsyncMock()
        # Model a VAD false positive. An acoustic classifier is not a cancel ack.
        s.barge_in_detector = types.SimpleNamespace(feed=mock.Mock(return_value=True))
        s.out_buf.extend(b"reply audio")
        return s

    async def drain(self, s):
        if s._playback_events:
            await asyncio.gather(*list(s._playback_events))

    async def test_noise_onset_without_new_turn_preserves_reply_audio(self):
        s = self.session()
        await s.on_microphone_audio(bytes(3200))
        await self.drain(s)
        self.assertTrue(s.should_send_output())
        self.assertEqual(s.out_buf, b"reply audio")
        s.send_json.assert_not_awaited()

    async def test_user_transcript_is_not_a_voice_cancellation_ack(self):
        s = self.session()
        s._observe_playback_turn("old", "assistant")
        s._observe_playback_turn("possible-user", "user")
        await self.drain(s)
        self.assertTrue(s.should_send_output())
        self.assertEqual(s.out_buf, b"reply audio")
        s.send_json.assert_not_awaited()

    async def test_input_continues_unchanged_while_assistant_speaks(self):
        s = self.session()
        pcm = bytes(range(256)) * 12
        async def frames():
            yield pcm
            yield json.dumps({"type": "stop"})
        class Socket:
            def __aiter__(self):
                return frames()
        s.ws = Socket()
        s.track = types.SimpleNamespace(halt=False, push=mock.AsyncMock())
        await s.recv_loop()
        s.track.push.assert_awaited_once_with(pcm)
        self.assertEqual(s.audio_bytes_in, len(pcm))


if __name__ == "__main__":
    unittest.main()
