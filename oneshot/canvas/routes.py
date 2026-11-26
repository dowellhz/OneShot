"""Board, project, team, and access endpoints."""

import json
import re
import time
import uuid
from pathlib import Path

from aiohttp import web

from oneshot import config
from oneshot.canvas import board_store
from oneshot.canvas import showcase_routes
from oneshot.canvas import workflow_review
from oneshot.canvas.board_store import access_role
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.canvas.board_store import can_see
from oneshot.memory import creative_memory
from oneshot.memory import legacy_routes
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


BOARDS = config.DATA_DIR / "boards"


def board_path(bid: str) -> Path:
    return board_store.board_path(BOARDS, bid)


def clean_board(v):
    board = board_store.clean_board(v, config.COMFY_DIR)
    if isinstance(board,dict) and isinstance(board.get("nodes"),list) and isinstance(board.get("edges"),list):
        board["edges"] = board_store.seed_audio_edges(board)
    return board


def write_board(path: Path, data: dict):
    if not path.is_file():
        data["created"] = time.time()
    creative_memory.remove_deleted_bindings(data)
    board_store.write_board(path, data)


def owned_project(user, project_id):
    if not isinstance(project_id, str) or not _ID.fullmatch(project_id):
        raise http_errors.bad("项目编号无效")
    project = db.one("SELECT id,name FROM canvas_projects WHERE id=? AND owner=?", project_id, user["id"])
    if not project:
        raise http_errors.bad("项目已不存在或无权管理")
    return project


def validate_canvas_destination(user, project_id, team_id):
    if project_id is not None and team_id is not None:
        raise http_errors.bad("请在个人项目和团队空间中选择一个")
    if project_id is not None:
        owned_project(user,project_id)
    if team_id is not None:
        team_membership(team_id,user)


def project_name(payload):
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or "\n" in name or "\r" in name:
        raise http_errors.bad("请输入 1–60 字的项目名称")
    return name.strip()


def assign_canvas_project(board_id, project_id):
    if project_id is None:
        db.run("DELETE FROM canvas_project_boards WHERE board_id=?", board_id)
    else:
        db.run("""INSERT INTO canvas_project_boards(board_id,project_id) VALUES(?,?)
                  ON CONFLICT(board_id) DO UPDATE SET project_id=excluded.project_id""", board_id, project_id)


async def list_canvas_projects(req):
    return web.json_response(db.q("SELECT id,name FROM canvas_projects WHERE owner=? ORDER BY created,id", req["user"]["id"]))


async def move_boards_to_project(req):
    payload = await req.json()
    boards = payload.get("boards") if isinstance(payload,dict) else None
    if (not isinstance(boards,list) or not 1<=len(boards)<=100 or
            any(not isinstance(bid,str) or not _ID.fullmatch(bid) for bid in boards)):
        raise http_errors.bad("请选择 1–100 张画布")
    if ("project" in payload)==("name" in payload):
        raise http_errors.bad("请选择现有项目，或填写新建项目的名称")
    user,ids = req["user"],list(dict.fromkeys(boards))
    for bid in ids:
        board = board_meta(board_path(bid))
        if not board or board.get("owner")!=user["id"] or board.get("team"):
            raise web.HTTPForbidden(text='{"error":"只能移动自己拥有的个人画布"}',content_type="application/json")
    with db.transaction():
        if "name" in payload:
            name = project_name(payload)
            project = {"id":"p"+uuid.uuid4().hex[:20],"name":name}
            db.run("INSERT INTO canvas_projects VALUES(?,?,?,?)",project["id"],user["id"],name,time.time())
        else:
            project = owned_project(user,payload["project"]) if payload["project"] is not None else None
        for bid in ids:
            assign_canvas_project(bid,project["id"] if project else None)
    return web.json_response({"project":project,"count":len(ids)})


async def create_canvas_project(req):
    payload = await req.json()
    user = req["user"]
    name = project_name(payload)
    bid = payload.get("board")
    if bid is not None and board_meta(board_path(bid)).get("owner") != user["id"]:
        raise http_errors.bad("只有画布所有者可以将画布移入项目")
    project_id = "p" + uuid.uuid4().hex[:20]
    db.run("INSERT INTO canvas_projects VALUES(?,?,?,?)", project_id, user["id"], name, time.time())
    if bid is not None:
        assign_canvas_project(bid, project_id)
    return web.json_response({"id":project_id, "name":name}, status=201)


async def rename_canvas_project(req):
    payload = await req.json()
    project = owned_project(req["user"], req.match_info["pid"])
    name = project_name(payload)
    db.run("UPDATE canvas_projects SET name=? WHERE id=?", name, project["id"])
    return web.json_response({"id":project["id"], "name":name})


