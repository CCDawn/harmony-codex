"""Isolated, deterministic checks for the Opus NACK recovery candidate.

Run with the repository's validated aiortc environment:
  .venv\\Scripts\\python.exe ..\\..\\..\\2026-10-04\\c-users-administrator-zcode-workspace-default\\work\\voice-recovery-stage\\test\\audio_recovery_harness.py

No real Companion, network service, microphone, or private conversation is used.
"""
from __future__ import annotations

import asyncio
import re
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

STAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STAGE))

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription  # noqa: E402
from aiortc.codecs import CODECS  # noqa: E402
from aiortc.jitterbuffer import JitterBuffer  # noqa: E402
from aiortc.rtcrtpreceiver import NackGenerator  # noqa: E402
from aiortc.rtcrtpparameters import RTCRtcpFeedback  # noqa: E402

from voice.audio_recovery import (  # noqa: E402
    AUDIO_RECOVERY_CAPACITY,
    AUDIO_RECOVERY_PREFETCH,
    enable_negotiated_audio_recovery,
    offer_audio_recovery,
)


def make_packet(index: int, sequence_origin: int = 65530) -> SimpleNamespace:
    """One complete 20 ms Opus RTP payload; bytes encode its source index."""
    return SimpleNamespace(
        sequence_number=(sequence_origin + index) & 0xFFFF,
        timestamp=(index * 960) & 0xFFFFFFFF,
        _data=index.to_bytes(2, "big"),
    )


def run_delayed_retransmission(capacity: int) -> list[tuple[int, int, int]]:
    """Return (arrival_ms, packet_index, RTP_timestamp) emitted by JitterBuffer."""
    packet_period_ms = 20
    missing_index = 10
    retransmit_delay_ms = 350
    packet_count = 80
    jitter = JitterBuffer(capacity=capacity, prefetch=4)

    events = [
        (index * packet_period_ms, 0, index)
        for index in range(packet_count)
        if index != missing_index
    ]
    events.append(
        (missing_index * packet_period_ms + retransmit_delay_ms, 1, missing_index)
    )
    events.sort()

    emitted = []
    for arrival_ms, _is_retransmission, index in events:
        _pli, frame = jitter.add(make_packet(index))
        if frame is not None:
            packet_index = int.from_bytes(frame.data[:2], "big")
            emitted.append((arrival_ms, packet_index, frame.timestamp))
    return emitted


def run_periodic_loss(capacity: int) -> list[tuple[int, int, int]]:
    """Six-in-one loss with 350 ms retransmission delay for every missing packet."""
    packet_period_ms = 20
    packet_count = 300
    retransmit_delay_ms = 350
    lost = {index for index in range(packet_count) if (index + 1) % 6 == 0}
    jitter = JitterBuffer(capacity=capacity, prefetch=4)
    events = [
        (index * packet_period_ms, 0, index)
        for index in range(packet_count)
        if index not in lost
    ]
    events.extend(
        (index * packet_period_ms + retransmit_delay_ms, 1, index)
        for index in lost
    )
    events.sort()

    emitted = []
    for arrival_ms, _is_retransmission, index in events:
        _pli, frame = jitter.add(make_packet(index))
        if frame is not None:
            packet_index = int.from_bytes(frame.data[:2], "big")
            emitted.append((arrival_ms, packet_index, frame.timestamp))
    return emitted


