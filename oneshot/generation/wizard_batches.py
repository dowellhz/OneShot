"""Persist and run the ready video shots of an Idea to Film project."""

import asyncio
import hashlib
import json
import logging
import time

from aiohttp import web

from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta, can_edit
from oneshot.generation import jobs, requests, submissions, wizard_batch_film
from oneshot.storage import db
from oneshot.web import http as http_errors
from oneshot.web.media import media_references, require_media


logger = logging.getLogger(__name__)
TERMINAL = {"done", "error", "uncertain"}


class BatchRequest(dict):
    def __init__(self, app, user, *, payload=None, headers=None, query=None):
        super().__init__(user=user)
        self.app = app
        self.payload = payload
        self.headers = headers or {}
        self.query = query or {}

    async def json(self):
        return self.payload


def authorized_board(user, bid):
    board = board_meta(canvas_routes.board_path(bid))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden()
    return board


def batch_record(user, bid, batch_id):
    if not isinstance(batch_id, str) or not submissions.KEY.fullmatch(batch_id):
        raise http_errors.bad("视频批次编号无效")
    authorized_board(user, bid)
    return db.one(
        "SELECT * FROM wizard_video_batches WHERE id=? AND board_id=? AND user_id=?",
        batch_id, bid, user["id"],
    )


def entries(batch_id):
    return db.q("SELECT * FROM wizard_video_steps WHERE batch_id=? ORDER BY position", batch_id)


def public_batch(batch):
    steps = entries(batch["id"])
    result = {
        "state": batch["state"],
        "entries": [
            {"node": row["node_id"], "state": row["state"], "error": row["error"],
             "result": json.loads(row["result"]) if row["result"] else None}
            for row in steps
        ],
    }
    if film := wizard_batch_film.public_film(batch["id"]):
        result["film"] = film
    return result


def checked_entries(raw, board, script_id, bid, *, assembly=False):
    nodes = {node.get("id"): node for node in board.get("nodes", [])}
    script = nodes.get(script_id)
    if not script or script.get("type") != "script":
        raise http_errors.bad("制作剧本不存在")
    allowed = {pair.get("vid") for pair in script.get("data", {}).get("made", [])}
    if not isinstance(raw, list) or not (0 if assembly else 1) <= len(raw) <= 40:
        raise http_errors.bad("请选择 1 到 40 个镜头")
    checked, used_nodes, used_keys = [], set(), set()
    for item in raw:
        if not isinstance(item, dict):
            raise http_errors.bad("镜头生成设置无效")
        node, key, payload = (item.get(field) for field in ("node", "key", "payload"))
        if (not isinstance(node, str) or node not in allowed or node in used_nodes or
                nodes.get(node, {}).get("type") != "video" or nodes[node].get("job") or
                not isinstance(key, str) or not submissions.KEY.fullmatch(key) or key in used_keys or
                not isinstance(payload, dict) or payload.get("kind") != "video" or payload.get("board") != bid):
            raise http_errors.bad("镜头未保存、正在生成或不属于该剧本")
        used_nodes.add(node)
        used_keys.add(key)
        checked.append((node, key, payload))
    return checked


