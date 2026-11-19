"""Shot-by-shot character replacement previews on the original video frames."""
from __future__ import annotations

import asyncio
import json
import math
import re
from contextlib import closing
from pathlib import Path

from aiohttp import web
from PIL import Image, ImageChops

import db
import image_editor
import video_matte
from creative_memory import IMAGE_EXT, character_notes, fail

MAX_SECONDS = 60
MAX_SHOTS = 12
MAX_PREVIEWS = 20
MAX_CORRECTIONS = 8
CUT_ACTIONS = ("split_shot", "move_cut", "merge_shots", "undo_cut")
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


def mapped_shots(session):
    mapping = session.get("mapping")
    return set(mapping["shots"]) if mapping else None


def matches_mapping(version, mapping):
    return (not mapping or (version.get("asset", {}).get("id") == mapping["asset"] and
                            version.get("source_person") == mapping["source"]))


def set_mapping(req, board, session, data):
    source = data.get("person")
    shots = data.get("shots")
    look = data.get("look", "")
    if not isinstance(source, str) or not source.strip() or len(source.strip()) > 60:
        fail("请选择或填写原片人物")
    if (not isinstance(shots, list) or not shots or
            any(type(index) is not int or not 0 <= index < len(session["shots"]) for index in shots)):
        fail("请勾选已确认出现该人物的镜头")
    if not isinstance(look, str) or len(look.strip()) > 240:
        fail("原片外貌提示限 240 字以内")
    asset, _, _ = role_reference(req, board, {**data, "view": "main"})
    session["mapping"] = {"source": source.strip(), "asset": asset["id"],
                          "asset_name": asset["name"], "shots": sorted(set(shots)), "look": look.strip()}


async def analyze(req, host, source):
    try:
        cut = await asyncio.to_thread(find_shots, host, source)
    except Exception as error:
        fail(str(error)[:200] or "无法读取原片")
    details, people, warning = await summarize_shots(req, host, cut)
    shots = []
    for index, item in enumerate(cut["shots"]):
        size = (item["w"], item["h"])
        shots.append({
            "start": item["start"], "end": item["end"],
            "summary": details[index],
            "frames": {"first": {**frame_record(item["ref"], size), "at": item["start"]},
                       "middle": {**frame_record(item["mid"], size), "at": item["mid_at"]}},
        })
    return {"duration": cut["duration"], "warning": warning, "shots": shots, "source_people": people}


async def summarize_shots(req, host, cut):
    details = []
    people = []
    warning = ""
    try:
        if "llm" not in req.app:
            raise RuntimeError("视觉模型未配置")
        response = await host.llm_call(req, host.tools.analyze_shots(req.app["llm"], host.COMFY_DIR, cut))
        analysis = json.loads(response.body)
        details = analysis.get("shots") or []
        if not isinstance(details, list):
            raise ValueError("镜头分析结果格式不正确")
        for person in analysis.get("characters") or []:
            if not isinstance(person, dict):
                continue
            name, look = person.get("name"), person.get("look")
            if isinstance(name, str) and 0 < len(name.strip()) <= 60 and isinstance(look, str) and look.strip():
                people.append({"name": name.strip(), "look": look.strip()[:240]})
        people = people[:24]
    except Exception:
        details = []
        warning = "镜头已切分，视觉分析暂不可用，仍可手动选择人物。"
    summaries = []
    for index in range(len(cut["shots"])):
        detail = details[index] if index < len(details) and isinstance(details[index], dict) else {}
        summaries.append({field: detail.get(field) for field in ("shot_size", "camera", "scene", "action", "characters")})
    return summaries, people, warning