class AudioRecoveryHarness(unittest.IsolatedAsyncioTestCase):
    async def _negotiate(self, strip_nack: bool = False):
        offer_audio_recovery()
        config = RTCConfiguration(iceServers=[])
        offerer = RTCPeerConnection(config)
        answerer = RTCPeerConnection(config)
        offerer.addTransceiver("audio", direction="sendrecv")
        answerer.addTransceiver("audio", direction="sendrecv")
        try:
            offer = await offerer.createOffer()
            await offerer.setLocalDescription(offer)
            await answerer.setRemoteDescription(offerer.localDescription)
            answer = await answerer.createAnswer()
            await answerer.setLocalDescription(answer)
            answer_sdp = answerer.localDescription.sdp
            if strip_nack:
                answer_sdp = re.sub(
                    r"^a=rtcp-fb:\d+ nack\r?\n?",
                    "",
                    answer_sdp,
                    flags=re.MULTILINE,
                )
            await offerer.setRemoteDescription(
                RTCSessionDescription(sdp=answer_sdp, type="answer")
            )
            # setRemoteDescription schedules aiortc's ICE connect task. Let it
            # start before close() so the SDP test does not race a closed
            # transport with that background task.
            await asyncio.sleep(0.1)
            return offerer, answerer
        except BaseException:
            await offerer.close()
            await answerer.close()
            raise

    async def test_01_offer_adds_generic_nack_idempotently_and_preserves_feedback(self):
        opus = next(codec for codec in CODECS["audio"] if codec.mimeType.lower() == "audio/opus")
        original = list(opus.rtcpFeedback)
        try:
            offer_audio_recovery()
            offer_audio_recovery()
            feedback = opus.rtcpFeedback
            generic_nacks = [
                item for item in feedback
                if item.type == "nack" and not item.parameter
            ]
            self.assertEqual(len(generic_nacks), 1)
            self.assertTrue(all(item in feedback for item in original))
            self.assertEqual(
                [item for item in feedback if not (item.type == "nack" and not item.parameter)],
                original,
            )
        finally:
            opus.rtcpFeedback[:] = original

    async def test_02_350ms_retransmission_survives_capacity64_but_not16(self):
        out16 = run_delayed_retransmission(16)
        out64 = run_delayed_retransmission(64)
        ids16 = [packet_index for _arrival, packet_index, _timestamp in out16]
        ids64 = [packet_index for _arrival, packet_index, _timestamp in out64]

        # RTP sequence numbers wrap in this stream (65530 + index modulo 65536).
        # The 350 ms retransmission is older than cap16's live window, but remains
        # admissible in cap64.  The latter emits one complete packet per timestamp.
        self.assertNotIn(10, ids16)
        self.assertIn(10, ids64)
        self.assertEqual(ids64, list(range(len(ids64))))
        self.assertTrue(any(index > 10 for index in ids16))
        for _arrival, packet_index, timestamp in out64:
            self.assertEqual(timestamp, (packet_index * 960) & 0xFFFFFFFF)

    async def test_025_six_in_one_loss_with_350ms_retransmissions(self):
        out16 = run_periodic_loss(16)
        out64 = run_periodic_loss(64)
        ids16 = [packet_index for _arrival, packet_index, _timestamp in out16]
        ids64 = [packet_index for _arrival, packet_index, _timestamp in out64]

        # With capacity64, every output before the final prefetch tail is ordered
        # and complete; capacity16 advances past gaps before these retransmissions
        # arrive, losing the missing packet and buffered audio around each gap.
        self.assertEqual(ids64, list(range(len(ids64))))
        self.assertGreaterEqual(len(ids64), 280)
        self.assertGreater(len(ids64), len(ids16))
        shared_prefix = range(min(len(ids16), len(ids64), 60))
        self.assertTrue(any(index not in ids16 for index in shared_prefix))
        self.assertTrue(all(index in ids64 for index in range(0, len(ids64))))

    async def test_03_real_answer_with_nack_enables_audio_receiver_once(self):
        offerer, answerer = await self._negotiate()
        try:
            answer_sdp = answerer.localDescription.sdp
            self.assertRegex(answer_sdp, r"(?m)^a=rtcp-fb:\d+ nack\r?$")
            receiver = offerer.getTransceivers()[0].receiver
            enabled = enable_negotiated_audio_recovery(offerer)
            self.assertEqual(enabled, 1)
            jitter = receiver._RTCRtpReceiver__jitter_buffer
            nack = receiver._RTCRtpReceiver__nack_generator
            self.assertIsInstance(jitter, JitterBuffer)
            self.assertEqual(jitter.capacity, AUDIO_RECOVERY_CAPACITY)
            self.assertEqual(AUDIO_RECOVERY_CAPACITY, 64)
            self.assertEqual(jitter._prefetch, AUDIO_RECOVERY_PREFETCH)
            self.assertEqual(AUDIO_RECOVERY_PREFETCH, 4)
            self.assertIsInstance(nack, NackGenerator)

            self.assertEqual(enable_negotiated_audio_recovery(offerer), 1)
            self.assertIs(receiver._RTCRtpReceiver__jitter_buffer, jitter)
            self.assertIs(receiver._RTCRtpReceiver__nack_generator, nack)
        finally:
            await offerer.close()
            await answerer.close()

    async def test_04_answer_without_generic_nack_leaves_audio_receiver_unchanged(self):
        offerer, answerer = await self._negotiate(strip_nack=True)
        try:
            receiver = offerer.getTransceivers()[0].receiver
            old_jitter = receiver._RTCRtpReceiver__jitter_buffer
            old_nack = receiver._RTCRtpReceiver__nack_generator
            self.assertEqual(old_jitter.capacity, 16)
            self.assertIsNone(old_nack)
            self.assertEqual(enable_negotiated_audio_recovery(offerer), 0)
            self.assertIs(receiver._RTCRtpReceiver__jitter_buffer, old_jitter)
            self.assertIs(receiver._RTCRtpReceiver__nack_generator, old_nack)
        finally:
            await offerer.close()
            await answerer.close()

    async def test_05_non_audio_transceiver_is_untouched(self):
        receiver = SimpleNamespace()
        old_jitter = JitterBuffer(capacity=16, prefetch=4)
        setattr(receiver, "_RTCRtpReceiver__jitter_buffer", old_jitter)
        setattr(receiver, "_RTCRtpReceiver__nack_generator", None)
        video_codec = SimpleNamespace(
            mimeType="video/VP8",
            rtcpFeedback=[RTCRtcpFeedback(type="nack")],
        )
        video_transceiver = SimpleNamespace(
            kind="video", receiver=receiver, _codecs=[video_codec]
        )
        pc = SimpleNamespace(getTransceivers=lambda: [video_transceiver])

        self.assertEqual(enable_negotiated_audio_recovery(pc), 0)
        self.assertIs(receiver._RTCRtpReceiver__jitter_buffer, old_jitter)
        self.assertIsNone(receiver._RTCRtpReceiver__nack_generator)

    async def test_06_version_mismatch_fails_closed(self):
        with patch("voice.audio_recovery.version", return_value="1.14.0"):
            with self.assertRaisesRegex(RuntimeError, "validated aiortc version"):
                enable_negotiated_audio_recovery(SimpleNamespace(getTransceivers=lambda: []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
