"""Audio NACK support for the verified aiortc receiver implementation.

aiortc 1.15.0 enables retransmission recovery for video only. Opus packets on
this path can be retransmitted by the remote peer when NACK is negotiated.
Keep a bounded reordering window long enough for the measured ~300ms RTT;
capacity is a ceiling, while prefetch remains four packets (~80ms).
"""
from importlib.metadata import version

SUPPORTED_AIORTC_VERSION = '1.15.0'
AUDIO_RECOVERY_CAPACITY = 64
AUDIO_RECOVERY_PREFETCH = 4


def _verify_version():
    if version('aiortc') != SUPPORTED_AIORTC_VERSION:
        raise RuntimeError('Audio recovery requires a validated aiortc version')


def offer_audio_recovery():
    """Advertise generic NACK for Opus, preserving other codec capabilities."""
    _verify_version()
    from aiortc.codecs import CODECS
    from aiortc.rtcrtpparameters import RTCRtcpFeedback

    for codec in CODECS['audio']:
        if codec.mimeType.lower() == 'audio/opus':
            nack = RTCRtcpFeedback(type='nack')
            if nack not in codec.rtcpFeedback:
                codec.rtcpFeedback.append(nack)


def enable_negotiated_audio_recovery(pc):
    """Activate only for an Opus receiver whose answer accepted generic NACK.

Called immediately after setRemoteDescription, before yielding to attach.
The two private receiver fields are explicitly guarded and version-pinned;
no installed dependency files are modified.
"""
    _verify_version()
    from aiortc.jitterbuffer import JitterBuffer
    from aiortc.rtcrtpreceiver import NackGenerator

    enabled = 0
    for transceiver in pc.getTransceivers():
        if transceiver.kind != 'audio':
            continue
        codecs = getattr(transceiver, '_codecs', None)
        if codecs is None:
            raise RuntimeError('Audio recovery codec interface changed')
        supports_nack = any(
            codec.mimeType.lower() == 'audio/opus'
            and any(feedback.type == 'nack' and not feedback.parameter
                    for feedback in codec.rtcpFeedback)
            for codec in codecs
        )
        if not supports_nack:
            continue
        receiver = transceiver.receiver
        if (not hasattr(receiver, '_RTCRtpReceiver__jitter_buffer')
                or not hasattr(receiver, '_RTCRtpReceiver__nack_generator')):
            raise RuntimeError('Audio recovery receiver interface changed')
        current = receiver._RTCRtpReceiver__jitter_buffer
        if (isinstance(current, JitterBuffer)
                and current.capacity == AUDIO_RECOVERY_CAPACITY
                and receiver._RTCRtpReceiver__nack_generator is not None):
            enabled += 1
            continue
        receiver._RTCRtpReceiver__jitter_buffer = JitterBuffer(
            capacity=AUDIO_RECOVERY_CAPACITY, prefetch=AUDIO_RECOVERY_PREFETCH)
        receiver._RTCRtpReceiver__nack_generator = NackGenerator()
        enabled += 1
    return enabled
