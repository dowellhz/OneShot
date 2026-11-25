"""Remote speech, music, and sound adapters."""

import base64
import json
import math
import uuid
from urllib.parse import quote

import aiohttp

from oneshot.generation.media_files import _new
from oneshot.providers.catalog import ProviderError, download, json_req
from oneshot.providers.minimax import mm_base, mm_check, mm_headers


MM_VOICES = [("male-qn-qingse", "青涩青年"), ("male-qn-jingying", "精英青年"), ("male-qn-badao", "霸道青年"),
             ("male-qn-daxuesheng", "青年大学生"), ("female-shaonv", "少女"), ("female-yujie", "御姐"),
             ("female-chengshu", "成熟女性"), ("female-tianmei", "甜美女性"), ("clever_boy", "聪明男童"),
             ("lovely_girl", "萌萌女童"), ("junlang_nanyou", "俊朗男友"), ("danya_xuejie", "淡雅学姐")]


async def mm_tts(http, comfy_dir, p, model, req):
    body = {"model": model or "speech-2.8-hd", "text": req["text"], "stream": False, "language_boost": "auto", "output_format": "hex",
            "voice_setting": {"voice_id": req.get("voice") or "female-shaonv", "speed": float(req.get("speed") or 1), "vol": 1, "pitch": 0},
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1}}
    j = await json_req(http, "POST", mm_base(p) + "/v1/t2a_v2", p["name"], json=body, headers=mm_headers(p))
    mm_check(j, p["name"])
    audio = (j.get("data") or {}).get("audio")
    if not audio:
        raise ProviderError(f"{p['name']} 没有返回音频")
    path, ref = _new(comfy_dir, "output", "tts", ".mp3")
    path.write_bytes(bytes.fromhex(audio))
    ex = j.get("extra_info") or {}
    return {"files": [{"path": path, "ref": ref, "kind": "audio"}], "seconds": (ex.get("audio_length") or 0) / 1000,
            "units": ex.get("usage_characters")}


async def mm_music(http, comfy_dir, p, model, req):
    body = {"model": model or "music-3.0", "prompt": req.get("prompt") or "", "output_format": "hex",
            "audio_setting": {"sample_rate": 44100, "bitrate": 256000, "format": "mp3"}}
    if req.get("lyrics"):
        body["lyrics"] = req["lyrics"]
    else:
        body["is_instrumental"] = True
    j = await json_req(http, "POST", mm_base(p) + "/v1/music_generation", p["name"], json=body, headers=mm_headers(p),
                       timeout=aiohttp.ClientTimeout(total=600))
    mm_check(j, p["name"])
    audio = (j.get("data") or {}).get("audio")
    if not audio:
        raise ProviderError(f"{p['name']} 没有返回音乐（MiniMax 音乐接口自 2026-08 起不再向新账号开放）")
    path, ref = _new(comfy_dir, "output", "music", ".mp3")
    path.write_bytes(bytes.fromhex(audio) if not audio.startswith("http") else b"")
    if audio.startswith("http"):
        await download(http, audio, path, p["name"])
    return {"files": [{"path": path, "ref": ref, "kind": "audio"}], "seconds": ((j.get("extra_info") or {}).get("music_duration") or 0) / 1000}


# =========================================================================== ElevenLabs

def elevenlabs_cues(alignment):
    if not isinstance(alignment, dict):
        return []
    values = [alignment.get(key) for key in ("characters","character_start_times_seconds","character_end_times_seconds")]
    if any(not isinstance(value,list) for value in values) or not 0 < len(values[0]) <= 20_000 or len({len(value) for value in values}) != 1:
        return []
    cues, parts = [], []
    start = end = 0
    size = 0

    def finish():
        nonlocal size
        text = "".join(parts).strip()
        if text and end > start:
            cues.append({"start":start,"end":end,"text":text})
        parts.clear()
        size = 0

    for text, a, b in zip(*values):
        if (not isinstance(text,str) or not 0 < len(text) <= 16 or type(a) not in (int,float) or
                type(b) not in (int,float) or not 0 <= a <= b < math.inf):
            return []
        if parts and (a-end > .55 or (size >= 36 and text.isspace()) or size+len(text) > 75):
            finish()
        if not parts and not text.strip():
            continue
        if not parts:
            start = max(a,cues[-1]["end"] if cues else 0)
            end = start
        parts.append(text)
        end = max(end,b)
        size += len(text)
        if text.endswith(("。","！","？","!","?","\n")) or (text == "." and size >= 20):
            finish()
    finish()
    return cues


