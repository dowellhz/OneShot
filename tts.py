"""旁白配音: a long-lived Kokoro worker process (CPU, tts-venv) driven over stdin/stdout, stopped after 10 idle minutes."""
import asyncio
import json
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = ROOT / "tts-venv" / "bin" / "python"
WORKER = ROOT / "tts_worker.py"

# Kokoro v1.1-zh voices picked from all 100 by measured pitch and pace (names describe the measurement, so they are honest)
VOICES = [
    {"id": "zf_001", "name": "自然女声"}, {"id": "zf_048", "name": "温柔女声（慢）"}, {"id": "zf_036", "name": "知性女声"},
    {"id": "zf_046", "name": "低沉女声"}, {"id": "zf_088", "name": "轻快女声"}, {"id": "zf_017", "name": "甜美女声（高音）"},
    {"id": "zm_010", "name": "自然男声"}, {"id": "zm_029", "name": "浑厚男声"}, {"id": "zm_098", "name": "沉稳男声（慢）"},
    {"id": "zm_013", "name": "磁性男声"}, {"id": "zm_045", "name": "清朗男声"}, {"id": "zm_041", "name": "少年音"},
]

_proc = None
_lock = asyncio.Lock()
_last = 0.0


def available() -> bool:
    return PY.exists() and WORKER.exists() and (ROOT / "tts-venv" / ".ready").exists()   # written after the install's self-test


async def _start():
    global _proc
    if _proc and _proc.returncode is None:
        return
    _proc = await asyncio.create_subprocess_exec(str(PY), str(WORKER), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                 stderr=open(ROOT / "tts.log", "ab"), cwd=str(ROOT), limit=1 << 20)
    while True:
        line = await asyncio.wait_for(_proc.stdout.readline(), 600)
        if not line:
            raise RuntimeError("配音模型启动失败，见 tts.log")
        try:
            if json.loads(line).get("ready"):
                return
        except ValueError:
            continue


async def say(comfy_dir: Path, text: str, voice: str, speed: float = 1.0) -> dict:
    global _last
    name = f"narr_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}.wav"
    out = comfy_dir / "input" / "h3studio" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    async with _lock:
        await _start()
        _proc.stdin.write((json.dumps({"text": text, "voice": voice, "speed": speed, "out": str(out)}, ensure_ascii=False) + "\n").encode())
        await _proc.stdin.drain()
        while True:
            line = await asyncio.wait_for(_proc.stdout.readline(), 300)
            if not line:
                raise RuntimeError("配音进程退出了，见 tts.log")
            try:
                r = json.loads(line)
                break
            except ValueError:
                continue
        _last = time.time()
    if not r.get("ok"):
        raise RuntimeError(r.get("error") or "配音失败")
    return {"ref": f"input:h3studio/{name}", "seconds": r["seconds"]}


async def reaper():
    while True:
        await asyncio.sleep(60)
        if _proc and _proc.returncode is None and not _lock.locked() and time.time() - _last > 600:
            _proc.kill()


def stop():
    if _proc and _proc.returncode is None:
        _proc.kill()
