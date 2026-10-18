"""Detect sustained microphone speech for local barge-in, without transcription.

Input is little-endian signed PCM16, mono, 16 kHz, from the phone's selected
communication/AEC capture path. WebRTC VAD classifies speech; it does NOT remove
speaker echo. Enable detection only while model output is eligible to interrupt.
One detector belongs to one call and must be fed serially.

The detector keeps only an incomplete 20 ms frame, never records audio, and
processes every complete frame even for large input chunks. A True result means
at least one speech onset in this call to feed(); multiple onsets in a single
large chunk are coalesced. Dependency/runtime failure disables detection without
raising into the call or substituting an amplitude threshold.
"""

from __future__ import annotations


SAMPLE_RATE = 16_000
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
SPEECH_FRAMES = 4  # 80 ms of consecutive VAD-positive frames.
SILENCE_FRAMES = 10  # 200 ms of consecutive VAD-negative frames re-arms.
VAD_MODE = 2


class BargeInDetector:
    """Return once per sustained speech burst; expose unavailable VAD explicitly.

    ``vad`` can be injected for deterministic offline tests; it must implement
    ``is_speech(frame_bytes, sample_rate)``. Production omits it to use WebRTC
    VAD mode 2. ``error_reason`` contains only a fixed, log-safe code or None.
    ``reset()`` drops frame/counter/latch state and renews the production VAD to
    clear its speech hangover. Injected test backends own their acoustic state.
    Reset never hides a VAD failure.
    """

    def __init__(self, vad=None):
        self._vad = None
        self._vad_factory = None
        self._backend_dirty = False
        self.error_reason = None
        self._pending = bytearray()
        self._speech_frames = 0
        self._silence_frames = 0
        self._latched = False
        if vad is not None:
            self._vad = vad
            return
        try:
            import webrtcvad
        except Exception:
            self.error_reason = "dependency_unavailable"
            return
        try:
            self._vad_factory = webrtcvad.Vad
            self._vad = self._vad_factory(VAD_MODE)
        except Exception:
            self.error_reason = "vad_initialization_failed"

    @property
    def available(self) -> bool:
        return self._vad is not None

    @property
    def unavailable(self) -> bool:
        return not self.available

    def reset(self) -> None:
        self._pending.clear()
        self._speech_frames = 0
        self._silence_frames = 0
        self._latched = False
        if self._backend_dirty and self._vad_factory is not None and self.available:
            try:
                self._vad = self._vad_factory(VAD_MODE)
            except Exception:
                self._vad = None
                self.error_reason = "vad_initialization_failed"
        self._backend_dirty = False

    def _process_frame(self, frame: bytes) -> bool:
        self._backend_dirty = True
        if self._vad.is_speech(frame, SAMPLE_RATE):
            self._silence_frames = 0
            self._speech_frames = min(self._speech_frames + 1, SPEECH_FRAMES)
            if not self._latched and self._speech_frames == SPEECH_FRAMES:
                self._latched = True
                return True
        else:
            self._speech_frames = 0
            self._silence_frames = min(self._silence_frames + 1, SILENCE_FRAMES)
            if self._silence_frames == SILENCE_FRAMES:
                self._latched = False
        return False

    def feed(self, raw_pcm16_mono16k, enabled=True) -> bool:
        """Consume bytes and signal sustained speech onset, or return False.

        Arbitrary byte splits (including odd-sized chunks) are reassembled before
        VAD. An incomplete final sample/frame waits for the next chunk and is
        discarded by reset/disabled; at most FRAME_BYTES - 1 bytes are retained.
        Non-buffer/non-contiguous input is rejected safely and clears state.
        Disabled calls clear accumulation/native hangover and never classify audio.
        """
        if not enabled or self.unavailable:
            self.reset()
            return False
        try:
            incoming = memoryview(raw_pcm16_mono16k).cast("B")
        except (TypeError, ValueError):
            self.reset()
            return False

        triggered = False
        offset = 0
        try:
            if self._pending:
                count = min(FRAME_BYTES - len(self._pending), len(incoming))
                self._pending.extend(incoming[:count])
                offset = count
                if len(self._pending) == FRAME_BYTES:
                    frame = bytes(self._pending)
                    self._pending.clear()
                    triggered = self._process_frame(frame)
            while offset + FRAME_BYTES <= len(incoming):
                frame = bytes(incoming[offset:offset + FRAME_BYTES])
                offset += FRAME_BYTES
                # Always classify every frame, even after an onset was found.
                onset = self._process_frame(frame)
                triggered = onset or triggered
            self._pending.extend(incoming[offset:])
        except Exception:
            self._vad = None
            self.error_reason = "vad_processing_failed"
            self.reset()
            return False
        return triggered