def find_shots(host, source):
    import numpy as np
    path = host.tools.ref_path(host.COMFY_DIR, source)
    _, _, duration, _ = host.film.probe(path)
    fps = host.film.FPS
    ticks = round(duration * fps)
    if ticks <= 0 or duration > MAX_SECONDS:
        raise ValueError(f"角色替换支持 {MAX_SECONDS} 秒以内、至少包含一帧的原片")
    with closing(host.film.video_ticks(path, 0, ticks, relative_time=True)) as frames:
        thumbnails = [frame.reformat(width=64, height=36, format="rgb24").to_ndarray() for frame in frames]
    if not thumbnails:
        raise ValueError("无法读取原片画面")

    # Favor a sharp color or layout change that persists beyond a one- or two-frame flash.
    scores = [0.0] + [float(np.mean(np.abs(b.astype("int16") - a))) for a, b in zip(thumbnails, thumbnails[1:])]
    candidates = []
    min_gap = 6
    for tick in range(min_gap, len(thumbnails) - min_gap + 1):
        score = scores[tick]
        if score < 20:
            continue
        nearby = scores[tick - 4:tick] + scores[tick + 1:tick + 5]
        if score < 2.5 * float(np.median(nearby)):
            continue
        before = np.median(thumbnails[tick - 5:tick], axis=0)
        after = np.median(thumbnails[tick:tick + 5], axis=0)
        if float(np.mean(np.abs(after - before))) >= max(15, score * .55):
            candidates.append((score, tick))
    cuts = [0, ticks]
    for _, tick in sorted(candidates, reverse=True):
        if len(cuts) == MAX_SHOTS + 1:
            break
        if all(abs(tick - cut) >= min_gap for cut in cuts):
            cuts.append(tick)
    cuts.sort()

    spans = []
    scores.append(0.0)
    for start, end in zip(cuts, cuts[1:]):
        middle = (start + end) // 2
        # A representative frame should stay near the midpoint without landing on a flash.
        stable = [tick for tick in range(max(start, middle - 3), min(end, middle + 4))
                  if max(scores[tick], scores[tick + 1]) < 20]
        middle = min(stable, key=lambda tick: abs(tick - middle), default=middle)
        spans.append((start, middle, end))
    selected = original_frames(host, source, {tick for start, middle, _ in spans for tick in (start, middle)})
    shots = []
    for start, middle, end in spans:
        first = selected[start]
        shots.append({"start": start / fps, "end": duration if end == ticks else end / fps,
                      "ref": first["ref"], "mid": selected[middle]["ref"], "mid_at": middle / fps,
                      "w": first["w"], "h": first["h"]})
    return {"duration": duration, "shots": shots}


