"""Localize generated shot output and composite independent role layers."""
from __future__ import annotations

from copy import deepcopy
import asyncio

from oneshot.editing import video_matte
from oneshot.editing.remake_regions import person_absent, person_selection
from oneshot.editing.remake_shot_plan import correction_frames, video_start_issue
from oneshot.editing.remake_state import (
    MAX_PREVIEWS,
    MAX_SHOT_SECONDS,
    completed,
    matches_mapping,
    pending,
    submitted_job,
)
from oneshot.memory.creative_memory import fail


def localize_shot(req, host, key, shot, job, mapping=None, *, display):
    videos = shot.get("videos", [])
    generated = completed(videos, job)
    if not generated or generated.get("mode") == "local":
        fail("请选择已完成的整镜重制视频")
    if not matches_mapping(generated, mapping):
        fail("视频属于之前的人物映射，请重新生成当前角色的视频")
    if pending(videos):
        fail("此镜头正在处理，请等待完成", 409)
    if len(videos) >= MAX_PREVIEWS:
        fail("此镜头已达到视频版本上限")
    first = shot["frames"]["first"]
    starts_absent = person_absent(first, mapping)
    entry_tick = generated.get("entry_tick", 0)
    if starts_absent != bool(entry_tick):
        fail("首帧出画标记已变更，请重新生成镜头视频")
    seed = next((p for p in first["previews"] if p.get("ref") == generated.get("first_frame")), None)
    mask = generated.get("mask") or (seed or {}).get("mask")
    if not mask:
        fail("这个版本没有首帧选区，请重新采用首帧并生成")
    first_selection = person_selection(first, mapping)
    source_mask = first_selection["mask"] if first_selection else mask
    start, end = shot["start"], shot["end"]
    fps = host.film.FPS
    if round(end * fps) - round(start * fps) > MAX_SHOT_SECONDS * fps:
        fail(f"局部合成支持 {MAX_SHOT_SECONDS} 秒以内的镜头")

    start_tick = round(start * host.film.FPS)
    corrections = {0: None} if starts_absent else {}
    replacement_corrections = dict(corrections)
    guides = {guide["tick"]: guide["ref"] for guide in generated.get("guides", [])}
    absent = starts_absent
    for frame in correction_frames(shot):
        tick = frame["correction_tick"] - start_tick
        if person_absent(frame, mapping):
            corrections[tick] = None
            replacement_corrections[tick] = None
            absent = True
            continue
        selection = person_selection(frame, mapping)
        if not selection:
            continue
        guide_ref = guides.get(tick)
        guide = next((p for p in frame["previews"] if guide_ref and p.get("ref") == guide_ref and p.get("mask") and
                      p.get("asset", {}).get("id") == generated["asset"]["id"] and
                      p.get("source_person") == generated.get("source_person")), None)
        if guide:
            replacement_corrections[tick] = guide["mask"]
        elif absent:
            fail(f"原片 {frame['correction_tick'] / host.film.FPS:.2f} 秒人物重新入画，请采用此帧为动作关键帧并重新生成镜头视频")
        corrections[tick] = selection["mask"]
        absent = False
    if entry_tick and next((tick for tick, ref in corrections.items() if ref), None) != entry_tick:
        fail("首次入画的校正帧已变更，请重新生成镜头视频")
    protections = {
        frame.get("correction_tick", start_tick) - start_tick: frame["protection"]["mask"]
        for frame_key, frame in shot["frames"].items()
        if "protection" in frame and (frame_key == "first" or "correction_tick" in frame)
    }

    def composite(progress, cancelled):
        return video_matte.localized_clip(host.COMFY_DIR, key[3], generated["ref"], source_mask,
                                          start, end, progress, cancelled, corrections=corrections,
                                          replacement_mask_ref=mask, replacement_corrections=replacement_corrections,
                                          protections=protections, display=display)

    response = host.enqueue_render(req, composite, seconds=end - start, label="角色替换 · 局部合成", board=key[1])
    version = submitted_job(response)
    version.update(mode="local", derived_from=job, first_frame=generated["first_frame"], mask=mask, source_mask=source_mask,
                   entry_tick=entry_tick,
                   asset=generated["asset"], source_person=generated.get("source_person"),
                   motion=generated.get("motion", ""), guides=generated.get("guides", []),
                   prompt=generated.get("prompt", ""), generation=generated.get("generation", {}),
                   corrections=corrections, replacement_corrections=replacement_corrections, protections=protections)
    if generated.get("depth_ref"):
        version.update(depth_ref=generated["depth_ref"], motion_model=generated.get("motion_model"))
    videos.append(version)


