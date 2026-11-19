"""Typed video tools using the same routing, reference planning and queue as canvas generation."""
from __future__ import annotations

import asyncio
import copy
import json
import math
import uuid
import time

from aiohttp import web

import video_remake

NAMES = {"video_generate", "video_regenerate", "video_remake_status", "video_remake_analyze",
         "video_remake_map", "video_remake_locate", "video_remake_preview", "video_remake_generate",
         "video_remake_review", "video_remake_export"}


def result_id(cid):
    return "a" + uuid.uuid5(uuid.NAMESPACE_URL, cid + "0").hex[:20]


def node_data(recipe):
    return {"prompt": recipe.get("prompt", ""), "duration": recipe.get("duration", 5), "aspect": "auto", "quality": recipe.get("quality", "hd"),
            "mode": "keyframes" if recipe.get("planned") else "auto", "turbo": recipe.get("turbo", True), "seed": recipe.get("seed", -1),
            "sound": recipe.get("sound", ""), "music": recipe.get("music", ""), "pmode": "fields" if recipe.get("fields") else "free",
            "fields": copy.deepcopy(recipe.get("fields", {})), "count": 1, "provider": recipe.get("provider", "")}


def connect_inputs(board, nid, recipe):
    images = recipe.get("images", [])
    end = max((im.get("time", 0) for im in images if im.get("role") != "subject"), default=0)
    for i, image in enumerate(images):
        source_id = image.get("node_id")
        if not source_id or not any(n["id"] == source_id and n.get("type") == "image" for n in board["nodes"]):
            continue
        if image.get("role") == "subject":
            role = "subject"
        elif recipe.get("planned"):
            role = "first" if image.get("time", 0) <= .01 else "last" if end and image.get("time", 0) >= end else "keyframe"
        else:
            role = "first" if i == 0 else "last"
        edge = {"from": source_id, "to": nid, "role": role}
        if recipe.get("planned") and role != "subject":
            edge["time"] = image.get("time", 0)
        if edge not in board.setdefault("edges", []):
            board["edges"].append(edge)


def remember_version(s, board, n):
    """Legacy versions acquire a snapshot before their live inputs are changed."""
    version = s.current(n)
    if version is not None:
        version.setdefault("input_edges", copy.deepcopy([e for e in board.get("edges", []) if e.get("to") == n["id"]]))
        version.setdefault("node_data", copy.deepcopy(n.get("data", {})))


def queued_node(s, run, user, cid, pending):
    nid = pending.get("target_id") or result_id(cid)
    def change(b):
        n = next((n for n in b["nodes"] if n["id"] == nid), None)
        if pending.get("target_id"):
            if not n:
                return {"node_id": nid, "deleted": True}
            if n.get("job") and n["job"].get("agent_call") != cid:
                raise ValueError("原节点已有其他任务，未覆盖其进度")
            if pending.get("kind") == "video":
                remember_version(s, b, n)
                image_ids = {im["id"] for im in b["nodes"] if im.get("type") == "image"}
                b["edges"] = [e for e in b.get("edges", []) if not (e.get("to") == nid and e.get("from") in image_ids)]
                n["data"].update(copy.deepcopy(pending.get("target_data") or node_data(pending["recipe"])))
                connect_inputs(b, nid, pending["recipe"])
        elif n:
            return {"node_id": nid}
        else:
            x = max((n.get("x", 0) + s.dimensions(n)[0] for n in b["nodes"]), default=20) + 100
            y = min((n.get("y", 100) for n in b["nodes"]), default=100)
            n = {"id": nid, "type": "video", "name": pending["name"][:40], "x": x, "y": y,
                 "data": node_data(pending["recipe"]), "versions": [], "cur": -1, "agent_call": cid}
            b["nodes"].append(n)
            connect_inputs(b, nid, pending["recipe"])
        n["job"] = {"ids": pending["ids"], "prompt": pending["prompt"], "t0": round(time.time() * 1000), "agent_call": cid}
        n.pop("agent_error", None)
        history = {"input_edges": copy.deepcopy([e for e in b.get("edges", []) if e.get("to") == nid]),
                   "node_data": copy.deepcopy(n["data"])} if pending.get("kind") == "video" else {}
        return {"node_id": nid, "history": history}
    return s.commit(run, user, "queued_" + cid, change)


