"""Edit titles and cutaways on the pinned video timeline."""
from __future__ import annotations

import asyncio
import copy
import math

from aiohttp import web

from oneshot.assistant.video_reference_inputs import reference_version, video_node
from oneshot.assistant.video_reference_plan import video_edit_snapshot
from oneshot.canvas import workflow_review
from oneshot.editing import broll


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
