"""Capture and describe frames from pinned videos."""
from __future__ import annotations

import asyncio

from oneshot.assistant.video_canvas_results import result_id
from oneshot.assistant.video_reference_inputs import reference_version, video_node


async def capture_video_frame(s, run, user, cid, args):
    board = s.board(user, run["board_id"])
    prior = next((op["result"] for op in board.get("agent_ops", []) if op["id"] == cid), None)
    if prior:
        return prior
    source, _ = reference_version(s, run, user, args, kind="clip")
    position = args["position"]
    image = await s.response(s.host.lastframe, user, {"ref":source["ref"], "position":position, "at":args.get("at")})
    if s.stopped(run):
        raise ValueError("本轮任务已停止")
    nid = result_id(cid)
    suffix = {"first":"首帧", "last":"末帧"}.get(position, f"{image['at']:.2f} 秒")

    def change(current):
        original = next((n for n in current["nodes"] if n["id"] == source["node_id"]
                         and any(v.get("ref") == source["ref"] for v in n.get("versions", []))), None)
        if original is None:
            raise ValueError("取帧所用的原视频版本已移除")
        name = (args.get("name") or f"{original.get('name','视频')} · {suffix}")[:80]
        capture = {"source_node":original["id"], "source_ref":source["ref"], "position":position, "at":image["at"]}
        version = {**{key:image[key] for key in ("ref","url","w","h")}, "source":"frame", "prompt":"", "capture":capture}
        x = max(n.get("x", 0) + s.dimensions(n)[0] for n in current["nodes"]) + 110
        current["nodes"].append({"id":nid, "type":"image", "name":name, "x":x, "y":original.get("y", 100),
            "data":{"prompt":"", "caption":""}, "versions":[version], "cur":0, "job":None})
        current.setdefault("edges", []).append({"from":original["id"], "to":nid, "relation":"capture",
                                               "source_ref":source["ref"], "at":image["at"]})
        return {"media_type":"image", "nodes":[{"id":nid, "type":"image", "name":name, "ref":image["ref"], "url":image["url"],
                "version_index":0}], "capture":capture, "text":f"已把{suffix}放到画布。"}

    result = s.commit(run, user, cid, change)
    run["data"]["bindings"][nid] = image["ref"]
    s.update(run)
    return result


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
