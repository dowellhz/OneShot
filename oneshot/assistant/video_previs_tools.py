"""Read, edit, and render previsualizations from assistant tools."""
from __future__ import annotations

import hashlib
import json

from oneshot.assistant.video_canvas_results import (
    node_data,
    remember_version,
    result_id,
)
from oneshot.assistant.video_reference_inputs import video_node
from oneshot.editing import previs
from oneshot.editing.render import FPS


def scene_revision(scene):
    return hashlib.sha256(json.dumps(scene, sort_keys=True).encode()).hexdigest()


def previs_scene(n):
    scene = n.get("data", {}).get("previs")
    if not isinstance(scene, dict):
        raise ValueError("请选择白模场景节点")
    return previs.validate(scene)


def get_previs(n):
    scene = previs_scene(n)
    return {"node_id":n["id"], "name":n.get("name"), "scene":editable_previs_tracks(scene), "scene_revision":scene_revision(scene),
            "versions":[{"number":i, "ref":v.get("ref"), "seconds":v.get("seconds"), "current":i - 1 == n.get("cur"),
                         **({"span":v["previs_span"]} if v.get("previs_span") else {})}
                        for i, v in enumerate(n.get("versions", []), 1) if v.get("source") == "previs"]}


def editable_previs_tracks(scene):
    return {**scene, "objects":[{key:value for key,value in item.items() if key != "triangles"}
                                for item in scene["objects"]]}


def save_previs(s, run, user, cid, args, *, motion=None, route=None):
    nid = args.get("node_id") or result_id(cid)
    def change(b):
        n = next((n for n in b["nodes"] if n["id"] == nid), None)
        original = None
        meshes = {}
        if args.get("node_id"):
            original = previs_scene(n) if n and n.get("type") == "video" else None
            if original is None or scene_revision(original) != args.get("scene_revision"):
                raise ValueError("白模场景已更新，请重新读取后再保存")
            if n.get("job"):
                raise ValueError("请等待白模渲染完成后再编辑")
            meshes = {item["id"]:item["triangles"] for item in original["objects"] if item["shape"] == "mesh"}
            remember_version(s, b, n)
        else:
            x = max((item.get("x", 0) + s.dimensions(item)[0] for item in b["nodes"]), default=20) + 100
            y = min((item.get("y", 100) for item in b["nodes"]), default=100)
            n = {"id":nid, "type":"video", "name":"白模预演", "x":x, "y":y, "data":node_data({}), "versions":[], "cur":-1}
            b["nodes"].append(n)
        if motion is not None:
            scene = {**original,"camera":previs.camera_motion(original,motion)}
        elif route is not None:
            track = previs.object_motion(original,route)
            scene = {**original,"objects":[{**item,"keys":track} if item["id"]==route["target"] else item
                                          for item in original["objects"]]}
        else:
            retained = {"lighting":original["lighting"]} if original and "lighting" in original else {}
            scene = previs.validate({**retained,**args["scene"],"objects":[
                {**item,"triangles":meshes.get(item["id"])} if item["shape"] == "mesh" else item
                for item in args["scene"]["objects"]
            ]})
        if args.get("name", "").strip():
            n["name"] = args["name"].strip()
        n["data"].update(previs=scene, aspect=scene["aspect"], duration=scene["duration"])
        return {"node_id":nid, "name":n["name"], "scene_revision":scene_revision(scene), "scene":editable_previs_tracks(scene)}
    result = s.commit(run, user, cid, change)
    return {**result, "previs_node":nid, "text":"白模已保存，可打开编辑器调整，或渲染预演。"}


async def render_previs(s, run, user, cid, nid, span=None):
    b, n = video_node(s, run, user, nid)
    scene = previs_scene(n)
    start,end = previs.render_span(scene,span)
    if n.get("job"):
        raise ValueError("白模正在渲染，请等待完成")
    await s.begin_generation(run,cid,"previs",1,{"label":n["name"],"node":nid,"scene":scene,
                                              "duration":(end-start)/FPS},target_id=nid)
    result = await s.response(s.host.render_previs, user, {"board":run["board_id"], "node":nid,
                              "revision":b.get("rev"), "request_key":cid, **({"span":span} if span is not None else {})})
    return await s.wait_submitted_jobs(run, user, cid, {"ids":result["ids"], "name":n["name"], "prompt":"",
        "kind":"video", "target_id":nid, "previs_render":scene, "source":"previs","previs_span":span})
