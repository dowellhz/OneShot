"""Video reference validation, prompt bindings, and media preparation."""

import asyncio
import copy
import hashlib
import json
import re

from aiohttp import web

from engine import h3_int8
from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import workflow_review
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import camera_plan
from oneshot.editing import image_camera
from oneshot.editing import image_editor
from oneshot.editing import object_edit
from oneshot.editing import previs
from oneshot.editing import render as film
from oneshot.generation import fields as pfields
from oneshot.generation import graphs
from oneshot.generation import motion_reference
from oneshot.generation import prompts
from oneshot.generation import requests as generation_requests
from oneshot.generation import tools
from oneshot.generation import video_prompt_adapters
from oneshot.memory import creative_memory
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.providers import routes as provider_routes
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


def plain_prompt(p: dict) -> str:
    """Fields → one Chinese paragraph for third-party models (they don't speak H3's structured format)."""
    f = p.get("fields")
    if not isinstance(f, dict) or not pfields.has_content(f):
        return http_errors.clean(p.get("prompt"))
    lab = [("style", "风格"), ("scene", "场景"), ("people", "人物"), ("camera", "镜头"), ("action", "动作"), ("dialogue", "对白"), ("sound", "声音"), ("music", "配乐")]
    parts = [f"{t}：{'；'.join(x.strip() for x in str(f.get(k) or '').splitlines() if x.strip())}" for k, t in lab if str(f.get(k) or "").strip()]
    if http_errors.clean(p.get("prompt")):
        parts.append(http_errors.clean(p.get("prompt")))
    return "。".join(parts)


def remote_video_prompt(raw, provider, model):
    images = raw.get("images") or []
    if limit := image_reference_limit(raw,provider,model):
        if len(images)>limit:
            raise http_errors.bad(f"此模型最多支持 {limit} 张参考图")
        if any(not 1 <= int(mark) <= len(images) for mark in re.findall(r"@(?:图|图片)(\d+)",plain_prompt(raw))):
            raise http_errors.bad("提示词引用的参考图不存在，请重新选择")
        prompt = video_reference_prompt(raw,provider,model,guide_frames=True)
        return prompt, ["image_ref"]*len(images)
    frames = [i for i, image in enumerate(images) if image.get("role") != "subject"]
    subjects = [i for i, image in enumerate(images) if image.get("role") == "subject"]
    kling = provider["kind"] == "kling"
    roles = ["unused_image"] * len(images)
    labels = {}
    if frames:
        roles[frames[0]], labels[frames[0]] = "first_frame", "首帧画面"
        if len(frames) > 1 and not (kling and (subjects or "flash" in model)):
            roles[frames[-1]], labels[frames[-1]] = "last_frame", "尾帧画面"
    if kling or not frames:
        for number, i in enumerate(subjects[:7 if kling else 9], 1):
            roles[i], labels[i] = "subject", f"第 {number} 张人物参考图"

    def replace(match):
        i = int(match[1]) - 1
        if i not in labels:
            raise http_errors.bad(f"当前视频服务无法采用 {match[0]}，请调整参考素材或切换视频服务")
        return labels[i]

    prompt = prompts._IMAGE_MENTION.sub(replace,plain_prompt(raw))
    if is_cloud_h3(provider,model):
        prompt = video_prompt_adapters.h3_cloud_prompt(prompt)
    return prompt,roles


def wants_image_references(raw):
    images = raw.get("images") or []
    return len(images)>2 or any(image.get("role")=="subject" for image in images)


def image_reference_limit(raw, provider, model):
    if wants_image_references(raw):
        return motion_reference.image_reference_limit(provider,model)
    return None


def has_remote_image_references(raw, route):
    return bool(route and image_reference_limit(raw,route["provider"],route["model"]))


def configured_models(provider, cap, routes):
    models = [providers.default_model(provider, cap)]
    models.extend(route["model"] for route in routes if route["provider"]["id"] == provider["id"])
    if cap == "video" and provider["kind"] == "ark":
        models.extend(provider.get("config",{}).get("video_endpoint_models",{}))
    if cap == "video" and provider["kind"] == "local_h3" and h3_int8.installed():
        models.append(h3_int8.MODEL)
    return list(dict.fromkeys(model for model in models if model))


