"""One bounded call setup over the configured public route, without microphone."""
import asyncio, base64, hashlib, hmac, json, re, struct, time
from pathlib import Path
import websockets

root = Path(__file__).resolve().parents[1]
config = (root / 'HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets').read_text(encoding='utf-8-sig')
route = (root / 'HarmonyCodexRemote/entry/src/main/ets/config/VoiceRouteConfig.ets').read_text(encoding='utf-8-sig')
def value(text, name):
    m = re.search(name + r'''\s*:\s*string\s*=\s*['"]([^'"]*)['"]''', text)
    return m.group(1) if m else ''
headers = {'X-Codex-Bridge-Token': value(config, 'DEFAULT_BRIDGE_TOKEN')}
secret = value(config, 'DEFAULT_BRIDGE_TOTP_SECRET').replace(' ', '').upper()
if secret:
    digest = hmac.new(base64.b32decode(secret + '=' * (-len(secret) % 8)), struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    headers['X-Codex-Bridge-OTP'] = str((struct.unpack('>I', digest[offset:offset+4])[0] & 0x7fffffff) % 1000000).zfill(6)
origin = value(route, 'voiceHttpsBaseUrl')
assert origin.startswith('https://')
result = {'ready': False, 'microphoneUsed': False, 'events': []}
started = time.monotonic()
async def main():
    try:
        async with websockets.connect(origin.replace('https:', 'wss:', 1).rstrip('/') + '/voice', additional_headers=headers, proxy=None, open_timeout=12, close_timeout=3) as ws:
            await ws.send('{"type":"start"}')
            async with asyncio.timeout(135):
                async for raw in ws:
                    if not isinstance(raw, str):
                        continue
                    event = json.loads(raw)
                    if event.get('type') not in {'progress', 'ready', 'closed', 'busy', 'error'}:
                        continue
                    safe = {key: event[key] for key in ('type', 'stage', 'failureStage', 'errorCode', 'operation', 'httpStatus') if key in event}
                    safe['elapsedMs'] = round((time.monotonic()-started)*1000)
                    result['events'].append(safe)
                    print(json.dumps(safe), flush=True)
                    if event['type'] == 'ready':
                        result['ready'] = True
                        await ws.send('{"type":"stop"}')
                    if event['type'] in {'busy', 'closed'}:
                        break
    except Exception as error:
        result['failureType'] = type(error).__name__
asyncio.run(main())
(root / 'work/voice-startup-check-20261013.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({'ready': result['ready'], 'microphoneUsed': False, 'failureType': result.get('failureType')}))
