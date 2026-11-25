"""List and search assets, resolve references, and import documents."""
from __future__ import annotations

import json
import math

from aiohttp import web

from oneshot.memory import document_import
from oneshot.memory.memory_folder_routes import valid_library_scope
from oneshot.memory.memory_http import store
from oneshot.memory.memory_values import (
    KINDS,
    dumps,
    fail,
    generation_asset_key,
)
from oneshot.storage import db


def asset_list_entries(items, user, query):
    folders = {row["asset_id"]:row["folder_id"] for row in db.q(
        "SELECT asset_id,folder_id FROM asset_folder_items WHERE owner=?",user["id"])}
    team_folders = {row["asset_id"]:row["folder_id"] for row in db.q("""
        SELECT i.asset_id,i.folder_id FROM team_asset_folder_items i JOIN team_asset_folders f ON f.id=i.folder_id
        JOIN canvas_team_members m ON m.team_id=f.team WHERE m.user_id=?""",user["id"])}
    folded = query.strip().casefold()
    for asset in items:
        asset["folder_id"] = folders.get(asset["id"])
        if asset.get("team"):
            asset["team_folder_id"] = team_folders.get(asset["id"])
        if document := asset.get("document"):
            asset["document"] = {"name":document["name"], "truncated":document["truncated"], "length":len(document["text"]),
                                 "excerpt":document_import.passage(document,folded,350)}
            if folded and folded in (document["name"]+"\n"+document["text"]).casefold():
                asset["document_match"] = True
    return items


async def listing(req):
    s,user,query = store(req),req["user"],req.query.get("q","")
    bid, scope = req.query.get("board") or None, req.query.get("scope")
    cursor = req.query.get("cursor")
    if scope is not None and (not bid or not valid_library_scope(scope)):
        fail("请选择有效的画布和资产范围")
    if cursor is not None and (scope is None or query):
        fail("请选择有效的资产分页范围")
    items = s.list(user,bid,query,req.query.get("kind"))
    if scope is not None:
        in_scope = s.scope_filter(user,bid,scope)
        items = [asset for asset in items if in_scope(asset)]
    if cursor is not None:
        items, next_cursor = library_page(items,cursor)
    else:
        items = items[:300]
    s.character_drafts(user,items)
    asset_list_entries(items,user,query)
    payload = items if cursor is None else {"items":items,"next_cursor":next_cursor}
    return web.json_response(payload,headers={"Cache-Control":"no-store"})


def library_page(items, cursor):
    def position(asset):
        return asset["mtime"],asset["id"]

    if cursor:
        try:
            if len(cursor) > 240:
                raise ValueError
            mtime, mid = json.loads(cursor)
            if type(mtime) not in (int,float) or not math.isfinite(mtime) or not isinstance(mid,str):
                raise ValueError
        except (TypeError, ValueError, OverflowError):
            fail("资产分页位置无效")
        items = [asset for asset in items if position(asset) < (mtime,mid)]
    page = sorted(items,key=position,reverse=True)[:120]
    return page, dumps(position(page[-1])) if len(items) > len(page) else None


async def mention_options(req):
    bid, query, view = req.query.get("board"), req.query.get("q",""), req.query.get("view")
    if not bid or len(query) > 80 or view is not None and len(view) > 80:
        fail("素材引用搜索参数无效")
    items = store(req).mention_suggestions(req["user"],bid,query.strip(),None if view is None else view.casefold())
    return web.json_response(items,headers={"Cache-Control":"no-store"})


async def upload_document(req):
    try:
        return web.json_response(await document_import.read_upload(req))
    except document_import.UploadTooLarge as error:
        return web.json_response({"error":str(error)},status=413)
    except (ValueError, AssertionError) as error:
        fail(str(error) or "无法读取上传的文档")


async def detail(req):
    s = store(req)
    board = req.query.get("board") or None
    asset = s.get(req["user"], req.match_info["mid"], board)
    s.character_drafts(req["user"], [asset])
    return web.json_response({**asset, "history": s.history(req["user"], asset["id"], board)},
                             headers={"Cache-Control":"no-store"})


async def saving(req):
    return web.json_response(store(req).put(req["user"], await req.json()))


async def search_assets(req):
    payload = await req.json()
    if not isinstance(payload,dict):
        fail("素材检索参数无效")
    query, scope, kind = payload.get("query"), payload.get("scope","current"), payload.get("kind")
    if not isinstance(query,str) or not 1<=len(query.strip())<=1000:
        fail("请输入 1–1000 字的素材描述")
    if not valid_library_scope(scope):
        fail("请选择有效的资产范围")
    if kind is not None and (not isinstance(kind,str) or kind not in KINDS):
        fail("请选择有效的资产分类")
    user = req["user"]
    items, method = await store(req).search(req.app["llm"],user,payload.get("board"),query,kind=kind,scope=scope)
    return web.json_response({"items":asset_list_entries(items,user,query),"method":method},
                             headers={"Cache-Control":"no-store"})


async def resolve_assets(req):
    payload = await req.json()
    ids = payload.get("ids") if isinstance(payload,dict) else None
    board = payload.get("board") if isinstance(payload,dict) else None
    if (not isinstance(ids,list) or not 1<=len(ids)<=100 or
            not all(isinstance(mid,str) and 1<=len(mid)<=120 for mid in ids) or not board):
        fail("请选择画布和 1–100 个资产")
    s,user = store(req),req["user"]
    fields = ("id","kind","name","desc","constraints","document","media","ref","w","h")
    assets = []
    for mid in dict.fromkeys(ids):
        asset = s.get(user,mid,board)
        assets.append({key:asset[key] for key in fields if key in asset})
    return web.json_response(assets,headers={"Cache-Control":"no-store"})


async def review_generation_assets(req):
    payload = await req.json()
    if not isinstance(payload,dict) or not isinstance(payload.get("entries"),list) or not 1<=len(payload["entries"])<=100:
        fail("请选择要核对的生成节点")
    user, s = req["user"], store(req)
    bid = payload.get("board")
    s.board(user,bid)
    reviewed = []
    for entry in payload["entries"]:
        if (not isinstance(entry,dict) or not isinstance(entry.get("id"),str) or
                entry.get("kind") not in ("image","video") or not isinstance(entry.get("prompt"),str) or
                not isinstance(entry.get("fields",{}),dict)):
            fail("生成参考核对参数无效")
        raw = {key:entry[key] for key in ("kind","prompt","fields","memory_ids","memory_views") if key in entry}
        try:
            replay_ref = s.h.checked_asset_replay({"replay_memory_ref":entry.get("replay_memory_ref")})
            prepared = s.prepare(user,{**raw,"board":bid},replay_ref=replay_ref,
                                 video_reference_check=True)
        except web.HTTPException as error:
            reviewed.append({"id":entry["id"],"error":json.loads(error.text).get("error",error.reason)})
            continue
        assets = prepared.get("memory_used",[])
        reviewed.append({"id":entry["id"],"key":generation_asset_key(assets),"assets":[
            {key:asset[key] for key in ("id","name","kind","ref","references") if key in asset} for asset in assets
        ]})
    return web.json_response(reviewed,headers={"Cache-Control":"no-store"})


async def deleting(req):
    store(req).delete(req["user"], req.match_info["mid"])
    return web.json_response({"ok": True})
