"""Decode pinned original frames and store correction captures."""
from __future__ import annotations

from contextlib import closing
import asyncio

from oneshot.editing import image_editor
from oneshot.editing.remake_state import (
    MAX_CORRECTIONS,
    MAX_SECONDS,
    frame_record,
)
from oneshot.memory.creative_memory import fail


def original_frames(host, source, ticks, *, display=True):
    if not ticks:
        return {}
    fps = host.film.FPS
    start = min(ticks)
    path = host.tools.ref_path(host.COMFY_DIR, source)
    selected = {}
    frames = host.film.video_ticks(path, start / fps, max(ticks) - start + 1, relative_time=True)
    with closing(frames):
        for tick, frame in enumerate(frames, start):
            if tick in ticks:
                image = host.film.frame_image(frame, display=display)
                saved = image_editor.save(host.COMFY_DIR, image, "remake-frame", "input")
                selected[tick] = {**frame_record(saved["ref"], (saved["w"], saved["h"])), "at": tick / fps}
    if len(selected) != len(ticks):
        raise ValueError("没有可用的画面")
    return selected


async def capture_correction(host, source, shot, value, *, display):
    if type(value) not in (int, float) or not 0 <= value <= MAX_SECONDS:
        fail("请先将原片定位到镜头内")
    fps = host.film.FPS
    start, end = round(shot["start"] * fps), round(shot["end"] * fps)
    tick = round(value * fps)
    if not start < tick < end:
        fail("请将播放器定位到当前镜头的首帧之后、结束之前")
    frame_key = f"correction-{tick}"
    if frame_key in shot["frames"]:
        return frame_key
    if sum("correction_tick" in frame for frame in shot["frames"].values()) >= MAX_CORRECTIONS:
        fail(f"每个镜头最多保存 {MAX_CORRECTIONS} 张校正帧")

    try:
        frames = await asyncio.to_thread(original_frames, host, source, {tick}, display=display)
    except (ValueError, OSError):
        fail("无法读取校正画面")
    shot["frames"][frame_key] = {
        **frames[tick], "correction_tick": tick,
    }
    return frame_key
