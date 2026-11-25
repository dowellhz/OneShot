"""Validate and resolve video generation's pinned media inputs."""

import asyncio
import json
import re

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta, can_edit
from oneshot.editing import image_editor
from oneshot.editing import previs
from oneshot.editing import render as film
from oneshot.generation import motion_reference
from oneshot.generation import tools
from oneshot.memory import creative_memory
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


def has_asset_media(raw):
    return any(isinstance(entry,dict) and entry.get("memory_id") for key in ("audio_refs","video_refs")
               for entry in (raw.get(key) if isinstance(raw.get(key),list) else []))


def is_asset_media(raw, entry):
    if not isinstance(entry,dict) or not entry.get("memory_id"):
        return False
    return any(asset["id"] == entry["memory_id"] and any(item.get("ref") == entry.get("ref")
               for item in asset.get("references",[])) for asset in raw.get("memory_used",[]))


async def resolve_audio_refs(user, raw, model, *, provider_kind="ark"):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["audio_refs"]
    if not isinstance(entries, list) or len(entries) > limit:
        raise http_errors.bad(f"此服务最多可采用 {limit} 段参考音频")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        return_error = json.dumps({"error":"需要画布编辑权限才能提交参考音频"}, ensure_ascii=False)
        raise web.HTTPForbidden(text=return_error, content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "audio"}
    result = []
    for entry in entries:
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise http_errors.bad("音频参考版本已移除或尚未保存，请重新选择")
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
        except ValueError:
            raise http_errors.bad("音频素材格式无效") from None
        if path.suffix.lower() not in media_routes.AUDIO_MEDIA_EXT:
            raise http_errors.bad("请选择音频文件作为参考")
        media_routes.require_media(user, {ref})
        try:
            seconds = await asyncio.to_thread(film.audio_duration, path)
        except (OSError, ValueError):
            raise http_errors.bad("音频文件无法读取") from None
        try:
            start = image_editor.number(entry.get("start"),0,seconds,"音频参考入点",0)
            end = min(seconds,image_editor.number(entry.get("end"),start,seconds+.025,"音频参考出点",seconds))
        except ValueError as exc:
            raise http_errors.bad(str(exc)) from None
        duration = end-start
        if not 2-1e-8 <= duration <= max_seconds+.05:
            raise http_errors.bad(f"每段参考音频须为 2 到 {max_seconds} 秒")
        duration = min(duration,max_seconds)
        result.append((path,start,duration))
        entry.update(start=start,end=round(start+duration,5))
    if sum(seconds for _,_,seconds in result) > max_seconds + .05:
        raise http_errors.bad(f"参考音频总时长不能超过 {max_seconds} 秒")
    if provider_kind == "ark" and max_seconds == 15 and not raw.get("images") and not raw.get("previs_guide") and not raw.get("video_refs"):
        raise http_errors.bad("此服务需要同时连入参考图或参考视频")
    return result


async def resolve_previs_guide(user, raw):
    guide = raw["previs_guide"]
    if not isinstance(guide, dict):
        raise http_errors.bad("白模动作参考格式无效")
    ref, nid = guide.get("ref"), guide.get("node_id")
    if (not isinstance(ref, str) or not re.fullmatch(r"output:h3studio/previs_\d{8}_\d{6}_[a-f0-9]{5}\.mp4", ref)
            or not isinstance(nid, str)):
        raise http_errors.bad("请选择已渲染的白模预演版本")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交白模动作参考"}, ensure_ascii=False),
                                content_type="application/json")
    node = next((n for n in board.get("nodes", []) if n.get("id") == nid and n.get("type") == "video"), None)
    if not node or not any(v.get("source") == "previs" and v.get("ref") == ref for v in node.get("versions", [])):
        raise http_errors.bad("白模预演版本已移除或尚未保存，请重新选择")
    media_routes.require_media(user, {ref})
    path = tools.ref_path(config.COMFY_DIR, ref)
    try:
        w, h, seconds, _ = await asyncio.to_thread(film.probe, path, display=False)
        ticks = round(seconds * film.FPS)
    except (OSError, ValueError, IndexError):
        raise http_errors.bad("白模预演文件无法读取，请重新渲染") from None
    if not motion_reference.eligible(w, h, ticks) or ticks > previs.MAX_SECONDS * film.FPS:
        raise http_errors.bad("白模预演时长或画幅超出动作参考范围")
    return {"path":path, "ticks":ticks, "source":"previs"}


