"""Offline barge-in checks; no microphone, audio files, or running services.

Run: .venv/Scripts/python.exe -m unittest -v test.barge_in_harness
Requires the pinned dependency in voice/requirements-barge-in.txt. Scripted VAD
decisions verify timing/state only; the real VAD test separately verifies silence.
"""

from __future__ import annotations

import builtins
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


VOICE_DIR = Path(__file__).resolve().parents[1] / "voice"
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))
import barge_in as BI  # noqa: E402


SPEECH = b"\x01\x00" * (BI.FRAME_BYTES // 2)
SILENCE = bytes(BI.FRAME_BYTES)


class ScriptedVad:
    """Explicit frame labels, not an acoustic or amplitude-based VAD substitute."""

    def __init__(self):
        self.frames = 0

    def is_speech(self, frame, rate):
        if rate != 16_000 or len(frame) != 640:
            raise AssertionError("invalid VAD frame format")
        self.frames += 1
        if frame == SPEECH:
            return True
        if frame == SILENCE:
            return False
        raise AssertionError("unknown scripted frame label")


class BargeInHarness(unittest.TestCase):
    def setUp(self):
        self.vad = ScriptedVad()
        self.detector = BI.BargeInDetector(vad=self.vad)

    def test_four_consecutive_frames_trigger_once(self):
        self.assertFalse(self.detector.feed(SPEECH * 3))
        self.assertTrue(self.detector.feed(SPEECH))
        self.assertFalse(self.detector.feed(SPEECH * 100))
        self.assertEqual(self.vad.frames, 104)

    def test_silence_alone_never_triggers(self):
        self.assertFalse(self.detector.feed(SILENCE * 100))
        self.assertEqual(self.vad.frames, 100)

    def test_intervening_silence_breaks_consecutive_speech(self):
        self.assertFalse(self.detector.feed(SPEECH * 3 + SILENCE + SPEECH * 3))
        self.assertTrue(self.detector.feed(SPEECH))

    def test_exactly_ten_silent_frames_rearm(self):
        self.assertTrue(self.detector.feed(SPEECH * 4))
        self.assertFalse(self.detector.feed(SILENCE * 9 + SPEECH * 4))
        self.assertFalse(self.detector.feed(SILENCE * 10 + SPEECH * 3))
        self.assertTrue(self.detector.feed(SPEECH))

    def test_speech_breaks_consecutive_rearm_silence(self):
        self.assertTrue(self.detector.feed(SPEECH * 4))
        self.assertFalse(self.detector.feed(SILENCE * 5 + SPEECH + SILENCE * 5 + SPEECH * 4))

    def test_disabled_clears_speech_and_partial_frame(self):
        self.assertFalse(self.detector.feed(SPEECH * 3 + SPEECH[:320]))
        self.assertFalse(self.detector.feed(SPEECH * 50, enabled=False))
        self.assertEqual(self.vad.frames, 3)
        self.assertEqual(len(self.detector._pending), 0)
        self.assertFalse(self.detector.feed(SPEECH * 3))
        self.assertTrue(self.detector.feed(SPEECH))

    def test_disabled_clears_latch(self):
        self.assertTrue(self.detector.feed(SPEECH * 4))
        self.assertFalse(self.detector.feed(b"", enabled=False))
        self.assertTrue(self.detector.feed(SPEECH * 4))

    def test_partial_frames_preserve_consecutive_detection(self):
        self.assertFalse(self.detector.feed(SPEECH * 3 + SPEECH[:638]))
        self.assertEqual(self.vad.frames, 3)
        self.assertTrue(self.detector.feed(SPEECH[638:]))
        self.assertEqual(self.vad.frames, 4)

    def test_arbitrary_odd_byte_chunking_preserves_event_sample_positions(self):
        stream = SPEECH * 4 + SILENCE * 10 + SPEECH * 4 + SPEECH[:31]
        expected = [4 * 640, 18 * 640]
        for chunk_size in (1, 3, 127, 320, 639):
            with self.subTest(chunk_size=chunk_size):
                detector = BI.BargeInDetector(vad=ScriptedVad())
                events = []
                for offset in range(0, len(stream), chunk_size):
                    end = min(offset + chunk_size, len(stream))
                    if detector.feed(stream[offset:end]):
                        events.append(end // 640 * 640)
                self.assertEqual(events, expected)
                self.assertEqual(len(detector._pending), 31)

    def test_single_odd_byte_never_reaches_vad_and_reset_discards_it(self):
        self.assertFalse(self.detector.feed(b"\x01"))
        self.assertEqual(self.vad.frames, 0)
        self.detector.reset()
        self.assertTrue(self.detector.feed(SPEECH * 4))

    def test_large_chunk_processes_all_frames_and_bounds_pending(self):
        self.assertTrue(self.detector.feed(SPEECH * 4 + SILENCE * 2000 + SPEECH * 3 + SPEECH[:639]))
        self.assertEqual(self.vad.frames, 2007)
        self.assertEqual(len(self.detector._pending), 639)
        self.assertTrue(self.detector.feed(SPEECH[639:]))
        self.assertEqual(self.vad.frames, 2008)
        self.assertEqual(len(self.detector._pending), 0)

    def test_long_chunk_multiple_bursts_coalesce_and_leave_final_latch(self):
        self.assertTrue(self.detector.feed(SPEECH * 4 + SILENCE * 10 + SPEECH * 4))
        self.assertFalse(self.detector.feed(SPEECH * 4))
        self.assertEqual(self.vad.frames, 22)

    def test_invalid_input_safely_resets_without_disabling_vad(self):
        for invalid in (None, "pcm", memoryview(b"abcdef")[::2]):
            with self.subTest(invalid_type=type(invalid).__name__):
                self.detector.feed(SPEECH * 3)
                self.assertFalse(self.detector.feed(invalid))
                self.assertTrue(self.detector.available)
                self.assertFalse(self.detector.feed(SPEECH * 3))
                self.assertTrue(self.detector.feed(SPEECH))
                self.detector.reset()

    def test_empty_input_does_not_rearm_or_count_as_silence(self):
        self.assertTrue(self.detector.feed(SPEECH * 4))
        for _ in range(20):
            self.assertFalse(self.detector.feed(b""))
        self.assertFalse(self.detector.feed(SPEECH * 4))

    def test_missing_dependency_is_explicit_and_never_raises(self):
        original_import = builtins.__import__

        def missing_import(name, *args, **kwargs):
            if name == "webrtcvad":
                raise ImportError("do not copy exception data into logs")
            return original_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=missing_import):
            detector = BI.BargeInDetector()
        self.assertFalse(detector.available)
        self.assertTrue(detector.unavailable)
        self.assertEqual(detector.error_reason, "dependency_unavailable")
        self.assertFalse(detector.feed(SPEECH * 4))

    def test_backend_initialization_failure_is_explicit(self):
        failing_module = types.SimpleNamespace(Vad=mock.Mock(side_effect=RuntimeError("private detail")))
        with mock.patch.dict(sys.modules, {"webrtcvad": failing_module}):
            detector = BI.BargeInDetector()
        self.assertTrue(detector.unavailable)
        self.assertEqual(detector.error_reason, "vad_initialization_failed")
        self.assertFalse(detector.feed(SPEECH * 4))

    def test_backend_runtime_failure_disables_detection_only(self):
        failing_vad = types.SimpleNamespace(is_speech=mock.Mock(side_effect=RuntimeError("private detail")))
        detector = BI.BargeInDetector(vad=failing_vad)
        self.assertFalse(detector.feed(SPEECH * 4))
        self.assertTrue(detector.unavailable)
        self.assertEqual(detector.error_reason, "vad_processing_failed")
        detector.reset()
        self.assertFalse(detector.feed(SPEECH * 4))
        self.assertEqual(failing_vad.is_speech.call_count, 1)

    def test_disabled_resets_native_hangover_once_before_reenabling(self):
        class StickyVad:
            def __init__(self, mode):
                self.heard_speech = False

            def is_speech(self, frame, rate):
                # Model a native VAD's internal hangover, not speech acoustics.
                self.heard_speech = self.heard_speech or frame == SPEECH
                return self.heard_speech

        factory = mock.Mock(side_effect=StickyVad)
        with mock.patch.dict(sys.modules, {"webrtcvad": types.SimpleNamespace(Vad=factory)}):
            detector = BI.BargeInDetector()
        self.assertTrue(detector.feed(SPEECH * 4))
        for _ in range(20):
            self.assertFalse(detector.feed(SPEECH, enabled=False))
        self.assertEqual(factory.call_count, 2)
        self.assertFalse(detector.feed(SILENCE * 10))
        self.assertTrue(detector.feed(SPEECH * 4))

    def test_native_reset_failure_is_explicit_without_raising(self):
        factory = mock.Mock(side_effect=[ScriptedVad(), RuntimeError("private detail")])
        with mock.patch.dict(sys.modules, {"webrtcvad": types.SimpleNamespace(Vad=factory)}):
            detector = BI.BargeInDetector()
        self.assertTrue(detector.feed(SPEECH * 4))
        self.assertFalse(detector.feed(b"", enabled=False))
        self.assertTrue(detector.unavailable)
        self.assertEqual(detector.error_reason, "vad_initialization_failed")
        self.assertFalse(detector.feed(SPEECH * 4))

    def test_real_installed_webrtc_vad_zeros_and_odd_fragments(self):
        detector = BI.BargeInDetector()
        self.assertTrue(detector.available, detector.error_reason)
        self.assertIsNone(detector.error_reason)
        for size in (1, 639, 640, 1280, 32000, 1):
            self.assertFalse(detector.feed(bytes(size)))
        self.assertTrue(detector.available)
        self.assertLess(len(detector._pending), 640)


if __name__ == "__main__":
    unittest.main()
