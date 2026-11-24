"""Submit and recover jobs handled by remote generation providers."""

import asyncio
import hashlib
import json
import re
import tempfile
import time
import uuid
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import image_editor
from oneshot.editing import object_edit
from oneshot.editing import render as film
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import motion_reference
from oneshot.generation import reference as video_reference
from oneshot.generation import tools
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.storage import db
from oneshot.web import history as media_history
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


async def generate_remote(req, raw: dict, route: dict, cap: str, *, motion=None, audio_refs=(), video_refs=()):
    """Run one image / video request on a third-party provider; tracked in JOBS like a local job (id "x…")."""
    p, model = route["provider"], route["model"]
    u = req["user"]
    resolution = video_reference.checked_video_resolution(raw,p["kind"],model,provider=p) if cap=="video" else None
    draft = raw.get("draft")
    if draft and (draft is not True or cap != "video" or not remote.supports_video_draft(p,model)):
        raise http_errors.bad("请选择支持原生样片的 Seedance 2.5 服务")
    from_previs = motion and motion.get("source") == "previs"
    object_plan = raw.get("object_edit")
    full_reference = from_previs or audio_refs or video_refs
    image_references = cap == "video" and not full_reference and video_reference.image_reference_limit(raw,p,model)
    if full_reference:
        prompt = video_reference.video_reference_prompt(raw,p,model)
    elif cap == "video":
        prompt, _ = video_reference.remote_video_prompt(raw, p, model)
    else:
        prompt = video_reference.plain_prompt(raw)
    if not prompt:
        raise http_errors.bad("提示词不能为空")
    imgs = []
    if not (full_reference or image_references):
        for im in raw.get("images") or []:
            try:
                imgs.append({**im, "path": tools.ref_path(config.COMFY_DIR, im["ref"])})
            except Exception:
                pass
    if cap == "image":
        nreq = {"prompt": re.sub(r"@图(\d+)", r"图\1", prompt), "images": [x["path"] for x in imgs], "ar": float(raw.get("ar") or 1), "n": int(raw.get("count") or 1)}
    elif full_reference or image_references:
        model_for_limits = motion_reference.video_model_for_limits(p,model)
        video_reference.ensure_reference_media_count(raw,p["kind"],model_for_limits,object_plan)
        paths = video_reference.resolve_video_reference_images(u,raw)
        try:
            seconds = video_reference.reference_video_duration(raw,p,model,motion)
            ratio = image_editor.number(raw.get("ar"), .4, 2.5, "画面宽高比", 16 / 9)
        except ValueError as exc:
            raise http_errors.bad(str(exc))
        nreq = {"prompt":prompt, "first":None, "last":None, "refs":paths,
                "duration":seconds, "ar":ratio,
                "quality":raw.get("quality") or "hd", "audio":True, "audio_refs":audio_refs}
        if raw.get("extension"):
            nreq["extension"] = raw["extension"]
        if raw.get("segment_edit"):
            nreq["segment_edit"] = True
        if object_plan:
            clip = video_refs[0]
            if not clip["start"] <= object_plan["at"] < min(clip["source_seconds"], clip["start"] + clip["ticks"]/film.FPS):
                raise http_errors.bad("物体标注帧须位于要修改的区间内")
            nreq["object_edit"] = object_plan
            if ref := object_plan.get("replacement_ref"):
                media_routes.require_media(u, {ref})
                try:
                    path = tools.ref_path(config.COMFY_DIR, ref)
                    if path.suffix.lower() not in (".png",".jpg",".jpeg",".webp") or not path.is_file():
                        raise ValueError()
                except ValueError:
                    raise http_errors.bad("请选择可读取的替换参考图") from None
                nreq["replacement_path"] = path
    else:
        frames = [x for x in imgs if x.get("role") != "subject"]
        nreq = {"prompt": prompt, "first": frames[0]["path"] if frames else None, "last": frames[-1]["path"] if len(frames) > 1 else None,
                "refs": [x["path"] for x in imgs if x.get("role") == "subject"], "duration": float(raw.get("duration") or 5),
                "ar": float(raw.get("ar") or 16 / 9), "quality": raw.get("quality") or "hd", "audio": True}
    if motion or video_refs:
        if cap != "video" or not motion_reference.supports(p, model) or nreq["first"] is not None:
            raise http_errors.bad("此服务或参考素材不能用于动作参考")
        if motion and not from_previs:
            if not nreq["refs"]:
                raise http_errors.bad("深度参考需要已采用的首帧图")
            nreq.update(audio=False)
    if draft:
        nreq["draft"] = True
    cls = f"remote|{p['kind']}|{cap}|{model}"
    count = 1 if cap == "image" else max(1, min(3, int(raw.get("count") or 1)))
    ids = []
    for _ in range(count):
        jid = "x" + uuid.uuid4().hex[:12]
        meta = {"label": http_errors.clean(raw.get("label"))[:60] or p["name"], "cls": cls, "units": 1, "est": generation_jobs.estimate(cls, 1, 40 if cap == "image" else 150),
                "mode_name": f"{p['name']} · {model}", "uid": u["id"], "provider": p["name"], "model":model,
                "prompt": prompt, "board":http_errors.clean(raw.get("board"))}
        if resolution:
            meta["resolution"] = resolution
        if raw.get("segment_edit"):
            operation = object_edit.ACTIONS[object_plan["action"]] if object_plan else "镜头重拍" if raw.get("camera_plan") else "片段修改"
            meta["mode_name"]=operation+" · "+meta["mode_name"]
        if draft:
            meta["mode_name"]="480p 样片 · "+meta["mode_name"]
        j = generation_jobs.JOBS[jid] = {"id": jid, "kind": cap, "state": "queued", "created": time.time(), "meta": meta}
        generation_jobs.attach_image_edit(j, raw)
        request_data = {"prompt":prompt[:2000]}
        if resolution:
            request_data["resolution"] = resolution
        if from_previs:
            request_data["previs_ref"] = raw["previs_guide"]["ref"]
        if audio_refs:
            request_data["audio_refs"] = [{key:entry[key] for key in ("ref","start","end") if key in entry}
                                          for entry in raw["audio_refs"]]
        if video_refs:
            request_data["video_refs"] = [{k:entry[k] for k in ("ref","start","end") if k in entry} for entry in raw["video_refs"]]
        if raw.get("extension"):
            request_data["extension"] = raw["extension"]
        if raw.get("segment_edit"):
            request_data["segment_edit"] = True
        if raw.get("camera_plan"):
            request_data["camera_plan"] = raw["camera_plan"]
        if object_plan:
            request_data["object_edit"] = object_plan
        if draft:
            request_data["draft"] = True
        db.task_start(id=jid, user_id=u["id"], board_id=meta["board"], label=meta["label"], capability=cap, provider_id=p["id"],
                      provider_kind=p["kind"], model=model, state="queued", request=request_data)
        start_remote(req.app, j, p, model, cap, nreq, motion=motion, video_refs=video_refs)
        ids.append(jid)
    return web.json_response({"ids": ids, "meta": generation_jobs.JOBS[ids[0]]["meta"]})


