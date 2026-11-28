"""Board-scoped receipts for image and video submissions that can be resumed."""

import hashlib
import json
import re
import time
import uuid

from aiohttp import web

from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta, can_edit
from oneshot.storage import db
from oneshot.web import http as http_errors


KEY = re.compile(r"[A-Za-z0-9-]{16,80}")
NODE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
INSTANCE = uuid.uuid4().hex


def scope(req, board_id, node_id, key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise http_errors.bad("生成提交编号无效")
    if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id):
        raise http_errors.bad("生成节点无效")
    board = board_meta(canvas_routes.board_path(board_id))
    if not board or not can_edit(req["user"], board):
        raise web.HTTPForbidden()
    return (req["user"]["id"], board_id, key), board


def stored_receipt(receipt):
    return db.one(
        "SELECT node_id,fingerprint,state,worker,response FROM generation_submissions "
        "WHERE user_id=? AND board_id=? AND key=?", *receipt,
    )


def update(receipt, state, data=None):
    db.run(
        "UPDATE generation_submissions SET state=?,response=? WHERE user_id=? AND board_id=? AND key=?",
        state, json.dumps(data, ensure_ascii=False) if data is not None else None, *receipt,
    )


def remember_jobs(req, result):
    receipt = req.get("canvas_generation_submission")
    if receipt and result.get("ids"):
        update(receipt, "accepted", result)


def read_generation_response(req, response):
    result = json.loads(response.body)
    remember_jobs(req, result)
    return result


def payload_fingerprint(raw):
    return hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def append_queued_job(req, ids, job_id, first_meta):
    ids.append(job_id)
    if receipt := req.get("canvas_generation_submission"):
        update(receipt, "submitting", {"ids": ids, "meta": first_meta})


async def submit(req, handler):
    key = req.headers.get("X-OneShot-Submission")
    if key is None:
        return await handler(req)
    raw = await req.json()
    if not isinstance(raw, dict) or raw.get("kind") not in ("image", "video"):
        raise http_errors.bad("请选择图片或视频生成节点")
    node_id = req.headers.get("X-OneShot-Node")
    receipt, board = scope(req, raw.get("board"), node_id, key)
    digest = payload_fingerprint(raw)
    with db.transaction():
        prior = stored_receipt(receipt)
        if not prior:
            if not any(n.get("id") == node_id and n.get("type") == raw["kind"] for n in board.get("nodes", [])):
                raise http_errors.bad("生成节点未保存或已移除")
            db.run(
                "INSERT INTO generation_submissions VALUES (?,?,?,?,?,'submitting',?,NULL,?)",
                *receipt, node_id, digest, INSTANCE, time.time(),
            )
    if prior:
        if prior["node_id"] != node_id or prior["fingerprint"] != digest:
            raise http_errors.bad("该提交编号已用于其他生成内容")
        if receipt_state(prior) == "accepted":
            return web.json_response(json.loads(prior["response"]))
        return web.json_response({"error": "该提交已有记录，请检查回执。"}, status=409)

    req["canvas_generation_submission"] = receipt
    try:
        response = await handler(req)
        if response.status >= 400:
            mark_failure(receipt, response.status)
        else:
            remember_jobs(req, json.loads(response.body))
        return response
    except web.HTTPException as error:
        mark_failure(receipt, error.status)
        raise
    finally:
        db.run(
            "UPDATE generation_submissions SET state=CASE WHEN response IS NULL THEN 'uncertain' ELSE 'accepted' END "
            "WHERE user_id=? AND board_id=? AND key=? AND state='submitting'", *receipt,
        )


def mark_failure(receipt, status):
    if 400 <= status < 500:
        db.run(
            "UPDATE generation_submissions SET state='rejected' "
            "WHERE user_id=? AND board_id=? AND key=? AND state='submitting' AND response IS NULL", *receipt,
        )


def receipt_state(row):
    if row["state"] == "submitting" and row["worker"] != INSTANCE:
        return "accepted" if row["response"] else "uncertain"
    return row["state"]


async def status(req):
    node_id = req.query.get("node")
    receipt, _ = scope(req, req.query.get("board"), node_id, req.query.get("key"))
    row = stored_receipt(receipt)
    result = {"state": "missing"}
    if row and row["node_id"] == node_id:
        state = result["state"] = receipt_state(row)
        if state == "accepted":
            result["result"] = json.loads(row["response"])
    return web.json_response(result, headers={"Cache-Control": "no-store"})
