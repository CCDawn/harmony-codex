"""Voice-session adapter for the active personal-assistant Companion room.

The inherited Session owns the PCM/WebRTC media path. This adapter replaces
only the app-server thread/realtime control plane with the Companion desktop
RPC helper and keeps the helper's private call lifecycle scoped to this
session.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from collections import OrderedDict
from pathlib import Path

try:
    from .voice_server import Session, log
    from .playback_control import PlaybackControl
except ImportError:  # voice_server.py may also be run with its directory on sys.path
    from voice_server import Session, log
    from playback_control import PlaybackControl


RPC_HELPER = Path(__file__).resolve().with_name("companion_rpc.mjs")
RPC_STDOUT_LIMIT = 4 * 1024 * 1024
RPC_TIMEOUT_S = 35.0
# start includes identity verification, optional orphan cleanup, and creation;
# discovery/recovery can use 30s, creation up to 45s including reply delivery.
# Do not apply a single-request 35s deadline
# to the complete sequence. The overall deadline remains bounded, with no retry.
RPC_START_TIMEOUT_S = 110.0
RPC_STOP_TIMEOUT_S = RPC_TIMEOUT_S
HELPER_EXIT_TIMEOUT_S = 2.0
HISTORY_POLL_INTERVAL_S = 2.0
MAX_HISTORY_ENTRIES = 32
MAX_TRANSCRIPT_EVENT_BYTES = 256 * 1024
MAX_TRACKED_TURNS = 512

_OWNED_CALL_ID = re.compile(r"^rtc_[^/?#]+$")
_ERROR_CODES = {"timeout", "cdp_connection", "http_error", "unknown_error"}
_ERROR_STAGES = {"discover", "history", "create", "attach", "stop", "reconcile", "unknown"}


class CompanionSessionError(RuntimeError):
    """An error with a fixed, log-safe message."""

    def __init__(self, message, *, http_status=None, operation=None, error_code=None, stage=None):
        super().__init__(message)
        self.http_status = http_status
        self.operation = operation
        self.error_code = error_code if error_code in _ERROR_CODES else None
        self.stage = stage if stage in _ERROR_STAGES else None


class CompanionSession(Session):
    """One voice call attached only to the selected personal assistant."""

    data_channel_label = "oai-events"

    _ERROR_EVENTS = {"error", "session.error", "response.error"}

    def __init__(self, ws, helper_path=None):
        super().__init__(ws)
        self.helper_path = Path(helper_path) if helper_path else RPC_HELPER
        self.helper = None
        self._rpc_lock = asyncio.Lock()
        self._next_rpc_id = 0
        self._owns_call = False
        self.call_id = None
        self.profile_id = None
        self.profile_name = None
        self.room_id = None
        self._last_history_entries = None
        self._turn_roles = OrderedDict()
        self._turn_initial_sent = set()
        self._completed_turns = set()
        self.cleanup_pending = True
        self._media_released = False
        self.playback_control = PlaybackControl()
        self._playback_admitted = True
        self._phone_ready = False
        self._playback_events = set()

    def should_buffer_output(self):
        return not self.playback_control_enabled or not self.playback_control.blocked

    def should_send_output(self):
        return self.should_buffer_output() and self._playback_admitted

    # Automatic interruption is owned by the upstream voice engine. Local VAD
    # and transcript turn creation are not cancellation acknowledgements: gating
    # here can discard an entire reply after a noise/echo false positive.
    # Inherit Session.on_microphone_audio so all input still reaches WebRTC.

    async def on_client_interrupt(self):
        if not self.playback_control_enabled or not self._phone_ready:
            await super().on_client_interrupt()
            return
        self._block_playback("manual")

    def _block_playback(self, source):
        revision = self.playback_control.block(user_confirmed=source == "user_turn")
        self._playback_admitted = False
        dropped = self.discard_pending_output()
        log("playback-control", f"state=blocked revision={revision} source={source} dropped={dropped}B")
        self._queue_playback_event("blocked", revision, source)

    def _queue_playback_event(self, state, revision, source):
        # Capture identity before cleanup, never send a later call's identity.
        identity = self._call_identity()
        task = asyncio.create_task(self._emit_playback_event(state, revision, source, identity))
        self._playback_events.add(task)
        task.add_done_callback(self._playback_events.discard)

    async def _emit_playback_event(self, state, revision, source, identity):
        async with self.output_lock:
            if self.stopped:
                return
            await self.send_json({"type": "playback", "state": state,
                                  "revision": revision, "source": source, **identity})
            if state == "blocked":
                await self.send_json({"type": "speaking", "state": "stop"})
            elif revision == self.playback_control.revision and not self.playback_control.blocked:
                # The ordered control event precedes any new PCM on this socket.
                self._playback_admitted = True
                self.out_evt.set()

    def _observe_playback_turn(self, turn_id, role):
        if role == "user":
            self.playback_control.user_started()
        else:
            revision = self.playback_control.assistant_started(turn_id)
            if revision is not None and self.playback_control_enabled and self._phone_ready:
                self._playback_admitted = False
                self.discard_pending_output()
                log("playback-control", f"state=resumed revision={revision} source=assistant_turn")
                self._queue_playback_event("resumed", revision, "assistant_turn")

    async def _start_helper(self):
        if not self.helper_path.is_file():
            raise CompanionSessionError("Companion helper unavailable")
        node = shutil.which("node") or "node"
        process_options = {}
        if os.name == "nt":
            process_options["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        try:
            self.helper = await asyncio.create_subprocess_exec(
                node,
                str(self.helper_path),
                cwd=str(self.helper_path.parent),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=RPC_STDOUT_LIMIT,
                **process_options,
            )
        except Exception as exc:
            raise CompanionSessionError("Companion helper could not start") from exc

    async def _rpc(self, method, params=None, timeout_s=RPC_TIMEOUT_S):
        process = self.helper
        if (process is None or process.returncode is not None
                or process.stdin is None or process.stdout is None):
            raise CompanionSessionError("Companion helper unavailable")

        async with self._rpc_lock:
            started = time.monotonic()
            operation = method if method in {"discover", "history", "start", "attach", "stop"} else "unknown"
            self._next_rpc_id += 1
            request_id = self._next_rpc_id
            request = {"id": request_id, "method": method, "params": params or {}}
            try:
                process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
                await process.stdin.drain()
                response = await self._read_rpc_response(process, request_id, timeout_s)
            except asyncio.TimeoutError as exc:
                log("companion-rpc-error", f"operation={operation} code=timeout stage=rpc elapsedMs={round((time.monotonic()-started)*1000)}")
                raise CompanionSessionError("Companion request timed out", operation=operation,
                                            error_code="timeout") from exc
            except asyncio.CancelledError:
                raise
            except CompanionSessionError:
                raise
            except Exception as exc:
                raise CompanionSessionError("Companion request failed") from exc

            if not isinstance(response, dict) or response.get("id") != request_id:
                raise CompanionSessionError("Companion response mismatch")
            if response.get("error"):
                # Only the helper's strict status format may cross this boundary.
                match = re.fullmatch(r"Companion HTTP ([1-5][0-9]{2})", str(response["error"]))
                status = int(match.group(1)) if match else None
                code = response.get("errorCode")
                code = code if isinstance(code, str) and code in _ERROR_CODES else ("http_error" if status else "unknown_error")
                stage = response.get("stage")
                stage = stage if isinstance(stage, str) and stage in _ERROR_STAGES else "unknown"
                if response.get("operation") == "reconcile":
                    operation = "reconcile"
                log("companion-rpc-error", f"operation={operation} code={code} stage={stage} http={status or 0} elapsedMs={round((time.monotonic()-started)*1000)}")
                raise CompanionSessionError("Companion request failed", http_status=status, operation=operation,
                                            error_code=code, stage=stage)
            result = response.get("result")
            if not isinstance(result, dict):
                raise CompanionSessionError("Companion response invalid")
            return result

    @staticmethod
    async def _read_rpc_response(process, request_id, timeout_s):
        """Read our response, discarding an older reply left by a cancelled RPC."""
        deadline = asyncio.get_running_loop().time() + timeout_s
        for _ in range(8):
            remaining = deadline - asyncio.get_running_loop().time()
            line = await asyncio.wait_for(process.stdout.readline(), timeout=max(0, remaining))
            if not line:
                raise CompanionSessionError("Companion helper closed")
            try:
                response = json.loads(line)
            except Exception as exc:
                raise CompanionSessionError("Companion response invalid") from exc
            if not isinstance(response, dict):
                raise CompanionSessionError("Companion response invalid")
            response_id = response.get("id")
            if response_id == request_id:
                return response
            if isinstance(response_id, int) and response_id < request_id:
                continue
            raise CompanionSessionError("Companion response mismatch")
        raise CompanionSessionError("Companion response mismatch")

    async def _discover_profile(self):
        profile = await self._rpc("discover", {})
        profile_id = profile.get("id")
        room_id = profile.get("roomId")
        name = profile.get("name")
        if not isinstance(profile_id, str) or not profile_id:
            raise CompanionSessionError("Personal assistant unavailable")
        if not isinstance(room_id, str) or not room_id:
            raise CompanionSessionError("Personal assistant room unavailable")
        self.profile_id = profile_id
        self.room_id = room_id
        self.profile_name = name.strip() if isinstance(name, str) and name.strip() else "个人助手"

    async def exchange_offer(self, app, local_sdp):
        """Create a Companion call using this session's generated WebRTC offer."""
        # Cancellation must not discard a late allocation receipt. Drain the
        # bounded create RPC, retain ownership, then let cleanup stop that call.
        pending = asyncio.create_task(self._allocate_call(local_sdp))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            try:
                await pending
            except Exception:
                log("companion-cancel-create-unresolved")
            raise

    async def _allocate_call(self, local_sdp):
        result = await self._rpc("start", {"sdp": local_sdp}, timeout_s=RPC_START_TIMEOUT_S)
        call_id = result.get("callId")
        if isinstance(call_id, str) and _OWNED_CALL_ID.fullmatch(call_id):
            self.call_id = call_id
            self._owns_call = True
        answer_sdp = result.get("sdp")
        if not isinstance(answer_sdp, str) or not answer_sdp.startswith("v=0"):
            raise CompanionSessionError("Personal assistant returned an invalid answer")
        if not self._owns_call:
            raise CompanionSessionError("Personal assistant call receipt invalid")
        return answer_sdp

    async def after_remote_description(self):
        if not self._owns_call:
            raise CompanionSessionError("Personal assistant call was not allocated")
        await self._rpc("attach", {})
        self.rt_started.set()

    def on_data_channel_message(self, msg):
        """Forward only observed turn transcript fields; never log raw events."""
        if isinstance(msg, str) and len(msg.encode("utf-8", errors="ignore")) > MAX_TRANSCRIPT_EVENT_BYTES:
            return
        if isinstance(msg, bytes) and len(msg) > MAX_TRANSCRIPT_EVENT_BYTES:
            return
        try:
            event = json.loads(msg)
        except Exception:
            return
        if not isinstance(event, dict):
            return

        event_type = event.get("type")
        if not isinstance(event_type, str):
            return
        self.media_diagnostics.control(event)
        if event_type in self._ERROR_EVENTS:
            self.rt_errors.append("Companion realtime error")
            if self.rt_started.is_set():
                self.sync_error("Personal assistant voice session error")
            return

        if event_type == "turn.created":
            turn = event.get("turn")
            if not isinstance(turn, dict):
                return
            turn_id = turn.get("id")
            role = turn.get("role")
            transcript = turn.get("transcript")
            if (not isinstance(turn_id, str) or not turn_id or len(turn_id) > 512
                    or role not in ("user", "assistant")
                    or not isinstance(transcript, str)):
                return
            if not self._remember_turn(turn_id, role):
                return
            if turn_id in self._turn_initial_sent:
                return
            self._turn_initial_sent.add(turn_id)
            self._observe_playback_turn(turn_id, role)
            self._log_turn_event(event_type, role, transcript, False)
            if transcript:
                self._send_turn_transcript(turn_id, role, transcript, False)
            return

        if event_type == "turn.delta":
            turn_id = event.get("turn_id")
            delta = event.get("delta")
            if (not isinstance(turn_id, str) or not turn_id or len(turn_id) > 512
                    or not isinstance(delta, str) or not delta
                    or turn_id in self._completed_turns):
                return
            role = self._turn_roles.get(turn_id)
            if role not in ("user", "assistant"):
                return
            self._log_turn_event(event_type, role, delta, False)
            self._send_turn_transcript(turn_id, role, delta, False)
            return

        if event_type == "turn.done":
            turn = event.get("turn")
            if not isinstance(turn, dict):
                return
            turn_id = turn.get("id")
            role = turn.get("role")
            transcript = turn.get("transcript")
            if (not isinstance(turn_id, str) or not turn_id or len(turn_id) > 512
                    or role not in ("user", "assistant")
                    or not isinstance(transcript, str)):
                return
            if not self._remember_turn(turn_id, role):
                return
            self._completed_turns.add(turn_id)
            if role == "user":
                self.playback_control.user_done()
            self._log_turn_event(event_type, role, transcript, True)
            self._send_turn_transcript(turn_id, role, transcript, True)

    def _remember_turn(self, turn_id, role):
        existing = self._turn_roles.get(turn_id)
        if existing is not None and existing != role:
            return False
        if existing is None:
            self._turn_roles[turn_id] = role
        while len(self._turn_roles) > MAX_TRACKED_TURNS:
            old_id, _ = self._turn_roles.popitem(last=False)
            self._turn_initial_sent.discard(old_id)
            self._completed_turns.discard(old_id)
        return True

    @staticmethod
    def _log_turn_event(event_type, role, text, final):
        log("companion-turn-transcript", " ".join((
            f"type={event_type}",
            f"role={role}",
            f"chars={len(text)}",
            f"final={str(bool(final)).lower()}",
        )))

    def _send_turn_transcript(self, turn_id, role, text, final):
        asyncio.get_running_loop().create_task(self.send_json({
            "type": "transcript",
            "itemId": f"voice:{turn_id}",
            "role": role,
            "text": text,
            "final": final,
            **self._call_identity(),
        }))

    def _call_identity(self):
        # Keep the official identity on each event; a delayed callback must not
        # become a message in whatever assistant the phone selected later.
        return {key: value for key, value in (
            ("profileId", self.profile_id), ("roomId", self.room_id),
            ("callId", self.call_id),
        ) if isinstance(value, str) and value}

    @staticmethod
    def _clean_history(entries):
        if not isinstance(entries, list):
            return []
        clean = []
        for entry in entries[:MAX_HISTORY_ENTRIES]:
            if not isinstance(entry, dict):
                continue
            item_id = entry.get("itemId")
            role = entry.get("role")
            text = entry.get("text")
            if (not isinstance(item_id, str) or not item_id or len(item_id) > 512
                    or role not in ("user", "assistant")
                    or not isinstance(text, str) or not text
                    or entry.get("final") is not True):
                continue
            clean.append({"itemId": item_id, "role": role, "text": text, "final": True})
        return clean

    async def _fetch_history(self):
        response = await self._rpc("history", {"roomId": self.room_id})
        return self._clean_history(response.get("entries"))

    async def _publish_history(self, entries, force=False):
        clean = self._clean_history(entries)
        if not force and clean == self._last_history_entries:
            return False
        await self.send_json({"type": "history", "entries": clean})
        self._last_history_entries = clean
        return True

    async def _history_poller(self):
        try:
            try:
                await self._publish_history(await self._fetch_history(), force=True)
            except asyncio.CancelledError:
                raise
            except Exception:
                log("companion-history-initial-failed")
                await self._publish_history([], force=True)
            while not self.stopped:
                await asyncio.sleep(HISTORY_POLL_INTERVAL_S)
                if self.stopped:
                    break
                try:
                    await self._publish_history(await self._fetch_history())
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log("companion-history-poll-failed")
        except asyncio.CancelledError:
            pass

    async def run(self):
        failure_stage = "assistant"
        startup = receiver = None

        async def prepare():
            nonlocal failure_stage
            await self._start_helper()
            await self._discover_profile()
            await self.setup_webrtc(None)
            failure_stage = "media"
            await self.send_json({"type": "progress", "stage": "media"})
            await self.wait_media_connected()

        try:
            await self.send_json({"type": "progress", "stage": "assistant"})
            # A single reader observes stop/disconnect even during discovery,
            # SDP gathering and call creation. It remains the reader when ready.
            receiver = asyncio.create_task(self.recv_loop())
            startup = asyncio.create_task(prepare())
            await asyncio.wait((receiver, startup), return_when=asyncio.FIRST_COMPLETED)
            if receiver.done():
                await receiver
                return
            await startup
            if self.close_sent or self.stopped:
                return
            self.last_client_audio = time.monotonic()
            log("companion-session-ready")
            await self.send_json({
                "type": "ready",
                **({"playbackControlVersion": 1,
                    "bargeInAvailable": False}
                   if self.playback_control_enabled else {}),
                "profileName": self.profile_name,
                "roomId": self.room_id,
                **self._call_identity(),
            })
            self._phone_ready = True
            log("playback-ready", f"version={1 if self.playback_control_enabled else 0} automatic=upstream")
            self._tasks = [
                asyncio.create_task(self.outbound_pump()),
                asyncio.create_task(self.speaker_watch()),
                asyncio.create_task(self.idle_watch()),
                asyncio.create_task(self._history_poller()),
            ]
            await receiver
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # This path deliberately hides exception text, which may contain private data.
            log("companion-session-error", type(exc).__name__)
            if not self.close_sent:
                message = ("个人助手准备失败" if failure_stage == "assistant"
                           else "语音媒体连接失败")
                await self.send_json({
                    "type": "error",
                    "failureStage": failure_stage,
                    "message": message,
                    **({"httpStatus": exc.http_status} if isinstance(exc, CompanionSessionError)
                       and exc.http_status is not None else {}),
                    **({"errorCode": exc.error_code} if isinstance(exc, CompanionSessionError)
                       and exc.error_code is not None else {}),
                    **({"operation": exc.operation} if isinstance(exc, CompanionSessionError)
                       and exc.operation in {"discover", "history", "start", "attach", "stop", "reconcile"} else {}),
                    **({"stage": exc.stage} if isinstance(exc, CompanionSessionError)
                       and exc.stage is not None else {}),
                })
            await self.emit_closed("error")
        finally:
            self.stopped = True
            for task in (receiver, startup):
                if task is not None and not task.done():
                    task.cancel()
            # Close local media before waiting for a late create receipt.
            await self._release_media()
            await asyncio.gather(*(t for t in (receiver, startup) if t is not None),
                                 return_exceptions=True)
            await self.cleanup()
            self.cleanup_pending = False
            log("companion-session-end", f"in={self.audio_bytes_in} out={self.audio_bytes_out}")

    async def _stop_owned_call(self):
        if not self._owns_call:
            return
        try:
            await self._rpc("stop", {}, timeout_s=RPC_STOP_TIMEOUT_S)
        except Exception:
            log("companion-stop-pending")
        else:
            self._owns_call = False
            self.call_id = None

    async def _stop_helper(self):
        process = self.helper
        self.helper = None
        if process is None or process.returncode is not None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
            await asyncio.wait_for(process.wait(), timeout=HELPER_EXIT_TIMEOUT_S)
        except asyncio.TimeoutError:
            log("companion-helper-terminate")
            try:
                process.kill()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(process.wait(), timeout=HELPER_EXIT_TIMEOUT_S)
            except Exception:
                pass
        except Exception:
            log("companion-helper-stop-failed")

    async def _release_media(self):
        if self._media_released:
            return
        self._media_released = True
        self.local_media_release = True
        self.log_media_state()
        if self.track:
            try:
                self.track.halt_stream()
            except Exception:
                log("companion-track-release-failed")
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass

    async def cleanup(self):
        self.stopped = True
        pending_controls = list(self._playback_events)
        for task in pending_controls:
            task.cancel()
        if pending_controls:
            await asyncio.gather(*pending_controls, return_exceptions=True)
        self._playback_events.clear()
        tasks = list(self._tasks)
        self._tasks = []
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._release_media()
        await self._stop_owned_call()
        await self._stop_helper()
