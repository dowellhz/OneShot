"""Shot-by-shot character replacement previews on the original video frames."""
from __future__ import annotations

import asyncio
import json
import math
import re
from contextlib import closing
from copy import deepcopy
from pathlib import Path

from aiohttp import web
from PIL import Image, ImageChops

import db
import image_editor
import motion_reference
import video_depth
import video_matte
from creative_memory import IMAGE_EXT, character_notes, fail
from tools import VIDEO_EXT

MAX_SECONDS = 60
MAX_SHOT_SECONDS = 14
MAX_SHOTS = 12
MAX_PREVIEWS = 20
MAX_CORRECTIONS = 8
CUT_ACTIONS = ("split_shot", "split_long_shot", "move_cut", "merge_shots", "undo_cut")
VIEWS = {"main", "face", "side", "back", "detail"}
_writes = set()


def original_video(host, user, board_id, node_id, source):
    board = host.board_meta(host.board_path(board_id))
    if not board or not host.can_see(user, board):
        fail("画布不存在或不可访问", 404)
    node = next((n for n in board.get("nodes", []) if n["id"] == node_id and n["type"] == "video"), None)
    if not isinstance(source, str) or not node:
        fail("原片版本已不存在，请重新打开视频节点", 404)
    versions = node.get("versions", [])
    matches = [v for v in versions if v.get("ref") == source]
    if not matches:
        fail("原片版本已不存在，请重新打开视频节点", 404)
    selected = node.get("cur")
    if type(selected) is int and 0 <= selected < len(versions) and versions[selected].get("ref") == source:
        return versions[selected]
    return matches[0]


def remake_key(host, user, board, node, source):
    version = original_video(host, user, board, node, source)
    lineage = version.get("tab_nodes")
    lineage = [item for item in lineage if isinstance(item, str) and item] if isinstance(lineage, list) else []
    if not lineage:
        return (user["id"], board, node, source)
    existing = {row["node"] for row in db.q(
        "SELECT node FROM video_remakes WHERE owner=? AND board=? AND source=?", user["id"], board, source,
    )}
    # A moved tab reuses the most recent existing session in its own source lineage.
    location = next((item for item in [node, *reversed(lineage)] if item in existing), lineage[0])
    return (user["id"], board, location, source)


def load(key):
    row = db.one("SELECT data FROM video_remakes WHERE owner=? AND board=? AND node=? AND source=?", *key)
    if not row:
        return None
    session = json.loads(row["data"])
    if session.get("warning"):
        for shot in [*session["shots"], *session.get("cut_archive", {}).values()]:
            shot.setdefault("analysis_missing", not any(shot.get("summary", {}).values()))
    return session


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
        if depth := shot.get("depth"):
            sync_job(host, owner, depth, VIDEO_EXT)
            if depth["state"] == "done" and not host.tools.ref_path(host.COMFY_DIR, depth["ref"]).is_file():
                depth.update(state="error", error="深度参考文件已丢失，请重新生成")
                depth.pop("ref", None)
    if session.get("export"):
        sync_job(host, owner, session["export"], VIDEO_EXT)
    if session.get("playback"):
        sync_job(host, owner, session["playback"], VIDEO_EXT)


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
    if not mapping:
        return True
    roles = version.get("roles") or [version]
    return any(role.get("asset", {}).get("id") == mapping["asset"] and role.get("source_person") == mapping["source"]
               for role in roles)


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
    source = source.strip()
    activate_role_frames(session, source)
    session["mapping"] = {"source": source, "asset": asset["id"],
                          "asset_name": asset["name"], "shots": sorted(set(shots)), "look": look.strip()}


def activate_role_frames(session, source):
    previous = session.get("mapping", {}).get("source")
    if previous != source:
        fields = ("selection", "protection", "person_absent", "person_hint", "approved")
        for shot in session["shots"]:
            for frame in shot["frames"].values():
                stored = frame.get("role_states", {})
                frame_owner = (previous or (frame.get("selection") or {}).get("source_person")
                               or (frame.get("person_absent") or {}).get("source")
                               or (frame.get("person_hint") or {}).get("source"))
                if frame_owner and frame_owner == source:
                    continue
                if frame_owner:
                    stored[frame_owner] = {key:frame.pop(key) for key in fields if key in frame}
                    frame["role_states"] = stored
                elif stored:
                    for key in fields:
                        frame.pop(key, None)
                frame.update(stored.pop(source, {}))