def reference_routes(*, require_motion=False, segment_edit=False, extension=False, all_models=False, image_only=False):
    check = motion_reference.supports if require_motion or segment_edit else motion_reference.supports_audio
    def supports(provider, model):
        if image_only:
            return (provider["enabled"] and provider.get("secrets",{}).get("api_key")
                    and motion_reference.image_reference_limit(provider,model))
        return (check(provider,model) and (not extension or provider["kind"] == "ark") and
                (not segment_edit or "seedance-2-5" in motion_reference.video_model_for_limits(provider,model)))
    choices = {}
    routes = providers.routes("video")
    defaults = [{"provider":p,"model":model} for p in providers.all_providers()
                for model in configured_models(p,"video",[])]
    for route in [*routes, *defaults]:
        provider, model = route["provider"], route["model"]
        if supports(provider, model):
            key = (provider["id"], model) if all_models else provider["id"]
            choices.setdefault(key, route)
    return list(choices.values())


def requested_reference_routes(raw):
    has_motion = raw.get("previs_guide") is not None or bool(raw.get("video_refs"))
    edit = bool(raw.get("segment_edit"))
    selected = raw.get("selected_model")
    auto = not raw.get("provider") and selected is None
    routes = reference_routes(require_motion=has_motion,segment_edit=edit,extension=bool(raw.get("extension")),
                              all_models=selected is not None or auto)
    if auto and routes:
        return routes
    for route in routes:
        if route["provider"]["id"] == raw.get("provider") and (selected is None or route["model"] == selected):
            return [route]
    if selected is not None:
        raise http_errors.bad("所选模型不支持当前参考素材或已不可用，请重新选择模型")
    if edit:
        raise http_errors.bad("请选择已配置参考视频公网地址的 Seedance 2.5 服务")
    if has_asset_media(raw):
        raise http_errors.bad("资产包含音频或视频参考，请选择支持全模态参考的视频服务" +
                  ("，并配置参考视频公网地址" if has_motion else ""))
    raise http_errors.bad("请选择支持全模态参考的视频服务" + ("，并配置参考视频公网地址" if has_motion else ""))


def reference_video_duration(raw, provider, model, motion):
    from_previs = motion and motion.get("source") == "previs"
    limit = 14 if from_previs and not raw.get("extension") else remote.video_durations(provider["kind"],model,provider=provider)[-1]
    try:
        seconds = image_editor.number(raw.get("duration"),2,limit,"成片时长",5)
    except ValueError as exc:
        raise http_errors.bad(str(exc)) from None
    return remote.video_duration(provider["kind"],model,seconds,provider=provider)


def checked_video_resolution(raw,kind,model,*,provider=None):
    quality = raw.get("quality") or "hd"
    if quality in ("480p","4k") and (raw.get("draft") or quality not in remote.video_resolutions(kind,model,provider=provider)):
        raise http_errors.bad(f"当前生成模式不支持 {quality.upper()}，请更改分辨率或模型")
    return "480p" if raw.get("draft") else remote.video_resolution(kind,model,quality,provider=provider)


def check_reference_operation(raw):
    entries = raw.get("video_refs")
    has_source_clip = isinstance(entries,list) and bool(entries) and isinstance(entries[0],dict) and not entries[0].get("memory_id")
    extension = raw.get("extension")
    if extension is not None and (extension not in ("before","after") or not has_source_clip):
        raise http_errors.bad("请选择续拍方向和原视频")
    edit = raw.get("segment_edit")
    if edit is not None and (edit is not True or extension or not has_source_clip):
        raise http_errors.bad("请选择要修改的原视频片段")


async def check_reference_inputs(user, raw, provider, model, motion, object_plan):
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    ensure_reference_media_count(raw,provider["kind"],model_for_limits,object_plan)
    clips = await resolve_video_refs(user,raw,model_for_limits,motion) if raw.get("video_refs") else []
    audio = await resolve_audio_refs(user,raw,model_for_limits,provider_kind=provider["kind"]) if raw.get("audio_refs") else []
    return clips,audio


