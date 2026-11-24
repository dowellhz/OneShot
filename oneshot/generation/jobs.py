"""Generation job state, polling, cancellation, and recovery."""

import asyncio
import json
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import aiohttp
from aiohttp import web

from oneshot import config
from oneshot.editing import audio_separation
from oneshot.editing import image_editor
from oneshot.generation import generation_watermark
from oneshot.generation import remote_jobs
from oneshot.generation import tools
from oneshot.generation.audio import AUDIO_GENERATION_MODES
from oneshot.memory import creative_memory
from oneshot.providers import catalog as providers
from oneshot.storage import db
from oneshot.web import history as media_history
from oneshot.web import media as media_routes


CLIENT_ID = "h3studio-" + uuid.uuid4().hex[:8]


JOBS: dict = {}   # prompt_id -> state


EDIT_JOBS = config.DATA_DIR / "image-edits"


def attach_image_edit(j, p):
    spec = p.get("_image_edit")
    if spec:
        j["meta"]["image_edit"] = spec
        recipe = spec.get("recipe") or {}
        mode_name = {"region":"局部重绘","whole":"整图编辑","outpaint":"智能扩图"}[spec["mode"]]
        if recipe.get("camera_view"):
            mode_name = "图片换机位"
        elif recipe.get("relight"):
            mode_name = "图片重新布光"
        j["meta"]["mode_name"] = mode_name
        if spec.get("recipe", {}).get("backend") == "native":
            j["meta"]["mode_name"] += " · 原生遮罩"
        EDIT_JOBS.mkdir(parents=True, exist_ok=True)
        path = EDIT_JOBS / (j["id"] + ".json")
        tmp = path.with_suffix(".tmp"); tmp.write_text(json.dumps(spec, ensure_ascii=False)); tmp.replace(path)


def restore_image_edit(j):
    # Also keep region protection when recovering an engine/ComfyUI job after restart.
    if re.fullmatch(r"[\w-]{1,80}", j["id"]):
        path = EDIT_JOBS / (j["id"] + ".json")
        if path.is_file():
            attach_image_edit(j, {"_image_edit": json.loads(path.read_text())})


async def complete_outputs(j, outputs):
    async with j.setdefault("_output_lock", asyncio.Lock()):
        if j["state"] in ("done", "error"):
            return
        error_label = "图像编辑合成失败"
        try:
            spec = j.get("meta", {}).get("image_edit")
            if spec:
                j["phase"] = "compositing"
                if spec.get("recipe") is not None:
                    spec["recipe"]["seed"] = j["meta"].get("seed", spec["recipe"].get("seed", -1))
                outputs = await asyncio.to_thread(image_editor.composite, config.COMFY_DIR, spec, outputs)
            if outputs and not j.get("cancel") and db.one("SELECT 1 FROM task_watermarks WHERE job_id=?",j["id"]):
                j["phase"] = "watermark"
                error_label = "写入 AI 生成水印失败"
                labelled = await asyncio.to_thread(generation_watermark.label_outputs,
                    config.COMFY_DIR,j["id"],j["kind"],outputs,lambda:bool(j.get("cancel")))
                for original, marked in zip(outputs,labelled):
                    if original.get("extra",{}).get("draft_expires"):
                        db.run("""INSERT OR IGNORE INTO video_drafts
                            SELECT ?,job_id,provider_task,expires FROM video_drafts WHERE ref=?""",marked["ref"],original["ref"])
                outputs = labelled
            if j.get("cancel"):
                return
            j.update(outputs=outputs, state="done", phase="done", finished=time.time())
            record(j)
        except Exception as e:
            if not j.get("cancel"):
                j.update(state="error", error=f"{error_label}：{e}")
        log_end(j)


STATS_FILE = config.DATA_DIR / "stats.json"


try:
    STATS: dict = json.loads(STATS_FILE.read_text())
except Exception:
    STATS = {}


