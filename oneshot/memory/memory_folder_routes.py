"""Manage personal and team asset folders and constrained references."""
from __future__ import annotations

import re
import uuid

from aiohttp import web

from oneshot.memory.memory_http import store
from oneshot.memory.memory_values import dumps, fail
from oneshot.storage import db


def folder_name(payload):
    raw = payload.get("name") if isinstance(payload,dict) else None
    if not isinstance(raw,str) or not 1 <= len(raw.strip()) <= 60 or "\n" in raw or "\r" in raw:
        fail("请输入 1–60 字的文件夹名称")
    return raw.strip()


def valid_library_scope(scope):
    return isinstance(scope,str) and (
        scope in ("current","personal","shared") or re.fullmatch(r"team:[\w-]{1,80}",scope)
    )


def folder_scope(user, team=None, *, manage=False):
    if team is None:
        return "asset_folders","owner",user["id"]
    if not isinstance(team,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}",team):
        fail("团队编号无效")
    record = db.one("""SELECT t.owner FROM canvas_teams t JOIN canvas_team_members m ON m.team_id=t.id
                    WHERE t.id=? AND m.user_id=?""",team,user["id"])
    if not record:
        fail("团队不存在或不可访问",404)
    if manage and record["owner"] != user["id"]:
        fail("只有团队管理员可以管理文件夹",403)
    return "team_asset_folders","team",team


def owned_folder(user, fid, team=None, *, manage=False):
    table, field, uid = folder_scope(user,team,manage=manage)
    folder = db.one(f"SELECT id,name FROM {table} WHERE {field}=? AND id=?",uid,fid)
    if not folder:
        fail("文件夹不存在",404)
    return folder


async def folder_references(req):
    user, bid, selected = req["user"], req.query.get("board"), req.query.get("folder")
    if not bid:
        fail("请选择当前画布")
    st = store(req)
    items = {item["id"]:item for item in st.list(user,bid)}
    folders = db.q("""SELECT id,name,NULL AS team FROM asset_folders WHERE owner=?
                    UNION ALL SELECT f.id,f.name,f.team FROM team_asset_folders f
                    JOIN canvas_team_members m ON m.team_id=f.team WHERE m.user_id=?
                    ORDER BY name COLLATE NOCASE,id""",user["id"],user["id"])
    members = db.q("""SELECT i.asset_id,i.folder_id FROM asset_folder_items i WHERE i.owner=?
                    UNION ALL SELECT i.asset_id,i.folder_id FROM team_asset_folder_items i
                    JOIN team_asset_folders f ON f.id=i.folder_id
                    JOIN canvas_team_members m ON m.team_id=f.team WHERE m.user_id=?""",user["id"],user["id"])
    available = {folder["id"]:{**folder,"assets":[]} for folder in folders}
    for member in members:
        folder = available.get(member["folder_id"])
        item = items.get(member["asset_id"])
        if folder and item and (not folder["team"] or item.get("team")==folder["team"]):
            folder["assets"].append({key:item.get(key) for key in ("id","name","kind","ref")})
    headers = {"Cache-Control":"no-store"}
    if selected:
        folder = available.get(selected)
        if not folder:
            fail("文件夹已删除或不可访问",404)
        folder["assets"].sort(key=lambda item:(item["name"].casefold(),item["id"]))
        return web.json_response(folder,headers=headers)
    return web.json_response([{**{k:folder[k] for k in ("id","name","team")},"count":len(folder["assets"])}
                              for folder in available.values() if folder["assets"]],headers=headers)


async def list_folders(req):
    table, field, uid = folder_scope(req["user"],req.query.get("team"))
    return web.json_response(db.q(f"SELECT id,name FROM {table} WHERE {field}=? ORDER BY name COLLATE NOCASE,id",uid),
                             headers={"Cache-Control":"no-store"})


async def create_folder(req):
    name = folder_name(await req.json())
    table, field, uid = folder_scope(req["user"],req.query.get("team"),manage=True)
    if db.one(f"SELECT 1 FROM {table} WHERE {field}=? AND name=? COLLATE NOCASE",uid,name):
        fail("已有同名文件夹",409)
    fid = "f"+uuid.uuid4().hex[:20]
    db.run(f"INSERT INTO {table} VALUES(?,?,?)",fid,uid,name)
    return web.json_response({"id":fid,"name":name},status=201)


async def rename_folder(req):
    name = folder_name(await req.json())
    team = req.query.get("team")
    table, field, uid = folder_scope(req["user"],team,manage=True)
    folder = owned_folder(req["user"],req.match_info["fid"],team)
    if db.one(f"SELECT 1 FROM {table} WHERE {field}=? AND name=? COLLATE NOCASE AND id<>?",uid,name,folder["id"]):
        fail("已有同名文件夹",409)
    db.run(f"UPDATE {table} SET name=? WHERE id=?",name,folder["id"])
    return web.json_response({"id":folder["id"],"name":name})


async def delete_folder(req):
    team = req.query.get("team")
    table, _, _ = folder_scope(req["user"],team,manage=True)
    folder = owned_folder(req["user"],req.match_info["fid"],team)
    db.run(f"DELETE FROM {table} WHERE id=?",folder["id"])
    return web.json_response({"ok":True})


async def file_assets(req):
    p = await req.json()
    if not isinstance(p,dict) or "folder" not in p or not isinstance(p.get("board"),str) or not p["board"]:
        fail("请选择画布和目标文件夹")
    user, fid, ids = req["user"], p["folder"], p.get("assets")
    team = p.get("team")
    if not isinstance(ids,list) or not 1 <= len(ids) <= 100 or any(not isinstance(mid,str) for mid in ids):
        fail("请选择 1–100 个资产")
    if fid is not None:
        if not isinstance(fid,str):
            fail("目标文件夹无效")
        owned_folder(user,fid,team)
    allowed = {a["id"]:a for a in store(req).list(user,p["board"])}
    if not set(ids) <= allowed.keys():
        fail("有资产已不可访问",404)
    if team is not None:
        folder_scope(user,team)
        manager = db.one("SELECT owner FROM canvas_teams WHERE id=?",team)["owner"]
        if any(allowed[aid].get("team") != team for aid in ids):
            fail("只能将本团队的资产归档到团队文件夹")
        if user["id"] != manager and any(allowed[aid]["owner"] != user["id"] for aid in ids):
            fail("只能归档自己收录的资产",403)
        if fid is None:
            db.run("DELETE FROM team_asset_folder_items WHERE asset_id IN (SELECT value FROM json_each(?))",dumps(ids))
        else:
            db.run("""INSERT INTO team_asset_folder_items(asset_id,folder_id)
                    SELECT value,? FROM json_each(?) WHERE 1 ON CONFLICT(asset_id) DO UPDATE SET folder_id=excluded.folder_id""",
                   fid,dumps(ids))
        return web.json_response({"ok":True})
    ids = dumps(list(dict.fromkeys(ids)))
    if fid is None:
        db.run("DELETE FROM asset_folder_items WHERE owner=? AND asset_id IN (SELECT value FROM json_each(?))",user["id"],ids)
    else:
        db.run("""INSERT INTO asset_folder_items(owner,asset_id,folder_id)
                  SELECT ?,value,? FROM json_each(?) WHERE 1
                  ON CONFLICT(owner,asset_id) DO UPDATE SET folder_id=excluded.folder_id""",user["id"],fid,ids)
    return web.json_response({"ok":True})
