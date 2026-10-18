"""Bounded media diagnostics: no message formatting, addresses or payloads."""
import json
import logging
import time
import uuid

STATES = {"new", "checking", "connecting", "connected", "completed",
          "disconnected", "failed", "closed", "open", "closing"}
ERROR_CODES = {"session_expired", "rate_limit_exceeded", "context_length_exceeded",
               "max_duration_exceeded", "server_error", "internal_error",
               "invalid_request_error", "session_not_found",
               "input_audio_buffer_commit_empty", "audio_unintelligible"}
CONTROL_EVENTS = {"error", "session.error", "response.error", "session.created",
                  "session.updated", "session.closed", "session.ended",
                  "session.expired", "response.done", "response.failed"}
STATUSES = {"failed", "cancelled", "incomplete", "completed", "in_progress"}


class MediaDiagnostics:
    def __init__(self, emit):
        self.emit = emit
        self.tag = uuid.uuid4().hex[:12]
        self.started = time.monotonic()

    def state(self, pc, *, channel=None, local_release=False, requested_stop=False):
        values = {"tag": self.tag, "elapsedMs": round((time.monotonic()-self.started)*1000),
                  "localRelease": bool(local_release), "requestedStop": bool(requested_stop)}
        for key, value in (("peer", getattr(pc, "connectionState", None)),
                           ("ice", getattr(pc, "iceConnectionState", None)),
                           ("channel", getattr(channel, "readyState", None))):
            values[key] = value if isinstance(value, str) and value in STATES else "unknown"
        try:
            states = {getattr(sender.transport, "state", None) for sender in pc.getSenders()}
            values["dtls"] = sorted(s for s in states if isinstance(s, str) and s in STATES)
        except Exception:
            values["dtls"] = []
        self.emit("media-state", json.dumps(values, separators=(",", ":")))

    def control(self, event):
        event_type = event.get("type")
        if not isinstance(event_type, str) or event_type not in CONTROL_EVENTS:
            return
        response = event.get("response")
        response = response if isinstance(response, dict) else {}
        details = response.get("status_details")
        details = details if isinstance(details, dict) else {}
        error = event.get("error", details.get("error"))
        error = error if isinstance(error, dict) else {}
        code = error.get("code")
        error_type = error.get("type")
        status = response.get("status")
        values = {"tag": self.tag, "event": event_type,
                  "elapsedMs": round((time.monotonic()-self.started)*1000),
                  "code": code if isinstance(code, str) and code in ERROR_CODES else "unrecognized",
                  "errorType": error_type if isinstance(error_type, str) and error_type in ERROR_CODES else "unrecognized",
                  "status": status if isinstance(status, str) and status in STATUSES else "unknown",
                  "hasError": bool(error)}
        self.emit("media-control", json.dumps(values, separators=(",", ":")))


_DTLS_SIGNALS = {
    "RTCDtlsTransport(%s) - DTLS shutdown by remote party": "remote_shutdown",
    "RTCDtlsTransport(%s) - DTLS shutdown complete": "local_shutdown",
    "RTCDtlsTransport(%s) x DTLS handshake failed (connection error)": "handshake_connection_error",
    "RTCDtlsTransport(%s) x DTLS handshake failed (fingerprint mismatch)": "handshake_identity_error",
    "RTCDtlsTransport(%s) x DTLS handshake failed (error %s)": "handshake_error",
}


def install_dtls_signals(emit, logger=None):
    """Read exact library log templates; never interpolate their private args.

    Newly enabled debug records are suppressed from ordinary log handlers.
    Existing warning/error handling and any preconfigured verbosity are retained.
    Returns a cleanup function for tests or a managed runtime shutdown.
    """
    logger = logger if logger is not None else logging.getLogger("aiortc.rtcdtlstransport")
    previous_level = logger.level
    previous_effective = logger.getEffectiveLevel()

    class SignalFilter(logging.Filter):
        def filter(self, record):
            signal = _DTLS_SIGNALS.get(record.msg) if isinstance(record.msg, str) else None
            if signal:
                try:
                    emit("media-dtls-signal", json.dumps({"origin": signal}, separators=(",", ":")))
                except Exception:
                    pass  # diagnostics must not affect media delivery
            return record.levelno >= previous_effective

    signal_filter = SignalFilter()
    logger.addFilter(signal_filter)
    logger.setLevel(min(previous_effective, logging.DEBUG))

    def uninstall():
        logger.removeFilter(signal_filter)
        logger.setLevel(previous_level)

    return uninstall
