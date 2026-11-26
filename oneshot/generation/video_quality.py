"""Screen INT8 drafts and verify image-conditioned BF16 renders."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import uuid
from urllib.parse import quote

import aiohttp
from aiohttp import web

from engine import h3_int8
from oneshot import config
from oneshot.generation import graphs, jobs, local, prompts, tools, video_quality_judge as judge
from oneshot.storage import db
from oneshot.web import http as http_errors, media

MAX_ATTEMPTS = 5
MAX_FINAL_ATTEMPTS = 2
FINAL_RETRY_CHECKS = ("subjects","action","order","camera")
MAX_INPUT_IMAGES = 12
RENDER_TIMEOUT = 1800
ENGINE_QUEUE_TIMEOUT = 7200
ENGINE_STATUS_GRACE = 90


def validate(raw, route):
    if not raw.get("quality_precheck"):
        if "quality_precheck" in raw and type(raw["quality_precheck"]) is not bool:
            raise http_errors.bad("质量预检设置无效")
        return
    if raw["quality_precheck"] is not True:
        raise http_errors.bad("质量预检设置无效")
    if (raw.get("kind") != "video" or not route or route["provider"]["kind"] != "local_h3"
            or route["model"] != "h3-video" or any(raw.get(key) for key in (
                "previs_guide", "audio_refs", "video_refs", "draft", "segment_edit", "extension"))):
        raise http_errors.bad("质量预检仅支持本地 H3 BF16 定稿和图片参考")
    if type(raw.get("count", 1)) is not int or raw.get("count", 1) != 1:
        raise http_errors.bad("质量预检每次只生成一个定稿")
    images = raw.get("images") or []
    if not isinstance(images, list) or any(not isinstance(image, dict) for image in images):
        raise http_errors.bad("质量预检图片格式无效")
    if len(images) > MAX_INPUT_IMAGES or sum(image.get("role") == "subject" for image in images) > 9:
        raise http_errors.bad("质量预检最多使用 12 张图片，其中主体参考最多 9 张")
    if raw.get("planned"):
        validate_keyframe_times(images, raw.get("duration"))


def validate_keyframe_times(images, duration):
    try:
        length = graphs.engine_video_frames(min(15.0, max(2.0, float(duration or 5))))
        positions = {}
        for image in images:
            if image.get("role") == "subject":
                continue
            frame = graphs.keyframe_index(image.get("time"), length)
            ref = image.get("ref")
            if positions.setdefault(frame, ref) != ref:
                raise http_errors.bad("不同图片落在同一关键帧，请调整关键帧时间或视频时长")
    except (OverflowError, TypeError, ValueError) as error:
        raise http_errors.bad("质量预检关键帧时间无效") from error


async def enqueue(req, payload):
    app = req.app
    if not app["llm"].local_vision_available():
        raise http_errors.bad("质量预检需要本地 Qwen 视觉模型")
    for delay in (0,0.5,1.5):
        if delay:
            await asyncio.sleep(delay)
        if await local.engine_up(app,int8=True):
            break
    else:
        raise http_errors.bad("质量预检需要就绪的 H3 INT8 引擎")
    payload = deepcopy(payload)
    payload["seed"] = graphs.seed_of(payload.get("seed"))
    jid = "p" + uuid.uuid4().hex[:12]
    cls, units, default = jobs.job_class(payload)
    cls = f"quality|{cls}"
    review = {"limit": MAX_ATTEMPTS, "attempts": [], "attempt": 0}
    meta = {"uid":req["user"]["id"], "board":http_errors.clean(payload.get("board")),
            "label":http_errors.clean(payload.get("label"))[:60], "prompt":payload["prompt"],
            "seed":payload["seed"], "cls":cls, "units":units, "est":jobs.estimate(cls, units, default * 4),
            "engine":True, "mode_name":"H3 质量预检", "quality_review":review}
    job = {"id":jid, "kind":"video", "state":"queued", "created":time.time(), "phase":"quality_prepare", "meta":meta}
    db.task_start(id=jid, user_id=meta["uid"], board_id=meta["board"], label=meta["label"], capability="video",
                  provider_id="local_h3", provider_kind="local_h3", model="h3-video", state="queued", cost=0)
    jobs.JOBS[jid] = job
    task = asyncio.create_task(run(app, job, payload))
    app["remote_tasks"].add(task)
    task.add_done_callback(app["remote_tasks"].discard)
    return web.json_response({"ids":[jid], "meta":meta})


async def engine_request(app, path, *, body=None, params=None):
    request = app["http"].get if body is None else app["http"].post
    options = {"params":params} if body is None else {"json":body}
    async with request(config.ENGINE + path, **options, timeout=aiohttp.ClientTimeout(total=15)) as response:
        result = await response.json()
        if response.status != 200 or not isinstance(result, dict):
            raise RuntimeError("H3 引擎暂不可用")
        return result


async def submit(app, body):
    pending = asyncio.create_task(engine_request(app, "/jobs", body=body))
    try:
        result = await asyncio.shield(pending)
    except asyncio.CancelledError:
        # The engine may have accepted the request even when Web is shutting down.
        try:
            result = await pending
        except Exception:
            result = {}
        if isinstance(result.get("id"), str):
            await jobs.cancel_engine_jobs(app, [result["id"]])
        raise
    if not isinstance(result.get("id"), str) or not result["id"]:
        raise RuntimeError("H3 引擎未接受任务")
    return result["id"]


def check_cancelled(job):
    if job.get("cancel"):
        raise asyncio.CancelledError()


def track_render_progress(job, status):
    if status.get("state") == "queued":
        job.update(engine_queue=status.get("ahead",0), value=None, max=None)
    else:
        sampling = status.get("state") == "running" and status.get("phase") == "sampling"
        job.update(engine_queue=None, value=status.get("value") if sampling else None,
                   max=status.get("max") if sampling else None)


async def wait_render(app, job, eid, stage):
    queued_at = last_response = time.monotonic()
    started = None
    while True:
        check_cancelled(job)
        try:
            result = (await engine_request(app,"/jobs",params={"ids":eid})).get(eid) or {}
        except (aiohttp.ClientError, TimeoutError) as error:
            # Status polling is read-only. Keep the accepted engine task on temporary disconnects.
            if time.monotonic() - last_response >= ENGINE_STATUS_GRACE:
                raise RuntimeError(f"{stage}进度查询超时，无法确认引擎状态") from error
            await asyncio.sleep(2.5)
            continue
        track_render_progress(job, result)
        state = result.get("state")
        if state == "done":
            return
        if state == "error":
            raise RuntimeError(f"{stage}失败：" + str(result.get("error") or "")[:180])
        now = last_response = time.monotonic()
        if state == "running" and started is None:
            started = now
        if started is None and now - queued_at >= ENGINE_QUEUE_TIMEOUT:
            raise TimeoutError(f"{stage}排队超时")
        if started is not None and now - started >= RENDER_TIMEOUT:
            raise TimeoutError(f"{stage}超时")
        await asyncio.sleep(1.5)


async def wait_draft(app, job, eid):
    await wait_render(app, job, eid, "INT8 试生成")


def refined_prompt(original, notes):
    if not notes:
        return original
    hints = " ".join(dict.fromkeys(notes))
    for section in ("detailed_description", "integrated_multimodal_description"):
        updated, found = graphs._append_to_section(original, (section,), hints)
        if found:
            return updated
    return original.rstrip() + "\n\n" + hints


def save_history(job, engine=None):
    meta = job["meta"]
    request = {"history": {**jobs.video_job_details(meta), "seed":meta["seed"]}}
    if engine is not None:
        request["engine"] = engine
    db.task_update(job["id"], request=json.dumps(request))


async def screen(app, job, p, folder, brief):
    review = job["meta"]["quality_review"]
    best = None
    notes = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        check_cancelled(job)
        review["attempt"] = attempt
        job["phase"] = "quality_draft"
        candidate = refined_prompt(p["prompt"], notes)
        draft = {**p, "_int8":True, "prompt":candidate, "quality":"std", "turbo":True}
        graph, meta = graphs.graph_video(draft, native=True)
        target = folder / f"draft-{attempt}.mp4"
        eid = await submit(app, {"kind":"video_int8", "graph":graph, "media_dir":str(config.COMFY_DIR),
                                 "prompt":meta["full_prompt"], "steps":meta["steps"], "seed":p["seed"], "out":str(target)})
        try:
            await wait_draft(app, job, eid)
        except BaseException:
            await jobs.cancel_engine_jobs(app, [eid])
            raise
        check_cancelled(job)
        job["phase"] = "quality_review"
        result = await judge.evaluate(app["llm"], brief, p.get("images") or [], target)
        report = {"attempt":attempt, **result}
        review["attempts"].append(report)
        save_history(job)
        if best is None or report["score"] > best[0]["score"]:
            best = report, candidate
        if report["passed"]:
            break
        notes.append(judge.correction(report, attempt-1))
    return best


async def submit_final(app, job, p, candidate):
    check_cancelled(job)
    body, meta = local.engine_body({**p, "prompt":candidate, "_int8":False})
    out, ref = tools._new(config.COMFY_DIR,"output","quality-video",".mp4")
    eid = await submit(app,{**body, "seed":p["seed"], "out":str(out)})
    return eid, out, ref, meta


async def wait_final(app, job, eid):
    await wait_render(app, job, eid, "BF16 定稿")


async def verify_final(app, job, p, candidate, brief):
    review = job["meta"]["quality_review"]
    review.update(final_limit=MAX_FINAL_ATTEMPTS, final_attempts=[])
    best = None
    rendered = []
    selected_path = None
    recoverable_path = None
    try:
        for attempt in range(1,MAX_FINAL_ATTEMPTS+1):
            review["final_attempt"] = attempt
            job["phase"] = "quality_final"
            try:
                eid, out, ref, meta = await submit_final(app,job,p,candidate)
                rendered.append(out)
                try:
                    if attempt == 1:
                        job["meta"].update(meta)
                        save_history(job,{"id":eid,"out_ref":ref})
                    await wait_final(app,job,eid)
                except BaseException:
                    await jobs.cancel_engine_jobs(app,[eid])
                    raise
            except Exception:
                if best is None:
                    raise
                review["final_retry_failed"] = True
                break
            if attempt == 1:
                recoverable_path = out
            check_cancelled(job)
            job["phase"] = "quality_final_review"
            job["value"] = job["max"] = None
            try:
                verdict = await judge.evaluate(app["llm"],brief,p["images"],out)
            except Exception:
                if best is None:
                    best = (-1,attempt,eid,out,ref,meta,None)
                review["final_review_failed"] = True
                break
            check_cancelled(job)
            review["final_attempts"].append({"attempt":attempt, **verdict})
            if best is None or verdict["score"] > best[0]:
                best = (verdict["score"],attempt,eid,out,ref,meta,verdict)
            if (attempt == MAX_FINAL_ATTEMPTS
                    or all(verdict["checks"][key] != "fail" for key in FINAL_RETRY_CHECKS)):
                break
            repair = judge.correction(verdict,0,only_failures=True)
            if not repair:
                break
            candidate = refined_prompt(candidate,[repair])

        check_cancelled(job)
        _, attempt, eid, out, ref, meta, verdict = best
        review["final_selected"] = attempt
        if verdict is not None:
            review["final_assessment"] = verdict
        job["meta"].update(meta)
        save_history(job,{"id":eid,"out_ref":ref})
        recoverable_path = out
        await jobs.complete_outputs(job,[{"ref":ref,"url":"/media?ref="+quote(ref,safe=""),
                                         "meta":media.media_info(out,job["kind"])}])
        if job["state"] == "done":
            selected_path = out
    except asyncio.CancelledError:
        if recoverable_path is not None and not job.get("cancel"):
            selected_path = recoverable_path
            job["_recoverable_final"] = True
        raise
    finally:
        for path in rendered:
            if path != selected_path:
                path.unlink(missing_ok=True)


async def publish(app, job, p, report, candidate, brief):
    check_cancelled(job)
    review = job["meta"]["quality_review"]
    review.update(selected=report["attempt"],passed=report["passed"],fallback=not report["passed"])
    job["phase"] = "quality_final"
    if p.get("images"):
        await verify_final(app,job,p,candidate,brief)
        return
    eid, _, ref, meta = await submit_final(app,job,p,candidate)
    try:
        check_cancelled(job)
        job["meta"].update(meta)
        save_history(job,{"id":eid,"out_ref":ref})
    except BaseException:
        await jobs.cancel_engine_jobs(app,[eid])
        raise
    job.update(eid=eid,out_ref=ref)
    asyncio.create_task(jobs.follow_engine(app))


async def run(app, job, payload):
    try:
        check_cancelled(job)
        job.update(state="running", started=time.time())
        db.task_update(job["id"], state="running", started=job["started"])
        p = await prompts.to_english(app, payload, local_only=True)
        await app["llm"].release_gpu()
        check_cancelled(job)
        with TemporaryDirectory(prefix="oneshot-quality-drafts-") as folder:
            report, prompt = await screen(app, job, p, Path(folder), payload["prompt"])
        await publish(app, job, p, report, prompt, payload["prompt"])
    except asyncio.CancelledError:
        if not job.get("cancel") and not job.get("_recoverable_final"):
            job.update(state="error", error="质量预检已中断，请重新提交")
            jobs.log_end(job)
        raise
    except Exception as error:
        if not job.get("cancel"):
            job.update(state="error", error=str(error)[:300] or "质量预检失败")
            jobs.log_end(job)