async def analyze(req, host, source):
    try:
        cut = await asyncio.to_thread(find_shots, host, source)
    except Exception as error:
        fail(str(error)[:200] or "无法读取原片")
    details, people, missing = await summarize_shots(req, host, cut)
    shots = []
    for index, item in enumerate(cut["shots"]):
        size = (item["w"], item["h"])
        shots.append({
            "start": item["start"], "end": item["end"],
            "summary": details[index], "analysis_missing": index in missing,
            "frames": {"first": {**frame_record(item["ref"], size), "at": item["start"]},
                       "middle": {**frame_record(item["mid"], size), "at": item["mid_at"]}},
        })
    return {"duration": cut["duration"], "shots": shots, "source_people": people,
            "display_oriented": True}


async def summarize_shots(req, host, cut):
    count = len(cut["shots"])
    details = []
    people = []
    missing = set(range(count))
    try:
        if "llm" not in req.app:
            raise RuntimeError("视觉模型未配置")
        response = await host.llm_call(req, host.tools.analyze_shots(req.app["llm"], host.COMFY_DIR, cut))
        analysis = json.loads(response.body)
        details = analysis.get("shots") or []
        if not isinstance(details, list):
            raise ValueError("镜头分析结果格式不正确")
        missing = {number - 1 for number in analysis.get("missing_shots", [])}
        missing.update(i for i in range(count) if i >= len(details) or not isinstance(details[i], dict))
        for person in analysis.get("characters") or []:
            if not isinstance(person, dict):
                continue
            name, look = person.get("name"), person.get("look")
            if isinstance(name, str) and 0 < len(name.strip()) <= 60 and isinstance(look, str) and look.strip():
                people.append({"name": name.strip(), "look": look.strip()[:240]})
        people = people[:24]
    except Exception:
        details = []
        people = []
        missing = set(range(count))
    summaries = []
    for index in range(count):
        detail = details[index] if index < len(details) and isinstance(details[index], dict) else {}
        summaries.append({field: detail.get(field) for field in ("shot_size", "camera", "scene", "action", "characters")})
    return summaries, people, missing


def analysis_warning(shots):
    missing = [str(index) for index, shot in enumerate(shots, 1) if shot.get("analysis_missing")]
    if not missing:
        return ""
    if len(missing) == len(shots):
        return "镜头已切分，视觉分析暂不可用。可重试分析或手动选择人物。"
    return f"镜头 {'、'.join(missing)} 缺少视觉分析，可重试分析或手动选择人物。"


async def fill_shot_analysis(req, host, session, shots, indices):
    if not indices:
        return
    cut = {"duration": shots[-1]["end"], "known_people": session.get("source_people"), "shots": []}
    for shot in shots:
        first = shot["frames"]["first"]
        middle = shot["frames"].get("middle", first)
        cut["shots"].append({"start": shot["start"], "end": shot["end"], "ref": first["ref"],
                             "w": first["w"], "h": first["h"], "mid": middle["ref"]})
    summaries, people, missing = await summarize_shots(req, host, cut)
    for index in indices:
        shots[index]["analysis_missing"] = index in missing
        if index not in missing:
            shots[index]["summary"] = summaries[index]
    if any(index not in missing for index in indices):
        known = {person["name"]: person for person in session.get("source_people", [])}
        for person in people:
            known.setdefault(person["name"], person)
        session["source_people"] = list(known.values())[:24]


def find_shots(host, source):
    import numpy as np
    path = host.tools.ref_path(host.COMFY_DIR, source)
    _, _, duration, _ = host.film.probe(path, display=False)
    fps = host.film.FPS
    ticks = round(duration * fps)
    if ticks <= 0 or duration > MAX_SECONDS:
        raise ValueError(f"角色替换支持 {MAX_SECONDS} 秒以内、至少包含一帧的原片")
    with closing(host.film.video_ticks(path, 0, ticks, relative_time=True)) as frames:
        thumbnails = [np.asarray(host.film.frame_image(frame, thumbnail_size=(64, 36))) for frame in frames]
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


def sample_shot_frames(host, source, shot, display, offsets=None):
    from rewriter import encode_image_part
    fps = host.film.FPS
    start = round(shot["start"] * fps)
    count = round(shot["end"] * fps) - start
    if count <= 0:
        raise ValueError("镜头中没有可用画面")
    if offsets is None:
        offsets = {round(i * (count - 1) / 5) for i in range(6)}
    first = shot["frames"]["first"]
    scale = min(1, 640 / max(first["w"], first["h"]))
    size = (max(1, round(first["w"] * scale)), max(1, round(first["h"] * scale)))
    path = host.tools.ref_path(host.COMFY_DIR, source)
    samples = []
    with closing(host.film.video_ticks(path, start / fps, max(offsets) + 1, relative_time=True)) as frames:
        for tick, frame in enumerate(frames):
            if tick in offsets:
                image = host.film.frame_image(frame, display=display, thumbnail_size=size)
                samples.append((tick, encode_image_part(image, 640)))
    if not samples:
        raise ValueError("镜头中没有可用画面")
    return samples


