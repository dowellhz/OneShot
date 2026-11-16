"""Accounts: scrypt-hashed passwords, cookie sessions, admin/member roles, first-run setup of the admin account."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time

from aiohttp import web

import db

COOKIE = "h3s"
SESSION_DAYS = 30
PUBLIC = ("/login", "/api/auth/", "/static/", "/favicon")
_fails: dict[str, list[float]] = {}


def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), h)
    except Exception:
        return False


def public_user(u: dict | None) -> dict | None:
    if not u:
        return None
    return {k: u.get(k) for k in ("id", "username", "name", "role", "disabled", "created", "last_login")}


def user_of(req) -> dict | None:
    tok = req.cookies.get(COOKIE)
    if not tok:
        return None
    s = db.one("SELECT * FROM sessions WHERE token=?", tok)
    if not s or s["expires"] < time.time():
        return None
    u = db.one("SELECT * FROM users WHERE id=?", s["user_id"])
    return u if u and not u["disabled"] else None


def needs_setup() -> bool:
    return not db.one("SELECT id FROM users LIMIT 1")


def err(status: int, msg: str):
    return web.json_response({"error": msg}, status=status)


@web.middleware
async def middleware(req, handler):
    path = req.path
    if path.startswith(PUBLIC):
        return await handler(req)
    u = user_of(req)
    if not u:
        if path.startswith("/api/") or path.startswith("/media"):
            return err(401, "请先登录")
        raise web.HTTPFound("/login" + ("?next=" + path if path not in ("/", "") else ""))
    req["user"] = u
    if path.startswith("/api/admin/") and u["role"] != "admin":
        return err(403, "需要管理员权限")
    return await handler(req)


def _session(resp, uid: int, req):
    tok = secrets.token_urlsafe(32)
    db.run("INSERT INTO sessions VALUES (?,?,?,?)", tok, uid, time.time(), time.time() + SESSION_DAYS * 86400)
    db.run("UPDATE users SET last_login=? WHERE id=?", time.time(), uid)
    resp.set_cookie(COOKIE, tok, max_age=SESSION_DAYS * 86400, httponly=True, samesite="Lax", path="/")
    return resp


def valid_username(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_.\-]{2,32}", s or ""))


routes = web.RouteTableDef()


@routes.get("/api/auth/state")
async def state(req):
    return web.json_response({"needs_setup": needs_setup(), "user": public_user(user_of(req))})


@routes.post("/api/auth/setup")
async def setup(req):
    """First run only: create the administrator; existing boards and assets become theirs."""
    if not needs_setup():
        return err(400, "已经初始化过了")
    p = await req.json()
    u, pw = (p.get("username") or "").strip(), p.get("password") or ""
    if not valid_username(u):
        return err(400, "用户名 2~32 位，只能用字母、数字、_ . -")
    if len(pw) < 8:
        return err(400, "密码至少 8 位")
    uid = db.run("INSERT INTO users (username, name, pw_hash, role, created) VALUES (?,?,?,?,?)",
                 u, (p.get("name") or u).strip()[:40], hash_pw(pw), "admin", time.time())
    req.app["on_first_admin"](uid)
    return _session(web.json_response({"ok": True}), uid, req)


@routes.post("/api/auth/login")
async def login(req):
    ip = req.remote or "?"
    recent = [t for t in _fails.get(ip, []) if time.time() - t < 600]
    if len(recent) >= 8:
        return err(429, "尝试次数太多，请 10 分钟后再试")
    p = await req.json()
    u = db.one("SELECT * FROM users WHERE username=?", (p.get("username") or "").strip())
    if not u or not check_pw(p.get("password") or "", u["pw_hash"]):
        _fails[ip] = recent + [time.time()]
        return err(400, "用户名或密码不对")
    if u["disabled"]:
        return err(403, "这个账号已停用，请联系管理员")
    _fails.pop(ip, None)
    return _session(web.json_response({"ok": True, "user": public_user(u)}), u["id"], req)


@routes.post("/api/auth/logout")
async def logout(req):
    tok = req.cookies.get(COOKIE)
    if tok:
        db.run("DELETE FROM sessions WHERE token=?", tok)
    r = web.json_response({"ok": True})
    r.del_cookie(COOKIE, path="/")
    return r


@routes.get("/api/me")
async def me(req):
    return web.json_response(public_user(req["user"]))


@routes.post("/api/me/password")
async def my_password(req):
    p = await req.json()
    u = req["user"]
    if not check_pw(p.get("old") or "", u["pw_hash"]):
        return err(400, "原密码不对")
    if len(p.get("new") or "") < 8:
        return err(400, "新密码至少 8 位")
    db.run("UPDATE users SET pw_hash=? WHERE id=?", hash_pw(p["new"]), u["id"])
    db.run("DELETE FROM sessions WHERE user_id=? AND token<>?", u["id"], req.cookies.get(COOKIE))
    return web.json_response({"ok": True})


# ---------------------------------------------------------------- admin: members

@routes.get("/api/admin/users")
async def users(_):
    rows = db.q("SELECT * FROM users ORDER BY id")
    usage = {r["user_id"]: r for r in db.q(
        "SELECT user_id, COUNT(*) n, SUM(COALESCE(cost,0)) cost, MAX(created) last FROM tasks GROUP BY user_id")}
    return web.json_response([{**public_user(r), "tasks": usage.get(r["id"], {}).get("n", 0),
                               "cost": round(usage.get(r["id"], {}).get("cost") or 0, 2)} for r in rows])


@routes.post("/api/admin/users")
async def add_user(req):
    p = await req.json()
    u, pw = (p.get("username") or "").strip(), p.get("password") or ""
    if not valid_username(u):
        return err(400, "用户名 2~32 位，只能用字母、数字、_ . -")
    if len(pw) < 8:
        return err(400, "初始密码至少 8 位")
    if db.one("SELECT id FROM users WHERE username=?", u):
        return err(400, "用户名已存在")
    role = "admin" if p.get("role") == "admin" else "member"
    uid = db.run("INSERT INTO users (username, name, pw_hash, role, created) VALUES (?,?,?,?,?)",
                 u, (p.get("name") or u).strip()[:40], hash_pw(pw), role, time.time())
    return web.json_response({"id": uid})


@routes.put("/api/admin/users/{uid}")
async def edit_user(req):
    uid = int(req.match_info["uid"])
    p = await req.json()
    me_ = req["user"]
    target = db.one("SELECT * FROM users WHERE id=?", uid)
    if not target:
        return err(404, "没有这个用户")
    if "role" in p or "disabled" in p:
        if uid == me_["id"]:
            return err(400, "不能修改自己的角色或停用自己")
    if "name" in p:
        db.run("UPDATE users SET name=? WHERE id=?", (p["name"] or "").strip()[:40], uid)
    if "role" in p:
        db.run("UPDATE users SET role=? WHERE id=?", "admin" if p["role"] == "admin" else "member", uid)
    if "disabled" in p:
        db.run("UPDATE users SET disabled=? WHERE id=?", 1 if p["disabled"] else 0, uid)
        if p["disabled"]:
            db.run("DELETE FROM sessions WHERE user_id=?", uid)
    if p.get("password"):
        if len(p["password"]) < 8:
            return err(400, "密码至少 8 位")
        db.run("UPDATE users SET pw_hash=? WHERE id=?", hash_pw(p["password"]), uid)
        db.run("DELETE FROM sessions WHERE user_id=?", uid)
    return web.json_response({"ok": True})
