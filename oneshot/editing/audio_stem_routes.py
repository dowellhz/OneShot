"""Submit vocal and accompaniment separation jobs and look up prior results."""

import asyncio
import hashlib
import json
import re
import time
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import audio_separation
from oneshot.editing import render as film
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import tools
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


STEM_LOCK = asyncio.Lock()


def stem_source(user, bid, nid, ref):
    if not all(isinstance(value,str) for value in (bid,nid,ref)):
        raise http_errors.bad("请选择画布上的视频或音频版本")
    board = board_meta(canvas_routes.board_path(bid))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    source = next((n for n in board.get("nodes",[]) if n["id"] == nid and n["type"] in ("audio","video")),None)
    if not source or not any(v.get("ref") == ref for v in source.get("versions",[])):
        raise http_errors.bad("原素材版本已移除，请重新选择")
    media_routes.require_media(user,{ref})
    return source


async def latest_stems(req):
    user = req["user"]
    bid, nid, ref = (req.query.get(key) for key in ("board","node","ref"))
    stem_source(user,bid,nid,ref)
    last = db.one("""SELECT id,request FROM tasks WHERE user_id=? AND board_id=? AND capability='audio_separation'
                     AND json_extract(request,'$.node')=? AND json_extract(request,'$.ref')=?
                     ORDER BY created DESC LIMIT 1""",user["id"],bid,nid,ref)
    return web.json_response({"available":bool(audio_separation.executable()),
        "latest":{"id":last["id"],"range":json.loads(last["request"])["range"]} if last else None})


async def request_stems(req):
    payload = await req.json()
    if not isinstance(payload,dict):
        raise http_errors.bad("请选择画布上的视频或音频版本")
    user = req["user"]
    bid, nid, ref, attempt = (payload.get(key) for key in ("board","node","ref","request_key"))
    source = stem_source(user,bid,nid,ref)
    if not isinstance(attempt,str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}",attempt):
        raise http_errors.bad("音轨分离请求编号无效")
    try:
        requested = audio_separation.range_values(payload)
        path = tools.ref_path(config.COMFY_DIR,ref)
        start, end = await asyncio.to_thread(audio_separation.media_range,path,source["type"],*requested)
    except (ValueError,OSError,OverflowError) as error:
        raise http_errors.bad(str(error)) from None
    source = stem_source(user,bid,nid,ref)
    jid = "t" + hashlib.sha256(json.dumps(["stems",user["id"],bid,nid,ref,attempt]).encode()).hexdigest()[:12]
    interval = {"start":start / film.SR,"end":end / film.SR}
    receipt = {"node":nid,"ref":ref,"range":interval}
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?",jid,user["id"]):
        if json.loads(prior["request"]) != receipt:
            return auth.err(409,"分离区间已变更，请重新提交")
        return web.json_response({"id":jid,"range":interval})
    for job in generation_jobs.JOBS.values():
        if job["state"] not in ("running","queued") or job.get("mode") != "audio_separation":
            continue
        if (job["meta"]["uid"],job["meta"]["board"],job["meta"]["node"],job["meta"]["ref"]) == (user["id"],bid,nid,ref):
            if job["meta"]["range"] == interval:
                return web.json_response({"id":job["id"],"range":interval})
            return auth.err(409,"此版本已有分离任务，请等待完成或取消后再切换区间")
    binary = audio_separation.executable()
    if not binary:
        return auth.err(503,"部署主机尚未配置人声分离模型")
    mode = "人声分离"
    label = http_errors.clean(source.get("name"))[:50] or mode
    meta = {"uid":user["id"],"board":bid,"node":nid,"ref":ref,"range":interval,
            "label":label,"mode_name":mode}
    job = {"id":jid,"kind":"audio","mode":"audio_separation","state":"queued","created":time.time(),"meta":meta}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability="audio_separation",
                  provider_id="local_demucs",provider_kind="local_demucs",model=audio_separation.MODEL,request=receipt)
    generation_jobs.JOBS[jid] = job
    asyncio.create_task(run_stems(job,binary,path,source["type"],start,end))
    return web.json_response({"id":jid,"range":interval})


async def run_stems(job, binary, path, kind, start, end):
    async with STEM_LOCK:
        if job.get("cancel"):
            return
        jid = job["id"]
        job.update(state="running",started=time.time())
        db.task_update(jid,state="running",started=job["started"])
        try:
            def phase(value):
                job["phase"] = value
            refs = await audio_separation.separate(config.COMFY_DIR,binary,path,kind,start,end,phase,lambda:job.get("cancel"))
            if job.get("cancel"):
                for ref in refs.values():
                    tools.ref_path(config.COMFY_DIR,ref).unlink(missing_ok=True)
                return
            duration = (end-start) / film.SR
            outputs = [{"ref":refs[stem],"url":"/media?ref="+quote(refs[stem],safe=""),
                        "meta":{"duration":duration},"extra":{"stem":stem}} for stem in audio_separation.STEMS]
            job.update(state="done",phase="done",outputs=outputs,finished=time.time())
        except film.Cancelled:
            job.update(state="error",error="已取消")
        except Exception as error:
            if not job.get("cancel"):
                detail = str(error) if isinstance(error,ValueError) else "无法读取音频或运行分离模型"
                job.update(state="error",error=detail[:300])
        finally:
            generation_jobs.log_end(job)
