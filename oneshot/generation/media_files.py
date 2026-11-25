"""Workspace media references and output file allocation."""
import time
import uuid
from pathlib import Path


FPS = 24
SR = 44100
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v", ".mkv"}
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}


def ref_path(comfy_dir: Path, ref: str) -> Path:
    """'input:h3studio/x.png' -> the file, only ever inside <media>/input|output/h3studio (no absolute paths, no ..)."""
    kind, _, path = str(ref).partition(":")
    if kind not in ("input", "output") or not path.startswith("h3studio/") or "\\" in path or "\0" in path:
        raise ValueError("bad ref")
    root = (comfy_dir / kind / "h3studio").resolve()
    p = (comfy_dir / kind / path).resolve()
    if not p.is_relative_to(root):
        raise ValueError("bad ref")
    return p


def _new(comfy_dir: Path, kind: str, prefix: str, ext: str) -> tuple[Path, str]:
    name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}{ext}"
    d = comfy_dir / kind / "h3studio"
    d.mkdir(parents=True, exist_ok=True)
    return d / name, f"{kind}:h3studio/{name}"
