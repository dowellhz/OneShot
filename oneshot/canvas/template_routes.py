"""List, edit, publish, and reuse workflow templates."""

import copy
import json
import re
import time
import uuid

from aiohttp import web

from oneshot import config
from oneshot.canvas import board_store
from oneshot.canvas import public_canvas
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import workflow_presets
from oneshot.canvas.board_store import access_role
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_see
from oneshot.storage import db
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


def comment_board(req):
    bid = req.match_info["bid"]
    board = board_meta(canvas_routes.board_path(bid))
    if not board or not can_see(req["user"], board):
        raise web.HTTPNotFound()
    return bid, board


def owned_template(req):
    row = db.one("SELECT * FROM canvas_templates WHERE id=? AND owner=?", req.match_info["tid"], req["user"]["id"])
    if not row:
        raise web.HTTPNotFound()
    return row


def workflow_template_by_id(uid, tid):
    if preset := workflow_presets.PRESETS.get(tid):
        return preset
    row = db.one("""SELECT t.* FROM canvas_templates t
                    LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                    WHERE t.id=? AND (t.owner=? OR p.template_id IS NOT NULL)""",
                 tid, uid)
    if row is None:
        return None
    board = json.loads(row["data"])
    row.update(data=board,description=board.pop("template_description",""))
    return row


def readable_template(req):
    row = workflow_template_by_id(req["user"]["id"],req.match_info["tid"])
    if row is None:
        raise web.HTTPNotFound()
    return row


def private_template_summaries(uid):
    return db.q("""SELECT t.id,t.name,t.updated,p.published,json_array_length(t.data,'$.nodes') AS nodes,
                          json_extract(t.data,'$.template_description') AS description,f.template_id IS NOT NULL AS favorite
                   FROM canvas_templates t LEFT JOIN canvas_template_publications p ON p.template_id=t.id
                   LEFT JOIN canvas_template_favorites f ON f.template_id=t.id AND f.owner=t.owner
                   WHERE t.owner=? ORDER BY t.updated DESC,t.id""", uid)


def shared_template_summaries(uid):
    return db.q("""SELECT t.id,t.name,p.published,json_array_length(t.data,'$.nodes') AS nodes,
                          t.owner=? AS owned, COALESCE(NULLIF(u.name,''),u.username) AS author,
                          json_extract(t.data,'$.template_description') AS description,f.template_id IS NOT NULL AS favorite
                   FROM canvas_template_publications p JOIN canvas_templates t ON t.id=p.template_id
                   JOIN users u ON u.id=t.owner
                   LEFT JOIN canvas_template_favorites f ON f.template_id=t.id AND f.owner=?
                   ORDER BY p.published DESC,t.id""", uid, uid)


def preset_template_summaries(uid):
    favorites = {row["template_id"] for row in db.q("SELECT template_id FROM canvas_template_favorites WHERE owner=?",uid)}
    return [{k:v for k,v in row.items() if k!="data"} | {"favorite":row["id"] in favorites}
            for row in workflow_presets.PRESETS.values()]


def favorite_template_summaries(uid):
    saved = db.q("""SELECT f.template_id,t.id,t.name,t.updated,p.published,t.owner=? AS owned,
                           json_array_length(t.data,'$.nodes') AS nodes,COALESCE(NULLIF(u.name,''),u.username) AS author,
                           json_extract(t.data,'$.template_description') AS description
                    FROM canvas_template_favorites f LEFT JOIN canvas_templates t ON t.id=f.template_id
                    LEFT JOIN canvas_template_publications p ON p.template_id=t.id LEFT JOIN users u ON u.id=t.owner
                    WHERE f.owner=? AND (t.id IS NULL OR t.owner=? OR p.template_id IS NOT NULL)
                    ORDER BY f.added DESC,f.template_id""", uid, uid, uid)
    rows = []
    for row in saved:
        tid = row.pop("template_id")
        if preset := workflow_presets.PRESETS.get(tid):
            row = {k:v for k,v in preset.items() if k!="data"}
        if row["id"]:
            rows.append(row | {"favorite":True})
    return rows


TEMPLATE_SUMMARIES = {"private":private_template_summaries,"catalog":shared_template_summaries,
                      "presets":preset_template_summaries,"favorites":favorite_template_summaries}


async def list_templates(req):
    return web.json_response(TEMPLATE_SUMMARIES[req.match_info.get("scope","private")](req["user"]["id"]))


