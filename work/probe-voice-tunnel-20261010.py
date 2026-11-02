import asyncio, base64, datetime, hashlib, hmac, json, re, struct, sys, time
from pathlib import Path
import websockets
root = Path(__file__).resolve().parents[1]
config = (root / "HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets").read_text(encoding="utf-8-sig")
def value(name):
    match = re.search(name + r""":\s*string\s*=\s*['"]([^'"]*)['"]""", config)
    return match.group(1) if match else ""
route = (root / "HarmonyCodexRemote/entry/src/main/ets/config/VoiceRouteConfig.ets").read_text(encoding="utf-8-sig")
origin = re.search(r"""voiceHttpsBaseUrl:\s*string\s*=\s*['"]([^'"]+)['"]""", route).group(1)
assert origin.startswith("https://")
headers = {"X-Codex-Bridge-Token": value("DEFAULT_BRIDGE_TOKEN")}
secret = value("DEFAULT_BRIDGE_TOTP_SECRET")
if secret:
    secret = secret.replace(" ", "").upper()
    digest = hmac.new(base64.b32decode(secret + "=" * (-len(secret) % 8)), struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    headers["X-Codex-Bridge-OTP"] = str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)
label = sys.argv[1] if len(sys.argv) > 1 else "probe"
assert re.fullmatch(r"[a-z-]+", label)
result = {"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "label": label, "tlsVerified": True, "upgraded": False, "pong": False, "createdCall": False}
async def main():
    try:
        async with websockets.connect(origin.replace("https:", "wss:", 1).rstrip("/") + "/voice", additional_headers=headers, open_timeout=12, close_timeout=2, proxy=None) as ws:
            result["upgraded"] = True
            pong = await ws.ping(b"tunnel-health")
            await asyncio.wait_for(pong, 5)
            result["pong"] = True
    except Exception as error:
        result["failure"] = type(error).__name__
        status = getattr(getattr(error, "response", None), "status_code", None)
        if status:
            result["httpStatus"] = status
asyncio.run(main())
(root / "work" / ("voice-tunnel-probe-" + label + ".json")).write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
sys.exit(0 if result["upgraded"] and result["pong"] else 1)