def person_appearance(session, mapping):
    if not mapping:
        return ""
    return mapping.get("look") or next((p["look"] for p in session.get("source_people", [])
                                         if p["name"] == mapping["source"]), "")


async def analyze_motion(req, host, source, session, shot, mapping):
    fps = host.film.FPS
    person = mapping["source"] if mapping else None
    try:
        samples = await asyncio.to_thread(sample_shot_frames, host, source, shot, session.get("display_oriented", False))
        analysis = await host.tools.describe_shot_motion(req.app["llm"], samples, fps, person,
                                                        person_appearance(session, mapping))
    except Exception:
        fail("无法分析此镜头的动作，可手动填写动作与运镜")
    if not isinstance(analysis, dict):
        fail("动作分析结果格式不正确，请重试")
    camera = analysis.get("camera")
    camera = camera.strip()[:240] if isinstance(camera, str) else ""
    beats = {}
    rows = analysis.get("beats")
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            number, action = row.get("sample"), row.get("action")
            if type(number) is int and 1 <= number <= len(samples) and isinstance(action, str) and action.strip():
                beats.setdefault(samples[number - 1][0], action.strip()[:220])
    if not camera and not beats:
        fail("动作分析未返回可用内容，请重试")
    shot["motion_analysis"] = {
        "camera":camera, "beats":[{"tick":tick, "action":action} for tick, action in sorted(beats.items())],
        "source_person":person,
    }


async def suggest_entry(req, host, source, session, shot, mapping, data):
    if not mapping or mapping["source"] != data.get("person"):
        fail("请先确认当前镜头的原片人物映射", 409)
    if not person_absent(shot["frames"]["first"], mapping):
        fail("请先确认并标记首帧人物出画")
    person, look = mapping["source"], mapping.get("look") or ""
    appearance = person_appearance(session, mapping)
    if not appearance and re.fullmatch(r"人物\s*\d+", person):
        fail("请在人物映射中补充原片外貌提示，例如服装颜色或明显配饰")
    fps = host.film.FPS
    start = round(shot["start"] * fps)
    display = session.get("display_oriented", False)
    excluded = {0, *(frame["correction_tick"] - start for frame in correction_frames(shot) if person_absent(frame, mapping))}

    async def locate(offsets=None):
        samples = await asyncio.to_thread(sample_shot_frames, host, source, shot, display, offsets)
        samples = [sample for sample in samples if sample[0] not in excluded]
        if not samples:
            return None
        result = await host.tools.locate_shot_entry(req.app["llm"], samples, person, appearance)
        number = result.get("sample")
        if number is None:
            return None
        if type(number) is not int or not 1 <= number <= len(samples):
            raise ValueError("Invalid entry frame")
        tick = samples[number - 1][0]
        earlier = samples[number - 2][0] if number > 1 else 0
        return tick, coordinates(result.get("point"), 2), earlier

    try:
        match = await locate()
    except Exception:
        fail("入画帧识别暂不可用，可手动添加校正帧")
    if not match:
        fail("采样画面中未能确认人物，可手动定位首次入画位置")
    tick, point, earlier = match
    # Check a second set of samples before the first visible match.
    offsets = {round(earlier + (tick - earlier) * i / 6) for i in range(1, 6)} - excluded - {earlier, tick}
    if offsets:
        try:
            refined = await locate(offsets)
        except Exception:
            refined = None
        if refined:
            tick, point, _ = refined
    frame_key = await capture_correction(host, source, shot, (start + tick) / fps, display=display)
    frame = shot["frames"][frame_key]
    if not person_selection(frame, mapping):
        frame["person_hint"] = {"source":person, "look":look, "point":point}
    return frame_key


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
        pieces = math.ceil(length / (MAX_SHOT_SECONDS * fps))
        if pieces < 2:
            fail(f"此镜头已经在 {MAX_SHOT_SECONDS} 秒以内")
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


def selected_frame(session, data):
    index, frame_key = data.get("shot"), data.get("frame", "first")
    if type(index) is not int or not 0 <= index < len(session["shots"]) or not isinstance(frame_key, str):
        fail("请先选择镜头和画面")
    shot = session["shots"][index]
    if frame_key not in shot["frames"]:
        fail("画面已不存在，请重新选择")
    return shot, shot["frames"][frame_key]


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


def person_absent(frame, mapping):
    marker = frame.get("person_absent")
    return marker is not None and (not mapping or marker.get("source") in (None, mapping["source"]))