def job_class(p: dict):
    """-> (class key, units, default seconds per unit). Video time scales with its length (unit = 5 s of video)."""
    kind = p.get("kind") or "video"
    if kind == "image":
        if p.get("model") == "h3video":
            return f"image|h3video|{p.get('quality')}|{bool(p.get('turbo'))}", 1, (32 if p.get("turbo") else 110) * (2 if p.get("quality") == "hd" else 1)
        return f"image|h3img|{p.get('quality')}|{bool(p.get('expand'))}", 1, (50 if p.get("quality") == "16mp" else 30) + (25 if p.get("expand") else 0)
    ref, hd = bool(p.get("planned")), p.get("quality") == "hd"
    base = (150 if hd else 65) if ref else (120 if hd else 60)
    units = max(0.4, float(p.get("duration") or 5) / 5)
    return f"video|{'ref' if ref else 'fl2v'}|{p.get('quality')}|{bool(p.get('turbo'))}", units, base * (1 if p.get("turbo", True) else 4)


def estimate(cls: str, units: float, default: float) -> float:
    xs = sorted(STATS.get(cls) or [])
    per = xs[len(xs) // 2] if xs else default
    return round(per * units, 1)


def record(j: dict):
    m = j.get("meta") or {}
    if not m.get("cls") or not j.get("started") or not j.get("finished"):
        return
    took = j["finished"] - j["started"]
    if took <= 1:
        return
    xs = STATS.setdefault(m["cls"], [])
    xs.append(round(took / max(0.1, m.get("units") or 1), 1))
    del xs[:-12]
    try:
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(STATS))
    except Exception:
        pass


def remaining(j: dict) -> float:
    """Seconds until a job is done."""
    if j["state"] in ("done", "error"):
        return 0.0
    est = (j.get("meta") or {}).get("est") or 60
    if j["state"] == "queued":
        return est
    el = time.time() - j.get("started", time.time())
    rem = est - el
    if j.get("max") and (j.get("value") or 0) >= 2 and j.get("kind") != "render":   # sampling steps: project from their pace
        frac = j["value"] / j["max"]
        rem = min(rem, el * (1 - frac) / frac + 0.15 * est) if frac < 1 else min(rem, 0.15 * est)
    elif j.get("kind") == "render" and j.get("max"):
        frac = (j.get("value") or 0) / j["max"]
        if frac > 0.05:
            rem = el * (1 - frac) / frac
    return max(2.0, rem)


async def comfy_ws(app):
    """Follows ComfyUI's websocket for progress of our prompts; reconnects forever."""
    while True:
        try:
            async with app["http"].ws_connect(f"{config.COMFY.replace('http', 'ws', 1)}/ws?clientId={CLIENT_ID}", heartbeat=30) as ws:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    m = json.loads(msg.data)
                    d = m.get("data") or {}
                    j = JOBS.get(d.get("prompt_id"))
                    if not j:
                        continue
                    t = m.get("type")
                    if t == "execution_start":
                        j["state"] = "running"; j["started"] = time.time()
                    elif t == "executing" and d.get("node"):
                        j["state"] = "running"; j["node"] = d["node"]; j.setdefault("started", time.time())
                    elif t == "progress":
                        j["state"] = "running"; j["value"], j["max"] = d.get("value"), d.get("max"); j["node"] = d.get("node")
                    elif t == "execution_error":
                        j["state"] = "error"; j["error"] = d.get("exception_message", "执行失败")[:500]; log_end(j)
                    elif t == "execution_interrupted":
                        j["state"] = "error"; j["error"] = "已取消"; log_end(j)
                    elif t in ("execution_success",) or (t == "executing" and d.get("node") is None):
                        await finish(app, d["prompt_id"])
        except Exception:
            pass
        await asyncio.sleep(2)


