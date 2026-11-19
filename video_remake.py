"""Shot-by-shot character replacement previews on the original video frames."""
from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path

from aiohttp import web
from PIL import Image

import db
import image_editor
import video_matte
from creative_memory import IMAGE_EXT, character_notes, fail

MAX_SECONDS = 60
MAX_SHOTS = 12
MAX_PREVIEWS = 20
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".m4v"}
VIEWS = {"main", "face", "side", "back", "detail"}
_writes = set()


def original_video(host, user, board_id, node_id, source):
    board = host.board_meta(host.board_path(board_id))
    if not board or not host.can_see(user, board):
        fail("画布不存在或不可访问", 404)
    node = next((n for n in board.get("nodes", []) if n["id"] == node_id and n["type"] == "video"), None)
    if not isinstance(source, str) or not node or not any(v.get("ref") == source for v in node.get("versions", [])):
        fail("原片版本已不存在，请重新打开视频节点", 404)
    return node


def load(key):
    row = db.one("SELECT data FROM video_remakes WHERE owner=? AND board=? AND node=? AND source=?", *key)
    return json.loads(row["data"]) if row else None


def save(key, session):
    db.run("""INSERT INTO video_remakes VALUES(?,?,?,?,?)
              ON CONFLICT(owner, board, node, source) DO UPDATE SET data=excluded.data""",
           *key, json.dumps(session, ensure_ascii=False, allow_nan=False))


def job_status(host, owner, job_id):
    live = host.JOBS.get(job_id)
    if live:
        exports = [o.get("ref") for o in live.get("outputs") or []]
        return live.get("state"), exports, live.get("error")
    task = db.one("SELECT state,outputs,error FROM tasks WHERE id=? AND user_id=?", job_id, owner)
    if task:
        return task["state"], json.loads(task["outputs"] or "[]"), task["error"]
    return "queued", [], None


def sync_job(host, owner, record, extensions):
    if record.get("state") in ("done", "error"):
        return
    state, refs, error = job_status(host, owner, record["job"])
    record["state"] = state or "queued"
    if state == "done":
        ref = next((r for r in refs if isinstance(r, str) and Path(r).suffix.lower() in extensions), "")
        if ref:
            record["ref"] = ref
        else:
            record.update(state="error", error="任务没有返回所需的媒体文件")
    elif state == "error":
        record["error"] = error or "生成失败"


def update_jobs(host, owner, session):
    for shot in session["shots"]:
        for frame in shot["frames"].values():
            for preview in frame["previews"]:
                sync_job(host, owner, preview, IMAGE_EXT)
        for video in shot.get("videos", []):
            sync_job(host, owner, video, VIDEO_EXT)
    if session.get("export"):
        sync_job(host, owner, session["export"], VIDEO_EXT)


def completed(versions, job):
    return next((v for v in versions if v["job"] == job and v["state"] == "done" and v.get("ref")), None)


def pending(versions):
    return any(item["state"] not in ("done", "error") for item in versions)


def frame_record(ref, dimensions):
    return {"ref": ref, "w": dimensions[0], "h": dimensions[1], "previews": []}


async def analyze(req, host, source):
    def cut_video():
        _, _, duration, _ = host.film.probe(host.tools.ref_path(host.COMFY_DIR, source))
        if not 0 < duration <= MAX_SECONDS:
            raise ValueError(f"角色替换预览支持 {MAX_SECONDS} 秒以内的原片")
        cut = host.tools.find_shots(host.COMFY_DIR, source, MAX_SHOTS, relative_time=True)
        cut["duration"] = duration
        cut["shots"][-1]["end"] = duration
        return cut
    try:
        cut = await asyncio.to_thread(cut_video)
    except Exception as error:
        fail(str(error)[:200] or "无法读取原片")
    details = []
    warning = ""
    try:
        if "llm" not in req.app:
            raise RuntimeError("视觉模型未配置")
        response = await host.llm_call(req, host.tools.analyze_shots(req.app["llm"], host.COMFY_DIR, cut))
        details = json.loads(response.body).get("shots") or []
    except Exception:
        warning = "镜头已切分，视觉分析暂不可用，仍可手动选择人物。"
    shots = []
    for index, item in enumerate(cut["shots"]):
        detail = details[index] if index < len(details) else {}
        size = (item["w"], item["h"])
        shots.append({
            "start": item["start"], "end": item["end"],
            "summary": {field: detail.get(field) for field in ("shot_size", "camera", "scene", "action", "characters")},
            "frames": {"first": frame_record(item["ref"], size), "middle": frame_record(item["mid"], size)},
        })
    return {"duration": cut["duration"], "warning": warning, "shots": shots}


