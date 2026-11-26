"""Select video reference routes and coordinate review and generation."""

import copy
import hashlib
import json

from aiohttp import web

from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import workflow_review
from oneshot.canvas.board_store import board_meta, can_edit
from oneshot.editing import image_editor
from oneshot.editing import render as film
from oneshot.generation import motion_reference
from oneshot.generation import requests as generation_requests
from oneshot.generation.reference_media import (
    ensure_reference_media_count,
    has_asset_media,
    is_asset_media as is_asset_media,
    resolve_audio_refs,
    resolve_previs_guide,
    resolve_video_reference_images,
    resolve_video_refs,
)
from oneshot.generation.reference_prompts import (
    apply_video_optics,
    has_remote_image_references,
    image_reference_limit,
    is_cloud_h3,
    numbered_reference_inputs,
    plain_prompt as plain_prompt,
    reference_prompt as reference_prompt,
    remote_video_prompt,
    resolve_camera_plan,
    resolve_object_edit,
    set_video_preview_image_role,
    video_reference_prompt,
    wants_image_references,
)
from oneshot.memory import creative_memory
from oneshot.providers import catalog as providers
from oneshot.providers import remote
from oneshot.providers import routes as provider_routes
from oneshot.providers.selection import configured_models
from oneshot.web import http as http_errors


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
