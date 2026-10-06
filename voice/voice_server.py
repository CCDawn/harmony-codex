# voice_server.py — codex-harmony-remote personal-assistant voice bridge
#
# Bridges a device-facing WebSocket (plain PCM16 protocol) to the signed-in
# desktop's primary Companion room via its voice API and aiortc WebRTC.
# The production handler exclusively uses CompanionSession. Session retains
# the proven PCM media implementation and legacy diagnostic test hooks.
#
# Device protocol (frozen contract):
#   C->S text  {"type":"start"} -> {"type":"ready","profileName":...,"roomId":...}
#   C->S bin   raw PCM16LE 16kHz mono mic audio
#   C->S text  {"type":"interrupt"}                          -> drop pending outbound, speaking stop
#   C->S text  {"type":"stop"}                               -> {"type":"closed","reason":"requested"}
#   S->C text  {"type":"history","entries":[{itemId,role,text,final}]}
#   S->C text  {"type":"transcript","itemId":...,"role":...,"text":...,"final":bool}
#   S->C text  {"type":"speaking","state":"start"|"stop"}
#   S->C bin   raw PCM16LE 24kHz mono assistant audio
#   S->C text  {"type":"busy"} / {"type":"error",...} / {"type":"closed","reason":...}
#
# Usage: python voice_server.py [--port 8790]
import argparse
import asyncio
import fractions
import json
import os
import struct
import sys
import time
from pathlib import Path

import av
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

WORK = Path(__file__).resolve().parent
LOG_PATH = WORK / "voice-server.log"
SCRATCH = WORK / "voice-scratch"
ALLOWED_VOICES = {"juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"}
IDLE_TIMEOUT_S = 90.0        # no client binary audio for this long -> closed "idle"
SPEAKING_IDLE_S = 0.600      # outbound audio idle -> speaking stop
SDP_GATHER_WAIT_S = 3.0      # ICE candidate gathering wait (proven m1 value)
MEDIA_READY_TIMEOUT_S = 15.0
IN_FRAME_SAMPLES = 960       # 20ms @ 48kHz, stereo PCM16
IN_FRAME_BYTES = IN_FRAME_SAMPLES * 4
IN_BACKLOG_BYTES = 48000 * 4 * 2  # cap microphone jitter to two seconds
OUT_CHUNK_BYTES = 4800       # 100ms of 24k mono s16le
OUT_PACE_S = OUT_CHUNK_BYTES / 48000.0
OUT_BACKLOG_CAP = 480000     # 10s of 24k audio; beyond this drop oldest
CODEX_EXE_MIN_BYTES = 1 << 20  # 自动更新器会留 <1MB 的 codex.exe 残骸，选型时跳过

# ---- 下行重复异常音频检测 ----
# 静音是正常通话状态，不能据此判断上游故障。只对可听的周期重复音频保护挂断；
# 检测属于本地启发式判断，不代表上游模型状态。
ZOMBIE_WINDOW_SAMPLES = 72000   # 判定窗口：3s @ 24k（24000 样本/秒；144000 是字节不是样本）
ZOMBIE_WINDOW_BYTES = ZOMBIE_WINDOW_SAMPLES * 2
ZOMBIE_SEC_BYTES = 48000        # 1s @ 24k s16le，逐秒 RMS 包络
ZOMBIE_PERIOD_MIN = 1024        # 瓦片周期搜索范围（覆盖 1088±）
ZOMBIE_PERIOD_MAX = 1152
ZOMBIE_PERIOD_MATCH = 0.95      # x[k]==x[k+P] 命中率阈值 → 判瓦片
ZOMBIE_RMS_FLOOR = 200.0        # 低于该 RMS 视为静音秒，不参与包络对比
ZOMBIE_RMS_RATIO = 2.0          # 相邻有声秒 RMS 相差超该倍数 → 真实语音起伏
ZOMBIE_PROBE_STEPS = 1500       # 每个周期候选的确定性抽检步数（控 CPU）
ZOMBIE_ERROR_MESSAGE = "检测到持续重复的异常音频，通话已结束，请重试"

_log_fh = None

def log(event, detail=""):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % int((time.time() % 1) * 1000)
    line = f"{ts} {event}" + (f" {detail}" if detail else "")
    try:
        _log_fh.write(line + "\n")
        _log_fh.flush()
    except Exception:
        pass
    return line


