"""Administrator controls for publishing official Noiz voices to OneShot."""

import asyncio
import io
import json
from pathlib import PurePath
import re
import time

import av
from aiohttp import BodyPartReader, web

from oneshot.providers import catalog, noiz
from oneshot.storage import db
from oneshot.web import http as http_errors

MAX_SAMPLE_BYTES = 10 * 1024 * 1024
MAX_VOICES = 30


def service(req):
    provider = catalog.get(req.match_info["pid"])
    if not provider or provider["kind"] != "noiz" or not provider["enabled"]:
        raise web.HTTPNotFound()
    return provider


def saved_voices(provider):
    return catalog.configured_voices("noiz", provider["config"].get("voices", ""))


def save_voice(req, provider, voice, *, remove=False):
    latest = service(req)
    if latest["secrets"] != provider["secrets"]:
        raise web.HTTPConflict(text="Noiz API Key changed")
    voices = {item["id"]: item["name"] for item in saved_voices(latest)}
    if remove:
        voices.pop(voice["id"], None)
    else:
        voices[voice["id"]] = re.sub(r"[,，\r\n]+", " ", voice["name"]).strip() or voice["id"]
    if len(voices) > MAX_VOICES:
        raise http_errors.bad("最多可在 OneShot 中启用 30 个音色")
    config = {**latest["config"], "voices": ",".join(f"{voice_id}={name}" for voice_id, name in voices.items())}
    db.run("UPDATE providers SET config=?, updated=? WHERE id=?", json.dumps(config, ensure_ascii=False),
           time.time(), latest["id"])
    return saved_voices({**latest, "config": config})


async def official_page(req, provider):
    kind = req.query.get("kind", "")
    page = req.query.get("page", "0")
    if kind not in ("custom", "built-in") or not re.fullmatch(r"[0-9]{1,4}", page):
        raise http_errors.bad("音色列表参数无效")
    try:
        return await noiz.list_voices(req.app["http"], provider, kind, int(page), req.query.get("q", "").strip()[:80])
    except catalog.ProviderError as error:
        raise http_errors.bad(str(error)) from error


async def list_voices(req):
    provider = service(req)
    result = {"saved": saved_voices(provider)}
    if req.query.get("kind"):
        result.update(await official_page(req, provider))
    return web.json_response(result)


async def publish_voice(req):
    provider = service(req)
    voice_id = req.match_info["voice"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", voice_id):
        raise http_errors.bad("音色 ID 无效")
    remove = req.method == "DELETE"
    if remove:
        voice = {"id": voice_id}
    else:
        page = await official_page(req, provider)
        voice = next((item for item in page["voices"] if item["id"] == voice_id), None)
        if not voice:
            raise http_errors.bad("此音色已不在列表中，请重新搜索")
    return web.json_response({"saved": save_voice(req, provider, voice, remove=remove)})


def validate_sample(audio: bytes, extension: str):
    formats = {"wav": "wav", "mp3": "mp3", "m4a": "m4a"}
    try:
        with av.open(io.BytesIO(audio)) as media:
            if formats[extension] not in media.format.name.split(",") or not media.streams.audio:
                raise ValueError("Invalid audio container")
            if not any(frame.samples for frame in media.decode(audio=0)):
                raise ValueError("Empty sample")
    except (av.FFmpegError, ValueError, EOFError) as error:
        raise http_errors.bad("请选择可播放的 WAV、MP3 或 M4A 音频") from error


async def clone_voice(req):
    provider = service(req)
    if len(saved_voices(provider)) >= MAX_VOICES:
        raise http_errors.bad("最多可在 OneShot 中启用 30 个音色")
    if req.content_type != "multipart/form-data":
        raise http_errors.bad("请上传一段参考音频")
    fields = {}
    try:
        form = await req.multipart()
        async for part in form:
            if not isinstance(part, BodyPartReader) or part.name not in ("name", "language", "file") or part.name in fields:
                raise http_errors.bad("声音克隆请求格式无效")
            if part.name == "file":
                extension = PurePath(part.filename or "").suffix.lower().lstrip(".")
                if extension not in ("wav", "mp3", "m4a"):
                    raise http_errors.bad("请选择可播放的 WAV、MP3 或 M4A 音频")
                data = bytearray()
                while chunk := await part.read_chunk():
                    data.extend(chunk)
                    if len(data) > MAX_SAMPLE_BYTES:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_SAMPLE_BYTES, actual_size=len(data))
                fields["file"] = (bytes(data), extension)
            else:
                raw = bytearray()
                while chunk := await part.read_chunk():
                    raw.extend(chunk)
                    if len(raw) > 240:
                        raise http_errors.bad("声音克隆请求格式无效")
                fields[part.name] = raw.decode("utf-8").strip()
    except (ValueError, AssertionError) as error:
        raise http_errors.bad("声音克隆请求格式无效") from error
    name, language = fields.get("name", ""), fields.get("language", "")
    if not 1 <= len(name) <= 60 or language not in ("", "zh", "en") or "file" not in fields:
        raise http_errors.bad("请填写音色名称并上传参考音频")
    await asyncio.to_thread(validate_sample, *fields["file"])
    try:
        voice = await noiz.clone_voice(req.app["http"], provider, name, language, *fields["file"])
    except catalog.ProviderError as error:
        raise http_errors.bad(str(error)) from error
    return web.json_response({"voice": voice, "saved": save_voice(req, provider, voice)})
