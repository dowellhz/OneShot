"""Detect shot boundaries and analyze the original footage."""
from __future__ import annotations

from contextlib import closing
import asyncio
import json
import re

from oneshot.editing.remake_regions import (
    coordinates,
    person_absent,
    person_selection,
)
from oneshot.editing.remake_shot_plan import correction_frames
from oneshot.editing.remake_source_media import capture_correction, original_frames
from oneshot.editing.remake_state import (
    MAX_SECONDS,
    MAX_SHOTS,
    frame_record,
    person_appearance,
)
from oneshot.memory.creative_memory import fail


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


def sample_shot_frames(host, source, shot, display, offsets=None):
    from oneshot.generation.rewriter import encode_image_part
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