def resolve_codex(stable_root=None, store_root=None):
    # Prefer the stable per-user install dir (newest first), then WindowsApps fallback.
    # 两个分支都要求 codex.exe >= 1MB：自动更新中断会留下 0 字节/小体积残骸，选了就起不来。
    if stable_root is None:
        local_app_data = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
        stable_root = local_app_data / "OpenAI" / "Codex" / "bin"
    if store_root is None:
        store_root = Path(r"C:\Program Files\WindowsApps")
    if stable_root.is_dir():
        dirs = [p for p in stable_root.iterdir() if p.is_dir()]
        for d in sorted(dirs, key=lambda p: p.stat().st_mtime, reverse=True):
            exe = d / "codex.exe"
            if exe.exists() and exe.stat().st_size >= CODEX_EXE_MIN_BYTES:
                return str(exe)
    for d in sorted([p for p in store_root.iterdir() if p.name.startswith("OpenAI.Codex_")], reverse=True):
        exe = d / "app" / "resources" / "codex.exe"
        if exe.exists() and exe.stat().st_size >= CODEX_EXE_MIN_BYTES:
            return str(exe)
    raise RuntimeError("no codex.exe found")


# ---- 下行僵尸音频判定（纯函数，便于单测） ----
def pcm16_rms(raw):
    """PCM16LE 字节流的 RMS 幅值（0-32768 量纲）。"""
    n = len(raw) // 2
    if n == 0:
        return 0.0
    acc = 0
    for (v,) in struct.iter_unpack("<h", raw):
        acc += v * v
    return (acc / n) ** 0.5


def zombie_period_ratio(raw, period, probes=ZOMBIE_PROBE_STEPS):
    """x[k]==x[k+period] 在整个窗口上的抽检命中率（确定性等距取样，不随机）。"""
    n = len(raw) // 2
    span = n - period
    if span <= 0:
        return 0.0
    step = span // probes if span > probes else 1
    total = match = 0
    for k in range(0, span, step):
        if raw[2 * k] == raw[2 * (k + period)] and raw[2 * k + 1] == raw[2 * (k + period) + 1]:
            match += 1
        total += 1
    return match / total


def judge_zombie(raw):
    """窗口满 3s 时判定：返回 "zero"（全零）/ "tile"（周期瓦片）/ "clean"（真信号）。

    非全零且走完所有周期候选都未达 95% 命中 → 最优周期也有 >5%（远超 1% 阈值）
    的采样打破周期，按"非周期非全零"的真信号处理。"""
    if not raw.strip(b"\x00"):
        return "zero"
    for period in range(ZOMBIE_PERIOD_MIN, ZOMBIE_PERIOD_MAX + 1):
        if zombie_period_ratio(raw, period) >= ZOMBIE_PERIOD_MATCH:
            return "tile"
    return "clean"


class ZombieDetector:
    """Observe sent audio, ignoring silence and protecting against audible tiles."""

    def __init__(self):
        self.disabled = False
        self.buf = bytearray()
        self.sec_rms = []              # 已完成的逐秒 RMS（最多保留一对）

    def reset(self):
        """丢弃未判定的累计数据（interrupt 清旧下行时、窗口被消费后调用）。"""
        self.buf.clear()
        self.sec_rms.clear()

    def disable(self):
        self.disabled = True
        self.reset()

    def feed(self, chunk):
        """喂入一段已发给客户端的 24k PCM16LE。返回 True 表示判定为僵尸。"""
        if self.disabled:
            return False
        self.buf += chunk
        if self._check_envelope():
            return False
        if len(self.buf) < ZOMBIE_WINDOW_BYTES:
            return False
        window = bytes(self.buf[:ZOMBIE_WINDOW_BYTES])
        verdict = judge_zombie(window)
        self.reset()
        if verdict == "zero" or pcm16_rms(window) < ZOMBIE_RMS_FLOOR:
            # Keep observing: silence does not prove a failure or a healthy reply.
            return False
        if verdict == "tile":
            log("zombie-verdict", verdict)
            return True
        if verdict == "clean":
            # 一整窗"非周期非全零"数据 → 见过真语音，永久解除
            log("zombie-escape", "clean-window")
            self.disable()
        return False

    def _check_envelope(self):
        # 逐秒 RMS 包络：相邻有声秒能量差显著 → 真实语音起伏，永久解除
        while (len(self.sec_rms) < 2
               and len(self.buf) >= (len(self.sec_rms) + 1) * ZOMBIE_SEC_BYTES):
            off = len(self.sec_rms) * ZOMBIE_SEC_BYTES
            self.sec_rms.append(pcm16_rms(bytes(self.buf[off:off + ZOMBIE_SEC_BYTES])))
        if len(self.sec_rms) == 2:
            a, b = self.sec_rms
            if (a >= ZOMBIE_RMS_FLOOR and b >= ZOMBIE_RMS_FLOOR
                    and max(a, b) >= min(a, b) * ZOMBIE_RMS_RATIO):
                log("zombie-escape", f"rms {a:.0f}->{b:.0f}")
                self.disable()
                return True
        return False


