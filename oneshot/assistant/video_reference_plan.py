"""Resolve pinned generation inputs and historical video settings."""
from __future__ import annotations

import copy
import math
import re

from oneshot.assistant.video_canvas_results import connect_inputs, node_data
from oneshot.assistant.video_media_tools import capture_video_frame
from oneshot.assistant.video_reference_inputs import reference_slot
from oneshot.memory import creative_memory
from oneshot.storage import db


def video_edit_snapshot(s, run, board, node, version=None):
    active = s.current(node)
    versions = node.get("versions", [])
    bound = run["data"].get("bindings", {}).get(node["id"])
    if version is not None:
        if not 1 <= version <= len(versions):
            raise ValueError("指定的视频版本已移除")
        current = versions[version - 1]
    elif bound:
        current = next((v for v in versions if v.get("ref") == bound), None)
        if current is None:
            raise ValueError("本轮引用的视频版本已移除，请重新选择")
    else:
        current = active
    recipe = copy.deepcopy((current or {}).get("video_recipe") or {})
    data = copy.deepcopy(node.get("data") or {})
    incoming = [edge for edge in board.get("edges", []) if edge.get("to") == node["id"]]
    if current is not active or (version is not None and recipe):
        if isinstance(current.get("input_edges"), list):
            incoming = copy.deepcopy(current["input_edges"])
        else:
            detached = {"nodes":board["nodes"],"edges":[]}
            connect_inputs(s,detached,node["id"],recipe)
            incoming = detached["edges"]
        ranges = {(relation,item.get("node_id"),item.get("ref")):item
                  for relation,key in (("audio_ref","audio_refs"),("video_ref","video_refs"))
                  for item in recipe.get(key) or []}
        images = {item.get("node_id"):item.get("ref") for item in recipe.get("images") or []}
        for edge in incoming:
            relation, source = edge.get("relation"),edge["from"]
            if recorded := ranges.get((relation,source,edge.get("ref"))):
                edge.update({key:recorded[key] for key in ("start","end") if recorded.get(key) is not None})
            if not relation and not edge.get("ref") and images.get(source):
                edge["ref"] = images[source]
        data = copy.deepcopy(current["node_data"]) if isinstance(current.get("node_data"), dict) else node_data(recipe)
    return current, recipe, data, incoming


def historical_video_model(user, board_id, version, recipe):
    if recipe.get("provider") and (recipe.get("selected_model") or recipe["provider"]=="local_h3"):
        return {"provider":"local_h3"} if recipe["provider"]=="local_h3" else {
            key:recipe[key] for key in ("provider","selected_model")}
    recorded = (version.get("generation_record") or {}).get("settings",{})
    provider, model = recorded.get("provider"),recorded.get("provider_model")
    if not provider or not model:
        task = db.one("""SELECT provider_id,model FROM tasks,
                        json_each(CASE WHEN json_valid(tasks.outputs) THEN tasks.outputs END)
                        WHERE user_id=? AND board_id=? AND capability='video' AND state='done'
                        AND provider_id IS NOT NULL AND json_each.value=? ORDER BY created DESC LIMIT 1""",
                      user["id"],board_id,version.get("ref"))
        if task:
            provider,model = task["provider_id"],task["model"]
    if provider=="local_h3":
        return {"provider":provider}
    return {"provider":provider,"selected_model":model} if provider and model else {}


async def local_extension_inputs(s, run, user, cid, args, source, frames):
    if args.get("audio_refs") or args.get("video_refs") or args.get("draft"):
        raise ValueError("本地接点续拍支持图片参考。请移除音视频参考与样片模式，或选择连续画面服务。")
    direction = args["direction"]
    role = "last" if direction == "before" else "first"
    if any(frame.get("role") == role for frame in frames):
        raise ValueError("该接点会自动采用原片画面，请移除重复的首帧或尾帧")
    duration = args.get("duration", 5)
    if not 2 <= duration <= 15 or len(frames) >= 12:
        raise ValueError("本地接点续拍支持 2–15 秒，最多 11 张附加参考图")
    provider = next((p for p in s.host.providers.all_providers() if p["kind"] == "local_h3" and p["enabled"]
                     and (not args.get("provider") or args["provider"] == p["id"])), None)
    if not provider:
        raise ValueError("本地接点续拍需要启用本地 H3 视频服务")
    s.check_generation_budget(run,"video",1)
    s.validate_external_task(run)
    for frame in frames:
        s.source(run,user,frame["node_id"])
    capture = await capture_video_frame(s, run, user, cid+"_anchor", {
        "node_id":source["node_id"], "version":source["version"], "position":"first" if direction=="before" else "last"})
    image = capture["nodes"][0]
    anchor = {"node_id":image["id"], "role":role, "ref":image["ref"]}
    return [*frames, anchor], provider["id"]


