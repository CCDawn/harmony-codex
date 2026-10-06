# voice_client_test.py — device-side test client for voice_server.py (frozen contract)
#
# Connects to ws://127.0.0.1:<port>, sends start, streams m1-test-input.wav
# (16k mono PCM16) at ~1x pace + 1s trailing silence, collects events and
# binary assistant audio for up to 40s, sends stop, prints a summary and
# writes voice-test-output.wav (24k mono PCM16).
#
# Usage: python voice_client_test.py [--port 8790] [--label run1]
import argparse
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

WORK = Path(__file__).resolve().parent
IN_WAV = WORK / "m1-test-input.wav"
OUT_WAV = WORK / "voice-test-output.wav"
MIN_AUDIO_BYTES = 48000
COLLECT_WINDOW_S = 40.0


def read_mono_pcm16(path):
    b = path.read_bytes()
    assert b[0:4] == b"RIFF", "not a RIFF wav"
    off, data, ch = 12, None, 1
    while off + 8 <= len(b):
        cid = b[off:off + 4]
        size = int.from_bytes(b[off + 4:off + 8], "little")
        if cid == b"fmt ":
            ch = int.from_bytes(b[off + 20:off + 22], "little")
        if cid == b"data":
            data = b[off + 8:off + 8 + size]
            break
        off += 8 + size + (size % 2)
    if ch == 2:
        mono = bytearray()
        for i in range(0, len(data) - 3, 4):
            l = int.from_bytes(data[i:i + 2], "little", signed=True)
            r = int.from_bytes(data[i + 2:i + 4], "little", signed=True)
            mono += int((l + r) / 2).to_bytes(2, "little", signed=True)
        data = bytes(mono)
    return data


def write_wav(path, pcm, rate=24000, ch=1, bits=16):
    h = bytearray(44)
    h[0:4] = b"RIFF"
    h[4:8] = (36 + len(pcm)).to_bytes(4, "little")
    h[8:12] = b"WAVE"
    h[12:16] = b"fmt "
    h[16:20] = (16).to_bytes(4, "little")
    h[20:22] = (1).to_bytes(2, "little")
    h[22:24] = ch.to_bytes(2, "little")
    h[24:28] = rate.to_bytes(4, "little")
    h[28:32] = (rate * ch * bits // 8).to_bytes(4, "little")
    h[32:34] = (ch * bits // 8).to_bytes(2, "little")
    h[34:36] = bits.to_bytes(2, "little")
    h[36:40] = b"data"
    h[40:44] = len(pcm).to_bytes(4, "little")
    path.write_bytes(bytes(h) + pcm)


async def run(label, port):
    import websockets

    uri = f"ws://127.0.0.1:{port}"
    pcm = read_mono_pcm16(IN_WAV)
    print(f"[{label}] input pcm {len(pcm)}B (~{len(pcm) / 32000:.1f}s)")

    events = {"ready": 0, "transcript": 0, "speaking": 0, "closed": 0, "busy": 0, "error": 0, "other": 0}
    transcripts = []          # (role, final, text)
    audio = bytearray()
    speaking_states = []
    ready_id = None
    closed_reason = None
    error_msgs = []

    async with websockets.connect(uri, max_size=1 << 22) as ws:
        await ws.send(json.dumps({"type": "start", "voice": None, "prompt": None}))
        print(f"[{label}] -> start")

        # phase 1: wait for ready (max 30s)
        t0 = time.monotonic()
        while time.monotonic() - t0 < 30:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=30 - (time.monotonic() - t0))
            except (asyncio.TimeoutError, Exception) as e:
                print(f"[{label}] no ready: {type(e).__name__}")
                break
            if isinstance(raw, bytes):
                audio += raw
                continue
            m = json.loads(raw)
            if m.get("type") == "ready":
                ready_id = m.get("sessionId")
                events["ready"] += 1
                print(f"[{label}] <- ready sessionId={str(ready_id)[:12]}...")
                break
            else:
                print(f"[{label}] <- {m}")
                if m.get("type") == "busy":
                    events["busy"] += 1
                elif m.get("type") == "error":
                    events["error"] += 1
                    error_msgs.append(m.get("message", "")[:120])

        if ready_id:
            # phase 2: stream mic audio at ~1x + 1s trailing silence (binary)
            CHUNK = 3200
            stream_buf = pcm + b"\x00" * 32000  # +1s of 16k silence
            ts = time.monotonic()
            sent = 0
            while sent < len(stream_buf):
                piece = stream_buf[sent:sent + CHUNK]
                await ws.send(piece)
                sent += len(piece)
                due = ts + sent / 32000.0 - 0.10  # 100ms lead
                delay = due - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            print(f"[{label}] streamed {sent}B (speech+1s silence)")

            # phase 3: collect events/audio up to COLLECT_WINDOW_S, stop early when settled
            quiet = 0
            last_bytes = -1
            collect_deadline = time.monotonic() + COLLECT_WINDOW_S
            while time.monotonic() < collect_deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    raw = None
                except Exception:
                    break
                if isinstance(raw, bytes):
                    audio += raw
                    continue
                if raw is None:
                    break
                m = json.loads(raw)
                t = m.get("type")
                if t == "transcript":
                    events["transcript"] += 1
                    transcripts.append((m.get("role"), m.get("final"), m.get("text", "")))
                elif t == "speaking":
                    events["speaking"] += 1
                    speaking_states.append(m.get("state"))
                elif t == "closed":
                    events["closed"] += 1
                    closed_reason = m.get("reason")
                    print(f"[{label}] <- closed reason={closed_reason}")
                    break
                elif t == "error":
                    events["error"] += 1
                    error_msgs.append(m.get("message", "")[:120])
                    print(f"[{label}] <- error {error_msgs[-1]}")
                else:
                    events["other"] += 1
                # early settle: got audio, speaking stopped, no new bytes for 6s
                if len(audio) != last_bytes:
                    last_bytes = len(audio)
                    quiet = 0
                else:
                    quiet += 1
                if quiet >= 6 and len(audio) > MIN_AUDIO_BYTES and speaking_states[-1:] == ["stop"]:
                    break

            # phase 4: stop
            try:
                await ws.send(json.dumps({"type": "stop"}))
                print(f"[{label}] -> stop")
            except Exception:
                pass
            # read until closed or socket close (max 10s)
            tstop = time.monotonic()
            while time.monotonic() - tstop < 10:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=10 - (time.monotonic() - tstop))
                except (asyncio.TimeoutError, Exception):
                    break
                if isinstance(raw, bytes):
                    audio += raw
                    continue
                m = json.loads(raw)
                if m.get("type") == "closed":
                    events["closed"] += 1
                    closed_reason = m.get("reason")
                    print(f"[{label}] <- closed reason={closed_reason}")
                    break

    write_wav(OUT_WAV, bytes(audio))
    asst_text = "".join(t for (r, f, tx) in transcripts if r == "assistant" for t in [tx]).strip()

    print(f"[{label}] ---- SUMMARY ----")
    print(f"[{label}] ready: {events['ready']} sessionId={str(ready_id)[:12]}")
    print(f"[{label}] transcripts: {events['transcript']} assistant_text={asst_text[:200]!r}")
    print(f"[{label}] speaking states: {speaking_states}")
    print(f"[{label}] audio bytes: {len(audio)} (~{len(audio) / 48000:.1f}s @24k)")
    print(f"[{label}] errors: {events['error']} {error_msgs[:2]}")
    print(f"[{label}] closed: reason={closed_reason}")
    print(f"[{label}] output wav: {OUT_WAV}")

    checks = {
        "ready": events["ready"] == 1 and bool(ready_id),
        "assistant_transcript_nonempty": bool(asst_text),
        "audio_gt_48000": len(audio) > MIN_AUDIO_BYTES,
        "closed_requested": closed_reason == "requested",
    }
    ok = all(checks.values())
    print(f"[{label}] VERDICT: {'SUCCESS' if ok else 'FAIL'} checks={checks}")
    return 0 if ok else 1


