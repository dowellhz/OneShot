"""Copy, export, and collect pinned assets from the canvas."""
from __future__ import annotations

import re
import uuid

from aiohttp import web

from oneshot.memory.memory_folder_routes import owned_folder
from oneshot.memory.memory_http import store
from oneshot.memory.memory_values import dumps, fail
from oneshot.storage import db


async def duplicate_asset(req):
    payload = await req.json()
    key = payload.get("request_key") if isinstance(payload,dict) else None
    if not isinstance(key,str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}",key):
        fail("复制请求编号无效")
    asset = store(req).duplicate(req["user"],req.match_info["mid"],payload.get("board") or None,key)
    return web.json_response(asset)


async def download_asset(req):
    s = store(req)
    asset = s.get(req["user"],req.match_info["mid"],req.query.get("board") or None)
    s.h.require_media(req["user"],[item["ref"] for item in asset.get("media",[])])
    filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]',"_",asset["name"]).strip(". ") or "素材"
    return await s.h.serve_asset_archive(s.package(asset),filename+".zip")


async def import_canvas_assets(req):
    p = await req.json()
    if not isinstance(p,dict):
        fail("收录参数无效")
    user, s = req["user"], store(req)
    bid, folder, scope = p.get("board"), p.get("folder"), p.get("scope")
    key, entries = p.get("request_key"), p.get("nodes")
    if not isinstance(key,str) or not re.fullmatch(r"[\w.-]{12,100}",key):
        fail("收录编号无效")
    if not isinstance(entries,list) or not 1 <= len(entries) <= 100 or any(
        not isinstance(item,dict) or not isinstance(item.get("id"),str)
        or item.get("ref") is not None and not isinstance(item["ref"],str) for item in entries
    ):
        fail("请选择 1–100 个可收录的画布节点")
    if len({item["id"] for item in entries}) != len(entries):
        fail("收录节点重复")
    if scope not in ("canvas","project","personal","team") or folder is not None and not isinstance(folder,str):
        fail("请选择有效的范围与文件夹")
    board = s.board(user,bid)
    if not s.h.can_edit(user,board):
        fail("审阅权限无法收录画布素材",403)
    nodes = {n["id"]:n for n in board.get("nodes",[])}
    results = []
    with db.transaction():
        project = s.project(user,bid) if scope == "project" else None
        team = p.get("team") if scope == "team" else None
        if scope == "team" and (not isinstance(team,str) or team not in s.teams(user)):
            fail("只能把资产收录到你所属的团队",403)
        if scope == "project" and (not project or project != p.get("project")):
            fail("该画布所属的项目已改变，请重新选择",409)
        if folder is not None:
            owned_folder(user,folder,team)
        for item in entries:
            nid, ref = item["id"], item.get("ref")
            scope_key = team if scope=="team" else project
            mid = "m" + uuid.uuid5(uuid.NAMESPACE_URL,dumps([user["id"],bid,key,nid,ref,scope,scope_key,folder])).hex
            prior = db.one("SELECT 1 FROM creative_memories WHERE id=?",mid)
            if prior:
                s.get(user,mid)
                results.append(mid)
                continue
            n = nodes.get(nid)
            if n is None:
                fail("有画布节点已移除，请重新选择",409)
            kind, data = n.get("type"), n.get("data",{})
            name = n["name"].replace("@","＠").strip() or "画布素材"
            payload = {"name":name,"board":bid if scope=="canvas" else "","project":project or "","team":team or ""}
            if kind == "text" and ref is None and isinstance(data.get("text"),str) and data["text"].strip():
                payload.update(kind="document",document={"name":name,"text":data["text"],
                    "format":"markdown" if data.get("text_format") == "markdown" else "plain"})
            elif kind in ("image","video","audio") and ref:
                version = next((v for v in n.get("versions",[]) if v.get("ref")==ref),None)
                if version is None:
                    fail("有素材版本已移除，请重新选择",409)
                payload.update(kind="prop",ref=ref,source_board=bid,node_id=nid,
                               desc=data.get("caption") or version.get("prompt") or "")
            else:
                fail("有节点没有可收录的素材",409)
            s.put(user,payload,stable_id=mid)
            results.append(mid)
            if folder and team:
                db.run("INSERT INTO team_asset_folder_items VALUES(?,?)",mid,folder)
            elif folder:
                db.run("INSERT INTO asset_folder_items(owner,asset_id,folder_id) VALUES(?,?,?)",user["id"],mid,folder)
    return web.json_response({"ids":results},status=201)