async def finish(app, pid):
    j = JOBS.get(pid)
    if not j or j["state"] in ("done", "error"):
        return
    async with app["http"].get(f"{config.COMFY}/history/{pid}") as r:
        h = await r.json()
    if pid not in h:
        return
    st = h[pid].get("status", {})
    if st.get("status_str") == "error":
        msgs = [m[1] for m in st.get("messages", []) if m[0] == "execution_error"]
        j["state"] = "error"; j["error"] = (msgs[0].get("exception_message") if msgs else "执行失败")[:500]
        log_end(j)
        return
    outs = []
    for o in h[pid].get("outputs", {}).values():
        for f in o.get("images", []) + o.get("videos", []) + o.get("gifs", []):
            ref = f"{f.get('type', 'output')}:{(f.get('subfolder') + '/') if f.get('subfolder') else ''}{f['filename']}"
            outs.append({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "meta": f.get("metadata", {})})
    await complete_outputs(j, outs)


async def submit(app, graph, meta, kind):
    async with app["http"].post(f"{config.COMFY}/prompt", json={"prompt": graph, "client_id": CLIENT_ID}) as r:
        body = await r.json(content_type=None)
        if r.status != 200:
            err = body.get("error", {}).get("message", "") if isinstance(body, dict) else str(body)
            details = body.get("node_errors") if isinstance(body, dict) else None
            raise web.HTTPBadRequest(text=json.dumps({"error": f"ComfyUI 拒绝了任务: {err} {json.dumps(details, ensure_ascii=False)[:600]}"}, ensure_ascii=False),
                                     content_type="application/json")
    pid = body["prompt_id"]
    JOBS[pid] = {"id": pid, "kind": kind, "state": "queued", "created": time.time(), "meta": meta}
    db.task_start(id=pid, user_id=meta.get("uid"), board_id=meta.get("board"), label=meta.get("label"), capability=kind,
                  provider_id="local_h3", provider_kind="local_h3", model=meta.get("mode_name"), state="queued", cost=0)
    return pid


def log_end(j: dict):
    """Write a finished / failed job into the task log (once)."""
    from oneshot import app as application

    if j.get("_logged") or j["state"] not in ("done", "error"):
        return
    j["_logged"] = True
    try:
        if j["state"] == "done" and (j.get("meta") or {}).get("uid") is not None:
            creative_memory.Store(application).observe({"id": j["meta"]["uid"]}, {j["id"]: j})
        db.task_update(j["id"], state=j["state"], started=j.get("started"), finished=j.get("finished") or time.time(),
                       seconds=round((j.get("finished") or time.time()) - (j.get("started") or j["created"]), 1),
                       error=j.get("error"), outputs=[o.get("ref") for o in j.get("outputs") or []],
                       **media_history.generation_history_metadata(j))
    except Exception:
        pass