class AppServer:
    """codex app-server process + JSON-RPC channel. Spawned lazily, reused across
    sessions; initialize/initialized handshake runs exactly once per process."""

    def __init__(self):
        self.proc = None
        self.next_id = 1
        self.pending = {}
        self.on_notify = None          # callback(method, params) -> None
        self.on_death = None           # callback() -> None
        self._lock = asyncio.Lock()

    def alive(self):
        return self.proc is not None and self.proc.returncode is None

    async def ensure(self):
        async with self._lock:
            if self.alive():
                return self
            SCRATCH.mkdir(exist_ok=True)
            exe = resolve_codex()
            env = {**os.environ,
                   "HTTP_PROXY": "http://127.0.0.1:7890",
                   "HTTPS_PROXY": "http://127.0.0.1:7890",
                   "ALL_PROXY": "http://127.0.0.1:7890",
                   "NO_PROXY": "127.0.0.1,localhost",
                   "RUST_LOG": "warn"}
            self.proc = await asyncio.create_subprocess_exec(
                exe, "app-server", "--enable", "realtime_conversation", "--stdio",
                "--disable", "shell_tool",
                cwd=str(SCRATCH),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=env)
            log("appserver-spawn", f"pid={self.proc.pid}")
            asyncio.create_task(self._reader())
            asyncio.create_task(self._stderr_pump())
            init = await self.req("initialize", {
                "clientInfo": {"name": "codex-harmony-remote-voice", "title": "Harmony Remote Voice",
                               "version": "0.1.0"},
                "capabilities": {"experimentalApi": True}}, timeout=30)
            if init.get("error"):
                raise RuntimeError(f"initialize failed: {json.dumps(init['error'])[:300]}")
            self.notify("initialized")
            log("appserver-initialized", f"pid={self.proc.pid}")
            return self

    async def _reader(self):
        proc = self.proc
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = self.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                    continue
                if "method" not in msg:
                    continue
                method = msg["method"]
                params = msg.get("params") or {}
                if "id" in msg:
                    # server -> client request: fail closed (deny everything), log the method
                    log("srv-request-denied", method)
                    try:
                        proc.stdin.write((json.dumps({
                            "jsonrpc": "2.0", "id": msg["id"],
                            "error": {"code": -32601,
                                      "message": "voice server denies server requests"}}) + "\n").encode())
                    except Exception:
                        pass
                    continue
                if method.startswith("mcpServer"):
                    continue
                # SDP includes ICE credentials; record event names, not SDP contents.
                detail = sorted(params) if method == "thread/realtime/sdp" else params
                log("notify", f"{method} {json.dumps(detail, ensure_ascii=False)[:300]}")
                if self.on_notify:
                    try:
                        self.on_notify(method, params)
                    except Exception as e:
                        log("notify-handler-error", f"{type(e).__name__}: {e}")
        except Exception as e:
            log("appserver-reader-error", f"{type(e).__name__}: {e}")
        finally:
            log("appserver-exit", f"pid={proc.pid if proc else '?'}")
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("app-server exited"))
            self.pending.clear()
            if self.on_death:
                try:
                    self.on_death()
                except Exception:
                    pass

    async def _stderr_pump(self):
        try:
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    break
                s = line.decode(errors="replace").strip()
                if s:
                    log("codex-stderr", s[:400])
        except Exception:
            pass

    async def req(self, method, params=None, timeout=30):
        if not self.alive():
            raise RuntimeError("app-server not running")
        fid = self.next_id
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[fid] = fut
        self.proc.stdin.write((json.dumps(
            {"jsonrpc": "2.0", "id": fid, "method": method, "params": params or {}}) + "\n").encode())
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(fid, None)
            return {"error": {"message": f"timeout waiting for {method}"}}

    def notify(self, method, params=None):
        try:
            self.proc.stdin.write((json.dumps(
                {"jsonrpc": "2.0", "method": method, "params": params or {}}) + "\n").encode())
        except Exception:
            pass

    def kill(self):
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.kill()
            except Exception:
                pass