async def prepare_reference_generation(user, raw, object_plan, *, fixed_route=None):
    routes = requested_reference_routes(raw)
    if fixed_route:
        routes = [route for route in routes if route["provider"]["id"] == fixed_route["provider"] and
                  route["model"] == fixed_route["model"]]
        if not routes:
            raise http_errors.bad("原参考视频服务或模型已变更，请重新配置后再重试")
    motion = await resolve_previs_guide(user,raw) if raw.get("previs_guide") is not None else None
    first_error = None
    for route in routes:
        provider, model = route["provider"], route["model"]
        entries = {key:copy.deepcopy(raw[key]) for key in ("audio_refs","video_refs") if raw.get(key)}
        candidate = {**raw,**entries}
        try:
            reference_video_duration(candidate,provider,model,motion)
            checked_video_resolution(candidate,provider["kind"],model,provider=provider)
            if candidate.get("draft") and not remote.supports_video_draft(provider,model):
                raise http_errors.bad("请选择支持原生样片的 Seedance 2.5 服务")
            clips,audio = await check_reference_inputs(user,candidate,provider,model,motion,object_plan)
        except web.HTTPBadRequest as exc:
            if first_error is None:
                first_error = exc
            continue
        for key, value in entries.items():
            kind = "video" if key=="video_refs" else "audio"
            resolved = {(before["ref"],before.get("start"),before.get("end")):after
                        for before,after in zip(raw[key],value)}
            for asset in raw.get("memory_used", []):
                for reference in asset.get("references", []):
                    if reference.get("type") == kind:
                        match = resolved.get((reference["ref"],reference.get("start"),reference.get("end")))
                        if match:
                            reference.update(start=match["start"],end=match["end"])
            raw[key][:] = value
        return route, motion, clips, audio
    raise first_error


