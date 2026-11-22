"""Create, edit and render the same saved playlists the canvas uses."""
from __future__ import annotations

import asyncio
import copy

import agent_video
import render as film

NAMES = {"video_playlist_create", "video_playlist_read", "video_playlist_edit", "video_playlist_export"}


def register(tool, prop, node):
    number = prop("integer",minimum=1)
    ends = {key:prop("number",minimum=0) for key in ("in","out")}
    source = prop("object",properties={"node_id":node,"version":number,**ends},required=["node_id"],additionalProperties=False)
    change = prop("object",properties={"action":prop("string",enum=["add","trim","remove"]),
        "number":number,"source":source,**ends},required=["action"],additionalProperties=False)
    selection = {"node_id":node,"revision":prop("string",maxLength=64)}
    tool("video_playlist_create", "按给出的顺序将画布视频保存成独立播放列表。可指定1起算的版本及源视频入点、出点秒数。用户要求空列表时传空数组。不渲染。", {
        "name":node,"clips":prop("array",items=source,maxItems=60)},["clips"])
    tool("video_playlist_read", "读取画布上的播放列表，包括当前时间线、片段编号、源版本、出入点和编辑修订号。只读。", {"node_id":node},["node_id"])
    tool("video_playlist_edit", "保存播放列表编辑，不渲染。changes 可添加、裁剪或移除片段，trim 和 remove 用改动前的编号。add 给 source；trim 只给要改的入点或出点。order 如提供，给出 changes 处理后列表中每个编号的新顺序。", {
        **selection,"changes":prop("array",items=change,minItems=1,maxItems=60),
        "order":prop("array",items=number,minItems=1,maxItems=5000)},["node_id"])
    tool("video_playlist_export", "将已保存的播放列表渲染成一段视频，作为列表节点的新版本。只有用户要求导出或合并成片时才调用。",selection,["node_id"])


def playlist_node(board, nid):
    target = next((n for n in board["nodes"] if n["id"]==nid and n.get("type")=="video"),None)
    if not target or not target.get("data",{}).get("playlist"):
        raise ValueError("请选择画布上的播放列表")
    timeline = target["data"].get("film")
    if not isinstance(timeline,dict) or not isinstance(timeline.get("clips"),list):
        raise ValueError("播放列表时间线无法读取")
    return target,timeline


def summary(node, spec):
    return {"playlist_node":node["id"],"name":node["name"],"revision":film.playlist_revision(spec),
            "clips":agent_video.timeline_items(spec["clips"]),"version_count":len(node.get("versions",[]))}


def check_range(clip, length):
    start = clip.get("in",0)
    finish = clip["out"] if clip.get("out") is not None else length
    if not 0 <= start < finish <= length + 1e-6 or finish-start < 1/film.FPS-1e-6:
        raise ValueError(f"{clip.get('name') or '片段'}的剪辑范围须在原片的 0 到 {length:.3f} 秒内，并至少保留一帧")


async def video_length(s, user, ref):
    s.host.require_media(user,{ref})
    path = s.host.tools.ref_path(s.host.COMFY_DIR,ref)
    _, _, length, _ = await asyncio.to_thread(film.probe,path,display=False)
    return length


async def make_clip(s, run, user, source):
    selected, _ = agent_video.reference_version(s,run,user,selection=source,kind="clip")
    length = await video_length(s,user,selected["ref"])
    clip = {"node":selected["node_id"],"name":selected["name"],"ref":selected["ref"],"version":selected["version"],
            "kind":"video","media_seconds":length,"trans":"cut","volume":1,"subs":[],
            "in":source.get("in",0),"out":source.get("out"),"tight":True}
    check_range(clip,length)
    return clip


async def create(s, run, user, cid, args):
    clips = [await make_clip(s,run,user,source) for source in args["clips"]]
    spec = {"clips":clips,"aspect":"source","fit":"blur","subtitles":True,"sub_size":1,"titles":[],"cutaways":[],
            "bgm":None,"narration":[],"audio_clips":[],"cover":0}
    nid = agent_video.result_id(cid)

    def change(board):
        nodes = {n["id"]:n for n in board["nodes"]}
        for clip in clips:
            source = nodes.get(clip["node"])
            if not source or not any(v.get("ref")==clip["ref"] for v in source.get("versions",[])):
                raise ValueError("有源视频版本已被移除，请重新读取画布")
        x = max((n.get("x",0)+s.dimensions(n)[0] for n in nodes.values()),default=0)+100
        y = min((nodes[clip["node"]].get("y",100) for clip in clips),default=100)
        target = {"id":nid,"type":"video","name":(args.get("name") or "播放列表")[:40],"x":x,"y":y,
                  "data":{**agent_video.node_data({}),"playlist":True,"film":spec},"versions":[],"cur":-1,"job":None}
        board["nodes"].append(target)
        return {**summary(target,spec),"text":"已在画布保存播放列表，可以直接打开审片。"}

    return s.commit(run,user,cid,change)


