"""Resolve the assistant service and enforce access to a chat session."""
from __future__ import annotations

from aiohttp import web

from oneshot.assistant.chat_state import ToolError
from oneshot.storage import db


def service(req):
    return req.app["agent_chat"]


def session_for(req, sid):
    row = db.one("SELECT * FROM chat_sessions WHERE id=? AND user_id=?", sid, req["user"]["id"])
    if not row:
        raise web.HTTPNotFound(text="会话不存在")
    try:
        service(req).board(req["user"], row["board_id"])
    except ToolError as e:
        raise web.HTTPForbidden(text=str(e)) from None
    return row
