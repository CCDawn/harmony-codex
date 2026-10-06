"""Narrow offline regression tests for voice_server.PcmTrack and ready gating.

Run with the existing m1-venv Python from the repository root:
  $env:VOICE_SERVER_DIR = 'C:\\path\\to\\codex-harmony\\voice'
  python -m unittest -v test.voice_stream_harness

VOICE_SERVER_DIR may be either a directory containing voice_server.py or the
file itself. No App Server process, socket, or external API is started here.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import struct
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = Path(os.environ.get("VOICE_SERVER_DIR", REPO_ROOT / "voice")).resolve()
SOURCE_FILE = SOURCE_ROOT / "voice_server.py" if SOURCE_ROOT.is_dir() else SOURCE_ROOT
if not SOURCE_FILE.is_file():
    raise FileNotFoundError(f"voice_server.py not found at {SOURCE_FILE}")

SPEC = importlib.util.spec_from_file_location("voice_server_under_test", SOURCE_FILE)
if SPEC is None or SPEC.loader is None:
    raise ImportError(f"cannot load voice server module from {SOURCE_FILE}")
VS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VS)


def pcm_bytes(samples: int, value: int = 0x1200) -> bytes:
    return struct.pack("<h", value) * samples


def frame_pcm(frame, channels: int = 2) -> bytes:
    # PyAV planes may include line-alignment padding.
    return bytes(frame.planes[0])[:frame.samples * 2 * channels]


class FakePeerConnection:
    def __init__(self, state: str):
        self.connectionState = state


class VoiceStreamHarness(unittest.IsolatedAsyncioTestCase):
    async def test_item_transcripts_keep_identity_without_legacy_duplicates(self):
        session = VS.Session(ws=object())
        session.send_json = mock.AsyncMock()
        session.on_app_notify("thread/realtime/item/started", {
            "item": {"id": "u1", "type": "transcriptSegment", "role": "user", "text": ""}})
        session.on_app_notify("thread/realtime/item/transcript/delta", {"itemId": "u1", "delta": "seven"})
        session.on_app_notify("thread/realtime/transcript/delta", {"role": "user", "delta": "seven"})
        session.on_app_notify("thread/realtime/item/started", {
            "item": {"id": "a1", "type": "transcriptSegment", "role": "assistant", "text": ""}})
        session.on_app_notify("thread/realtime/item/transcript/delta", {"itemId": "a1", "delta": "twelve"})
        session.on_app_notify("thread/realtime/item/completed", {
            "item": {"id": "u1", "type": "transcriptSegment", "role": "user", "text": "seven plus five"}})
        session.on_app_notify("thread/realtime/transcript/done", {"role": "user", "text": "seven plus five"})
        await asyncio.sleep(0)
        self.assertEqual([call.args[0] for call in session.send_json.call_args_list], [
            {"type": "transcript", "itemId": "u1", "role": "user", "text": "seven", "final": False},
            {"type": "transcript", "itemId": "a1", "role": "assistant", "text": "twelve", "final": False},
            {"type": "transcript", "itemId": "u1", "role": "user", "text": "seven plus five", "final": True}])

    async def test_legacy_transcripts_still_work_without_item_stream(self):
        session = VS.Session(ws=object())
        session.send_json = mock.AsyncMock()
        session.on_app_notify("thread/realtime/transcript/delta", {"role": "user", "delta": "hello"})
        session.on_app_notify("thread/realtime/transcript/done", {"role": "user", "text": "hello"})
        await asyncio.sleep(0)
        self.assertEqual(session.send_json.call_count, 2)
        self.assertEqual(session.send_json.call_args.args[0]["final"], True)

    async def test_audio_clock_does_not_accumulate_timer_overshoot(self):
        # Windows timer granularity used to stretch these 51 frames to ~1.55s.
        track = VS.PcmTrack()
        start = time.monotonic()
        for _ in range(51):
            await track.recv()
        elapsed = time.monotonic() - start
        self.assertGreaterEqual(elapsed, 0.95)
        self.assertLess(elapsed, 1.25)
        track.halt_stream()

    async def test_recv_without_phone_input_is_clocked_stereo_silence(self):
        track = VS.PcmTrack()
        started = time.monotonic()
        first = await asyncio.wait_for(track.recv(), timeout=0.15)
        first_returned = time.monotonic()
        second = await asyncio.wait_for(track.recv(), timeout=0.15)
        second_returned = time.monotonic()

        self.assertLess(first_returned - started, 0.12)
        for index, frame in enumerate((first, second)):
            self.assertEqual(frame.sample_rate, 48000)
            self.assertEqual(frame.layout.name, "stereo")
            self.assertEqual(frame.format.name, "s16")
            self.assertEqual(frame.samples, 960)
            self.assertEqual(frame.pts, index * 960)
            self.assertEqual(frame.time_base, VS.fractions.Fraction(1, 48000))
            self.assertEqual(frame_pcm(frame), b"\x00" * (960 * 4))
        interval = second_returned - first_returned
        self.assertGreaterEqual(round(interval, 6), 0.015, "consecutive frames must not burst")
        self.assertLess(interval, 0.10, "20 ms silence frames must keep advancing")

        track.halt_stream()
        with self.assertRaises(VS.MediaStreamError):
            await track.recv()

    async def test_mic_chunks_become_contiguous_20ms_frames_then_silence(self):
        track = VS.PcmTrack()
        # Ten 10 ms chunks leave room for the resampler's initial filter delay.
        for _ in range(10):
            await track.push(pcm_bytes(160))

        frames = [await asyncio.wait_for(track.recv(), timeout=0.15) for _ in range(6)]

        self.assertEqual([frame.samples for frame in frames], [960] * 6)
        self.assertEqual([frame.pts for frame in frames], [0, 960, 1920, 2880, 3840, 4800])
        self.assertEqual([frame.sample_rate for frame in frames], [48000] * 6)
        self.assertEqual([frame.time_base for frame in frames], [VS.fractions.Fraction(1, 48000)] * 6)
        self.assertEqual(frame_pcm(frames[-1]), b"\x00" * (960 * 4))

    async def test_odd_pcm16_input_is_rejected(self):
        track = VS.PcmTrack()
        with self.assertRaises(ValueError):
            await track.push(b"\x01\x02\x03")

    async def test_ready_gate_times_out_without_both_started_and_connected(self):
        session = VS.Session(ws=object())
        session.pc = FakePeerConnection("connected")
        session.media_connected.set()  # A prior connected event alone is insufficient.
        await self._assert_ready_timeout(session)

        session2 = VS.Session(ws=object())
        session2.pc = FakePeerConnection("new")
        session2.rt_started.set()
        await self._assert_ready_timeout(session2)

    async def test_failed_or_closed_state_never_passes_after_connected_event(self):
        for terminal_state in ("failed", "closed"):
            with self.subTest(state=terminal_state):
                session = VS.Session(ws=object())
                session.pc = FakePeerConnection(terminal_state)
                session.rt_started.set()
                session.media_connected.set()  # Simulates a stale earlier connected event.
                with self.assertRaises(RuntimeError):
                    await session.wait_media_connected()

    async def test_realtime_error_never_passes_ready_gate(self):
        session = VS.Session(ws=object())
        session.pc = FakePeerConnection("connected")
        session.rt_started.set()
        session.media_connected.set()
        session.rt_errors.append("offline fixture error")
        with self.assertRaises(RuntimeError):
            await session.wait_media_connected()

    async def test_ready_gate_passes_when_started_and_connected(self):
        session = VS.Session(ws=object())
        session.pc = FakePeerConnection("connected")
        session.rt_started.set()
        with mock.patch.object(VS, "MEDIA_READY_TIMEOUT_S", 0.05, create=True):
            await asyncio.wait_for(session.wait_media_connected(), timeout=0.15)

    async def _assert_ready_timeout(self, session):
        if hasattr(VS, "MEDIA_READY_TIMEOUT_S"):
            with mock.patch.object(VS, "MEDIA_READY_TIMEOUT_S", 0.05):
                with self.assertRaises(TimeoutError):
                    await session.wait_media_connected()
            return

        # Keep the old baseline's hard-coded 15 s wait bounded for the red run.
        real_wait_for = asyncio.wait_for

        async def capped_wait_for(awaitable, timeout=None):
            short_timeout = 0.05 if timeout is None else min(timeout, 0.05)
            return await real_wait_for(awaitable, timeout=short_timeout)

        with mock.patch.object(VS.asyncio, "wait_for", capped_wait_for):
            with self.assertRaises(TimeoutError):
                await session.wait_media_connected()


if __name__ == "__main__":
    unittest.main()