async def jobs(req):
    u = req["user"]
    ids = [i for i in req.query.get("ids", "").split(",") if i and (u["role"] == "admin" or i not in JOBS
                                                                    or (JOBS[i].get("meta") or {}).get("uid") in (None, u["id"]))][:200]
    queue_order = []
    comfy_ids = [i for i in ids if not (JOBS.get(i, {}).get("out_ref") or i[:1] in "xrtp" and len(i) == 13
                                        or i.startswith("r") and len(i) == 25)]
    if any(JOBS.get(i, {}).get("state") == "queued" for i in comfy_ids):
        try:
            async with req.app["http"].get(f"{config.COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
                q = await r.json()
            queue_order = [x[1] for x in q.get("queue_running", [])] + [x[1] for x in sorted(q.get("queue_pending", []), key=lambda x: x[0])]
        except Exception:
            pass
    out = {}
    for i in ids:
        j = JOBS.get(i)
        row = None
        if not j:
            row = db.one("SELECT * FROM tasks WHERE id=?", i)
            if row and u["role"] != "admin" and row["user_id"] != u["id"]:
                continue
            if row:
                j = restore_logged_job(req.app, row)
        if not j:
            # a job from before a restart: ask the history
            JOBS[i] = j = job_from_log(row) if row else {"id": i, "state": "queued", "created": time.time(), "meta": {}}
            restore_image_edit(j)
            live = set(queue_order)
            try:
                await finish(req.app, i)
                if j["state"] in ("queued", "running") and i not in live:
                    async with req.app["http"].get(f"{config.COMFY}/queue", timeout=aiohttp.ClientTimeout(total=3)) as r:
                        q = await r.json()
                    live = {x[1] for x in q.get("queue_running", []) + q.get("queue_pending", [])}
            except Exception:
                live = set()
            if j["state"] in ("queued", "running") and i not in live:
                j["state"] = "error"; j["error"] = "任务已不存在（服务重启过）"
        if j["state"] in ("queued", "running") and time.time() - j.get("polled", 0) > 10 and not j.get("out_ref") and i in comfy_ids:
            j["polled"] = time.time()
            try:
                await finish(req.app, i)   # in case a websocket message was missed
            except Exception:
                pass
        r = {k: j.get(k) for k in ("state", "value", "max", "node", "error", "outputs", "meta", "prep", "phase")}
        if j["state"] == "queued" and i in queue_order:
            r["ahead"] = queue_order.index(i)
            r["eta"] = round(sum(remaining(JOBS[x]) if x in JOBS else 90 for x in queue_order[:r["ahead"] + 1]))
        elif j["state"] in ("queued", "running"):
            r["eta"] = round(remaining(j))
            if j["state"] == "queued":
                r["ahead"] = j.get("ahead", 0)
        r["elapsed"] = round(time.time() - (j.get("started") or j["created"]), 1)
        out[i] = r
    req.app["creative_memory"].observe(u, out)
    return web.json_response(out)


async def cancel_engine_jobs(app, ids):
    if not ids:
        return
    try:
        async with app["http"].post(config.ENGINE + "/cancel", json={"ids": ids}, timeout=aiohttp.ClientTimeout(total=4)):
            pass
    except (aiohttp.ClientError, asyncio.TimeoutError):
        pass


async def cancel(req):
    u = req["user"]
    eng = []
    for i in (await req.json()).get("ids", []):
        if not isinstance(i, str):
            continue
        job = JOBS.get(i)
        if not job:
            row = db.one("SELECT * FROM tasks WHERE id=?", i)
            if row and (u["role"] == "admin" or row["user_id"] == u["id"]) and row["state"] in ("queued", "running"):
                job = restore_logged_job(req.app, row)
        if not job or job["state"] not in ("queued", "running"):
            continue
        if u["role"] != "admin" and (job.get("meta") or {}).get("uid") not in (None, u["id"]):
            continue
        if job.get("out_ref"):
            eng.append(job.get("eid", i))
        job.update(state="error", error="已取消", cancel=True)
        log_end(job)
    await cancel_engine_jobs(req.app, eng)
    return web.json_response({"ok": True})


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
        j = JOBS.get(i)
        if j and j["state"] in ("done", "error"):
            continue
        t += remaining(j) if j else 90
        if j:
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"),
                        "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in JOBS.items():            # our engine's jobs, in submission order (those still being prepared last)
        if j.get("out_ref") and j["state"] in ("queued", "running"):
            t += remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": j["state"], "label": m.get("label") or ("图片" if j["kind"] == "image" else "视频"), "eta": round(t), "value": j.get("value"), "max": j.get("max")})
    for i, j in JOBS.items():
        if j.get("prep") and j["state"] == "queued":
            t += remaining(j)
            m = j.get("meta") or {}
            out.append({"id": i, "kind": j["kind"], "state": "queued", "label": (m.get("label") or "视频") + " · 翻译提示词", "eta": round(t), "value": None, "max": None})
    rt = 0.0
    for i, j in JOBS.items():            # renders run beside ComfyUI
        if j.get("kind") == "render" and j["state"] in ("queued", "running"):
            rt += remaining(j)
            out.append({"id": i, "kind": "render", "state": j["state"], "label": (j.get("meta") or {}).get("label") or "成片",
                        "eta": round(rt), "value": j.get("value"), "max": j.get("max")})
    audio_eta = 0
    for i,j in JOBS.items():
        if j.get("kind")=="audio" and j["state"] in ("queued","running"):
            eta = round(remaining(j))
            audio_eta = max(audio_eta,eta)
            out.append({"id":i,"kind":"audio","state":j["state"],"label":j["meta"]["label"],"eta":eta})
    foreign = sum(1 for i in order if i not in JOBS)
    return web.json_response({"jobs": out, "total": round(max(t, rt, audio_eta)), "foreign": foreign})


def video_job_details(meta):
    details = {key:meta[key] for key in ("mode","mode_name","provider","model","resolution") if isinstance(meta.get(key),str)}
    if isinstance(meta.get("full_prompt"),str):
        details["full_prompt"] = meta["full_prompt"][:5000]
    return details


_following = False


def job_from_log(row):
    cap = row.get("capability")
    kind = "audio" if cap in AUDIO_GENERATION_MODES or cap == "audio_separation" else "image" if cap == "image" else "video"
    return {"id":row["id"], "kind":kind, "state":row["state"], "created":row.get("created") or time.time(),
            "meta":{"label":row.get("label"), "uid":row.get("user_id"), "board":row.get("board_id"),
                    "mode_name":(row.get("model") or "").replace("MiniMax-H3 ", "")}}


def restore_logged_job(app, row):
    jid = row["id"]
    if jid in JOBS:
        return JOBS[jid]
    job = job_from_log(row)
    request = media_history.task_settings(row.get("request"))
    if job["kind"] == "video":
        job["meta"].update(video_job_details(request))
        if isinstance(request.get("prompt"),str):
            job["meta"]["prompt"] = request["prompt"]
        if row.get("provider_kind") in ("ark","kling","minimax") and row.get("model"):
            job["meta"]["model"] = row["model"]
    history = request.get("history")
    if isinstance(history,dict):
        job["meta"].update({key:history[key] for key in ("seed","mode_name") if key in history})
        if job["kind"] == "video":
            job["meta"].update(video_job_details(history))
    if row["state"] in ("done", "error"):
        try:
            refs = json.loads(row.get("outputs") or "[]")
        except (ValueError, TypeError):
            refs = []
        outputs = []
        image_edits = request.get("image_edits")
        for index, ref in enumerate(refs if isinstance(refs,list) else []):
            if not isinstance(ref, str):
                continue
            try:
                path = tools.ref_path(config.COMFY_DIR, ref)
            except ValueError:
                continue
            stem = None
            if row.get("capability") == "audio_separation":
                stems = tuple(audio_separation.STEMS)
                if index >= len(stems) or not path.is_file():
                    continue
                stem = stems[index]
            outputs.append({"ref":ref, "url":"/media?ref=" + quote(ref, safe=""),
                            "meta":media_routes.media_info(path, job["kind"])})
            if row.get("capability") in AUDIO_GENERATION_MODES:
                extra = {key:request[source] for key,source in (("audio_recipe","recipe"),("audio_transcript","audio_transcript"))
                         if isinstance(request.get(source),dict)}
                if extra:
                    outputs[-1]["extra"] = extra
            if job["kind"]=="image" and isinstance(image_edits,dict) and isinstance(image_edits.get(ref),dict):
                outputs[-1]["extra"] = {"source":"edit","edit":image_edits[ref]}
            if stem:
                outputs[-1]["extra"] = {"stem":stem}
            if draft := db.one("SELECT expires FROM video_drafts WHERE ref=? AND job_id=?", ref, jid):
                outputs[-1].setdefault("extra",{})["draft_expires"] = draft["expires"]
            if Path(ref).name.startswith("ai_") and db.one("SELECT 1 FROM task_watermarks WHERE job_id=?",jid):
                outputs[-1].setdefault("extra",{})["ai_watermark"] = True
        job.update(error=row.get("error"), outputs=outputs, _logged=True)
        JOBS[jid] = job
        return job
    receipt = request.get("engine") or {}
    if not isinstance(receipt, dict):
        receipt = {}
    if not receipt and len(jid) == 13 and jid[0] == "e" and row.get("provider_kind") == "local_h3":
        receipt = {"id":jid, "out_ref":"output:h3studio/pending"}
    if receipt.get("id") and receipt.get("out_ref"):
        job.update(eid=receipt["id"], out_ref=receipt["out_ref"])
        job["meta"]["engine"] = True
        JOBS[jid] = job
        restore_image_edit(job)
        asyncio.create_task(follow_engine(app))
        return job
    receipt = request.get("remote_video")
    if row.get("capability") == "video" and isinstance(receipt, dict):
        JOBS[jid] = job
        provider = providers.get(row["provider_id"])
        if not provider or not provider["enabled"] or provider["kind"] != row.get("provider_kind"):
            job.update(state="error", error="原视频服务已停用或变更，无法查询任务")
            log_end(job)
        else:
            job["started"] = row.get("started") or job["created"]
            job["meta"].setdefault("provider",provider["name"])
            remote_jobs.start_remote(app, job, provider, row["model"], "video", {}, receipt=receipt)
        return job
    remote_final = len(jid) == 25 and jid.startswith("r") and row.get("provider_kind") == "ark" and row.get("capability") == "video"
    if not remote_final and (len(jid) != 13 or jid[0] not in "epxrt"):
        return None
    message = ("OneShot 已重启，未保存第三方任务号。请先到视频服务查询提交记录"
               if remote_final or (jid.startswith("x") and row.get("capability") == "video")
               else "OneShot 已重启，此任务无法恢复，请重试")
    job.update(state="error", error=message)
    JOBS[jid] = job
    log_end(job)
    return job


async def follow_engine(app):
    """Mirror the engine's job states into JOBS (one follower for all jobs)."""
    global _following
    if _following:
        return
    _following = True
    try:
        while True:
            live = [i for i, j in JOBS.items() if j.get("out_ref") and j["state"] in ("queued", "running")]
            if not live:
                return
            try:
                async with app["http"].get(config.ENGINE + "/jobs", params={"ids": ",".join(JOBS[i].get("eid", i) for i in live)},
                                           timeout=aiohttp.ClientTimeout(total=5)) as r:
                    r.raise_for_status()
                    st = await r.json()
                if not isinstance(st, dict):
                    raise ValueError("Invalid engine status response")
            except Exception:
                await asyncio.sleep(3); continue
            for i in live:
                j = JOBS.get(i)
                if not j or j["state"] not in ("queued", "running"):
                    continue
                s = st.get(j.get("eid", i))
                if not isinstance(s, dict):
                    continue
                if s.get("state") == "queued":
                    j["ahead"] = s.get("ahead", 0)
                    j["phase"] = "queued"
                if s.get("state") == "running":
                    if j["state"] != "running":
                        j["state"] = "running"; j["started"] = s.get("started") or time.time()
                    j["value"], j["max"] = s.get("value"), s.get("max")
                    j["phase"] = s.get("phase") or ("decoding" if s.get("max") and (s.get("value") or 0) >= s["max"] else "sampling")
                    j["ahead"] = s.get("ahead", 0)
                elif s.get("state") == "done":
                    if s.get("out"):
                        j["out_ref"] = "output:h3studio/" + Path(s["out"]).name
                    path = config.COMFY_DIR / "output" / "h3studio" / Path(j["out_ref"]).name
                    j["started"] = s.get("started") or j.get("started")
                    await complete_outputs(j, [{"ref": j["out_ref"], "url": "/media?ref=" + quote(j["out_ref"], safe=""), "meta": media_routes.media_info(path, j["kind"])}])
                elif s.get("state") == "error":
                    j["state"] = "error"; j["error"] = s.get("error") or "生成失败"; log_end(j)
            await asyncio.sleep(1.5)
    finally:
        _following = False


def recover_remote_videos(app):
    rows = db.q("""SELECT * FROM tasks WHERE capability='video' AND state IN ('queued','running')
                  AND CASE WHEN json_valid(request) THEN json_type(request,'$.remote_video')='object' ELSE 0 END
                  ORDER BY created""")
    for row in rows:
        restore_logged_job(app, row)
