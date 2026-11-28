"""Timeline validation, previews, and rendering endpoints."""

import asyncio
import hashlib
import json
import re
import time
import uuid
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import broll
from oneshot.editing import image_editor
from oneshot.editing import previs
from oneshot.editing import render as film
from oneshot.editing import video_remake
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import tools
from oneshot.memory import creative_memory
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import history as media_history
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


RENDER_LOCK = asyncio.Lock()


DEPTH_LOCK = asyncio.Lock()


def film_preflight(spec, user=None, board=None):
    from oneshot import app as application

    if not isinstance(spec, dict) or not isinstance(spec.get("clips"), list) or not spec["clips"]:
        raise ValueError("时间线上没有图片或视频")
    if spec.get("aspect", "source") not in {"source","16:9","9:16","1:1","4:3","3:4","21:9"}:
        raise ValueError("请选择支持的成片画幅")
    film.title_items(spec.get("titles", []))
    film.cutaway_items(config.COMFY_DIR,spec.get("cutaways", []))
    audio_clips = spec.get("audio_clips", [])
    if not isinstance(audio_clips, list):
        raise ValueError("音频片段格式无效")
    problems = []
    first_size = None
    sessions, audio_sources = {}, {}
    for i, clip in enumerate(spec["clips"]):
        try:
            _, w, h, duration, start, end = film.clip_info(config.COMFY_DIR, clip)
            if not 0 <= start < end <= duration + 1 / film.FPS:
                raise ValueError()
            first_size = first_size or (w, h)
        except Exception:
            problems.append({"clip":i, "error":f"第 {i + 1} 段素材无法读取，或时长超出范围"})
            continue
        try:
            film.clip_speed(clip)
            if "captions" in clip:
                film.subtitle_captions(clip["captions"])
        except ValueError as error:
            problems.append({"clip":i, "error":f"第 {i + 1} 段：{error}"})
        try:
            film.clip_source_audio(config.COMFY_DIR, clip, start, end, audio_sources)
        except (TypeError, ValueError, IndexError, KeyError, OSError):
            problems.append({"clip":i, "error":f"第 {i + 1} 段原片音轨无法读取，或剪辑点超出范围"})
        if provenance := clip.get("remake_shot"):
            try:
                source = provenance["source"]
                k = (provenance["node"], source)
                if k not in sessions:
                    key = video_remake.remake_key(application, user, board, *k)
                    session = video_remake.load(key)
                    video_remake.update_jobs(application, user["id"], session)
                    sessions[k] = session
                session = sessions[k]
                index, shot = next((j, s) for j, s in enumerate(session["shots"])
                                   if s["start"] == provenance["start"] and s["end"] == provenance["end"])
                review, issue = video_remake.export_choice(shot, session.get("mapping"), index)
                if issue or (review["ref"] if review else source) != clip["ref"]:
                    raise ValueError()
            except (KeyError, TypeError, ValueError, StopIteration, web.HTTPException):
                problems.append({"clip":i, "error":f"第 {i + 1} 段审核版本或剪辑点已变更，请更新这一镜"})
    for ref, label, video in [(spec.get("remake_audio"), "原声", True),
                              ((spec.get("bgm") or {}).get("ref"), "配乐", False),
                              *((a.get("ref"), f"第 {i + 1} 段旁白", False) for i, a in enumerate(spec.get("narration") or []))]:
        if not ref:
            continue
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
            if video:
                w, h, duration, _ = film.probe(path)
                if not 0 < duration <= 60:
                    raise ValueError()
                first_size = (w, h)
            else:
                import av
                with av.open(str(path)) as media:
                    if not media.streams.audio:
                        raise ValueError()
        except Exception:
            problems.append({"error":f"{label}文件无法读取"})
    for i, clip in enumerate(audio_clips):
        try:
            film.audio_clip_info(config.COMFY_DIR, clip)
        except (TypeError, ValueError, IndexError, KeyError, OSError):
            problems.append({"audio":i, "error":f"第 {i + 1} 段音频无法读取，或入点、出点和音量超出范围"})
            continue
        if "captions" in clip:
            try:
                film.subtitle_captions(clip["captions"])
            except ValueError as error:
                problems.append({"audio":i, "error":f"第 {i + 1} 段音频的旁白字幕无效：{error}"})
    dimensions = film.target_size(*first_size, spec.get("aspect") or "source") if first_size else None
    return {"ok":not problems, "issues":problems, "dimensions":dimensions}


async def render_check(req):
    data = await req.json()
    try:
        result = await asyncio.to_thread(film_preflight, data.get("spec"), req["user"], data.get("board"))
    except (AttributeError, TypeError, ValueError) as e:
        raise http_errors.bad(str(e))
    return web.json_response(result)


