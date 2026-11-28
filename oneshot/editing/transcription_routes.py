"""Transcribe recordings and create captions from pinned clips."""

import asyncio
import math
from pathlib import Path

from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_edit
from oneshot.editing.audio_edit_routes import audio_node_source
from oneshot.editing import render as film
from oneshot.editing.render_timeline_audio import SilentTrackError
from oneshot.providers import catalog as providers
from oneshot.web import auth
from oneshot.web import http as http_errors


ASR_AUDIO_LIMIT = 8 * 1024 * 1024


ASR_AUDIO_TYPES = {
    ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp4": "audio/mp4",
    ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".flac": "audio/flac",
}


def is_transcription_audio(header, extension):
    if extension == ".wav":
        return header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    if extension in (".m4a", ".mp4"):
        return header[4:8] == b"ftyp"
    if extension == ".mp3":
        return header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224)
    return header.startswith({".webm": b"\x1aE\xdf\xa3", ".ogg": b"OggS", ".flac": b"fLaC"}[extension])


async def transcription_status(_):
    return web.json_response({"available": bool(providers.routes("asr"))})


async def transcribe_audio(req):
    configured = providers.routes("asr")
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    if req.content_type != "multipart/form-data":
        raise http_errors.bad("请选择音频文件")
    try:
        part = await (await req.multipart()).next()
        if part is None or part.name != "file" or not part.filename:
            raise http_errors.bad("请选择音频文件")
        extension = Path(part.filename).suffix.lower()
        content_type = ASR_AUDIO_TYPES.get(extension)
        if content_type is None:
            raise http_errors.bad("不支持的音频格式")
        audio = bytearray()
        while chunk := await part.read_chunk(64 * 1024):
            audio.extend(chunk)
            if len(audio) > ASR_AUDIO_LIMIT:
                return auth.err(413, "音频文件不能超过 8 MB")
    except (ValueError, AssertionError):
        raise http_errors.bad("无法读取上传的音频")
    if not is_transcription_audio(audio, extension):
        raise http_errors.bad("音频内容与文件格式不符")
    recording = bytes(audio)
    if req.query.get("preview") == "1":
        try:
            recording = await asyncio.to_thread(film.recording_preview_wav, recording)
        except ValueError as error:
            raise http_errors.bad(str(error)) from None
        extension, content_type = ".wav", "audio/wav"
    transcript = await plain_transcript(req, configured, recording, extension, content_type)
    if transcript is not None:
        return web.json_response({"text": transcript})
    return auth.err(502, "语音转写服务暂时不可用，请稍后重试")


async def plain_transcript(req, configured, audio, extension, content_type):
    for route in configured:
        try:
            return await providers.transcribe(req.app["http"], route["provider"], route["model"],
                                              audio, extension, content_type)
        except providers.ProviderError:
            continue


async def audio_transcript(req):
    payload = await req.json()
    audio_node_source(req,payload)
    configured = providers.routes("asr")
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    clip = {k:payload[k] for k in ("ref", "in", "out") if k in payload}
    try:
        wav, start, end = await asyncio.to_thread(film.transcription_wav, config.COMFY_DIR, clip, audio_only=True)
    except (KeyError, TypeError, ValueError, OSError, OverflowError) as error:
        raise http_errors.bad("无法读取音频：" + str(error)) from None
    captions = await timed_transcript(req, configured, wav, start, end)
    text = "\n".join(cue["text"] for cue in captions) if captions is not None else (
        await plain_transcript(req, configured, wav, ".wav", "audio/wav"))
    if text is None:
        return auth.err(502, "语音转写服务暂时不可用，请稍后重试")
    return web.json_response({"text":text,"captions":captions or [],"start":start,"end":end})


async def video_captions(req):
    raw = await req.json()
    if not isinstance(raw, dict) or not isinstance(raw.get("ref"), str):
        raise http_errors.bad("请选择要识别字幕的视频片段")
    board = board_meta(canvas_routes.board_path(raw.get("board")))
    if not board or not can_edit(req["user"], board):
        raise web.HTTPForbidden()
    configured = providers.routes("asr")
    allow_silence = raw.get("allow_silence") is True
    if not configured and not allow_silence:
        return auth.err(503, "请在控制台配置语音转写服务")
    clip = {k:raw[k] for k in ("ref", "in", "out", "audio_ref", "audio_start") if k in raw}
    clip["kind"] = "video"
    try:
        wav, start, end = await asyncio.to_thread(film.transcription_wav, config.COMFY_DIR, clip)
    except SilentTrackError as error:
        if allow_silence:
            return web.json_response({"captions": [], "silent": True})
        raise http_errors.bad("无法提取视频原声：" + str(error)) from None
    except (KeyError, TypeError, ValueError, OSError, OverflowError) as error:
        raise http_errors.bad("无法提取视频原声：" + str(error)) from None
    if not configured:
        return auth.err(503, "请在控制台配置语音转写服务")
    captions = await timed_transcript(req, configured, wav, start, end)
    if captions is not None:
        return web.json_response({"captions":captions})
    return auth.err(502, "转写服务暂时不可用，或不支持返回字幕时间码")


async def timed_transcript(req, configured, wav, start, end):
    for route in configured:
        try:
            segments = await providers.transcribe(req.app["http"], route["provider"], route["model"],
                                                   wav, ".wav", "audio/wav", timed=True)
        except providers.ProviderError:
            continue
        captions = []
        for segment in segments[:film.CAPTION_LIMIT]:
            if not isinstance(segment, dict):
                continue
            a, b, caption = (segment.get(key) for key in ("start", "end", "text"))
            if (type(a) not in (int,float) or type(b) not in (int,float) or not -math.inf < a < b < math.inf or
                    not isinstance(caption, str) or not caption.strip()):
                continue
            captions.append({"start":round(max(start,start+a),3), "end":round(min(end,start+b),3), "text":caption.strip()[:500]})
        timed = []
        for cue in sorted(captions, key=lambda item: item["start"]):
            if timed:
                cue["start"] = max(cue["start"], timed[-1]["end"])
            if cue["end"] > cue["start"]:
                timed.append(cue)
        if timed or not segments:
            return timed
