"""Edit and undo shot boundaries for the pinned original."""
from __future__ import annotations

from copy import deepcopy
import asyncio
import math

from oneshot.editing.remake_analysis import fill_shot_analysis
from oneshot.editing.remake_source_media import original_frames
from oneshot.editing.remake_state import (
    MAX_SECONDS,
    MAX_SHOTS,
    pending,
)
from oneshot.editing.remake_submission import default_remake_durations, shot_video_limit
from oneshot.memory.creative_memory import fail


async def edit_cuts(req, host, source, session, data):
    old_shots = session["shots"]
    index = data.get("shot")
    if type(index) is not int or not 0 <= index < len(old_shots):
        fail("请先选中要调整的镜头")
    fps = host.film.FPS
    old = [0, *(round(shot["end"] * fps) for shot in old_shots)]
    bounds = old.copy()
    focus = old[index]
    action = data["action"]
    undo = session.get("cut_undo")
    if action == "undo_cut":
        if not undo:
            fail("没有可以撤销的切镜调整")
        bounds = undo["bounds"]
    elif action == "merge_shots":
        if index == 0:
            fail("请选择第二个或后续的镜头")
        del bounds[index]
    elif action == "split_long_shot":
        start, end = old[index:index + 2]
        length = end - start
        limit = shot_video_limit(host,old_shots[index],session.get("mapping"),default_remake_durations(host))
        pieces = math.ceil(length / (limit * fps))
        if pieces < 2:
            fail(f"此镜头已经在 {limit} 秒以内")
        if len(old_shots) + pieces - 1 > MAX_SHOTS:
            fail(f"拆分后会超过 {MAX_SHOTS} 个镜头，请先合并不需要的切点")
        # Balance the segments so a shot just over the limit doesn't leave a tiny final piece.
        bounds[index + 1:index + 1] = [start + (length * i) // pieces for i in range(1, pieces)]
    else:
        at = data.get("at")
        if type(at) not in (int, float) or not 0 <= at <= MAX_SECONDS:
            fail("请先定位原片播放位置")
        tick = round(at * fps)
        if action == "split_shot":
            if len(old_shots) >= MAX_SHOTS:
                fail(f"最多保留 {MAX_SHOTS} 个镜头，请先合并不需要的切点")
            if not old[index] < tick < old[index + 1]:
                fail("请将播放器定位到所选镜头内部")
            bounds.insert(index + 1, tick)
        else:
            if index == 0 or not old[index - 1] < tick < old[index + 1] or tick == old[index]:
                fail("请把播放位置移到分界两侧镜头的范围内")
            bounds[index] = tick
        focus = tick

    def ranges(points):
        return list(zip(points, points[1:]))

    old_ranges, new_ranges = ranges(old), ranges(bounds)
    existing = dict(zip(old_ranges, old_shots))
    affected = [shot for span, shot in existing.items() if span not in new_ranges]
    if any(pending(shot.get("videos", [])) or any(pending(f["previews"]) for f in shot["frames"].values())
           or shot.get("depth") and pending([shot["depth"]]) for shot in affected):
        fail("受影响的镜头有任务正在处理，请等待完成", 409)
    export = session.get("export")
    if export and pending([export]):
        fail("成片正在合成，请等待完成后再调整切镜", 409)

    archive = session.setdefault("cut_archive", {})
    for (start, end), shot in existing.items():
        if (start, end) not in new_ranges:
            archive[f"{start}:{end}"] = shot

    split = action in ("split_shot", "split_long_shot")
    parent = old_shots[index]["frames"] if split else {}

    def capture():
        shots = [existing.get((start, end)) or archive.get(f"{start}:{end}") for start, end in new_ranges]
        fresh = [i for i, shot in enumerate(shots) if shot is None]
        inherited = {}
        needed = set()
        for i in fresh:
            start, end = new_ranges[i]
            frames = {}
            if split and start == old[index]:
                frames["first"] = deepcopy(parent["first"])
            for name, frame in parent.items():
                tick = frame.get("correction_tick")
                if tick is None or not start <= tick < end:
                    continue
                saved = deepcopy(frame)
                if tick == start:
                    saved.pop("correction_tick")
                    frames["first"] = saved
                else:
                    frames[name] = saved
            inherited[i] = frames
            needed.add((start + end) // 2)
            if "first" not in frames:
                needed.add(start)
        captured = original_frames(host, source, needed, display=session.get("display_oriented", False))
        for i in fresh:
            start, end = new_ranges[i]
            frames = inherited[i]
            if "first" not in frames:
                frames["first"] = captured[start]
            frames["middle"] = captured[(start + end) // 2]
            shots[i] = {"start": start / fps, "end": end / fps, "summary": {}, "frames": frames}
        return shots, fresh

    try:
        shots, fresh = await asyncio.to_thread(capture)
    except Exception:
        fail("无法读取新剪辑点的原片画面")
    await fill_shot_analysis(req, host, session, shots, fresh)

    mapping = session.get("mapping")
    before = mapping.copy() if mapping else None
    if mapping:
        if action == "undo_cut" and mapping == undo["mapping_after"]:
            mapping["shots"] = undo["mapping_before"]["shots"]
        else:
            confirmed = [old_ranges[i] for i in mapping["shots"]]
            mapping["shots"] = [
                i for i, (start, end) in enumerate(new_ranges)
                if sum(max(0, min(end, b) - max(start, a)) for a, b in confirmed) == end - start
            ]
    if action == "undo_cut":
        session.pop("cut_undo")
    else:
        session["cut_undo"] = {"bounds": old, "mapping_before": before, "mapping_after": mapping.copy() if mapping else None}
    for start, end in new_ranges:
        archive.pop(f"{start}:{end}", None)
    if export:
        export["stale"] = True
    session["shots"] = shots
    session["cut_revision"] = session.get("cut_revision", 0) + 1
    return next(i for i, (_, end) in enumerate(new_ranges) if focus < end)