def video_draft_source(ref):
    return db.one("SELECT d.provider_task,d.expires,t.provider_id,t.model FROM video_drafts d "
                  "JOIN tasks t ON t.id=d.job_id WHERE d.ref=? AND t.state='done'", ref)


async def finalize_video_draft(req):
    raw = await req.json()
    if not isinstance(raw, dict):
        raise http_errors.bad("请选择样片和定稿分辨率")
    bid, nid, ref, resolution, key = (raw.get(field) for field in ("board","node","ref","resolution","request_key"))
    if (not all(isinstance(value, str) for value in (bid,nid,ref,key)) or
            not _ID.fullmatch(nid) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", key) or resolution not in ("1080p","4k")):
        raise http_errors.bad("请选择样片和定稿分辨率")
    user = req["user"]
    board = board_meta(canvas_routes.board_path(bid))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden()
    node = next((n for n in board["nodes"] if n["id"] == nid and n["type"] == "video"), None)
    if not node or not any(v.get("ref") == ref for v in node.get("versions", [])):
        raise http_errors.bad("画布里的样片版本已移除")
    media_routes.require_media(user, {ref})
    jid = "r" + hashlib.sha256(f"draft-final:{user['id']}:{key}".encode()).hexdigest()[:24]
    fingerprint = {"board":bid,"node":nid,"ref":ref,"resolution":resolution}
    if existing := db.one("SELECT request FROM tasks WHERE id=?", jid):
        saved = media_history.task_settings(existing["request"])
        if any(saved.get(field) != value for field, value in fingerprint.items()):
            raise http_errors.bad("该定稿请求已经用于另一项任务")
        return web.json_response({"ids":[jid],"meta":generation_jobs.JOBS.get(jid, {}).get("meta", {})})
    source = video_draft_source(ref)
    if not source:
        raise http_errors.bad("这个视频版本没有可用的样片任务")
    if source["expires"] <= time.time():
        raise http_errors.bad("样片已过定稿有效期，请重新生成样片")
    provider = providers.get(source["provider_id"])
    if not provider or not provider["enabled"] or not remote.supports_video_draft(provider,source["model"]):
        raise http_errors.bad("原样片的 Seedance 服务不可用")
    model = source["model"]
    label = (node["name"] + " · " + resolution.upper() + " 定稿")[:60]
    cls = f"remote|ark|video|{model}|final|{resolution}"
    meta = {"label":label,"cls":cls,"units":1,"est":generation_jobs.estimate(cls,1,150),"board":bid,"uid":user["id"],
            "mode_name":resolution.upper()+" 定稿","provider":provider["name"],"model":model,"resolution":resolution}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability="video",provider_id=provider["id"],
                  provider_kind="ark",model=model,request={**fingerprint,"history":generation_jobs.video_job_details(meta)})
    job = generation_jobs.JOBS[jid] = {"id":jid,"kind":"video","state":"queued","created":time.time(),"meta":meta}
    start_remote(req.app,job,provider,model,"video",
                 {"draft_task":source["provider_task"],"resolution":resolution})
    return web.json_response({"ids":[jid],"meta":meta})


