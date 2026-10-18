"""Offline privacy, lifecycle and behavior tests for media diagnostics."""
import json
import logging
import types
import unittest
from unittest import mock

from companion_session_harness import VS, CS
import media_diagnostics as MD


class MediaDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.lines = []
        self.emit = lambda event, detail: self.lines.append((event, json.loads(detail)))
        self.diagnostics = MD.MediaDiagnostics(self.emit)

    def test_control_errors_keep_categories_but_never_private_message_fields(self):
        self.diagnostics.control({"type": "error", "error": {
            "code": "context_length_exceeded", "type": "invalid_request_error",
            "message": "SECRET SPEECH", "param": "SECRET TOKEN"}, "sdp": "PRIVATE SDP"})
        record = self.lines[-1][1]
        self.assertEqual(record["code"], "context_length_exceeded")
        self.assertEqual(record["errorType"], "invalid_request_error")
        self.assertTrue(record["hasError"])
        self.assertNotIn("SECRET", json.dumps(self.lines))
        self.assertNotIn("PRIVATE", json.dumps(self.lines))

    def test_response_failure_metadata_and_unknown_values_are_bounded(self):
        self.diagnostics.control({"type": "response.done", "response": {
            "status": "failed", "status_details": {"error": {
                "code": "server_error", "message": "SPEECH"}}}})
        self.assertEqual(self.lines[-1][1]["status"], "failed")
        self.assertEqual(self.lines[-1][1]["code"], "server_error")
        self.diagnostics.control({"type": "session.error", "error": {
            "code": ["private"], "type": {"private": True}}})
        self.assertEqual(self.lines[-1][1]["code"], "unrecognized")
        for event in ({"type": "turn.delta", "delta": "SPEECH"}, {"type": []},
                      {"type": "private-event-name"}):
            self.diagnostics.control(event)
        self.assertEqual(len(self.lines), 2)

    def test_state_distinguishes_local_release_without_logging_peer_objects(self):
        pc = types.SimpleNamespace(connectionState="closed", iceConnectionState="closed",
            getSenders=lambda: [types.SimpleNamespace(transport=types.SimpleNamespace(state="closed"))])
        self.diagnostics.state(pc, channel=types.SimpleNamespace(readyState="closed"))
        self.assertFalse(self.lines[-1][1]["localRelease"])
        self.diagnostics.state(pc, local_release=True, requested_stop=True)
        self.assertTrue(self.lines[-1][1]["localRelease"])
        self.assertTrue(self.lines[-1][1]["requestedStop"])
        self.assertEqual(self.lines[-1][1]["dtls"], ["closed"])
        self.assertEqual(self.lines[0][1]["tag"], self.lines[1][1]["tag"])

    def test_dtls_signal_does_not_format_args_or_enable_packet_debug_output(self):
        logger = logging.Logger("test.media", level=logging.WARNING)
        output = mock.Mock()
        handler = logging.Handler()
        handler.emit = output
        logger.addHandler(handler)
        cleanup = MD.install_dtls_signals(self.emit, logger)
        try:
            class PrivateArg:
                def __str__(self):
                    raise AssertionError("private log arguments must never be formatted")
            logger.debug("RTCDtlsTransport(%s) - DTLS shutdown by remote party", PrivateArg())
            logger.debug("RTCDtlsTransport(%s) x DTLS handshake failed (error %s)", PrivateArg(), PrivateArg())
            logger.debug("PRIVATE SDP AND PACKET", PrivateArg())
            output.assert_not_called()
            self.assertEqual([r[1]["origin"] for r in self.lines],
                             ["remote_shutdown", "handshake_error"])
            logger.warning("existing warning")
            output.assert_called_once()
        finally:
            cleanup()
        self.assertEqual(logger.level, logging.WARNING)
        self.assertFalse(logger.filters)

    def test_diagnostics_failure_cannot_interrupt_dtls_logging(self):
        logger = logging.Logger("test.media.failure", level=logging.ERROR)
        cleanup = MD.install_dtls_signals(mock.Mock(side_effect=RuntimeError), logger)
        try:
            logger.debug("RTCDtlsTransport(%s) - DTLS shutdown by remote party", "server")
        finally:
            cleanup()

    async def test_companion_error_retains_existing_fatal_behavior_with_safe_metadata(self):
        session = CS.CompanionSession(object())
        session.media_diagnostics = self.diagnostics
        session.rt_started.set()
        session.sync_error = mock.Mock()
        session.on_data_channel_message(json.dumps({"type": "error", "error": {
            "code": "session_expired", "message": "PRIVATE"}}))
        session.sync_error.assert_called_once_with("Personal assistant voice session error")
        self.assertEqual(self.lines[-1][1]["code"], "session_expired")
        self.assertEqual(session.rt_errors, ["Companion realtime error"])

    async def test_release_logs_local_origin_before_peer_close_and_is_idempotent(self):
        session = CS.CompanionSession(object())
        session.log_media_state = mock.Mock()
        async def close():
            self.assertTrue(session.local_media_release)
            session.log_media_state.assert_called_once()
        session.pc = types.SimpleNamespace(close=mock.AsyncMock(side_effect=close))
        await session._release_media()
        await session._release_media()
        session.pc.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
