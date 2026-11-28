"""Shared HTTP error responses and text handling."""

import json
import time

from aiohttp import web


def clean(s) -> str:
    return " ".join(str(s or "").split()) if s else ""


def bad(msg):
    return web.HTTPBadRequest(text=json.dumps({"error": msg}, ensure_ascii=False), content_type="application/json")


async def llm_call(req, coro):
    """Run a Qwen tool; tell the user when it has to fall back to the (slow) CPU because a generation holds the GPU."""
    return web.json_response(await llm_result(req.app["llm"], coro))


async def llm_result(llm, coro):
    if not llm.available():
        coro.close()
        raise bad("本地 Qwen 模型还没装好")
    t0 = time.time()
    try:
        r = await coro
    except web.HTTPException:
        raise
    except Exception as e:
        raise bad(str(e) or e.__class__.__name__)
    r["seconds"] = round(time.time() - t0, 1)
    r["device"] = llm.via
    return r