async def start(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("script"), str):
        raise http_errors.bad("制作请求格式无效")
    user = req["user"]
    bid, batch_id = raw.get("board"), raw.get("id")
    prior = batch_record(user, bid, batch_id)
    assembly = raw.get("assembly")
    inputs = [raw["script"], raw.get("entries")]
    if assembly is not None:
        inputs.append(assembly)
    canonical = json.dumps(inputs, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    if prior:
        if prior["fingerprint"] != fingerprint:
            raise http_errors.bad("视频批次的输入已变化")
    else:
        board = authorized_board(user, bid)
        checked = checked_entries(raw.get("entries"), board, raw["script"], bid, assembly=assembly is not None)
        film = wizard_batch_film.plan(board, raw["script"], {n for n, _, _ in checked}, assembly) if assembly is not None else None
        if film:
            require_media(user, media_references(film))
        for _, _, payload in checked:
            require_media(user, media_references(payload))
        if db.one("SELECT 1 FROM wizard_video_batches WHERE id=?", batch_id):
            raise web.HTTPConflict()
        with db.transaction():
            placeholders = ",".join("?" for _ in checked)
            overlap = db.one(
                "SELECT 1 FROM wizard_video_steps s JOIN wizard_video_batches b ON b.id=s.batch_id "
                "WHERE b.board_id=? AND b.state IN ('running','paused') AND s.state IN ('waiting','running') "
                f"AND s.node_id IN ({placeholders}) LIMIT 1", bid, *(node for node, _, _ in checked),
            )
            if overlap:
                raise web.HTTPConflict(text="镜头已在另一批制作任务中")
            db.run("INSERT INTO wizard_video_batches VALUES (?,?,?,?,?,'running',?)",
                   batch_id, bid, user["id"], raw["script"], fingerprint, time.time())
            for index, (node, key, payload) in enumerate(checked):
                db.run("INSERT INTO wizard_video_steps VALUES (?,?,?,?,?,'waiting',NULL,NULL)",
                       batch_id, index, node, key, json.dumps(payload, ensure_ascii=False))
            if film:
                wizard_batch_film.save_plan(batch_id, film)
    launch(req.app, batch_id)
    return web.json_response(public_batch(batch_record(user, bid, batch_id)))


async def status(req):
    batch = batch_record(req["user"], req.query.get("board"), req.match_info["batch_id"])
    if not batch:
        raise web.HTTPNotFound()
    return web.json_response(public_batch(batch), headers={"Cache-Control": "no-store"})


async def set_paused(req):
    raw = await req.json()
    if not isinstance(raw, dict) or type(raw.get("paused")) is not bool:
        raise http_errors.bad("请选择暂停或继续")
    batch = batch_record(req["user"], raw.get("board"), req.match_info["batch_id"])
    if not batch:
        raise web.HTTPNotFound()
    if batch["state"] != "done":
        db.run("UPDATE wizard_video_batches SET state=? WHERE id=?",
               "paused" if raw["paused"] else "running", batch["id"])
        if not raw["paused"]:
            launch(req.app, batch["id"])
    return web.json_response({"ok": True})


def is_running(batch_id):
    row = db.one("SELECT state FROM wizard_video_batches WHERE id=?", batch_id)
    return row and row["state"] == "running"


def set_step(step, state, *, result=None, error=None):
    db.run("UPDATE wizard_video_steps SET state=?, result=COALESCE(?,result), error=? WHERE batch_id=? AND position=?",
           state, json.dumps(result, ensure_ascii=False) if result is not None else None, error,
           step["batch_id"], step["position"])


async def submit_step(app, batch, step, user):
    payload = json.loads(step["payload"])
    require_media(user, media_references(payload))
    receipt = (user["id"], batch["board_id"], step["submission_key"])
    prior = submissions.stored_receipt(receipt)
    if prior and (prior["node_id"] != step["node_id"] or prior["fingerprint"] != submissions.payload_fingerprint(payload)):
        set_step(step, "error", error="该提交编号已用于其他生成内容")
        return None
    if prior and submissions.receipt_state(prior) == "accepted":
        return json.loads(prior["response"])
    if prior and submissions.receipt_state(prior) in ("uncertain", "submitting"):
        set_step(step, "uncertain", error="提交状态不明，请先在任务中心核对。")
        return None
    request = BatchRequest(app, user, payload=payload, headers={
        "X-OneShot-Submission": step["submission_key"], "X-OneShot-Node": step["node_id"],
    })
    try:
        response = await submissions.submit(request, requests.generate_canvas_request)
        result = json.loads(response.body)
        if response.status < 400 and result.get("ids"):
            return result
        error = result.get("error", "视频提交失败")
    except web.HTTPException as exc:
        error = exc.reason
        if exc.content_type == "application/json":
            error = json.loads(exc.text).get("error", error)
    except Exception:
        logger.exception("Wizard video submission failed for batch %s", batch["id"])
        error = "视频提交失败"
    prior = submissions.stored_receipt(receipt)
    state = submissions.receipt_state(prior) if prior else "missing"
    if state == "accepted":
        return json.loads(prior["response"])
    set_step(step, "uncertain" if state in ("uncertain", "submitting") else "error", error=error)
    return None


async def follow_step(app, batch, step, user, result):
    set_step(step, "running", result=result)
    ids = result["ids"]
    req = BatchRequest(app, user, query={"ids": ",".join(ids)})
    while is_running(batch["id"]):
        response = await jobs.jobs(req)
        states = json.loads(response.body)
        if all(states.get(jid, {}).get("state") in ("done", "error") for jid in ids):
            outputs = [item["ref"] for jid in ids for item in states[jid].get("outputs") or [] if item.get("ref")]
            if outputs:
                set_step(step, "done", result={**result, "selected_ref": outputs[-1]})
            else:
                error = next((states[jid]["error"] for jid in ids if states[jid].get("error")), "没有可用的视频结果")
                set_step(step, "error", error=error)
            return
        await asyncio.sleep(1.5)


async def run(app, batch_id):
    batch = db.one("SELECT * FROM wizard_video_batches WHERE id=?", batch_id)
    for step in entries(batch_id):
        if not is_running(batch_id):
            return
        if step["state"] in TERMINAL:
            continue
        user = db.one("SELECT id,role FROM users WHERE id=? AND disabled=0", batch["user_id"])
        try:
            if not user:
                raise web.HTTPForbidden()
            authorized_board(user, batch["board_id"])
            result = json.loads(step["result"]) if step["result"] else await submit_step(app, batch, step, user)
            if result:
                await follow_step(app, batch, step, user, result)
        except web.HTTPForbidden:
            set_step(step, "error", error="项目访问权限已变化")
        except Exception:
            logger.exception("Unable to track wizard video batch %s", batch_id)
            db.run("UPDATE wizard_video_batches SET state='paused' WHERE id=?", batch_id)
            return
    if is_running(batch_id):
        try:
            user = db.one("SELECT id,role FROM users WHERE id=? AND disabled=0", batch["user_id"])
            if user:
                authorized_board(user, batch["board_id"])
                refs = {step["node_id"]: json.loads(step["result"]).get("selected_ref")
                        for step in entries(batch_id) if step["state"] == "done"}
                await wizard_batch_film.assemble(app, batch, user, refs, lambda: is_running(batch_id))
        except web.HTTPForbidden:
            pass
        except Exception:
            logger.exception("Unable to assemble wizard video batch %s", batch_id)
            db.run("UPDATE wizard_video_batches SET state='paused' WHERE id=?", batch_id)
            return
        if is_running(batch_id):
            db.run("UPDATE wizard_video_batches SET state='done' WHERE id=?", batch_id)


def launch(app, batch_id):
    workers = app.setdefault("wizard_video_workers", {})
    if batch_id in workers or not is_running(batch_id):
        return
    task = workers[batch_id] = asyncio.create_task(run(app, batch_id))

    def release(finished):
        workers.pop(batch_id, None)
        if not finished.cancelled() and finished.exception() is None and is_running(batch_id):
            launch(app, batch_id)

    task.add_done_callback(release)


def recover(app):
    for row in db.q("SELECT id FROM wizard_video_batches WHERE state='running'"):
        launch(app, row["id"])


async def stop(app):
    workers = tuple(app.get("wizard_video_workers", {}).values())
    for task in workers:
        task.cancel()
    await asyncio.gather(*workers, return_exceptions=True)
