"""Validate audio versions and expose waveform and trim operations."""

import asyncio
import hashlib
import json
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing import audio_waveform
from oneshot.editing import render as film
from oneshot.editing import timeline_routes
from oneshot.generation import tools
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


def audio_node_source(req, payload):
    if not isinstance(payload, dict) or not all(isinstance(payload.get(k), str) for k in ("board", "node", "ref")):
        raise http_errors.bad("请选择画布上的音频版本")
    board = board_meta(canvas_routes.board_path(payload["board"]))
    if not board or not can_edit(req["user"], board):
        raise web.HTTPForbidden()
    source = next((n for n in board.get("nodes", []) if n["id"] == payload["node"] and n["type"] == "audio"), None)
    if not source or not any(v.get("ref") == payload["ref"] for v in source.get("versions", [])):
        raise http_errors.bad("音频版本已移除，请重新选择")
    media_routes.require_media(req["user"], {payload["ref"]})
    return payload["ref"]


async def get_audio_waveform(req):
    ref = req.query.get("ref","")
    try:
        source = tools.ref_path(config.COMFY_DIR,ref)
    except ValueError:
        raise web.HTTPNotFound() from None
    if source.suffix.lower() not in media_routes.AUDIO_MEDIA_EXT or not source.is_file() or not media_routes.can_read_media(req["user"],ref):
        raise web.HTTPNotFound()
    try:
        result = await asyncio.to_thread(audio_waveform.waveform,source)
    except (OSError,ValueError,TypeError) as error:
        raise http_errors.bad("暂时无法读取此音频的波形") from error
    return web.json_response(result,headers={"Cache-Control":"private, no-cache"})


async def audio_cut(req):
    payload = await req.json()
    ref = audio_node_source(req,payload)
    entries = payload.get("ranges")
    if not isinstance(entries,list) or not 1 <= len(entries) <= film.CAPTION_LIMIT:
        raise http_errors.bad("请至少选择一段要保留的音频")
    ranges = []
    previous = 0
    for entry in entries:
        start, end = (entry.get("start"),entry.get("end")) if isinstance(entry,dict) else (None,None)
        if type(start) not in (int,float) or type(end) not in (int,float) or not 0 <= previous <= start < end <= 86400:
            raise http_errors.bad("音频区间须按时间顺序排列，且不能重叠")
        ranges.append((float(start),float(end)))
        previous = end
    if ranges[-1][1] - ranges[0][0] > 90.001:
        raise http_errors.bad("每次最多剪辑 90 秒的转写区间")
    key = hashlib.sha256(json.dumps([req["user"]["id"],ref,ranges]).encode()).hexdigest()[:24]
    target = f"output:h3studio/audio_cut_{key}.wav"
    try:
        async with timeline_routes.RENDER_LOCK:
            result = await asyncio.to_thread(film.cut_audio_ranges,config.COMFY_DIR,ref,ranges,target)
    except (KeyError,TypeError,ValueError,OSError,OverflowError) as error:
        raise http_errors.bad("无法剪辑音频：" + str(error)) from None
    media_routes.grant_media(req["user"], target)
    result["url"] = "/media?ref=" + quote(target,safe="")
    return web.json_response(result)