async def resolve_video_refs(user, raw, model, motion):
    limit, max_seconds = motion_reference.av_limits(model)
    entries = raw["video_refs"]
    if not isinstance(entries, list) or len(entries) + bool(motion) > limit:
        raise http_errors.bad(f"此服务最多可采用 {limit} 段参考视频（包含白模）")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(user, board):
        raise web.HTTPForbidden(text=json.dumps({"error":"需要画布编辑权限才能提交参考视频"}, ensure_ascii=False),
                                content_type="application/json")
    nodes = {n["id"]:n for n in board.get("nodes", []) if n.get("type") == "video"}
    clips = []
    for index, entry in enumerate(entries):
        ref, nid = (entry.get("ref"), entry.get("node_id")) if isinstance(entry, dict) else (None, None)
        if (not isinstance(ref, str) or not (is_asset_media(raw,entry) or isinstance(nid,str) and
                any(v.get("ref") == ref for v in nodes.get(nid, {}).get("versions", [])))):
            raise http_errors.bad("参考视频版本已移除或尚未保存，请重新选择")
        media_routes.require_media(user, {ref})
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
            if path.suffix.lower() not in tools.VIDEO_EXT:
                raise ValueError()
            w, h, seconds, _ = await asyncio.to_thread(film.probe, path)
            if not w or not h or not .4 <= w / h <= 2.5:
                raise ValueError()
        except (OSError, ValueError, IndexError):
            raise http_errors.bad("参考视频无法读取，或宽高比超出 0.4 到 2.5") from None
        extension = raw.get("extension") if index==0 else None
        edit = raw.get("segment_edit") and index==0
        default_start = max(0,seconds-4) if extension=="after" else 0
        try:
            start = image_editor.number(entry.get("start"), 0, seconds, "视频参考入点", default_start)
            default_end = seconds if extension=="after" or is_asset_media(raw,entry) else min(seconds,start+(4 if extension=="before" else max_seconds))
            end = min(seconds, image_editor.number(entry.get("end"), start, seconds + .025, "视频参考出点",
                                                   default_end))
        except ValueError as exc:
            raise http_errors.bad(str(exc)) from None
        if (extension=="before" and start > .025) or (extension=="after" and seconds-end > .025):
            raise http_errors.bad("续拍参考须包含原片接点，请保留片头或片尾")
        if extension=="before":
            start=0
        elif extension=="after":
            end=seconds
        if edit:
            start=round(start*film.FPS)/film.FPS
            end=min(seconds,round(end*film.FPS)/film.FPS)
        minimum = 4 if edit else 2
        ticks = round((end-start) * film.FPS)
        if not film.FPS * minimum <= ticks <= max_seconds * film.FPS:
            if is_asset_media(raw,entry):
                raise http_errors.bad(f"资产「{entry['name']}」的参考视频须为 {minimum} 到 {max_seconds} 秒")
            raise http_errors.bad(f"待编辑片段须为 {minimum} 到 {max_seconds} 秒" if edit else f"每段参考视频须为 2 到 {max_seconds} 秒")
        clips.append({"path":path, "start":start, "ticks":ticks, "ratio":w / h, "source_seconds":seconds})
    if sum(clip["ticks"] for clip in clips) + (motion["ticks"] if motion else 0) > max_seconds * film.FPS:
        raise http_errors.bad(f"参考视频总时长不能超过 {max_seconds} 秒（包含白模）")
    for entry, clip in zip(entries, clips):
        entry.update(start=clip["start"], end=min(clip["source_seconds"],round(clip["start"]+clip["ticks"]/film.FPS, 5)))
    if raw.get("segment_edit"):
        entries[0]["source_seconds"] = clips[0]["source_seconds"]
    return clips


def resolve_video_reference_images(user, raw):
    images = raw.get("images") or []
    if not isinstance(images,list) or any(not isinstance(image,dict) or not isinstance(image.get("ref"),str)
                                          for image in images):
        raise http_errors.bad("请选择可读取的参考图")
    refs = [image["ref"] for image in images]
    media_routes.require_media(user,set(refs))
    try:
        paths = [tools.ref_path(config.COMFY_DIR,ref) for ref in refs]
    except ValueError:
        raise http_errors.bad("请选择可读取的参考图") from None
    if any(path.suffix.lower() not in creative_memory.IMAGE_EXT or not path.is_file() for path in paths):
        raise http_errors.bad("参考图无法读取，请重新选择")
    return paths


def ensure_reference_media_count(raw, provider_kind, model, object_plan):
    limit = motion_reference.image_limit(model)
    extra = (1 + bool(object_plan.get("replacement_ref"))) if object_plan else 0
    if len(raw.get("images") or []) + extra > limit:
        raise http_errors.bad(f"此服务最多支持 {limit} 张有效参考图")
    if provider_kind == "minimax":
        total = sum(len(raw.get(key) or []) for key in ("images","audio_refs","video_refs")) + bool(raw.get("previs_guide"))
        if total > 12:
            raise http_errors.bad("云端 H3 的图片、视频和音频参考合计最多 12 项")