REMOTE_SEM: dict = {}


def start_remote(app, *args, **kwargs):
    task = asyncio.create_task(run_remote(app, *args, **kwargs))
    tasks = app.get("remote_tasks")
    if tasks is not None:
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return task


def record_remote_video(job, receipt):
    row = db.one("SELECT request FROM tasks WHERE id=?", job["id"])
    request = media_history.task_settings(row["request"])
    request.update(remote_video=receipt, history=generation_jobs.video_job_details(job["meta"]))
    fields = {"request":json.dumps(request, ensure_ascii=False)}
    if not job.get("cancel"):
        fields.update(state="running", started=job["started"])
    db.task_update(job["id"], **fields)


async def run_with_motion(app, j, p, model, nreq, motion, video_refs=(), *, on_submitted=None):
    origin = motion_reference.public_origin(p["config"].get("motion_origin"))
    with tempfile.TemporaryDirectory(prefix="oneshot-motion-") as temp, ExitStack() as leases:
        j["phase"] = "encoding"
        cancelled = lambda: j.get("cancel")
        paths = []
        if motion:
            path = Path(temp) / "guide.mp4"
            await asyncio.to_thread(motion_reference.prepare, motion["path"], path, motion["ticks"], cancelled)
            paths.append(path)
        for i, clip in enumerate(video_refs):
            if cancelled():
                return None
            path = Path(temp) / f"reference-{i}.mp4"
            await asyncio.to_thread(motion_reference.prepare_clip, clip["path"], path, clip["start"], clip["ticks"], clip["ratio"], cancelled)
            paths.append(path)
        if cancelled():
            return None
        def publish(path):
            return leases.enter_context(motion_reference.publish(origin,path,lambda:j["state"] == "running" and not cancelled()))
        urls = [publish(path) for path in paths]
        request = {**nreq, "motion_url":urls[0] if motion else None, "video_urls":urls[bool(motion):]}
        if p["kind"] == "minimax":
            audio_urls = []
            for index,(source,start,seconds) in enumerate(nreq.get("audio_refs",[])):
                if cancelled():
                    return None
                path = Path(temp) / f"reference-audio-{index}.wav"
                data = await asyncio.to_thread(remote.reference_audio_wav,source,seconds,start)
                path.write_bytes(data)
                audio_urls.append(publish(path))
            request["audio_urls"] = audio_urls
            urls += audio_urls
        j["phase"] = "sampling"
        try:
            if plan := nreq.get("object_edit"):
                guide = Path(temp) / "selection.png"
                await asyncio.to_thread(object_edit.annotate, video_refs[0]["path"], guide, plan)
                request["refs"] = [*nreq["refs"],guide]
                if replacement := nreq.get("replacement_path"):
                    request["refs"].append(replacement)
                if cancelled():
                    return None
            return await remote.run(app["http"], config.COMFY_DIR, p, model, "video", request, on_submitted=on_submitted)
        except Exception as exc:
            message = str(exc)
            for url in urls:
                message = message.replace(url, "素材参考链接").replace(url.rsplit("/", 1)[-1], "已隐藏")
            raise providers.ProviderError(message) from None


