"""Compatibility endpoints for the original asset library."""

import json

from aiohttp import web

from oneshot import config
from oneshot.memory import creative_memory
from oneshot.storage import db


LIBRARY = config.DATA_DIR / "library.json"


def legacy_lib_load() -> list:
    try:
        return json.loads(LIBRARY.read_text())
    except Exception:
        return []


def lib_load() -> list:
    from oneshot import app as application

    return creative_memory.Store(application).all()


async def library(req):
    return web.json_response(req.app["creative_memory"].list(req["user"], req.query.get("board") or None))


async def library_put(req):
    data = await req.json()
    store = req.app["creative_memory"]
    if isinstance(data, dict) and data.pop("recreate_deleted", False):
        mid = data.get("id")
        if isinstance(mid, str) and db.one("SELECT 1 FROM creative_memories WHERE id=? AND deleted=1", mid):
            data.pop("id")
            if not {"board","project","team"} & data.keys() and (bid := data.get("source_board")):
                data.update(store.default_scope(req["user"],bid))
    return web.json_response(store.put(req["user"], data))


async def library_del(req):
    req.app["creative_memory"].delete(req["user"], req.match_info["aid"])
    return web.json_response({"ok": True})