def reference_preview_fingerprint(raw, route, *, guide_frames=False):
    snapshot = workflow_review.capture_generation(raw)
    if not guide_frames:
        if plan := resolve_camera_plan(raw):
            snapshot["camera_plan"] = plan
        if plan := resolve_object_edit(raw):
            snapshot["object_edit"] = plan
    provider = route["provider"]
    prompt = (remote_video_prompt(raw,provider,route["model"])[0] if guide_frames
              else video_reference_prompt(raw,provider,route["model"]))
    details = [raw.get("board"),provider["id"],provider.get("updated"),route["model"],prompt,
               snapshot,raw.get("draft")]
    return hashlib.sha256(json.dumps(details,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def needs_reference_review(raw):
    return has_asset_media(raw) or (not raw.get("provider") and raw.get("selected_model") is None and
        any(raw.get(key) for key in ("previs_guide","video_refs","audio_refs")))


def verify_reference_preview(req, raw, route, *, guide_frames=False):
    reviewable = (has_remote_image_references(raw,route) if guide_frames else
                  bool(route and raw.get("kind")=="video" and any(raw.get(k) for k in ("previs_guide","video_refs","audio_refs"))))
    key = req.get("reference_preview")
    confirmed = req.get("reference_reviewed")
    # Older assistant approvals for explicitly selected services did not store a preview key.
    if not key and not (confirmed and reviewable and (guide_frames or needs_reference_review(raw))):
        return
    if not reviewable or key != reference_preview_fingerprint(raw,route,guide_frames=guide_frames):
        next_step = "重新确认生成" if confirmed else "重新预览"
        reason = "参考素材或生成服务已变化" if reviewable else "参考素材已变化"
        creative_memory.fail(f"{reason}，请{next_step}",409)


async def video_reference_models(req):
    raw = await req.json()
    if (not isinstance(raw,dict) or raw.get("kind") != "video" or not isinstance(raw.get("board"),str)
            or not isinstance(raw.get("prompt",""),str) or not isinstance(raw.get("fields",{}),dict)
            or any(not isinstance(raw.get(key,[]),list) or any(not isinstance(item,dict) for item in raw.get(key,[]))
                   for key in ("images","audio_refs","video_refs"))):
        raise http_errors.bad("视频参考设置无效")
    user = req["user"]
    board = board_meta(canvas_routes.board_path(raw["board"]))
    if not board or not can_edit(user,board):
        raise web.HTTPForbidden()
    payload = req.app["creative_memory"].prepare(user,raw,replay_ref=generation_requests.checked_asset_replay(raw),video_reference_check=True)
    check_reference_operation(payload)
    motion = await resolve_previs_guide(user,payload) if payload.get("previs_guide") is not None else None
    resolve_camera_plan(payload)
    object_plan = resolve_object_edit(payload)
    image_only = not (motion or payload.get("video_refs") or payload.get("audio_refs"))
    if image_only and not wants_image_references(payload):
        return web.json_response({"models":[],"message":"当前使用普通文生视频或原生首尾帧。可在节点设置直接选择模型。"})
    resolve_video_reference_images(user,payload)
    routes = reference_routes(require_motion=bool(motion or payload.get("video_refs")),
                              segment_edit=bool(payload.get("segment_edit")),extension=bool(payload.get("extension")),
                              all_models=True,image_only=image_only)
    requested_quality = payload.get("quality")
    requested_quality = requested_quality if isinstance(requested_quality,str) and requested_quality else "hd"
    try:
        duration = image_editor.number(payload.get("duration"),0,300,"成片时长",5)
    except ValueError as exc:
        raise http_errors.bad(str(exc)) from None
    results, defaults = [], {}
    for route in routes:
        provider,model = route["provider"],route["model"]
        defaults.setdefault(provider["id"],model)
        choice = provider_routes.canvas_model_choice(provider,"video",model)
        durations = choice["durations"]
        if motion and not payload.get("extension"):
            durations = [seconds for seconds in durations if seconds <= 14]
        seconds = min(durations,key=lambda value:abs(value-round(duration)))
        draft = bool(payload.get("draft")) and choice["draft"]
        quality = "std" if draft or requested_quality not in choice["qualities"] else requested_quality
        row = {"provider_id":provider["id"],"provider":provider["name"],"model":model,
               **({"endpoint_model":choice["endpoint_model"]} if "endpoint_model" in choice else {}),
               "duration":seconds,"quality":quality,"resolution":"480p" if draft else choice["qualities"][quality],
               "draft":draft,"limits":choice["reference_limits"],"selected":raw.get("provider")==provider["id"]
               and model==(raw.get("selected_model") or defaults[provider["id"]])}
        candidate = copy.deepcopy(payload)
        try:
            clips,audio = await check_reference_inputs(user,candidate,provider,model,motion,object_plan)
            row["video_seconds"] = round((sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0))/film.FPS,2)
            row["audio_seconds"] = round(sum(seconds for _,_,seconds in audio),2)
            if payload.get("segment_edit"):
                source = candidate["video_refs"][0]
                row["duration"] = round(source["end"]-source["start"],2)
        except web.HTTPBadRequest as error:
            row["error"] = json.loads(error.text)["error"]
        results.append(row)
    counts = {"images":len(payload.get("images") or []) + (1 + bool(object_plan.get("replacement_ref")) if object_plan else 0),
              "videos":len(payload.get("video_refs") or []) + bool(motion),"audio":len(payload.get("audio_refs") or [])}
    message = "" if results else "当前没有支持这些参考类型的视频服务，请在控制台检查配置。"
    return web.json_response({"models":results,"counts":counts,"message":message,"image_only":image_only})


async def describe_video_references(user,payload,object_plan):
    check_reference_operation(payload)
    resolve_video_reference_images(user,payload)
    route, motion, clips, _ = await prepare_reference_generation(user,payload,object_plan)
    model, provider = route["model"],route["provider"]
    seconds = reference_video_duration(payload,provider,model,motion)
    if payload.get("segment_edit") and payload.get("video_refs"):
        source = payload["video_refs"][0]
        seconds = round(source["end"]-source["start"],2)
    quality = checked_video_resolution(payload,provider["kind"],model,provider=provider)
    model_for_limits = motion_reference.video_model_for_limits(provider,model)
    limit = motion_reference.av_limits(model_for_limits)[0]
    counts = (("图",len(payload.get("images") or []),motion_reference.image_limit(model_for_limits)),
              ("视频",len(payload.get("video_refs") or [])+bool(motion),limit),
              ("音频",len(payload.get("audio_refs") or []),limit))
    inputs = numbered_reference_inputs(workflow_review.capture_generation(payload)["inputs"],payload,
                                       h3_labels=is_cloud_h3(provider,model))
    input_video_seconds = (sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0))/film.FPS
    return {"provider":provider["name"],"model":model,"duration":seconds,"quality":quality,
            "prompt":video_reference_prompt(payload,provider,model),
            "counts":counts,"inputs":inputs,"assets":[item["name"] for item in payload.get("memory_used",[])],
            "key":reference_preview_fingerprint(payload,route),
            "unit_cost":generation_requests.quoted_video_unit_cost(route,payload,seconds,input_video_seconds=input_video_seconds)}


