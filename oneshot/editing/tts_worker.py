"""Kokoro-82M-v1.1-zh worker (runs in tts-venv, CPU). One JSON request per stdin line -> one JSON reply line."""
import json
import sys

import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline

torch.set_num_threads(8)
REPO = "hexgrad/Kokoro-82M-v1.1-zh"
model = KModel(repo_id=REPO).eval()
en = KPipeline(lang_code="a", repo_id=REPO, model=False)


def en_callable(text):
    return next(en(text)).phonemes


zh = KPipeline(lang_code="z", repo_id=REPO, model=model, en_callable=en_callable)


def speed_for(speed):
    return lambda len_ps: speed     # v1.1-zh: speed may be a callable of the phoneme length


print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        q = json.loads(line)
        parts = []
        for r in zh(q["text"], voice=q["voice"], speed=speed_for(float(q.get("speed") or 1.0))):
            if r.audio is not None:
                parts.append(r.audio.numpy() if hasattr(r.audio, "numpy") else np.asarray(r.audio))
                parts.append(np.zeros(int(24000 * 0.12), np.float32))
        if not parts:
            raise RuntimeError("没有合成出声音")
        a = np.concatenate(parts)
        sf.write(q["out"], a, 24000)
        print(json.dumps({"ok": True, "seconds": round(len(a) / 24000, 2)}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{e.__class__.__name__}: {e}"}), flush=True)
