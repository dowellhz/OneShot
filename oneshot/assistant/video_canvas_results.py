"""Bind video results to canvas nodes, pinned inputs, and versions."""
from __future__ import annotations

import copy
import time
import uuid

from oneshot.assistant.video_reference_inputs import image_reference, reference_slot
from oneshot.canvas import workflow_review


def result_id(cid):
    return "a" + uuid.uuid5(uuid.NAMESPACE_URL, cid + "0").hex[:20]


def node_data(recipe):
    return {"prompt": recipe.get("prompt", ""), "duration": recipe.get("duration", 5), "aspect": "auto", "quality": recipe.get("quality", "hd"),
            "mode": "keyframes" if recipe.get("planned") else "auto", "turbo": recipe.get("turbo", True), "seed": recipe.get("seed", -1),
            "sound": recipe.get("sound", ""), "music": recipe.get("music", ""), "pmode": "fields" if recipe.get("fields") else "free",
            "fields": copy.deepcopy(recipe.get("fields", {})), "count": 1, "provider": recipe.get("provider", ""),
            **{key:copy.deepcopy(recipe[key]) for key in ("selected_model","camera_plan","object_edit","draft","video_optics") if recipe.get(key)}}


def connect_inputs(s, board, nid, recipe):
    images = recipe.get("images", [])
    duration = workflow_review.number(recipe.get("duration")) or 5
    end = (s.host.frames_for(duration) - 4) / 24
    for i, image in enumerate(images):
        source_id = image.get("node_id")
        if not source_id or not any(n["id"] == source_id and n.get("type") == "image" for n in board["nodes"]):
            continue
        if image.get("role") == "subject":
            role = "subject"
        elif recipe.get("planned"):
            role = "first" if image.get("time", 0) <= .01 else "last" if image.get("time", 0) >= end-.05 else "keyframe"
        else:
            role = "first" if i == 0 else "last"
        edge = {"from": source_id, "to": nid, "role": role}
        edge.update(image_reference(image))
        if recipe.get("planned") and role != "subject":
            edge["time"] = image.get("time", 0)
        if edge not in board.setdefault("edges", []):
            board["edges"].append(edge)
    guide = recipe.get("previs_guide")
    if guide and any(n["id"] == guide["node_id"] and any(v.get("ref") == guide["ref"] and v.get("source") == "previs"
                     for v in n.get("versions", [])) for n in board["nodes"]):
        board["edges"].append({"from":guide["node_id"], "to":nid, "relation":"previs", "ref":guide["ref"]})
    for sound in recipe.get("audio_refs", []):
        if any(n["id"] == sound.get("node_id") and n.get("type") == "audio" and
               any(v.get("ref") == sound["ref"] for v in n.get("versions", [])) for n in board["nodes"]):
            board["edges"].append({"from":sound["node_id"],"to":nid,"relation":"audio_ref","ref":sound["ref"],
                                   **reference_slot(sound),**{key:sound[key] for key in ("start","end") if key in sound}})
    for index, clip in enumerate(recipe.get("video_refs", [])):
        if any(n["id"] == clip.get("node_id") and n.get("type") == "video" and
               any(v.get("ref") == clip["ref"] for v in n.get("versions", [])) for n in board["nodes"]):
            edge = {"from":clip["node_id"],"to":nid,"relation":"video_ref","ref":clip["ref"],
                    **reference_slot(clip),
                    **{key:clip[key] for key in ("start","end") if key in clip}}
            if index==0 and recipe.get("extension"):
                edge["extension"]=recipe["extension"]
            if index==0 and recipe.get("segment_edit"):
                edge["segment_edit"]=True
            board["edges"].append(edge)


def remember_version(s, board, n):
    """Legacy versions acquire a snapshot before their live inputs are changed."""
    version = s.current(n)
    if version is not None:
        version.setdefault("input_edges", copy.deepcopy([e for e in board.get("edges", []) if e.get("to") == n["id"]]))
        version.setdefault("node_data", copy.deepcopy(n.get("data", {})))


