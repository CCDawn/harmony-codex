"""Playback gates, control ordering and microphone continuity, no provider calls."""
import asyncio
import json
import types
import unittest
from unittest import mock

from companion_session_harness import VS, CS
from playback_control import PlaybackControl


class PlaybackGateTests(unittest.TestCase):
    def test_manual_waits_for_user_and_fresh_assistant_not_old_or_unrelated_turn(self):
        gate = PlaybackControl()
        gate.assistant_started("old")
        self.assertEqual(gate.block(), 1)
        self.assertIsNone(gate.assistant_started("old"))
        self.assertIsNone(gate.assistant_started("unsolicited"))
        gate.user_started()
        self.assertIsNone(gate.assistant_started("unsolicited"))
        self.assertEqual(gate.assistant_started("new"), 2)
        self.assertFalse(gate.blocked)

    def test_block_after_active_user_and_double_interrupt_have_monotonic_revisions(self):
        gate = PlaybackControl()
        gate.user_started()
        gate.block()
        gate.block()
        self.assertEqual(gate.assistant_started("reply"), 3)
        gate.user_done()
        gate.block()
        self.assertIsNone(gate.assistant_started("next_without_user"))
        self.assertTrue(gate.blocked)

    def test_completed_history_is_bounded(self):
        gate = PlaybackControl()
        for n in range(1024):
            gate.assistant_started(str(n))
        self.assertEqual(len(gate._assistant_turns), 512)


class PlaybackSessionTests(unittest.IsolatedAsyncioTestCase):
    def make_session(self, negotiated=True):
        session = CS.CompanionSession(types.SimpleNamespace(send=mock.AsyncMock()))
        session.profile_id = "profile-test"
        session.room_id = "room-test"
        session.call_id = "rtc_test"
        session.playback_control_enabled = negotiated
        session._phone_ready = True
        session.speaking = True
        session.send_json = mock.AsyncMock()
        session.barge_in_detector = types.SimpleNamespace(feed=mock.Mock(return_value=True), available=True)
        return session

    async def drain_controls(self, session):
        if session._playback_events:
            await asyncio.gather(*list(session._playback_events))

    async def test_manual_blocks_old_audio_without_canceling_call_and_resumes_on_new_turn(self):
        s = self.make_session()
        s.out_buf.extend(b"old audio")
        s.playback_control.assistant_started("old")
        await s.on_client_interrupt()
        await self.drain_controls(s)
        self.assertFalse(s.should_buffer_output())
        self.assertFalse(s.should_send_output())
        self.assertEqual(s.out_buf, b"")
        self.assertFalse(s.stopped)
        self.assertFalse(s.requested_stop)
        self.assertFalse(s.close_sent)
        control = s.send_json.await_args_list[0].args[0]
        self.assertEqual(control, {"type": "playback", "state": "blocked", "revision": 1,
            "source": "manual", "profileId": "profile-test", "roomId": "room-test", "callId": "rtc_test"})
        s._observe_playback_turn("old", "assistant")
        s._observe_playback_turn("user", "user")
        s._observe_playback_turn("new", "assistant")
        self.assertFalse(s.should_send_output(), "PCM cannot precede the resumed control")
        await self.drain_controls(s)
        self.assertTrue(s.should_send_output())
        self.assertEqual(s.send_json.await_args.args[0]["state"], "resumed")

    async def test_legacy_phone_keeps_existing_clear_behavior_and_no_vad_trigger(self):
        s = self.make_session(negotiated=False)
        s.barge_in_detector.feed.return_value = False
        await s.on_microphone_audio(bytes(3200))
        s.barge_in_detector.feed.assert_not_called()
        await s.on_client_interrupt()
        self.assertFalse(s.playback_control.blocked)
        self.assertTrue(s.should_send_output())
        self.assertEqual(s.send_json.await_args.args[0], {"type": "speaking", "state": "stop"})

    async def test_user_turn_events_do_not_block_playback(self):
        s = self.make_session()
        event = {"type": "turn.created", "turn": {"id": "user", "role": "user", "transcript": "test"}}
        s.on_data_channel_message(json.dumps(event))
        s.on_data_channel_message(json.dumps(event))
        s.on_data_channel_message(json.dumps({"type": "turn.delta", "turn_id": "user", "delta": "test"}))
        await self.drain_controls(s)
        self.assertEqual(s.playback_control.revision, 0)
        s.on_data_channel_message(json.dumps({"type": "turn.done", "turn": {"id": "old", "role": "assistant", "transcript": "test"}}))
        self.assertFalse(s.playback_control.blocked)

    async def test_microphone_still_reaches_track_after_manual_blocks_output(self):
        s = self.make_session()
        await s.on_client_interrupt()
        pcm = bytes(3200)
        async def frames():
            yield pcm
            yield json.dumps({"type": "stop"})
        class Socket:
            def __aiter__(self):
                return frames()
        s.ws = Socket()
        s.track = types.SimpleNamespace(halt=False, push=mock.AsyncMock())
        await s.recv_loop()
        await self.drain_controls(s)
        s.track.push.assert_awaited_once_with(pcm)
        self.assertEqual(s.audio_bytes_in, 3200)

    async def test_old_recovery_cannot_release_new_block_and_identity_is_captured(self):
        s = self.make_session()
        s._block_playback("manual")
        s.playback_control.user_started()
        s._observe_playback_turn("reply", "assistant")
        s._block_playback("manual")
        s.call_id = "rtc_later"
        await self.drain_controls(s)
        self.assertFalse(s.should_send_output())
        frames = [c.args[0] for c in s.send_json.await_args_list if c.args[0]["type"] == "playback"]
        self.assertEqual([f["revision"] for f in frames], [1, 2, 3])
        self.assertTrue(all(f["callId"] == "rtc_test" for f in frames))

    async def test_sender_does_not_emit_old_chunk_after_speaking_callback_interrupt(self):
        s = self.make_session()
        s.speaking = False
        s.out_buf.extend((3000).to_bytes(2, "little", signed=True) * (VS.OUT_CHUNK_BYTES // 2))
        async def on_speaking(event):
            if event == {"type": "speaking", "state": "start"}:
                s._block_playback("manual")
        s.send_json.side_effect = on_speaking
        pump = asyncio.create_task(s.outbound_pump())
        await asyncio.sleep(0.02)
        pump.cancel()
        await pump
        await self.drain_controls(s)
        s.ws.send.assert_not_awaited()

    async def test_input_after_manual_recovery_cannot_automatically_block_again(self):
        s = self.make_session()
        await s.on_client_interrupt()
        await self.drain_controls(s)
        self.assertEqual(s.playback_control.revision, 1)
        # The caller continues speaking while output is blocked.
        await s.on_microphone_audio(bytes(3200))
        s._observe_playback_turn("user", "user")
        s._observe_playback_turn("reply", "assistant")
        await self.drain_controls(s)
        s.speaking = True
        await s.on_microphone_audio(bytes(3200))
        await self.drain_controls(s)
        self.assertEqual(s.playback_control.revision, 2,
                         "output state must not turn one ongoing speech burst into another onset")


if __name__ == "__main__":
    unittest.main()
