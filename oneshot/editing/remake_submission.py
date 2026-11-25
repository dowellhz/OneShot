"""Route and submit full shot generation using pinned previews."""
from __future__ import annotations

from aiohttp import web

from oneshot.editing.remake_previews import generate_preview
from oneshot.editing.remake_reference_assets import role_reference
from oneshot.editing.remake_regions import person_selection
from oneshot.editing.remake_shot_plan import (
    shot_guides,
    shot_start,
    start_preview_key,
)
from oneshot.editing.remake_state import (
    MAX_PREVIEWS,
    MAX_SHOT_SECONDS,
    matches_mapping,
    pending,
    submitted_job,
)
from oneshot.generation import motion_reference
from oneshot.memory.creative_memory import fail


async def queue_one_shot(req, host, key, shot, params, mapping, preview):
    if preview:
        frame_key = start_preview_key(shot, mapping)
        if frame_key != params["frame"]:
            fail("镜头的首帧或入画帧已变更，请核对后重试", 409)
        frame = shot["frames"][frame_key]
        selection = person_selection(frame, mapping)
        if not selection or pending(frame["previews"]):
            return False
        role = role_reference(req, key[1], params)
        _, view, reference = role
        protection = frame.get("protection", {}).get("mask")
        if any(
            p.get("ref") and matches_mapping(p, mapping) and
            p.get("mask") == selection["mask"] and p.get("protection") == protection and
            p.get("asset", {}).get("view", "main") == view and p.get("asset", {}).get("ref") == reference and
            p.get("note", "") == params["note"]
            for p in frame["previews"]
        ):
            return False
        await generate_preview(req, host, key, frame, params, mapping, role=role)
    else:
        ref, approved, entry_tick = shot_start(shot, mapping, host.film.FPS)
        if params["first_job"] != approved["job"]:
            fail("已采用的起始帧有变更，请核对后重试", 409)
        videos = shot.get("videos", [])
        guides = shot_guides(shot, approved, host.film.FPS, mapping, entry_tick)
        if pending(videos) or any(
            v.get("ref") and matches_mapping(v, mapping) and v.get("first_frame") == ref and
            v.get("entry_tick", 0) == entry_tick and
            not v.get("depth_ref") and v.get("guides", []) == guides and v.get("motion", "") == params["motion"] for v in videos
        ):
            return False
        await generate_shot(req, host, key, shot, params, mapping)
    return True


def motion_routes(host):
    choices = {}
    for route in host.providers.routes("video"):
        provider = route["provider"]
        if motion_reference.supports(provider, route["model"]):
            choices.setdefault(provider["id"], route)
    for provider in host.providers.all_providers():
        model = host.providers.default_model(provider, "video")
        if motion_reference.supports(provider, model):
            choices.setdefault(provider["id"], {"provider":provider, "model":model})
    return list(choices.values())


def motion_providers(host):
    return [{"id":r["provider"]["id"], "name":r["provider"]["name"], "model":r["model"]} for r in motion_routes(host)]


def remake_durations(host, route):
    if not route or route["provider"]["kind"] == "local_h3":
        return ()
    return host.remote.video_durations(route["provider"]["kind"],route["model"],provider=route["provider"])


def default_remake_durations(host):
    return remake_durations(host,host.providers.primary("video"))


def shot_video_limit(host, shot, mapping, default_durations):
    if not default_durations or default_durations[-1] >= MAX_SHOT_SECONDS:
        return MAX_SHOT_SECONDS
    try:
        _, approved, entry = shot_start(shot,mapping,host.film.FPS)
        if shot_guides(shot,approved,host.film.FPS,mapping,entry):
            return MAX_SHOT_SECONDS
    except web.HTTPBadRequest:
        pass
    return default_durations[-1]


def depth_motion(user, host, key, shot, start_ref, first, ticks, entry_tick, guides):
    board = host.board_meta(host.board_path(key[1]))
    if not board or not host.can_edit(user, board):
        fail("需要画布编辑权限才能提交动作参考", 403)
    if entry_tick or guides:
        fail("这个镜头已有入画帧或动作关键帧，请使用按关键帧生成")
    if not motion_reference.eligible(first["w"], first["h"], ticks):
        fail("动作参考需要至少 2 秒，且宽高比在 0.4 到 2.5 之间")
    depth = shot.get("depth")
    if not depth or depth.get("state") != "done" or not depth.get("ref"):
        fail("请先生成当前镜头的深度参考")
    fps = host.film.FPS
    if any(round(depth[k] * fps) != round(shot[k] * fps) for k in ("start", "end")):
        fail("剪辑点已更新，请重新生成深度参考", 409)
    path = host.tools.ref_path(host.COMFY_DIR, depth["ref"])
    if not path.is_file() or not host.tools.ref_path(host.COMFY_DIR, start_ref).is_file():
        fail("深度参考或已采用的首帧文件不存在")
    host.require_media(user, {depth["ref"], start_ref})
    return depth["ref"], {"path":path, "ticks":ticks}