def selected_frame(session, data):
    index, frame_key = data.get("shot"), data.get("frame", "first")
    if type(index) is not int or not 0 <= index < len(session["shots"]) or frame_key not in ("first", "middle"):
        fail("请先选择镜头和画面")
    shot = session["shots"][index]
    return shot, shot["frames"][frame_key]


def coordinates(values, length):
    if not isinstance(values, list) or len(values) != length:
        fail("画面选区格式不正确")
    if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in values):
        fail("画面选区超出范围")
    return values


def display_mask(root, source_ref, mask_ref):
    mask = image_editor.load(root, mask_ref).convert("L")
    source = image_editor.load(root, source_ref)
    if source.size != mask.size or not mask.getbbox():
        raise ValueError("未识别到有效人物区域，请重新点选或手动框选")
    tint = Image.new("RGBA", source.size, (167, 182, 215, 0))
    tint.putalpha(mask.point(lambda value: round(value * .52)))
    return image_editor.save(root, tint, "remake-overlay", "input")["ref"]


async def select_area(req, host, frame, data):
    w, h = frame["w"], frame["h"]
    if "point" in data:
        x, y = coordinates(data["point"], 2)
        result = await host.run_image_tool(req.app, "segment", {
            "ref": frame["ref"],
            "points": [{"x": round(x * (w - 1)), "y": round(y * (h - 1)), "positive": True}],
        })
        mask_ref = result["ref"]
    else:
        a, b, c, d = coordinates(data.get("rect"), 4)
        x0, x1 = sorted((round(a * w), round(c * w)))
        y0, y1 = sorted((round(b * h), round(d * h)))
        if x1 - x0 < 2 or y1 - y0 < 2:
            fail("请框出人物区域")
        mask = Image.new("L", (w, h))
        mask.paste(255, (x0, y0, x1, y1))
        mask_ref = (await asyncio.to_thread(image_editor.save, host.COMFY_DIR, mask, "remake-mask", "input"))["ref"]
    try:
        overlay = await asyncio.to_thread(display_mask, host.COMFY_DIR, frame["ref"], mask_ref)
    except (ValueError, OSError) as error:
        fail(str(error))
    frame["selection"] = {"mask": mask_ref, "overlay": overlay}


def role_reference(req, board, data):
    asset_id = data.get("asset")
    view = data.get("view", "main")
    if not isinstance(asset_id, str) or not isinstance(view, str) or view not in VIEWS:
        fail("请选择一个角色资产和参考角度")
    asset = req.app["creative_memory"].get(req["user"], asset_id, board)
    if asset["kind"] != "character":
        fail("请选择角色资产")
    ref = asset.get("character_views", {}).get(view) or (asset["ref"] if view == "main" else "")
    if not ref or Path(ref).suffix.lower() not in IMAGE_EXT:
        fail("该角色没有可用的参考图")
    return asset, view, ref