def fail_node(s, run, user, cid, message, target_id=None):
    nid = target_id or result_id(cid)
    def change(b):
        n = next((n for n in b["nodes"] if n["id"] == nid and (n.get("job") or {}).get("agent_call") == cid), None)
        if n:
            queued = next((op for op in b.get("agent_ops", []) if op["id"] == "queued_" + cid), None)
            history = (queued or {}).get("result", {}).get("history", {})
            previous = s.current(n)
            if target_id and previous and history:
                incoming = [e for e in b.get("edges", []) if e.get("to") == nid]
                if incoming == history.get("input_edges") and "input_edges" in previous:
                    existing = {node["id"] for node in b["nodes"]}
                    restored = [e for e in previous["input_edges"] if e.get("from") in existing]
                    b["edges"] = [e for e in b.get("edges", []) if e.get("to") != nid] + copy.deepcopy(restored)
                if n.get("data") == history.get("node_data") and "node_data" in previous:
                    n["data"] = copy.deepcopy(previous["node_data"])
            n["job"] = None
            n["agent_error"] = str(message)[:400]
        return {"node_id": nid}
    return s.commit(run, user, "failed_" + cid, change)


def register(tool, prop, node, prompt):
    frame = prop("object", properties={"node_id": node, "role": prop("string", enum=["first", "last", "keyframe", "subject"]),
                                      "time": prop("number", minimum=0, maximum=15)}, required=["node_id"], additionalProperties=False)
    options = {"prompt": prompt, "duration": prop("number", minimum=2, maximum=15), "quality": prop("string", enum=["hd", "std"]),
               "seed": prop("integer", minimum=-1, maximum=2**48), "provider": prop("string", maxLength=100), "name": node}
    tool("video_generate", "生成真正的视频（MP4），使用平台视频服务与队列。参考帧指定图片节点，支持首尾帧、多关键帧及人物设定；不能用image_generate代替。", {
        **options, "frames": prop("array", items=frame, maxItems=12)}, ["prompt"])
    tool("video_regenerate", "重新生成已有视频，复用提示词、时长、关键帧连线和配置。可用replacements替换关键帧。结果在原视频节点追加版本，用Tab切换，历史视频与输入连线保留。", {
        **options, "node_id": node, "replacements": prop("array", maxItems=12, items=prop("object", properties={
            "from_node_id": node, "to_node_id": node}, required=["from_node_id", "to_node_id"], additionalProperties=False))}, ["node_id"])
    shot_number = prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS)
    tool("video_remake_status", "读取原片视频版本的角色替换进度。指定shot可查看该镜头的已完成视频版本和任务编号。", {
        "node_id": node, "shot": shot_number,
    }, ["node_id"])
    tool("video_remake_analyze", "在视频重制工作区分析指定原片，按原片时间轴拆分镜头并识别人物。已有分析时直接读取，可继续审核。", {"node_id": node}, ["node_id"])
    tool("video_remake_map", "保存角色映射，用资产库角色替换指定原片人物。镜头编号从1开始，使用最近一次重制状态的cut_revision。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "shots": prop("array", items=prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
                      minItems=1, maxItems=video_remake.MAX_SHOTS),
        "cut_revision": prop("integer", minimum=0), "look": prop("string", maxLength=240),
    }, ["node_id", "person", "asset_id", "shots", "cut_revision"])
    tool("video_remake_locate", "为已映射镜头的首帧批量标记候选人物位置，留给用户确认。镜头从1编号，省略shots则使用当前映射的全部镜头。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "shots": prop("array", items=prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
                      minItems=1, maxItems=video_remake.MAX_SHOTS),
        "cut_revision": prop("integer", minimum=0),
    }, ["node_id", "person", "asset_id", "cut_revision"])
    tool("video_remake_preview", "为有选区的镜头提交起始帧换角预览，最多4个。镜头从1编号；预览保存在重制工作区。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "cut_revision": prop("integer", minimum=0),
        "shots": prop("array", minItems=1, maxItems=4, items=prop("object", properties={
            "number": prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS),
            "view": prop("string", enum=sorted(video_remake.VIEWS)), "note": prop("string", maxLength=800),
        }, required=["number"], additionalProperties=False)),
    }, ["node_id", "person", "asset_id", "cut_revision", "shots"])
    tool("video_remake_generate", "用已采用的起始帧和动作关键帧提交一个重制镜头视频。first_job取自重制状态的approved_start_job。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "cut_revision": prop("integer", minimum=0),
        "shot": prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS), "first_job": node,
        "motion": prop("string", maxLength=1600),
    }, ["node_id", "person", "asset_id", "cut_revision", "shot", "first_job"])
    tool("video_remake_export", "把已审核的重制镜头与保留原片的镜头合成，保留原声。须使用最新cut_revision；只有用户明确要求重新导出时才设rebuild。", {
        "node_id": node, "cut_revision": prop("integer", minimum=0), "rebuild": prop("boolean"),
    }, ["node_id", "cut_revision"])
    tool("video_remake_review", "保存用户明确指定的审核决定。adopt时使用该镜头已完成版本的video_job，keep时保留原镜头。镜头从1编号。", {
        "node_id": node, "shot": shot_number, "cut_revision": prop("integer", minimum=0),
        "decision": prop("string", enum=["adopt", "keep"]), "video_job": node,
    }, ["node_id", "shot", "cut_revision", "decision"])


