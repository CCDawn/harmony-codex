"""Offline tests for the Companion voice-session adapter.

Run from the repository root with:
  python -m unittest -v test.companion_session_harness

The harness stubs only the optional aiortc/PyAV imports; it starts no desktop
client, browser, microphone, app-server, or Companion API request.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[1]
VOICE_DIR = REPO_ROOT / "voice"


def _stub(name, **attrs):
    module = sys.modules.get(name) or types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


_stub("av", AudioResampler=object)
_stub("aiortc", RTCPeerConnection=object, RTCSessionDescription=object)
_stub("aiortc.mediastreams",
      MediaStreamError=type("MediaStreamError", (Exception,), {}),
      MediaStreamTrack=object)

if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))
import voice_server as VS  # noqa: E402
import companion_session as CS  # noqa: E402


class FakeStdout:
    def __init__(self):
        self.lines = asyncio.Queue()

    async def readline(self):
        return await self.lines.get()


class FakeStdin:
    def __init__(self, stdout, responder):
        self.stdout = stdout
        self.responder = responder
        self.buffer = bytearray()

    def write(self, data):
        self.buffer.extend(data)

    async def drain(self):
        request = json.loads(bytes(self.buffer).decode("utf-8"))
        self.buffer.clear()
        result = self.responder(request)
        await self.stdout.lines.put((json.dumps({"id": request["id"], "result": result}) + "\n").encode())


class FakeHelperProcess:
    def __init__(self, responder):
        self.returncode = None
        self.stdout = FakeStdout()
        self.stdin = FakeStdin(self.stdout, responder)


class CompanionSessionHarness(unittest.IsolatedAsyncioTestCase):
    async def test_rpc_is_line_json_and_correlates_response_id(self):
        seen = []

        def respond(request):
            seen.append(request)
            return {"entries": []}

        session = CS.CompanionSession(ws=object())
        session.helper = FakeHelperProcess(respond)

        result = await session._rpc("history", {"roomId": "room-1"})

        self.assertEqual(result, {"entries": []})
        self.assertEqual(seen, [{"id": 1, "method": "history", "params": {"roomId": "room-1"}}])
        self.assertEqual(CS.RPC_STDOUT_LIMIT, 4 * 1024 * 1024)

    async def test_windows_helper_is_started_without_console_window(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            helper_path = Path(temp_dir) / "companion_rpc.mjs"
            helper_path.write_text("", encoding="utf-8")
            session = CS.CompanionSession(ws=object(), helper_path=helper_path)
            process = object()
            with mock.patch.object(CS.os, "name", "nt"), \
                    mock.patch.object(CS.asyncio, "create_subprocess_exec",
                                      new=mock.AsyncMock(return_value=process)) as spawn:
                await session._start_helper()

        self.assertIs(session.helper, process)
        self.assertEqual(spawn.await_args.kwargs["creationflags"], 0x08000000)

    async def test_start_and_attach_are_scoped_to_owned_call(self):
        session = CS.CompanionSession(ws=object())
        session._rpc = mock.AsyncMock(side_effect=[
            {"callId": "rtc_owned-1", "sdp": "v=0\r\nanswer"},
            {"ok": True},
        ])

        answer = await session.exchange_offer(None, "v=0\r\noffer")
        await session.after_remote_description()

        self.assertEqual(answer, "v=0\r\nanswer")
        self.assertEqual(session._rpc.await_args_list, [
            mock.call("start", {"sdp": "v=0\r\noffer"}, timeout_s=CS.RPC_START_TIMEOUT_S),
            mock.call("attach", {}),
        ])
        self.assertEqual(session.call_id, "rtc_owned-1")
        self.assertTrue(session._owns_call)
        self.assertTrue(session.rt_started.is_set())

    async def test_history_is_sanitized_and_only_reemitted_when_changed(self):
        session = CS.CompanionSession(ws=object())
        session.send_json = mock.AsyncMock()
        original = [
            {"itemId": "room:1", "role": "user", "text": "你好", "final": True},
            {"itemId": "room:2", "role": "system", "text": "private", "final": True},
            {"itemId": "room:3", "role": "assistant", "text": "回复", "final": False},
        ]

        self.assertTrue(await session._publish_history(original, force=True))
        self.assertFalse(await session._publish_history(original))
        changed = [original[0], {"itemId": "room:4", "role": "assistant", "text": "可以", "final": True}]
        self.assertTrue(await session._publish_history(changed))

        self.assertEqual(session.send_json.await_args_list, [
            mock.call({"type": "history", "entries": [original[0]]}),
            mock.call({"type": "history", "entries": changed}),
        ])

    async def test_observed_turn_stream_is_authoritative_and_sdp_is_not_forwarded(self):
        session = CS.CompanionSession(ws=object())
        session.send_json = mock.AsyncMock()
        safe_logs = []

        with mock.patch.object(CS, "log", side_effect=lambda *args: safe_logs.append(args)):
            session.on_data_channel_message(json.dumps({
                "type": "turn.created",
                "turn": {"id": "turn-7", "role": "user", "transcript": "请帮我"},
            }))
            session.on_data_channel_message(json.dumps({
                "type": "turn.delta",
                "turn_id": "turn-7",
                "delta": "查一下",
                "sdp": "must-not-be-forwarded",
            }))
            session.on_data_channel_message(json.dumps({
                "type": "output_transcript.added",
                "item": {"id": "duplicate", "type": "transcript", "text": "must-not-be-forwarded"},
            }))
            session.on_data_channel_message(json.dumps({
                "type": "turn.done",
                "turn": {"id": "turn-7", "role": "user", "transcript": "请帮我查一下"},
            }))
            session.on_data_channel_message(json.dumps({
                "type": "turn.delta",
                "turn_id": "turn-7",
                "delta": "late delta must be ignored",
            }))
            session.on_data_channel_message(json.dumps({
                "type": "turn.created",
                "turn": {"id": "turn-8", "role": "system", "transcript": "must be ignored"},
            }))
            session.on_data_channel_message(json.dumps({"type": []}))
        await asyncio.sleep(0)

        self.assertEqual(session.send_json.await_args_list, [
            mock.call({"type": "transcript", "itemId": "voice:turn-7", "role": "user",
                       "text": "请帮我", "final": False}),
            mock.call({"type": "transcript", "itemId": "voice:turn-7", "role": "user",
                       "text": "查一下", "final": False}),
            mock.call({"type": "transcript", "itemId": "voice:turn-7", "role": "user",
                       "text": "请帮我查一下", "final": True}),
        ])
        log_details = " ".join(str(call) for call in safe_logs)
        self.assertIn("type=turn.created role=user chars=3 final=false", log_details)
        self.assertIn("type=turn.delta role=user chars=3 final=false", log_details)
        self.assertIn("type=turn.done role=user chars=6 final=true", log_details)
        self.assertNotIn("请帮我", log_details)
        self.assertNotIn("must-not-be-forwarded", log_details)

    async def test_transcript_captures_owned_call_identity_before_async_delivery(self):
        session = CS.CompanionSession(ws=object())
        session.profile_id = 'profile-a'
        session.room_id = 'room-a'
        session.call_id = 'rtc_a'
        session.send_json = mock.AsyncMock()
        session.on_data_channel_message(json.dumps({
            'type': 'turn.done',
            'turn': {'id': 'turn-a', 'role': 'assistant', 'transcript': '已完成'},
        }))
        # Cleanup can run before the websocket coroutine. Identity must not
        # disappear or be taken from a subsequent call at delivery time.
        session.call_id = None
        session.room_id = 'room-b'
        await asyncio.sleep(0)
        event = session.send_json.await_args.args[0]
        self.assertEqual(event['profileId'], 'profile-a')
        self.assertEqual(event['roomId'], 'room-a')
        self.assertEqual(event['callId'], 'rtc_a')
        self.assertEqual(event['role'], 'assistant')
        self.assertNotIn('synced', event)

    async def test_handler_routes_legacy_start_options_only_to_companion(self):
        class FakeWebSocket:
            remote_address = ("127.0.0.1", 4567)

            async def recv(self):
                return json.dumps({"type": "start", "voice": "maple", "prompt": "legacy"})

            async def send(self, _message):
                pass

            async def close(self):
                pass

        instances = []

        class FakeCompanionSession:
            def __init__(self, ws):
                self.ws = ws
                self.close_sent = False
                self.stopped = False
                instances.append(self)

            async def run(self):
                self.ran = True

        app = types.SimpleNamespace(ensure=mock.AsyncMock())
        legacy_session = mock.Mock(wraps=VS.Session)
        previous_active = VS._active
        VS._active = None
        try:
            with mock.patch.object(CS, "CompanionSession", FakeCompanionSession), \
                    mock.patch.object(VS, "Session", legacy_session), \
                    mock.patch.object(VS, "APP", app):
                await VS.handler(FakeWebSocket())
        finally:
            VS._active = previous_active

        self.assertEqual(len(instances), 1)
        self.assertTrue(instances[0].ran)
        legacy_session.assert_not_called()
        app.ensure.assert_not_awaited()

    async def test_cleanup_never_stops_a_call_this_session_did_not_create(self):
        session = CS.CompanionSession(ws=object())
        session._rpc = mock.AsyncMock()
        session._stop_helper = mock.AsyncMock()

        await session.cleanup()

        session._rpc.assert_not_awaited()
        session._stop_helper.assert_awaited_once_with()

    async def test_media_is_released_before_waiting_for_upstream_stop(self):
        session = CS.CompanionSession(ws=object())
        session._owns_call = True
        session.call_id = "rtc_owned-media"
        session.track = mock.Mock()
        session.pc = mock.Mock(close=mock.AsyncMock())
        async def stop(*args, **kwargs):
            session.track.halt_stream.assert_called_once_with()
            session.pc.close.assert_awaited_once_with()
            return {"ok": True}
        session._rpc = mock.AsyncMock(side_effect=stop)
        session._stop_helper = mock.AsyncMock()
        await session.cleanup()

    async def test_failed_stop_preserves_ownership_for_reconciliation(self):
        session = CS.CompanionSession(ws=object())
        session._owns_call = True
        session.call_id = "rtc_owned-pending"
        session._rpc = mock.AsyncMock(side_effect=CS.CompanionSessionError("Companion request timed out"))
        session._stop_helper = mock.AsyncMock()
        await session.cleanup()
        self.assertTrue(session._owns_call)
        self.assertEqual(session.call_id, "rtc_owned-pending")
        self.assertGreaterEqual(CS.RPC_STOP_TIMEOUT_S, 30)
        session._stop_helper.assert_awaited_once_with()

    async def test_cleanup_stops_only_a_call_owned_by_this_session(self):
        session = CS.CompanionSession(ws=object())
        session._owns_call = True
        session.call_id = "rtc_owned-9"
        session._rpc = mock.AsyncMock(return_value={"ok": True})
        session._stop_helper = mock.AsyncMock()

        await session.cleanup()

        session._rpc.assert_awaited_once_with("stop", {}, timeout_s=CS.RPC_STOP_TIMEOUT_S)
        self.assertFalse(session._owns_call)

    async def test_run_uses_companion_path_without_app_server_or_thread_start(self):
        session = CS.CompanionSession(ws=object())
        sent = []
        ready_sent = asyncio.Event()

        async def capture_event(event):
            sent.append(event)
            if event.get("type") == "ready":
                ready_sent.set()

        session._start_helper = mock.AsyncMock()

        async def discover():
            session.profile_id = "profile-1"
            session.profile_name = "熊大"
            session.room_id = "room-1"

        session._discover_profile = mock.AsyncMock(side_effect=discover)
        session.setup_webrtc = mock.AsyncMock()

        async def wait_for_media():
            self.assertEqual(sent[-1], {"type": "progress", "stage": "media"})

        session.wait_media_connected = mock.AsyncMock(side_effect=wait_for_media)
        session.send_json = mock.AsyncMock(side_effect=capture_event)
        session.outbound_pump = mock.AsyncMock()
        session.speaker_watch = mock.AsyncMock()
        session.idle_watch = mock.AsyncMock()
        session._history_poller = mock.AsyncMock()
        session.recv_loop = mock.AsyncMock(side_effect=ready_sent.wait)
        session._stop_helper = mock.AsyncMock()
        previous_app = VS.APP
        VS.APP = None
        try:
            await session.run()
        finally:
            VS.APP = previous_app

        session.setup_webrtc.assert_awaited_once_with(None)
        self.assertEqual(sent[:2], [
            {"type": "progress", "stage": "assistant"},
            {"type": "progress", "stage": "media"},
        ])
        self.assertEqual([event.get("type") for event in sent], [
            "progress", "progress", "ready",
        ])
        ready = next(event for event in sent if event.get("type") == "ready")
        self.assertEqual(ready, {"type": "ready", "profileName": "熊大", "roomId": "room-1", "profileId": "profile-1"})
        self.assertTrue(session._discover_profile.awaited)
        self.assertTrue(session.recv_loop.awaited)
        session._stop_helper.assert_awaited_once_with()

    async def test_rpc_preserves_only_strict_http_status_and_operation(self):
        for raw, expected in [("Companion HTTP 502", 502), ("private token and SDP", None),
                              ("Companion HTTP 502 private", None)]:
            session = CS.CompanionSession(ws=object())
            session.helper = FakeHelperProcess(lambda request: {})
            session._read_rpc_response = mock.AsyncMock(return_value={"id": 1, "error": raw})
            with self.assertRaises(CS.CompanionSessionError) as caught:
                await session._rpc("start")
            self.assertEqual(caught.exception.http_status, expected)
            self.assertEqual(caught.exception.operation, "start")
            self.assertNotIn("private", str(caught.exception))

    async def test_run_reports_upstream_status_without_private_message(self):
        session = CS.CompanionSession(ws=object())
        session.recv_loop = mock.AsyncMock(side_effect=asyncio.Event().wait)
        session._start_helper = mock.AsyncMock(side_effect=CS.CompanionSessionError(
            "private", http_status=502, operation="start"))
        session.send_json = mock.AsyncMock()
        session.emit_closed = mock.AsyncMock()
        session.cleanup = mock.AsyncMock()
        await session.run()
        event = session.send_json.await_args_list[-1].args[0]
        self.assertEqual(event["httpStatus"], 502)
        self.assertNotIn("private", str(event))

    async def test_run_reports_safe_assistant_failure_without_ready(self):
        session = CS.CompanionSession(ws=object())
        session.recv_loop = mock.AsyncMock(side_effect=asyncio.Event().wait)
        sent = []
        session._start_helper = mock.AsyncMock(
            side_effect=RuntimeError("private token and SDP must not escape"))
        session.send_json = mock.AsyncMock(side_effect=lambda event: sent.append(event))
        session.emit_closed = mock.AsyncMock()
        session.cleanup = mock.AsyncMock()

        await session.run()

        self.assertEqual(sent[0], {"type": "progress", "stage": "assistant"})
        self.assertEqual(sent[-1], {
            "type": "error",
            "failureStage": "assistant",
            "message": "个人助手准备失败",
        })
        self.assertFalse(any(event.get("type") == "ready" for event in sent))
        self.assertNotIn("private token", str(sent))
        session.emit_closed.assert_awaited_once_with("error")

    async def test_run_reports_safe_media_failure_without_ready(self):
        session = CS.CompanionSession(ws=object())
        session.recv_loop = mock.AsyncMock(side_effect=asyncio.Event().wait)
        sent = []
        session._start_helper = mock.AsyncMock()

        async def discover():
            session.profile_id = "profile-1"
            session.profile_name = "熊大"
            session.room_id = "room-1"

        session._discover_profile = mock.AsyncMock(side_effect=discover)
        session.setup_webrtc = mock.AsyncMock()
        session.wait_media_connected = mock.AsyncMock(
            side_effect=TimeoutError("private remote address and SDP must not escape"))
        session.send_json = mock.AsyncMock(side_effect=lambda event: sent.append(event))
        session.emit_closed = mock.AsyncMock()
        session.cleanup = mock.AsyncMock()

        await session.run()

        self.assertEqual(sent[:2], [
            {"type": "progress", "stage": "assistant"},
            {"type": "progress", "stage": "media"},
        ])
        self.assertEqual(sent[-1], {
            "type": "error",
            "failureStage": "media",
            "message": "语音媒体连接失败",
        })
        self.assertFalse(any(event.get("type") == "ready" for event in sent))
        self.assertNotIn("private remote address", str(sent))
        session.emit_closed.assert_awaited_once_with("error")


if __name__ == "__main__":
    unittest.main()