def person_selection(frame, mapping):
    selection = frame.get("selection")
    if selection and not person_absent(frame, mapping) and (
        not mapping or selection.get("source_person") in (None, mapping["source"])
    ):
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
    if person_absent(frame, mapping):
        fail("请先取消人物出画标记")
    if person_selection(frame, mapping):
        fail("当前画面已有选区，可直接点选或框选来调整", 409)
    source, look = mapping["source"], mapping.get("look") or ""
    if data["action"] == "apply_person_hint":
        hint = frame.get("person_hint") or {}
        if hint.get("source") != source or hint.get("look") != look:
            fail("人物定位已失效，请重新定位", 409)
        await select_area(req, host, frame, {"point": hint["point"]}, "selection", source_person=source)
        return

    appearance = person_appearance(session, mapping)
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


async def batch_locate_people(req, host, session, data):
    mapping = session.get("mapping")
    if not mapping or (data.get("person"), data.get("asset"), data.get("look", "")) != (
        mapping["source"], mapping["asset"], mapping.get("look", "")
    ):
        fail("人物映射已更新，请核对后重新定位", 409)
    indices = data.get("shots")
    scope = mapped_shots(session)
    if (not isinstance(indices, list) or not 1 <= len(indices) <= MAX_SHOTS or
            any(type(index) is not int or index not in scope for index in indices) or len(set(indices)) != len(indices)):
        fail("批量定位的镜头必须在人物映射范围内，且不可重复")

    limiter = asyncio.Semaphore(3)

    async def locate(index):
        shot = session["shots"][index]
        frame = shot["frames"]["first"]
        hint = frame.get("person_hint") or {}
        if (shot.get("keep_original") or person_absent(frame, mapping) or person_selection(frame, mapping) or
                (hint.get("source") == mapping["source"] and hint.get("look") == mapping.get("look", ""))):
            return "skipped", index
        async with limiter:
            try:
                await locate_person(req, host, session, frame, {"action": "locate_person", "person": mapping["source"]})
            except web.HTTPBadRequest as error:
                return "failed", {"shot": index, "error": json.loads(error.text)["error"]}
        return "located", index

    outcome = {"located": [], "skipped": [], "failed": []}
    for state, item in await asyncio.gather(*(locate(index) for index in indices)):
        outcome[state].append(item)
    return outcome


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
    if data.get("reference") is not None and data["reference"] != ref:
        fail("资产库角色参考图已更新，请重新打开视频重制后再生成", 409)
    if not ref or Path(ref).suffix.lower() not in IMAGE_EXT:
        fail("该角色没有可用的参考图")
    return asset, view, ref


async def generate_preview(req, host, key, frame, data, mapping=None, *, role=None):
    selection = person_selection(frame, mapping)
    if not selection:
        fail("请先在原片画面中选中待替换的人物")
    if pending(frame["previews"]):
        fail("此画面已有生成任务，请等待完成", 409)
    if len(frame["previews"]) >= MAX_PREVIEWS:
        fail("此画面已达到预览版本上限")
    asset, view, reference = role or role_reference(req, key[1], data)
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
        "protection": protection,
        "note": note[:800],
        "source_person": mapping["source"] if mapping else None,
        "asset": {"id": asset["id"], "name": asset["name"], "view": view, "ref": reference},
    })
    frame["previews"].append(preview)
    return {"asset": asset["id"], "view": view}