def video_node(s, run, user, nid, *, allow_film=False):
    b = s.board(user, run["board_id"])
    n = next((n for n in b.get("nodes", []) if n["id"] == nid), None)
    if not n or n.get("type") != "video":
        raise ValueError("视频节点已不存在，请重新读取画布")
    if not allow_film and n.get("data", {}).get("film"):
        raise ValueError("这是剪辑成片，请使用原始镜头视频重新生成")
    return b, n


def plan_payload(s, run, user, frames, duration, data, prompt):
    frames=[{**f,"_slot":i} for i,f in enumerate(frames)]
    images, kinds = [], []
    end = (s.host.frames_for(duration) - 4) / 24
    ordered = [f for f in frames if f.get("role") != "subject"]
    ordered = [f for f in ordered if f.get("role") == "first"] + [f for f in ordered if f.get("role") not in ("first", "last")] + [f for f in ordered if f.get("role") == "last"]
    planned = any(f.get("role") in ("subject", "keyframe") for f in frames) or len(ordered) > 2 or data.get("mode") in ("keyframes", "reference") or (len(ordered) == 1 and ordered[0].get("role") == "last")
    if data.get("mode") == "reference":
        frames = [{**f, "role": "subject"} if f.get("role", "auto") == "auto" else f for f in frames]
        ordered = [f for f in ordered if f.get("role", "auto") != "auto"]
    for i, f in enumerate(frames):
        src, version = s.source(run, user, f["node_id"])
        role = f.get("role", "auto")
        t = 0
        if role != "subject" and f in ordered:
            j = ordered.index(f)
            t = 0 if role == "first" else end if role == "last" else f.get("time", end * j / max(1, len(ordered) - 1))
            t = max(0, min(end, t))
        images.append({"node_id": src["id"], "ref": version["ref"], "name": src.get("name"), "caption": src.get("data", {}).get("caption", ""),
                       "index": i + 1, "role": "subject" if role == "subject" else "frame", "time": t, "w": version.get("w"), "h": version.get("h")})
        kinds.append(role)
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
    payload = {"kind": "video", "prompt": prompt, "images": images, "duration": duration, "ar": ar,
               "quality": data.get("quality", "hd"), "turbo": bool(data.get("turbo", True)), "seed": data.get("seed", -1),
               "count": 1, "sound": data.get("sound", ""), "music": data.get("music", ""), "mode": "fl2v"}
    if planned:
        payload["planned"] = True
    return payload