async def dissolve_canvas_project(req):
    project = owned_project(req["user"], req.match_info["pid"])
    db.run("DELETE FROM canvas_projects WHERE id=?", project["id"])
    return web.json_response({"ok":True})


async def move_canvas_project(req):
    payload = await req.json()
    if not isinstance(payload, dict) or "project" not in payload:
        raise http_errors.bad("请选择目标项目")
    bid, user = req.match_info["bid"], req["user"]
    if board_meta(board_path(bid)).get("owner") != user["id"]:
        raise http_errors.bad("只有画布所有者可以移动画布")
    project = payload["project"]
    if project is not None:
        owned_project(user, project)
    assign_canvas_project(bid, project)
    return web.json_response({"ok":True, "project":project})


async def list_boards(req):
    u = req["user"]
    BOARDS.mkdir(parents=True, exist_ok=True)
    groups = {row["board_id"]:row["project_id"] for row in db.q(
        """SELECT b.board_id,b.project_id FROM canvas_project_boards b
           JOIN canvas_projects p ON p.id=b.project_id WHERE p.owner=?""", u["id"])}
    out = []
    for f in sorted(BOARDS.glob("*.json"), key=lambda f: -f.stat().st_mtime):
        b = board_meta(f)
        if not b or not can_see(u, b):
            continue
        team = b.get("team")
        if u["role"] == "admin" and req.query.get("all") != "1" and b.get("owner") not in (None, u["id"]) and not b.get("shared") and not (
                team and db.one("SELECT 1 FROM canvas_team_members WHERE team_id=? AND user_id=?",team,u["id"])):
            continue                       # admins see others' private boards only on request (console)
        v = next((n["versions"][n["cur"]] for n in reversed(b.get("nodes", [])) if n.get("type") == "video" and
                  n.get("versions") and type(n.get("cur")) is int and 0<=n["cur"]<len(n["versions"])), None)
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime,
                    "created":b.get("created"), "auto_name":b.get("auto_name"),
                    "owner": b.get("owner"), "shared": bool(b.get("shared")), "wiz": (b.get("wiz") or {}).get("step"),
                    "project":groups.get(f.stem) if b.get("owner") == u["id"] else None, "access":access_role(u,b),"team":team,
                    "cover": (v or {}).get("cover_url") or (v or {}).get("url")})
    return web.json_response(out)


async def list_boards_legacy(req):
    BOARDS.mkdir(parents=True, exist_ok=True)
    old = config.DATA_DIR / "board.json"
    if old.exists() and not any(BOARDS.iterdir()):
        b = json.loads(old.read_text()); b.setdefault("name", "我的画布"); write_board(BOARDS / "default.json", b)
    out = []
    for f in sorted(BOARDS.glob("*.json"), key=lambda f: -f.stat().st_mtime):
        try:
            b = json.loads(f.read_text())
        except ValueError:
            continue
        if not isinstance(b, dict) or not can_see(req["user"], b):
            continue
        out.append({"id": f.stem, "name": b.get("name") or "未命名画布", "nodes": len(b.get("nodes", [])), "mtime": f.stat().st_mtime})
    return web.json_response(out)


async def get_board(req):
    f = board_path(req.match_info["bid"])
    b = board_meta(f)
    if b and not can_see(req["user"], b):
        raise http_errors.bad("没有权限打开这个项目")
    creative_memory.remove_deleted_bindings(b)
    if b:
        b["access"] = access_role(req["user"], b)
        b.pop("collaborators", None)
    return web.json_response(b)


async def put_board(req):
    f = board_path(req.match_info["bid"])
    raw = await req.json()
    if not isinstance(raw, dict):
        raise http_errors.bad("画布数据须为对象")
    data = clean_board(raw)
    u = req["user"]
    old = board_meta(f) if f.exists() else {}
    project_id,team_id = req.query.get("project"),req.query.get("team")
    if project_id is not None or team_id is not None:
        if old:
            raise http_errors.bad("已有画布请使用移动操作")
        validate_canvas_destination(u,project_id,team_id)
    if old and not can_edit(u, old):
        raise web.HTTPForbidden(text='{"error":"当前账号没有编辑权限"}', content_type="application/json")
    data.pop("access", None)
    data.pop("created",None)
    data.pop("collaborators", None)
    data.pop("team",None)
    if old.get("team") or team_id:
        data["team"] = old.get("team") or team_id
    if old.get("collaborators"):
        data["collaborators"] = old["collaborators"]
    if old.get("created"):
        data["created"] = old["created"]
    media_routes.require_media(u, media_routes.media_references(data) - media_routes.media_references(old))
    data["owner"] = old.get("owner") or u["id"]          # the owner never changes through a save
    data["shared"] = bool(data.get("shared")) if (data["owner"] == u["id"] or u["role"] == "admin") else bool(old.get("shared"))
    if data.get("team"):
        data["shared"] = False
    # optimistic concurrency: a page may only overwrite the revision it loaded (another tab, an unload save of a stale
    # page, or a server-side edit would otherwise be silently lost)
    cur = old.get("rev")
    if cur is not None and data.get("rev") != cur:
        return web.json_response({"error": "画布已在别处更新", "stale": True, "rev": cur}, status=409)
    data["rev"] = int(cur or 0) + 1
    write_board(f, data)
    if project_id is not None:
        assign_canvas_project(f.stem, project_id)
    return web.json_response({"ok": True, "rev": data["rev"]})


