"""Read and resolve canvas comments."""

import json
import re
import time
import uuid

from aiohttp import web

from oneshot.canvas import template_routes
from oneshot.memory import document_review
from oneshot.storage import db
from oneshot.web import http as http_errors


def comment_thread(bid, thread_id):
    row = db.one("SELECT * FROM canvas_comments WHERE board_id=? AND id=? AND thread_id IS NULL", bid, thread_id)
    if row is None:
        raise web.HTTPNotFound()
    return row


def comment_anchor(board, anchor):
    if anchor is None:
        return None
    if not isinstance(anchor, dict):
        raise http_errors.bad("评论位置无效")
    if "node" in anchor:
        target = next((n for n in board.get("nodes", []) if n["id"] == anchor["node"]), None)
        if target is None:
            raise http_errors.bad("评论对应的节点已不存在")
        ref = anchor.get("ref")
        version = next((v for v in target.get("versions", []) if ref and v.get("ref") == ref), None)
        if ref is not None and version is None:
            raise http_errors.bad("评论对应的素材版本已不存在")
        result = {"node":target["id"], "name":target.get("name"), "ref":ref}
        if "passage" in anchor:
            text = (target.get("data") or {}).get("text")
            if target.get("type") != "text" or not isinstance(text,str) or ref is not None:
                raise http_errors.bad("段落批注只能标注文本节点的正文")
            try:
                result["passage"] = document_review.capture(text,anchor["passage"])
            except ValueError as error:
                raise http_errors.bad(str(error)) from error
        if "box" in anchor:
            box = anchor["box"]
            if not version or target.get("type") != "image" or not isinstance(box,list) or len(box) != 4 or any(
                    type(point) not in (int,float) or not 0 <= point <= 1 for point in box):
                raise http_errors.bad("批注区域必须是对应图片版本上的有效矩形")
            box = [round(point,6) for point in box]
            if box[0] >= box[2] or box[1] >= box[3]:
                raise http_errors.bad("批注区域不能为空")
            result["box"] = box
        if "at" in anchor or "end" in anchor:
            points = [anchor.get("at")] + ([anchor["end"]] if "end" in anchor else [])
            if not version or target.get("type") not in ("video","audio") or any(
                    type(point) not in (int,float) or not 0 <= point <= 86_400 for point in points):
                raise http_errors.bad("评论时间点无效")
            duration = version.get("seconds")
            if type(duration) in (int,float) and duration > 0:
                if any(point > duration + 0.05 for point in points):
                    raise http_errors.bad("评论时间点超出素材时长")
                points = [min(point,duration) for point in points]
            points = [round(point,3) for point in points]
            result["at"] = points[0]
            if len(points) == 2:
                if points[1] <= points[0]:
                    raise http_errors.bad("批注结束时间必须晚于开始时间")
                result["end"] = points[1]
        return result
    if "box" in anchor or "passage" in anchor:
        raise http_errors.bad("区域或段落批注需要指定素材节点")
    x, y = anchor.get("x"), anchor.get("y")
    if not all(type(n) in (int, float) and abs(n) <= 1_000_000 for n in (x, y)):
        raise http_errors.bad("评论位置超出画布范围")
    return {"x":round(x, 2), "y":round(y, 2)}


def can_resolve_comment(user, board, author):
    return user["id"] in (board.get("owner"), author) or user["role"] == "admin"


async def list_comments(req):
    bid, board = template_routes.comment_board(req)
    rows = db.q("""SELECT c.*, COALESCE(NULLIF(u.name,''),u.username,'已注销用户') AS author
                   FROM canvas_comments c LEFT JOIN users u ON c.author_id=u.id
                   WHERE c.board_id=? ORDER BY created,id""", bid)
    threads = {}
    nodes = {n["id"]:n for n in board.get("nodes",[])}
    for row in rows:
        item = {k:row[k] for k in ("id", "body", "author", "created")}
        if row["thread_id"] is None:
            anchor = json.loads(row["anchor"] or "null")
            threads[row["id"]] = {**item, "anchor":document_review.visible_anchor(anchor), "resolved":bool(row["resolved"]),
                                  "can_resolve":can_resolve_comment(req["user"], board, row["author_id"]), "replies":[]}
            if anchor and (passage := anchor.get("passage")):
                node = nodes.get(anchor.get("node"))
                text = (node.get("data") or {}).get("text") if node and node.get("type") == "text" else None
                threads[row["id"]]["passage_location"] = document_review.locate(text,passage) if isinstance(text,str) else None
        elif row["thread_id"] in threads:
            threads[row["thread_id"]]["replies"].append(item)
    return web.json_response(list(threads.values())[::-1])


async def post_comment(req):
    payload = await req.json()
    bid, board = template_routes.comment_board(req)
    text = payload.get("body") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
        raise http_errors.bad("评论须为 1–2000 字")
    key = payload.get("request_key")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", key):
        raise http_errors.bad("评论请求编号无效")
    uid = req["user"]["id"]
    prior = db.one("SELECT id,thread_id FROM canvas_comments WHERE board_id=? AND author_id=? AND request_key=?", bid, uid, key)
    if prior:
        return web.json_response(prior)
    thread_id = payload.get("thread_id")
    if thread_id is not None:
        if not isinstance(thread_id, str):
            raise http_errors.bad("评论编号无效")
        if comment_thread(bid, thread_id)["resolved"]:
            raise http_errors.bad("此讨论已解决，请先重新打开")
    anchor = None if thread_id else comment_anchor(board, payload.get("anchor"))
    cid = "c" + uuid.uuid4().hex[:20]
    db.run("""INSERT INTO canvas_comments(id,board_id,thread_id,anchor,author_id,body,created,request_key)
              VALUES(?,?,?,?,?,?,?,?)""", cid, bid, thread_id, json.dumps(anchor, ensure_ascii=False), uid, text.strip(), time.time(), key)
    req.app["canvas_live"].comments_changed(bid)
    return web.json_response({"id":cid, "thread_id":thread_id}, status=201)


async def resolve_comment(req):
    payload = await req.json()
    bid, board = template_routes.comment_board(req)
    row = comment_thread(bid, req.match_info["cid"])
    if not can_resolve_comment(req["user"], board, row["author_id"]):
        raise web.HTTPForbidden()
    resolved = payload.get("resolved") if isinstance(payload, dict) else None
    if type(resolved) is not bool:
        raise http_errors.bad("评论状态无效")
    if bool(row["resolved"]) != resolved:
        db.run("UPDATE canvas_comments SET resolved=? WHERE id=?", int(resolved), row["id"])
        req.app["canvas_live"].comments_changed(bid)
    return web.json_response({"ok":True})
