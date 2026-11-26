"""H3 engine service: one resident process on 127.0.0.1:8189 that owns the GPU and runs one job at a time.

  POST /jobs     {"kind": "video", "prompt", "image"?, "last_image"?, "references"?: [path], "seconds", "height", "width",
                  "steps", "seed", "turbo", "out"}                     -> {"id"}
  GET  /jobs?ids=a,b                                                   -> {id: {state, value, max, error, out, took, ahead}}
  POST /cancel   {"ids": [...]}
  GET  /status                                                         -> {ready, loaded, queue, running, vram}
  POST /free                                                           -> drop the transformer (frees ~62 GB of RAM)

States: queued → running → done | error. `value/max` counts transformer forward passes (denoising steps).
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")   # shapes change every job: less fragmentation
import torch
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent))
import h3engine as E
import h3_int8
import image_models
import editor_tools as EDITOR

PORT = int(os.environ.get("H3_ENGINE_PORT", "8189"))
JOBS: dict[str, dict] = {}
Q: "queue.Queue[str]" = queue.Queue()
STATE = {"ready": False, "loading": "starting", "running": None, "error": None}
ENGINE: E.Engine | None = None
EDITOR_CPU_LOCK = asyncio.Lock()


class Cancelled(Exception):
    pass


def progress_hook(module, args, kwargs):
    j = JOBS.get(STATE["running"] or "")
    if j:
        if j.get("cancel"):
            raise Cancelled()
        j["phase"] = "sampling"
        j["value"] = j.get("value", 0) + 1
    return None


def decoding_hook(module, args):
    j = JOBS.get(STATE["running"] or "")
    if j:
        if j.get("cancel"):
            raise Cancelled()
        j["phase"] = "decoding"


def watch_decoder(vae):
    decoder = getattr(vae, "decoder", None)
    if decoder is not None and not getattr(decoder, "_editor_hooked", False):
        decoder.register_forward_pre_hook(decoding_hook)
        decoder._editor_hooked = True


def load_image(path):
    from PIL import Image
    return Image.open(path).convert("RGB")


def worker():
    global ENGINE
    try:
        STATE["loading"] = "loading text encoder and VAEs"
        ENGINE = E.Engine()
        STATE.update(ready=True, loading=None)
    except Exception as e:
        STATE.update(loading=None, error=f"engine failed to start: {e}")
        traceback.print_exc()
        return
    while True:
        jid = Q.get()
        if jid == "__free__":             # unloading happens here, never on the web thread while a job runs
            try:
                ENGINE._drop_big()
                EDITOR.drop_inpaint()
            except Exception:
                traceback.print_exc()
            continue
        j = JOBS.get(jid)
        if not j or j.get("cancel"):
            continue
        STATE["running"] = jid
        model = None                      # never keep a reference to a big model across jobs (it pins ~62 GB)
        try:
            j.update(state="running", started=time.time(), value=0, max=int(j["req"].get("steps") or 4))
            r = j["req"]
            if r.get("kind") == "inpaint":
                ENGINE._drop_big()
                def report(phase, value, maximum):
                    j.update(phase=phase, value=value, max=maximum)
                t0 = time.time()
                EDITOR.inpaint(r, report, lambda: bool(j.get("cancel")))
                j.update(state="done", took=round(time.time() - t0, 1), finished=time.time(), phase="done")
                continue
            EDITOR.drop_inpaint()
            if r.get("kind") == "video_int8":
                ENGINE._drop_big()
                t0 = time.time()

                def report(phase, value, maximum):
                    j.update(phase=phase, value=value, max=maximum)

                h3_int8.run(r["graph"], r["out"], r["media_dir"], r["seed"], report, lambda: bool(j.get("cancel")))
                j.update(state="done", took=round(time.time() - t0, 1), finished=time.time(), phase="done")
                continue
            if r.get("kind") == "image":
                if r.get("image_model"):
                    ENGINE._drop_big()
                    t0 = time.time()

                    def report(phase, value, maximum):
                        j.update(phase=phase, value=value, max=maximum)

                    image_models.generate(r, [load_image(path) for path in r.get("images") or []],
                                          report, lambda: bool(j.get("cancel")))
                    if j.get("cancel"):
                        raise Cancelled()
                    j.update(state="done", took=round(time.time() - t0, 1), finished=time.time(), phase="done")
                    continue
                if not ENGINE.image_ready():
                    raise RuntimeError("H3-Image 权重还在下载")
                j["phase"] = "loading" if ENGINE.task != "image" else "encoding"
                ENGINE.use_image()
                j["phase"] = "encoding"
                watch_decoder(ENGINE.ipipe.vae)
                j["max"] = int(r.get("steps") or 6)
                model = ENGINE.ipipe.transformer
                if not getattr(model, "_h3_hooked", False):
                    model.register_forward_pre_hook(progress_hook, with_kwargs=True); model._h3_hooked = True
                took = ENGINE.generate_image(r["prompt"], r["out"], images=[load_image(x) for x in r.get("images") or []] or None,
                                             height=int(r.get("height") or 2048), width=int(r.get("width") or 2048),
                                             steps=r.get("steps"), seed=int(r.get("seed") or 0))
                j.update(state="done", took=round(took, 1), finished=time.time())
                continue
            refs = None
            if r.get("references"):
                from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference
                refs = [MiniMaxH3ImageReference(image=load_image(p)) for p in r["references"]]
            kfs = [(load_image(k["path"]), int(k["frame"])) for k in r.get("keyframes") or []]
            task = "ref2va" if refs or kfs else "fl2va"
            j["phase"] = "loading" if ENGINE.task != task else "encoding"
            lora = E.pick_lora(task, r.get("height"), r.get("width"), bool(r.get("turbo", True)))
            ENGINE.use(task, lora)
            if j.get("cancel"):
                raise Cancelled()
            j["phase"] = "encoding"
            watch_decoder(ENGINE.pipe.vae)
            model = ENGINE.pipe.transformer_ref if task == "ref2va" else ENGINE.pipe.transformer
            if not getattr(model, "_h3_hooked", False):   # marked on the model: ids get reused after a model is freed
                model.register_forward_pre_hook(progress_hook, with_kwargs=True)
                model._h3_hooked = True
            took = ENGINE.generate(r["prompt"], r["out"], image=load_image(r["image"]) if r.get("image") else None,
                                   last_image=load_image(r["last_image"]) if r.get("last_image") else None, references=refs,
                                   seconds=float(r.get("seconds") or 5.2), height=r.get("height"), width=r.get("width"),
                                   steps=int(r.get("steps") or 4), seed=int(r.get("seed") or 0), turbo=bool(r.get("turbo", True)),
                                   frames=r.get("frames"), lora=lora, keyframes=kfs)
            j.update(state="done", took=round(took, 1), finished=time.time())
        except (Cancelled, InterruptedError):
            j.update(state="error", error="已取消", finished=time.time())
        except Exception as e:
            traceback.print_exc()
            msg = str(e) or e.__class__.__name__
            if isinstance(e, torch.OutOfMemoryError):
                msg = "显存不够：试试降低分辨率或时长"
            j.update(state="error", error=msg[:500], finished=time.time())
        finally:
            STATE["running"] = None
            model = None
            torch.cuda.empty_cache()


routes = web.RouteTableDef()


@routes.post("/jobs")
async def submit(req):
    r = await req.json()
    if not r.get("prompt") or not r.get("out"):
        return web.json_response({"error": "prompt and out are required"}, status=400)
    if STATE.get("error"):
        return web.json_response({"error": STATE["error"]}, status=503)
    if r.get("kind") == "video_int8" and not h3_int8.installed():
        return web.json_response({"error": "H3 INT8 ConvRot 尚未安装"}, status=503)
    if r.get("kind") == "image" and r.get("image_model") and not image_models.installed(r["image_model"]):
        return web.json_response({"error": "所选图像模型尚未安装"}, status=503)
    try:                                   # a bad number must be refused here, not crash the worker later
        for k in ("steps", "seed", "height", "width", "frames"):
            if r.get(k) is not None:
                r[k] = int(r[k])
        if r.get("seconds") is not None:
            r["seconds"] = float(r["seconds"])
    except (TypeError, ValueError):
        return web.json_response({"error": f"参数格式不对：{k}"}, status=400)
    jid = "e" + uuid.uuid4().hex[:12]
    JOBS[jid] = {"id": jid, "state": "queued", "created": time.time(), "req": r}
    Q.put(jid)
    return web.json_response({"id": jid})


@routes.get("/jobs")
async def jobs(req):
    ids = [i for i in req.query.get("ids", "").split(",") if i]
    pending = [k for k, v in JOBS.items() if v["state"] == "queued"]
    out = {}
    for i in ids:
        j = JOBS.get(i)
        if not j:
            out[i] = {"state": "error", "error": "引擎里没有这个任务（引擎重启过）"}
            continue
        o = {k: j.get(k) for k in ("state", "value", "max", "error", "took", "phase", "started", "finished")}
        o["out"] = j["req"]["out"] if j["state"] == "done" else None
        if j["state"] == "queued":
            o["ahead"] = pending.index(i) + (1 if STATE["running"] else 0)
        out[i] = o
    return web.json_response(out)


@routes.post("/cancel")
async def cancel(req):
    for i in (await req.json()).get("ids", []):
        if i in JOBS and JOBS[i]["state"] in ("queued", "running"):
            JOBS[i]["cancel"] = True
            if JOBS[i]["state"] == "queued":
                JOBS[i].update(state="error", error="已取消")
    return web.json_response({"ok": True})


@routes.get("/status")
async def status(_):
    free, total = torch.cuda.mem_get_info() if torch.cuda.is_available() else (0, 0)
    return web.json_response({**{k: STATE[k] for k in ("ready", "loading", "running", "error")},
                              "image_ready": bool(ENGINE and ENGINE.image_ready()),
                              "image_models": [model for model in image_models.MODELS if image_models.installed(model)],
                              "int8_ready": h3_int8.installed(),
                              "loaded": ENGINE and {"task": ENGINE.task, "lora": ENGINE.lora},
                              "queue": sum(1 for v in JOBS.values() if v["state"] == "queued"),
                              "vram_used_gb": round((total - free) / 2**30, 1), "editor": EDITOR.capabilities()})


@routes.post("/tools/{tool}")
async def editor_tool(req):
    tool = req.match_info["tool"]
    if tool not in ("segment", "cutout", "decompose"):
        raise web.HTTPNotFound()
    p = await req.json()
    try:
        async with EDITOR_CPU_LOCK:
            if tool == "segment":
                result = await asyncio.to_thread(EDITOR.segment, p["image"], p.get("points"), p["out"])
            elif tool == "cutout":
                result = await asyncio.to_thread(EDITOR.cutout, p["image"], p["out"])
            else:
                result = await asyncio.to_thread(EDITOR.decompose, p["image"], p["out"])
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"error": str(e)[:500]}, status=400)


@routes.post("/free")
async def free(_):
    if ENGINE:
        Q.put("__free__")                  # done by the worker between jobs
    return web.json_response({"ok": True})


def main():
    try:   # if memory ever runs out, the kernel should take the engine, not the canvas server or the DeepSeek web
        open("/proc/self/oom_score_adj", "w").write("800")
    except Exception:
        pass
    threading.Thread(target=worker, daemon=True).start()
    app = web.Application(client_max_size=8 << 20)
    app.add_routes(routes)
    web.run_app(app, host="127.0.0.1", port=PORT, print=lambda *_: print(f"H3 engine on 127.0.0.1:{PORT}", flush=True))


if __name__ == "__main__":
    main()
