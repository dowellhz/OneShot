"""Edit per-role selections, correction frames, and masks."""
from __future__ import annotations

from PIL import Image
from PIL import ImageChops
import asyncio
import json
import math
import re

from aiohttp import web

from oneshot.editing import image_editor
from oneshot.editing.remake_state import (
    MAX_SHOTS,
    mapped_shots,
    person_appearance,
)
from oneshot.memory.creative_memory import fail


def selected_frame(session, data):
    index, frame_key = data.get("shot"), data.get("frame", "first")
    if type(index) is not int or not 0 <= index < len(session["shots"]) or not isinstance(frame_key, str):
        fail("请先选择镜头和画面")
    shot = session["shots"][index]
    if frame_key not in shot["frames"]:
        fail("画面已不存在，请重新选择")
    return shot, shot["frames"][frame_key]


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