def film_render_job_id(user_id, attempt):
    return "r" + hashlib.sha256(f"{user_id}:{attempt}".encode()).hexdigest()[:24]


async def render_film(req):
    """成片: render a timeline in the background; it is tracked like a generation job (poll /api/jobs)."""
    p = await req.json()
    spec = p.get("spec") or {}
    attempt = p.get("request_key")
    target = p.get("target")
    if target is not None:
        if not isinstance(target,dict) or not isinstance(target.get("node"),str):
            raise http_errors.bad("请选择要保存新版本的视频")
        if not attempt:
            raise http_errors.bad("保存为新版本需要导出请求编号")
        field = "playlist_revision" if "playlist_revision" in target else "ref"
        if not isinstance(target.get(field),str) or field == "playlist_revision" and not re.fullmatch(r"[a-f0-9]{64}",target[field]):
            raise http_errors.bad("请选择要保存新版本的视频")
        target = {k:target[k] for k in ("node",field)}
    if not attempt:
        return enqueue_film(req, spec, label=p.get("label"))
    if not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise http_errors.bad("导出请求编号无效")
    uid = req["user"]["id"]
    jid = film_render_job_id(uid, attempt)
    fingerprint = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    try:
        check = await asyncio.to_thread(film_preflight, spec, req["user"], p.get("board"))
    except (AttributeError, TypeError, ValueError) as e:
        raise http_errors.bad(str(e))
    prior = db.one("SELECT state,request FROM tasks WHERE id=? AND user_id=?", jid, uid)
    if prior:
        saved = json.loads(prior["request"])
        if saved["fingerprint"] != fingerprint or ("target" in saved and saved["target"] != target):
            raise http_errors.bad("导出内容已变更，请重新检查后提交")
        return web.json_response({"ids":[jid],"meta":generation_jobs.JOBS.get(jid, {}).get("meta") or {"est":0}})
    if not check["ok"]:
        raise http_errors.bad(check["issues"][0]["error"])
    request_data = {"fingerprint":fingerprint}
    if target is not None:
        board = board_meta(canvas_routes.board_path(p.get("board")))
        if not board or not can_edit(req["user"],board):
            raise web.HTTPForbidden()
        node = next((n for n in board.get("nodes",[]) if n.get("id")==target["node"] and n.get("type")=="video"),None)
        if "playlist_revision" in target:
            data = node.get("data",{}) if node else {}
            if not data.get("playlist") or film.playlist_revision(data.get("film")) != target["playlist_revision"]:
                return auth.err(409,"播放列表已变化，请重新打开后导出")
        elif not node or not any(v.get("ref")==target["ref"] for v in node.get("versions",[])):
            return auth.err(409,"剪辑所用的视频版本已移除")
        if node.get("job"):
            return auth.err(409,"节点正在处理另一个任务，请稍候")
        request_data["target"] = target
    return enqueue_film(req, spec, label=p.get("label"), board=p.get("board"), jid=jid, request_data=request_data)


def enqueue_film(req, spec, *, label=None, source_audio=None, board=None, display=True, jid=None, request_data=None):
    clips = [c for c in spec.get("clips") or [] if c.get("ref")]
    if not clips:
        raise http_errors.bad("时间线上没有图片或视频")
    try:
        secs = sum(image_editor.number(c.get("duration"), .5, 60, "图片停留时长", 3) if c.get("kind") == "image"
                   else max(.5, float(c.get("out") or 8) - float(c.get("in") or 0)) / film.clip_speed(c) for c in clips)
    except (TypeError, ValueError) as error:
        raise http_errors.bad(str(error)) from None
    def render_timeline(progress, cancelled):
        return film.render(config.COMFY_DIR, spec, progress, cancelled, source_audio=source_audio, display=display)
    return enqueue_render(req, render_timeline, seconds=secs, label=label, board=board, jid=jid, request_data=request_data)


async def broll_source(user, payload):
    if not isinstance(payload,dict) or not isinstance(payload.get("board"),str):
        raise ValueError("请选择来源画布和素材")
    board_id = payload["board"]
    board = board_meta(canvas_routes.board_path(board_id))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    node = next((node for node in board.get("nodes",[]) if node.get("id")==payload.get("node")),None)
    if not node or node.get("type") not in ("image","video"):
        raise ValueError("请选择一张图片或一段视频")
    ref = payload.get("ref")
    if not isinstance(ref,str) or not any(version.get("ref")==ref for version in node.get("versions",[])):
        raise ValueError("所选素材版本已移除")
    media_routes.require_media(user,{ref})
    path = tools.ref_path(config.COMFY_DIR,ref)
    kind = node["type"]
    extensions = creative_memory.IMAGE_EXT if kind == "image" else tools.VIDEO_EXT
    if not path.is_file() or path.suffix.lower() not in extensions:
        raise ValueError("所选素材文件不可用")
    try:
        duration = (await asyncio.to_thread(film.probe,path))[2] if kind == "video" else None
    except Exception as error:
        raise ValueError("无法读取来源视频") from error
    return board_id,node,ref,duration