async def approve_video(host, shot, job, mapping=None):
    version = completed(shot.get("videos", []), job)
    if not version:
        fail("请选择已完成的视频版本")
    if version.get("mode") != "combined" and not matches_mapping(version, mapping):
        fail("视频属于之前的人物映射，请重新生成当前角色的视频")
    if error := video_start_issue(shot, version, mapping):
        fail(error)
    try:
        w, h, duration, _ = await asyncio.to_thread(host.film.probe, host.tools.ref_path(host.COMFY_DIR, version["ref"]))
    except Exception:
        fail("视频文件无法播放，请重新生成")
    expected_frames = round(shot["end"] * host.film.FPS) - round(shot["start"] * host.film.FPS)
    if duration * host.film.FPS + .51 < expected_frames:
        fail("生成的视频短于原镜头，请重试或保留原镜头")
    version.update(w=w, h=h, duration=duration)
    shot["adopted_video"] = version["job"]
    shot["keep_original"] = False


def edit_role_layers(shot, data, mapping):
    action = data["action"]
    layers = shot.setdefault("role_layers", [])
    job = data.get("job")
    if action == "add_role_layer":
        video = completed(shot.get("videos", []), job)
        if not video or video.get("mode") != "local" or not video.get("source_person") or not matches_mapping(video, mapping):
            fail("请先完成当前人物的局部合成")
        previous = next((i for i, layer in enumerate(layers) if layer["source_person"] == video["source_person"]), None)
        layer = {"job":video["job"], "source_person":video["source_person"], "asset":video["asset"]}
        if previous is None:
            if len(layers) >= 4:
                fail("每个镜头最多可合成四个角色")
            layers.append(layer)
        else:
            layers[previous] = layer
        return
    index = next((i for i, layer in enumerate(layers) if layer["job"] == job), None)
    if index is None:
        fail("角色图层已不存在")
    if action == "remove_role_layer":
        layers.pop(index)
    elif index > 0:
        layers[index - 1], layers[index] = layers[index], layers[index - 1]


def queue_combined_roles(req, host, key, shot, *, display):
    layers = shot.get("role_layers", [])
    if len(layers) < 2:
        fail("请加入至少两个人物的局部合成")
    videos = shot.setdefault("videos", [])
    if pending(videos) or len(videos) >= MAX_PREVIEWS:
        fail("请等待当前任务完成或检查镜头版本上限")
    inputs = []
    for layer in layers:
        local = completed(videos, layer["job"])
        generated = completed(videos, local.get("derived_from")) if local else None
        if not generated:
            fail("有角色图层缺少已完成的生成视频")
        inputs.append((local, generated))
    start, end = shot["start"], shot["end"]

    def composite(progress, cancelled):
        result = None
        temporary = []
        try:
            for i, (local, generated) in enumerate(inputs):
                if result:
                    temporary.append(result["ref"])
                result = video_matte.localized_clip(host.COMFY_DIR, key[3], generated["ref"], local["source_mask"],
                    start, end, lambda done, total: progress(i * 100 + round(100 * done / total), len(inputs) * 100),
                    cancelled, replacement_mask_ref=local.get("mask"),
                    corrections={int(k):v for k,v in local.get("corrections", {}).items()},
                    replacement_corrections={int(k):v for k,v in local.get("replacement_corrections", {}).items()},
                    protections={int(k):v for k,v in local.get("protections", {}).items()}, display=display,
                    base_ref=result["ref"] if result else None)
            return result
        finally:
            for ref in temporary:
                host.tools.ref_path(host.COMFY_DIR, ref).unlink(missing_ok=True)

    version = submitted_job(host.enqueue_render(req, composite, seconds=end-start, label="多角色合成", board=key[1]))
    version.update(mode="combined", roles=deepcopy(layers))
    videos.append(version)