async def edit(s, run, user, cid, args, target, saved, revision):
    if not args.get("changes") and not args.get("order"):
        raise ValueError("请提供要修改的片段或新的排列顺序")
    spec = copy.deepcopy(saved)
    clips = spec["clips"]
    original_count = len(clips)
    touched = set()
    new_sources = []
    for change in args.get("changes",[]):
        action, number = change["action"], change.get("number")
        if action == "add":
            if not change.get("source") or any(key in change for key in ("number","in","out")):
                raise ValueError("添加片段时请在 source 里指定源视频和剪辑范围")
            clip = await make_clip(s,run,user,change["source"])
            new_sources.append(clip)
            clips.append(clip)
            continue
        if number is None or not 1 <= number <= original_count or number in touched or "source" in change:
            raise ValueError("请用改动前的片段编号，每个编号在同次操作中只修改一次")
        touched.add(number)
        bounds = {key:change[key] for key in ("in","out") if key in change}
        if action == "remove":
            if bounds:
                raise ValueError("删除片段只需要编号")
            clips[number-1] = None
            continue
        if not bounds:
            raise ValueError("裁剪片段需要入点或出点")
        clip = clips[number-1]
        length = await video_length(s,user,clip["ref"])
        clip.update(bounds,media_seconds=length,tight=True)
        check_range(clip,length)
    clips = [clip for clip in clips if clip is not None]
    if order := args.get("order"):
        if sorted(order)!=list(range(1,len(clips)+1)):
            raise ValueError("新的顺序必须恰好包含改动后的每个片段编号")
        clips = [clips[i-1] for i in order]
    spec["clips"] = clips

    def change(board):
        current, timeline = playlist_node(board,target["id"])
        if film.playlist_revision(timeline) != revision:
            raise ValueError("播放列表已变化，请重新读取后修改")
        nodes = {n["id"]:n for n in board["nodes"]}
        for clip in new_sources:
            source = nodes.get(clip["node"])
            if not source or not any(v.get("ref")==clip["ref"] for v in source.get("versions",[])):
                raise ValueError("有源视频版本已被移除，请重新读取画布")
        current["data"]["film"] = spec
        return {**summary(current,spec),"text":"已保存播放列表的镜头顺序和区间。"}

    return s.commit(run,user,cid,change)


async def export(s, run, user, cid, target, spec, revision):
    if not spec["clips"]:
        raise ValueError("请先向列表添加视频")
    if target.get("job"):
        raise ValueError("此列表正在导出，请稍候")
    s.host.require_media(user,s.host.media_references(spec))
    spec = copy.deepcopy(spec)
    for clip in spec["clips"]:
        if clip.get("remake_shot"):
            clip["remake_shot"]["node"] = clip.get("node")
    await s.begin_generation(run,cid,"video",1,{"label":target["name"],"node":target["id"],"spec":spec},target_id=target["id"])
    for narration in spec.get("narration",[]):
        if (narration.get("text") or "").strip() and not narration.get("ref"):
            if s.stopped(run):
                raise ValueError("用户已停止本轮任务")
            speech = await s.response(s.host.tts_say,user,{k:narration.get(k) for k in ("text","voice","speed")})
            narration.update(ref=speech["ref"],seconds=speech.get("seconds"))
    if s.stopped(run):
        raise ValueError("用户已停止本轮任务")
    recipe = {"clips":spec["clips"],"titles":spec.get("titles",[]),"cutaways":spec.get("cutaways",[]),"audio":[
        *([{"ref":spec["remake_audio"],"role":"original_sound"}] if spec.get("remake_audio") else []),
        *([{"ref":spec["bgm"]["ref"],"role":"bgm"}] if spec.get("bgm",{}) and spec["bgm"].get("ref") else []),
        *[{"ref":n["ref"],"role":"narration","start":n.get("start")} for n in spec.get("narration",[]) if n.get("ref")],
        *[{**n,"role":"audio"} for n in spec.get("audio_clips",[]) if n.get("ref")]]}
    response = await s.response(s.host.render_film,user,{"board":run["board_id"],"spec":spec,"label":target["name"],
        "request_key":cid,"target":{"node":target["id"],"playlist_revision":revision}})
    return await s.wait_submitted_jobs(run,user,cid,{"ids":response["ids"],"name":target["name"]+" · 成片",
        "prompt":"","source":"film","kind":"video","target_id":target["id"],"playlist_node":target["id"],
        "version_history":{"film_recipe":recipe,"mode":"播放列表成片"}})


async def execute(s, run, user, cid, name, args):
    if name == "video_playlist_create":
        return await create(s,run,user,cid,args)
    target, timeline = playlist_node(s.board(user,run["board_id"]),args["node_id"])
    if name == "video_playlist_read":
        return summary(target,timeline)
    revision = film.playlist_revision(timeline)
    if args.get("revision") is not None and args["revision"]!=revision:
        raise ValueError("播放列表已变化，请重新读取后操作")
    if name == "video_playlist_edit":
        return await edit(s,run,user,cid,args,target,timeline,revision)
    return await export(s,run,user,cid,target,timeline,revision)
