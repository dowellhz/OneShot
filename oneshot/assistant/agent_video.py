"""Dispatch assistant video operations through canvas generation tools."""
from __future__ import annotations

import copy
import math

from oneshot.assistant.video_canvas_results import (
    connect_inputs as connect_inputs,
    fail_node as fail_node,
    node_data as node_data,
    queued_node as queued_node,
    restore_video_snapshot as restore_video_snapshot,
    result_id as result_id,
)
from oneshot.assistant.video_draft_tools import finalize_draft, read_draft_status
from oneshot.assistant.video_media_tools import capture_video_frame, describe as describe
from oneshot.assistant.video_object_tools import read_object_settings, update_object_plan
from oneshot.assistant.video_previs_tools import (
    get_previs,
    previs_scene,
    render_previs,
    save_previs,
    scene_revision as scene_revision,
)
from oneshot.assistant.video_reference_inputs import (
    image_reference,
    reference_slot,
    reference_version,
    video_node,
)
from oneshot.assistant.video_reference_plan import (
    check_asset_video_limits,
    historical_video_model,
    local_extension_inputs,
    plan_payload,
    resolve_canvas_prompt,
    video_edit_snapshot,
)
from oneshot.assistant.video_remake_generation import (
    export_remake,
    finish_remake_export as finish_remake_export,
    finish_remake_generation as finish_remake_generation,
    generate_remake,
    preview_remake,
)
from oneshot.assistant.video_remake_tools import (
    analyze_remake,
    locate_remake,
    map_remake,
    plan_remake,
    remake_source,
    remake_status,
    review_remake,
    split_long_remake_shot,
)
from oneshot.assistant.video_timeline_tools import (
    edit_video_timeline,
    generate_broll,
    timeline_items as timeline_items,
)
from oneshot.assistant.video_tool_schemas import NAMES as NAMES, register as register
from oneshot.editing import camera_plan
from oneshot.editing import image_camera
from oneshot.editing import previs
from oneshot.editing import video_remake
from oneshot.editing.render import FPS
from oneshot.generation import motion_reference
from oneshot.memory import creative_memory