async def asset_reference_review(req,raw,*,replay_ref=None):
    replay_ref = replay_ref or req.get("replay_memory_ref")
    fields = raw.get("fields")
    prompt = raw.get("prompt", "")
    if not isinstance(prompt, str) or fields is not None and not isinstance(fields, dict):
        raise http_errors.bad("提示词格式不正确")
    has_mention = any(isinstance(part,str) and "@" in part for part in [prompt,*(fields or {}).values()])
    payload = raw
    if replay_ref or has_mention or any(raw.get(key) for key in ("memory_ids","memory_views","video_refs","audio_refs","previs_guide")):
        payload = apply_video_optics(req.app["creative_memory"].prepare(req["user"],raw,replay_ref=replay_ref,
            owner_only=bool(req.get("connector_own_assets"))))
    if any(payload.get(key) for key in ("previs_guide","video_refs","audio_refs")):
        review = await describe_video_references(req["user"],payload,resolve_object_edit(payload))
        return review,review["unit_cost"]
    route = generation_requests.requested_generation_route(payload,"video")
    provider = route["provider"] if route else None
    maximum = (remote.video_durations(provider["kind"],route["model"],provider=provider)[-1]
               if provider and provider["kind"]!="local_h3" else 15)
    duration = payload.get("duration")
    if type(duration) in (int,float) and duration > maximum:
        raise http_errors.bad(f"此模式成片最长 {maximum} 秒")
    if has_remote_image_references(payload,route):
        provider,model = route["provider"],route["model"]
        _, roles = remote_video_prompt(payload,provider,model)
        resolve_video_reference_images(req["user"],payload)
        inputs = numbered_reference_inputs(workflow_review.capture_generation(payload)["inputs"],payload,
                                           h3_labels=is_cloud_h3(provider,model))
        for entry,role in zip(inputs,roles):
            set_video_preview_image_role(entry,role)
        seconds = reference_video_duration(payload,provider,model,None)
        quality = checked_video_resolution(payload,provider["kind"],model,provider=provider)
        limit = image_reference_limit(payload,provider,model)
        cost = generation_requests.quoted_video_unit_cost(route,payload,seconds)
        return {"provider":provider["name"],"model":model,"duration":seconds,"quality":quality,
                "counts":[("图",len(inputs),limit)],"inputs":inputs,"assets":[item["name"] for item in payload.get("memory_used",[])],
                "key":reference_preview_fingerprint(payload,route,guide_frames=True),"unit_cost":cost},cost
    quote = {key:value for key,value in payload.items()
             if key not in ("memory_ids","memory_views","has_asset","prompt","fields")}
    return None,generation_requests.generation_unit_cost(quote)


def previs_routes():
    return reference_routes(require_motion=True)


