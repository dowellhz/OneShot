"""Run a wizard screenplay draft independently of the HTTP connection."""

import asyncio
import json
import logging
import time

from aiohttp import web

from oneshot.generation import prompts, submissions
from oneshot.storage import db
from oneshot.web import http as http_errors
from oneshot.web.media import media_references, require_media


logger = logging.getLogger(__name__)


async def draft(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("story"), str) or not raw["story"].strip():
        raise http_errors.bad("先写一段剧情")
    key, node = raw.get("key"), raw.get("script")
    if not isinstance(key, str) or not submissions.KEY.fullmatch(key):
        raise http_errors.bad("生成提交编号无效")
    user, app = req["user"], req.app
    receipt, board = submissions.scope(req, raw.get("board"), node, "draft-" + submissions.payload_fingerprint(key))
    if not any(item.get("id") == node and item.get("type") == "script" for item in board.get("nodes", [])):
        raise http_errors.bad("剧本节点未保存或已移除")
    require_media(user, media_references(raw))
    digest = submissions.payload_fingerprint(raw)
    prior = submissions.stored_receipt(receipt)
    if prior:
        if prior["node_id"] != node or prior["fingerprint"] != digest:
            raise http_errors.bad("该提交编号已用于其他生成内容")
        if prior["state"] in ("accepted", "rejected"):
            return web.json_response(json.loads(prior["response"]))
        if prior["worker"] == submissions.INSTANCE:
            return web.json_response({"state": "running"})
        db.run("UPDATE generation_submissions SET worker=? WHERE user_id=? AND board_id=? AND key=?",
               submissions.INSTANCE, *receipt)
    else:
        db.run("INSERT INTO generation_submissions VALUES (?,?,?,?,?,'submitting',?,NULL,?)",
               *receipt, node, digest, submissions.INSTANCE, time.time())
    if "remote_tasks" not in app:
        app["remote_tasks"] = set()
    task = asyncio.create_task(run(app, dict(user), raw, receipt))
    app["remote_tasks"].add(task)
    task.add_done_callback(app["remote_tasks"].discard)
    return web.json_response({"state": "running"})


async def run(app, user, raw, receipt):
    try:
        result = await prompts.build_storyboard(app, user, raw)
        submissions.update(receipt, "accepted", {"state": "done", "result": result})
    except web.HTTPException as error:
        message = json.loads(error.text).get("error", error.reason) if error.content_type == "application/json" else error.reason
        submissions.update(receipt, "rejected", {"state": "error", "error": message})
    except Exception:
        logger.exception("Wizard screenplay draft failed")
        submissions.update(receipt, "rejected", {"state": "error", "error": "剧本尚未生成。"})