def resolve_canvas_prompt(prompt, images, sounds=(), clips=(), *, guide=False, special=False):
    slots = {}
    for tag, inputs in (("图",images),("音",sounds),("视频",clips)):
        for i, entry in enumerate(inputs):
            if slot := reference_slot(entry).get("prompt_slot"):
                slots[tag,slot] = i+1+int(tag=="视频" and bool(guide) and (not special or i>0))
    def resolve(match):
        tag, slot = match.groups()
        index = slots.get((tag,int(slot)))
        if not index:
            raise ValueError("提示词中的素材引用已断开，请在画布重新选择")
        return f"@{tag}{index}"
    return re.sub(r"@(图|视频|音)\{(\d{1,16})\}",resolve,prompt)


def plan_payload(s, run, user, frames, duration, data, prompt, *, sounds=(), clips=(), guide=False, special=False):
    frames=[{**f,"_slot":i} for i,f in enumerate(frames)]
    media_reference = bool(guide or sounds or clips)
    if media_reference or data.get("mode") == "reference":
        frames = [{**f,"role":"subject"} if f.get("role","auto") == "auto" else f for f in frames]
    images = []
    end = (s.host.frames_for(duration) - 4) / 24
    ordered = [f for f in frames if f.get("role") != "subject"]
    ordered = [f for f in ordered if f.get("role") == "first"] + [f for f in ordered if f.get("role") not in ("first", "last")] + [f for f in ordered if f.get("role") == "last"]
    planned = media_reference or any(f.get("role") in ("subject", "keyframe") for f in frames) or len(ordered) > 2 or data.get("mode") in ("keyframes", "reference") or (len(ordered) == 1 and ordered[0].get("role") == "last")
    for i, f in enumerate(frames):
        src, version = s.source(run, user, f["node_id"],pinned_ref=f.get("ref"))
        pinned = bool(f.get("ref")) or src["id"] in run["data"].get("pinned_versions", ())
        version_number = next((number for number, item in enumerate(src.get("versions",[]),1)
                               if item.get("ref") == version["ref"]),None)
        role = f.get("role", "auto")
        t = 0
        if role != "subject" and f in ordered:
            j = ordered.index(f)
            t = 0 if role == "first" else end if role == "last" else f.get("time", end * j / max(1, len(ordered) - 1))
            t = max(0, min(end, t))
        images.append({"node_id": src["id"], "ref": version["ref"], "name": src.get("name"), "caption": src.get("data", {}).get("caption", ""),
                       "index": i + 1, "role": "subject" if role == "subject" else "frame", "time": t, "w": version.get("w"), "h": version.get("h"),
                       **({"version":version_number} if version_number is not None else {}),
                       **reference_slot(f), **({"pinned":True} if pinned else {})})
    if not planned:
        indices = [frames.index(f) for f in ordered]
        images = [images[i] for i in indices]
    aspect = data.get("aspect", "auto")
    leading = next((im for im in images if im["role"] == "frame"), images[0] if images else {})
    if aspect == "auto":
        ar = (leading.get("w") or 16) / (leading.get("h") or 9)
    else:
        try:
            w, h = map(float, aspect.split(":")); ar = w / h
            if not math.isfinite(ar) or not .25 <= ar <= 4:
                raise ValueError()
        except (ValueError, ZeroDivisionError, AttributeError):
            raise ValueError("视频画幅格式不正确") from None
    payload = {"kind": "video", "prompt": resolve_canvas_prompt(prompt,images,sounds,clips,guide=guide,special=special), "images": images, "duration": duration, "ar": ar,
               **({"quality": data["quality"]} if "quality" in data else {}),
               "turbo": bool(data.get("turbo", True)), "seed": data.get("seed", -1),
               "count": 1, "sound": data.get("sound", ""), "music": data.get("music", ""), "mode": "fl2v"}
    if planned:
        payload["planned"] = True
    return payload


def check_asset_video_limits(s, run, user, payload, replay_ref, image_limit, maximum):
    """A mixed asset can use a different route than a plain video with the same prompt."""
    mentions = [payload.get("prompt"),*(payload.get("fields") or {}).values()]
    ids = list(dict.fromkeys([*payload.get("memory_ids",[]),*run["data"].get("memory_ids",[])]))
    views = creative_memory.requested_views(payload.get("memory_views",[]))
    views.update(creative_memory.requested_views(run["data"].get("memory_views",[])))
    if replay_ref or ids or views or any(isinstance(part,str) and "@" in part for part in mentions):
        raw = {**payload,"board":run["board_id"],"memory_ids":ids,"memory_views":creative_memory.view_selections(views)}
        prepared = s.app["creative_memory"].prepare(user,raw,replay_ref=replay_ref,
            owner_only=bool(run["data"].get("external_tool")))
        if s.host.has_asset_media(prepared):
            # The reference preflight and submission check the selected route against the complete media set.
            return
    raise ValueError(f"此模式最多接受 {image_limit} 张画布图片，成片最长 {maximum} 秒")