def resolve_camera_plan(raw):
    if "camera_plan" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("extension"):
        raise http_errors.bad("镜头重拍需要指定原视频片段")
    try:
        return camera_plan.validate(raw["camera_plan"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None


def apply_video_optics(raw):
    if "video_optics" not in raw:
        return raw
    if raw.get("kind","video") != "video":
        raise http_errors.bad("视频镜头参数仅用于视频生成")
    try:
        settings = image_camera.validate_optics(raw["video_optics"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None
    if not settings:
        return raw
    description = "，".join(image_camera.optics_instructions(settings)) + "。"
    fields = raw.get("fields")
    if isinstance(fields,dict) and pfields.has_content(fields):
        camera = str(fields.get("camera") or "").strip()
        return {**raw,"fields":{**fields,"camera":"\n".join(filter(None,(camera,description)))}}
    prompt = str(raw.get("prompt") or "").strip()
    prompt, structured = graphs._append_to_section(prompt,("detailed_description","integrated_multimodal_description"),description)
    return {**raw,"prompt":prompt if structured else "\n".join(filter(None,(prompt,description)))}


def resolve_object_edit(raw):
    if "object_edit" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("camera_plan") or raw.get("extension"):
        raise http_errors.bad("物体编辑需要指定原视频片段")
    try:
        return object_edit.validate(raw["object_edit"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None


def numbered_reference_inputs(inputs, payload, *, h3_labels=False):
    image_count = len(payload.get("images") or [])
    pictures, media = inputs[:image_count],inputs[image_count:]
    guide = next((item for item in media if item.get("role")=="previs"),None)
    videos = motion_reference.ordered_video_references(guide,(item for item in media if item.get("role")=="video_ref"),
                    source_first=bool(payload.get("extension") or payload.get("segment_edit")))
    audio = [item for item in media if item.get("role")=="audio_ref"]
    for prefix,group in (("图片",pictures),("视频",videos),("音频",audio)):
        for index,item in enumerate(group,1):
            item["prompt_reference"] = (video_prompt_adapters.h3_reference_label(prefix,index) if h3_labels
                                        else f"@{prefix}{index}")
    return pictures + videos + audio


def set_video_preview_image_role(item, role):
    if role=="image_ref" and item.get("role") in ("subject","frame"):
        item["image_role"] = item["role"]
    item["role"] = role


def is_cloud_h3(provider, model):
    return provider["kind"] == "minimax" and model in motion_reference.H3_CLOUD_MODELS


def video_reference_prompt(raw, provider, model, *, guide_frames=False):
    prompt = reference_prompt(raw,guide_frames=guide_frames)
    if is_cloud_h3(provider,model):
        return video_prompt_adapters.h3_cloud_prompt(prompt,images=raw.get("images") or [],reference=True)
    return prompt


def reference_prompt(raw, *, guide_frames=False):
    retake = resolve_camera_plan(raw)
    object_plan = resolve_object_edit(raw)
    prompt = plain_prompt(raw)
    if not prompt and not retake and not object_plan:
        raise http_errors.bad("请描述正式视频的内容或画面风格")
    prompt = video_prompt_adapters.map_reference_tokens(
        prompt,lambda kind,number: "@"+{"图":"图片","音":"音频"}.get(kind,kind)+number)
    images = raw.get("images") or []
    frames = [(i,entry) for i,entry in enumerate(images,1)
              if entry.get("role")=="frame" or guide_frames and entry.get("role")!="subject"]
    if frames:
        guidance = []
        duration = raw.get("duration")
        for index,(i,entry) in enumerate(frames):
            at = entry.get("time")
            if raw.get("planned") and isinstance(at,(int,float)) and 0 <= at <= 30:
                position = ("开头" if at <= .01 else "结尾"
                            if isinstance(duration,(int,float)) and at >= duration-.25 else f"约在 {at:g} 秒")
            elif index==0:
                position = "开头"
            elif index==len(frames)-1:
                position = "结尾"
            elif isinstance(at,(int,float)) and 0 < at <= 30:
                position = f"约在 {at:g} 秒"
            else:
                continue
            guidance.append(f"{position}参考 @图片{i} 的构图。")
        if any(graphs.is_character_reference(image) for image in images):
            guidance.append("关键帧里出现的人物与各自的角色参考图共用同一身份。除非镜头明确要求分身，同一角色同时只出现一位。")
        prompt = "".join(guidance) + "\n" + prompt
    extension = raw.get("extension")
    edit = raw.get("segment_edit")
    if raw.get("previs_guide"):
        n = 2 if extension or edit else 1
        guidance = "人物走位和空间关系，机位服从重拍方案。" if retake else "镜头运动、人物走位和空间构图。"
        prompt = (f"参考 @视频{n} 的{guidance}"
                  "按描述和参考图生成正式画面，使用正式场景的材质、光线和色彩。\n" + prompt)
    if extension in ("before","after"):
        direction = "向前" if extension=="before" else "向后"
        boundary = "开头之前" if extension=="before" else "结尾之后"
        prompt = (f"{direction}延长 @视频1。只生成接在原视频{boundary}的新片段。"
                  "让人物外观、场景、光线和动作在接点自然衔接。\n" + prompt)
    if object_plan:
        prompt = (object_edit.instructions(object_plan,len(raw.get("images") or [])+1)+"\n"+prompt).strip()
    elif retake:
        direction = camera_plan.instructions(retake)
        prompt = ("按下列机位方案重拍 @视频1。保留人物外观、原场景、动作内容和发生顺序。"
                  f"保持原片段的时长和画幅。{direction}\n{prompt}").strip()
    elif edit:
        prompt = ("编辑 @视频1 中指定的内容，保留其他人物、场景和镜头节奏。保持原片段的时长和画幅。\n" + prompt)
    return prompt


def has_asset_media(raw):
    return any(isinstance(entry,dict) and entry.get("memory_id") for key in ("audio_refs","video_refs")
               for entry in (raw.get(key) if isinstance(raw.get(key),list) else []))


def is_asset_media(raw, entry):
    if not isinstance(entry,dict) or not entry.get("memory_id"):
        return False
    return any(asset["id"] == entry["memory_id"] and any(item.get("ref") == entry.get("ref")
               for item in asset.get("references",[])) for asset in raw.get("memory_used",[]))


async def resolve_audio_refs(user, raw, model, *, provider_kind="ark"):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["audio_refs"]
    if not isinstance(entries, list) or len(entries) > limit:
        raise http_errors.bad(f"此服务最多可采用 {limit} 段参考音频")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        return_error = json.dumps({"error":"需要画布编辑权限才能提交参考音频"}, ensure_ascii=False)
        raise web.HTTPForbidden(text=return_error, content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "audio"}
    result = []
    for entry in entries:
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise http_errors.bad("音频参考版本已移除或尚未保存，请重新选择")
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
        except ValueError:
            raise http_errors.bad("音频素材格式无效") from None
        if path.suffix.lower() not in media_routes.AUDIO_MEDIA_EXT:
            raise http_errors.bad("请选择音频文件作为参考")
        media_routes.require_media(user, {ref})
        try:
            seconds = await asyncio.to_thread(film.audio_duration, path)
        except (OSError, ValueError):
            raise http_errors.bad("音频文件无法读取") from None
        try:
            start = image_editor.number(entry.get("start"),0,seconds,"音频参考入点",0)
            end = min(seconds,image_editor.number(entry.get("end"),start,seconds+.025,"音频参考出点",seconds))
        except ValueError as exc:
            raise http_errors.bad(str(exc)) from None
        duration = end-start
        if not 2-1e-8 <= duration <= max_seconds+.05:
            raise http_errors.bad(f"每段参考音频须为 2 到 {max_seconds} 秒")
        duration = min(duration,max_seconds)
        result.append((path,start,duration))
        entry.update(start=start,end=round(start+duration,5))
    if sum(seconds for _,_,seconds in result) > max_seconds + .05:
        raise http_errors.bad(f"参考音频总时长不能超过 {max_seconds} 秒")
    if provider_kind == "ark" and max_seconds == 15 and not raw.get("images") and not raw.get("previs_guide") and not raw.get("video_refs"):
        raise http_errors.bad("此服务需要同时连入参考图或参考视频")
    return result


async def resolve_previs_guide(user, raw):
    guide = raw["previs_guide"]
    if not isinstance(guide, dict):
        raise http_errors.bad("白模动作参考格式无效")
    ref, nid = guide.get("ref"), guide.get("node_id")
    if (not isinstance(ref, str) or not re.fullmatch(r"output:h3studio/previs_\d{8}_\d{6}_[a-f0-9]{5}\.mp4", ref)
            or not isinstance(nid, str)):
        raise http_errors.bad("请选择已渲染的白模预演版本")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交白模动作参考"}, ensure_ascii=False),
                                content_type="application/json")
    node = next((n for n in board.get("nodes", []) if n.get("id") == nid and n.get("type") == "video"), None)
    if not node or not any(v.get("source") == "previs" and v.get("ref") == ref for v in node.get("versions", [])):
        raise http_errors.bad("白模预演版本已移除或尚未保存，请重新选择")
    media_routes.require_media(user, {ref})
    path = tools.ref_path(config.COMFY_DIR, ref)
    try:
        w, h, seconds, _ = await asyncio.to_thread(film.probe, path, display=False)
        ticks = round(seconds * film.FPS)
    except (OSError, ValueError, IndexError):
        raise http_errors.bad("白模预演文件无法读取，请重新渲染") from None
    if not motion_reference.eligible(w, h, ticks) or ticks > previs.MAX_SECONDS * film.FPS:
        raise http_errors.bad("白模预演时长或画幅超出动作参考范围")
    return {"path":path, "ticks":ticks, "source":"previs"}


async def resolve_video_refs(user, raw, model, motion):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["video_refs"]
    if not isinstance(entries, list) or len(entries) + bool(motion) > limit:
        raise http_errors.bad(f"此服务最多可采用 {limit} 段参考视频（包含白模）")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交参考视频"}, ensure_ascii=False),
                                content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "video"}
    clips = []
    for index, entry in enumerate(entries):
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise http_errors.bad("参考视频版本已移除或尚未保存，请重新选择")
        media_routes.require_media(user, {ref})
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
            if path.suffix.lower() not in tools.VIDEO_EXT:
                raise ValueError()
            w, h, seconds, _ = await asyncio.to_thread(film.probe, path)
            if not w or not h or not .4 <= w / h <= 2.5:
                raise ValueError()
        except (OSError, ValueError, IndexError):
            raise http_errors.bad("参考视频无法读取，或宽高比超出 0.4 到 2.5") from None
        extension = raw.get("extension") if index==0 else None
        edit = raw.get("segment_edit") and index==0
        default_start = max(0,seconds-4) if extension=="after" else 0
        try:
            start = image_editor.number(entry.get("start"), 0, seconds, "视频参考入点", default_start)
            default_end = seconds if extension=="after" or is_asset_media(raw,entry) else min(seconds,start+(4 if extension=="before" else max_seconds))
            end = min(seconds, image_editor.number(entry.get("end"), start, seconds + .025, "视频参考出点",
                                                   default_end))
        except ValueError as exc:
            raise http_errors.bad(str(exc)) from None
        if (extension=="before" and start > .025) or (extension=="after" and seconds-end > .025):
            raise http_errors.bad("续拍参考须包含原片接点，请保留片头或片尾")
        if extension=="before":
            start=0
        elif extension=="after":
            end=seconds
        if edit:
            start=round(start*film.FPS)/film.FPS
            end=min(seconds,round(end*film.FPS)/film.FPS)
        minimum = 4 if edit else 2
        ticks = round((end-start) * film.FPS)
        if not film.FPS * minimum <= ticks <= max_seconds * film.FPS:
            if is_asset_media(raw,entry):
                raise http_errors.bad(f"资产「{entry['name']}」的参考视频须为 {minimum} 到 {max_seconds} 秒")
            raise http_errors.bad(f"待编辑片段须为 {minimum} 到 {max_seconds} 秒" if edit else f"每段参考视频须为 2 到 {max_seconds} 秒")
        clips.append({"path":path, "start":start, "ticks":ticks, "ratio":w / h, "source_seconds":seconds})
    if sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0) > max_seconds * film.FPS:
        raise http_errors.bad(f"参考视频总时长不能超过 {max_seconds} 秒（包含白模）")
    for entry, clip in zip(entries, clips):
        entry.update(start=clip["start"], end=min(clip["source_seconds"],round(clip["start"]+clip["ticks"]/film.FPS, 5)))
    if raw.get("segment_edit"):
        entries[0]["source_seconds"] = clips[0]["source_seconds"]
    return clips


def resolve_video_reference_images(user, raw):
    images = raw.get("images") or []
    if not isinstance(images,list) or any(not isinstance(image,dict) or not isinstance(image.get("ref"),str)
                                          for image in images):
        raise http_errors.bad("请选择可读取的参考图")
    refs = [image["ref"] for image in images]
    media_routes.require_media(user,set(refs))
    try:
        paths = [tools.ref_path(config.COMFY_DIR,ref) for ref in refs]
    except ValueError:
        raise http_errors.bad("请选择可读取的参考图") from None
    if any(path.suffix.lower() not in creative_memory.IMAGE_EXT or not path.is_file() for path in paths):
        raise http_errors.bad("参考图无法读取，请重新选择")
    return paths


def ensure_reference_media_count(raw, provider_kind, model, object_plan):
    limit = motion_reference.image_limit(model)
    extra = (1 + bool(object_plan.get("replacement_ref"))) if object_plan else 0
    if len(raw.get("images") or []) + extra > limit:
        raise http_errors.bad(f"此服务最多支持 {limit} 张有效参考图")
    if provider_kind == "minimax":
        total = sum(len(raw.get(key) or []) for key in ("images","audio_refs","video_refs")) + bool(raw.get("previs_guide"))
        if total > 12:
            raise http_errors.bad("云端 H3 的图片、视频和音频参考合计最多 12 项")
