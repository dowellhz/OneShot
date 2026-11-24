"""Publish and read public canvas snapshots."""

import json
import secrets
import time
import uuid

from aiohttp import web

from oneshot import config
from oneshot.assistant import agent_chat
from oneshot.canvas import public_canvas
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


async def board_snapshot_status(req):
    path, _ = canvas_routes.board_to_share(req)
    row = db.one("SELECT token,created FROM canvas_snapshots WHERE board_id=?", path.stem)
    return web.json_response(row, headers=public_canvas.HEADERS)


async def publish_board_snapshot(req):
    path, board = canvas_routes.board_to_share(req)
    current = db.one("SELECT token,created FROM canvas_snapshots WHERE board_id=?", path.stem)
    if current:
        return web.json_response(current, headers=public_canvas.HEADERS)
    snapshot = public_canvas.capture(board, config.COMFY_DIR)
    token, created = secrets.token_urlsafe(32), time.time()
    db.run("INSERT INTO canvas_snapshots VALUES(?,?,?,?)", path.stem, token, json.dumps(snapshot, ensure_ascii=False), created)
    return web.json_response({"token":token,"created":created}, status=201, headers=public_canvas.HEADERS)


async def revoke_board_snapshot(req):
    path, _ = canvas_routes.board_to_share(req)
    db.run("DELETE FROM canvas_snapshots WHERE board_id=?", path.stem)
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)


def require_snapshot_board(row):
    if not row or not canvas_routes.board_path(row["board_id"]).is_file():
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)


def read_public_snapshot(token):
    row = public_snapshot_row(token)
    require_snapshot_board(row)
    return json.loads(row["data"]), row["created"]


def public_snapshot_row(token):
    return db.one("""SELECT board_id,data,created FROM canvas_snapshots WHERE token=?
                     UNION ALL SELECT board_id,snapshot,published FROM showcase_entries
                     WHERE token=? AND state='approved' AND snapshot IS NOT NULL""", token, token)


def snapshot_page_file():
    headers = {**public_canvas.HEADERS,
               "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
    return web.FileResponse(config.ROOT / "static" / "public-canvas.html", headers=headers)


async def public_snapshot_page(req):
    require_snapshot_board(public_snapshot_row(req.match_info["token"]))
    return snapshot_page_file()


async def public_snapshot_data(req):
    snapshot, created = read_public_snapshot(req.match_info["token"])
    snapshot.pop("media")
    return web.json_response({**snapshot,"created":created}, headers=public_canvas.HEADERS)


async def public_snapshot_media(req):
    snapshot, _ = read_public_snapshot(req.match_info["token"])
    return snapshot_media_file(snapshot,int(req.match_info["index"]))


def snapshot_media_file(snapshot,index):
    refs = snapshot["media"]
    path = public_canvas.media_path(config.COMFY_DIR, refs[index]) if index < len(refs) else None
    if not path:
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)
    return web.FileResponse(path, headers=public_canvas.HEADERS)


def ensure_snapshot_copy(token,snapshot,user):
    existing = db.one("SELECT board_id FROM canvas_snapshot_copies WHERE token=? AND user_id=?", token, user["id"])
    if existing:
        prior = board_meta(canvas_routes.board_path(existing["board_id"]))
        if prior.get("owner") == user["id"]:
            return existing["board_id"], False
    bid = "b" + uuid.uuid4().hex[:20]
    media_routes.grant_media(user,*snapshot["media"])
    canvas_routes.write_board(canvas_routes.board_path(bid), public_canvas.copy_board(snapshot,user["id"]))
    db.run("INSERT OR REPLACE INTO canvas_snapshot_copies VALUES(?,?,?)", token, user["id"], bid)
    return bid, True


async def copy_public_snapshot(req):
    if req.content_type != "application/json":
        raise http_errors.bad("请求格式无效")
    token, user = req.match_info["token"], req["user"]
    snapshot, _ = read_public_snapshot(token)
    bid, created = ensure_snapshot_copy(token,snapshot,user)
    response = {"id":bid}
    if req.path.endswith("/explain"):
        try:
            response["session"] = req.app["agent_chat"].explain_snapshot(user,bid,public_canvas.explanation_context(snapshot))
        except agent_chat.ToolError as error:
            return auth.err(409,str(error))
    return web.json_response(response,status=201 if created else 200,headers=public_canvas.HEADERS)
