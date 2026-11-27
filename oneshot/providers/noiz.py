"""Speech synthesis through the official Noiz API."""

import asyncio
import io
import json
import wave

import aiohttp

from oneshot.generation.media_files import _new
from oneshot.providers.catalog import ProviderError, configured_voices

INTERNATIONAL_API = "https://noiz.ai/v1"
SPEED_RANGE = (.5, 1.5)
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024


def headers(provider: dict) -> dict[str, str]:
    key = provider.get("secrets", {}).get("api_key")
    if not key:
        raise ProviderError("请先填写 Noiz 凭据")
    return {"Authorization": key}


async def response_bytes(http, method, url, limit, **kwargs) -> bytes:
    timeout = aiohttp.ClientTimeout(total=45, connect=8)
    try:
        async with http.request(method, url, timeout=timeout, allow_redirects=False, **kwargs) as response:
            if response.status == 402:
                raise ProviderError("Noiz 账户可用额度不足")
            if response.status != 200:
                raise ProviderError(f"Noiz 请求失败（HTTP {response.status}）")
            output = bytearray()
            async for chunk in response.content.iter_chunked(64 * 1024):
                output.extend(chunk)
                if len(output) > limit:
                    raise ProviderError("Noiz 返回的数据过大")
            return bytes(output)
    except (aiohttp.ClientError, TimeoutError) as error:
        raise ProviderError("Noiz 连接失败或超时") from error


def decode_result(body: bytes):
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ProviderError("Noiz 返回格式不正确") from error
    if not isinstance(result, dict) or type(result.get("code")) is not int:
        raise ProviderError("Noiz 返回格式不正确")
    message = str(result.get("message") or result.get("msg") or "").lower()
    if result["code"] == 402 or result["code"] == 400 and "credit limit exceeded" in message:
        raise ProviderError("Noiz 账户可用额度不足")
    if result["code"] != 0:
        raise ProviderError(f"Noiz 拒绝请求（代码 {result['code']}）")
    return result.get("data")


async def request_data(http, method, url, **kwargs):
    return decode_result(await response_bytes(http, method, url, MAX_JSON_BYTES, **kwargs))


def save_audio(comfy_dir, audio: bytes) -> dict:
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            frames = wav.getnframes()
            expected = frames * wav.getsampwidth() * wav.getnchannels()
            if not frames or expected > len(audio) or len(wav.readframes(frames)) != expected:
                raise ValueError("Missing or truncated PCM data")
            seconds = frames / wav.getframerate()
    except (EOFError, ValueError, wave.Error) as error:
        raise ProviderError("Noiz 未返回可播放的 WAV 音频") from error
    path, ref = _new(comfy_dir, "output", "noiz", ".wav")
    path.write_bytes(audio)
    return {"files": [{"path": path, "ref": ref, "kind": "audio"}], "seconds": seconds}


async def noiz_tts(http, comfy_dir, provider, _model, req) -> dict:
    auth = headers(provider)
    text = req.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 5000:
        raise ProviderError("Noiz 配音文案须为 1 到 5000 字")
    voices = configured_voices(provider["kind"], provider["config"].get("voices", ""))
    voice = req.get("voice") or (voices[0]["id"] if voices else None)
    if not any(voice == item["id"] for item in voices):
        raise ProviderError("请选择所选服务提供的音色")
    try:
        speed = float(1 if req.get("speed") is None else req["speed"])
    except (ValueError, TypeError):
        speed = 0
    if not SPEED_RANGE[0] <= speed <= SPEED_RANGE[1]:
        raise ProviderError("Noiz 语速须在 0.5 到 1.5 倍之间")
    with aiohttp.MultipartWriter("form-data") as form:
        for name, value in {"text": text.strip(), "voice_id": voice, "speed": str(speed),
                            "output_format": "wav"}.items():
            form.append(value).set_content_disposition("form-data", name=name)
        audio = await response_bytes(http, "POST", INTERNATIONAL_API + "/text-to-speech",
                                     MAX_AUDIO_BYTES, data=form, headers=auth)
    if audio.lstrip()[:1] == b"{" and len(audio) <= MAX_JSON_BYTES:
        decode_result(audio)
    return await asyncio.to_thread(save_audio, comfy_dir, audio)


async def test_noiz(http, provider) -> dict:
    await list_voices(http, provider, "built-in", 0, "")
    return {"ok": True, "detail": "Noiz 凭据有效，可以访问音色列表"}


def voice_option(data: dict, *, cloned=False) -> dict:
    if not isinstance(data, dict):
        raise ProviderError("Noiz 返回格式不正确")
    voice_id = data.get("voice_id")
    name = data.get("voice_display_name" if cloned else "display_name")
    if not isinstance(voice_id, str):
        raise ProviderError("Noiz 未返回音色 ID")
    options = configured_voices("noiz", voice_id)
    if not options or options[0]["id"] != voice_id or len(options) != 1:
        raise ProviderError("Noiz 返回的音色 ID 无效")
    options[0]["name"] = (name.strip()[:60] if isinstance(name, str) else "") or voice_id
    return options[0]


async def list_voices(http, provider, kind: str, page: int, keyword: str) -> dict:
    params = {"voice_type": kind, "skip": page, "limit": 10}
    if keyword:
        params["keyword"] = keyword
    data = await request_data(http, "GET", INTERNATIONAL_API + "/voices", headers=headers(provider), params=params)
    if not isinstance(data, dict) or not isinstance(data.get("voices"), list):
        raise ProviderError("Noiz 返回格式不正确")
    voices = [voice_option(voice) for voice in data["voices"][:10]]
    total = data.get("total_count")
    return {"voices": voices, "more": (page + 1) * 10 < total if type(total) is int else len(voices) == 10}


async def clone_voice(http, provider, name: str, language: str, audio: bytes, ext: str) -> dict:
    form = aiohttp.FormData()
    form.add_field("file", audio, filename=f"sample.{ext}",
                   content_type={"wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4"}[ext])
    form.add_field("display_name", name)
    if language:
        form.add_field("language", language)
    data = await request_data(http, "POST", INTERNATIONAL_API + "/voices", headers=headers(provider), data=form)
    return voice_option(data, cloned=True)