async def execute(s, run, user, cid, name, args):
    if name == "video_remake_status":
        nid = args["node_id"]
        key = remake_source(s, run, user, nid)
        return remake_status(s.host, nid, key, video_remake.load(key), review_shot=args.get("shot"))
    if name == "video_remake_analyze":
        return await analyze_remake(s, run, user, args["node_id"])
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
    frames, data, original = args.get("frames", []), {}, None
    prompt = args.get("prompt", "")
    if name == "video_regenerate":
        b, original = video_node(s, run, user, args["node_id"])
        data = copy.deepcopy(original.get("data") or {})
        if original.get("job"):
            raise ValueError("原视频仍有任务，请等待完成或取消后再重新生成")
        incoming = [e for e in b.get("edges", []) if e.get("to") == original["id"]]
        nodes = {n["id"]: n for n in b.get("nodes", [])}
        frames = [{"node_id": e["from"], "role": e.get("role", "auto"), **({"time": e["time"]} if e.get("time") is not None else {})}
                  for e in incoming if nodes.get(e["from"], {}).get("type") == "image"]
        inputs = [(nodes[e["from"]].get("data", {}).get("text") or "").strip() for e in incoming if nodes.get(e["from"], {}).get("type") == "text"]
        prompt = prompt or "\n".join([t for t in inputs if t] + ([data.get("prompt", "")] if data.get("prompt") else []))
        current = next((v for v in original.get("versions", []) if v.get("ref") == run["data"].get("bindings", {}).get(original["id"])), None) or s.current(original)
        recipe = copy.deepcopy((current or {}).get("video_recipe"))
        if not frames and recipe:
            frames = [{"node_id": im["node_id"], "role": "subject" if im.get("role") == "subject" else "keyframe" if recipe.get("planned") else "auto",
                       **({"time": im["time"]} if "time" in im else {})} for im in recipe.get("images", []) if im.get("node_id")]
            data.update({k: recipe[k] for k in ("duration", "quality", "turbo", "seed", "sound", "music", "provider") if k in recipe})
            prompt = args.get("prompt") or prompt or recipe.get("prompt", "")
            if recipe.get("ar"):
                data["aspect"] = str(recipe["ar"]) + ":1"
        replacements = args.get("replacements", [])
        if len({r["from_node_id"] for r in replacements}) != len(replacements):
            raise ValueError("同一关键帧不能重复替换")
        mapping = {r["from_node_id"]: r["to_node_id"] for r in replacements}
        if set(mapping) - {f["node_id"] for f in frames}:
            raise ValueError("要替换的图片不是原视频的输入关键帧")
        frames = [{**f, "node_id": mapping.get(f["node_id"], f["node_id"])} for f in frames]
    duration = args.get("duration", data.get("duration", 5))
    if type(duration) not in (int, float) or not math.isfinite(duration) or not 2 <= duration <= 15:
        raise ValueError("视频时长须在2至15秒之间")
    data.update({k: args[k] for k in ("quality", "seed", "provider") if k in args})
    payload = plan_payload(s, run, user, frames, duration, data, prompt)
    if data.get("pmode") == "fields" and data.get("fields") and not args.get("prompt"):
        payload["fields"] = data["fields"]
    if not prompt.strip() and not payload.get("fields"):
        raise ValueError("原视频没有可用提示词，请提供视频动作要求")
    if data.get("provider"):
        payload["provider"] = data["provider"]
    target_data = None
    if original:
        target_data = {**data, "duration": duration}
        if args.get("prompt"):
            target_data.update(prompt=args["prompt"], pmode="free")
    return await s.submit_generation(run, user, cid, payload, args.get("name") or (original.get("name", "视频") + " · 重生成" if original else "助手视频"),
                                     s.host.generate_request, target_id=original["id"] if original else None, target_data=target_data)


