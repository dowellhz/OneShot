"""Audio uploads, speech synthesis, and sound generation endpoints."""

import asyncio
import hashlib
import json
import math
import os
import re
import time
import uuid
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.assistant import agent_chat
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import image_editor
from oneshot.editing import render as film
from oneshot.editing import tts
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import remote_jobs
from oneshot.generation import tools
from oneshot.generation.audio import AUDIO_GENERATION_MODES
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.providers.noiz import SPEED_RANGE as NOIZ_SPEED_RANGE
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


async def upload_audio(req):
    reader = await req.multipart()
    part = await reader.next()
    if part is None or not part.filename:
        raise http_errors.bad("请选择音频文件")
    raw = await part.read(decode=False)
    ext = os.path.splitext(part.filename or "x.mp3")[1].lower() or ".mp3"
    if ext not in (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".webm"):
        raise http_errors.bad("不支持的音频格式")
    name = f"music_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
    dst = config.COMFY_DIR / "input" / "h3studio" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(raw)

    def dur():
        import numpy as np
        a = film.read_audio(dst)
        if not a.shape[1] or float(np.abs(a).max()) == 0:
            raise ValueError("文件里没有声音")
        return round(a.shape[1] / film.SR, 2)
    try:
        secs = await asyncio.get_running_loop().run_in_executor(None, dur)
    except Exception as e:
        dst.unlink(missing_ok=True)
        raise http_errors.bad(f"读不了这个音频：{e}")
    ref = f"input:h3studio/{name}"
    media_routes.grant_media(req["user"], ref)
    return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "seconds": secs, "name": part.filename or name})


async def voices(_):
    vs = list(tts.VOICES) if tts.available() else []
    route = providers.primary("tts")
    if route and route["provider"]["kind"] == "minimax":
        vs = [{"id": v, "name": f"{n}（MiniMax）"} for v, n in remote.MM_VOICES] + vs
    for option in audio_routes("tts"):
        provider = option["provider"]
        if provider["kind"] != "noiz":
            continue
        configured = [{**voice, "provider": provider["id"], "service": provider["name"]} for voice in option["voices"]]
        vs = configured + vs if route and route["provider"]["id"] == provider["id"] else vs + configured
    return web.json_response({"available": bool(vs), "voices": vs})


