"""Queue progress and time estimates used by the workspace and console."""
import aiohttp
from aiohttp import web

from oneshot import config
from oneshot.generation import jobs


async def queue(req):
    """Everything this canvas has queued or running, in order, with the time until each is done."""
    try:
        async with req.app["http"].get(f"{config.COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
            q = await r.json()
        order = [x[1] for x in q.get("queue_running", [])] + [x[1] for x in sorted(q.get("queue_pending", []), key=lambda x: x[0])]
    except Exception:
        order = []
    out, t = [], 0.0
    for i in order:                      # ComfyUI's queue, in execution order (foreign jobs count with a guess)
        j = jobs.JOBS.get(i)
        if j and j["state"] in ("done", "error"):
            continue
        t += jobs.remaining(j) if j else 90
        if j:
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"),
                        "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in jobs.JOBS.items():            # our engine's jobs, in submission order (those still being prepared last)
        if j.get("out_ref") and j["state"] in ("queued", "running"):
            t += jobs.remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"), "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in jobs.JOBS.items():
        if j.get("prep") and j["state"] == "queued":
            t += jobs.remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": "queued", "label": (m.get("label") or "视频") + " · 翻译提示词", "eta": round(t), "value": None, "max": None})
    rt = 0.0
    for i, j in jobs.JOBS.items():            # renders run beside ComfyUI
        if j.get("kind") == "render" and j["state"] in ("queued", "running"):
            rt += jobs.remaining(j)
            out.append({"id": i, "kind": "render", "state": j["state"], "label": (j.get("meta") or {}).get("label") or "成片",
                        "eta": round(rt), "value": j.get("value"), "max": j.get("max")})
    audio_eta = 0
    for i,j in jobs.JOBS.items():
        if j.get("kind")=="audio" and j["state"] in ("queued","running"):
            eta = round(jobs.remaining(j))
            audio_eta = max(audio_eta,eta)
            out.append({"id":i,"kind":"audio","state":j["state"],"label":j["meta"]["label"],"eta":eta})
    foreign = sum(1 for i in order if i not in jobs.JOBS)
    return web.json_response({"jobs": out, "total": round(max(t, rt, audio_eta)), "foreign": foreign})