def remake_source(s, run, user, nid):
    _, n = video_node(s, run, user, nid, allow_film=True)
    ref = run["data"].get("bindings", {}).get(nid) or (s.current(n) or {}).get("ref")
    try:
        return video_remake.remake_key(s.host, user, run["board_id"], nid, ref)
    except web.HTTPException:
        raise ValueError("原片版本已不存在，请重新选择视频") from None


async def apply_remake_action(s, user, nid, key, payload):
    async def invoke(req):
        req.method = "POST"
        req.match_info = {"board": key[1], "node": nid}
        return await s.host.remake(req)

    return await s.response(invoke, user, payload, query={"source": key[3]})


async def analyze_remake(s, run, user, nid):
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        session = await apply_remake_action(s, user, nid, key, {"action": "analyze"})
    return remake_status(s.host, nid, key, session)


async def map_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = await apply_remake_action(s, user, nid, key, {
        "action": "map_person", "person": args["person"], "asset": args["asset_id"],
        "shots": [number - 1 for number in args["shots"]], "cut_revision": args["cut_revision"],
        "look": args.get("look", ""),
    })
    result = remake_status(s.host, nid, key, session)
    mapping = session["mapping"]
    result["text"] = f"已保存人物映射：{mapping['source']} → {mapping['asset_name']}，共 {len(mapping['shots'])} 个镜头。"
    return result


async def locate_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    mapping = (session or {}).get("mapping")
    if not mapping or mapping["source"] != args["person"] or mapping["asset"] != args["asset_id"]:
        raise ValueError("请先读取或保存当前视频版本的人物映射")
    indices = [number - 1 for number in args["shots"]] if "shots" in args else mapping["shots"]
    session = await apply_remake_action(s, user, nid, key, {
        "action": "batch_locate_people", "person": args["person"], "asset": args["asset_id"],
        "shots": indices, "cut_revision": args["cut_revision"], "look": mapping.get("look", ""),
    })
    result = remake_status(s.host, nid, key, session)
    outcome = session["batch_locate_people"]
    located = [index + 1 for index in outcome["located"]]
    result["location"] = {
        "located": located, "skipped": [index + 1 for index in outcome["skipped"]],
        "failed": [{"shot": item["shot"] + 1, "error": item["error"]} for item in outcome["failed"]],
    }
    suggested = next((shot for shot in result["shots"] if shot["number"] - 1 in indices and shot["position_suggested"]), None)
    if suggested:
        result["remake"].update(shot_number=suggested["number"], shot_start=suggested["start"])
    result["text"] = (f"{len(located)} 个镜头已标出候选位置，请在工作区核对。" if located else
                      "本次未新增候选位置，可在工作区查看已有标记或手动选择。")
    return result


def mapped_remake(s, run, user, args):
    key = remake_source(s, run, user, args["node_id"])
    session = video_remake.load(key)
    mapping = (session or {}).get("mapping")
    if not mapping or mapping["source"] != args["person"] or mapping["asset"] != args["asset_id"]:
        raise ValueError("请先读取或保存当前视频版本的人物映射")
    if session.get("cut_revision", 0) != args["cut_revision"]:
        raise ValueError("剪辑点已更新，请重新读取视频重制状态")
    return key, session, mapping