async def tts_say(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("配音请求格式无效")
    if p.get("provider"):
        route = next((item for item in audio_routes("tts") if item["provider"]["id"] == p["provider"]), None)
        if not route:
            raise http_errors.bad("所选音频服务不可用，请检查控制台配置")
        if not any(item["id"] == p.get("voice") for item in route["voices"]):
            raise http_errors.bad("请选择所选服务提供的音色")
        if route["provider"]["kind"] != "local_kokoro":
            return await tts_remote(req, p, route)
    route = providers.primary("tts")
    if not p.get("provider") and route and route["provider"]["kind"] != "local_kokoro" and not str(p.get("voice") or "").startswith(("zf_", "zm_")):
        return await tts_remote(req, p, route)
    if not tts.available():
        raise http_errors.bad("配音模型还没装好")
    text = http_errors.clean(p.get("text"))
    if not text:
        raise http_errors.bad("先写旁白文字")
    t0 = time.time()
    try:
        r = await tts.say(config.COMFY_DIR, text, p.get("voice") or tts.VOICES[0]["id"], float(p.get("speed") or 1.0))
    except Exception as e:
        raise http_errors.bad(f"配音失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    r["took"] = round(time.time() - t0, 1)
    media_routes.grant_media(req["user"], r["ref"])
    return web.json_response(r)


def audio_routes(cap):
    routes = {}
    for route in providers.routes(cap):
        routes.setdefault(route["provider"]["id"],route)
    for provider in providers.all_providers():
        if provider["enabled"] and cap in providers.caps_of(provider):
            routes.setdefault(provider["id"], {"provider":provider,"model":providers.default_model(provider, cap)})
    result = []
    for route in routes.values():
        p = route["provider"]
        if p["kind"] == "local_kokoro":
            if cap == "tts" and tts.available():
                result.append({**route, "voices":tts.VOICES})
        elif (p["kind"], cap) in remote.ADAPTERS and p.get("secrets", {}).get("api_key"):
            if p["kind"] in providers.VOICE_LIST_PROVIDERS and cap == "tts":
                voices = providers.configured_voices(p["kind"], p["config"].get("voices", ""))
                if not voices:
                    continue
                option = {**route, "voices": voices, "speed_range": NOIZ_SPEED_RANGE}
                if p["kind"] == "elevenlabs":
                    option.update(speed_range=[1,1] if route["model"] == "eleven_v3" else [.7,1.2], subtitles=True)
                result.append(option)
            elif cap == "seed_audio":
                result.append({**route,"voices":[],"subtitles":True})
            else:
                voices = [{"id":v,"name":name} for v,name in remote.MM_VOICES] if cap == "tts" else []
                result.append({**route, "voices":voices})
    return result


def audio_service_options(cap):
    return [{"id":r["provider"]["id"],"name":r["provider"]["name"],"model":r["model"],"voices":r["voices"],
             **({"music_duration": True} if cap == "music" and r["provider"]["kind"] == "elevenlabs" else {}),
             **{key:r[key] for key in ("speed_range","subtitles") if key in r}} for r in audio_routes(cap)]


def seed_audio_bindings(board, user, raw, target_id):
    if not isinstance(raw,list) or len(raw)>3:
        raise http_errors.bad("请选择最多 3 段参考音频或 1 张参考图")
    assets, kinds = [], set()
    nodes = {n["id"]:n for n in board.get("nodes",[])}
    seen = set()
    for item in raw:
        if not isinstance(item,dict) or not all(isinstance(item.get(k),str) for k in ("node_id","ref")):
            raise http_errors.bad("参考素材格式无效")
        ident, ref = item["node_id"], item["ref"]
        source = nodes.get(ident)
        if (not source or ident==target_id or source.get("type") not in ("audio","image") or
                not any(v.get("ref")==ref for v in source.get("versions",[])) or ref in seen):
            raise http_errors.bad("参考素材已移除、重复或不是画布上的可用版本")
        kind = source["type"]
        seen.add(ref)
        kinds.add(kind)
        assets.append({"node_id":ident,"ref":ref,"kind":kind})
    if len(kinds)>1 or kinds=={"image"} and len(assets)>1:
        raise http_errors.bad("参考音频和参考图不能混用，最多选择 1 张图")
    media_routes.require_media(user,seen)
    return assets


def seed_audio_reference_bytes(entries):
    resolved = []
    for entry in entries:
        kind, ref = entry["kind"], entry["ref"]
        path = tools.ref_path(config.COMFY_DIR,ref)
        if not path.is_file() or path.stat().st_size>10_000_000:
            raise ValueError("参考素材不存在或超过 10 MB")
        ext = path.suffix.lower()
        if kind == "image":
            if ext not in (".jpg",".jpeg",".png",".webp"):
                raise ValueError("参考图片须为 JPEG、PNG 或 WebP")
            data = path.read_bytes()
        else:
            if ext not in tools.AUDIO_EXT or film.audio_duration(path)>30.001:
                raise ValueError("单段参考音频须在 30 秒以内")
            if ext in (".wav",".mp3"):
                data = path.read_bytes()
            else:
                data, _, _ = film.transcription_wav(config.COMFY_DIR,{"ref":ref},audio_only=True)
        if not data or len(data)>10_000_000:
            raise ValueError("参考素材为空或超过 10 MB")
        resolved.append({"kind":kind,"data":data})
    return resolved


def seed_audio_prompt(text, references):
    count = sum(x["kind"]=="audio" for x in references)
    tokens = {int(m) for m in re.findall(r"@音频(\d{1,4})(?!\d)",text)}
    if any(i<1 or i>count for i in tokens):
        raise http_errors.bad("提示词引用了不存在的参考音频")
    missing = [f"@音频{i}" for i in range(1,count+1) if i not in tokens]
    effective = text + ("\n声音参考：" + "、".join(missing) if missing else "")
    if len(effective)>3000:
        raise http_errors.bad("提示词加参考编号后不能超过 3000 字")
    return effective


async def generate_audio(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("mode"),str) or raw["mode"] not in AUDIO_GENERATION_MODES:
        raise http_errors.bad("请选择配音、音乐或音效")
    cap, bid, nid, attempt = (raw.get(k) for k in ("mode","board","node","request_key"))
    board = board_meta(canvas_routes.board_path(bid))
    user = req["user"]
    if not board or not can_edit(user, board):
        return auth.err(403, "需要画布编辑权限")
    if nid is not None and not any(n.get("id") == nid and n.get("type") == "audio" for n in board.get("nodes", [])):
        return auth.err(404, "音频节点已不存在")
    if not isinstance(attempt, str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", attempt):
        raise http_errors.bad("音频任务编号格式无效")
    text = raw.get("prompt")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 3000:
        raise http_errors.bad("请填写 1 到 3000 字的配音文案或声音描述")
    route = next((r for r in audio_routes(cap) if not raw.get("provider") or r["provider"]["id"] == raw["provider"]), None)
    if not route:
        return auth.err(503, "所选音频服务不可用，请检查控制台配置")
    provider, model = route["provider"], route["model"]
    if isinstance(req, agent_chat.InternalRequest):
        if req.get("fixed_audio_model") not in (None, model):
            return auth.err(409, "原音频模型已变更，请重新配置后再重试")
        req["generation_model"] = model
    recipe = {"mode":cap,"prompt":text.strip(),"provider":provider["id"]}
    if cap == "tts":
        voice = raw.get("voice") or (route["voices"][0]["id"] if route["voices"] else "")
        if not any(v["id"] == voice for v in route["voices"]):
            raise http_errors.bad("请选择所选服务提供的音色")
        try:
            low, high = route.get("speed_range", (.5,2))
            speed = image_editor.number(raw.get("speed"), low, high, "语速", 1)
        except ValueError as exc:
            raise http_errors.bad(str(exc)) from None
        recipe.update(voice=voice,speed=speed)
        subtitles = raw.get("subtitles",False)
        if type(subtitles) is not bool or subtitles and not route.get("subtitles"):
            raise http_errors.bad("所选配音服务不支持生成同步字幕")
        if route.get("subtitles"):
            recipe["subtitles"] = subtitles
    elif cap == "music":
        lyrics = raw.get("lyrics","")
        if not isinstance(lyrics, str) or len(lyrics.strip()) > 3000:
            raise http_errors.bad("歌词最多 3000 字")
        recipe["lyrics"] = lyrics.strip()
        if raw.get("duration_seconds") is not None:
            duration = raw["duration_seconds"]
            if provider["kind"] != "elevenlabs" or type(duration) not in (int,float) or not 3 <= duration <= 600:
                raise http_errors.bad("指定配乐时长需要支持此设置的服务，范围为 3 到 600 秒")
            recipe["duration_seconds"] = duration
    elif cap == "seed_audio":
        recipe["references"] = seed_audio_bindings(board,user,raw.get("references",[]),nid)
        seed_audio_prompt(recipe["prompt"],recipe["references"])
        subtitles = raw.get("subtitles",False)
        if type(subtitles) is not bool:
            raise http_errors.bad("字幕选项格式无效")
        recipe["subtitles"] = subtitles
    else:
        duration, influence, loop = raw.get("duration_seconds"), raw.get("prompt_influence", .3), raw.get("loop", False)
        if duration is not None and (type(duration) not in (int,float) or not .5 <= duration <= 30):
            raise http_errors.bad("音效时长须在 0.5–30 秒之间")
        if type(influence) not in (int,float) or not 0 <= influence <= 1:
            raise http_errors.bad("提示词影响须在 0–1 之间")
        if type(loop) is not bool:
            raise http_errors.bad("音效循环参数无效")
        recipe.update(duration_seconds=duration,prompt_influence=influence,loop=loop)
    output = raw.get("audio_format","source")
    if not isinstance(output,str) or (output != "source" and output not in film.AUDIO_OUTPUT_RATES):
        raise http_errors.bad("请选择支持的音频输出格式")
    if output != "source":
        rates = film.AUDIO_OUTPUT_RATES[output]
        rate = raw.get("sample_rate")
        if rate is None:
            rate = 44100 if 44100 in rates else rates[0]
        if type(rate) is not int or rate not in rates:
            raise http_errors.bad("所选格式不支持这个采样率")
        recipe.update(audio_format=output,sample_rate=rate)
    pitch, gain = raw.get("pitch_semitones",0), raw.get("gain",1)
    if type(pitch) is not int or not -12 <= pitch <= 12:
        raise http_errors.bad("音高须在 -12 至 +12 半音之间，并使用整数")
    if type(gain) not in (int,float) or not .5 <= gain <= 2:
        raise http_errors.bad("音量须在 0.5 至 2 倍之间")
    if pitch:
        recipe["pitch_semitones"] = pitch
    if gain != 1:
        recipe["gain"] = gain
    jid = "t" + hashlib.sha256(f"{user['id']}:{bid}:{nid}:{attempt}".encode()).hexdigest()[:12]
    fingerprint = hashlib.sha256(json.dumps([recipe,model], sort_keys=True).encode()).hexdigest()
    if prior := db.one("SELECT request FROM tasks WHERE id=? AND user_id=?", jid, user["id"]):
        if json.loads(prior["request"]).get("fingerprint") != fingerprint:
            return auth.err(409, "这次提交的音频参数已变更")
        return web.json_response({"ids":[jid],"recipe":recipe})
    if nid and any(j["state"] in ("queued","running") and (info:=j.get("meta",{})).get("board") == bid and
                   info.get("audio_node") == nid for j in generation_jobs.JOBS.values()):
        return auth.err(409, "此音频节点已有任务")
    mode = AUDIO_GENERATION_MODES[cap]
    label = http_errors.clean(raw.get("label"))[:60] or mode
    meta = {"uid":user["id"],"board":bid,"audio_node":nid,"label":label,"provider":provider["name"],
            "model":model,"mode_name":mode,"est":10 if cap=="tts" else 60}
    job = generation_jobs.JOBS[jid] = {"id":jid,"kind":"audio","state":"queued","created":time.time(),"meta":meta}
    db.task_start(id=jid,user_id=user["id"],board_id=bid,label=label,capability=cap,provider_id=provider["id"],
                  provider_kind=provider["kind"],model=model,request={"fingerprint":fingerprint,"recipe":recipe})
    asyncio.create_task(run_audio(req.app, job, provider, model, recipe))
    return web.json_response({"ids":[jid],"recipe":recipe})


async def run_audio(app, job, provider, model, recipe):
    jid, cap = job["id"], recipe["mode"]
    async with remote_jobs.REMOTE_SEM.setdefault(provider["id"], asyncio.Semaphore(3)):
        if job.get("cancel"):
            return
        job.update(state="running", phase="sampling", started=time.time())
        db.task_update(jid,state="running",started=job["started"])
        try:
            usage = {}
            if provider["kind"] == "local_kokoro":
                result = await tts.say(config.COMFY_DIR,recipe["prompt"],recipe["voice"],recipe["speed"])
                ref = result["ref"]
            else:
                if cap == "tts":
                    request = {"text":recipe["prompt"],"voice":recipe["voice"],"speed":recipe["speed"]}
                    if recipe.get("subtitles"):
                        request["subtitles"] = True
                elif cap == "seed_audio":
                    refs = recipe["references"]
                    request = {"prompt":seed_audio_prompt(recipe["prompt"],refs),"subtitles":recipe["subtitles"],
                               "references":await asyncio.to_thread(seed_audio_reference_bytes,refs)}
                else:
                    keys = ("lyrics",) if cap == "music" else ("duration_seconds","prompt_influence","loop")
                    request = {key:recipe[key] for key in ("prompt",*keys)}
                    if cap == "music" and "duration_seconds" in recipe:
                        request["duration_seconds"] = recipe["duration_seconds"]
                result = await remote.run(app["http"],config.COMFY_DIR,provider,model,cap,request)
                ref = result["files"][0]["ref"]
                usage = {key:result[key] for key in ("cost","units") if result.get(key) is not None}
            if job.get("cancel"):
                return
            path = tools.ref_path(config.COMFY_DIR,ref)
            output = recipe.get("audio_format")
            pitch, gain = recipe.get("pitch_semitones",0), recipe.get("gain",1)
            if output or pitch or gain != 1:
                original = path.suffix.lower().lstrip(".")
                output = output or (original if original in film.AUDIO_OUTPUT_RATES else "wav")
                target, ref = film._new(config.COMFY_DIR,"output","audio_export","."+output)
                job["phase"] = "compositing"
                await asyncio.to_thread(film.encode_audio_delivery,path,target,output,recipe.get("sample_rate"),
                                        lambda:bool(job.get("cancel")),pitch=pitch,gain=gain)
                path = target
            duration = await asyncio.to_thread(film.audio_duration,path)
            if path.suffix.lower() not in tools.AUDIO_EXT or not math.isfinite(duration) or duration <= 0:
                raise ValueError("服务未返回可播放音频")
            extra = {"audio_recipe":recipe}
            if recipe.get("subtitles"):
                cues = []
                for cue in (result.get("captions") or [])[:film.CAPTION_LIMIT]:
                    start = max(round(cue["start"],3),cues[-1]["end"] if cues else 0)
                    end = min(round(duration,3),round(cue["end"],3))
                    if end > start:
                        cues.append({"start":start,"end":end,"text":cue["text"]})
                if cues:
                    extra["audio_transcript"] = {"start":0,"end":round(duration,3),"cues":cues}
            await generation_jobs.complete_outputs(job,[{"ref":ref,"url":"/media?ref="+quote(ref,safe=""),"meta":{"duration":duration},
                                        "extra":extra}])
            db.task_update(jid,**usage)
        except Exception as error:
            if not job.get("cancel"):
                job.update(state="error",error=f"音频生成失败：{error}"[:500])
        generation_jobs.log_end(job)


async def tts_remote(req, p: dict, route: dict):
    text = http_errors.clean(p.get("text"))
    if not text:
        raise http_errors.bad("先写旁白文字")
    pr = route["provider"]
    jid = "t" + uuid.uuid4().hex[:12]
    t0 = time.time()
    db.task_start(id=jid, user_id=req["user"]["id"], label="配音", capability="tts", provider_id=pr["id"], provider_kind=pr["kind"],
                  model=route["model"], state="running", started=t0, request={"text": text[:500]})
    try:
        async with remote_jobs.REMOTE_SEM.setdefault(pr["id"], asyncio.Semaphore(3)):
            r = await remote.run(req.app["http"], config.COMFY_DIR, pr, route["model"], "tts",
                                 {"text": text, "voice": p.get("voice"), "speed": p.get("speed")})
        f = r["files"][0]
        media_routes.grant_media(req["user"], f["ref"])
    except Exception as e:
        db.task_update(jid, state="error", error=str(e)[:500], finished=time.time())
        raise http_errors.bad(f"配音失败：{e}")
    db.task_update(jid, state="done", finished=time.time(), seconds=round(time.time() - t0, 1), units=r.get("units"), outputs=[f["ref"]])
    return web.json_response({"ref": f["ref"], "url": "/media?ref=" + quote(f["ref"], safe=""), "seconds": r.get("seconds") or 0, "took": round(time.time() - t0, 1)})