async def queue_shots(req, host, key, session, data):
    mapping = session.get("mapping")
    if not mapping or data.get("asset") != mapping["asset"] or data.get("person") != mapping["source"]:
        fail("人物映射已更新，请核对后重新提交", 409)
    requests = data.get("shots")
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_SHOTS:
        fail("请选择要批量生成的镜头")
    inputs = {}
    previews_only = data["action"] == "batch_previews"
    scope = mapped_shots(session)
    for item in requests:
        index = item.get("shot") if isinstance(item, dict) else None
        if type(index) is not int or index not in scope or index in inputs:
            fail("批量生成的镜头必须在人物映射范围内，且不可重复")
        if previews_only:
            view = item.get("view", "main")
            if not isinstance(view, str) or view not in VIEWS:
                fail("镜头参考角度无效")
            note = item.get("note", "")
            if not isinstance(note, str):
                fail("镜头修改要求格式不正确")
            frame_key = item.get("frame", "first")
            if not isinstance(frame_key, str):
                fail("预览画面格式不正确")
            reference = item.get("reference")
            if reference is not None and not isinstance(reference, str):
                fail("角色参考图格式不正确")
            inputs[index] = {"asset":mapping["asset"], "view":view, "note":note[:800], "frame":frame_key,
                             "reference":reference}
        else:
            motion, first_job = item.get("motion", ""), item.get("first_job")
            if not isinstance(motion, str) or not isinstance(first_job, str) or not first_job:
                fail("请提供已采用的首帧和有效的动作说明")
            inputs[index] = {"motion":motion[:1600], "first_job":first_job}

    outcome = {"submitted": [], "skipped": [], "failed": []}
    for index, params in inputs.items():
        shot = session["shots"][index]
        if shot.get("keep_original"):
            outcome["skipped"].append(index)
            continue
        try:
            submitted = await queue_one_shot(req, host, key, shot, params, mapping, previews_only)
        except web.HTTPException as error:
            try:
                message = json.loads(error.text).get("error") or error.reason
            except (ValueError, AttributeError):
                message = error.reason
            outcome["failed"].append({"shot": index, "error": message})
        except Exception:
            outcome["failed"].append({"shot": index, "error": "生成服务未能提交任务"})
        else:
            outcome["submitted" if submitted else "skipped"].append(index)
            if submitted:
                if previews_only and data.get("plan_id"):
                    shot["frames"][params["frame"]]["previews"][-1]["plan_id"] = data["plan_id"]
                # Keep each task reachable even if a later service call fails.
                save(key, session)
    return outcome


async def apply_remake_plan(req, host, key, session, data):
    indices = data.get("shots")
    if (not isinstance(indices, list) or not 1 <= len(indices) <= 4
            or any(type(i) is not int or not 0 <= i < len(session["shots"]) for i in indices)
            or len(set(indices)) != len(indices)):
        fail("请选择 1 至 4 个不同的镜头")
    role_reference(req, key[1], data)
    previous = session.get("mapping")
    scope = indices
    if previous and previous["source"] == data.get("person") and previous["asset"] == data.get("asset"):
        scope = list(dict.fromkeys([*previous["shots"], *indices]))
    set_mapping(req, key[1], session, {**data, "shots":scope})
    mapping = session["mapping"]
    outcome = {"submitted":[], "skipped":[], "failed":[], "needs_selection":[], "jobs":[]}
    requests = []
    for index in indices:
        shot = session["shots"][index]
        frame_key = start_preview_key(shot, mapping)
        if shot.get("keep_original"):
            outcome["skipped"].append(index)
        elif not frame_key or (person_selection(shot["frames"][frame_key], mapping) or {}).get("source_person") != mapping["source"]:
            outcome["needs_selection"].append(index)
        else:
            requests.append({"shot":index, "frame":frame_key, "view":"main", "reference":data.get("reference")})
    if requests:
        if data.get("plan_id"):
            save(key, session)
        queued = await queue_shots(req, host, key, session, {**data, "action":"batch_previews", "shots":requests})
        for field in queued:
            outcome[field].extend(queued[field])
        for item in requests:
            if item["shot"] in queued["submitted"]:
                frame = session["shots"][item["shot"]]["frames"][item["frame"]]
                outcome["jobs"].append({"index":item["shot"], "frame":item["frame"], "job":frame["previews"][-1]["job"]})
    return outcome


def remake_plan_result(session, plan_id, receipt):
    if receipt.get("result") is not None:
        return receipt["result"]
    jobs = [{"index":index, "frame":frame, "job":preview["job"]}
            for index, shot in enumerate(session["shots"])
            for frame, item in shot["frames"].items()
            for preview in item["previews"] if preview.get("plan_id") == plan_id]
    return {"submitted":[job["index"] for job in jobs], "jobs":jobs, "skipped":[], "needs_selection":[],
            "failed":[], "uncertain":True}


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


def submitted_job(response):
    ids = json.loads(response.body).get("ids") or []
    if not ids:
        fail("服务未返回任务编号")
    return {"job": ids[0], "state": "queued"}


def correction_frames(shot):
    return sorted((f for f in shot["frames"].values() if "correction_tick" in f), key=lambda f: f["correction_tick"])


def start_preview_key(shot, mapping):
    frames = shot["frames"]
    if not person_absent(frames["first"], mapping):
        return "first"
    eligible = (key for key, frame in frames.items()
                if "correction_tick" in frame and person_selection(frame, mapping))
    return min(eligible, key=lambda key: frames[key]["correction_tick"], default=None)


def preview_matches_regions(frame, preview, mapping):
    selection = person_selection(frame, mapping)
    return ((not selection or selection["mask"] == preview.get("mask")) and
            frame.get("protection", {}).get("mask") == preview.get("protection"))