async def generate_preview(req, host, key, frame, data):
    if not frame.get("selection"):
        fail("请先在原片画面中选中待替换的人物")
    if pending(frame["previews"]):
        fail("此画面已有生成任务，请等待完成", 409)
    if len(frame["previews"]) >= MAX_PREVIEWS:
        fail("此画面已达到预览版本上限")
    asset, view, reference = role_reference(req, key[1], data)
    if not host.tools.ref_path(host.COMFY_DIR, reference).is_file():
        fail("角色参考图文件找不到")
    note = data.get("note", "")
    if not isinstance(note, str):
        fail("修改要求格式不正确")
    # Keep asset text as context and avoid resolving extra mentions from its descriptions.
    context = "。".join(x for x in (asset["name"], note[:800], character_notes(asset),
                                  asset.get("constraints"), asset.get("desc")) if x)[:6200]
    prompt = (
        "把遮罩内原人物换成 @图3 的角色。保持原镜头里主体的位置、体型占位、姿势、朝向、光线和透视。"
        "保持同画面的其他人物、场景、道具及原有遮挡次序。保持参考角色的面部、服装与配饰左右位置。"
        + context.replace("@", "＠")
    )
    selection = frame["selection"]
    try:
        payload = await asyncio.to_thread(image_editor.prepare, host.COMFY_DIR, {
            "ref": frame["ref"], "mask": selection["mask"], "mode": "region", "backend": "h3",
            "board": key[1], "prompt": prompt, "label": f"角色替换预览 · {asset['name']}",
        })
    except (ValueError, OSError) as error:
        fail(str(error))
    payload["images"].append({"ref": reference})
    preview = submitted_job(await host.generate_request(req, payload))
    preview.update({
        "mask": selection["mask"],
        "asset": {"id": asset["id"], "name": asset["name"], "view": view, "ref": reference},
    })
    frame["previews"].append(preview)
    return {"asset": asset["id"], "view": view}


def submitted_job(response):
    ids = json.loads(response.body).get("ids") or []
    if not ids:
        fail("服务未返回任务编号")
    return {"job": ids[0], "state": "queued"}


async def generate_shot(req, host, key, shot, data):
    first = shot["frames"]["first"]
    approved = completed(first["previews"], first.get("approved"))
    if not approved:
        fail("请先采用这个镜头的首帧预览")
    videos = shot.setdefault("videos", [])
    if pending(videos):
        fail("此镜头正在生成，请等待完成", 409)
    if len(videos) >= MAX_PREVIEWS:
        fail("此镜头已达到视频版本上限")
    length = round(shot["end"] - shot["start"], 3)
    if length <= 0 or length > 14:
        fail("请先剪出 14 秒以内的镜头，或保留原镜头")
    instructions = data.get("motion", "")
    if not isinstance(instructions, str):
        fail("动作要求格式不正确")
    summary = shot["summary"]
    action = summary.get("action") or []
    if not isinstance(action, list):
        action = []
    segments = [summary.get("camera"), *action, instructions[:1600]]
    motion = "。".join(part for part in segments if isinstance(part, str) and part.strip())
    prompt = (
        f"从输入首帧开始。角色的身份、服装、光线和周围场景与首帧一致。"
        f"用原镜头的机位与节奏，在前 {length:g} 秒完成镜头动作。"
        + (motion.replace("@", "＠") if motion else "沿用首帧构图，保持动作自然。")
    )[:3000]
    raw = {
        "kind": "video", "board": key[1], "label": "镜头重制 · " + approved["asset"]["name"],
        "prompt": prompt, "duration": max(2, length), "ar": first["w"] / first["h"], "quality": "std",
        "count": 1, "mode": "fl2v", "images": [{"ref": approved["ref"], "role": "frame", "time": 0}],
    }
    version = submitted_job(await host.generate_request(req, raw))
    version.update(first_frame=approved["ref"], mask=approved.get("mask"), asset=approved["asset"],
                   motion=instructions[:1600])
    videos.append(version)


def localize_shot(req, host, key, shot, job):
    videos = shot.get("videos", [])
    generated = completed(videos, job)
    if not generated or generated.get("mode") == "local":
        fail("请选择已完成的整镜重制视频")
    if pending(videos):
        fail("此镜头正在处理，请等待完成", 409)
    if len(videos) >= MAX_PREVIEWS:
        fail("此镜头已达到视频版本上限")
    first = shot["frames"]["first"]
    seed = next((p for p in first["previews"] if p.get("ref") == generated.get("first_frame")), None)
    mask = generated.get("mask") or (seed or {}).get("mask")
    if not mask:
        fail("这个版本没有首帧选区，请重新采用首帧并生成")
    start, end = shot["start"], shot["end"]
    if end - start > 14:
        fail("局部合成支持 14 秒以内的镜头")

    def composite(progress, cancelled):
        return video_matte.localized_clip(host.COMFY_DIR, key[3], generated["ref"], mask,
                                          start, end, progress, cancelled)

    response = host.enqueue_render(req, composite, seconds=end - start, label="角色替换 · 局部合成", board=key[1])
    version = submitted_job(response)
    version.update(mode="local", derived_from=job, first_frame=generated["first_frame"], mask=mask,
                   asset=generated["asset"], motion=generated.get("motion", ""))
    videos.append(version)


