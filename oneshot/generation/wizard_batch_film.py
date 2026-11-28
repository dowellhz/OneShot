"""Build and render an editable rough cut from a completed shot batch."""

import asyncio
import hashlib
import json
import math
import re
from types import SimpleNamespace

from aiohttp import web

from oneshot import config
from oneshot.assistant.chat_state import InternalRequest
from oneshot.editing import timeline_routes
from oneshot.editing.render_media import probe
from oneshot.generation import jobs, tools
from oneshot.generation.media_files import FPS
from oneshot.storage import db
from oneshot.web import http as http_errors
from oneshot.web.media import media_references, require_media


def subtitle_line(line):
    if not isinstance(line, str):
        return ""
    line = line.strip()
    if not line.startswith(("“", '"', "「")):
        line = re.sub(r"^[^：:\n]{1,24}[：:]+\s*", "", line)
    return line.strip().strip('“”"「」').strip()


def plan(board, script_id, pending, selection):
    nodes = {n["id"]: n for n in board.get("nodes", [])}
    data = nodes[script_id]["data"]
    shots = data.get("shots", [])
    rows = data.get("made", [])
    links = {pair["shot_id"]: pair.get("vid") for pair in rows if pair.get("shot_id")}
    legacy = len(rows) == len(shots) and not links
    if not isinstance(selection, list) or not shots or len(selection) != len(shots):
        raise http_errors.bad("合成计划必须覆盖全部分镜")
    clips = []
    seen = set()
    for index, (shot, item) in enumerate(zip(shots, selection)):
        if not isinstance(item, dict):
            raise http_errors.bad("合成镜头格式无效")
        node_id, ref = item.get("node"), item.get("ref")
        source = nodes.get(node_id) if isinstance(node_id, str) else None
        linked = rows[index].get("vid") if legacy else links.get(shot.get("id"))
        if not source or node_id in seen or linked != node_id:
            raise http_errors.bad("合成镜头与剧本不匹配")
        if node_id in pending:
            if ref is not None:
                raise http_errors.bad("待生成镜头不能固定为其他版本")
        elif not isinstance(ref, str) or not any(v.get("ref") == ref for v in source.get("versions", [])):
            raise http_errors.bad("剪辑使用的视频版本已移除")
        duration = shot.get("duration")
        frames = max(1, math.floor(duration * FPS + .5)) if type(duration) in (int, float) and 0 < duration <= 120 else None
        clips.append({"node": node_id, "name": source.get("name"), "ref": ref, "kind": "video", "trans": "cut",
                      "in": 0, "volume": 1, "story_shot": shot.get("id") or f"index:{index}", "story_frames": frames,
                      "subs": [text for line in shot.get("dialogue", []) if (text := subtitle_line(line))],
                      "story_dialogue": shot.get("dialogue", [])})
        seen.add(node_id)
    for item in (data.get("wizard_media") or {}).get("clips", []):
        source = nodes.get(item.get("node"))
        ref = item.get("ref")
        if not source or not any(v.get("ref") == ref for v in source.get("versions", [])):
            raise http_errors.bad("剪入成片的视频版本已移除")
        clips.append({"node": source["id"], "name": source.get("name"), "ref": ref, "kind": "video",
                      "in": item.get("start"), "out": item.get("end"), "tight": True, "trans": "cut", "subs": [], "volume": 1})
    return {"clips": clips, "story_script": script_id, "story_tracking": True, "aspect": "source", "fit": "blur",
            "subtitles": True, "sub_size": 1, "titles": [], "cutaways": [], "bgm": None, "narration": [],
            "audio_clips": [], "cover": 0, "story_voices": data.get("story_voices", [])}


def save_plan(batch_id, spec):
    db.run("INSERT INTO wizard_batch_films (batch_id,plan,state,attempt) VALUES (?,?,'waiting',0)",
           batch_id, json.dumps(spec, ensure_ascii=False))


def public_film(batch_id):
    row = db.one("SELECT state, spec, job_id, error FROM wizard_batch_films WHERE batch_id=?", batch_id)
    if not row:
        return None
    if row["state"] == "done":
        row["timeline"] = json.loads(row["spec"])
    row.pop("spec")
    return row


def resolved_plan(raw, results):
    spec = json.loads(raw)
    for clip in spec["clips"]:
        ref = clip["ref"] or results.get(clip["node"])
        if not ref:
            raise ValueError("有镜头缺少视频，暂时无法合成")
        _, _, duration, _ = probe(tools.ref_path(config.COMFY_DIR, ref), display=False)
        clip.update(ref=ref, media_seconds=duration)
        if clip.get("story_frames"):
            clip["out"] = min(clip["story_frames"], math.floor(duration * FPS + 1e-6)) / FPS
            clip["tight"] = True
    return spec


async def assemble(app, batch, user, results, running):
    batch_id = batch["id"]
    row = db.one("SELECT * FROM wizard_batch_films WHERE batch_id=?", batch_id)
    if not row or row["state"] in {"done", "error"} or not running():
        return
    try:
        spec = json.loads(row["spec"]) if row["spec"] else await asyncio.to_thread(resolved_plan, row["plan"], results)
        require_media(user, media_references(spec))
        attempt = row["attempt"]
        token = hashlib.sha256(batch_id.encode()).hexdigest()
        key = f"{token}-{attempt}"
        jid = timeline_routes.film_render_job_id(user["id"], key)
        previous = db.one("SELECT state FROM tasks WHERE id=?", jid)
        if previous and previous["state"] in ("queued", "running") and jid not in jobs.JOBS:
            attempt += 1
            key = f"{token}-{attempt}"
            jid = timeline_routes.film_render_job_id(user["id"], key)
        if not running():
            return
        db.run("UPDATE wizard_batch_films SET attempt=?,state='rendering',spec=?,job_id=? WHERE batch_id=?",
               attempt, json.dumps(spec, ensure_ascii=False), jid, batch_id)
        request = InternalRequest(SimpleNamespace(app=app), user,
                                  payload={"spec": spec, "board": batch["board_id"], "request_key": key, "label": "成片"})
        result = await timeline_routes.render_film(request)
        if result.status >= 400:
            raise ValueError(json.loads(result.body).get("error", "合成失败"))
        while running():
            task = db.one("SELECT state,error,outputs FROM tasks WHERE id=?", jid)
            if task and task["state"] in ("done", "error"):
                if task["state"] != "done" or not json.loads(task["outputs"] or "[]"):
                    raise ValueError(task["error"] or "没有可用的成片")
                db.run("UPDATE wizard_batch_films SET state='done',error=NULL WHERE batch_id=?", batch_id)
                return
            await asyncio.sleep(1)
    except (ValueError, OSError, web.HTTPException) as error:
        message = error.reason if isinstance(error, web.HTTPException) else str(error)
        if isinstance(error, web.HTTPException) and error.content_type == "application/json":
            message = json.loads(error.text).get("error", message)
        db.run("UPDATE wizard_batch_films SET state='error',error=? WHERE batch_id=?", message[:500], batch_id)