def shot_start(shot, mapping, fps):
    first = shot["frames"]["first"]
    if person_absent(first, mapping):
        entry = shot["frames"].get(start_preview_key(shot, mapping))
        if entry:
            approved = completed(entry["previews"], entry.get("approved"))
            if approved and matches_mapping(approved, mapping):
                if not preview_matches_regions(entry, approved, mapping):
                    fail("入画帧选区已更新，请重新生成并采用预览", 409)
                return first["ref"], approved, entry["correction_tick"] - round(shot["start"] * fps)
        fail("请在人物首次入画的校正帧中选中人物，生成预览并用作动作关键帧")
    approved = completed(first["previews"], first.get("approved"))
    if not approved:
        fail("请先采用这个镜头的首帧预览")
    if not matches_mapping(approved, mapping):
        fail("首帧属于之前的人物映射，请重新生成并采用首帧")
    if not preview_matches_regions(first, approved, mapping):
        fail("首帧选区已更新，请重新生成并采用预览", 409)
    return approved["ref"], approved, 0


def shot_guides(shot, approved, fps, mapping=None, entry_tick=0):
    start_tick = round(shot["start"] * fps)
    guides = []
    for frame in correction_frames(shot):
        tick = frame["correction_tick"] - start_tick
        if tick < entry_tick or person_absent(frame, mapping):
            continue
        preview = completed(frame["previews"], frame.get("approved"))
        if (preview and preview["asset"]["id"] == approved["asset"]["id"] and
                preview.get("source_person") == approved.get("source_person")):
            if not preview_matches_regions(frame, preview, mapping):
                fail(f"{frame['correction_tick'] / fps:.2f} 秒的动作关键帧选区已更新，请重新生成预览或取消此关键帧", 409)
            guides.append({"tick": tick, "ref": preview["ref"]})
    return guides


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
    if not 0 < ticks <= MAX_SHOT_SECONDS * fps:
        fail(f"请先把镜头拆分到 {MAX_SHOT_SECONDS} 秒以内，或保留原镜头")
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
        "prompt": prompt, "duration": max(2, length), "ar": first["w"] / first["h"], "quality": "std",
        "count": 1, "mode": "fl2v", "_preserve_speech_motion": True,
        "images": [{"ref": start_ref, "role": "frame", "time": 0}],
    }
    guides = shot_guides(shot, approved, host.film.FPS, mapping, entry_tick)
    depth_ref = None
    if motion_route:
        if data.get("first_job") != approved["job"]:
            fail("已采用的首帧已变更，请核对后重试", 409)
        depth_ref, motion = depth_motion(req["user"], host, key, shot, start_ref, first, ticks, entry_tick, guides)
        prompt = ("以 @图片1 确定开场构图、角色外观、场景光线及成片色彩。"
                  "使用 @视频1 的深度变化参考人物走位、姿态变化、遮挡关系和相机运动。"
                  "成片保持图片的正常色彩、纹理和照明，视频的灰度仅用于空间与时间参考。" + timing)[:3000]
        raw.update(prompt=prompt, duration=max(4, math.ceil(ticks / fps)), provider=motion_route["provider"]["id"],
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


def video_start_issue(shot, version, mapping):
    if version.get("mode") == "combined":
        return None if shot.get("role_layers") == version.get("roles") else "角色情况已更新，请重新合成并审核"
    first = shot["frames"]["first"]
    person = version.get("source_person")
    role_frame = first.get("role_states", {}).get(person, first)
    starts_absent = person_absent(role_frame, {"source":person} if person else mapping)
    if starts_absent != bool(version.get("entry_tick")):
        return "首帧出画标记已变更，请重新生成并审核镜头视频"
    if starts_absent and version.get("mode") != "local":
        return "请先做局部合成以保留开头原片，再采用此镜头"
    return None


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


def prepare_depth(req, host, key, session, shot):
    board = host.board_meta(host.board_path(key[1]))
    if not board or not host.can_edit(req["user"], board):
        fail("需要画布编辑权限才能生成深度参考", 403)
    if depth := shot.get("depth"):
        if depth["state"] != "error":
            return
    config = video_depth.configuration()
    if not config:
        fail("部署主机尚未安装 Small 视频深度模型", 503)
    fps = host.film.FPS
    start, end = round(shot["start"] * fps), round(shot["end"] * fps)
    if not 0 < end - start <= MAX_SHOT_SECONDS * fps:
        fail(f"单段深度参考最多 {MAX_SHOT_SECONDS} 秒，请先拆分长镜头")
    source = host.tools.ref_path(host.COMFY_DIR, key[3])
    if not source.is_file():
        fail("原片文件已丢失")
    if any(other.get("depth") and pending([other["depth"]]) for other in session["shots"]):
        fail("此原片已有深度任务，请等待完成或取消后再提交", 409)
    display = session.get("display_oriented", False)

    def encode(progress, cancelled):
        return video_depth.generate(host.COMFY_DIR, source, start / fps, end - start, display,
                                    progress, cancelled, config)

    depth = submitted_job(host.enqueue_render(req, encode, seconds=(end - start) / fps,
                                              label="视频重制 · 深度参考", board=key[1], depth=True))
    first = shot["frames"]["first"]
    w, h = video_depth.dimensions(first["w"], first["h"])
    shot["depth"] = {**depth, "start": start / fps, "end": end / fps, "w": w, "h": h}


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


def public_session(host, session, **extra):
    if session is None:
        return None
    result = {key: value for key, value in session.items() if key not in ("cut_archive", "cut_undo")}
    jobs = []
    for i, shot in enumerate(session["shots"]):
        version, issue = export_choice(shot, session.get("mapping"), i)
        jobs.append(version["job"] if version and not issue else None)
    result["reviewed_jobs"] = jobs
    result["remake_plans"] = {key:{"shots":receipt["shots"], "result":remake_plan_result(session, key, receipt)}
                              for key, receipt in session.get("remake_plans", {}).items()}
    if "export" in result:
        result["export"] = available_export(host, result["export"])
    return {**result, "can_undo_cut": bool(session.get("cut_undo")), "export_review": export_review(session),
            "motion_providers": motion_providers(host),
            "depth_available": video_depth.configuration() is not None, **extra}


async def handle(req, host):
    source = req.query.get("source")
    board, node = req.match_info["board"], req.match_info["node"]
    if req.method == "GET":
        key = remake_key(host, req["user"], board, node, source)
        session = load(key)
        if session:
            update_jobs(host, key[0], session)
            refresh_export_status(session, source, host.film.FPS)
        return web.json_response(public_session(host, session, session_node=key[2]))
    data = await req.json()
    if not isinstance(data, dict):
        fail("请求格式不正确")
    key = remake_key(host, req["user"], board, node, source)
    if key in _writes:
        fail("此原片正在处理，请稍候", 409)
    _writes.add(key)
    try:
        response = {}
        session = load(key)
        action = data.get("action")
        plan_id = data.get("plan_id") if action == "apply_plan" else None
        if plan_id is not None:
            if not isinstance(plan_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", plan_id):
                fail("计划编号无效")
            if session and (receipt := session.get("remake_plans", {}).get(plan_id)):
                update_jobs(host, key[0], session)
                return web.json_response(public_session(host, session, session_node=key[2],
                    apply_plan=remake_plan_result(session, plan_id, receipt)))
        if session and data.get("cut_revision", 0) != session.get("cut_revision", 0):
            fail("剪辑点已更新，请重新打开视频重制界面", 409)
        if action == "analyze":
            if not session or not session["shots"]:
                session = {**(session or {}), **await analyze(req, host, source)}
        elif action == "prepare_playback":
            session = session or {"shots": []}
            update_jobs(host, key[0], session)
            await prepare_playback(req, host, key, session)
        elif not session or not session["shots"]:
            fail("请先分析原片")
        elif action == "retry_analysis":
            shots = session["shots"]
            await fill_shot_analysis(req, host, session, shots, [
                index for index, shot in enumerate(shots) if shot.get("analysis_missing")
            ])
        elif action == "export":
            update_jobs(host, key[0], session)
            await export_video(req, host, key, session)
        elif action == "map_person":
            set_mapping(req, board, session, data)
        elif action == "apply_plan":
            update_jobs(host, key[0], session)
            if plan_id is None:
                response[action] = await apply_remake_plan(req, host, key, session, data)
            else:
                plans = session.setdefault("remake_plans", {})
                receipt = plans[plan_id] = {"shots":data.get("shots"), "result":None}
                try:
                    response[action] = await apply_remake_plan(req, host, key, session, data)
                except web.HTTPException:
                    plans.pop(plan_id, None)
                    save(key, session)
                    raise
                receipt["result"] = response[action]
        elif action == "remove_mapping":
            activate_role_frames(session, None)
            session.pop("mapping", None)
        elif action == "batch_locate_people":
            response[action] = await batch_locate_people(req, host, session, data)
        elif action in ("batch_previews", "batch_videos"):
            update_jobs(host, key[0], session)
            response[action] = await queue_shots(req, host, key, session, data)
        elif action in CUT_ACTIONS:
            update_jobs(host, key[0], session)
            response["selected_shot"] = await edit_cuts(req, host, source, session, data)
        else:
            update_jobs(host, key[0], session)
            shot, frame = selected_frame(session, data)
            mapping = session.get("mapping")
            scoped = mapped_shots(session)
            adopting_combined = action == "approve_video" and any(
                v["job"] == data.get("job") and v.get("mode") == "combined" for v in shot.get("videos", [])
            )
            if (scoped is not None and data["shot"] not in scoped and
                    not adopting_combined and
                    action in ("preview", "approve", "generate_video", "generate_depth_video", "localize", "approve_video",
                               "locate_person", "apply_person_hint", "set_absence", "analyze_motion", "suggest_entry")):
                fail("此镜头未包含在人物映射范围内，请先确认该镜头")
            if action == "set_absence":
                absent = data.get("absent")
                if (frame is not shot["frames"]["first"] and "correction_tick" not in frame) or type(absent) is not bool:
                    fail("请在首帧或校正帧标记人物出画")
                if absent:
                    frame["person_absent"] = {"source": mapping["source"] if mapping else None}
                elif person_absent(frame, mapping):
                    frame.pop("person_absent")
            elif action in ("select", "clear_protection"):
                layer = "protection" if action == "clear_protection" else data.get("layer", "selection")
                if layer not in ("selection", "protection"):
                    fail("请选择人物选区或前景保护区")
                if layer == "protection" and frame is not shot["frames"]["first"] and "correction_tick" not in frame:
                    fail("请在首帧或校正帧标记前景保护区")
                if action == "clear_protection":
                    # A null anchor stops protection inherited from an earlier frame.
                    frame["protection"] = {"mask": None}
                else:
                    if layer == "selection" and person_absent(frame, mapping):
                        fail("请先取消人物出画标记")
                    person = mapping["source"] if mapping and data["shot"] in scoped else None
                    await select_area(req, host, frame, data, layer, source_person=person)
            elif action in ("locate_person", "apply_person_hint"):
                await locate_person(req, host, session, frame, data)
            elif action == "analyze_motion":
                await analyze_motion(req, host, source, session, shot, mapping)
            elif action == "prepare_depth":
                prepare_depth(req, host, key, session, shot)
            elif action == "suggest_entry":
                response["captured_frame"] = await suggest_entry(req, host, source, session, shot, mapping, data)
            elif action == "capture_correction":
                response["captured_frame"] = await capture_correction(host, source, shot, data.get("at"),
                                                                      display=session.get("display_oriented", False))
            elif action == "remove_correction":
                if "correction_tick" not in frame:
                    fail("请选择要移除的校正帧")
                del shot["frames"][data["frame"]]
            elif action == "preview":
                session["role"] = await generate_preview(req, host, key, frame, data, mapping)
            elif action == "approve":
                if person_absent(frame, mapping):
                    fail("请先取消人物出画标记")
                preview = completed(frame["previews"], data.get("job"))
                if not preview or not preview.get("ref"):
                    fail("请选择已完成的预览")
                if not matches_mapping(preview, mapping):
                    fail("这个预览属于之前的人物映射，请为当前角色重新生成")
                if not preview_matches_regions(frame, preview, mapping):
                    fail("此预览的选区已更新，请重新生成预览", 409)
                frame["approved"] = preview["job"]
            elif action == "clear_guide":
                if "correction_tick" not in frame:
                    fail("请选择要取消的动作关键帧")
                frame.pop("approved", None)
            elif action == "generate_video":
                await generate_shot(req, host, key, shot, data, mapping)
            elif action == "generate_depth_video":
                route = next((r for r in motion_routes(host) if r["provider"]["id"] == data.get("provider")), None)
                if not route:
                    fail("请先在控制台配置支持参考视频的 Seedance 服务", 503)
                await generate_shot(req, host, key, shot, data, mapping, motion_route=route)
            elif action == "localize":
                localize_shot(req, host, key, shot, data.get("job"), mapping, display=session.get("display_oriented", False))
            elif action in ("add_role_layer", "remove_role_layer", "move_role_layer"):
                edit_role_layers(shot, data, mapping)
            elif action == "combine_roles":
                queue_combined_roles(req, host, key, shot, display=session.get("display_oriented", False))
            elif action == "approve_video":
                await approve_video(host, shot, data.get("job"), mapping)
            elif action == "keep":
                shot["keep_original"] = True
            else:
                fail("未知的视频重制操作")
        update_jobs(host, key[0], session)
        refresh_export_status(session, source, host.film.FPS)
        session["warning"] = analysis_warning(session["shots"])
        save(key, session)
        return web.json_response(public_session(host, session, session_node=key[2], **response))
    finally:
        _writes.discard(key)