APP = AppServer()


class PcmTrack(MediaStreamTrack):
    """Clocked 48k stereo track; fill missing microphone input with silence."""

    kind = "audio"

    def __init__(self):
        super().__init__()
        self.pcm = bytearray()
        self.to48k = av.AudioResampler(format="s16", layout="stereo", rate=48000)
        self.next_pts = 0
        self.next_at = None
        self.halt = False
        self.frames_sent = 0
        self.dropped_bytes = 0
        self.max_sent_rms = 0.0

    async def push(self, chunk):
        if self.halt:
            return
        if len(chunk) % 2:
            raise ValueError("microphone PCM16 requires complete samples")
        n = len(chunk) // 2
        if n == 0:
            return
        frame = av.AudioFrame(format="s16", layout="mono", samples=n)
        frame.sample_rate = 16000
        frame.planes[0].update(chunk)
        for f in self.to48k.resample(frame):
            self.pcm.extend(bytes(f.planes[0])[:f.samples * 4])
        if len(self.pcm) > IN_BACKLOG_BYTES:
            drop = len(self.pcm) - IN_BACKLOG_BYTES
            del self.pcm[:drop]
            self.dropped_bytes += drop
            log("inbound-drop", f"{drop}B backlog cap")

    async def recv(self):
        if self.halt or self.readyState != "live":
            raise MediaStreamError
        loop = asyncio.get_running_loop()
        scheduled = self.next_at if self.next_at is not None else loop.time()
        await asyncio.sleep(max(0, scheduled - loop.time()))
        if self.halt or self.readyState != "live":
            raise MediaStreamError
        # Preserve the clock across small Windows timer delays; rebase on stalls.
        now = loop.time()
        period = IN_FRAME_SAMPLES / 48000
        self.next_at = (now if now - scheduled >= period else scheduled) + period
        data = bytes(self.pcm[:IN_FRAME_BYTES])
        del self.pcm[:IN_FRAME_BYTES]
        self.frames_sent += 1
        self.max_sent_rms = max(self.max_sent_rms, pcm16_rms(data))
        frame = av.AudioFrame(format="s16", layout="stereo", samples=IN_FRAME_SAMPLES)
        frame.sample_rate = 48000
        frame.planes[0].update(data.ljust(IN_FRAME_BYTES, b"\x00"))
        frame.pts = self.next_pts
        frame.time_base = fractions.Fraction(1, 48000)
        self.next_pts += IN_FRAME_SAMPLES
        return frame

    def halt_stream(self):
        self.halt = True
        self.pcm.clear()
        self.stop()


