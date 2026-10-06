# One-off interrupt smoke test: mid-playback interrupt -> speaking stop, then stop -> closed requested.
import asyncio, json, sys, time
from voice_client_test import read_mono_pcm16

async def main():
    import websockets
    pcm = read_mono_pcm16(__import__("pathlib").Path(__file__).resolve().parent / "m1-test-input.wav")
    states = []
    interrupted_at = None
    async with websockets.connect("ws://127.0.0.1:8790", max_size=1 << 22) as ws:
        await ws.send(json.dumps({"type": "start", "voice": None, "prompt": None}))
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), 30))
            if m["type"] == "ready":
                break
        CHUNK = 3200
        buf = pcm + b"\x00" * 32000
        ts = time.monotonic()
        sent = 0
        audio = bytearray()
        stop_sent = False
        while time.monotonic() - ts < 45:
            # stream input at 1x for first ~5s
            if sent < len(buf) and not stop_sent:
                await ws.send(buf[sent:sent + CHUNK])
                sent += CHUNK
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.05 if not stop_sent else 1.0)
            except asyncio.TimeoutError:
                raw = None
            if isinstance(raw, bytes):
                audio += raw
                continue
            if raw is None:
                if not stop_sent and sent < len(buf):
                    continue
                continue
            m = json.loads(raw)
            if m["type"] == "speaking":
                states.append((m["state"], round(time.monotonic() - ts, 2)))
                # interrupt once, right after first speaking start
                if m["state"] == "start" and interrupted_at is None:
                    await ws.send(json.dumps({"type": "interrupt"}))
                    interrupted_at = time.monotonic()
                    print(f"interrupt sent at +{states[-1][1]}s")
            elif m["type"] == "closed":
                print("closed:", m["reason"])
                break
            # after reply has flowed for a bit and interrupt done, finish
            if interrupted_at and not stop_sent and len(audio) > 48000:
                await ws.send(json.dumps({"type": "stop"}))
                stop_sent = True
    print("speaking states:", states)
    ok = any(s == "stop" and interrupted_at and t >= 0 for s, t in states)
    print("INTERRUPT-TEST:", "PASS" if (interrupted_at and any(s == "stop" for s, _ in states)) else "FAIL",
          f"(interrupted_at={'yes' if interrupted_at else 'no'}, audio={len(audio)}B)")
    return 0

asyncio.run(main())
