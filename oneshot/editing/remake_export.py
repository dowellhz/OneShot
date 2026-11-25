"""Review and export approved shots in the original timeline."""
from __future__ import annotations

import asyncio

from aiohttp import web

from oneshot.editing.remake_shot_plan import video_start_issue
from oneshot.editing.remake_state import (
    MAX_SECONDS,
    completed,
    matches_mapping,
    pending,
    submitted_job,
)
from oneshot.memory.creative_memory import fail


def export_choice(shot, mapping, index):
    if shot.get("keep_original"):
        return None, None
    version = completed(shot.get("videos", []), shot.get("adopted_video"))
    if version and version.get("mode") == "combined":
        return version, video_start_issue(shot, version, mapping)
    if len(shot.get("role_layers", [])) > 1:
        return None, "已加入多个角色，请完成多角色合成并审核"
    scoped = mapping and index in mapping["shots"]
    if version:
        error = video_start_issue(shot, version, mapping) if not scoped or matches_mapping(version, mapping) else "视频属于之前的人物映射，请重新审核"
        return version, error
    if mapping and not scoped:
        return None, None
    if mapping or shot.get("videos") or any(f.get("approved") for f in shot["frames"].values()):
        return None, "待审核，请采用视频或选择保留原镜头"
    return None, None


def export_review(session):
    mapping = session.get("mapping")
    review = {"adopted": 0, "remaining": []}
    for index, shot in enumerate(session["shots"]):
        version, error = export_choice(shot, mapping, index)
        if error:
            review["remaining"].append({"shot": index, "error": error})
        elif version:
            review["adopted"] += 1
    return review


def export_plan(session, source, fps, duration):
    clips = []
    last_tick = 0
    kept = 0
    mapping = session.get("mapping")
    for index, shot in enumerate(session["shots"]):
        end = round(min(duration, shot["end"]) * fps)
        if index == len(session["shots"]) - 1:
            end = round(duration * fps)
        frames = end - last_tick
        if frames <= 0:
            continue
        version, error = export_choice(shot, mapping, index)
        if error:
            fail(f"镜头 {index + 1} {error}")
        if version:
            clips.append({"ref": version["ref"], "in": 0, "out": frames / fps, "frames": frames})
        else:
            clips.append({"ref": source, "in": last_tick / fps, "out": end / fps, "frames": frames})
            kept += 1
        last_tick = end
    if kept == len(clips):
        fail("请至少采用一个重制视频镜头")
    return {"clips": clips, "fit": "pad", "subtitles": False}


async def export_video(req, host, key, session):
    if session.get("export") and pending([session["export"]]):
        fail("成片正在合成，请等待完成", 409)
    source = host.tools.ref_path(host.COMFY_DIR, key[3])
    display = session.get("display_oriented", False)
    try:
        w, h, duration, _ = await asyncio.to_thread(host.film.probe, source, display=display)
    except Exception:
        fail("无法读取原片时间轴")
    spec = export_plan(session, key[3], host.film.FPS, duration)
    session["export"] = submitted_job(host.enqueue_film(req, spec, label="视频重制 · 合成",
                                                      source_audio=source, board=key[1], display=display))
    output_w, output_h = host.film.target_size(w, h, "source")
    seconds = sum(clip["frames"] for clip in spec["clips"]) / host.film.FPS
    session["export"].update(w=output_w, h=output_h, duration=seconds, clips=spec["clips"])


async def prepare_playback(req, host, key, session):
    playback = session.get("playback")
    if playback and (pending([playback]) or (
        playback.get("ref") and host.tools.ref_path(host.COMFY_DIR, playback["ref"]).is_file()
    )):
        return
    path = host.tools.ref_path(host.COMFY_DIR, key[3])
    display = session.get("display_oriented", True)
    try:
        _, _, duration, _ = await asyncio.to_thread(host.film.probe, path, display=False)
    except Exception:
        fail("无法解码原片，请重新上传视频")
    frames = round(duration * host.film.FPS)
    if frames <= 0 or duration > MAX_SECONDS:
        fail(f"播放预览支持 {MAX_SECONDS} 秒以内、至少包含一帧的原片")
    spec = {"clips": [{"ref": key[3], "in": 0, "out": duration, "frames": frames}], "subtitles": False}

    def encode(progress, cancelled):
        return host.film.render(host.COMFY_DIR, spec, progress, cancelled, source_audio=path,
                                display=display, max_side=1280)

    session["playback"] = submitted_job(host.enqueue_render(req, encode, seconds=duration,
                                                           label="视频重制 · 播放预览", board=key[1]))


def refresh_export_status(session, source, fps):
    export = session.get("export")
    if not export or not export.get("clips"):
        return
    try:
        current = export_plan(session, source, fps, export["duration"])
    except web.HTTPBadRequest:
        export["stale"] = True
    else:
        export["stale"] = current["clips"] != export["clips"]


def available_export(host, export):
    if not export or export.get("state") != "done":
        return export
    if export.get("stale"):
        return {**export, "ref": None}
    try:
        if export.get("ref") and host.tools.ref_path(host.COMFY_DIR, export["ref"]).is_file():
            return export
    except (ValueError, OSError):
        pass
    return {**export, "ref": None, "state": "error", "error": "成片文件暂不可用，请重新合成"}