class Session:
    """One device voice session: fresh thread + realtime session per start."""

    def __init__(self, ws, voice=None, prompt=None):
        self.ws = ws
        self.voice = voice if voice in ALLOWED_VOICES else None
        self.prompt = prompt if isinstance(prompt, str) and prompt.strip() else None
        self.thread_id = None
        self.track = None
        self.pc = None
        self.gen = 0                    # outbound generation (interrupt bumps this)
        self.out_buf = bytearray()      # resampled 24k mono assistant audio
        self.out_evt = asyncio.Event()
        self.speaking = False
        self.last_out_sent = 0.0        # monotonic ts of last audible outbound chunk
        self.last_client_audio = time.monotonic()
        self.audio_bytes_in = 0
        self.audio_bytes_out = 0
        self.max_input_rms = 0.0
        self.max_output_rms = 0.0
        self.stopped = False
        self.close_sent = False
        self.requested_stop = False
        self.rt_answer = None
        self.rt_sdp_evt = asyncio.Event()
        self.rt_started = asyncio.Event()
        self.media_connected = asyncio.Event()
        self.rt_errors = []
        self.backend_closed = False
        self.transcript_items = {}
        self.zombie = ZombieDetector()  # 下行僵尸音频检测（只观测，不吞帧）
        self._tasks = []

    # ---- device I/O helpers ----
    async def send_json(self, obj):
        try:
            await self.ws.send(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass

    async def emit_closed(self, reason):
        if self.close_sent:
            return
        self.close_sent = True
        await self.send_json({"type": "closed", "reason": reason})

    # ---- lifecycle ----
    async def run(self):
        try:
            app = await APP.ensure()
            APP.on_notify = self.on_app_notify
            APP.on_death = self.on_app_death

            params = {"cwd": str(SCRATCH)}
            t = await app.req("thread/start", params, timeout=30)
            tid = ((t.get("result") or {}).get("thread") or {}).get("id")
            if not tid:
                raise RuntimeError(f"thread/start failed: {json.dumps(t)[:300]}")
            self.thread_id = tid
            log("session-thread", tid)

            await self.setup_webrtc(app)
            await self.wait_media_connected()
            self.last_client_audio = time.monotonic()
            log("session-ready", tid)
            await self.send_json({"type": "ready", "sessionId": tid})
            self._tasks = [
                asyncio.create_task(self.outbound_pump()),
                asyncio.create_task(self.speaker_watch()),
                asyncio.create_task(self.idle_watch()),
            ]
            await self.recv_loop()
        except Exception as e:
            log("session-error", f"{type(e).__name__}: {e}")
            if not self.close_sent:
                await self.send_json({"type": "error", "message": f"{type(e).__name__}: {e}"})
            await self.emit_closed("error")
        finally:
            await self.cleanup()
            log("session-end", f"thread={self.thread_id} in={self.audio_bytes_in} out={self.audio_bytes_out}")

    async def setup_webrtc(self, app=None):
        try:
            from .audio_recovery import offer_audio_recovery, enable_negotiated_audio_recovery
        except ImportError:
            from audio_recovery import offer_audio_recovery, enable_negotiated_audio_recovery
        offer_audio_recovery()
        self.track = PcmTrack()
        pc = RTCPeerConnection()
        self.pc = pc
        pc.addTrack(self.track)
        # offer an OpenAI-style control datachannel (session events may flow here)
        try:
            dc = pc.createDataChannel(getattr(self, "data_channel_label", "odata"), ordered=True)

            @dc.on("message")
            def _on_dc(msg):
                self.on_data_channel_message(msg)
        except Exception as e:
            log("datachannel-offer-failed", str(e))

        out_resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)

        @pc.on("track")
        def on_track(remote):
            log("inbound-track", remote.kind)

            async def pump():
                while True:
                    try:
                        for f in out_resampler.resample(await remote.recv()):
                            self.out_buf += bytes(f.planes[0])[:f.samples * 2]
                            if len(self.out_buf) > OUT_BACKLOG_CAP:
                                drop = len(self.out_buf) - OUT_BACKLOG_CAP // 2
                                del self.out_buf[:drop]
                                log("outbound-drop", f"{drop}B backlog cap")
                            self.out_evt.set()
                    except Exception as e:
                        log("outbound-pump-end", type(e).__name__)
                        break

            asyncio.ensure_future(pump())

        @pc.on("connectionstatechange")
        def on_cs():
            log("pc-state", pc.connectionState)
            if pc.connectionState == "connected":
                self.media_connected.set()
            elif pc.connectionState in ("failed", "closed") and not self.stopped:
                self.sync_error(f"WebRTC connection {pc.connectionState}")

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await asyncio.sleep(SDP_GATHER_WAIT_S)
        local_sdp = pc.localDescription.sdp
        log("offer-ready", f"{len(local_sdp)}B audio={'m=audio' in local_sdp}")

        self.rt_answer = await self.exchange_offer(app, local_sdp)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=self.rt_answer, type="answer"))
        recovery_receivers = enable_negotiated_audio_recovery(pc)
        log("audio-recovery", f"nack_receivers={recovery_receivers} capacity=64 prefetch=4")
        await self.after_remote_description()
        log("answer-applied")

    def on_data_channel_message(self, msg):
        try:
            event_type = json.loads(msg).get("type", "unknown")
        except Exception:
            event_type = "unparsed"
        log("datachannel", str(event_type))

    async def after_remote_description(self):
        pass

    async def exchange_offer(self, app, local_sdp):

        start_params = {
            "threadId": self.thread_id,
            "outputModality": "audio",
            "includeStartupContext": False,
            "clientManagedHandoffs": False,
            "transport": {"type": "webrtc", "sdp": local_sdp},
            "version": "v3",
        }
        if self.voice:
            start_params["voice"] = self.voice
        if self.prompt:
            start_params["prompt"] = self.prompt
        rs = await app.req("thread/realtime/start", start_params, timeout=30)
        if rs.get("error"):
            raise RuntimeError(f"realtime/start failed: {json.dumps(rs['error'])[:300]}")
        log("realtime-start-accepted")

        try:
            await asyncio.wait_for(self.rt_sdp_evt.wait(), 25)
        except asyncio.TimeoutError:
            pass
        if not self.rt_answer:
            raise RuntimeError(f"no answer sdp; rt_errors={self.rt_errors[:2]}")
        if self.rt_errors or self.backend_closed or self.close_sent:
            raise RuntimeError("realtime ended before media setup completed")
        return self.rt_answer

    async def wait_media_connected(self):
        deadline = asyncio.get_running_loop().time() + MEDIA_READY_TIMEOUT_S
        while True:
            state = self.pc.connectionState if self.pc else "missing"
            if self.rt_errors:
                raise RuntimeError(f"realtime error before ready: {self.rt_errors[-1]}")
            if self.backend_closed or self.close_sent or self.stopped:
                raise RuntimeError("realtime closed before ready")
            if state in ("failed", "closed"):
                raise RuntimeError(f"WebRTC connection {state} before ready")
            if self.rt_started.is_set() and state == "connected":
                log("media-connected")
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f"voice not ready: realtime_started={self.rt_started.is_set()} media={state}")
            await asyncio.sleep(0.02)

    # ---- app-server notifications routed here ----
    def on_app_notify(self, method, params):
        tid = params.get("threadId")
        if tid and self.thread_id and tid != self.thread_id:
            return
        if method == "thread/realtime/sdp":
            self.rt_answer = params.get("sdp") or (params.get("answer") or {}).get("sdp")
            self.rt_sdp_evt.set()
        elif method == "thread/realtime/started":
            self.rt_started.set()
        elif method == "thread/realtime/error":
            msg = str(params.get("message", ""))[:300]
            self.rt_errors.append(msg)
            self.rt_sdp_evt.set()
            self.sync_error(msg)
        elif method == "thread/realtime/item/transcript/delta":
            item_id = params.get("itemId")
            role = self.transcript_items.get(item_id)
            if role:
                asyncio.ensure_future(self.send_json({
                    "type": "transcript", "itemId": item_id, "role": role,
                    "text": params.get("delta", ""), "final": False}))
        elif method == "thread/realtime/transcript/delta":
            if self.transcript_items:
                return  # The item stream is authoritative; legacy events duplicate it.
            # contract: final=false transcript event (role: user|assistant)
            asyncio.ensure_future(self.send_json({
                "type": "transcript", "role": params.get("role", "assistant"),
                "text": params.get("delta", ""), "final": False}))
        elif method == "thread/realtime/transcript/done":
            if self.transcript_items:
                return
            # contract: final=true transcript event
            asyncio.ensure_future(self.send_json({
                "type": "transcript", "role": params.get("role", "assistant"),
                "text": params.get("text", ""), "final": True}))
        elif method == "thread/realtime/closed":
            self.backend_closed = True
            self.rt_sdp_evt.set()
            log("realtime-closed", str(params.get("reason", "")))
            if not self.requested_stop and not self.close_sent:
                asyncio.ensure_future(self.finish("error"))
        elif method in ("thread/realtime/item/started", "thread/realtime/item/completed",
                        "thread/realtime/itemAdded"):
            item = params.get("item") or {}
            if item.get("type") == "transcriptSegment" and item.get("id"):
                item_id = item["id"]
                role = item.get("role", "assistant")
                self.transcript_items[item_id] = role
                if method == "thread/realtime/item/completed":
                    asyncio.ensure_future(self.send_json({
                        "type": "transcript", "itemId": item_id, "role": role,
                        "text": item.get("text", ""), "final": True}))
            if item.get("type") not in ("realtimeSessionStarted", "realtimeSessionClosed"):
                log("realtime-item", json.dumps(item, ensure_ascii=False)[:200])

    def on_app_death(self):
        self.rt_errors.append("app-server process exited")
        self.rt_sdp_evt.set()
        self.sync_error("app-server process exited")

    def sync_error(self, msg):
        """Fatal backend-side problem while the session is live."""
        if self.close_sent or self.requested_stop:
            return
        log("session-fatal", msg)

        async def _fail():
            try:
                await self.send_json({"type": "error", "message": msg})
            except Exception:
                pass
            await self.finish("error")
            try:
                await self.ws.close()
            except Exception:
                pass
        asyncio.ensure_future(_fail())

    async def fail_zombie(self):
        """Report the local repeated-audio diagnosis and close cleanly."""
        if self.close_sent or self.requested_stop:
            return
        log("session-zombie", f"out={self.audio_bytes_out}")
        await self.send_json({"type": "error", "message": ZOMBIE_ERROR_MESSAGE})
        await self.emit_closed("error")
        try:
            await self.ws.close()  # 正常关闭握手，recv_loop 自然退出后走 cleanup()
        except Exception:
            pass

    # ---- device frame loop ----
    async def recv_loop(self):
        async for raw in self.ws:
            if isinstance(raw, bytes):
                self.last_client_audio = time.monotonic()
                self.audio_bytes_in += len(raw)
                self.max_input_rms = max(self.max_input_rms, pcm16_rms(raw))
                if self.track and not self.track.halt:
                    await self.track.push(bytes(raw))
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                await self.send_json({"type": "error", "message": "malformed json frame"})
                continue
            mtype = msg.get("type")
            if mtype == "stop":
                self.requested_stop = True
                log("client-stop")
                await self.finish("requested")
                return
            elif mtype == "interrupt":
                self.gen += 1
                dropped = len(self.out_buf)
                self.out_buf.clear()
                self.zombie.reset()  # 旧下行被丢弃，检测窗口同步作废重来
                log("client-interrupt", f"gen={self.gen} dropped={dropped}B")
                if self.speaking:
                    self.speaking = False
                    await self.send_json({"type": "speaking", "state": "stop"})
                # v1: server-side response is NOT cancelled; only local pending
                # outbound audio is dropped. Backend keeps listening via webrtc.
            elif mtype == "start":
                await self.send_json({"type": "error", "message": "session already started"})
            else:
                log("client-unknown-frame", str(msg)[:120])

    # ---- outbound audio pacer (24k mono -> device, ~1x realtime) ----
    async def outbound_pump(self):
        next_send_at = None
        try:
            while not self.stopped:
                if len(self.out_buf) < OUT_CHUNK_BYTES:
                    self.out_evt.clear()
                    try:
                        await asyncio.wait_for(self.out_evt.wait(), 0.5)
                    except asyncio.TimeoutError:
                        continue
                    continue
                chunk = bytes(self.out_buf[:OUT_CHUNK_BYTES])
                del self.out_buf[:OUT_CHUNK_BYTES]
                chunk_rms = pcm16_rms(chunk)
                self.max_output_rms = max(self.max_output_rms, chunk_rms)
                audible = chunk_rms >= ZOMBIE_RMS_FLOOR
                if audible and not self.speaking:
                    self.speaking = True
                    await self.send_json({"type": "speaking", "state": "start"})
                try:
                    await self.ws.send(chunk)
                except Exception:
                    return
                self.audio_bytes_out += len(chunk)
                if audible:
                    self.last_out_sent = time.monotonic()
                if self.zombie.feed(chunk):
                    await self.fail_zombie()
                    return
                now = time.monotonic()
                if next_send_at is None or now - next_send_at >= OUT_PACE_S:
                    next_send_at = now
                next_send_at += OUT_PACE_S
                await asyncio.sleep(max(0, next_send_at - time.monotonic()))
        except asyncio.CancelledError:
            pass

    async def speaker_watch(self):
        try:
            while not self.stopped:
                await asyncio.sleep(0.15)
                if (self.speaking and self.last_out_sent > 0
                        and time.monotonic() - self.last_out_sent >= SPEAKING_IDLE_S):
                    self.speaking = False
                    await self.send_json({"type": "speaking", "state": "stop"})
        except asyncio.CancelledError:
            pass

    async def idle_watch(self):
        try:
            while not self.stopped:
                await asyncio.sleep(5)
                # Numeric health evidence only; never record microphone samples
                # or transcript text while diagnosing a silent call.
                track = self.track
                log("audio-health", json.dumps({
                    "input_bytes": self.audio_bytes_in,
                    "output_bytes": self.audio_bytes_out,
                    "input_peak_rms": round(self.max_input_rms, 1),
                    "output_peak_rms": round(self.max_output_rms, 1),
                    "track_frames": track.frames_sent if track else 0,
                    "track_peak_rms": round(track.max_sent_rms, 1) if track else 0,
                    "queued_bytes": len(track.pcm) if track else 0,
                    "dropped_bytes": track.dropped_bytes if track else 0,
                    "input_age_s": round(time.monotonic() - self.last_client_audio, 1),
                    "peer": self.pc.connectionState if self.pc else "none",
                }))
                self.max_input_rms = self.max_output_rms = 0.0
                if track:
                    track.max_sent_rms = 0.0
                if time.monotonic() - self.last_client_audio >= IDLE_TIMEOUT_S:
                    log("session-idle-timeout")
                    await self.finish("idle")
                    try:
                        await self.ws.close()
                    except Exception:
                        pass
                    return
        except asyncio.CancelledError:
            pass

    # ---- teardown ----
    async def finish(self, reason):
        if self.close_sent:
            return
        await self.emit_closed(reason)

    async def cleanup(self):
        self.stopped = True
        for t in self._tasks:
            t.cancel()
        app_alive = APP.alive()
        if app_alive and self.thread_id and not self.backend_closed:
            try:
                await asyncio.wait_for(
                    APP.req("thread/realtime/stop", {"threadId": self.thread_id}, timeout=5), 6)
                log("realtime-stop-sent")
            except Exception:
                log("realtime-stop-failed")
        if self.track:
            self.track.halt_stream()
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass
        if APP.on_notify is not None:
            APP.on_notify = None
            APP.on_death = None


