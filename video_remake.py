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
from creative_memory import IMAGE_EXT, character_notes, fail

MAX_SECONDS = 60
MAX_SHOTS = 12
MAX_PREVIEWS = 20
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


def update_previews(host, owner, session):
    for shot in session["shots"]:
        for frame in shot["frames"].values():
            for preview in frame["previews"]:
                if preview.get("state") in ("done", "error"):
                    continue
                state, refs, error = job_status(host, owner, preview["job"])
                if state == "done":
                    ref = next((r for r in refs if isinstance(r, str) and Path(r).suffix.lower() in IMAGE_EXT), "")
                    if ref:
                        preview.update(state="done", ref=ref)
                    else:
                        preview.update(state="error", error="任务没有返回图片")
                elif state == "error":
                    preview.update(state="error", error=error or "生成失败")
                else:
                    preview["state"] = state


def frame_record(ref, dimensions):
    return {"ref": ref, "w": dimensions[0], "h": dimensions[1], "previews": []}


async def analyze(req, host, source):
    def cut_video():
        _, _, duration, _ = host.film.probe(host.tools.ref_path(host.COMFY_DIR, source))
        if not 0 < duration <= MAX_SECONDS:
            raise ValueError(f"角色替换预览支持 {MAX_SECONDS} 秒以内的原片")
        return host.tools.find_shots(host.COMFY_DIR, source, MAX_SHOTS)
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
    if any(p["state"] not in ("done", "error") for p in frame["previews"]):
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
    response = await host.generate_request(req, payload)
    ids = json.loads(response.body).get("ids") or []
    if not ids:
        fail("生成服务未返回任务编号")
    frame["previews"].append({
        "job": ids[0], "state": "queued", "mask": selection["mask"],
        "asset": {"id": asset["id"], "name": asset["name"], "view": view, "ref": reference},
    })
    return {"asset": asset["id"], "view": view}


async def handle(req, host):
    source = req.query.get("source")
    board, node = req.match_info["board"], req.match_info["node"]
    original_video(host, req["user"], board, node, source)
    key = (req["user"]["id"], board, node, source)
    if req.method == "GET":
        session = load(key)
        if session:
            update_previews(host, key[0], session)
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
        elif session:
            update_previews(host, key[0], session)
            shot, frame = selected_frame(session, data)
            if action == "select":
                await select_area(req, host, frame, data)
            elif action == "preview":
                session["role"] = await generate_preview(req, host, key, frame, data)
            elif action == "approve":
                preview = next((p for p in frame["previews"] if p["job"] == data.get("job") and p["state"] == "done"), None)
                if not preview or not preview.get("ref"):
                    fail("请选择已完成的预览")
                for item in shot["frames"].values():
                    item.pop("approved", None)
                frame["approved"] = preview["job"]
                shot["keep_original"] = False
            elif action == "keep":
                shot["keep_original"] = True
            else:
                fail("未知的视频重制操作")
        else:
            fail("请先分析原片")
        update_previews(host, key[0], session)
        save(key, session)
        return web.json_response(session)
    finally:
        _writes.discard(key)