async def preview_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key, session, mapping = mapped_remake(s, run, user, args)
    indices = [item["number"] - 1 for item in args["shots"]]
    if len(set(indices)) != len(indices) or any(index not in mapping["shots"] for index in indices):
        raise ValueError("请选择人物映射内的镜头，且每个镜头只提交一次")

    requests, needs_selection, kept = [], [], []
    for index, item in zip(indices, args["shots"]):
        shot = session["shots"][index]
        frame_key = video_remake.start_preview_key(shot, mapping)
        if shot.get("keep_original"):
            kept.append(index)
        elif not frame_key or not video_remake.person_selection(shot["frames"][frame_key], mapping):
            needs_selection.append(index)
        else:
            requests.append({"shot": index, "frame": frame_key, "view": item.get("view", "main"),
                             "note": item.get("note", "")})

    outcome = {"submitted": [], "skipped": [], "failed": []}
    if requests:
        s.begin_generation(run, cid, "image", len(requests))
        session = await apply_remake_action(s, user, nid, key, {
            "action": "batch_previews", "person": args["person"], "asset": args["asset_id"],
            "shots": requests, "cut_revision": args["cut_revision"],
        })
        outcome = session["batch_previews"]
        if outcome["skipped"]:
            run["data"]["generated"] -= len(outcome["skipped"])
            s.update(run)

    result = remake_status(s.host, nid, key, session)
    submitted = outcome["submitted"]
    result["preview"] = {
        "submitted": [index + 1 for index in submitted],
        "skipped": [index + 1 for index in sorted(kept + outcome["skipped"])],
        "needs_selection": [index + 1 for index in needs_selection],
        "failed": [{"shot": item["shot"] + 1, "error": item["error"]} for item in outcome["failed"]],
    }
    targets = submitted or needs_selection or outcome["skipped"]
    if targets:
        index = targets[0]
        result["remake"].update(shot_number=index + 1, shot_start=session["shots"][index]["start"])
        frame = video_remake.start_preview_key(session["shots"][index], mapping)
        if frame:
            result["remake"]["frame"] = frame
    result["text"] = f"已提交 {len(submitted)} 个镜头的换角预览。"
    if needs_selection:
        result["text"] += f"另有 {len(needs_selection)} 个镜头需要先确认选区。"
    if outcome["failed"]:
        result["text"] += f"{len(outcome['failed'])} 个镜头提交失败。"
    return result


async def generate_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key, session, mapping = mapped_remake(s, run, user, args)
    index = args["shot"] - 1
    if index not in mapping["shots"]:
        raise ValueError("请选择人物映射内的镜头")
    shot = session["shots"][index]
    if shot.get("keep_original"):
        raise ValueError("此镜头已设为保留原片，请在工作区核对")
    video_remake.update_jobs(s.host, user["id"], session)
    try:
        _, approved, entry_tick = video_remake.shot_start(shot, mapping, s.host.film.FPS)
        video_remake.shot_guides(shot, approved, s.host.film.FPS, mapping, entry_tick)
    except web.HTTPException as error:
        raise ValueError(json.loads(error.text)["error"]) from None
    if approved["job"] != args["first_job"]:
        raise ValueError("已采用的起始帧已变更，请重新读取视频重制状态")
    s.begin_generation(run, cid, "video", 1)
    session = await apply_remake_action(s, user, nid, key, {
        "action": "batch_videos", "person": mapping["source"], "asset": mapping["asset"],
        "shots": [{"shot": index, "first_job": approved["job"], "motion": args.get("motion", "")}],
        "cut_revision": args["cut_revision"],
    })
    outcome = session["batch_videos"]
    if outcome["skipped"]:
        run["data"]["generated_video"] -= 1
        s.update(run)
    result = remake_status(s.host, nid, key, session)
    result["remake"].update(shot_number=index + 1, shot_start=shot["start"])
    result["video"] = {"shot": index + 1, "submitted": bool(outcome["submitted"])}
    if outcome["submitted"]:
        job = session["shots"][index]["videos"][-1]["job"]
        result["remake"]["video_job"] = job
        result["text"] = f"已提交镜头 {index + 1} 的重制视频，完成后可在工作区审核。"
    elif outcome["failed"]:
        result["video"]["error"] = outcome["failed"][0]["error"]
        result["text"] = f"镜头 {index + 1} 提交失败。{result['video']['error']}"
    else:
        result["text"] = f"镜头 {index + 1} 正在处理或已有匹配的视频版本。"
    return result


async def review_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    shot_number = args["shot"]
    adopt = args["decision"] == "adopt"
    job = args.get("video_job")
    if adopt and not job:
        raise ValueError("请先读取镜头的已完成版本，再指定要采用的版本")
    session = await apply_remake_action(s, user, nid, key, {
        "action": "approve_video" if adopt else "keep", "shot": shot_number - 1, "job": job,
        "cut_revision": args["cut_revision"],
    })
    result = remake_status(s.host, nid, key, session)
    result["remake"].update(shot_number=shot_number, shot_start=session["shots"][shot_number - 1]["start"])
    if adopt:
        result["remake"]["video_job"] = job
    result["text"] = f"已采用镜头 {shot_number} 的指定版本。" if adopt else f"镜头 {shot_number} 已设为保留原片。"
    return result


