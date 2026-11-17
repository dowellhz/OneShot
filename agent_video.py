"""Typed video tools using the same routing, reference planning and queue as canvas generation."""
from __future__ import annotations

import asyncio
import copy
import math
import uuid
import time


NAMES = {"video_generate", "video_regenerate"}


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


def video_node(s, run, user, nid):
    b = s.board(user, run["board_id"])
    n = next((n for n in b.get("nodes", []) if n["id"] == nid), None)
    if not n or n.get("type") != "video":
        raise ValueError("视频节点已不存在，请重新读取画布")
    if n.get("data", {}).get("film"):
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