async def draft_broll(req):
    payload = await req.json()
    try:
        _, node, _, duration = await broll_source(req["user"],payload)
        mode = payload.get("mode")
        if not isinstance(mode,str) or mode not in broll.MODES or mode == "motion" and node["type"] != "image":
            raise ValueError("请选择可用的 B-roll 类型")
        brief = broll.text(payload.get("brief"),1000,"画面说明")
        options = {key:payload[key] for key in ("start","end","duration","style") if key in payload}
    except (TypeError,ValueError) as error:
        raise http_errors.bad(str(error)) from None
    guide = {"title":"{\"title\":\"短标题\"}","captions":"{\"lines\":[\"第一行\",\"第二行\"]}",
             "chart":"{\"title\":\"标题\",\"bars\":[{\"label\":\"名称\",\"value\":1}]}","motion":"{\"direction\":\"in 或 out\"}"}[mode]
    system = "你为视频制定动态图形草稿。只输出 JSON，保留用户明确给出的文字和数字。字幕卡为1–6行。条形图需2–6项，只采用用户已给出的非负数值，材料不足时返回空 bars。不要虚构统计数据。输出格式 " + guide
    try:
        reply = await req.app["llm"].chat(system, brief, max_tokens=650, temperature=.2)
        draft = tools.parse_json(reply)
    except Exception:
        return auth.err(503,"无法使用当前文本模型起草，可在控制台检查配置，或手动填写")
    try:
        if not isinstance(draft,dict):
            raise ValueError("文本模型未返回可用草稿")
        result = broll.recipe({**draft,**options,"mode":mode},node["type"],duration)
    except (TypeError,ValueError) as error:
        raise http_errors.bad(str(error)) from None
    return web.json_response(result)


async def render_broll(req):
    payload = await req.json()
    try:
        board_id,node,ref,duration = await broll_source(req["user"],payload)
        graphics = broll.recipe(payload.get("recipe"),node["type"],duration)
        attempt = payload.get("request_key")
        if not isinstance(attempt,str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}",attempt):
            raise ValueError("B-roll 请求编号无效")
    except (TypeError,ValueError) as error:
        raise http_errors.bad(str(error)) from None
    kind = node["type"]
    duration = duration if kind == "video" else graphics["duration"]
    clip = {"ref":ref,"kind":kind,"tight":True,"out":duration} if kind == "video" else {"ref":ref,"kind":kind,"duration":duration}
    spec = {"clips":[clip],"aspect":"source","fit":"crop","subtitles":False,"broll":graphics,"cover":0}
    fingerprint = hashlib.sha256(json.dumps([board_id,node["id"],spec],sort_keys=True).encode()).hexdigest()
    uid = req["user"]["id"]
    jid = "broll" + hashlib.sha256(f"{uid}:{attempt}".encode()).hexdigest()[:20]
    prior = db.one("SELECT request FROM tasks WHERE id=? AND user_id=?",jid,uid)
    if prior:
        if media_history.task_settings(prior["request"]).get("fingerprint") != fingerprint:
            return auth.err(409,"B-roll 内容已变更，请重新提交")
        return web.json_response({"ids":[jid],"meta":generation_jobs.JOBS.get(jid,{}).get("meta",{}),"recipe":graphics})

    def render_graphics(progress,cancelled):
        return film.render(config.COMFY_DIR,spec,progress,cancelled,max_side=1920 if kind == "image" else None)

    response = enqueue_render(req,render_graphics,seconds=duration,label=node.get("name"),board=board_id,jid=jid,
                              request_data={"fingerprint":fingerprint,"broll":graphics,"source":ref},mode="B-roll")
    return web.json_response({**json.loads(response.body),"recipe":graphics})