async def approve_video(host, shot, job):
    version = completed(shot.get("videos", []), job)
    if not version:
        fail("请选择已完成的视频版本")
    try:
        _, _, duration, _ = await asyncio.to_thread(host.film.probe, host.tools.ref_path(host.COMFY_DIR, version["ref"]))
    except Exception:
        fail("视频文件无法播放，请重新生成")
    expected_frames = round(shot["end"] * host.film.FPS) - round(shot["start"] * host.film.FPS)
    if duration * host.film.FPS + .51 < expected_frames:
        fail("生成的视频短于原镜头，请重试或保留原镜头")
    version["duration"] = duration
    shot["adopted_video"] = version["job"]
    shot["keep_original"] = False


def export_plan(session, source, fps, duration):
    clips = []
    last_tick = 0
    kept = 0
    for index, shot in enumerate(session["shots"]):
        end = round(min(duration, shot["end"]) * fps)
        if index == len(session["shots"]) - 1:
            end = round(duration * fps)
        frames = end - last_tick
        if frames <= 0:
            continue
        version = None
        if not shot.get("keep_original"):
            version = completed(shot.get("videos", []), shot.get("adopted_video"))
            if not version and (shot.get("videos") or any(f.get("approved") for f in shot["frames"].values())):
                fail(f"镜头 {index + 1} 待审核，请采用视频或选择保留原镜头")
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
    try:
        _, _, duration, _ = await asyncio.to_thread(host.film.probe, source)
    except Exception:
        fail("无法读取原片时间轴")
    spec = export_plan(session, key[3], host.film.FPS, duration)
    session["export"] = submitted_job(host.enqueue_film(req, spec, label="视频重制 · 合成",
                                                      source_audio=source, board=key[1]))


async def handle(req, host):
    source = req.query.get("source")
    board, node = req.match_info["board"], req.match_info["node"]
    original_video(host, req["user"], board, node, source)
    key = (req["user"]["id"], board, node, source)
    if req.method == "GET":
        session = load(key)
        if session:
            update_jobs(host, key[0], session)
        return web.json_response(session)
    data = await req.json()
    if not isinstance(data, dict):
        fail("请求格式不正确")
    if key in _writes:
        fail("此原片正在处理，请稍候", 409)
    _writes.add(key)
    try:
        session = load(key)
        action = data.get("action")
        if action == "analyze":
            if session is None:
                session = await analyze(req, host, source)
        elif session and action == "export":
            update_jobs(host, key[0], session)
            await export_video(req, host, key, session)
        elif session:
            update_jobs(host, key[0], session)
            shot, frame = selected_frame(session, data)
            if action == "select":
                await select_area(req, host, frame, data)
            elif action == "preview":
                session["role"] = await generate_preview(req, host, key, frame, data)
            elif action == "approve":
                preview = completed(frame["previews"], data.get("job"))
                if not preview or not preview.get("ref"):
                    fail("请选择已完成的预览")
                for item in shot["frames"].values():
                    item.pop("approved", None)
                frame["approved"] = preview["job"]
            elif action == "generate_video":
                await generate_shot(req, host, key, shot, data)
            elif action == "localize":
                localize_shot(req, host, key, shot, data.get("job"))
            elif action == "approve_video":
                await approve_video(host, shot, data.get("job"))
            elif action == "keep":
                shot["keep_original"] = True
            else:
                fail("未知的视频重制操作")
        else:
            fail("请先分析原片")
        update_jobs(host, key[0], session)
        save(key, session)
        return web.json_response(session)
    finally:
        _writes.discard(key)
