"""Provider administration, task history, and service status."""

import json
import time

import aiohttp
from aiohttp import web

from oneshot import config
from oneshot.generation import jobs as generation_jobs
from oneshot.providers import catalog as providers
from oneshot.providers.selection import configured_models
from oneshot.storage import db
from oneshot.web import http as http_errors


async def admin_providers(_):
    catalog = dict(providers.CATALOG)
    local_h3 = catalog["local_h3"]
    catalog["local_h3"] = {**local_h3, "models": {
        **local_h3["models"], "image": configured_models({"id":"local_h3", "kind":"local_h3"}, "image", []),
    }}
    return web.json_response({"providers": [providers.public(x) for x in providers.all_providers()],
                              "catalog": catalog, "caps": providers.CAPS,
                              "routes": {c: [{"provider_id": r["provider"]["id"], "model": r["model"]} for r in providers.routes(c)] for c in providers.CAPS}})


async def admin_provider_save(req):
    p = await req.json()
    try:
        pid = providers.save(p.get("id"), p.get("kind"), p.get("name"), p.get("config") or {}, p.get("secrets") or {}, p.get("enabled", True))
    except providers.ProviderError as e:
        raise http_errors.bad(str(e))
    return web.json_response({"id": pid})


async def admin_provider_del(req):
    try:
        providers.delete(req.match_info["pid"])
    except providers.ProviderError as e:
        raise http_errors.bad(str(e))
    return web.json_response({"ok": True})


async def admin_provider_test(req):
    p = providers.get(req.match_info["pid"])
    if not p:
        raise http_errors.bad("没有这个服务")
    t0 = time.time()
    try:
        r = await providers.test(req.app["http"], p)
    except Exception as e:
        raise http_errors.bad(str(e) or e.__class__.__name__)
    r["seconds"] = round(time.time() - t0, 1)
    return web.json_response(r)


def llm_choices() -> dict:
    lst = [{"id": p["id"], "name": p["name"], "kind": p["kind"], "local": p["kind"].startswith("local_"),
            "model": providers.default_model(p, "text"), "vision": "vision" in providers.caps_of(p)}
           for p in providers.all_providers() if p["enabled"] and "text" in providers.caps_of(p)]
    cur = providers.primary("text")
    return {"choices": lst, "current": cur["provider"]["id"] if cur else None}


async def llm_get(_):
    return web.json_response(llm_choices())


async def llm_put(req):
    """The chosen provider goes first for text (and for vision when it can see); the others stay behind it as fallbacks."""
    pid = http_errors.clean((await req.json()).get("provider"))
    p = providers.get(pid)
    if not p or not p["enabled"] or "text" not in providers.caps_of(p):
        raise http_errors.bad("这个模型不可用")
    for cap in ("text", "vision"):
        if cap not in providers.caps_of(p):
            continue
        rest = [{"provider_id": r["provider"]["id"], "model": r["model"]} for r in providers.routes(cap) if r["provider"]["id"] != pid]
        for q in providers.all_providers():          # every usable one becomes a fallback, local Qwen last resort included
            if q["enabled"] and cap in providers.caps_of(q) and q["id"] != pid and not any(x["provider_id"] == q["id"] for x in rest):
                rest.append({"provider_id": q["id"], "model": None})
        providers.set_route(cap, [{"provider_id": pid, "model": None}] + rest)
    if pid != "local_qwen" and req.app["llm"].running():
        req.app["llm"].stop()                        # local Qwen not needed now; free its memory
    return web.json_response(llm_choices())


async def admin_route(req):
    items = (await req.json()).get("items") or []
    try:
        providers.set_route(req.match_info["cap"], items)
    except providers.ProviderError as e:
        raise http_errors.bad(str(e))
    return web.json_response({"ok": True})


async def task_list(req):
    """Task center: mine, or everyone's for admins (?all=1); with totals for the period."""
    u = req["user"]
    days = max(1, min(90, int(req.query.get("days") or 7)))
    since = time.time() - days * 86400
    every = u["role"] == "admin" and req.query.get("all") == "1"
    where, args = "created>?", [since]
    if not every:
        where += " AND user_id=?"; args.append(u["id"])
    if req.query.get("state"):
        where += " AND state=?"; args.append(req.query["state"])
    rows = db.q(f"SELECT id,user_id,board_id,label,capability,provider_id,provider_kind,model,state,created,started,finished,seconds,cost,error,outputs "
                f"FROM tasks WHERE {where} ORDER BY created DESC LIMIT 300", *args)
    names = {x["id"]: x["name"] or x["username"] for x in db.q("SELECT id,name,username FROM users")}
    pnames = {x["id"]: x["name"] for x in db.q("SELECT id,name FROM providers")}
    for r in rows:
        r["user"] = names.get(r["user_id"]); r["provider"] = pnames.get(r["provider_id"], r["provider_id"])
        try:
            r["outputs"] = json.loads(r["outputs"] or "[]")
        except ValueError:
            r["outputs"] = []
        live = generation_jobs.JOBS.get(r["id"])
        if live and r["state"] in ("queued", "running"):
            r["state"] = live["state"]; r["eta"] = round(generation_jobs.remaining(live))
    tot = db.q(f"SELECT provider_id, capability, COUNT(*) n, SUM(state='done') ok, SUM(state='error') bad, SUM(COALESCE(seconds,0)) secs, SUM(COALESCE(cost,0)) cost "
               f"FROM tasks WHERE {where} GROUP BY provider_id, capability", *args)
    for t in tot:
        t["provider"] = pnames.get(t["provider_id"], t["provider_id"])
    return web.json_response({"tasks": rows, "totals": tot, "days": days})


def text_name():
    r = providers.primary("text")
    return None if not r or r["provider"]["kind"] == "local_qwen" else f'{r["provider"]["name"]}（{r["model"]}）'


async def status(req):
    try:   # our engine first; the old ComfyUI only if it still runs
        async with req.app["http"].get(config.ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            s = await r.json()
        llm = req.app["llm"]
        return web.json_response({"comfy": bool(s.get("ready")), "engine": True, "loading": s.get("loading"),
                                  "running": 1 if s.get("running") else 0, "pending": s.get("queue", 0),
                                  "llm": llm.available(), "llm_running": llm.running(), "llm_device": llm.device if llm.running() else None,
                                  "remote": text_name()})
    except Exception:
        pass
    try:
        async with req.app["http"].get(f"{config.COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
            q = await r.json()
        llm = req.app["llm"]
        return web.json_response({"comfy": True, "running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", [])),
                                  "llm": llm.available(), "llm_running": llm.running(), "llm_device": llm.device if llm.running() else None,
                                  "remote": text_name()})
    except Exception:
        return web.json_response({"comfy": False})
