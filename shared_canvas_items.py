"""Publish a frozen media version or a reviewed, text-only conversation excerpt."""
import hashlib
import json
import secrets
import time
from urllib.parse import quote

from aiohttp import web

import db
import public_canvas

routes = web.RouteTableDef()
TOKEN = r"{token:[A-Za-z0-9_-]{43}}"
BASE = "/api/board/{bid}/shared-items"
MAX_MESSAGES = 200
MAX_TEXT = 120000


def reply(value, status=200):
    return web.json_response(value,status=status,headers=public_canvas.HEADERS)


def unavailable():
    raise web.HTTPNotFound(headers=public_canvas.HEADERS)


def owner_board(req):
    host = req.app["shared_items_host"]
    path,board = host.board_to_share(req)
    if board.get("owner")!=req["user"]["id"]:
        raise web.HTTPForbidden(headers=public_canvas.HEADERS)
    return path.stem,board


def projection(req, bid, board, source):
    if not isinstance(source,dict):
        raise ValueError("请选择要分享的内容")
    host = req.app["shared_items_host"]
    kind = source.get("kind")
    if kind=="media":
        node_id, requested, version = source.get("node"),source.get("ref"),source.get("version")
        node = next((n for n in board.get("nodes",[]) if n.get("id")==node_id),None)
        if not isinstance(requested,str) or not node or node.get("type") not in ("image","video","audio"):
            raise ValueError("请选择图片、视频或音频版本")
        versions = node.get("versions",[])
        media_type = node["type"]
        if (type(version) is not int or not 1<=version<=len(versions) or versions[version-1].get("ref")!=requested or
                not public_canvas.media_path(host.COMFY_DIR,requested,media_type)):
            raise ValueError("该版本已移除或文件不可用")
        host.require_media(req["user"],[requested])
        return {"kind":"media","title":public_canvas.string(node.get("name"),100) or "画布作品",
                "media_type":media_type,"version":version},requested
    if kind!="conversation" or not isinstance(source.get("session"),str):
        raise ValueError("请选择一段创作对话")
    session = db.one("SELECT id,title FROM chat_sessions WHERE id=? AND board_id=? AND user_id=?",
                     source["session"],bid,req["user"]["id"])
    if not session:
        unavailable()
    recent = source.get("recent",0)
    if type(recent) is not int or recent not in (0,20,50):
        raise ValueError("请选择全部、最近 20 条或最近 50 条消息")
    rows = db.q("""SELECT kind,data FROM chat_events WHERE session_id=? AND kind IN ('user','assistant')
        ORDER BY id DESC LIMIT ?""",session["id"],recent or MAX_MESSAGES+1)
    if len(rows)>MAX_MESSAGES:
        raise ValueError("对话较长，请选择最近 20 条或 50 条")
    messages = []
    for row in reversed(rows):
        text = json.loads(row["data"]).get("text")
        if isinstance(text,str) and text.strip():
            messages.append({"role":row["kind"],"text":text})
    if not messages:
        raise ValueError("这段对话还没有可分享的消息")
    if sum(len(message["text"]) for message in messages)>MAX_TEXT:
        raise ValueError("对话文字量超过分享范围，请选择更少的消息")
    return {"kind":"conversation","title":public_canvas.string(session["title"],100) or "创作对话",
            "messages":messages},None


def fingerprint(board, data, ref):
    return hashlib.sha256(json.dumps([board,data,ref],ensure_ascii=False,sort_keys=True).encode()).hexdigest()


@routes.get(BASE)
async def list_items(req):
    bid,_ = owner_board(req)
    uid = req["user"]["id"]
    rows = db.q("SELECT token,data,created FROM shared_canvas_items WHERE board_id=? AND owner=? ORDER BY created DESC",bid,uid)
    items = [{"token":row["token"],"kind":content["kind"],"title":content["title"],"created":row["created"]}
             for row in rows if (content := json.loads(row["data"]))]
    conversations = db.q("SELECT id,title FROM chat_sessions WHERE board_id=? AND user_id=? ORDER BY updated DESC LIMIT 200",bid,uid)
    return reply({"items":items,"conversations":conversations})


async def requested_projection(req):
    body = await req.json()
    bid,board = owner_board(req)
    if not isinstance(body,dict):
        raise ValueError("请选择要分享的内容")
    data,ref = projection(req,bid,board,body.get("source"))
    return bid,body,data,ref,fingerprint(bid,data,ref)


@routes.post(BASE+"/preview")
async def preview(req):
    try:
        _,_,data,ref,digest = await requested_projection(req)
    except ValueError as error:
        return reply({"error":str(error)},400)
    return reply({**data,"digest":digest,**({"preview_url":"/media?ref="+quote(ref,safe="")} if ref else {})})


@routes.post(BASE)
async def publish(req):
    try:
        bid,body,data,ref,digest = await requested_projection(req)
    except ValueError as error:
        return reply({"error":str(error)},400)
    if body.get("confirmed") is not True:
        return reply({"error":"请确认公开分享所选内容"},400)
    if body.get("digest")!=digest:
        return reply({"error":"内容已变化，请重新检查预览"},409)
    uid = req["user"]["id"]
    with db.transaction():
        existing = db.one("SELECT token FROM shared_canvas_items WHERE board_id=? AND owner=? AND digest=?",bid,uid,digest)
        if existing:
            return reply(existing)
        if db.one("SELECT count(*) AS n FROM shared_canvas_items WHERE board_id=? AND owner=?",bid,uid)["n"]>=100:
            return reply({"error":"分享链接数量已达上限，请先撤销旧链接"},409)
        token = secrets.token_urlsafe(32)
        db.run("INSERT INTO shared_canvas_items VALUES(?,?,?,?,?,?,?)",token,bid,uid,digest,
               json.dumps(data,ensure_ascii=False),ref,time.time())
    return reply({"token":token},201)


@routes.delete(BASE+"/"+TOKEN)
async def withdraw(req):
    bid,_ = owner_board(req)
    db.run("DELETE FROM shared_canvas_items WHERE board_id=? AND owner=? AND token=?",
           bid,req["user"]["id"],req.match_info["token"])
    return reply({"ok":True})


def published(req):
    host = req.app["shared_items_host"]
    item = db.one("SELECT * FROM shared_canvas_items WHERE token=?",req.match_info["token"])
    if not item:
        unavailable()
    board = host.board_meta(host.board_path(item["board_id"]))
    if not board or board.get("owner")!=item["owner"]:
        unavailable()
    return item,json.loads(item["data"])


@routes.get("/shared-item/"+TOKEN)
async def page(req):
    published(req)
    headers = {**public_canvas.HEADERS,"Content-Security-Policy":
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}
    return web.FileResponse(req.app["shared_items_host"].ROOT/"static/shared-item.html",headers=headers)


@routes.get("/api/shared-item/"+TOKEN)
async def detail(req):
    item,data = published(req)
    result = {**data,"created":item["created"]}
    if item["media_ref"]:
        result["media_url"] = "/api/shared-item/"+item["token"]+"/media"
    return reply(result)


@routes.get("/api/shared-item/"+TOKEN+"/media")
async def media(req):
    item,data = published(req)
    if not item["media_ref"]:
        unavailable()
    path = public_canvas.media_path(req.app["shared_items_host"].COMFY_DIR,item["media_ref"],data["media_type"])
    if not path:
        unavailable()
    return web.FileResponse(path,headers=public_canvas.HEADERS)


def install(app,host):
    app["shared_items_host"] = host
    app.add_routes(routes)