async def probe_busy(label, port):
    """Second connection while another session is active -> expect busy."""
    import websockets
    uri = f"ws://127.0.0.1:{port}"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"type": "start", "voice": None, "prompt": None}))
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        m = json.loads(raw)
        got = m.get("type")
        print(f"[{label}] BUSY-CHECK: got {got} (want busy)")
        return 0 if got == "busy" else 1


async def busy_flow(label, port):
    """Full lock check: session A starts and holds; B must get busy; A stops."""
    import websockets
    uri = f"ws://127.0.0.1:{port}"
    pcm = read_mono_pcm16(IN_WAV)
    async with websockets.connect(uri) as a:
        await a.send(json.dumps({"type": "start", "voice": None, "prompt": None}))
        raw = await asyncio.wait_for(a.recv(), timeout=30)
        m = json.loads(raw)
        if m.get("type") != "ready":
            print(f"[{label}] LOCK: session A not ready: {m}")
            return 1
        print(f"[{label}] LOCK: session A ready")
        # stream a little audio to keep A alive/active
        await a.send(pcm[:3200])
        await asyncio.sleep(0.5)
        async with websockets.connect(uri) as b:
            await b.send(json.dumps({"type": "start", "voice": None, "prompt": None}))
            try:
                raw = await asyncio.wait_for(b.recv(), timeout=10)
                mb = json.loads(raw)
            except Exception:
                mb = {"type": "(connection-closed-without-frame)"}
            got = mb.get("type")
            print(f"[{label}] BUSY-CHECK: got {got} (want busy)")
            ok_busy = got == "busy"
        await a.send(json.dumps({"type": "stop"}))
        raw = await asyncio.wait_for(a.recv(), timeout=10)
        ma = json.loads(raw)
        print(f"[{label}] LOCK: session A closed with {ma.get('reason')}")
        return 0 if ok_busy and ma.get("reason") == "requested" else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--label", default="t")
    ap.add_argument("--mode", choices=["session", "lock"], default="session")
    args = ap.parse_args()
    if args.mode == "session":
        code = asyncio.run(run(args.label, args.port))
    else:
        code = asyncio.run(busy_flow(args.label, args.port))
    sys.exit(code)


if __name__ == "__main__":
    main()
