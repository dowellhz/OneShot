"""Public showcase and moderation endpoints."""

import asyncio
import hashlib
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from pathlib import Path

from aiohttp import web
from PIL.Image import DecompressionBombError

from oneshot import config
from oneshot.canvas import creative_events
from oneshot.canvas import public_canvas
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import sharing as canvas_sharing
from oneshot.canvas import showcase
from oneshot.canvas.board_store import board_meta
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


SHOWCASE_FIELDS = """s.token,s.title,s.description,s.published,s.snapshot IS NOT NULL AS has_canvas,
                     CASE WHEN s.video_ref LIKE '%.gif' THEN 'gif' ELSE 'video' END AS media_kind,
                     COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS author"""


SHOWCASE_PAGE_SIZE = 24


SHOWCASE_PROMPT_LIMIT = 5000


async def showcase_page(req):
    headers = {**public_canvas.HEADERS,
               "Content-Security-Policy":"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"}
    return web.FileResponse(config.ROOT / "static" / "showcase.html", headers=headers)


def showcase_offset(req):
    page = req.query.get("page","1")
    if not re.fullmatch(r"[1-9][0-9]{0,3}",page):
        raise http_errors.bad("页码无效")
    return (int(page)-1)*SHOWCASE_PAGE_SIZE


def showcase_public_items(req, creator=None):
    search = req.query.get("q","").strip()[:80]
    kind = req.query.get("kind","")
    if kind not in ("","video","gif"):
        raise http_errors.bad("作品类型无效")
    filter_kind = {"":"", "video":"AND s.video_ref NOT LIKE '%.gif'", "gif":"AND s.video_ref LIKE '%.gif'"}[kind]
    filter_creator = "AND c.slug=?" if creator else ""
    args = [search,creator] if creator else [search]
    rows = db.q(f"""SELECT {SHOWCASE_FIELDS},c.slug AS creator FROM showcase_entries s
                    JOIN users u ON u.id=s.owner JOIN showcase_creators c ON c.owner=s.owner
                    WHERE s.state='approved' AND instr(lower(s.title||' '||s.description||' '||
                      COALESCE(u.name,'')),lower(?)) > 0 {filter_creator} {filter_kind}
                    ORDER BY s.published DESC,s.token LIMIT ? OFFSET ?""",
                *args,SHOWCASE_PAGE_SIZE+1,showcase_offset(req))
    return {"items":rows[:SHOWCASE_PAGE_SIZE],"more":len(rows)>SHOWCASE_PAGE_SIZE}


async def showcase_feed(req):
    return web.json_response(showcase_public_items(req), headers=public_canvas.HEADERS)


async def showcase_creator(req):
    slug = req.match_info["slug"]
    profile = db.one("""SELECT COALESCE(NULLIF(u.name,''),'OneShot 创作者') AS name
                       FROM showcase_creators c JOIN users u ON u.id=c.owner WHERE c.slug=?
                       AND EXISTS (SELECT 1 FROM showcase_entries s WHERE s.owner=c.owner AND s.state='approved')""",slug)
    if not profile:
        return auth.err(404,"创作者主页尚未公开")
    return web.json_response({**showcase_public_items(req,slug),"name":profile["name"]}, headers=public_canvas.HEADERS)


async def showcase_my_entries(req):
    uid = req["user"]["id"]
    rows = db.q("""SELECT token,board_id,title,description,state,reason FROM showcase_entries
                   WHERE owner=? ORDER BY submitted DESC,token LIMIT ? OFFSET ?""",
                uid,SHOWCASE_PAGE_SIZE+1,showcase_offset(req))
    creator = db.one("""SELECT slug FROM showcase_creators c WHERE owner=?
                       AND EXISTS (SELECT 1 FROM showcase_entries s WHERE s.owner=c.owner AND s.state='approved')""",uid)
    return web.json_response({"items":rows[:SHOWCASE_PAGE_SIZE],"more":len(rows)>SHOWCASE_PAGE_SIZE,
                              "creator":creator["slug"] if creator else None}, headers=public_canvas.HEADERS)