# ---- websocket handler / session lock ----
_session_lock = asyncio.Lock()
_active = None  # currently active Session


async def handler(ws):
    global _active
    peer = getattr(ws, "remote_address", None)
    log("ws-open", str(peer))
    try:
        # protocol allows start on the first frame; peek frames until start/busy decision
        first_raw = await ws.recv()
        if first_raw is None:
            return
        try:
            first = json.loads(first_raw) if isinstance(first_raw, str) else {}
        except Exception:
            first = {}
        if not isinstance(first, dict) or first.get("type") != "start":
            await ws.send(json.dumps({"type": "error",
                                      "message": "expected start frame first"}))
            return
        async with _session_lock:
            if _active is not None and not _active.close_sent and not _active.stopped:
                log("ws-busy", str(peer))
                await ws.send(json.dumps({"type": "busy"}))
                await ws.close()
                return
            from companion_session import CompanionSession
            sess = CompanionSession(ws)
            _active = sess
        try:
            await sess.run()
        finally:
            async with _session_lock:
                if _active is sess:
                    _active = None
    except Exception as e:
        log("ws-handler-error", f"{type(e).__name__}: {e}")
    finally:
        log("ws-close", str(peer))


async def main():
    global _log_fh
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    _log_fh = open(LOG_PATH, "a", encoding="utf-8")
    SCRATCH.mkdir(exist_ok=True)
    log("server-boot", f"port={args.port}")

    import websockets.asyncio.server as wss

    # Some mobile transports delay control-frame Pong while PCM is still flowing.
    # Keep protocol Pings for NAT, but let the 90s inbound-audio watchdog own
    # liveness rather than closing an actively sending phone after 20s.
    async with wss.serve(handler, "127.0.0.1", args.port, max_size=1 << 20,
                         ping_interval=20, ping_timeout=None):
        print(f"VOICE-SERVER listening 127.0.0.1:{args.port}", flush=True)
        try:
            await asyncio.get_running_loop().create_future()  # run forever
        finally:
            log("server-shutdown")
            APP.kill()


if __name__ == "__main__":
    # CompanionSession imports this media base; share the running module/log.
    sys.modules["voice_server"] = sys.modules[__name__]
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