def original_frames(host, source, ticks):
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
                saved = image_editor.save(host.COMFY_DIR, frame.to_image(), "remake-frame", "input")
                selected[tick] = {**frame_record(saved["ref"], (saved["w"], saved["h"])), "at": tick / fps}
    if len(selected) != len(ticks):
        raise ValueError("没有可用的画面")
    return selected


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
    if any(pending(shot.get("videos", [])) or any(pending(f["previews"]) for f in shot["frames"].values()) for shot in affected):
        fail("受影响的镜头有任务正在处理，请等待完成", 409)
    export = session.get("export")
    if export and pending([export]):
        fail("成片正在合成，请等待完成后再调整切镜", 409)

    archive = session.setdefault("cut_archive", {})
    for (start, end), shot in existing.items():
        if (start, end) not in new_ranges:
            archive[f"{start}:{end}"] = shot

    def capture():
        shots = [existing.get((start, end)) or archive.get(f"{start}:{end}") for start, end in new_ranges]
        fresh = [i for i, shot in enumerate(shots) if shot is None]
        spans = [new_ranges[i] for i in fresh]
        frames = original_frames(host, source, {tick for start, end in spans for tick in (start, (start + end) // 2)})
        for i, (start, end) in zip(fresh, spans):
            first, middle = frames[start], frames[(start + end) // 2]
            shots[i] = {"start": start / fps, "end": end / fps, "summary": {},
                        "frames": {"first": {**first, "previews": []}, "middle": {**middle, "previews": []}}}
        return shots, fresh

    try:
        shots, fresh = await asyncio.to_thread(capture)
    except Exception:
        fail("无法读取新剪辑点的原片画面")
    if fresh:
        cut = {"duration": old[-1] / fps, "known_people": session.get("source_people"), "shots": [
            {"start": shot["start"], "end": shot["end"], "ref": shot["frames"]["first"]["ref"],
             "mid": shot["frames"].get("middle", shot["frames"]["first"])["ref"]} for shot in shots
        ]}
        summaries, people, warning = await summarize_shots(req, host, cut)
        for i in fresh:
            shots[i]["summary"] = summaries[i]
        session["warning"] = warning
        if not session.get("source_people"):
            session["source_people"] = people

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


def selected_frame(session, data):
    index, frame_key = data.get("shot"), data.get("frame", "first")
    if type(index) is not int or not 0 <= index < len(session["shots"]) or not isinstance(frame_key, str):
        fail("请先选择镜头和画面")
    shot = session["shots"][index]
    if frame_key not in shot["frames"]:
        fail("画面已不存在，请重新选择")
    return shot, shot["frames"][frame_key]


async def capture_correction(host, source, shot, value):
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
        frames = await asyncio.to_thread(original_frames, host, source, {tick})
    except (ValueError, OSError):
        fail("无法读取校正画面")
    shot["frames"][frame_key] = {
        **frames[tick], "correction_tick": tick,
    }
    return frame_key


def coordinates(values, length):
    if not isinstance(values, list) or len(values) != length:
        fail("画面选区格式不正确")
    if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in values):
        fail("画面选区超出范围")
    return values


def display_mask(root, source_ref, mask_ref, layer):
    mask = image_editor.load(root, mask_ref).convert("L")
    source = image_editor.load(root, source_ref)
    if source.size != mask.size or not mask.getbbox():
        raise ValueError("未识别到有效区域，请重新点选或手动框选")
    color = (220, 169, 111, 0) if layer == "protection" else (167, 182, 215, 0)
    tint = Image.new("RGBA", source.size, color)
    tint.putalpha(mask.point(lambda value: round(value * .52)))
    return image_editor.save(root, tint, "remake-overlay", "input")["ref"]


def person_selection(frame, mapping):
    selection = frame.get("selection")
    if selection and (not mapping or selection.get("source_person") in (None, mapping["source"])):
        return selection
    return None


async def select_area(req, host, frame, data, layer, *, source_person=None):
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
            fail("请框出有效区域")
        mask = Image.new("L", (w, h))
        mask.paste(255, (x0, y0, x1, y1))
        mask_ref = (await asyncio.to_thread(image_editor.save, host.COMFY_DIR, mask, "remake-mask", "input"))["ref"]
    try:
        overlay = await asyncio.to_thread(display_mask, host.COMFY_DIR, frame["ref"], mask_ref, layer)
    except (ValueError, OSError) as error:
        fail(str(error))
    frame[layer] = {"mask": mask_ref, "overlay": overlay}
    if layer == "selection" and source_person is not None:
        frame[layer]["source_person"] = source_person


async def locate_person(req, host, session, frame, data):
    mapping = session.get("mapping")
    if not mapping or mapping["source"] != data.get("person"):
        fail("请先确认当前镜头的原片人物映射", 409)
    if person_selection(frame, mapping):
        fail("当前画面已有选区，可直接点选或框选来调整", 409)
    source, look = mapping["source"], mapping.get("look") or ""
    if data["action"] == "apply_person_hint":
        hint = frame.get("person_hint") or {}
        if hint.get("source") != source or hint.get("look") != look:
            fail("人物定位已失效，请重新定位", 409)
        await select_area(req, host, frame, {"point": hint["point"]}, "selection", source_person=source)
        return

    appearance = look or next((p["look"] for p in session.get("source_people", []) if p["name"] == source), "")
    if not appearance and re.fullmatch(r"人物\s*\d+", source):
        fail("请在人物映射中补充原片外貌提示，例如服装颜色或明显配饰")
    try:
        result = await host.tools.locate_shot_person(req.app["llm"], host.COMFY_DIR, frame["ref"], source, appearance)
    except Exception:
        fail("视觉定位暂不可用，可继续手动点选或框选")
    point = result.get("point")
    if point is None:
        fail("当前画面里无法确认这个人物，请手动选择")
    point = coordinates(point, 2)
    frame["person_hint"] = {"source": source, "look": look, "point": point}


def preview_mask(root, selection, protection):
    selected = image_editor.load(root, selection).convert("L")
    protected = image_editor.load(root, protection).convert("L").point(lambda value: 255 if value >= 128 else 0)
    editable = ImageChops.subtract(selected, protected)
    if not editable.getbbox():
        raise ValueError("前景保护区覆盖了整个人物选区，请调整选区")
    return image_editor.save(root, editable, "remake-editable", "input")["ref"]


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


async def generate_preview(req, host, key, frame, data, mapping=None):
    selection = person_selection(frame, mapping)
    if not selection:
        fail("请先在原片画面中选中待替换的人物")
    if pending(frame["previews"]):
        fail("此画面已有生成任务，请等待完成", 409)
    if len(frame["previews"]) >= MAX_PREVIEWS:
        fail("此画面已达到预览版本上限")
    asset, view, reference = role_reference(req, key[1], data)
    if mapping and asset["id"] != mapping["asset"]:
        fail("替换角色已更新，请刷新并确认人物映射", 409)
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
    try:
        protection = frame.get("protection", {}).get("mask")
        mask = selection["mask"]
        if protection:
            mask = await asyncio.to_thread(preview_mask, host.COMFY_DIR, mask, protection)
        payload = await asyncio.to_thread(image_editor.prepare, host.COMFY_DIR, {
            "ref": frame["ref"], "mask": mask, "mode": "region", "backend": "h3",
            "board": key[1], "prompt": prompt, "label": f"角色替换预览 · {asset['name']}",
        })
    except (ValueError, OSError) as error:
        fail(str(error))
    payload["images"].append({"ref": reference})
    preview = submitted_job(await host.generate_request(req, payload))
    preview.update({
        "mask": selection["mask"],
        "source_person": mapping["source"] if mapping else None,
        "asset": {"id": asset["id"], "name": asset["name"], "view": view, "ref": reference},
    })
    frame["previews"].append(preview)
    return {"asset": asset["id"], "view": view}


def submitted_job(response):
    ids = json.loads(response.body).get("ids") or []
    if not ids:
        fail("服务未返回任务编号")
    return {"job": ids[0], "state": "queued"}


async def generate_shot(req, host, key, shot, data, mapping=None):
    first = shot["frames"]["first"]
    approved = completed(first["previews"], first.get("approved"))
    if not approved:
        fail("请先采用这个镜头的首帧预览")
    if not matches_mapping(approved, mapping):
        fail("首帧属于之前的人物映射，请重新生成并采用首帧")
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
        "原片人物说话时，保留发言时的口部动作和停顿，供后续与原声合成。"
        + (motion.replace("@", "＠") if motion else "沿用首帧构图，保持动作自然。")
    )[:3000]
    raw = {
        "kind": "video", "board": key[1], "label": "镜头重制 · " + approved["asset"]["name"],
        "prompt": prompt, "duration": max(2, length), "ar": first["w"] / first["h"], "quality": "std",
        "count": 1, "mode": "fl2v", "_preserve_speech_motion": True,
        "images": [{"ref": approved["ref"], "role": "frame", "time": 0}],
    }
    start_tick = round(shot["start"] * host.film.FPS)
    guides = []
    for frame in shot["frames"].values():
        if "correction_tick" not in frame:
            continue
        preview = completed(frame["previews"], frame.get("approved"))
        if (preview and preview["asset"]["id"] == approved["asset"]["id"] and
                preview.get("source_person") == approved.get("source_person")):
            guides.append({"tick": frame["correction_tick"] - start_tick, "ref": preview["ref"]})
    guides.sort(key=lambda guide: guide["tick"])
    if guides:
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
    version = submitted_job(await host.generate_request(req, raw))
    version.update(first_frame=approved["ref"], mask=approved.get("mask"), asset=approved["asset"],
                   source_person=approved.get("source_person"),
                   motion=instructions[:1600], guides=guides)
    videos.append(version)


def localize_shot(req, host, key, shot, job, mapping=None):
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
    seed = next((p for p in first["previews"] if p.get("ref") == generated.get("first_frame")), None)
    mask = generated.get("mask") or (seed or {}).get("mask")
    if not mask:
        fail("这个版本没有首帧选区，请重新采用首帧并生成")
    start, end = shot["start"], shot["end"]
    if end - start > 14:
        fail("局部合成支持 14 秒以内的镜头")

    start_tick = round(start * host.film.FPS)
    corrections = {}
    for frame in shot["frames"].values():
        selection = person_selection(frame, mapping)
        if "correction_tick" in frame and selection:
            corrections[frame["correction_tick"] - start_tick] = selection["mask"]
    protections = {
        frame.get("correction_tick", start_tick) - start_tick: frame["protection"]["mask"]
        for frame_key, frame in shot["frames"].items()
        if "protection" in frame and (frame_key == "first" or "correction_tick" in frame)
    }

    def composite(progress, cancelled):
        return video_matte.localized_clip(host.COMFY_DIR, key[3], generated["ref"], mask,
                                          start, end, progress, cancelled, corrections=corrections,
                                          protections=protections)

    response = host.enqueue_render(req, composite, seconds=end - start, label="角色替换 · 局部合成", board=key[1])
    version = submitted_job(response)
    version.update(mode="local", derived_from=job, first_frame=generated["first_frame"], mask=mask,
                   asset=generated["asset"], source_person=generated.get("source_person"),
                   motion=generated.get("motion", ""), guides=generated.get("guides", []),
                   corrections=corrections, protections=protections)
    videos.append(version)


async def approve_video(host, shot, job, mapping=None):
    version = completed(shot.get("videos", []), job)
    if not version:
        fail("请选择已完成的视频版本")
    if not matches_mapping(version, mapping):
        fail("视频属于之前的人物映射，请重新生成当前角色的视频")
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
    scoped = mapped_shots(session)
    for index, shot in enumerate(session["shots"]):
        end = round(min(duration, shot["end"]) * fps)
        if index == len(session["shots"]) - 1:
            end = round(duration * fps)
        frames = end - last_tick
        if frames <= 0:
            continue
        version = None
        if (scoped is None or index in scoped) and not shot.get("keep_original"):
            version = completed(shot.get("videos", []), shot.get("adopted_video"))
            if version and not matches_mapping(version, session.get("mapping")):
                fail(f"镜头 {index + 1} 的视频属于之前的人物映射，请重新审核")
            if not version and (scoped is not None or shot.get("videos") or any(f.get("approved") for f in shot["frames"].values())):
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


def public_session(session, **extra):
    if session is None:
        return None
    return {**{key: value for key, value in session.items() if key not in ("cut_archive", "cut_undo")},
            "can_undo_cut": bool(session.get("cut_undo")), **extra}


async def handle(req, host):
    source = req.query.get("source")
    board, node = req.match_info["board"], req.match_info["node"]
    original_video(host, req["user"], board, node, source)
    key = (req["user"]["id"], board, node, source)
    if req.method == "GET":
        session = load(key)
        if session:
            update_jobs(host, key[0], session)
        return web.json_response(public_session(session))
    data = await req.json()
    if not isinstance(data, dict):
        fail("请求格式不正确")
    if key in _writes:
        fail("此原片正在处理，请稍候", 409)
    _writes.add(key)
    try:
        response = {}
        session = load(key)
        action = data.get("action")
        if session and data.get("cut_revision", 0) != session.get("cut_revision", 0):
            fail("剪辑点已更新，请重新打开视频重制界面", 409)
        if action == "analyze":
            if session is None:
                session = await analyze(req, host, source)
        elif session and action == "export":
            update_jobs(host, key[0], session)
            await export_video(req, host, key, session)
        elif session and action == "map_person":
            set_mapping(req, board, session, data)
        elif session and action == "remove_mapping":
            session.pop("mapping", None)
        elif session and action in CUT_ACTIONS:
            update_jobs(host, key[0], session)
            response["selected_shot"] = await edit_cuts(req, host, source, session, data)
        elif session:
            update_jobs(host, key[0], session)
            shot, frame = selected_frame(session, data)
            mapping = session.get("mapping")
            scoped = mapped_shots(session)
            if (scoped is not None and data["shot"] not in scoped and
                    action in ("preview", "approve", "generate_video", "localize", "approve_video",
                               "locate_person", "apply_person_hint")):
                fail("此镜头未包含在人物映射范围内，请先确认该镜头")
            if action in ("select", "clear_protection"):
                layer = "protection" if action == "clear_protection" else data.get("layer", "selection")
                if layer not in ("selection", "protection"):
                    fail("请选择人物选区或前景保护区")
                if layer == "protection" and frame is not shot["frames"]["first"] and "correction_tick" not in frame:
                    fail("请在首帧或校正帧标记前景保护区")
                if action == "clear_protection":
                    # A null anchor stops protection inherited from an earlier frame.
                    frame["protection"] = {"mask": None}
                else:
                    person = mapping["source"] if mapping and data["shot"] in scoped else None
                    await select_area(req, host, frame, data, layer, source_person=person)
            elif action in ("locate_person", "apply_person_hint"):
                await locate_person(req, host, session, frame, data)
            elif action == "capture_correction":
                response["captured_frame"] = await capture_correction(host, source, shot, data.get("at"))
            elif action == "remove_correction":
                if "correction_tick" not in frame:
                    fail("请选择要移除的校正帧")
                del shot["frames"][data["frame"]]
            elif action == "preview":
                session["role"] = await generate_preview(req, host, key, frame, data, mapping)
            elif action == "approve":
                preview = completed(frame["previews"], data.get("job"))
                if not preview or not preview.get("ref"):
                    fail("请选择已完成的预览")
                if not matches_mapping(preview, mapping):
                    fail("这个预览属于之前的人物映射，请为当前角色重新生成")
                frame["approved"] = preview["job"]
            elif action == "clear_guide":
                if "correction_tick" not in frame:
                    fail("请选择要取消的动作关键帧")
                frame.pop("approved", None)
            elif action == "generate_video":
                await generate_shot(req, host, key, shot, data, mapping)
            elif action == "localize":
                localize_shot(req, host, key, shot, data.get("job"), mapping)
            elif action == "approve_video":
                await approve_video(host, shot, data.get("job"), mapping)
            elif action == "keep":
                shot["keep_original"] = True
            else:
                fail("未知的视频重制操作")
        else:
            fail("请先分析原片")
        update_jobs(host, key[0], session)
        save(key, session)
        return web.json_response(public_session(session, **response))
    finally:
        _writes.discard(key)