def search_workflow_templates(user, scope, terms):
    scopes = ("private","catalog","presets") if scope=="all" else (scope,)
    tokens = set(term.casefold().strip() for term in terms if term.strip())
    matches = {}
    for source in scopes:
        for row in TEMPLATE_SUMMARIES[source](user["id"]):
            if row["id"] in matches:
                continue
            title = row["name"].casefold()
            details = " ".join(str(row.get(key) or "") for key in ("description","category","author")).casefold()
            score = sum(3 if token in title else 1 if token in details else 0 for token in tokens)
            if score or not tokens:
                matches[row["id"]] = (score,{**row,"scope":source})
    return [row for _,row in sorted(matches.values(),key=lambda item:(item[0],bool(item[1]["favorite"])),reverse=True)[:10]]


async def favorite_template(req):
    with db.transaction():
        template = readable_template(req)
        db.run("INSERT OR IGNORE INTO canvas_template_favorites VALUES(?,?,?)",req["user"]["id"],template["id"],time.time())
    return web.json_response({"favorite":True})


async def unfavorite_template(req):
    db.run("DELETE FROM canvas_template_favorites WHERE owner=? AND template_id=?",req["user"]["id"],req.match_info["tid"])
    return web.json_response({"favorite":False})


def template_description(payload):
    description = payload.get("description","")
    if not isinstance(description,str) or len(description.strip()) > 300:
        raise http_errors.bad("模板说明最多 300 字")
    return description.strip()


def template_from_board(user, payload):
    board = board_meta(canvas_routes.board_path(payload.get("board")))
    if not board or not can_see(user,board):
        raise web.HTTPNotFound()
    if access_role(user,board) != "owner":
        raise web.HTTPForbidden()
    if not board.get("nodes"):
        raise http_errors.bad("画布上至少需要一个节点")
    if "revision" in payload and payload["revision"] != board.get("rev"):
        raise web.HTTPConflict(text='{"error":"画布已更新，请打开最新版本后再保存模板"}',content_type="application/json")
    selected = payload.get("selected")
    if selected is not None:
        ids = {n["id"] for n in board["nodes"]}
        if not isinstance(selected,list) or not selected or any(not isinstance(nid,str) or nid not in ids for nid in selected):
            raise http_errors.bad("选中的模板节点不存在")
    include_upstream = payload.get("include_upstream",False)
    if type(include_upstream) is not bool:
        raise http_errors.bad("模板依赖选项无效")
    template = board_store.workflow_template(board, selected, include_upstream=include_upstream)
    template["template_description"] = template_description(payload)
    refs = media_routes.media_references(template)
    media_routes.require_media(user,refs)
    return template, refs


async def save_template(req):
    payload = await req.json()
    user, name = req["user"], canvas_routes.project_name(payload)
    template, refs = template_from_board(user,payload)
    tid, now = "t"+uuid.uuid4().hex[:20], time.time()
    with db.transaction():
        media_routes.grant_media(user,*refs)
        db.run("INSERT INTO canvas_templates VALUES(?,?,?,?,?)",tid,user["id"],name,json.dumps(template,ensure_ascii=False),now)
    return web.json_response({"id":tid,"name":name,"nodes":len(template["nodes"]),"updated":now,
                              "description":template["template_description"]},status=201)


async def rename_template(req):
    payload = await req.json()
    name = canvas_routes.project_name(payload)
    row = owned_template(req)
    data = row["data"]
    if "description" in payload:
        data = json.dumps({**json.loads(data),"template_description":template_description(payload)},ensure_ascii=False)
    db.run("UPDATE canvas_templates SET name=?,data=?,updated=? WHERE id=?",name,data,time.time(),row["id"])
    return web.json_response({"ok":True})


def template_update_target(req, payload):
    if not isinstance(payload,dict):
        raise http_errors.bad("模板更新参数无效")
    row = owned_template(req)
    if payload.get("template_updated")!=row["updated"]:
        raise web.HTTPConflict(text='{"error":"模板已更新，请刷新模板列表后重试"}',content_type="application/json")
    if db.one("SELECT 1 FROM canvas_template_publications WHERE template_id=?",row["id"]) and payload.get("confirmed_shared") is not True:
        raise http_errors.bad("请确认现有共享链接将使用新模板内容")
    return row


def update_template_content(row, name, data):
    if row["name"]==name and row["data"]==data:
        return
    tid = row["id"]
    db.run("INSERT INTO canvas_template_history(template_id,name,data,updated) VALUES(?,?,?,?)",
           tid,row["name"],row["data"],row["updated"])
    db.run("UPDATE canvas_templates SET name=?,data=?,updated=? WHERE id=?",name,data,time.time(),tid)
    db.run("""DELETE FROM canvas_template_history WHERE id IN (
              SELECT id FROM canvas_template_history WHERE template_id=? ORDER BY id DESC LIMIT -1 OFFSET 20)""",tid)