def enqueue_render(req, render_clip, *, seconds, label=None, board=None, jid=None, request_data=None, depth=False, mode=None):
    jid = jid or "r" + uuid.uuid4().hex[:12]
    mode = mode or ("深度参考" if depth else "成片")
    j = generation_jobs.JOBS[jid] = {"id": jid, "kind": "render", "state": "queued", "created": time.time(),
                     "meta": {"label": http_errors.clean(label)[:60] or mode, "est": round(3 + seconds * (20 if depth else FPS_EST), 1),
                              "cls": "depth" if depth else "render", "units": seconds,
                              "uid": req["user"]["id"], "board": board, "mode_name": mode}}
    db.task_start(id=jid, user_id=req["user"]["id"], board_id=board, capability="render",
                  label=j["meta"]["label"], request=request_data)

    async def run():
        async with (DEPTH_LOCK if depth else RENDER_LOCK):
            if j.get("cancel"):
                j.update(state="error", error="已取消")
                generation_jobs.log_end(j)
                return
            j["state"] = "running"; j["started"] = time.time()
            db.task_update(jid, state="running", started=j["started"])

            def prog(a, b):
                j["value"], j["max"] = a, b
            try:
                r = await asyncio.to_thread(render_clip, prog, lambda: j.get("cancel"))
            except film.Cancelled:
                j.update(state="error", error="已取消")
                generation_jobs.log_end(j)
                return
            except Exception as e:
                if not j.get("cancel"):
                    action = "合成" if mode == "成片" else mode
                    j.update(state="error", error=f"{action}失败：{e}"[:500])
                generation_jobs.log_end(j)
                return
            if j.get("cancel"):
                return
            media_routes.grant_media(req["user"], r.get("cover"))
            extra = {"cover": r.get("cover"), "cover_url": "/media?ref=" + quote(r["cover"], safe="") if r.get("cover") else None}
            j["outputs"] = [{"ref": r["ref"], "url": "/media?ref=" + quote(r["ref"], safe=""),
                             "meta": {"width": r["w"], "height": r["h"], "duration": r["seconds"]}, "extra": extra}]
            j["finished"] = time.time(); j["state"] = "done"
            generation_jobs.log_end(j)
            generation_jobs.record(j)
    asyncio.create_task(run())
    return web.json_response({"ids": [jid], "meta": j["meta"]})


async def previs_camera_motion(req):
    return await previs_motion_plan(req,previs.camera_motion,"camera")


async def previs_object_motion(req):
    return await previs_motion_plan(req,previs.object_motion,"keys")


async def previs_motion_plan(req, motion, result_name):
    try:
        data = await req.json()
        if not isinstance(data,dict):
            raise ValueError("请选择白模场景及运镜设置")
        scene = previs.validate(data.get("scene"))
        track = motion(scene,data.get("plan"))
    except (ValueError,UnicodeError) as error:
        raise http_errors.bad(str(error)) from None
    return web.json_response({result_name:track})


async def render_previs(req):
    payload = await req.json()
    if not isinstance(payload, dict):
        raise http_errors.bad("白模请求格式不正确")
    bid, nid, attempt = (payload.get(key) for key in ("board","node","request_key"))
    if not isinstance(nid, str) or not _ID.fullmatch(nid) or not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise http_errors.bad("节点或请求编号无效")
    board = board_meta(canvas_routes.board_path(bid))
    user = req["user"]
    if not board or not can_edit(user, board):
        return auth.err(404, "画布不存在或没有编辑权限")
    node = next((n for n in board.get("nodes", []) if n.get("id") == nid and n.get("type") == "video"), None)
    if not node or not isinstance(node.get("data", {}).get("previs"), dict):
        return auth.err(404, "白模节点已不存在")
    try:
        scene = previs.validate(node["data"]["previs"])
        span = payload.get("span")
        start, end = previs.render_span(scene,span)
    except ValueError as exc:
        raise http_errors.bad(str(exc))
    render_input = scene if span is None else {"scene":scene,"span":[start,end]}
    fingerprint = hashlib.sha256(json.dumps(render_input, sort_keys=True).encode()).hexdigest()
    jid = "r" + hashlib.sha256(f"previs:{user['id']}:{bid}:{nid}:{attempt}".encode()).hexdigest()[:12]
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?", jid, user["id"]):
        if json.loads(prior["request"] or "{}").get("fingerprint") != fingerprint:
            return auth.err(409, "白模已变更，请重新提交")
        return web.json_response({"ids":[jid]})
    if payload.get("revision") != board.get("rev"):
        return auth.err(409, "画布已变更，请保存后重试")
    if any(j["state"] in ("queued","running") and (m := j.get("meta", {})).get("board") == bid and
           m.get("previs_node") == nid for j in generation_jobs.JOBS.values()):
        return auth.err(409, "这个白模正在渲染")

    def encode(progress, cancelled):
        return previs.export(config.COMFY_DIR, scene, progress, cancelled, span=(start,end))

    label = "白模预演" if span is None else "白模分镜"
    response = enqueue_render(req, encode, seconds=(end-start)/film.FPS, label=label+" · "+http_errors.clean(node.get("name")),
                              board=bid, jid=jid, request_data={"fingerprint":fingerprint}, mode=label+"渲染")
    generation_jobs.JOBS[jid]["meta"]["previs_node"] = nid
    return response


FPS_EST = 0.45   # render seconds per second of film (768p, measured); refined by the stats


async def cover(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, film.cover_frame, config.COMFY_DIR, p["ref"], float(p.get("at") or 0))
    except Exception as e:
        raise http_errors.bad(f"取封面失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    media_routes.grant_media(req["user"], r["ref"])
    return web.json_response(r)