async def execute(s, run, user, cid, name, args):
    if name == "video_models":
        mode = args.get("mode","generation")
        if mode == "generation":
            choices = s.host.canvas_provider_choices("video")
        else:
            choices = s.host.canvas_reference_choices(require_motion=mode!="audio_reference",
                                                       segment_edit=mode=="segment_edit",extension=mode=="extension")
        return {"mode":mode,"providers":choices,"text":"已读取配置的视频模型。" if choices else "当前没有支持该模式的视频模型。"}
    if name == "video_broll_generate":
        return await generate_broll(s,run,user,cid,args)
    if name == "video_draft_status":
        return read_draft_status(s,run,user,args["node_id"])
    if name == "video_draft_finalize":
        return await finalize_draft(s,run,user,cid,args)
    if name in ("video_titles_get", "video_titles_edit", "video_cutaways_get", "video_cutaways_edit"):
        return await edit_video_timeline(s,run,user,cid,name,args)
    if name == "video_capture_frame":
        return await capture_video_frame(s, run, user, cid, args)
    if name == "video_export_gif":
        source, _ = reference_version(s, run, user, args, kind="clip")
        options = {key:args[key] for key in ("start","end","fps","size","ping_pong") if key in args}
        result = await s.response(s.host.video_gif, user, {"ref":source["ref"],**options})
        return {"gif":result,"text":f"已导出「{source['name']}」版本 {source['version']} 的循环 GIF。"}
    if name == "video_object_settings":
        return read_object_settings(s,run,user,args)
    if name == "video_previs_get":
        result = get_previs(video_node(s, run, user, args["node_id"])[1])
        return {**result, "previs_node":result["node_id"], "text":"已读取当前白模场景。"}
    if name == "video_previs_storyboard_plan":
        _, n = video_node(s,run,user,args["node_id"])
        scene = previs_scene(n)
        end = scene["duration"]*FPS
        boundaries = [0, *(k["t"] for k in scene["camera"] if k["ease"]=="cut" and 0<k["t"]<end), end]
        run["data"]["previs_storyboard_pending"] = True
        s.update(run)
        return {"previs_storyboard_plan":{"board":run["board_id"],"node":n["id"],"name":n["name"],
                                          "aspect":scene["aspect"],"fps":FPS,"boundaries":boundaries},
                "text":f"已准备 {len(boundaries)-1} 镜。打开白模核对后可创建分镜。"}
    if name == "video_previs_save":
        return save_previs(s, run, user, cid, args)
    if name == "video_previs_camera_motion":
        motion = {"mode":args["mode"],"start":round(args["start"]*FPS),"end":round(args["end"]*FPS),
                  "amount":args.get("amount"),"target":args.get("target")}
        result = save_previs(s,run,user,cid,args,motion=motion)
        return {**result,"text":"运镜关键帧已保存，可打开白模进行预览。"}
    if name == "video_previs_object_motion":
        route = {"target":args["target"],"start":round(args["start"]*FPS),"end":round(args["end"]*FPS),
                 "points":args["points"]}
        result = save_previs(s,run,user,cid,args,route=route)
        return {**result,"text":"走位关键帧已保存，可打开白模查看路线。"}
    if name == "video_previs_render":
        return await render_previs(s, run, user, cid, args["node_id"],args.get("span"))
    if run["data"].get("remake_plan_pending") and name in ("video_remake_split_long", "video_remake_map", "video_remake_locate",
            "video_remake_preview", "video_remake_generate", "video_remake_review", "video_remake_export"):
        raise ValueError("本轮有待确认的换角计划，请先使用计划卡选择镜头")
    if name == "video_remake_status":
        nid = args["node_id"]
        key = remake_source(s, run, user, nid)
        return remake_status(s.host, nid, key, video_remake.load(key), review_shot=args.get("shot"))
    if name == "video_remake_analyze":
        return await analyze_remake(s, run, user, args["node_id"], retry=args.get("retry", False))
    if name == "video_remake_split_long":
        return await split_long_remake_shot(s, run, user, args)
    if name == "video_remake_plan":
        return plan_remake(s, run, user, args, cid)
    if name == "video_remake_map":
        return await map_remake(s, run, user, args)
    if name == "video_remake_locate":
        return await locate_remake(s, run, user, args)
    if name == "video_remake_preview":
        return await preview_remake(s, run, user, cid, args)
    if name == "video_remake_generate":
        return await generate_remake(s, run, user, cid, args)
    if name == "video_remake_export":
        return await export_remake(s, run, user, cid, args)
    if name == "video_remake_review":
        return await review_remake(s, run, user, args)
    frames, data, original, guide_edge = args.get("frames", []), {}, None, None
    replay_ref = None
    sound_edges, clip_edges, extension, segment = [], [], None, False
    prompt = args.get("prompt", "")
    if name == "video_extend":
        first = {key:args[key] for key in ("node_id","version") if key in args}
        method = args.get("method","auto")
        source, _ = reference_version(s,run,user,first,kind="clip")
        if not prompt.strip():
            raise ValueError("请提供续拍的动作要求")
        if method == "frame" and args.get("selected_model"):
            raise ValueError("指定云端模型时请选择连续画面续拍")
        if method == "frame" or (method == "auto" and not args.get("provider") and not args.get("selected_model") and
                not s.host.reference_routes(require_motion=True,extension=True)):
            frames, provider = await local_extension_inputs(s,run,user,cid,args,source,frames)
            args = {**args,"provider":provider,"duration":s.host.engine_video_frames(args.get("duration",5))/24}
        else:
            extension = args["direction"]
            args = {**args,"video_refs":[{**first,"version":source["version"]}, *args.get("video_refs",[])]}
    if name=="video_edit_segment":
        segment=True
        first={key:args[key] for key in ("node_id","version","start","end") if key in args}
        args={**args,"video_refs":[first,*args.get("video_refs",[])]}
    if name == "video_regenerate":
        b, original = video_node(s, run, user, args["node_id"])
        if original.get("job"):
            raise ValueError("原视频仍有任务，请等待完成或取消后再重新生成")
        prior, recipe, data, incoming = video_edit_snapshot(s,run,b,original,args.get("version"))
        historical_model = historical_video_model(user,run["board_id"],prior,recipe) if prior else {}
        if historical_model:
            data.pop("selected_model",None)
            data.update(historical_model)
        if args.get("reuse_asset_references"):
            if "memory_views" in args:
                raise ValueError("请分别提交复用旧图和重新选择角色视角的请求")
            if not prior or not prior.get("ref"):
                raise ValueError("请选择已生成的视频版本复用资产参考图")
            replay_ref = prior["ref"]
        if data.get("previs"):
            raise ValueError("这是白模预演，请用白模渲染工具")
        guide_edge = next((e for e in incoming if e.get("relation") == "previs"), None)
        sound_edges = [e for e in incoming if e.get("relation") == "audio_ref"]
        clip_edges = sorted((e for e in incoming if e.get("relation") == "video_ref"),key=lambda e:not (e.get("extension") or e.get("segment_edit")))
        if clip_edges and "video_refs" not in args:
            extension=clip_edges[0].get("extension")
            segment=clip_edges[0].get("segment_edit") is True
        if segment and recipe and not data.get("camera_plan") and recipe.get("camera_plan"):
            data["camera_plan"] = copy.deepcopy(recipe["camera_plan"])
        if segment and recipe and not data.get("object_edit") and recipe.get("object_edit"):
            data["object_edit"] = copy.deepcopy(recipe["object_edit"])
        nodes = {n["id"]: n for n in b.get("nodes", [])}
        frames = [{"node_id":e["from"],"role":e.get("role","auto"),**{key:e[key] for key in ("time","ref","prompt_slot") if e.get(key) is not None}}
                  for e in incoming if nodes.get(e["from"], {}).get("type") == "image"]
        inputs = [(nodes[e["from"]].get("data", {}).get("text") or "").strip() for e in incoming if nodes.get(e["from"], {}).get("type") == "text"]
        prompt = prompt or "\n".join([t for t in inputs if t] + ([data.get("prompt", "")] if data.get("prompt") else []))
        if not frames and recipe:
            frames = [{"node_id": im["node_id"], "role": "subject" if im.get("role") == "subject" else "keyframe" if recipe.get("planned") else "auto",
                       **image_reference(im),
                       **({"time": im["time"]} if "time" in im else {})} for im in recipe.get("images", []) if im.get("node_id")]
            data.update({k: recipe[k] for k in ("duration", "quality", "turbo", "seed", "sound", "music") if k in recipe})
            if recipe.get("provider") and not historical_model:
                data["provider"] = recipe["provider"]
            prompt = args.get("prompt") or prompt or recipe.get("prompt", "")
            if recipe.get("ar") and not guide_edge and not args.get("previs"):
                data["aspect"] = str(recipe["ar"]) + ":1"
        replacements = args.get("replacements", [])
        if "frames" in args:
            if replacements:
                raise ValueError("请任选一种图片调整方式：用 frames 指定整组参考，或用 replacements 替换个别输入")
            slots={frame["node_id"]:frame["prompt_slot"] for frame in frames if frame.get("prompt_slot")}
            frames=[{**frame,**({"prompt_slot":slots[frame["node_id"]]} if frame["node_id"] in slots else {})}
                    for frame in args["frames"]]
        if len({r["from_node_id"] for r in replacements}) != len(replacements):
            raise ValueError("同一关键帧不能重复替换")
        mapping = {r["from_node_id"]: r["to_node_id"] for r in replacements}
        if set(mapping) - {f["node_id"] for f in frames}:
            raise ValueError("要替换的图片不是原视频的输入关键帧")
        for frame in frames:
            if frame["node_id"] in mapping:
                frame["node_id"] = mapping[frame["node_id"]]
                frame.pop("ref",None)
    guide = sample = None
    if args.get("previs") or guide_edge:
        guide, sample = reference_version(s, run, user, args.get("previs"), guide_edge if not args.get("previs") else None)
    sounds = []
    for entry in args.get("audio_refs",sound_edges):
        source, _ = reference_version(s,run,user,**({"selection":entry} if "audio_refs" in args else {"edge":entry}),kind="audio")
        sounds.append({**source,**{key:entry[key] for key in ("start","end") if key in entry}})
    if "audio_refs" in args:
        sound_slots = {edge["from"]:reference_slot(edge) for edge in sound_edges}
        for sound in sounds:
            sound.update(sound_slots.get(sound["node_id"],{}))
    if len({entry["node_id"] for entry in sounds}) != len(sounds):
        raise ValueError("同一音频节点只可选一个版本")
    clips = []
    clip_slots = {edge["from"]:reference_slot(edge) for edge in clip_edges}
    for entry in args.get("video_refs", clip_edges):
        clip, version = reference_version(s, run, user, **({"selection":entry} if "video_refs" in args else {"edge":entry}), kind="clip")
        if original and clip["node_id"]==original["id"]:
            raise ValueError("要参考同一节点的历史视频时，请先另建独立的视频节点")
        if not sample:
            sample = version
        clips.append({**clip, **clip_slots.get(clip["node_id"],{}), **{key:entry[key] for key in ("start","end") if key in entry}})
    if len({entry["node_id"] for entry in clips}) != len(clips) or (guide and any(clip["node_id"]==guide["node_id"] for clip in clips)):
        raise ValueError("同一视频节点只可选一个参考版本")
    default_length = (sample or {}).get("seconds") if guide else (clips[0]["end"] - clips[0].get("start",0) if clips and "end" in clips[0] else 5)
    duration = args.get("duration", data.get("duration", max(2,default_length or 5)))
    if segment:
        duration=clips[0].get("end",4)-clips[0].get("start",0)
        if not 4 <= duration <= 30+.01:
            raise ValueError("待编辑片段须为 4 到 30 秒")
        duration=min(duration,30)
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 2:
        raise ValueError("视频时长至少为 2 秒")
    if "provider" in args and args["provider"]!=data.get("provider"):
        data.pop("selected_model",None)
    data.update({k:args[k] for k in ("quality","seed","provider","selected_model") if k in args})
    selected_model = data.get("selected_model")
    if selected_model and not data.get("provider"):
        raise ValueError("请选择该模型所属的视频服务")
    guide_aspect = {}
    exceeds_plain_route = None
    if guide or sounds or clips:
        if guide and not (extension or segment) and duration > previs.MAX_SECONDS:
            raise ValueError("白模参考成片最长 14 秒")
        provider = data.get("provider")
        routes = s.host.reference_routes(require_motion=bool(guide or clips),segment_edit=segment,
                                         extension=bool(extension),all_models=True)
        chosen = next((r for r in routes if r["provider"]["id"]==provider and
                       (not selected_model or r["model"]==selected_model)),None)
        if not chosen and selected_model:
            raise ValueError("所选模型不支持当前参考素材或已不可用，请重新选择模型")
        candidates = [chosen] if chosen else (routes if "provider" not in args else [])
        if not candidates:
            if segment:
                raise ValueError("请选择已配置参考视频公网地址的 Seedance 2.5 服务")
            raise ValueError("请选择已配置公网地址的视频参考服务" if guide or clips else "请选择支持音频参考的视频服务")
        if not chosen:
            data.pop("provider",None)
        durations = [s.host.remote.video_durations(route["provider"]["kind"],route["model"],provider=route["provider"])
                     for route in candidates]
        maximum = 14 if guide and not (extension or segment) else max(values[-1] for values in durations)
        if duration > maximum:
            if "duration" in args or "duration" in data:
                raise ValueError(f"此模式成片最长 {maximum} 秒")
            duration = maximum
        if sample and data.get("aspect", "auto") == "auto" and sample.get("w") and sample.get("h"):
            guide_aspect["aspect"] = f"{sample['w']}:{sample['h']}"
        if chosen:
            duration = max(durations[0][0],round(duration))
    else:
        route = s.host.requested_generation_route(data,"video")
        maximum = (s.host.remote.video_durations(route["provider"]["kind"],route["model"],provider=route["provider"])[-1]
                   if route and route["provider"]["kind"] != "local_h3" else 15)
        image_limit = (motion_reference.image_reference_limit(route["provider"],route["model"]) if route else None) or 12
        if len(frames) > image_limit or duration > maximum:
            exceeds_plain_route = (image_limit,maximum)
    special = bool(extension or segment)
    payload = plan_payload(s, run, user, frames, duration, {**data, **guide_aspect}, prompt,
                           sounds=sounds,clips=clips,guide=bool(guide),special=special)
    excluded = data.get("ignored_memory_ids")
    ignored = excluded if isinstance(excluded,list) else []
    if "memory_views" in args:
        payload["memory_views"] = args["memory_views"]
    elif original and recipe.get("memory_views") and not replay_ref:
        overrides = creative_memory.view_tokens(args.get("prompt",""))
        payload["memory_views"] = [item for item in recipe["memory_views"] if isinstance(item,dict)
                                   and isinstance(item.get("memory_id"),str) and item["memory_id"] not in ignored
                                   and item["memory_id"] not in overrides
                                   and ("memory_ids" not in args or item.get("memory_id") in args["memory_ids"])]
    if original:
        saved_assets = (prior or {}).get("memory_used")
        inherited = [asset["id"] for asset in saved_assets if isinstance(asset,dict) and isinstance(asset.get("id"),str)
                     and asset["id"] not in ignored] if isinstance(saved_assets,list) else []
        if "memory_ids" in args:
            data["ignored_memory_ids"] = []
        if args.get("memory_ids", inherited):
            payload["memory_ids"] = args.get("memory_ids", inherited)
    if "video_optics" in args:
        if optics := image_camera.validate_optics(args["video_optics"]):
            data["video_optics"] = optics
        else:
            data.pop("video_optics",None)
    if data.get("video_optics"):
        payload["video_optics"] = image_camera.validate_optics(data["video_optics"])
    if args.get("draft",data.get("draft")):
        payload["draft"] = True
        data["draft"] = True
    if guide:
        payload.update(previs_guide=guide, planned=True, mode="previs")
    if sounds:
        payload.update(audio_refs=sounds, planned=True, mode="previs" if guide else "reference")
    if clips:
        payload.update(video_refs=clips, planned=True, mode="previs" if guide else "reference")
    if extension:
        payload.update(extension=extension,mode="extension")
    if segment:
        payload.update(segment_edit=True,mode="segment_edit")
    if "camera_plan" in args and "object_edit" in args:
        raise ValueError("请分别提交镜头重拍和物体编辑")
    if not segment and ("camera_plan" in args or "object_edit" in args):
        raise ValueError("镜头重拍和物体编辑需要指定原视频片段")
    if segment and "object_edit" in args:
        data["object_edit"] = update_object_plan(s,run,user,data.get("object_edit"),args["object_edit"])
        payload.update(object_edit=data["object_edit"],mode="object_edit")
    elif segment and (retake := args.get("camera_plan") or data.get("camera_plan")):
        data["camera_plan"] = camera_plan.validate(retake)
        payload.update(camera_plan=data["camera_plan"], mode="camera_retake")
    elif segment and data.get("object_edit"):
        payload.update(object_edit=data["object_edit"],mode="object_edit")
    if data.get("pmode") == "fields" and data.get("fields") and not args.get("prompt"):
        payload["fields"] = {key:resolve_canvas_prompt(value,payload["images"],sounds,clips,guide=guide,special=special) if isinstance(value,str) else value
                             for key,value in data["fields"].items()}
    if not prompt.strip() and not any(payload.get(key) for key in ("fields","camera_plan","object_edit")):
        raise ValueError("原视频没有可用提示词，请提供视频动作要求")
    if data.get("provider"):
        payload["provider"] = data["provider"]
    if selected_model:
        payload["selected_model"] = selected_model
    if exceeds_plain_route:
        image_limit,maximum = exceeds_plain_route
        check_asset_video_limits(s,run,user,payload,replay_ref,image_limit,maximum)
    target_data = None
    if original:
        target_data = {**data, "duration": duration}
        for prop in ("camera_plan","object_edit","draft"):
            if not payload.get(prop):
                target_data.pop(prop, None)
        if args.get("prompt"):
            target_data.update(prompt=args["prompt"], pmode="free")
    label = original.get("name", "视频") + " · 重生成" if original else "助手视频"
    if name == "video_extend":
        label = (source.get("name") or "视频") + (" · 补拍片头" if args["direction"] == "before" else " · 续拍片尾")
    target_id = original["id"] if original else s.empty_generation_target(run,user,"video") if name=="video_generate" else None
    return await s.submit_generation(run, user, cid, payload, args.get("name") or label[:80],
                                     s.host.generate_request, target_id=target_id, target_data=target_data,
                                     **({"replay_ref":replay_ref} if replay_ref else {}))
