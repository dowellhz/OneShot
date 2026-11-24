"""Render a silent, temporally consistent relative-depth clip for one shot."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from oneshot.editing import render
from oneshot.config import MODELS_DIR

MODEL_HOME = MODELS_DIR / "Video-Depth-Anything"
CHECKPOINT = "checkpoints/video_depth_anything_vits.pth"
SAMPLE_FPS = render.FPS // 2
MAX_SIDE = 768
INFERENCE_LIMIT = 8 * 60
LOG = logging.getLogger(__name__)
# The upstream writer still calls matplotlib.cm.get_cmap, including for grayscale.
# Keep the compatibility alias inside the child process.
UPSTREAM_ENTRY = """
import runpy
import sys
try:
    import matplotlib
    import matplotlib.cm
except ImportError:
    pass
else:
    if not hasattr(matplotlib.cm, "get_cmap"):
        matplotlib.cm.get_cmap = matplotlib.colormaps.get_cmap
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


def configuration():
    try:
        home = Path(os.environ.get("ONESHOT_DEPTH_HOME") or MODEL_HOME).expanduser().resolve()
        python = Path(os.environ.get("ONESHOT_DEPTH_PYTHON") or sys.executable).expanduser().absolute()
        if (home / "run.py").is_file() and (home / CHECKPOINT).is_file() and python.is_file() and os.access(python, os.X_OK):
            return home, python
    except (OSError, RuntimeError):
        pass
    return None


def dimensions(w, h):
    scale = min(1, MAX_SIDE / max(w, h))
    return max(2, 2 * round(w * scale / 2)), max(2, 2 * round(h * scale / 2))


def _prepare(source, dest, start, ticks, display, cancelled, progress):
    w, h, _, _ = render.probe(source, display=display)
    width, height = dimensions(w, h)
    with closing(render.video_ticks(source, start, ticks, relative_time=display)) as decoded:
        frames = (render.frame_image(frame, display=display, thumbnail_size=(width, height))
                  for i, frame in enumerate(decoded) if i % 2 == 0)
        count = render.encode_silent(dest, frames, width, height, SAMPLE_FPS, cancelled,
                        lambda n: progress(min(18, n * 36 // ticks), 100))
    if count != (ticks + 1) // 2:
        raise ValueError("无法按剪辑点截取完整镜头")
    return width, height


def _infer(home, python, source, work, cancelled):
    args = [str(python), "-c", UPSTREAM_ENTRY, str(home / "run.py"), "--input_video", str(source), "--output_dir", str(work),
            "--encoder", "vits", "--input_size", "392", "--max_res", str(MAX_SIDE),
            "--target_fps", str(SAMPLE_FPS), "--grayscale", "--fp32"]
    env = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4", "MPLBACKEND": "Agg"}
    log_path = work / "inference.log"
    with log_path.open("w") as log:
        proc = subprocess.Popen(args, cwd=home, env=env, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + INFERENCE_LIMIT
        try:
            while proc.poll() is None:
                if cancelled():
                    raise render.Cancelled()
                if time.monotonic() >= deadline:
                    raise ValueError("深度推理超时")
                time.sleep(.25)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
    result = work / "shot_vis.mp4"
    if proc.returncode or not result.is_file():
        with log_path.open("rb") as log:
            log.seek(max(0, log_path.stat().st_size - 2500))
            LOG.warning("Video depth worker returned %s: %s", proc.returncode, log.read().decode("utf-8", "replace"))
        raise ValueError("深度模型没有完成推理，请检查 Small 模型权重和 Python 依赖")
    return result


def _finish(raw, destination, ticks, width, height, cancelled, progress):
    import av
    from itertools import islice

    with av.open(str(raw)) as depth:
        def frames():
            for frame in depth.decode(video=0):
                if (frame.width, frame.height) != (width, height):
                    raise ValueError("深度参考尺寸与原镜头不一致")
                image = frame.to_image().convert("L")
                yield image
                yield image

        count = render.encode_silent(destination, islice(frames(), ticks), width, height, render.FPS, cancelled,
                        lambda n: progress(80 + n * 19 // ticks, 100))
    if count != ticks:
        raise ValueError("深度参考时长与原镜头不一致")
    return count


def generate(comfy_dir, source, start, ticks, display, progress, cancelled, config):
    if cancelled():
        raise render.Cancelled()
    with tempfile.TemporaryDirectory(prefix="oneshot-depth-") as tmp:
        work = Path(tmp)
        shot = work / "shot.mp4"
        w, h = _prepare(source, shot, start, ticks, display, cancelled, progress)
        progress(20, 100)
        raw = _infer(*config, shot, work, cancelled)
        progress(80, 100)
        path, ref = render._new(comfy_dir, "output", "depth", ".mp4")
        try:
            count = _finish(raw, path, ticks, w, h, cancelled, progress)
            if cancelled():
                raise render.Cancelled()
        except BaseException:
            path.unlink(missing_ok=True)
            raise
    progress(100, 100)
    return {"ref": ref, "w": w, "h": h, "seconds": count / render.FPS}