def export_media(host, export):
    ref = export.get("ref")
    if export.get("state") != "done" or export.get("stale") or not ref:
        return None
    try:
        return ref if host.tools.ref_path(host.COMFY_DIR, ref).is_file() else None
    except ValueError:
        return None


async def export_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        raise ValueError("请先分析原片")
    if args["cut_revision"] != session.get("cut_revision", 0):
        raise ValueError("剪辑点已更新，请重新读取视频重制状态")
    result = remake_status(s.host, nid, key, session)
    export = session.get("export") or {}
    if export.get("state") in ("queued", "running"):
        return await s.wait_submitted_jobs(run, user, cid, {
            "ids": [export["job"]], "remake_export": {"key": key, "node_id": nid}, "cancel_on_stop": False,
        })
    unresolved = next((shot for shot in result["shots"] if shot["review_issue"]), None)
    if unresolved:
        number = unresolved["number"]
        result["remake"].update(shot_number=number, shot_start=unresolved["start"])
        result["text"] = f"镜头 {number} {unresolved['review_issue']}"
        return result
    if not result["can_export"]:
        result["text"] = "请先采用至少一个重制镜头。"
        return result
    if result["export_ref"] and not args.get("rebuild"):
        result["text"] = "当前审核版本的成片已就绪，可直接下载。"
        return result
    session = await apply_remake_action(s, user, nid, key, {"action": "export", "cut_revision": args["cut_revision"]})
    return await s.wait_submitted_jobs(run, user, cid, {
        "ids": [session["export"]["job"]], "remake_export": {"key": key, "node_id": nid},
    })


def finish_remake_export(s, run, user, pending, state):
    info = pending["remake_export"]
    key = tuple(info["key"])
    if key[:2] != (user["id"], run["board_id"]):
        raise ValueError("无权读取该成片任务")
    s.board(user, key[1])
    session = video_remake.load(key)
    result = remake_status(s.host, info["node_id"], key, session)
    if state["state"] == "error":
        result.pop("export_ref", None)
        result["error"] = state.get("error") or "成片合成失败"
    elif ((session or {}).get("export") or {}).get("job") != pending["ids"][0] or result.get("export_state") == "stale":
        result.pop("export_ref", None)
        result["text"] = "当前审核内容或成片任务已更新，请打开重制工作区。"
    elif result.get("export_ref"):
        result["text"] = "成片已合成并保留原声，可直接下载。"
    else:
        result["error"] = "成片文件暂不可用，可在重制工作区重新合成。"
    return result