async def showcase_detail(req):
    row = db.one(f"""SELECT {SHOWCASE_FIELDS},c.slug AS creator FROM showcase_entries s
                     JOIN users u ON u.id=s.owner JOIN showcase_creators c ON c.owner=s.owner
                     WHERE s.token=? AND s.state='approved'""", req.match_info["token"])
    if not row:
        raise web.HTTPNotFound(headers=public_canvas.HEADERS)
    template = db.one("""SELECT t.id,t.name FROM showcase_template_links l
                         JOIN showcase_entries s ON s.token=l.token AND s.state='approved'
                         JOIN canvas_templates t ON t.id=l.template_id AND t.owner=s.owner
                         JOIN canvas_template_publications p ON p.template_id=t.id WHERE l.token=?""",row["token"])
    if template:
        row["template"] = template
    if prompt := db.one("SELECT prompt FROM showcase_prompts WHERE token=?", row["token"]):
        row["prompt"] = prompt["prompt"]
    return web.json_response(row, headers=public_canvas.HEADERS)


async def use_showcase_prompt(req):
    try:
        data = await req.json()
    except (ValueError, UnicodeError):
        raise http_errors.bad("请求格式不正确") from None
    key = data.get("request_key") if isinstance(data,dict) else None
    if not isinstance(key,str) or not re.fullmatch(r"[\w-]{16,80}",key,re.ASCII):
        raise http_errors.bad("创作草稿编号无效")
    uid, token = req["user"]["id"], req.match_info["token"]
    source = db.one("""SELECT s.title,p.prompt FROM showcase_entries s JOIN showcase_prompts p ON p.token=s.token
                       WHERE s.token=? AND s.state='approved'""",token)
    if not source:
        return auth.err(404,"此作品的提示词已撤回或尚未公开")
    digest = hashlib.sha256(f"showcase-prompt:{uid}:{token}:{key}".encode()).hexdigest()
    bid = "b" + digest[:20]
    path = canvas_routes.board_path(bid)
    if path.is_file():
        if board_meta(path).get("owner") != uid:
            raise web.HTTPConflict()
        return web.json_response({"id":bid},headers=public_canvas.HEADERS)
    draft = {"name":("新作 · "+source["title"])[:80],"owner":uid,"rev":1,"seq":2,
             "nodes":[{"id":"n1","type":"video","name":"视频草稿","x":80,"y":90,
                       "versions":[],"cur":-1,"job":None,"data":{"prompt":source["prompt"],"pmode":"free"}}],
             "edges":[],"groups":[],"view":{"x":0,"y":0,"k":1}}
    canvas_routes.write_board(path, draft)
    return web.json_response({"id":bid},status=201,headers=public_canvas.HEADERS)


def showcase_media(req, state):
    asset = req.match_info["asset"]
    cover = asset == "cover"
    column = "cover" if cover else "video_ref"
    row = db.one(f"SELECT {column} FROM showcase_entries WHERE token=? AND state=?",
                 req.match_info["token"], state)
    if row:
        if cover:
            return web.Response(body=row["cover"], content_type="image/jpeg", headers=public_canvas.HEADERS)
        ref = row["video_ref"]
        path = showcase.work_path(config.COMFY_DIR,ref) if ref.endswith(".gif") == (asset=="gif") else None
        if path:
            return web.FileResponse(path, headers=public_canvas.HEADERS)
    raise web.HTTPNotFound(headers=public_canvas.HEADERS)


async def showcase_public_media(req):
    return showcase_media(req,"approved")


async def board_showcase(req):
    path, _ = canvas_routes.board_to_share(req)
    rows = db.q("""SELECT s.token,s.title,s.state,s.reason,s.owner=? AS can_link_template,
                          EXISTS(SELECT 1 FROM showcase_prompts q WHERE q.token=s.token) AS has_prompt,
                          l.template_id,t.name AS template_name,p.published AS template_published
                   FROM showcase_entries s LEFT JOIN showcase_template_links l ON l.token=s.token
                   LEFT JOIN canvas_templates t ON t.id=l.template_id
                   LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                   WHERE s.board_id=? ORDER BY s.submitted DESC,s.token""", req["user"]["id"],path.stem)
    return web.json_response(rows, headers=public_canvas.HEADERS)