async def run_remote(app, j: dict, p: dict, model: str, cap: str, nreq: dict, *, motion=None, video_refs=(), receipt=None):
    sem = REMOTE_SEM.setdefault(p["id"], asyncio.Semaphore(3))       # be polite to each provider
    async with sem:
        if j.get("cancel"):
            return
        j["state"] = "running"
        j.setdefault("started", time.time())
        try:
            if receipt is not None:
                r = await remote.resume_video(app["http"], config.COMFY_DIR, p, receipt)
            elif cap == "video":
                def submitted(value):
                    record_remote_video(j, value)
                if motion or video_refs or p["kind"] == "minimax" and nreq.get("audio_refs"):
                    r = await run_with_motion(app, j, p, model, nreq, motion, video_refs, on_submitted=submitted)
                else:
                    r = await remote.run(app["http"], config.COMFY_DIR, p, model, cap, nreq, on_submitted=submitted)
            else:
                r = await remote.run(app["http"], config.COMFY_DIR, p, model, cap, nreq)
            if r is None or j.get("cancel"):
                return
            outs = []
            for f in r["files"]:
                outs.append({"ref": f["ref"], "url": "/media?ref=" + quote(f["ref"], safe=""), "meta": media_routes.media_info(f["path"], f["kind"])})
            if j.get("cancel"):
                return
            if r.get("draft_task"):
                expires = r["draft_created"] + 14 * 86400
                for output in outs:
                    db.run("INSERT INTO video_drafts VALUES (?,?,?,?)",
                           output["ref"], j["id"], r["draft_task"], expires)
                    output["extra"] = {"draft_expires":expires}
            db.task_update(j["id"], cost=r.get("cost"), units=r.get("units"))
            await generation_jobs.complete_outputs(j, outs)
        except Exception as e:
            if j["state"] != "error":
                message = str(e)
                if receipt is not None:
                    message = re.sub(r"""(?:https?://[^\s"'<>/]*)?""" + motion_reference.LEASE_PATH.pattern,
                                     "视频参考链接", message)
                j.update(state="error", error=message[:500] or e.__class__.__name__)
        generation_jobs.log_end(j)
