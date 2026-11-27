"""Submit prepared H3 requests to the local inference service."""

import asyncio
import json
import re
import time
import uuid

import aiohttp
from aiohttp import web

from engine import h3_int8, image_models, sulphur
from oneshot import config
from oneshot.generation import graphs
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import prompts
from oneshot.generation import tools
from oneshot.storage import db
from oneshot.web import http as http_errors


async def engine_up(app, image: bool = False, *, int8: bool = False, image_model: str | None = None,
                    sulphur_video: bool = False) -> bool:
    try:
        async with app["http"].get(config.ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            s = await r.json()
            return (bool(s.get("ready")) and (not image or bool(s.get("image_ready")))
                    and (not int8 or bool(s.get("int8_ready")))
                    and (not sulphur_video or bool(s.get("sulphur_ready")))
                    and (not image_model or image_model in s.get("image_models", ())))
    except Exception:
        return False


async def generate_engine_image(req, p: dict, count: int, *, model=None, expanded=None):
    """Queue a local image generation or edit."""
    u = req["user"]
    imgs = p.get("images") or []
    ar = float(p.get("ar") or 1)
    spec = image_models.MODELS.get(model)
    high = p.get("quality") == "16mp"
    if spec and len(imgs) > spec.references:
        raise http_errors.bad(f"{spec.label} 最多使用 {spec.references} 张参考图")
    mp = (4.0 if high and spec.high_resolution else 1.0) if spec else (16.0 if high else 4.0)
    w, h = graphs.size_for(ar, mp, 32)
    prompt = p["prompt"] if spec else re.sub(r"@图(\d+)", r"<Picture \1>", p["prompt"])
    paths = [str(tools.ref_path(config.COMFY_DIR, im["ref"])) for im in imgs]
    cls, units, dflt = generation_jobs.job_class(p)
    meta = {"prompt": p["prompt"], "cls": cls, "units": units, "est": generation_jobs.estimate(cls, units, dflt), "label": http_errors.clean(p.get("label"))[:60],
            "uid": u["id"], "board": http_errors.clean(p.get("board")), "engine": True, "width": w, "height": h,
            "mode_name": ("以图改图" if paths else "文生图") + f" · {round(w * h / 1e6)}MP"}
    if expanded:
        meta.update(expanded=expanded, mode_name=meta["mode_name"] + " · 扩写")
    if spec:
        meta.update(model=model, provider_id="local_h3", mode_name=f"{spec.label} · {meta['mode_name']}")
    ids = []
    for k in range(max(1, min(4, count))):
        seed = graphs.seed_of(p.get("seed")) + k
        name = f"image_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}.png"
        out = config.COMFY_DIR / "output" / "h3studio" / name
        out.parent.mkdir(parents=True, exist_ok=True)
        body = {"kind": "image", "prompt": prompt, "images": paths, "height": h, "width": w,
                "seed": seed, "out": str(out)}
        if spec:
            body.update(image_model=model, steps=spec.steps)
        async with req.app["http"].post(config.ENGINE + "/jobs", json=body, timeout=aiohttp.ClientTimeout(total=10)) as r:
            response = await r.json()
            if not response.get("id"):
                if not ids:
                    raise http_errors.bad(response.get("error") or "图像模型暂不可用")
                break
            jid = response["id"]
        generation_jobs.JOBS[jid] = {"id": jid, "kind": "image", "state": "queued", "created": time.time(), "meta": dict(meta, seed=seed),
                     "out_ref": f"output:h3studio/{name}"}
        generation_jobs.attach_image_edit(generation_jobs.JOBS[jid], p)
        db.task_start(id=jid, user_id=u["id"], board_id=meta["board"], label=meta["label"], capability="image", provider_id="local_h3",
                      provider_kind="local_h3", model=model if spec else "H3-Image " + meta["mode_name"], state="queued", cost=0)
        ids.append(jid)
    asyncio.create_task(generation_jobs.follow_engine(req.app))
    return web.json_response({"ids": ids, "meta": generation_jobs.JOBS[ids[0]]["meta"]})


async def generate_native_image(req, p):
    native = p["_native_inpaint"]
    # Native SD prompts use CLIP's English vocabulary. Translate through the configured text route when needed.
    prompt = native["prompt"]
    if not req.get("replaying_effective_image") and re.search(r"[\u4e00-\u9fff]", prompt):
        llm = req.app["llm"]
        try:
            prompt = http_errors.clean(await llm.chat("Translate the image editing instruction into a concise English image description. Return only the English description, without commentary.", prompt, max_tokens=180, temperature=.1))
        except Exception as e:
            raise http_errors.bad(f"原生重绘提示词翻译失败：{e}；也可直接填写英文")
        if llm.running() and llm.device == "GPU":
            llm.stop()
    out, ref = tools._new(config.COMFY_DIR, "output", "inpaint", ".png")
    req["effective_image_prompt"] = prompt
    seed = graphs.seed_of(p.get("seed"))
    body = {**native, "kind": "inpaint", "prompt": prompt, "seed": seed, "out": str(out),
            "image": str(tools.ref_path(config.COMFY_DIR, native["image"])), "mask": str(tools.ref_path(config.COMFY_DIR, native["mask"]))}
    try:
        async with req.app["http"].post(config.ENGINE + "/jobs", json=body, timeout=aiohttp.ClientTimeout(total=10)) as r:
            response = await r.json()
            if r.status != 200 or not response.get("id"):
                raise ValueError(response.get("error") or "原生重绘引擎未就绪")
    except (ValueError, aiohttp.ClientError, asyncio.TimeoutError) as e:
        raise http_errors.bad(str(e))
    jid = response["id"]; uid = req["user"]["id"]
    meta = {"prompt": p["_image_edit"]["prompt"], "label": http_errors.clean(p.get("label"))[:60], "uid": uid,
            "board": http_errors.clean(p.get("board")), "seed": seed, "engine": True, "est": 25, "cls": "native-inpaint", "units": 1}
    j = generation_jobs.JOBS[jid] = {"id": jid, "kind": "image", "state": "queued", "created": time.time(), "meta": meta, "out_ref": ref}
    generation_jobs.attach_image_edit(j, p)
    db.task_start(id=jid, user_id=uid, board_id=meta["board"], label=meta["label"], capability="image", provider_id="local_h3",
                  provider_kind="local_h3", model="SD 原生遮罩重绘", state="queued", cost=0)
    asyncio.create_task(generation_jobs.follow_engine(req.app))
    return web.json_response({"ids": [jid], "meta": meta})


async def generate_engine(req, p: dict, count: int):
    """Queue the video at once (ids 'p…'); the prompt is translated to English and the job handed to the engine in the
    background, in click order, so 生成 answers immediately."""
    u = req["user"]
    _, meta = graphs.graph_video(p, native=True)            # mode name, seed and size for the queue entry (prompt rebuilt later)
    cls, units, dflt = generation_jobs.job_class(p)
    if p.get("_sulphur"):
        cls, _, dflt = generation_jobs.job_class({**p, "turbo": False})
        cls = f"{sulphur.MODEL}|{cls}"
    model_label = sulphur.LABEL if p.get("_sulphur") else h3_int8.LABEL if p.get("_int8") else "MiniMax-H3 " + meta["mode_name"]
    meta.update(prompt=p["prompt"], cls=cls, units=units, est=generation_jobs.estimate(cls, units, dflt), label=http_errors.clean(p.get("label"))[:60], uid=u["id"],
                board=http_errors.clean(p.get("board")), engine=True)
    pids = []
    for k in range(count):
        pid = "p" + uuid.uuid4().hex[:12]
        m = dict(meta, seed=meta["seed"] + k)
        generation_jobs.JOBS[pid] = {"id": pid, "kind": "video", "state": "queued", "prep": True, "created": time.time(), "meta": m}
        db.task_start(id=pid, user_id=u["id"], board_id=m["board"], label=m["label"], capability="video", provider_id="local_h3",
                      provider_kind="local_h3", model=model_label, state="queued", cost=0)
        pids.append(pid)
    prev = PREP_TAIL[0]
    PREP_TAIL[0] = asyncio.create_task(prepare_engine(req.app, p, pids, prev))
    return web.json_response({"ids": pids, "meta": generation_jobs.JOBS[pids[0]]["meta"]})


PREP_TAIL = [None]   # the last prepare task: each one waits for the one before, so jobs reach the engine in click order


async def prepare_engine(app, p: dict, pids: list, prev):
    if prev is not None:
        try:
            await prev
        except Exception:
            pass
    if not any(generation_jobs.JOBS.get(i, {}).get("state") == "queued" for i in pids):
        return                                       # all cancelled while waiting
    try:
        q = await prompts.to_english(app, p)
        llm = app["llm"]
        if llm.running() and llm.device == "GPU":
            llm.stop()                               # give the GPU back to the engine
        if q.get("_int8") or q.get("_sulphur"):
            graph, meta = graphs.graph_video(q, native=True)
            body = {"kind": "video_int8", "graph": graph, "media_dir": str(config.COMFY_DIR), "prompt": meta["full_prompt"], "steps": meta["steps"]}
            if q.get("_sulphur"):
                body["video_model"] = sulphur.MODEL
        else:
            body, meta = engine_body(q)
        for pid in pids:
            j = generation_jobs.JOBS.get(pid)
            if not j or j["state"] != "queued":
                continue
            m = dict(meta, **{k: j["meta"][k] for k in ("prompt", "cls", "units", "est", "label", "uid", "board", "engine", "seed")})
            if q.get("_xlate_err"):
                m["mode_name"] = m.get("mode_name", "") + " · 未翻译"
            name = f"video_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}.mp4"
            out = config.COMFY_DIR / "output" / "h3studio" / name
            out.parent.mkdir(parents=True, exist_ok=True)
            async with app["http"].post(config.ENGINE + "/jobs", json={**body, "seed": m["seed"], "out": str(out)}) as r:
                jr = await r.json()
            if j.get("cancel"):
                if jr.get("id"):
                    await generation_jobs.cancel_engine_jobs(app, [jr["id"]])
                continue
            if "id" not in jr:
                j["state"] = "error"; j["error"] = f"本地引擎拒绝了任务：{jr.get('error')}"; generation_jobs.log_end(j)
                continue
            j.update(meta=m, eid=jr["id"], out_ref=f"output:h3studio/{name}")
            db.task_update(pid, request=json.dumps({"engine": {"id": j["eid"], "out_ref": j["out_ref"]},
                                                    "history":{**generation_jobs.video_job_details(m),"seed":m["seed"]}}))
            j.pop("prep", None)
        asyncio.create_task(generation_jobs.follow_engine(app))
    except Exception as e:
        for pid in pids:
            j = generation_jobs.JOBS.get(pid)
            if j and j["state"] == "queued":
                j["state"] = "error"; j["error"] = f"提交失败：{e}"; generation_jobs.log_end(j)


def engine_body(p: dict):
    """The same request the ComfyUI graph was built from, sent to the engine: prompt, keyframes or references, size."""
    _, meta = graphs.graph_video(p, native=True)
    short = 768 if p.get("quality", "hd") == "hd" else 480
    meta["width"], meta["height"] = graphs.engine_video_size(p)
    meta.update(provider="本地 H3",model="h3-video",resolution=f"{short}P")
    imgs = p.get("images") or []
    paths = [str(tools.ref_path(config.COMFY_DIR, im["ref"])) for im in imgs]
    body = {"kind": "video", "prompt": meta["full_prompt"], "frames": meta["frames"], "height": meta["height"],
            "width": meta["width"], "steps": meta["steps"], "turbo": bool(p.get("turbo", True))}
    mode = meta["mode"]
    nframes = body["frames"]
    if mode == "planned":                          # character references + keyframes at their times (ComfyUI AddGuide)
        subj = [str(tools.ref_path(config.COMFY_DIR, im["ref"])) for im in imgs if im.get("role") == "subject"][:9]
        frames = sorted([im for im in imgs if im.get("role") != "subject"], key=lambda im: float(im.get("time") or 0))
        body["references"] = subj
        body["keyframes"] = [{"path": str(tools.ref_path(config.COMFY_DIR, im["ref"])), "frame": graphs.keyframe_index(im.get("time"), nframes)}
                             for im in frames]
    elif mode == "reference":
        body["references"] = paths[:9]
    elif mode == "keyframes":                      # like the ComfyUI graph: the first image as reference, the rest anchored
        times = meta.get("times") or []
        body["references"] = paths[:1]
        body["keyframes"] = [{"path": paths[i], "frame": graphs.keyframe_index(times[i] if i < len(times) else 0, nframes)}
                             for i in range(1, len(paths))]
    elif paths:
        body["image"] = paths[0]
        if len(paths) > 1:
            body["last_image"] = paths[-1]
    return body, meta