async def get_workflow_review(req):
    board = board_meta(board_path(req.match_info["bid"]))
    if not board or not can_see(req["user"], board):
        return auth.err(404, "画布不存在或没有访问权限")
    node_id = req.query.get("node")
    version = req.query.get("version")
    if version is not None and (not node_id or not re.fullmatch(r"[1-9][0-9]{0,4}", version)):
        raise http_errors.bad("版本编号格式不正确")
    try:
        report = workflow_review.build(board, node_id, int(version) if version is not None else None)
    except ValueError as e:
        return auth.err(404, str(e))
    return web.json_response({**report, "markdown":workflow_review.markdown(report)})


async def delete_board(req):
    f = board_path(req.match_info["bid"])
    old = board_meta(f) if f.exists() else {}
    if old and not (req["user"]["role"] == "admin" or old.get("owner") in (None, req["user"]["id"])):
        raise http_errors.bad("只有项目的主人可以删除")
    if f.exists():
        f.rename(f.with_suffix(".deleted"))
        db.run("DELETE FROM canvas_comments WHERE board_id=?", f.stem)
        db.run("DELETE FROM canvas_snapshots WHERE board_id=?", f.stem)
        db.run("DELETE FROM shared_canvas_items WHERE board_id=?",f.stem)
        showcase_routes.delete_showcase_entries(f.stem)
    assign_canvas_project(f.stem, None)
    return web.json_response({"ok": True})


def share_details(board):
    members = board.get("collaborators") or {}
    accounts = []
    if members:
        keys = list(members)
        for row in db.q(f"SELECT id,username,name,disabled FROM users WHERE id IN ({','.join('?' for _ in keys)}) ORDER BY username", *keys):
            accounts.append({**row, "role":members[str(row["id"])]})
    return {"shared":bool(board.get("shared")), "collaborators":accounts, "rev":board.get("rev"),"team":board.get("team")}


def team_membership(team_id, user):
    if not isinstance(team_id,str) or not _ID.fullmatch(team_id):
        raise http_errors.bad("团队编号无效")
    team = db.one("""SELECT t.* FROM canvas_teams t JOIN canvas_team_members m ON m.team_id=t.id
                     WHERE t.id=? AND m.user_id=?""", team_id,user["id"])
    if not team:
        raise web.HTTPNotFound()
    return team


async def canvas_teams(req):
    user = req["user"]
    return web.json_response(db.q("""SELECT t.id,t.name,t.owner=? AS managed FROM canvas_teams t
                                    JOIN canvas_team_members m ON m.team_id=t.id
                                    WHERE m.user_id=? ORDER BY t.created,t.id""",user["id"],user["id"]))


async def create_canvas_team(req):
    name = project_name(await req.json())
    owner = req["user"]["id"]
    team_id = "team"+uuid.uuid4().hex[:20]
    with db.transaction():
        db.run("INSERT INTO canvas_teams VALUES(?,?,?,?)",team_id,owner,name,time.time())
        db.run("INSERT INTO canvas_team_members VALUES(?,?)",team_id,owner)
    return web.json_response({"id":team_id,"name":name,"managed":True},status=201)


async def canvas_team_members(req):
    team = team_membership(req.match_info["tid"],req["user"])
    members = db.q("""SELECT u.username,u.name,u.id=t.owner AS manager,u.disabled FROM canvas_team_members m
                      JOIN users u ON u.id=m.user_id JOIN canvas_teams t ON t.id=m.team_id
                      WHERE t.id=? ORDER BY manager DESC,u.username""",team["id"])
    return web.json_response(members)