async def elevenlabs_audio(http, comfy_dir, p, endpoint, body, prefix, max_bytes, *, timed=False):
    secret = p["secrets"].get("api_key")
    if not secret:
        raise ProviderError("未配置 ElevenLabs API Key")
    async with http.post("https://api.elevenlabs.io/v1/"+endpoint, json=body,
                         params={"output_format":"mp3_44100_128"}, headers={"xi-api-key":secret},
                         timeout=aiohttp.ClientTimeout(total=120), allow_redirects=False) as response:
        if response.status != 200:
            detail = {401:"请检查 API Key",403:"Key 或账号无此生成权限",404:"模型或音色不可用",422:"参数不被所选模型接受",
                      429:"请求过多或额度不足"}.get(response.status,"服务暂时不可用")
            raise ProviderError(f"ElevenLabs HTTP {response.status} · {detail}")
        formats = ("application/json",) if timed else ("audio/mpeg","audio/mp3","application/octet-stream")
        if response.content_type not in formats:
            raise ProviderError("ElevenLabs 未返回 MP3 音频")
        audio = bytearray()
        async for chunk in response.content.iter_chunked(65536):
            audio.extend(chunk)
            if len(audio) > (max_bytes*3//2 if timed else max_bytes):
                raise ProviderError("ElevenLabs 返回的数据超出大小限制")
        if not audio:
            raise ProviderError("ElevenLabs 返回了空音频")
        units = response.headers.get("character-cost", "")
    captions = []
    if timed:
        try:
            payload = json.loads(audio)
            audio = base64.b64decode(payload["audio_base64"], validate=True)
        except (KeyError,TypeError,ValueError) as exc:
            raise ProviderError("ElevenLabs 返回的配音数据无效") from exc
        if not audio or len(audio) > max_bytes:
            raise ProviderError("ElevenLabs 返回的配音数据为空或超出大小限制")
        captions = elevenlabs_cues(payload.get("normalized_alignment")) or elevenlabs_cues(payload.get("alignment"))
    path, ref = _new(comfy_dir, "output", prefix, ".mp3")
    path.write_bytes(audio)
    return {"files":[{"path":path,"ref":ref,"kind":"audio"}],
            **({"captions":captions} if captions else {}),
            "units":int(units) if units.isascii() and units.isdecimal() and len(units)<=12 else None}


async def elevenlabs_sfx(http, comfy_dir, p, model, req):
    body = {"model_id":model, "text":req["prompt"], "prompt_influence":req["prompt_influence"], "loop":req["loop"]}
    if req["duration_seconds"] is not None:
        body["duration_seconds"] = req["duration_seconds"]
    return await elevenlabs_audio(http, comfy_dir, p, "sound-generation", body, "sfx", 4*1024*1024)


async def elevenlabs_tts(http, comfy_dir, p, model, req):
    body = {"model_id":model, "text":req["text"]}
    if model != "eleven_v3":
        body["voice_settings"] = {"speed":req["speed"]}
    endpoint = "text-to-speech/" + quote(req["voice"], safe="")
    timed = bool(req.get("subtitles"))
    if timed:
        endpoint += "/with-timestamps"
    return await elevenlabs_audio(http, comfy_dir, p, endpoint, body, "tts", 12*1024*1024, timed=timed)


async def volc_seed_audio(http, comfy_dir, p, model, req):
    references = req.get("references",[])
    body = {"model":model,"text_prompt":req["prompt"],
            "audio_config":{"format":"wav","sample_rate":24000,"enable_subtitle":bool(req.get("subtitles"))}}
    if references:
        body["references"] = [{item["kind"]+"_data":base64.b64encode(item["data"]).decode("ascii")} for item in references]
    secret = p["secrets"].get("api_key")
    if not secret:
        raise ProviderError("未配置豆包语音 API Key")
    headers = {"X-Api-Key":secret,"X-Api-Request-Id":uuid.uuid4().hex}
    response = await json_req(http,"POST","https://openspeech.bytedance.com/api/v3/tts/create",p["name"],
                              json=body,headers=headers,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=300))
    if not isinstance(response,dict) or response.get("code") not in (None,0,20000000):
        raise ProviderError("火山音频生成失败，请检查模型权限和所选参考")
    encoded = response.get("audio")
    if not isinstance(encoded,str) or not 1 <= len(encoded) <= 24*1024*1024:
        raise ProviderError("火山未返回可用音频")
    try:
        audio = base64.b64decode(encoded,validate=True)
    except ValueError as error:
        raise ProviderError("火山返回的音频编码无效") from error
    if audio[:4]!=b"RIFF" or audio[8:12]!=b"WAVE":
        raise ProviderError("火山未返回 WAV 音频")
    path, ref = _new(comfy_dir, "output","seed_audio",".wav")
    path.write_bytes(audio)
    subtitles = response.get("subtitle")
    sentences = subtitles.get("sentences") if isinstance(subtitles,dict) else None
    cues = []
    if isinstance(sentences,list):
        for cue in sentences[:300]:
            if not isinstance(cue,dict):
                continue
            a,b,text = (cue.get(key) for key in ("start_time","end_time","text"))
            if type(a) is int and type(b) is int and 0 <= a < b <= 600_000 and isinstance(text,str) and text.strip():
                cues.append({"start":a/1000,"end":b/1000,"text":text.strip()[:500]})
    units = response.get("original_duration")
    return {"files":[{"path":path,"ref":ref,"kind":"audio"}],"captions":sorted(cues,key=lambda cue:cue["start"]),
            "units":units if type(units) in (float,int) and 0 < units <= 120 else None}
