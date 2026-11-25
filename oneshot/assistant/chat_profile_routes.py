"""Read and update confirmed assistant profile preferences."""
from __future__ import annotations

from aiohttp import web

from oneshot.assistant import creative_profile
from oneshot.assistant.chat_http import service, session_for
from oneshot.assistant.chat_state import ToolError
from oneshot.storage import db


async def get_profile(req):
    user, bid = req["user"],req.query.get("board","")
    try:
        service(req).board(user,bid)
    except ToolError as e:
        return web.json_response({"error":str(e)},status=403)
    return web.json_response(creative_profile.get(user["id"],bid))


async def update_profile(req):
    payload = await req.json()
    if not isinstance(payload,dict) or set(payload)!={"board","changes"}:
        return web.json_response({"error":"记忆请求格式不正确"},status=400)
    user, bid = req["user"],payload["board"]
    try:
        service(req).board(user,bid)
    except ToolError as e:
        return web.json_response({"error":str(e)},status=403)
    try:
        return web.json_response(creative_profile.update(user["id"],bid,payload["changes"]))
    except ValueError as e:
        return web.json_response({"error":str(e)},status=409)


async def decide_profile(req):
    session = session_for(req,req.match_info["sid"])
    payload = await req.json()
    decision = payload.get("decision") if isinstance(payload,dict) else None
    if decision not in ("save","dismiss"):
        return web.json_response({"error":"请选择记住或忽略"},status=400)
    cid = req.match_info["cid"]
    try:
        with db.transaction():
            result = creative_profile.decide(req["user"]["id"],session,cid,decision)
            if result is None:
                raise web.HTTPNotFound()
            rid, changed = result
            if changed:
                service(req).emit(session["id"],rid,"profile_decision",{"id":cid,"decision":decision})
    except ValueError as e:
        return web.json_response({"error":str(e)},status=409)
    return web.json_response({"decision":decision})