async def update_canvas_team_members(req):
    team = team_membership(req.match_info["tid"],req["user"])
    if team["owner"] != req["user"]["id"]:
        raise web.HTTPForbidden()
    payload = await req.json()
    username = payload.get("username") if isinstance(payload,dict) else None
    action = payload.get("action") if isinstance(payload,dict) else None
    if not isinstance(username,str) or not username.strip() or action not in ("add","remove"):
        raise http_errors.bad("请输入账号并选择成员操作")
    account = db.one("SELECT id,disabled FROM users WHERE username=?",username.strip())
    if not account or account["id"] == team["owner"] or (action=="add" and account["disabled"]):
        raise http_errors.bad("账号不可用或属于团队创建者")
    if action == "add":
        db.run("INSERT OR IGNORE INTO canvas_team_members VALUES(?,?)",team["id"],account["id"])
    else:
        db.run("DELETE FROM canvas_team_members WHERE team_id=? AND user_id=?",team["id"],account["id"])
    return web.json_response({"ok":True})


def board_to_share(req):
    path = board_path(req.match_info["bid"])
    board = board_meta(path)
    user = req["user"]
    if not board or not can_see(user, board):
        raise web.HTTPNotFound()
    if access_role(user, board) != "owner":
        raise web.HTTPForbidden()
    return path, board


async def get_board_access(req):
    _, board = board_to_share(req)
    return web.json_response(share_details(board))


async def update_board_access(req):
    payload = await req.json()
    path, board = board_to_share(req)
    if not isinstance(payload, dict):
        raise http_errors.bad("分享权限格式无效")
    if "team" in payload:
        if board.get("owner") != req["user"]["id"]:
            raise web.HTTPForbidden()
        if payload["team"] is None:
            board.pop("team",None)
        else:
            board["team"] = team_membership(payload["team"],req["user"])["id"]
        board["shared"] = False
    elif "shared" in payload:
        if type(payload["shared"]) is not bool:
            raise http_errors.bad("团队共享状态无效")
        if board.get("team") and payload["shared"]:
            raise http_errors.bad("请先将画布移回个人空间")
        board["shared"] = payload["shared"]
    elif "username" in payload:
        username, role = payload["username"], payload.get("role")
        if not isinstance(username, str) or not username.strip() or role not in (None, "reviewer", "editor"):
            raise http_errors.bad("请输入账号并选择协作权限")
        account = db.one("SELECT id,role,disabled FROM users WHERE username=?", username.strip())
        if not account:
            raise http_errors.bad("账号不存在")
        key = str(account["id"])
        members = board.setdefault("collaborators", {})
        if role is None:
            members.pop(key, None)
        else:
            if account["role"] == "admin" or account["id"] == board.get("owner") or account["disabled"]:
                raise http_errors.bad("此账号无需邀请或已停用")
            if key not in members and len(members) >= 100:
                raise http_errors.bad("单张画布最多邀请 100 个账号")
            members[key] = role
    else:
        raise http_errors.bad("请选择要修改的分享权限")
    board["rev"] = int(board.get("rev") or 0) + 1
    write_board(path, board)
    return web.json_response(share_details(board))


SAMPLES = config.DATA_DIR / "samples"


async def samples(_):
    """Finished example films made from the wizard's templates (data/samples/samples.json + their boards)."""
    try:
        return web.json_response(json.loads((SAMPLES / "samples.json").read_text()))
    except Exception:
        return web.json_response([])


async def sample_open(req):
    """Copy a sample's whole project into a new board, so every step can be looked at and changed."""
    sid = req.match_info["sid"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        raise http_errors.bad("bad id")
    src = SAMPLES / "boards" / f"{sid}.json"
    if not src.is_file():
        raise http_errors.bad("示例不存在")
    b = json.loads(src.read_text())
    b["name"] = (b.get("name") or "示例") + "（副本）"
    b["owner"] = req["user"]["id"]; b["shared"] = False
    b.pop("collaborators", None)
    b.pop("access", None)
    for n in b.get("nodes", []):
        n["job"] = None
    bid = "b" + uuid.uuid4().hex[:10]
    write_board(board_path(bid), b)
    return web.json_response({"id": bid})


def on_first_admin(uid: int):
    """Everything made before accounts existed belongs to the first administrator; library items stay shared."""
    for f in BOARDS.glob("*.json"):
        b = board_meta(f)
        if b and not b.get("owner"):
            b["owner"] = uid
            write_board(f, b)
    items = legacy_routes.lib_load()
    for a in items:
        a.setdefault("owner", uid); a.setdefault("shared", True)
    if items:
        legacy_routes.LIBRARY.write_text(json.dumps(items, ensure_ascii=False, indent=1))
