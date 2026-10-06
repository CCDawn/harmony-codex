# voice_zombie_harness.py — voice_server 纯函数级测试垫片
#
# 由 test/voiceServerZombie.test.js 调起。生产环境 voice_server.py 跑在带
# av/aiortc 的 .venv 里，而 CI/系统 python 往往没有；这里先往 sys.modules 塞
# 最小 stub 再导入 voice_server，只测下行僵尸检测的纯函数/ZombieDetector 与
# resolve_codex 选型，不起 WebSocket、不碰 app-server。全部用例结果以 JSON
# （ensure_ascii）打到 stdout，由 node 侧断言。
import json
import math
import os
import struct
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def _stub(name, **attrs):
    mod = sys.modules.get(name) or types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


_stub("av", AudioResampler=object)
_stub("aiortc", RTCPeerConnection=object, RTCSessionDescription=object)
_stub("aiortc.mediastreams",
      MediaStreamError=type("MediaStreamError", (Exception,), {}),
      MediaStreamTrack=object)

sys.path.insert(0, str(REPO / "voice"))
import voice_server as vs  # noqa: E402

CHUNK = 4800  # 与 OUT_CHUNK_BYTES 一致：60 块 = 3s 窗口
CASES = {}


def case(fn):
    CASES[fn.__name__] = fn
    return fn


def pcm(samples):
    return struct.pack("<%dh" % len(samples), *samples)