async def submit_showcase(req):
    path, board = canvas_routes.board_to_share(req)
    if req.content_type != "multipart/form-data":
        return await store_showcase(req,path,board,await req.json(),{})
    folder = config.COMFY_DIR / "showcase"
    folder.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".upload-",dir=folder) as temporary:
        try:
            payload, files = await showcase.read_upload(req,Path(temporary),path.stem)
        except (ValueError,UnicodeError) as error:
            raise http_errors.bad(str(error) if not isinstance(error,json.JSONDecodeError) else "作品信息格式不正确") from None
        except web.HTTPRequestEntityTooLarge:
            return auth.err(413,"成片最多 300 MB，封面最多 20 MB")
        return await store_showcase(req,path,board,payload,files)


async def store_showcase(req, path, board, payload, files):
    if not isinstance(payload,dict):
        raise http_errors.bad("请填写作品信息")
    title, description = payload.get("title"), payload.get("description","")
    prompt = payload.get("public_prompt")
    attach = payload.get("attach_canvas",False)
    source, cover = payload.get("video"), payload.get("cover")
    video_file, cover_file = files.get("video"), files.get("cover")
    gif_ref = payload.get("gif_ref")
    if gif_ref is not None and (not isinstance(gif_ref,str) or not showcase.EXPORTED_GIF.fullmatch(gif_ref)):
        raise http_errors.bad("请选择已生成的 GIF")
    if sum(value is not None for value in (video_file,source,gif_ref)) != 1 or cover_file and cover is not None:
        raise http_errors.bad("请选择一个作品来源和一个封面来源")
    if (not isinstance(title,str) or not 1 <= len(title.strip()) <= 80
            or not isinstance(description,str) or len(description.strip()) > 500
            or type(attach) is not bool or payload.get("confirmed") is not True
            or not all(isinstance(asset,dict) and isinstance(asset.get("node"),str)
                       and isinstance(asset.get("ref"),str) for asset in (source,cover) if asset is not None)):
        raise http_errors.bad("请确认发布，并填写有效的作品标题、简介与素材")
    if prompt is not None and (not isinstance(prompt,str) or not 1 <= len(prompt.strip()) <= SHOWCASE_PROMPT_LIMIT):
        raise http_errors.bad("公开提示词应为 1–5000 字")
    if payload.get("revision") != board.get("rev"):
        return auth.err(409,"画布已更新，请重新选择要发布的版本")
    uid = req["user"]["id"]
    template = payload.get("template")
    validate_showcase_template(template,uid)
    event = None
    if "event" in payload:
        event = creative_events.find_event(creative_events.field(payload,"event",21,required=True))
        track = creative_events.field(payload,"track",60)
        creative_events.validate_submission(event,uid,track)
    try:
        index = showcase.find_version(board,"video",source["node"],source["ref"]) if source else None
        if cover is not None:
            showcase.find_version(board,"image",cover["node"],cover["ref"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None
    node_id = ""
    if video_file:
        video_path, video_ref = video_file
    elif gif_ref:
        video_ref = gif_ref
        video_path = showcase.work_path(config.COMFY_DIR,gif_ref)
    else:
        video_ref, node_id = source["ref"],source["node"]
        video_path = public_canvas.media_path(config.COMFY_DIR,video_ref,"video")
    cover_path = cover_file[0] if cover_file else public_canvas.media_path(config.COMFY_DIR,cover["ref"],"image") if cover else None
    if not video_path or video_path.stat().st_size > showcase.VIDEO_LIMIT or cover and not cover_path:
        raise http_errors.bad("请使用可读取的作品文件（最多 300 MB）和封面")
    snapshot = showcase.capture(board,config.COMFY_DIR,node_id,index) if attach else None
    refs = set(snapshot["media"]) if snapshot else set()
    if not video_file:
        refs.add(video_ref)
    if cover:
        refs.add(cover["ref"])
    media_routes.require_media(req["user"],refs)
    if event:
        if video_ref.endswith(".gif"):
            raise http_errors.bad("创作活动投稿需要视频作品")
        await creative_events.validate_video(event,video_path)
    try:
        jpg = await asyncio.to_thread(showcase.cover_jpeg,video_path,cover_path,check_video=bool(video_file))
    except (OSError,ValueError,IndexError,DecompressionBombError) as error:
        raise http_errors.bad("无法读取作品或封面，请检查文件格式") from error
    _, current = canvas_routes.board_to_share(req)
    if current.get("rev") != board.get("rev"):
        return auth.err(409,"画布已更新，请重新选择要发布的版本")
    destination = showcase.upload_path(config.COMFY_DIR,video_ref) if video_file else None
    if destination and not destination.exists():
        os.replace(video_path,destination)
    try:
        with db.transaction():
            validate_showcase_template(template,uid)
            row = insert_showcase(path.stem,uid,node_id,video_ref,title.strip(),description.strip(),jpg,snapshot,template,
                                  prompt=prompt.strip() if prompt else None)
            if event:
                row["event_entry"], _ = creative_events.store_entry(event,uid,row["token"],track)
    except Exception:
        discard_showcase_video(video_ref)
        raise
    return web.json_response(row, status=201, headers=public_canvas.HEADERS)


def insert_showcase(bid,uid,node_id,video_ref,title,description,jpg,snapshot,template=None,*,prompt=None):
    token = secrets.token_urlsafe(32)
    changed = db.one("""INSERT INTO showcase_entries
              (token,board_id,owner,node_id,video_ref,cover,title,description,state,submitted,snapshot)
              VALUES(?,?,?,?,?,?,?,?,'pending',?,?)
              ON CONFLICT(board_id,node_id,video_ref) DO UPDATE SET cover=excluded.cover,title=excluded.title,
                description=excluded.description,state='pending',reason='',submitted=excluded.submitted,
                snapshot=excluded.snapshot WHERE showcase_entries.state='rejected'
              RETURNING token,title,state,reason""",
           token,bid,uid,node_id,video_ref,jpg,title,description,time.time(),
           json.dumps(snapshot,ensure_ascii=False) if snapshot else None)
    if changed:
        set_showcase_template(changed["token"],template)
        if prompt:
            db.run("""INSERT INTO showcase_prompts VALUES(?,?) ON CONFLICT(token)
                      DO UPDATE SET prompt=excluded.prompt""", changed["token"],prompt)
        else:
            db.run("DELETE FROM showcase_prompts WHERE token=?",changed["token"])
        return changed
    return db.one("SELECT token,title,state,reason FROM showcase_entries WHERE board_id=? AND node_id=? AND video_ref=?",
                  bid,node_id,video_ref)


def set_showcase_template(token, template):
    if template:
        db.run("""INSERT INTO showcase_template_links VALUES(?,?) ON CONFLICT(token)
                  DO UPDATE SET template_id=excluded.template_id""",token,template)
    else:
        db.run("DELETE FROM showcase_template_links WHERE token=?",token)


def discard_showcase_video(ref):
    if (path := showcase.upload_path(config.COMFY_DIR,ref)) and not db.one("SELECT 1 FROM showcase_entries WHERE video_ref=?",ref):
        path.unlink(missing_ok=True)


def delete_showcase_entries(bid, token=None):
    clause, args = ("board_id=? AND token=?", (bid,token)) if token else ("board_id=?", (bid,))
    rows = db.q(f"SELECT video_ref FROM showcase_entries WHERE {clause}",*args)
    db.run(f"DELETE FROM showcase_entries WHERE {clause}",*args)
    for row in rows:
        discard_showcase_video(row["video_ref"])


async def withdraw_showcase(req):
    path, _ = canvas_routes.board_to_share(req)
    delete_showcase_entries(path.stem,req.match_info["token"])
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)


def validate_showcase_template(template, uid):
    if template is None:
        return
    if not isinstance(template,str) or not re.fullmatch(r"t[a-f0-9]{20}",template):
        raise http_errors.bad("工作流模板编号无效")
    if not db.one("""SELECT 1 FROM canvas_templates t JOIN canvas_template_publications p ON p.template_id=t.id
                     WHERE t.id=? AND t.owner=?""",template,uid):
        raise http_errors.bad("请选择自己已共享的工作流模板")


async def update_showcase_template(req):
    path, _ = canvas_routes.board_to_share(req)
    uid, token = req["user"]["id"],req.match_info["token"]
    payload = await req.json()
    if not isinstance(payload,dict) or "template" not in payload:
        raise http_errors.bad("请选择要关联的工作流模板")
    template = payload["template"]
    with db.transaction():
        if not db.one("SELECT 1 FROM showcase_entries WHERE board_id=? AND token=? AND owner=? AND state='approved'",
                      path.stem,token,uid):
            raise web.HTTPNotFound()
        validate_showcase_template(template,uid)
        set_showcase_template(token,template)
    return web.json_response({"ok":True},headers=public_canvas.HEADERS)


async def revoke_showcase_prompt(req):
    path, _ = canvas_routes.board_to_share(req)
    token = req.match_info["token"]
    db.run("""DELETE FROM showcase_prompts WHERE token=? AND EXISTS (
              SELECT 1 FROM showcase_entries s WHERE s.token=? AND s.board_id=? AND s.owner=?)""",
           token,token,path.stem,req["user"]["id"])
    return web.json_response({"ok":True},headers=public_canvas.HEADERS)


def require_showcase_admin(req):
    if req["user"]["role"] != "admin":
        raise web.HTTPForbidden()


async def showcase_pending(req):
    require_showcase_admin(req)
    rows = db.q(f"""SELECT {SHOWCASE_FIELDS},q.prompt FROM showcase_entries s JOIN users u ON u.id=s.owner
                    LEFT JOIN showcase_prompts q ON q.token=s.token
                    WHERE s.state='pending' ORDER BY s.submitted,s.token LIMIT 50""")
    return web.json_response(rows, headers=public_canvas.HEADERS)


async def showcase_pending_media(req):
    require_showcase_admin(req)
    return showcase_media(req,"pending")


def pending_showcase_snapshot(req):
    require_showcase_admin(req)
    row = db.one("""SELECT board_id,snapshot,submitted FROM showcase_entries
                 WHERE token=? AND state='pending' AND snapshot IS NOT NULL""", req.match_info["token"])
    canvas_sharing.require_snapshot_board(row)
    return json.loads(row["snapshot"]), row["submitted"]


async def showcase_review_page(req):
    pending_showcase_snapshot(req)
    return canvas_sharing.snapshot_page_file()


async def showcase_review_snapshot(req):
    snapshot, created = pending_showcase_snapshot(req)
    snapshot.pop("media")
    return web.json_response({**snapshot,"created":created}, headers=public_canvas.HEADERS)


async def showcase_review_snapshot_media(req):
    snapshot, _ = pending_showcase_snapshot(req)
    return canvas_sharing.snapshot_media_file(snapshot,int(req.match_info["index"]))


async def review_showcase(req):
    require_showcase_admin(req)
    payload = await req.json()
    state = payload.get("state") if isinstance(payload,dict) else None
    reason = payload.get("reason","") if isinstance(payload,dict) else ""
    if state not in ("approved","rejected") or not isinstance(reason,str) or len(reason.strip()) > 500 or (
            state == "rejected" and not reason.strip()):
        raise http_errors.bad("请选择审核结果，退回时请填写原因")
    with db.transaction():
        token = req.match_info["token"]
        entry = db.one("SELECT owner FROM showcase_entries WHERE token=? AND state='pending'",token)
        if not entry:
            return auth.err(409,"作品已处理或已撤回")
        if state == "approved":
            db.run("INSERT OR IGNORE INTO showcase_creators VALUES(?,?)",entry["owner"],uuid.uuid4().hex)
        db.run("UPDATE showcase_entries SET state=?,reason=?,published=? WHERE token=?",
               state,reason.strip() if state=="rejected" else "",time.time() if state=="approved" else None,token)
        if state == "rejected":
            db.run("UPDATE event_entries SET state='rejected',reason=? WHERE token=? AND state='pending'",reason.strip(),token)
    return web.json_response({"ok":True}, headers=public_canvas.HEADERS)