async def generate_shot(req, host, key, shot, data, mapping=None, *, motion_route=None):
    first = shot["frames"]["first"]
    start_ref, approved, entry_tick = shot_start(shot, mapping, host.film.FPS)
    videos = shot.setdefault("videos", [])
    if pending(videos):
        fail("此镜头正在生成，请等待完成", 409)
    if len(videos) >= MAX_PREVIEWS:
        fail("此镜头已达到视频版本上限")
    fps = host.film.FPS
    ticks = round(shot["end"] * fps) - round(shot["start"] * fps)
    length = round(ticks / fps, 3)
    guides = shot_guides(shot, approved, fps, mapping, entry_tick)
    durations = remake_durations(host,motion_route) if motion_route else () if guides else default_remake_durations(host)
    limit = min(MAX_SHOT_SECONDS,durations[-1]) if durations else MAX_SHOT_SECONDS
    if not 0 < ticks <= limit * fps:
        fail(f"请先把镜头拆分到 {limit} 秒以内，或保留原镜头")
    duration = next(seconds for seconds in durations if seconds * fps >= ticks) if durations else max(2,length)
    instructions = data.get("motion", "")
    if not isinstance(instructions, str):
        fail("动作要求格式不正确")
    summary = shot["summary"]
    action = summary.get("action") or []
    if not isinstance(action, list):
        action = []
    segments = [summary.get("camera"), *action, instructions[:1600]]
    motion = "。".join(part for part in segments if isinstance(part, str) and part.strip())
    beginning = (f"从原片首帧开始，在 {entry_tick / host.film.FPS:.3f} 秒按对应关键帧让替换角色入画。"
                 if entry_tick else "从输入首帧开始。角色的身份、服装、光线和周围场景与首帧一致。")
    timing = (
        f"用原镜头的机位与节奏，在前 {length:g} 秒完成镜头动作。"
        "原片人物说话时，保留发言时的口部动作和停顿，供后续与原声合成。"
        + (motion.replace("@", "＠") if motion else "沿用首帧构图，保持动作自然。")
    )
    prompt = (beginning + timing)[:3000]
    raw = {
        "kind": "video", "board": key[1], "label": "镜头重制 · " + approved["asset"]["name"],
        "prompt": prompt, "duration": duration, "ar": first["w"] / first["h"], "quality": "std",
        "count": 1, "mode": "fl2v", "_preserve_speech_motion": True,
        "images": [{"ref": start_ref, "role": "frame", "time": 0}],
    }
    depth_ref = None
    if motion_route:
        if data.get("first_job") != approved["job"]:
            fail("已采用的首帧已变更，请核对后重试", 409)
        depth_ref, motion = depth_motion(req["user"], host, key, shot, start_ref, first, ticks, entry_tick, guides)
        prompt = ("以 @图片1 确定开场构图、角色外观、场景光线及成片色彩。"
                  "使用 @视频1 的深度变化参考人物走位、姿态变化、遮挡关系和相机运动。"
                  "成片保持图片的正常色彩、纹理和照明，视频的灰度仅用于空间与时间参考。" + timing)[:3000]
        raw.update(prompt=prompt, provider=motion_route["provider"]["id"],
                   images=[{"ref":start_ref, "role":"subject"}])
        response = await host.generate_remote(req, raw, motion_route, "video", motion=motion)
    elif guides:
        provider = host.providers.get("local_h3")
        if not provider or not provider["enabled"]:
            fail("动作关键帧需要启用本地 H3 视频服务")
        images = raw["images"]
        for guide in guides:
            if not host.tools.ref_path(host.COMFY_DIR, guide["ref"]).is_file():
                fail("动作关键帧文件已丢失，请重新生成并采用")
            images.append({"ref": guide["ref"], "role": "frame", "time": guide["tick"] / host.film.FPS})
        # H3 guide positions must leave four frames at the end of the generated clip.
        final_tick = guides[-1]["tick"]
        if final_tick > host.frames_for(raw["duration"]) - 4:
            raw["duration"] = (final_tick + 4) / host.film.FPS
        for index, image in enumerate(images, 1):
            image["index"] = index
        raw.update(planned=True, provider=provider["id"])
    if not motion_route:
        response = await host.generate_request(req, raw)
    version = submitted_job(response)
    version.update(first_frame=start_ref, entry_tick=entry_tick, mask=approved.get("mask"), asset=approved["asset"],
                   source_person=approved.get("source_person"),
                   motion=instructions[:1600], guides=guides, prompt=prompt,
                   generation={key: raw[key] for key in ("duration", "quality", "provider") if key in raw})
    if depth_ref:
        version.update(mode="depth", depth_ref=depth_ref, motion_model=motion_route["model"])
    videos.append(version)