def queued_node(s, run, user, cid, pending):
    nid = pending.get("target_id") or result_id(cid)
    version_history = pending.get("version_history") or pending.get("draft_history")
    def change(b):
        n = next((n for n in b["nodes"] if n["id"] == nid), None)
        if pending.get("target_id"):
            if not n:
                return {"node_id": nid, "deleted": True}
            if n.get("job") and n["job"].get("agent_call") != cid:
                raise ValueError("原节点已有其他任务，未覆盖其进度")
            if pending.get("kind") == "video":
                remember_version(s, b, n)
                recipe = pending.get("recipe")
                if recipe and not version_history:
                    image_ids = {im["id"] for im in b["nodes"] if im.get("type") == "image"}
                    b["edges"] = [e for e in b.get("edges", []) if not (e.get("to") == nid and
                                  (e.get("from") in image_ids or e.get("relation") in ("previs","audio_ref","video_ref")))]
                    n["data"].update(copy.deepcopy(pending.get("target_data") or node_data(recipe)))
                    for prop in ("selected_model","camera_plan","object_edit","draft","video_optics"):
                        if not recipe.get(prop):
                            n["data"].pop(prop, None)
                    connect_inputs(s, b, nid, recipe)
            elif pending.get("audio_recipe"):
                for field in ("subtitles","audio_format","sample_rate","pitch_semitones","gain","references"):
                    if field not in pending["audio_recipe"]:
                        n["data"].pop(field,None)
                n["data"].update(pending["audio_recipe"])
        elif n:
            return {"node_id": nid}
        else:
            x = max((n.get("x", 0) + s.dimensions(n)[0] for n in b["nodes"]), default=20) + 100
            y = min((n.get("y", 100) for n in b["nodes"]), default=100)
            kind=pending["kind"]
            recipe=pending.get("recipe",{})
            if recipe.get("extension")=="before":
                x=min((item.get("x",0) for item in b["nodes"]),default=0)-540
            n = {"id": nid, "type": kind, "name": pending["name"][:40], "x": x, "y": y,
                 "data": node_data(recipe) if kind=="video" else dict(pending["audio_recipe"]),
                 "versions": [], "cur": -1, "agent_call": cid}
            b["nodes"].append(n)
            if kind=="video":
                if draft := pending.get("draft_branch"):
                    source = next((item for item in b["nodes"] if item["id"] == draft["source_node"]), None)
                    n["data"] = copy.deepcopy(version_history["node_data"])
                    if source:
                        previous = {item["id"] for item in b["nodes"] if item is not n}
                        s.place_new_nodes(b,previous,{"x":source["x"]+s.placement_size(source)[0]+110,"y":source["y"]})
                        if any(v.get("ref")==draft["source_ref"] for v in source["versions"]):
                            b["edges"].extend(copy.deepcopy(version_history["input_edges"]))
                else:
                    connect_inputs(s, b, nid, recipe)
                if source := pending.get("broll_source"):
                    if any(item["id"] == source["node"] and any(v.get("ref")==source["ref"] for v in item.get("versions",[])) for item in b["nodes"]):
                        b["edges"].append({"from":source["node"],"to":nid,"relation":"broll","ref":source["ref"]})
        n["job"] = {"ids": pending["ids"], "prompt": pending["prompt"], "t0": round(time.time() * 1000), "agent_call": cid}
        n.pop("agent_error", None)
        history = {"input_edges": copy.deepcopy([e for e in b.get("edges", []) if e.get("to") == nid]),
                   "node_data": copy.deepcopy(n["data"])} if pending.get("kind") == "video" else {}
        if version_history:
            history = copy.deepcopy(version_history)
        if source := pending.get("broll_source"):
            history.update(broll_source=source,broll_recipe=pending["broll_recipe"],mode="B-roll")
        if scene := pending.get("previs_render"):
            history.update(previs_recipe=scene, node_data={**history["node_data"], "previs":scene,
                           "aspect":scene["aspect"], "duration":scene["duration"]})
            if pending.get("previs_span"):
                history["previs_span"] = pending["previs_span"]
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
            if target_id and previous and history and not any(history.get(k) for k in ("previs_recipe","draft_final","film_recipe")) and n.get("type")=="video":
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


def restore_video_snapshot(board, target, version):
    nid = target["id"]
    known = {n["id"] for n in board["nodes"]}
    restored = [e for e in version["input_edges"] if e.get("from") in known and e.get("from") != nid]
    board["edges"] = [e for e in board.get("edges", []) if e.get("to") != nid] + copy.deepcopy(restored)
    target["data"] = copy.deepcopy(version["node_data"])