def sine_sec(freq, amp, rate=24000):
    return [int(amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(rate)]


def lcg_noise_sec(seed, amp, rate=24000):
    out = []
    x = seed
    for _ in range(rate):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        out.append((x % (2 * amp)) - amp)
    return out


def feed_all(det, data):
    """按 100ms 块喂入，返回命中僵尸时的起始字节偏移（0 或 1 个）。"""
    hits = []
    for off in range(0, len(data), CHUNK):
        if det.feed(data[off:off + CHUNK]):
            hits.append(off)
            break
    return hits


@case
def judge_pure():
    """判定纯函数直测：全零 / 1088 瓦片 / 真实包络语音 三种输入。"""
    zero = b"\x00\x00" * vs.ZOMBIE_WINDOW_SAMPLES
    tile = pcm([((i * 73) % 20000) - 10000 for i in range(1088)]) * 133
    speech = pcm(sine_sec(100, 3000) + sine_sec(100, 12000) + sine_sec(100, 6000))
    return {"zero": vs.judge_zombie(zero),
            "tile": vs.judge_zombie(tile),
            "speech": vs.judge_zombie(speech)}


@case
def zero_window():
    det = vs.ZombieDetector()
    hits = feed_all(det, b"\x00\x00" * vs.ZOMBIE_WINDOW_SAMPLES)
    return {"hitOffsets": hits, "disabled": det.disabled}


@case
def tile_window():
    results = {}
    for period in (1024, 1088, 1152):
        tile = pcm([((i * 2654435761) % 65536) - 32768 for i in range(period)])
        data = tile * (vs.ZOMBIE_WINDOW_SAMPLES // period + 2)
        det = vs.ZombieDetector()
        results[str(period)] = {
            "hitOffsets": feed_all(det, data[:len(data) // CHUNK * CHUNK]),
            "disabled": det.disabled}
    return results


@case
def silence_then_tile():
    det = vs.ZombieDetector()
    silence_hits = feed_all(det, bytes(vs.ZOMBIE_WINDOW_BYTES * 3))
    tile = pcm([((i * 2654435761) % 65536) - 32768 for i in range(1088)])
    data = (tile * 70)[:vs.ZOMBIE_WINDOW_BYTES]
    return {"silenceHits": silence_hits, "tileHits": feed_all(det, data)}


@case
def quiet_tile():
    det = vs.ZombieDetector()
    return {"hitOffsets": feed_all(det, pcm([1] * vs.ZOMBIE_WINDOW_SAMPLES))}


@case
def speech_escapes_via_envelope():
    """相邻秒包络差异明显（3k→12k 振幅）→ 2s 时提前永久解除，永不误杀。"""
    det = vs.ZombieDetector()
    data = pcm(sine_sec(100, 3000) + sine_sec(100, 12000) + sine_sec(100, 6000))
    return {"hitOffsets": feed_all(det, data), "disabled": det.disabled}


@case
def steady_noise_escapes_via_window():
    """稳态非周期噪声（包络不触发）→ 窗口满判 clean 解除。"""
    det = vs.ZombieDetector()
    data = pcm(lcg_noise_sec(7, 8000) * 3)  # 72000 样本 = 3s @ 24k
    return {"hitOffsets": feed_all(det, data), "disabled": det.disabled}


@case
def real_voice_then_silence_immune():
    """出现过真语音后永久解除：之后再来 6s 纯零下行也不杀。"""
    det = vs.ZombieDetector()
    feed_all(det, pcm(sine_sec(100, 3000) + sine_sec(100, 12000) + sine_sec(100, 6000)))
    disabled_after_speech = det.disabled
    feed_all(det, b"\x00\x00" * vs.ZOMBIE_WINDOW_SAMPLES * 2)
    return {"disabledAfterSpeech": disabled_after_speech, "disabled": det.disabled}


@case
def partial_window_no_verdict():
    """窗口未满（1.5s = 36000 样本全零）不判定——会话刚就绪没出帧天然不计数。"""
    det = vs.ZombieDetector()
    hits = feed_all(det, b"\x00\x00" * 36000)
    return {"hitOffsets": hits, "disabled": det.disabled, "bufLen": len(det.buf)}


@case
def resolve_codex_skips_small():
    """两个分支都跳过 <1MB 残骸：选更旧的大文件 → 落 WindowsApps 分支 → 全跳过报错。

    生产代码按版本目录 mtime 降序遍历，故这里在写完文件后用 os.utime 调目录时间。"""
    result = {}
    with tempfile.TemporaryDirectory() as td:
        stable = Path(td) / "bin"
        store = Path(td) / "store"
        v_new = stable / "1.0.14-new"
        v_old = stable / "1.0.13-old"
        store_pkg = store / "OpenAI.Codex_1.0.14" / "app" / "resources"
        v_new.mkdir(parents=True)
        v_old.mkdir()
        store_pkg.mkdir(parents=True)
        big = bytes(2 << 20)

        # 先写文件再调目录 mtime（写入子文件会刷新目录时间）：v_new 最新、v_old 更旧
        (v_new / "codex.exe").write_bytes(bytes(100))      # 最新但 <1MB 残骸
        (v_old / "codex.exe").write_bytes(big)
        os.utime(v_new, (2000000000, 2000000000))
        os.utime(v_old, (1000000000, 1000000000))
        picked = vs.resolve_codex(stable_root=stable, store_root=store)
        result["skipsSmallPicksOlderBig"] = picked.replace("\\", "/").endswith(
            "1.0.13-old/codex.exe")

        (v_new / "codex.exe").write_bytes(big)             # 无残骸时仍选最新目录
        result["picksNewestWhenBig"] = vs.resolve_codex(
            stable_root=stable, store_root=store).replace("\\", "/").endswith(
            "1.0.14-new/codex.exe")
        (v_new / "codex.exe").write_bytes(bytes(100))

        (v_old / "codex.exe").unlink()                     # stable 只剩残骸 → 落分支
        (store_pkg / "codex.exe").write_bytes(big)
        result["fallsBackToStore"] = vs.resolve_codex(
            stable_root=stable, store_root=store).replace("\\", "/").endswith(
            "OpenAI.Codex_1.0.14/app/resources/codex.exe")

        (store_pkg / "codex.exe").write_bytes(bytes(100))  # 两分支全残骸 → 报错
        try:
            vs.resolve_codex(stable_root=stable, store_root=store)
            result["raisesWhenAllSmall"] = False
        except RuntimeError:
            result["raisesWhenAllSmall"] = True
    return result


if __name__ == "__main__":
    print(json.dumps({name: fn() for name, fn in CASES.items()}))
