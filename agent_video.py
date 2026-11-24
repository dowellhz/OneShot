"""Typed video tools using the same routing, reference planning and queue as canvas generation."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
import re
import uuid
import time

from aiohttp import web

import video_remake
import previs
import camera_plan
import image_camera
import motion_reference
import object_edit
import workflow_review
import broll
import creative_memory
import db
from render import CUTAWAY_LIMIT, FPS, GIF_FPS, GIF_SIZES, TITLE_LIMIT, TITLE_POSITIONS, TITLE_STYLES

NAMES = {"video_models", "video_generate", "video_regenerate", "video_extend", "video_edit_segment", "video_object_settings", "video_capture_frame", "video_remake_status", "video_remake_analyze", "video_remake_plan",
         "video_draft_status", "video_draft_finalize", "video_titles_get", "video_titles_edit",
         "video_cutaways_get", "video_cutaways_edit", "video_broll_generate", "video_export_gif",
         "video_remake_split_long", "video_remake_map", "video_remake_locate", "video_remake_preview", "video_remake_generate",
         "video_remake_review", "video_remake_export", "video_previs_get", "video_previs_save", "video_previs_render",
         "video_previs_camera_motion", "video_previs_object_motion", "video_previs_storyboard_plan"}


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


def register(tool, prop, node, prompt):
    frame = prop("object", properties={"node_id": node, "role": prop("string", enum=["first", "last", "keyframe", "subject"]),
                                      "time": prop("number", minimum=0, maximum=15)}, required=["node_id"], additionalProperties=False)
    optics = prop("object",properties={
        "lens":prop("integer",enum=list(image_camera.LENSES)), "sensor":prop("string",enum=list(image_camera.SENSORS)),
        "optics":prop("string",enum=list(image_camera.OPTICS)), "aperture":prop("string",enum=list(image_camera.APERTURES)),
    },additionalProperties=False)
    options = {"prompt": prompt, "duration": prop("number", minimum=2, maximum=30),
               "quality": prop("string", enum=["hd","std","480p","4k"],description="选择当前模型支持的分辨率。480p 与 4k 为显式档位。"),
               "selected_model": prop("string", minLength=1,maxLength=200,description="用 video_models 查到的具体模型 ID。新生成时须同时传该模型的 provider。"),
               "draft": prop("boolean"),
               "video_optics":optics,
               "memory_views":creative_memory.view_selection_schema(prop),
               "seed": prop("integer", minimum=-1, maximum=2**48), "provider": prop("string", maxLength=100), "name": node}
    guide = prop("object", properties={"node_id":node, "version":prop("integer", minimum=1, maximum=5000)},
                 required=["node_id"], additionalProperties=False)
    clips = prop("array", items=prop("object", properties={**guide["properties"],
                 "start":prop("number", minimum=0), "end":prop("number", minimum=0)},
                 required=["node_id"], additionalProperties=False), maxItems=10)
    sounds = clips
    camera_view=prop("object",properties={"angle":prop("string",enum=list(camera_plan.ANGLES)),
                     "scale":prop("string",enum=list(camera_plan.SCALES))},required=["angle","scale"],additionalProperties=False)
    camera=prop("object",properties={"mode":prop("string",enum=list(camera_plan.MODES)),
                "start":camera_view,"end":camera_view},required=["mode","start"],additionalProperties=False)
    replacement=prop("object",properties={**guide["properties"],"memory_id":node},additionalProperties=False)
    object_plan=prop("object",properties={"action":prop("string",enum=list(object_edit.ACTIONS)), "at":prop("number",minimum=0),
                     "box":prop("array",items=prop("number",minimum=0,maximum=1),minItems=4,maxItems=4),
                     "replacement":replacement},additionalProperties=False)
    tool("video_models", "读取当前可选视频模型、服务 ID、支持的时长、分辨率和参考能力。选模式可筛选音视频参考、续拍或片段编辑。", {
        "mode":prop("string",enum=["generation","audio_reference","video_reference","extension","segment_edit"]),
    }, [])
    tool("video_generate", "生成真正的视频（MP4）。frames 支持首尾帧、关键帧和人物设定；提供已渲染的 previs 时，图片作为外观参考，白模控制运镜和走位。", {
        **options, "frames": prop("array", items=frame, maxItems=30), "previs":guide, "audio_refs":sounds, "video_refs":clips}, ["prompt"])
    tool("video_extend", "生成接在现有视频之前或之后的新镜头。method 默认 auto，有支持的连续参考服务时使用原片连续画面，否则在本地 H3 以接点帧接拍。method=frame 指定本地接拍，method=motion 指定连续画面参考。node_id 指原视频，version 省略时使用本轮所选版本；before 补拍片头，after 续拍片尾。", {
        **options, **guide["properties"], "direction":prop("string", enum=["before","after"]),
        "method":prop("string", enum=["auto","frame","motion"]),
        "frames":prop("array", items=frame, maxItems=30), "audio_refs":sounds, "video_refs":clips}, ["node_id","direction","prompt"])
    tool("video_edit_segment", "编辑原片的指定范围（4 到 30 秒），结果放在相连的新节点。普通修改提供 prompt；重拍提供 camera_plan；框选物体用 object_edit，须有明确的原片秒数 at 和归一化框 [左,上,右,下]。替换参考用 replacement 的图片节点或资产ID。", {
        "node_id":node,"version":guide["properties"]["version"],"prompt":prompt,"provider":options["provider"],"name":node,"draft":options["draft"],"video_optics":optics,
        "memory_views":options["memory_views"],
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),
        "frames":prop("array",items=frame,maxItems=30),"audio_refs":sounds,"video_refs":clips,"camera_plan":camera,"object_edit":object_plan},
        ["node_id","start","end"])
    tool("video_object_settings", "读取物体编辑节点已保存的原片区间、框选位置及替换参考图。可读取还未生成的草稿或指定历史版本。", guide["properties"], ["node_id"])
    tool("video_draft_status", "列出视频节点中实际生成过的 480p 样片及其定稿有效期；普通视频不会列为样片。", {"node_id":node}, ["node_id"])
    tool("video_draft_finalize", "把已生成的原生 480p 样片交给原生成服务定稿。placement=branch 把定稿放到相连的新节点，默认 tab 在原节点追加定稿版本。version 选定样片版本，默认当前引用；resolution 默认 1080p。", {
        **guide["properties"],"resolution":prop("string",enum=["1080p","4k"]),
        "placement":prop("string",enum=["tab","branch"])}, ["node_id"])
    tool("video_titles_get", "读取所选视频版本的时长和可编辑画面标题。标题编号从 1 开始，时间是该版本的成片秒数。", guide["properties"], ["node_id"])
    title = prop("object", properties={"text":prop("string",minLength=1,maxLength=120),
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),
        "position":prop("string",enum=list(TITLE_POSITIONS)),"style":prop("string",enum=sorted(TITLE_STYLES))},
        additionalProperties=False)
    change = prop("object", properties={"action":prop("string",enum=["add","update","remove"]),
        "number":prop("integer",minimum=1,maximum=TITLE_LIMIT),"title":title}, required=["action"], additionalProperties=False)
    tool("video_titles_edit", "给已有视频添加、修改或移除片头、地名条等画面文字。add 提供 title.text，其他字段可选；update 必须提供原编号和要改的 title 字段；remove 只提供原编号。同次改动中编号以原列表为准。输出追加到原节点新版本。", {
        **guide["properties"],"changes":prop("array",items=change,minItems=1,maxItems=TITLE_LIMIT)}, ["node_id","changes"])
    source = prop("object",properties={**guide["properties"],"memory_id":node},additionalProperties=False)
    cutaway = prop("object",properties={"source":source,"start":prop("number",minimum=0),
        "duration":prop("number",minimum=1/24),"in":prop("number",minimum=0)},additionalProperties=False)
    cutaway_change = prop("object",properties={"action":prop("string",enum=["add","update","remove"]),
        "number":prop("integer",minimum=1,maximum=CUTAWAY_LIMIT),"cutaway":cutaway},required=["action"],additionalProperties=False)
    tool("video_cutaways_get", "读取所选视频版本的时长、补画面编号和标题，不会提交渲染。", guide["properties"], ["node_id"])
    tool("video_cutaways_edit", "在现有视频指定时段插入补画面，保留主片时长、声音和字幕。同一次可改标题。add 提供 cutaway.source（画布图片/视频节点及可选版本，或资产 memory_id）、start 和 duration，视频可用 in 指定源素材入点。update 传原编号与改动；remove 只传原编号。编号以改动前为准。结果保存到原节点的新版本。", {
        **guide["properties"],"changes":prop("array",items=cutaway_change,minItems=1,maxItems=CUTAWAY_LIMIT),
        "title_changes":prop("array",items=change,minItems=1,maxItems=TITLE_LIMIT)}, ["node_id","changes"])
    graphics_bar = prop("object",properties={"label":prop("string",minLength=1,maxLength=18),
        "value":prop("number",minimum=0,maximum=1e9)},required=["label","value"],additionalProperties=False)
    tool("video_broll_generate", "在用户确认后，把指定图片或视频版本制作成相连的独立 B-roll 视频。title 为动态标题，captions 为依次显示的字幕卡，chart 为条形图，motion 为图片推拉。只做草稿时直接用文字回复。图表只用用户给出的数值，不补造。start/end 是源视频或图片片段的秒数，视频保留原声和总长，图片片段默认 4 秒。", {
        **guide["properties"],"mode":prop("string",enum=list(broll.MODES)),"style":prop("string",enum=sorted(broll.STYLES)),
        "start":prop("number",minimum=0),"end":prop("number",minimum=0),"duration":prop("number",minimum=.5,maximum=12),
        "title":prop("string",minLength=1,maxLength=100),"lines":prop("array",items=prop("string",minLength=1,maxLength=70),minItems=1,maxItems=6),
        "bars":prop("array",items=graphics_bar,minItems=2,maxItems=6),"direction":prop("string",enum=["in","out"])}, ["node_id","mode"])
    tool("video_capture_frame", "把视频的首帧、末帧或指定时间的画面保存成相连的图片节点。position 为 first、last 或 time；仅 time 需要 at（原视频秒数）。返回真实图片节点，可以在后续生成用作首帧或参考图。", {
        **guide["properties"], "position":prop("string", enum=["first","last","time"]),
        "at":prop("number", minimum=0), "name":node}, ["node_id","position"])
    tool("video_export_gif", "把已完成的视频版本导出为可下载的无声循环 GIF。start/end 是原片秒数，区间须在 0.25–8 秒内；默认导出开头最多 3 秒。ping_pong=true 时往返循环，适合动作首尾不相接。", {
        **guide["properties"],"start":prop("number",minimum=0),"end":prop("number",exclusiveMinimum=0),
        "fps":prop("integer",enum=list(GIF_FPS)),"size":prop("integer",enum=list(GIF_SIZES)),
        "ping_pong":prop("boolean")},["node_id"])
    tool("video_regenerate", "在同一节点重新生成并追加版本。可选 version 指定旧版。省略 frames 时沿用所选版本的图片；只换个别输入用 replacements，重新指定整组图片用 frames，两者不可同传。物体框选等其他设置仍沿用所选版本。", {
        **options, **guide["properties"], "previs":guide, "audio_refs":sounds, "video_refs":clips, "camera_plan":camera, "object_edit":object_plan,
        "reuse_asset_references":prop("boolean",description="用户要求按旧资产复现时为 true，沿用原生成记录里的参考素材和文字设定"),
        "memory_ids":prop("array",items=node,maxItems=8,description="替换从旧版本沿用的资产，空数组可清除继承；省略则沿用。用户本轮或本次提示词的明确引用仍会应用"),
        "frames":prop("array",items=frame,maxItems=30),
        "replacements": prop("array", maxItems=12, items=prop("object", properties={
            "from_node_id": node, "to_node_id": node}, required=["from_node_id", "to_node_id"], additionalProperties=False))}, ["node_id"])
    def track(fields, transitions=("linear","smooth")):
        pose = {field:prop("number", minimum=18 if field == "fov" else -360 if field == "yaw" else -50,
                           maximum=95 if field == "fov" else 360 if field == "yaw" else 50) for field in fields}
        key = prop("object", properties={**pose, "t":prop("integer", minimum=0, maximum=24 * previs.MAX_SECONDS),
                   "ease":prop("string", enum=list(transitions))}, required=["t", *fields], additionalProperties=False)
        return prop("array", items=key, minItems=1, maxItems=32)
    dimensions = {key:prop("number", minimum=.1, maximum=20) for key in ("width","height","depth")}
    item = prop("object", properties={"id":node, "label":node, "shape":prop("string", enum=sorted(previs.SHAPES)), **dimensions,
                                    "keys":track(previs.POSE_FIELDS)},
                required=["id","label","shape",*dimensions,"keys"], additionalProperties=False)
    lighting = prop("object",properties={
        **{key:prop("number",minimum=low,maximum=high) for key,(low,high) in previs.LIGHT_LIMITS.items()},
        "tone":prop("string",enum=list(previs.LIGHT_TONES)),"enabled":prop("boolean")},additionalProperties=False)
    scene = prop("object", properties={"duration":prop("integer", minimum=2, maximum=previs.MAX_SECONDS),
                 "aspect":prop("string", enum=list(previs.ASPECTS)), "camera":track(previs.CAMERA_FIELDS,previs.CAMERA_TRANSITIONS),
                 "objects":prop("array", items=item, maxItems=24),"lighting":lighting},
                 required=["duration","aspect","camera","objects"], additionalProperties=False)
    tool("video_previs_get", "读取白模当前可编辑场景、场景版本校验码和已渲染的 Tab。", {"node_id":node}, ["node_id"])
    tool("video_previs_storyboard_plan", "按现有白模的机位硬切准备分镜导入卡，列出实际切点和时长。用户打开白模核对后，点击按切点创建分镜，生成首帧并连到视频节点。", {"node_id":node}, ["node_id"])
    tool("video_previs_save", "保存可编辑的白模场景。创建时省略 node_id。修改时先读取原场景，保留无关物体和关键帧，并传 node_id 与 scene_revision。灯光 lighting 省略时保留，开启时填写 azimuth（0° 为 +Z、90° 为 +X）、elevation、key、ambient、tone，传 enabled=false 恢复默认。已导入的 mesh 通过原物体 ID 保留。t 为 24 FPS 帧号。", {
        "node_id":node, "scene_revision":prop("string", maxLength=64), "name":node, "scene":scene}, ["scene"])
    tool("video_previs_camera_motion", "为现有白模在指定区间写入可编辑运镜关键帧。先用 video_previs_get 获取校验码和物体编号。start/end 为秒。推进、拉远和横移的 amount 为米，环绕的 amount 为度，跟拍则提供 target 物体编号。", {
        "node_id":node,"scene_revision":prop("string",minLength=64,maxLength=64),
        "mode":prop("string",enum=list(previs.CAMERA_MOVES)),
        "start":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "end":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "amount":prop("number",minimum=.1,maximum=180),"target":node},
        ["node_id","scene_revision","mode","start","end"])
    route_point = prop("object",properties={"x":prop("number",minimum=-50,maximum=50),
        "z":prop("number",minimum=-50,maximum=50)},required=["x","z"],additionalProperties=False)
    tool("video_previs_object_motion", "给现有白模的一个物体设置按距离分配时间的走位路线。先读取场景，提供版本校验码和目标物体编号。start/end 为秒，起点自动取该物体在 start 的位置。points 按经过顺序填写 X/Z 坐标，最后一个为终点。", {
        "node_id":node,"scene_revision":prop("string",minLength=64,maxLength=64),"target":node,
        "start":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "end":prop("number",minimum=0,maximum=previs.MAX_SECONDS),
        "points":prop("array",items=route_point,minItems=1,maxItems=31)},
        ["node_id","scene_revision","target","start","end","points"])
    tool("video_previs_render", "把已保存的白模渲染为无声 MP4，追加在同一节点的版本 Tab。span 可指定 24 FPS 的起止帧，起帧包含、止帧不包含，省略时渲染整段。渲染结果至少 2 秒才可用作视频动作参考。", {
        "node_id":node,"span":prop("array",items=prop("integer",minimum=0,maximum=FPS*previs.MAX_SECONDS),minItems=2,maxItems=2)}, ["node_id"])
    shot_number = prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS)
    tool("video_remake_status", "读取原片视频版本的角色替换进度。指定shot可查看该镜头的已完成视频版本和任务编号。", {
        "node_id": node, "shot": shot_number,
    }, ["node_id"])
    tool("video_remake_analyze", "分析重制原片的镜头和人物。已有分析时读取结果；用户要求重试时设retry=true，补充缺失分析并保留剪辑点和审核决定。", {
        "node_id": node, "retry": prop("boolean"),
    }, ["node_id"])
    tool("video_remake_split_long", "按当前视频服务的时长上限均匀拆分指定长镜头。先用video_remake_status获取镜头编号和最新cut_revision。拆分会更新后续镜头编号。", {
        "node_id": node, "shot": shot_number, "cut_revision": prop("integer", minimum=0),
    }, ["node_id", "shot", "cut_revision"])
    tool("video_remake_plan", "列出换角执行计划的镜头、角色参考和待确认选区，等待用户勾选提交。", {
        "node_id": node, "asset_id": node, "person": prop("string", minLength=1, maxLength=60),
        "look": prop("string", maxLength=240), "shots": prop("array", items=shot_number, minItems=1, maxItems=4),
    }, ["node_id", "asset_id", "person", "shots"])
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
    tool("video_remake_generate", "用已采用的起始帧和动作关键帧提交一个重制镜头视频。first_job取自重制状态的approved_start_job。仅在用户明确要求用深度参考时，传入可用的motion_provider。", {
        "node_id": node, "person": prop("string", minLength=1, maxLength=60), "asset_id": node,
        "cut_revision": prop("integer", minimum=0),
        "shot": prop("integer", minimum=1, maximum=video_remake.MAX_SHOTS), "first_job": node,
        "motion": prop("string", maxLength=1600), "motion_provider": node,
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


def reference_slot(record):
    slot = (record or {}).get("prompt_slot")
    return {"prompt_slot":slot} if type(slot) is int and slot>0 else {}


def image_reference(image):
    slot = reference_slot(image)
    ref = image.get("ref")
    return {**slot, "ref":ref} if ref and (slot or image.get("pinned") is True) else slot


def reference_version(s, run, user, selection=None, edge=None, *, kind="video"):
    nid = selection["node_id"] if selection else edge["from"]
    if kind != "audio":
        _, node = video_node(s, run, user, nid, allow_film=kind=="clip")
    else:
        board = s.board(user, run["board_id"])
        node = next((n for n in board["nodes"] if n["id"] == nid and n["type"] == "audio"), None)
        if node is None:
            raise ValueError("音频节点已不存在")
    versions = node.get("versions", [])
    if selection and "version" in selection:
        index = selection["version"] - 1
    elif edge or (nid in run["data"].get("bindings", {})):
        ref = edge.get("ref") if edge else run["data"]["bindings"][nid]
        index = next((i for i, v in enumerate(versions) if v.get("ref") == ref), -1)
    else:
        index = node.get("cur", -1)
    if not 0 <= index < len(versions) or (kind == "video" and versions[index].get("source") != "previs"):
        raise ValueError({"video":"请选择已渲染的白模 Tab", "clip":"请选择仍存在的视频版本", "audio":"请选择仍存在的音频版本"}[kind])
    version = versions[index]
    return {"node_id":nid, "ref":version["ref"], "name":node.get("name"), "version":index + 1, **reference_slot(edge)}, version


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


def read_draft_status(s, run, user, nid):
    _, node = video_node(s,run,user,nid,allow_film=True)
    now = time.time()
    drafts = []
    for index, version in enumerate(node.get("versions", []), 1):
        if source := s.host.video_draft_source(version.get("ref")):
            expiry = source["expires"]
            drafts.append({"version":index,"current":node.get("cur")==index-1,
                           "expires":expiry,"expired":expiry<=now,"resolution":"480p"})
    return {"node_id":nid,"name":node["name"],"drafts":drafts,"final_resolutions":["1080p","4k"],
            "text":"已读取样片版本。" if drafts else "这个节点还没有可列出的原生样片。"}


async def finalize_draft(s, run, user, cid, args):
    board, target = video_node(s,run,user,args["node_id"],allow_film=True)
    if target.get("job"):
        raise ValueError("请等待当前视频任务完成或取消后再生成定稿")
    selected, source = reference_version(s,run,user,selection=args,kind="clip")
    draft = s.host.video_draft_source(source["ref"])
    if not draft:
        raise ValueError("所选版本不是原生样片，请从样片版本生成定稿")
    if draft["expires"]<=time.time():
        raise ValueError("样片已过定稿有效期，请重新生成样片")

    _, recipe, data, inputs = video_edit_snapshot(s,run,board,target,selected["version"])
    recipe.pop("draft",None)
    data.pop("draft",None)
    resolution = args.get("resolution","1080p")
    recipe["quality"] = data["quality"] = "4k" if resolution == "4k" else "hd"
    record = copy.deepcopy(source.get("generation_record") or workflow_review.capture_generation(recipe))
    record.setdefault("settings", {})["resolution"] = resolution
    prompt = source.get("prompt") or recipe.get("prompt") or ""
    branch = args.get("placement") == "branch"
    target_id = None if branch else target["id"]
    draft_final = {"source_node":target["id"],"source_ref":source["ref"],"resolution":resolution}
    if branch:
        inputs = [{"from":target["id"],"to":result_id(cid),"relation":"draft_final","ref":source["ref"]}]
        data = {**node_data(recipe),**data,"prompt":prompt}
    name = target["name"][:28]+" · "+resolution.upper()+" 定稿" if branch else target["name"]+" · 定稿"
    await s.begin_generation(run,cid,"video",1,{"label":name,"ref":source["ref"],
        "node":target["id"],"resolution":resolution,"prompt":prompt,"placement":"branch" if branch else "tab"},target_id=target_id)
    result = await s.response(s.host.finalize_video_draft,user,{
        "board":run["board_id"],"node":target["id"],"ref":source["ref"],"resolution":resolution,"request_key":cid})
    return await s.wait_submitted_jobs(run,user,cid,{
        "ids":result["ids"],"name":name,"prompt":prompt,"kind":"video",
        "target_id":target_id,"recipe":recipe,"generation_record":record,
        **({"draft_branch":draft_final} if branch else {}),
        "memory_used":source.get("memory_used",[]),"version_history":{
            "input_edges":inputs,"node_data":data,"draft_final":draft_final}})


def restore_video_snapshot(board, target, version):
    nid = target["id"]
    known = {n["id"] for n in board["nodes"]}
    restored = [e for e in version["input_edges"] if e.get("from") in known and e.get("from") != nid]
    board["edges"] = [e for e in board.get("edges", []) if e.get("to") != nid] + copy.deepcopy(restored)
    target["data"] = copy.deepcopy(version["node_data"])


async def saved_video_timeline(s, run, user, target, args):
    selected, video = reference_version(s,run,user,selection=args,kind="clip")
    ref = selected["ref"]
    s.host.require_media(user,{ref})
    path = s.host.tools.ref_path(s.host.COMFY_DIR,ref)
    _, _, seconds, _ = await asyncio.to_thread(s.host.film.probe,path)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("无法读取所选视频的时长")
    saved = workflow_review.obj(video.get("film_recipe"))
    saved_timeline = saved.get("timeline")
    editable = isinstance(saved_timeline,dict) and bool(workflow_review.items(saved_timeline.get("clips")))
    if editable:
        timeline = copy.deepcopy(saved_timeline)
        recipe = copy.deepcopy(saved)
    else:
        clip = {"node":target["id"],"name":target["name"],"ref":ref,"kind":"video","media_seconds":seconds,
                "in":0,"out":seconds,"trans":"cut","volume":1,"subs":[],"audio_ref":ref,"audio_start":0,
                "audio_seconds":seconds}
        timeline = {"clips":[clip],"aspect":"source","fit":"blur","subtitles":True,"sub_size":1,"bgm":None,
                    "narration":[],"audio_clips":[],"cover":0}
        recipe = {"clips":[{"node":target["id"],"ref":ref,"in":0,"out":seconds,"trans":"cut","audio_ref":ref,
                            "audio_start":0}],"audio":[]}
    return selected, video, seconds, editable, timeline, recipe


def change_titles(film, titles, changes, seconds):
    previous = copy.deepcopy(titles)
    combined = copy.deepcopy(titles)
    changed = set()
    for change in changes:
        action, number, fields = change["action"], change.get("number"), change.get("title")
        if action == "add":
            if number is not None or not fields or not fields.get("text","").strip():
                raise ValueError("添加标题需要文字，标题编号由时间线分配")
            start = fields.get("start",0)
            title = {"start":start,"end":min(seconds,start+2.5),**fields}
            combined.append(title)
        else:
            if number is None or not 1 <= number <= len(previous) or number in changed:
                raise ValueError("请使用所选版本里的有效标题编号，每次只能修改同一编号一次")
            changed.add(number)
            if action == "remove":
                if fields is not None:
                    raise ValueError("删除标题只需要标题编号")
                combined[number-1] = None
                continue
            if not fields or ("text" in fields and not fields["text"].strip()):
                raise ValueError("请填写需要更新的标题字段")
            title = {**combined[number-1],**fields}
            combined[number-1] = title
        if not 0 <= title["start"] < title["end"] <= seconds + .001:
            raise ValueError(f"标题须在 0 到 {seconds:.3f} 秒内，结束时间须晚于开始时间")
    return film.title_items([title for title in combined if title is not None])


async def cutaway_source(s, run, user, board, source):
    nid, mid, index = (source.get(key) for key in ("node_id","memory_id","version"))
    if bool(nid) == bool(mid) or (mid and index is not None):
        raise ValueError("补画面请选择一个画布节点和版本，或一项资产")
    if mid:
        try:
            asset = s.app["creative_memory"].get(user,mid,run["board_id"])
        except web.HTTPException:
            raise ValueError("补画面资产不存在或不可访问") from None
        ref, label = asset.get("ref"), asset.get("name")
        origin = {"memory_id":mid}
    else:
        node = next((item for item in board.get("nodes",[]) if item["id"] == nid and item.get("type") in ("image","video")),None)
        if not node:
            raise ValueError("请选择画布上的图片或视频作为补画面")
        versions = node.get("versions",[])
        if index is None:
            bound = run["data"].get("bindings",{}).get(nid)
            index = next((i for i,v in enumerate(versions,1) if v.get("ref")==bound),0) if bound else node.get("cur",-1)+1
        if not 1 <= index <= len(versions):
            raise ValueError("补画面的所选版本不存在")
        ref, label = versions[index-1].get("ref"), node.get("name")
        origin = {"node":nid,"version":index}
    suffix = "." + ref.rsplit(".",1)[-1].lower() if isinstance(ref,str) else ""
    kind = "video" if suffix in s.host.tools.VIDEO_EXT else "image" if suffix in s.host.creative_memory.IMAGE_EXT else None
    if not kind:
        raise ValueError("补画面素材须为图片或视频")
    s.host.require_media(user,{ref})
    item = {**origin,"kind":kind,"ref":ref,"name":label or "补画面"}
    if kind == "video":
        path = s.host.tools.ref_path(s.host.COMFY_DIR,ref)
        _, _, duration, _ = await asyncio.to_thread(s.host.film.probe,path,display=False)
        item["seconds"] = duration
    return item


async def change_cutaways(s, run, user, board, items, changes, seconds):
    combined = copy.deepcopy(items)
    changed = set()
    for change in changes:
        action, number, fields = change["action"], change.get("number"), change.get("cutaway")
        if action == "add":
            if number is not None or not fields or not {"source","start","duration"} <= fields.keys():
                raise ValueError("添加补画面需要素材、开始时间和时长")
            item = {"in":0}
        else:
            if number is None or not 1 <= number <= len(items) or number in changed:
                raise ValueError("请使用所选版本里的有效补画面编号，每次只能修改同一编号一次")
            changed.add(number)
            if action == "remove":
                if fields is not None:
                    raise ValueError("删除补画面只需要原编号")
                combined[number-1] = None
                continue
            if not fields:
                raise ValueError("请填写需要修改的补画面设置")
            item = copy.deepcopy(items[number-1])
        if "source" in fields:
            source = await cutaway_source(s,run,user,board,fields["source"])
            for key in ("node","version","memory_id","seconds"):
                item.pop(key,None)
            item.update(source)
            if item["kind"] == "image":
                item["in"] = 0
        item.update({key:fields[key] for key in ("start","duration","in") if key in fields})
        duration = item["duration"]
        if item["start"] + duration > seconds + .001:
            raise ValueError(f"补画面须位于成片的 0 到 {seconds:.3f} 秒内")
        if item.get("seconds") and item.get("in",0) + duration > item["seconds"] + 1/24:
            raise ValueError("补画面的出点超出原片范围")
        if action == "add":
            combined.append(item)
        else:
            combined[number-1] = item
    result = [item for item in combined if item is not None]
    s.host.film.cutaway_layout(result)
    return result


def timeline_items(items):
    return [{**item,"number":i} for i,item in enumerate(items,1)]


async def edit_video_timeline(s, run, user, cid, name, args):
    board, target = video_node(s,run,user,args["node_id"],allow_film=True)
    selected, video, seconds, editable, timeline, recipe = await saved_video_timeline(s,run,user,target,args)
    titles = s.host.film.title_items(timeline.get("titles",[]))
    cutaways = timeline.get("cutaways",[])
    s.host.film.cutaway_layout(cutaways)
    if name.endswith("_get"):
        return {"node_id":target["id"],"version":selected["version"],"seconds":seconds,"timeline_saved":editable,
                "titles":timeline_items(titles),"cutaways":timeline_items(cutaways)}
    editing_cutaways = name == "video_cutaways_edit"
    title_changes = args.get("title_changes",[]) if editing_cutaways else args["changes"]
    edited_titles = change_titles(s.host.film,titles,title_changes,seconds) if title_changes else titles
    edited_cutaways = await change_cutaways(s,run,user,board,cutaways,args["changes"],seconds) if editing_cutaways else cutaways
    board, target = video_node(s,run,user,target["id"],allow_film=True)
    matches = [i for i,v in enumerate(target.get("versions",[]),1) if v.get("ref")==selected["ref"]]
    if not matches:
        raise ValueError("所选视频版本已移除")
    source_index = selected["version"] if selected["version"] in matches else matches[0]
    if target.get("job"):
        raise ValueError("请等待当前视频任务完成后再剪辑")
    if edited_titles == titles and edited_cutaways == cutaways:
        return {"nodes":[],"text":"剪辑设置与所选版本相同。"}
    timeline.update(titles=edited_titles,cutaways=edited_cutaways)
    spec = copy.deepcopy(timeline)
    for clip in spec["clips"]:
        if clip.get("remake_shot"):
            clip["remake_shot"]["node"] = clip.get("node")
    s.host.require_media(user,s.host.media_references(spec))
    recipe.update(titles=edited_titles,cutaways=edited_cutaways,timeline=timeline)
    _, generation_recipe, data, inputs = video_edit_snapshot(s,run,board,target,source_index)
    if not generation_recipe and not video.get("node_data"):
        data = target.get("data",{})
    if not generation_recipe and not isinstance(video.get("input_edges"),list):
        inputs = [edge for edge in board.get("edges",[]) if edge.get("to")==target["id"]]
    mode = "补画面剪辑" if editing_cutaways else "标题剪辑"
    label = target["name"] + " · " + mode
    await s.begin_generation(run,cid,"video",1,{"label":label,"node":target["id"],"spec":spec,"ref":selected["ref"]},
                             target_id=target["id"])
    result = await s.response(s.host.render_film,user,{"board":run["board_id"],"spec":spec,"label":label,
        "request_key":cid,"target":{"node":target["id"],"ref":selected["ref"]}})
    return await s.wait_submitted_jobs(run,user,cid,{"ids":result["ids"],"name":label,
        "prompt":video.get("prompt",""),"source":"film","kind":"video","target_id":target["id"],
        "version_history":{"input_edges":inputs,"node_data":data,"mode":mode,"film_recipe":recipe}})


async def generate_broll(s, run, user, cid, args):
    bid, nid = run["board_id"], args["node_id"]
    board = s.board(user,bid)
    node = next((item for item in board["nodes"] if item["id"]==nid and item.get("type") in ("image","video")),None)
    if not node:
        raise ValueError("请选择画布上的图片或视频")
    versions = node.get("versions",[])
    pinned = run["data"].get("bindings",{}).get(nid)
    if args.get("version") is not None:
        index = args["version"]-1
    elif pinned:
        index = next((i for i,version in enumerate(versions) if version.get("ref")==pinned),-1)
    else:
        index = node.get("cur",-1)
    if not 0 <= index < len(versions) or not versions[index].get("ref"):
        raise ValueError("所选图片或视频版本已移除或尚未完成")
    ref = versions[index]["ref"]
    source = {"board":bid,"node":nid,"ref":ref}
    _, _, _, duration = await s.host.broll_source(user,source)
    recipe = broll.recipe(args,node["type"],duration)
    mode = recipe["mode"]
    label = f"{(node.get('name') or '来源素材')[:30]} · B-roll"
    details = [f"来源版本 {index+1} · {recipe['start']:g}–{recipe['end']:g} 秒",
               "深色卡片" if recipe["style"]=="card" else "简洁样式"]
    if mode == "motion":
        details[1] = "推进" if recipe["direction"]=="in" else "拉远"
    if recipe.get("title"):
        details.append(recipe["title"])
    details.extend(recipe.get("lines",[]))
    details.extend(f"{bar['label']}  {bar['value']:g}" for bar in recipe.get("bars",[]))
    await s.begin_generation(run,cid,"video",1,{**source,"label":label,"prompt":"\n".join(details),
        "mode":broll.MODES[mode],"duration":recipe.get("duration",duration)},force_confirmation=True)
    result = await s.response(s.host.render_broll,user,{**source,"recipe":recipe,"request_key":cid})
    return await s.wait_submitted_jobs(run,user,cid,{"ids":result["ids"],"name":label,"kind":"video","source":"broll",
        "prompt":recipe.get("title") or "\n".join(recipe.get("lines",[])),
        "broll_source":{"node":nid,"ref":ref},"broll_recipe":result["recipe"]})


def read_object_settings(s, run, user, args):
    board, node = video_node(s, run, user, args["node_id"])
    current, recipe, data, incoming = video_edit_snapshot(s,run,board,node,args.get("version"))
    plan = data.get("object_edit") or recipe.get("object_edit")
    source_edge = next((e for e in incoming if e.get("relation")=="video_ref" and e.get("segment_edit")), None)
    if not plan or source_edge is None:
        raise ValueError("这个视频版本没有已保存的物体选区，请先在画布框选并创建物体编辑节点")
    source, _ = reference_version(s,run,user,edge=source_edge,kind="clip")
    source.update({key:source_edge[key] for key in ("start","end") if key in source_edge})
    return {"node_id":node["id"],"version":next((i for i,v in enumerate(node.get("versions",[]),1) if v is current),None),
            "source":source,"object_edit":object_edit.validate(plan),"text":"已读取原片范围、框选和替换参考。"}


def object_replacement(s, run, user, selection):
    nid, mid, index = selection.get("node_id"), selection.get("memory_id"), selection.get("version")
    if bool(nid) == bool(mid) or (mid and index is not None):
        raise ValueError("请选择一个图片节点及版本，或一项资产")
    if mid:
        try:
            asset = s.app["creative_memory"].get(user,mid,run["board_id"])
        except web.HTTPException:
            raise ValueError("该参考资产不存在或不可访问") from None
        ref, label = asset.get("ref"), asset.get("name")
    elif index is None:
        node, version = s.source(run,user,nid)
        ref, label = version["ref"], node.get("name")
    else:
        board = s.board(user,run["board_id"])
        node = next((n for n in board["nodes"] if n["id"]==nid and n["type"]=="image"),None)
        versions = node.get("versions",[]) if node else []
        if not 1 <= index <= len(versions):
            raise ValueError("所选参考图版本已移除")
        ref, label = versions[index-1]["ref"], node.get("name")
    if not ref or not ref.lower().endswith((".png",".jpg",".jpeg",".webp")):
        raise ValueError("替换参考须为图片")
    return {"replacement_ref":ref,"replacement_name":label}


def update_object_plan(s, run, user, plan, changes):
    merged = {**(plan or {}), **{key:changes[key] for key in ("action","at","box") if key in changes}}
    if "replacement" in changes:
        if changes.get("action") == "remove":
            raise ValueError("移除物体无需指定替换参考")
        merged.update(action="replace",**object_replacement(s,run,user,changes["replacement"]))
    return object_edit.validate(merged)


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
               "quality": data.get("quality", "hd"), "turbo": bool(data.get("turbo", True)), "seed": data.get("seed", -1),
               "count": 1, "sound": data.get("sound", ""), "music": data.get("music", ""), "mode": "fl2v"}
    if planned:
        payload["planned"] = True
    return payload


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


async def split_long_remake_shot(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    previous = video_remake.load(key)
    session = await apply_remake_action(s, user, nid, key, {
        "action": "split_long_shot", "shot": args["shot"] - 1, "cut_revision": args["cut_revision"],
    })
    result = remake_status(s.host, nid, key, session)
    first = session["selected_shot"]
    count = len(session["shots"]) - len(previous["shots"]) + 1
    children = result["shots"][first:first + count]
    result["remake"].update(shot_number=children[0]["number"], shot_start=children[0]["start"])
    result["split_shots"] = [{field: shot[field] for field in ("number", "start", "end")} for shot in children]
    result["can_undo_cut"] = session["can_undo_cut"]
    result["text"] = (f"原第 {args['shot']} 镜已拆成 {count} 个镜头，"
                      f"新编号为第 {children[0]['number']} 至 {children[-1]['number']} 镜。"
                      + result["text"])
    return result


async def analyze_remake(s, run, user, nid, *, retry=False):
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        session = await apply_remake_action(s, user, nid, key, {"action": "analyze"})
        return remake_status(s.host, nid, key, session)
    missing = sum(bool(shot.get("analysis_missing")) for shot in session["shots"])
    if retry and missing:
        session = await apply_remake_action(s, user, nid, key, {
            "action": "retry_analysis", "cut_revision": session.get("cut_revision", 0),
        })
    result = remake_status(s.host, nid, key, session)
    recovered = missing - len(result["missing_analysis_shots"])
    if recovered:
        result["text"] = f"已补充 {recovered} 个镜头的视觉分析。" + result["text"]
    return result


def plan_remake(s, run, user, args, cid):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        raise ValueError("请先分析原片")
    asset = s.app["creative_memory"].get(user, args["asset_id"], key[1])
    reference = asset.get("character_views", {}).get("main") or asset.get("ref")
    if asset["kind"] != "character" or not reference:
        raise ValueError("请选择已有参考图的角色资产")
    person = args["person"].strip()
    if not person or len(set(args["shots"])) != len(args["shots"]):
        raise ValueError("请指定原片人物和不重复的镜头")
    mapping = {"source":person, "asset":asset["id"]}
    planned = []
    for number in args["shots"]:
        if not 1 <= number <= len(session["shots"]):
            raise ValueError("请选择存在的镜头")
        shot = session["shots"][number - 1]
        frame_key = video_remake.start_preview_key(shot, mapping)
        selection = video_remake.person_selection(shot["frames"][frame_key], mapping) if frame_key else None
        ready = not shot.get("keep_original") and selection and selection.get("source_person") == person
        planned.append({"shot":number, "start":shot["start"], "selection_ready":bool(ready), "keep":bool(shot.get("keep_original"))})
    if run.get("id"):
        run["data"]["remake_plan_pending"] = True
        s.update(run)
    return {"text":"勾选要处理的镜头，再确认提交换角计划。", "remake":{"node_id":nid,"source_ref":key[3]},
            "remake_plan":{"id":cid, "board":key[1], "cut_revision":session.get("cut_revision", 0), "asset":asset["id"],
                           "asset_name":asset["name"], "reference":reference, "person":person, "look":args.get("look", ""),
                           "shots":planned}}


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
        await s.begin_generation(run,cid,"image",len(requests),{"label":"换角预览","node":nid,"args":args,"shots":requests})
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
    if submitted:
        frames_by_shot = {item["shot"]: item["frame"] for item in requests}
        targets = []
        for index in submitted:
            frame = frames_by_shot[index]
            job = session["shots"][index]["frames"][frame]["previews"][-1]["job"]
            targets.append({"shot": index, "frame": frame, "job": job})
        return await wait_remake_generation(s, run, user, cid, key, nid, "preview", targets, result["preview"])
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
    motion_provider = args.get("motion_provider")
    try:
        fps = s.host.film.FPS
        ref, approved, entry_tick = video_remake.shot_start(shot, mapping, fps)
        guides = video_remake.shot_guides(shot, approved, fps, mapping, entry_tick)
        if motion_provider:
            if not any(p["id"] == motion_provider for p in video_remake.motion_providers(s.host)):
                raise ValueError("所选视频服务未配置深度参考，请重新读取视频重制状态")
            ticks = round(shot["end"] * fps) - round(shot["start"] * fps)
            video_remake.depth_motion(user, s.host, key, shot, ref, shot["frames"]["first"], ticks, entry_tick, guides)
    except web.HTTPException as error:
        raise ValueError(json.loads(error.text)["error"]) from None
    if approved["job"] != args["first_job"]:
        raise ValueError("已采用的起始帧已变更，请重新读取视频重制状态")
    await s.begin_generation(run,cid,"video",1,{"label":f"重制镜头 {index+1}","node":nid,"args":args,
                                              "ref":ref,"duration":shot["end"]-shot["start"],"provider":motion_provider})
    if motion_provider:
        session = await apply_remake_action(s, user, nid, key, {
            "action":"generate_depth_video", "shot":index, "first_job":approved["job"], "provider":motion_provider,
            "motion":args.get("motion", ""), "cut_revision":args["cut_revision"],
        })
        job = session["shots"][index]["videos"][-1]["job"]
        return await wait_remake_generation(s, run, user, cid, key, nid, "video",
                                            [{"shot":index,"job":job}], {"shot":index + 1,"submitted":True})
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
        return await wait_remake_generation(s, run, user, cid, key, nid, "video",
                                            [{"shot": index, "job": job}], result["video"])
    elif outcome["failed"]:
        result["video"]["error"] = outcome["failed"][0]["error"]
        result["text"] = f"镜头 {index + 1} 提交失败。{result['video']['error']}"
    else:
        result["text"] = f"镜头 {index + 1} 正在处理或已有匹配的视频版本。"
    return result


async def wait_remake_generation(s, run, user, cid, key, nid, kind, targets, outcome):
    return await s.wait_submitted_jobs(run, user, cid, {
        "ids": [target["job"] for target in targets],
        "remake_generation": {"key": key, "node_id": nid, "kind": kind, "targets": targets, "outcome": outcome},
    })


def finish_remake_generation(s, run, user, info, states):
    key = authorized_remake_key(s, run, user, info)
    session = video_remake.load(key)
    result = remake_status(s.host, info["node_id"], key, session)
    kind = info["kind"]
    outcome = copy.deepcopy(info["outcome"])
    completed = []
    failed = outcome.setdefault("failed", [])
    shots = (session or {}).get("shots", [])
    for target in info["targets"]:
        index, job = target["shot"], target["job"]
        shot = shots[index] if index < len(shots) else {}
        frame = shot.get("frames", {}).get(target.get("frame"), {})
        versions = frame.get("previews", []) if kind == "preview" else shot.get("videos", [])
        if video_remake.completed(versions, job):
            completed.append(target)
        else:
            failed.append({"shot": index + 1, "error": states[job].get("error") or "画面或剪辑点已更新，请在重制工作区核对"})
    result[kind] = outcome
    outcome["completed"] = [item["shot"] + 1 for item in completed] if kind == "preview" else bool(completed)
    if completed:
        target = completed[0]
        index = target["shot"]
        result["remake"].update(shot_number=index + 1, shot_start=shots[index]["start"])
        if kind == "preview":
            result["remake"].update(frame=target["frame"], preview_job=target["job"])
        else:
            result["remake"]["video_job"] = target["job"]
        result["text"] = f"{len(completed)} 个换角预览已生成，可打开审核。" if kind == "preview" else f"镜头 {index + 1} 的重制视频已生成，可打开审核。"
        if failed:
            result["text"] += f"另有 {len(failed)} 个镜头待处理。"
    else:
        result["error"] = failed[0]["error"]
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


def authorized_remake_key(s, run, user, info):
    key = tuple(info["key"])
    if key[:2] != (user["id"], run["board_id"]):
        raise ValueError("无权读取该视频重制任务")
    s.board(user, key[1])
    return key


def finish_remake_export(s, run, user, pending, state):
    info = pending["remake_export"]
    key = authorized_remake_key(s, run, user, info)
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
    out = video_remake.available_export(host, session.get("export")) or {}
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
             "review_issue": video_remake.video_start_issue(shot, version, mapping)
                             if in_scope or version.get("mode") == "combined" else "该镜头不在替换范围"}
            for index, version in enumerate(shot.get("videos", []))
            if version["state"] == "done" and version.get("ref")
            and (version.get("mode") == "combined" or video_remake.matches_mapping(version, mapping))
        ]
    issues = {item["shot"]: item["error"] for item in review["remaining"]}
    durations = video_remake.default_remake_durations(host)
    for index, shot in enumerate(session["shots"]):
        reviewed, issue = video_remake.export_choice(shot, mapping, index)
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
        limit = video_remake.shot_video_limit(host,shot,mapping,durations)
        fps = host.film.FPS
        ticks = round(shot["end"] * fps) - round(shot["start"] * fps)
        result["shots"].append({
            "number": index + 1, "start": shot["start"], "end": shot["end"],
            "max_source_seconds":limit,"requires_split":ticks > limit * fps,
            "suggested_people": [name[:60] for name in people[:24] if isinstance(name, str)] if isinstance(people, list) else [],
            "keep_original": bool(shot.get("keep_original") or
                                  mapping and index not in mapping["shots"] and not reviewed and not issue),
            "start_frame_selected": selected,
            "position_suggested": bool(mapping and not selected and not video_remake.person_absent(frame, mapping) and
                                       hint.get("point") and hint.get("source") == mapping["source"] and
                                       hint.get("look") == mapping.get("look", "")),
            "start_frame_approved": frame_approved,
            "approved_start_job": adopted_frame["job"] if frame_approved else None,
            "depth_ready": bool(shot.get("depth", {}).get("ref") and shot["depth"]["state"] == "done"),
            "video_available": any(item.get("ref") and video_remake.matches_mapping(item, mapping) for item in videos),
            "pending": video_remake.pending(frames + videos), "review_issue": issues.get(index),
        })
    count = len(result["shots"])
    missing = [index for index, shot in enumerate(session["shots"], 1) if shot.get("analysis_missing")]
    warning = session.get("warning") or None
    text = f"共 {count} 个镜头，{len(issues)} 个待审核。"
    if warning:
        text += warning
    return {**result, "analyzed": True, "text": text, "missing_analysis_shots": missing,
            "cut_revision": session.get("cut_revision", 0),
            "motion_providers": video_remake.motion_providers(host),
            "source_people": session.get("source_people", []), "warning": warning,
            "mapping": {"source": mapping["source"], "asset": mapping.get("asset_name"), "asset_id": mapping["asset"],
                        "shots": [index + 1 for index in mapping["shots"]]} if mapping else None,
            "adopted": review["adopted"], "can_export": bool(review["adopted"] and not issues and
                                                          out.get("state") not in ("queued", "running")),
            "export_state": "stale" if out.get("stale") else out.get("state"),
            "export_ref": out.get("ref") if out.get("state") == "done" else None}


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