async def replace_template_content(req):
    payload = await req.json()
    user, name = req["user"],canvas_routes.project_name(payload)
    with db.transaction():
        row = template_update_target(req,payload)
        if "revision" not in payload:
            raise http_errors.bad("缺少来源画布版本")
        template, refs = template_from_board(user,payload)
        media_routes.grant_media(user,*refs)
        update_template_content(row,name,json.dumps(template,ensure_ascii=False))
    return web.json_response({"ok":True})


async def list_template_history(req):
    row = owned_template(req)
    return web.json_response(db.q("""SELECT id,name,updated,json_array_length(data,'$.nodes') AS nodes
                                     FROM canvas_template_history WHERE template_id=? ORDER BY id DESC""",row["id"]))


def template_history_version(req, row):
    version = db.one("SELECT * FROM canvas_template_history WHERE id=? AND template_id=?",req.match_info["version"],row["id"])
    if version is None:
        raise web.HTTPNotFound()
    return version


async def read_template_history(req):
    version = template_history_version(req,owned_template(req))
    data = json.loads(version["data"])
    return web.json_response({"nodes":[{"name":n["name"],"type":n["type"],"inputs":template_node_inputs(n)} for n in data["nodes"]],
                              "description":data.get("template_description","")})


async def restore_template_history(req):
    payload = await req.json()
    with db.transaction():
        row = template_update_target(req,payload)
        version = template_history_version(req,row)
        media_routes.require_media(req["user"],media_routes.media_references(json.loads(version["data"])))
        update_template_content(row,version["name"],version["data"])
    return web.json_response({"ok":True})


async def delete_template(req):
    row = owned_template(req)
    db.run("DELETE FROM canvas_templates WHERE id=?",row["id"])
    return web.json_response({"ok":True})


async def publish_template(req):
    payload = await req.json()
    if not isinstance(payload,dict) or payload.get("confirmed") is not True:
        raise http_errors.bad("请确认向所有登录用户共享模板")
    row = owned_template(req)
    media_routes.require_media(req["user"], media_routes.media_references(json.loads(row["data"])))
    db.run("INSERT OR IGNORE INTO canvas_template_publications VALUES(?,?)", row["id"], time.time())
    return web.json_response({"ok":True})


async def unpublish_template(req):
    row = owned_template(req)
    db.run("DELETE FROM canvas_template_publications WHERE template_id=?", row["id"])
    return web.json_response({"ok":True})


TEMPLATE_VIDEO_INPUTS = ("style","scene","people","camera","action","dialogue","sound","music")


TEMPLATE_SCRIPT_SETTINGS = {
    "nshots": ("auto","3","4","6","8"),
    "shotlen": ("auto","3","5","8"),
    "aspect": ("16:9","9:16","4:3","1:1","21:9"),
}


def template_node_inputs(node):
    data = node.get("data",{})
    if not isinstance(data,dict):
        return {}
    if node["type"] == "text":
        return {"text":str(data.get("text") or "")}
    if node["type"] == "video" and data.get("pmode") == "fields":
        fields = data.get("fields")
        fields = fields if isinstance(fields,dict) else {}
        return {f"fields.{key}":str(fields.get(key) or "") for key in TEMPLATE_VIDEO_INPUTS}
    if node["type"] == "script":
        settings = {key:str(data.get(key) or ("16:9" if key == "aspect" else "auto")) for key in TEMPLATE_SCRIPT_SETTINGS}
        return {"prompt":str(data.get("prompt") or ""),**settings}
    if node["type"] in ("image","video","audio","script"):
        return {"prompt":str(data.get("prompt") or "")}
    return {}


def template_copy_inputs(row, payload):
    if not isinstance(payload,dict):
        raise http_errors.bad("模板填写内容无效")
    edits = payload.get("inputs",[])
    if not isinstance(edits,list) or len(edits)>200:
        raise http_errors.bad("一次最多填写 200 项模板内容")
    if not edits:
        return row["data"]
    board = copy.deepcopy(row["data"])
    nodes = {n["id"]:n for n in board["nodes"]}
    applied = set()
    for edit in edits:
        if not isinstance(edit,dict) or any(not isinstance(edit.get(k),str) for k in ("node","field","before","value")):
            raise http_errors.bad("模板填写内容无效")
        nid, field, old, value = (edit[k] for k in ("node","field","before","value"))
        node = nodes.get(nid)
        fields = template_node_inputs(node) if node else {}
        if field not in fields or (nid,field) in applied or len(value)>20_000 or len(old)>20_000:
            raise http_errors.bad("模板填写项不存在、重复或超过 20000 字")
        if node["type"] == "script" and field in TEMPLATE_SCRIPT_SETTINGS and value not in TEMPLATE_SCRIPT_SETTINGS[field]:
            raise http_errors.bad("分镜模板参数无效")
        if fields[field]!=old:
            raise web.HTTPConflict(text=json.dumps({"error":"模板内容已更新，请重新打开预览"},ensure_ascii=False),
                                   content_type="application/json")
        applied.add((nid,field))
        data = node.setdefault("data",{})
        if field.startswith("fields."):
            if not isinstance(data.get("fields"),dict):
                data["fields"] = {}
            data["fields"][field.split(".",1)[1]] = value
        else:
            data[field] = value
    return board