def remake_status(host, nid, key, session, *, review_shot=None):
    result = {"remake": {"node_id": nid, "source_ref": key[3]}, "shots": [], "analyzed": False}
    if not session or not session["shots"]:
        return {**result, "text": "该原片尚未分析，可打开视频重制工作区开始。"}
    video_remake.update_jobs(host, key[0], session)
    video_remake.refresh_export_status(session, key[3], host.film.FPS)
    review = video_remake.export_review(session)
    mapping = session.get("mapping")
    out = session.get("export") or {}
    if review_shot is not None:
        if not 1 <= review_shot <= len(session["shots"]):
            raise ValueError("请选择存在的镜头")
        shot = session["shots"][review_shot - 1]
        result["remake"].update(shot_number=review_shot, shot_start=shot["start"])
        result["review_board"] = key[1]
        in_scope = mapping is None or review_shot - 1 in mapping["shots"]
        result["review_versions"] = [
            {"number": index + 1, "job": version["job"], "mode": version.get("mode", "whole"),
             "adopted": not shot.get("keep_original") and shot.get("adopted_video") == version["job"],
             "review_issue": video_remake.video_start_issue(shot, version, mapping) if in_scope else "该镜头不在替换范围"}
            for index, version in enumerate(shot.get("videos", []))
            if version["state"] == "done" and version.get("ref") and video_remake.matches_mapping(version, mapping)
        ]
    issues = {item["shot"]: item["error"] for item in review["remaining"]}
    for index, shot in enumerate(session["shots"]):
        frame_key = video_remake.start_preview_key(shot, mapping)
        frame = shot["frames"].get(frame_key, {})
        videos = shot.get("videos", [])
        frames = [item for record in shot["frames"].values() for item in record["previews"]]
        adopted_frame = video_remake.completed(frame.get("previews", []), frame.get("approved"))
        people = shot.get("summary", {}).get("characters")
        hint = frame.get("person_hint") or {}
        selected = bool(video_remake.person_selection(frame, mapping))
        frame_approved = bool(adopted_frame and video_remake.matches_mapping(adopted_frame, mapping) and
                              video_remake.preview_matches_regions(frame, adopted_frame, mapping))
        result["shots"].append({
            "number": index + 1, "start": shot["start"], "end": shot["end"],
            "suggested_people": [name[:60] for name in people[:24] if isinstance(name, str)] if isinstance(people, list) else [],
            "keep_original": bool(shot.get("keep_original") or mapping and index not in mapping["shots"]),
            "start_frame_selected": selected,
            "position_suggested": bool(mapping and not selected and not video_remake.person_absent(frame, mapping) and
                                       hint.get("point") and hint.get("source") == mapping["source"] and
                                       hint.get("look") == mapping.get("look", "")),
            "start_frame_approved": frame_approved,
            "approved_start_job": adopted_frame["job"] if frame_approved else None,
            "video_available": any(item.get("ref") and video_remake.matches_mapping(item, mapping) for item in videos),
            "pending": video_remake.pending(frames + videos), "review_issue": issues.get(index),
        })
    count = len(result["shots"])
    return {**result, "analyzed": True, "text": f"共 {count} 个镜头，{len(issues)} 个待审核。",
            "cut_revision": session.get("cut_revision", 0),
            "source_people": session.get("source_people", []), "warning": session.get("warning") or None,
            "mapping": {"source": mapping["source"], "asset": mapping.get("asset_name"), "asset_id": mapping["asset"],
                        "shots": [index + 1 for index in mapping["shots"]]} if mapping else None,
            "adopted": review["adopted"], "can_export": bool(review["adopted"] and not issues and
                                                          out.get("state") not in ("queued", "running")),
            "export_state": "stale" if out.get("stale") else out.get("state"),
            "export_ref": export_media(host, out)}


async def describe(s, run, user, nid):
    b, n = video_node(s, run, user, nid)
    ref = run["data"].get("bindings", {}).get(nid) or (s.current(n) or {}).get("ref")
    if not ref or not any(v.get("ref") == ref for v in n.get("versions", [])):
        raise ValueError("视频版本已不存在")
    def sample():
        import av
        frames = []
        path = s.host.tools.ref_path(s.host.COMFY_DIR, ref)
        with av.open(str(path)) as media:
            stream = media.streams.video[0]
            duration = float(stream.duration * stream.time_base) if stream.duration else float(media.duration or 0) / 1e6
            times = [max(0, duration - .1) * i / 3 for i in range(4)]
            for frame in media.decode(video=0):
                t = float(frame.time or 0)
                if len(frames) < 4 and t + .05 >= times[len(frames)]:
                    im = frame.to_image();im.thumbnail((896, 896))
                    result = s.host.image_editor.save(s.host.COMFY_DIR, im, "agent-video-frame", "input")
                    frames.append({"ref": result["ref"], "name": f"视频实际画面 {t:.2f} 秒"})
                if len(frames) == 4:
                    break
        if not frames:
            raise ValueError("无法读取视频画面")
        return frames
    frames = await asyncio.to_thread(sample)
    result = await s.response(s.host.describe, user, {"images": frames, "mode": "prompt"})
    return {**result, "media_type": "video", "sampled_frames": len(frames), "note": "基于实际视频抽帧分析，不包含音轨分析"}
