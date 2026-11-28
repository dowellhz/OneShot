"""Run a wizard screenplay draft independently of the HTTP connection."""

import asyncio
import json
import logging
import time

from aiohttp import web

from oneshot import config
from oneshot.generation import prompts, screenplay_planning, screenplay_workbench as workbench, submissions, tools
from oneshot.storage import db
from oneshot.web import http as http_errors
from oneshot.web.media import media_references, require_media


logger = logging.getLogger(__name__)


async def draft(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("story"), str) or not raw["story"].strip():
        raise http_errors.bad("先写一段剧情")
    operation = raw.get("operation")
    if operation is not None and operation not in ("outline", "write", "review", "revise", "compile"):
        raise http_errors.bad("剧本操作无效")
    key, node = raw.get("key"), raw.get("script")
    if not isinstance(key, str) or not submissions.KEY.fullmatch(key):
        raise http_errors.bad("生成提交编号无效")
    user, app = req["user"], req.app
    receipt, board = submissions.scope(req, raw.get("board"), node, "draft-" + submissions.payload_fingerprint(key))
    if not any(item.get("id") == node and item.get("type") == "script" for item in board.get("nodes", [])):
        raise http_errors.bad("剧本节点未保存或已移除")
    require_media(user, media_references(raw))
    digest = submissions.payload_fingerprint(raw)
    with db.transaction():
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
        result = await process(app, user, raw)
        submissions.update(receipt, "accepted", {"state": "done", "result": result})
    except web.HTTPException as error:
        message = json.loads(error.text).get("error", error.reason) if error.content_type == "application/json" else error.reason
        submissions.update(receipt, "rejected", {"state": "error", "error": message})
    except ValueError as error:
        submissions.update(receipt, "rejected", {"state": "error", "error": str(error)})
    except Exception:
        logger.exception("Wizard screenplay draft failed")
        submissions.update(receipt, "rejected", {"state": "error", "error": "剧本尚未生成。"})


async def process(app, user, raw):
    operation = raw.get("operation")
    if operation is None:
        return await prompts.build_storyboard(app, user, raw)
    llm = app["llm"]
    if operation in ("outline","write"):
        if not llm.available():
            raise http_errors.bad("本地 Qwen 模型还没装好")
        candidates = app["creative_memory"].storyboard_assets(user, raw["board"], raw["story"])
        content = workbench.context(config.COMFY_DIR, raw["story"], raw.get("refs") or [], raw.get("shots"),
                                    raw.get("seconds"), http_errors.clean(raw.get("style")),
                                    raw.get("aspect"), raw.get("target_seconds"), candidates)
        if operation == "outline":
            return {"outline":await screenplay_planning.outline(llm,content,tools.parse_json,raw.get("target_seconds"))}
        approved = screenplay_planning.normalize_outline(raw["outline"]) if "outline" in raw else None
        if approved:
            content.append(workbench._text({"confirmed_outline":approved}))
        if raw.get("complete_script") is True:
            content.append({"type":"text","text":"用户已提供完整剧本。只把原稿整理成场次结构，逐字保留台词，保持行动、人物、顺序及结局，不润色或补写。"})
        manuscript = await workbench.write(llm, content, tools.parse_json)
        if approved:
            manuscript["fixed"] = list(dict.fromkeys([*approved["fixed"],*manuscript["fixed"]]))[:30]
        workbench.verify_silence(raw["story"],manuscript)
        return {"manuscript": manuscript}
    manuscript = workbench.manuscript(raw.get("manuscript"))
    if operation == "compile":
        workbench.verify_silence(raw["story"],manuscript)
        async def build(feedback):
            return await prompts.build_storyboard(app,user,raw,approved_screenplay=manuscript,screenplay_feedback=feedback)
        return await screenplay_planning.compile_checked(build,llm,manuscript,tools.parse_json)
    if not llm.available():
        raise http_errors.bad("本地 Qwen 模型还没装好")
    if operation == "review":
        return {"notes": await workbench.review(llm, manuscript, tools.parse_json)}
    index = raw.get("scene")
    scene = await workbench.revise(llm, raw["story"], manuscript, index, raw.get("notes"), tools.parse_json)
    return {"scene": index, "scene_data": scene}