def capture_template_preview(row):
    template = row["data"]
    preview = public_canvas.capture({**template, "name":row["name"]}, config.COMFY_DIR)
    media = {ref:index for index,ref in enumerate(preview["media"])}
    preview["description"] = row["description"]
    node_ids = {node["id"] for node in preview["nodes"]}
    nodes = {item["id"]:item for item in template["nodes"]}
    edges = []
    for edge in board_store.seed_audio_edges(template):
        source_id, target_id = edge.get("from"), edge.get("to")
        if source_id not in node_ids or target_id not in node_ids:
            continue
        summary = {key:public_canvas.string(edge[key],80) for key in ("from","to","role","relation") if key in edge}
        source = nodes[source_id]
        ref = edge.get("source_ref") if edge.get("relation") in public_canvas.SOURCE_RELATIONS else edge.get("ref")
        if isinstance(ref,str) and ref and source["type"] in ("image","audio","video"):
            versions = source.get("versions") or []
            number = next((i for i,v in enumerate(versions,1) if isinstance(v,dict) and v.get("ref")==ref),None)
            if number and public_canvas.media_path(config.COMFY_DIR,ref,source["type"]):
                summary.update(version=number,media=media.setdefault(ref,len(media)))
            else:
                summary["reference_unavailable"] = True
        for key in ("start","end","time","at"):
            if (value := public_canvas.number(edge.get(key),None,0,86_400)) is not None:
                summary[key] = value
        for key in ("slot","prompt_slot"):
            if type(edge.get(key)) is int and 0 < edge[key] <= 5000:
                summary[key] = edge[key]
        edges.append(summary)
    preview["edges"] = edges
    preview["media"] = list(media)
    for node in preview["nodes"]:
        original = nodes[node["id"]]
        data = original.get("data")
        if isinstance(data,dict) and isinstance(data.get("prompt"),str):
            node["prompt"] = data["prompt"][:20_000]
    return preview


async def preview_template(req):
    row = readable_template(req)
    preview = capture_template_preview(row)
    inputs = {node["id"]:template_node_inputs(node) for node in row["data"]["nodes"]}
    for node in preview["nodes"]:
        node["inputs"] = inputs[node["id"]]
    preview.pop("media")
    return web.json_response(preview, headers=public_canvas.HEADERS)


async def preview_template_media(req):
    preview = capture_template_preview(readable_template(req))
    index = int(req.match_info["index"])
    if index >= len(preview["media"]):
        raise web.HTTPNotFound()
    path = public_canvas.media_path(config.COMFY_DIR, preview["media"][index])
    if not path:
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=public_canvas.HEADERS)


async def template_fragment(req):
    row = readable_template(req)
    try:
        payload = await req.json() if req.can_read_body else {}
    except ValueError:
        raise http_errors.bad("模板填写内容无效") from None
    board = template_copy_inputs(row,payload)
    media_routes.grant_media(req["user"],*media_routes.media_references(board))
    groups = board["groups"]
    if not groups and len(board["nodes"]) > 1:
        groups = [{"id":"template","name":row["name"],"nodes":[node["id"] for node in board["nodes"]]}]
    return web.json_response({"nodes":board["nodes"],"edges":board["edges"],"groups":groups})


async def open_template(req):
    payload = await req.json()
    row = readable_template(req)
    key = payload.get("request_key") if isinstance(payload,dict) else None
    if not isinstance(key,str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}",key):
        raise http_errors.bad("模板请求编号无效")
    user, project = req["user"], payload.get("project")
    if project is not None:
        canvas_routes.owned_project(user,project)
    bid = "b"+uuid.uuid5(uuid.NAMESPACE_URL, f"oneshot:template:{row['id']}:{user['id']}:{key}").hex[:24]
    path = canvas_routes.board_path(bid)
    current = board_meta(path)
    if current:
        if current.get("owner") != user["id"]:
            raise web.HTTPConflict()
        return web.json_response({"id":bid})
    board = {**template_copy_inputs(row,payload),"name":row["name"],"owner":user["id"],"shared":False,"rev":1}
    media_routes.grant_media(user,*media_routes.media_references(board))
    canvas_routes.write_board(path,board)
    if project:
        canvas_routes.assign_canvas_project(bid,project)
    return web.json_response({"id":bid},status=201)
