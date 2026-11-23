"""Third-party generation adapters (image / video / tts / music). Each returns local files saved under
ComfyUI's output/h3studio, so everything downstream (canvas, 剪辑台, assets) treats them like local results.

Entry points used by the server:
  await run(http, comfy_dir, provider, model, cap, req, progress) -> {"files": [{"path", "ref", "kind"}], "cost": float|None, "units": ...}
  await test(http, provider) -> {"ok", "detail"}
req (normalized by the server):
  image: {prompt, images: [Path], ar, n, size_hint}
  video: {prompt, first: Path|None, last: Path|None, refs: [Path], duration, ar, quality, audio: bool, motion_url?}
  tts:   {text, voice, speed}
  music: {prompt, lyrics, instrumental}
  sfx:   {prompt, duration_seconds, prompt_influence, loop}
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import math
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import quote

import aiohttp

from providers import ProviderError, json_req, download, data_url, default_model


def _out(comfy_dir: Path, prefix: str, ext: str):
    name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}{ext}"
    d = comfy_dir / "output" / "h3studio"
    d.mkdir(parents=True, exist_ok=True)
    return d / name, f"output:h3studio/{name}"


# =========================================================================== MiniMax

def mm_base(p: dict) -> str:
    c = p["config"]
    if c.get("base_url"):
        return c["base_url"].rstrip("/")
    return "https://api.minimax.io" if c.get("region") == "intl" else "https://api.minimax.cn"


def mm_headers(p: dict) -> dict:
    return {"Authorization": "Bearer " + p["secrets"].get("api_key", ""), "Content-Type": "application/json"}


def mm_check(j: dict, who="MiniMax"):
    br = j.get("base_resp") or {}
    code = br.get("status_code", 0)
    if code:
        msg = {1002: "请求太频繁", 1004: "API Key 不对", 1008: "账户余额不足", 1026: "内容触发了审核", 1039: "超出每分钟用量",
               2013: "参数不对", 2038: "账号没有这个权限", 2049: "API Key 无效"}.get(code, "")
        raise ProviderError(f"{who} 错误 {code}：{msg or br.get('status_msg')}")


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
    path, ref = _out(comfy_dir, "tts", ".mp3")
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
    path, ref = _out(comfy_dir, "music", ".mp3")
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
    path, ref = _out(comfy_dir, prefix, ".mp3")
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
    path, ref = _out(comfy_dir,"seed_audio",".wav")
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


# =========================================================================== images

def _size_for(ar: float, total: int, mult: int = 16, sep: str = "x") -> str:
    import math
    w = math.sqrt(total * ar); h = w / ar
    w, h = int(round(w / mult)) * mult, int(round(h / mult)) * mult
    return f"{w}{sep}{h}"


async def _save_images(http, comfy_dir, who, items):
    files = []
    for it in items:
        path, ref = _out(comfy_dir, "img", ".png")
        if it.get("b64"):
            path.write_bytes(base64.b64decode(it["b64"]))
        else:
            await download(http, it["url"], path, who)
        files.append({"path": path, "ref": ref, "kind": "image"})
    if not files:
        raise ProviderError(f"{who} 没有返回图片")
    return files


async def ark_image(http, comfy_dir, p, model, req):
    """Seedream (Volcengine Ark): sync; reference images as data URLs; one image per call (no n)."""
    base = (p["config"].get("base_url") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
    body = {"model": model, "prompt": req["prompt"], "size": _size_for(req.get("ar") or 1, 2048 * 2048 if "5-0-260128" in model or "4-5" in model else 1536 * 1536),
            "response_format": "b64_json", "watermark": False}
    if req.get("images"):
        body["image"] = [data_url(x, 2048) for x in req["images"][:10]]
    items = []
    for _ in range(max(1, min(4, int(req.get("n") or 1)))):
        j = await json_req(http, "POST", base + "/images/generations", p["name"], json=body,
                           headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")}, timeout=aiohttp.ClientTimeout(total=300))
        for d in j.get("data") or []:
            if d.get("error"):
                raise ProviderError(f"{p['name']}：{d['error'].get('message')}")
            items.append({"b64": d.get("b64_json"), "url": d.get("url")})
    return {"files": await _save_images(http, comfy_dir, p["name"], items), "units": len(items)}


def ds_base(p: dict) -> str:
    return "https://dashscope.aliyuncs.com" if p["config"].get("region", "cn") == "cn" else "https://dashscope-intl.aliyuncs.com"


async def ds_image(http, comfy_dir, p, model, req):
    """Wan 2.7 (DashScope multimodal-generation, sync)."""
    content = [{"text": req["prompt"]}] + [{"image": data_url(x, 2048)} for x in (req.get("images") or [])[:9]]
    params = {"n": max(1, min(4, int(req.get("n") or 1))), "watermark": False}
    if not req.get("images"):
        params["size"] = _size_for(req.get("ar") or 1, 1536 * 1536, 16, "*")
    else:
        params["size"] = "2K"
    body = {"model": model, "input": {"messages": [{"role": "user", "content": content}]}, "parameters": params}
    j = await json_req(http, "POST", ds_base(p) + "/api/v1/services/aigc/multimodal-generation/generation", p["name"], json=body,
                       headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")}, timeout=aiohttp.ClientTimeout(total=300))
    if j.get("code"):
        raise ProviderError(f"{p['name']}：{j.get('code')} {j.get('message')}")
    items = []
    for ch in (j.get("output") or {}).get("choices") or []:
        for c in (ch.get("message") or {}).get("content") or []:
            if c.get("image"):
                items.append({"url": c["image"]})
    return {"files": await _save_images(http, comfy_dir, p["name"], items), "units": len(items)}


async def oai_image(http, comfy_dir, p, model, req):
    """GPT Image: generations (JSON) or edits (JSON with data-URL images); always base64 back."""
    base = (p["config"].get("base_url") or "https://api.openai.com/v1").rstrip("/")
    ar = req.get("ar") or 1
    size = "1024x1024" if 0.8 < ar < 1.25 else ("1536x1024" if ar >= 1.25 else "1024x1536")
    h = {"Authorization": "Bearer " + p["secrets"].get("api_key", "")}
    body = {"model": model, "prompt": req["prompt"], "n": max(1, min(4, int(req.get("n") or 1))), "size": size, "quality": "medium"}
    if req.get("images"):
        body["images"] = [{"image_url": data_url(x, 1536)} for x in req["images"][:16]]
        url = base + "/images/edits"
    else:
        url = base + "/images/generations"
    j = await json_req(http, "POST", url, p["name"], json=body, headers=h, timeout=aiohttp.ClientTimeout(total=360))
    items = [{"b64": d.get("b64_json")} for d in j.get("data") or [] if d.get("b64_json")]
    return {"files": await _save_images(http, comfy_dir, p["name"], items), "units": len(items)}


# =========================================================================== video

def _ratio(ar: float) -> str:
    opts = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9}
    import math
    return min(opts, key=lambda k: abs(math.log(opts[k] / ar)))


async def _poll(fn, who: str, every: float = 6, limit: float = 1800):
    """Call fn() until it returns a value (not None); fn raises ProviderError on failure."""
    t0 = time.time()
    while time.time() - t0 < limit:
        r = await fn()
        if r is not None:
            return r
        await asyncio.sleep(every)
    raise ProviderError(f"{who} 超过 {int(limit / 60)} 分钟还没出结果")


async def _save_video(http, comfy_dir, who, url):
    path, ref = _out(comfy_dir, "vid", ".mp4")
    partial = path.with_suffix(".part")
    try:
        await download(http, url, partial, who)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    return {"files": [{"path": path, "ref": ref, "kind": "video"}]}


def _b64(path) -> str:
    return data_url(path, 2048).split(",", 1)[1]


def kling_base(p):
    return "https://api-singapore.klingai.com" if p["config"].get("region") == "intl" else "https://api-beijing.klingai.com"


def ark_base(p):
    return (p["config"].get("base_url") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")


VIDEO_BASES = {"kling": kling_base, "minimax": mm_base, "ark": ark_base}


def video_endpoint(p):
    if base := VIDEO_BASES.get(p["kind"]):
        return hashlib.sha256(base(p).encode()).hexdigest()


def video_receipt(p, task_id, draft_created=None):
    if isinstance(task_id, int) and not isinstance(task_id, bool):
        task_id = str(task_id)
    if (not isinstance(task_id, str) or not task_id.strip() or len(task_id) > 250 or
            task_id in (".", "..") or any(c in task_id for c in ("/", "\\", "%", "?", "#"))):
        raise ProviderError(f"{p['name']} 没有返回有效的任务号")
    return {"task_id":task_id, "endpoint":video_endpoint(p), "draft_created":draft_created}


async def kling_video(http, comfy_dir, p, model, req, on_submitted=None):
    """Kling text / first and last frame / omni references."""
    dur = int(round(req.get("duration") or 5))
    settings = {"resolution": "1080p" if req.get("quality") == "hd" else "720p", "duration": max(3, dur)}
    if model.startswith("kling-2.6"):
        settings["duration"] = 5 if dur <= 7 else 10
    if model.startswith(("kling-3.0", "kling-2.6")):
        settings["audio"] = "native" if req.get("audio", True) and (model != "kling-2.6" or settings["resolution"] == "1080p") else "off"
    if req.get("refs"):
        path = "/omni-video/" + ("kling-3.0-omni" if model == "kling-3.0" else model)
        contents = [{"type": "prompt", "text": req["prompt"]}] + [{"type": "refer_image", "url": _b64(x)} for x in req["refs"][:7]]
        if req.get("first"):
            contents.append({"type": "first_frame", "url": _b64(req["first"])})
        settings["aspect_ratio"] = "adaptive"
        body = {"contents": contents, "settings": settings}
    elif req.get("first"):
        path = "/image-to-video/" + model
        contents = [{"type": "prompt", "text": req["prompt"]}, {"type": "first_frame", "url": _b64(req["first"])}]
        if req.get("last") and "flash" not in model:
            contents.append({"type": "last_frame", "url": _b64(req["last"])})
        body = {"contents": contents, "settings": settings}
    else:
        path = "/text-to-video/" + model
        settings["aspect_ratio"] = _ratio(req.get("ar") or 16 / 9)
        body = {"prompt": req["prompt"], "settings": settings}
    body["options"] = {"watermark_info": {"enabled": False}}
    j = await json_req(http, "POST", kling_base(p) + path, p["name"], json=body, headers=mm_headers(p))
    if j.get("code"):
        raise ProviderError(f"{p['name']} 错误 {j.get('code')}：{j.get('message')}")
    receipt = video_receipt(p, (j.get("data") or {}).get("id"))
    if on_submitted:
        on_submitted(receipt)
    return await kling_result(http, comfy_dir, p, receipt)


async def kling_result(http, comfy_dir, p, receipt):
    async def check():
        q = await json_req(http, "GET", kling_base(p) + "/tasks", p["name"],
                           params={"task_ids":receipt["task_id"]}, headers=mm_headers(p))
        t = (q.get("data") or [{}])[0]
        if t.get("status") == "failed":
            raise ProviderError(f"{p['name']} 生成失败：{t.get('message')}")
        if t.get("status") == "succeeded":
            v = next((o for o in t.get("outputs") or [] if o.get("type") == "video"), None)
            if not v:
                raise ProviderError(f"{p['name']} 没有返回视频")
            cost = sum(float(x.get("amount") or 0) for x in t.get("billing") or [] if x.get("currency") == "CNY")
            return v["url"], cost
        return None
    url, cost = await _poll(check, p["name"])
    r = await _save_video(http, comfy_dir, p["name"], url)
    r["cost"] = cost or None
    return r


async def mm_video(http, comfy_dir, p, model, req, on_submitted=None):
    """MiniMax V2 (cloud MiniMax-H3 family): content items with roles; poll /v2/query."""
    content = [{"type": "text", "text": req["prompt"][:7000]}]
    body = {"model": model, "duration": max(4 if model != "MiniMax-H3-Max" else 5, min(15, int(round(req.get("duration") or 5))))}
    hd = req.get("quality") == "hd"
    body["resolution"] = ("2K" if hd else "768P") if model == "MiniMax-H3" else ("768P" if hd else "480P")
    if req.get("first") or req.get("last"):
        if req.get("first"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["first"], 2048)}, "role": "first_frame"})
        if req.get("last"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["last"], 2048)}, "role": "last_frame"})
        body["ratio"] = "adaptive"
    elif req.get("refs"):
        content += [{"type": "image_url", "image_url": {"url": data_url(x, 2048)}, "role": "reference_image"} for x in req["refs"][:9]]
        body["ratio"] = _ratio(req.get("ar") or 16 / 9)
    else:
        body["ratio"] = _ratio(req.get("ar") or 16 / 9)
    body["content"] = content
    j = await json_req(http, "POST", mm_base(p) + "/v2/video_generation", p["name"], json=body, headers=mm_headers(p))
    if j.get("error"):
        raise ProviderError(f"{p['name']}：{(j['error'] or {}).get('message')}")
    receipt = video_receipt(p, j.get("task_id"))
    if on_submitted:
        on_submitted(receipt)
    return await mm_result(http, comfy_dir, p, receipt)


async def mm_result(http, comfy_dir, p, receipt):
    tid = quote(receipt["task_id"], safe="")
    async def check():
        q = await json_req(http, "GET", mm_base(p) + f"/v2/query/video_generation/{tid}", p["name"], headers=mm_headers(p))
        t = q.get("task") or {}
        if t.get("status") in ("failed", "cancelled"):
            raise ProviderError(f"{p['name']} 生成失败：{(t.get('error') or {}).get('message') or t.get('status')}")
        if t.get("status") == "succeeded":
            url = (t.get("content") or {}).get("url")
            if not url:
                raise ProviderError(f"{p['name']} 没有返回视频")
            return url
        return None
    return await _save_video(http, comfy_dir, p["name"], await _poll(check, p["name"]))


def ark_audio_url(path, seconds):
    import numpy as np
    from render import SR, read_audio

    samples = read_audio(path, t1=seconds)
    pcm = (np.clip(samples, -1, 1).T * 32767).astype("<i2")
    with io.BytesIO() as sink:
        with wave.open(sink, "wb") as audio:
            audio.setparams((2, 2, SR, 0, "NONE", "not compressed"))
            audio.writeframes(pcm.tobytes())
        return "data:audio/wav;base64," + base64.b64encode(sink.getvalue()).decode("ascii")


def supports_video_draft(provider, model):
    name = (model or "").lower()
    return provider["kind"] == "ark" and "seedance-2-5" in name and not any(x in name for x in ("flash","fast","mini"))


async def ark_video_body(model, req):
    if draft_task := req.get("draft_task"):
        return {"model":model, "content":[{"type":"draft_task","draft_task":{"id":draft_task}}],
                "resolution":req["resolution"], "watermark":False}
    content = [{"type": "text", "text": req["prompt"]}]
    motion_url = req.get("motion_url")
    video_urls = ([motion_url] if motion_url else []) + list(req.get("video_urls") or [])
    extension, edit = req.get("extension"), req.get("segment_edit")
    if (extension or edit) and motion_url and len(video_urls)>1:
        video_urls[0], video_urls[1] = video_urls[1], video_urls[0]
    audio_refs = req.get("audio_refs") or []
    if video_urls or audio_refs:
        content.extend({"type": "image_url", "image_url": {"url": data_url(path, 2048, min_side=300)}, "role": "reference_image"}
                       for path in req["refs"])
        content.extend({"type":"video_url", "video_url":{"url":url}, "role":"reference_video"} for url in video_urls)
        for path, seconds in audio_refs:
            sound = await asyncio.to_thread(ark_audio_url, path, seconds)
            content.append({"type":"audio_url", "audio_url":{"url":sound}, "role":"reference_audio"})
    elif req.get("first"):
        content.append({"type": "image_url", "image_url": {"url": data_url(req["first"], 2048)}, "role": "first_frame"})
        if req.get("last"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["last"], 2048)}, "role": "last_frame"})
    elif req.get("refs"):
        content += [{"type": "image_url", "image_url": {"url": data_url(x, 2048)}, "role": "reference_image"} for x in req["refs"][:9]]
    fast = "flash" in model or "fast" in model or "mini" in model
    body = {"model": model, "content": content, "resolution": "720p" if fast or req.get("quality") != "hd" else "1080p",
            "ratio": "adaptive" if req.get("first") else _ratio(req.get("ar") or 16 / 9),
            "duration": max(4, min(30 if "2-5" in model else 15, int(round(req.get("duration") or 5)))), "watermark": False}
    if video_urls or audio_refs or "seedance-2" in model:
        body["generate_audio"] = bool(req.get("audio", True))
    if extension and "seedance-2-5" in model:
        body.update(ratio="adaptive",omni_reference_task_type="extend")
    elif extension and model.startswith("ep-"):
        body["ratio"] = "adaptive"
    if edit:
        body.update(ratio="adaptive",duration=-1,omni_reference_task_type="edit")
    if req.get("draft"):
        body.update(draft=True,resolution="480p")
    return body


async def ark_video(http, comfy_dir, p, model, req, on_submitted=None):
    """Seedance (Volcengine Ark content generation tasks)."""
    body = await ark_video_body(model, req)
    created = time.time()
    try:
        j = await json_req(http, "POST", ark_base(p) + "/contents/generations/tasks", p["name"],
                           json=body, headers=mm_headers(p))
    except ProviderError as e:
        if req.get("audio_refs"):
            raise ProviderError(str(e).split("data:audio/", 1)[0].rstrip()) from None
        raise
    receipt = video_receipt(p, j.get("id"), created if req.get("draft") else None)
    if on_submitted:
        on_submitted(receipt)
    return await ark_result(http, comfy_dir, p, receipt)


async def ark_result(http, comfy_dir, p, receipt):
    tid = quote(receipt["task_id"], safe="")
    async def check():
        q = await json_req(http, "GET", ark_base(p) + f"/contents/generations/tasks/{tid}", p["name"], headers=mm_headers(p))
        st = q.get("status")
        if st in ("failed", "cancelled", "expired"):
            raise ProviderError(f"{p['name']} 生成失败：{(q.get('error') or {}).get('message') or st}")
        if st == "succeeded":
            url = (q.get("content") or {}).get("video_url")
            if not url:
                raise ProviderError(f"{p['name']} 没有返回视频")
            return url
        return None
    result = await _save_video(http, comfy_dir, p["name"], await _poll(check, p["name"]))
    if receipt.get("draft_created") is not None:
        result.update(draft_task=receipt["task_id"],draft_created=receipt["draft_created"])
    return result


# =========================================================================== dispatch

VIDEO_RESULTS = {"kling": kling_result, "minimax": mm_result, "ark": ark_result}


async def resume_video(http, comfy_dir, p, receipt):
    validated = video_receipt(p, receipt.get("task_id"), receipt.get("draft_created"))
    if not validated["endpoint"] or validated["endpoint"] != receipt.get("endpoint"):
        raise ProviderError("视频服务的请求地址已变更，无法查询原任务")
    return await VIDEO_RESULTS[p["kind"]](http, comfy_dir, p, validated)


async def run(http, comfy_dir: Path, p: dict, model: str | None, cap: str, req: dict, progress=lambda s: None, *,
              on_submitted=None) -> dict:
    k = p["kind"]
    fn = ADAPTERS.get((k, cap))
    if not fn:
        raise ProviderError(f"{p['name']} 暂不支持「{cap}」")
    if cap == "video":
        return await fn(http, comfy_dir, p, model or default_model(p, cap), req, on_submitted)
    return await fn(http, comfy_dir, p, model or default_model(p, cap), req)


ADAPTERS = {
    ("kling", "video"): kling_video,
    ("minimax", "video"): mm_video,
    ("ark", "video"): ark_video,
    ("ark", "image"): ark_image,
    ("dashscope", "image"): ds_image,
    ("openai", "image"): oai_image,
    ("minimax", "tts"): mm_tts,
    ("minimax", "music"): mm_music,
    ("elevenlabs", "sfx"): elevenlabs_sfx,
    ("elevenlabs", "tts"): elevenlabs_tts,
    ("volc_seed_audio", "seed_audio"): volc_seed_audio,
}


async def test(http, p: dict) -> dict:
    k = p["kind"]
    if k == "elevenlabs":
        if not p["secrets"].get("api_key"):
            raise ProviderError("先填写 API Key")
        return {"ok":True,"detail":"已配置 API Key，首次生成时验证权限"}
    if k == "minimax":
        if not p["secrets"].get("api_key"):
            raise ProviderError("先填写 API Key")
        # the cheapest authenticated call: a 2-character TTS
        body = {"model": "speech-2.8-turbo", "text": "测试", "stream": False, "output_format": "hex",
                "voice_setting": {"voice_id": "female-shaonv"}, "audio_setting": {"format": "mp3", "sample_rate": 16000}}
        j = await json_req(http, "POST", mm_base(p) + "/v1/t2a_v2", p["name"], json=body, headers=mm_headers(p))
        mm_check(j, p["name"])
        return {"ok": True, "detail": "Key 有效（合成了 2 个字的测试语音）"}
    fn = TESTS.get(k)
    if not fn:
        return {"ok": True, "detail": "已保存（这种服务没有免费的测试方法，第一次生成时会验证）"}
    return await fn(http, p)


async def _test_kling(http, p):
    base = "https://api-singapore.klingai.com" if p["config"].get("region") == "intl" else "https://api-beijing.klingai.com"
    j = await json_req(http, "GET", base + "/tasks", p["name"], params={"task_ids": "0"}, headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")})
    if j.get("code") in (1000, 1001, 1002, 1003, 1004):
        raise ProviderError(f"Key 无效（{j.get('code')}）：{j.get('message')}")
    return {"ok": True, "detail": "Key 有效（查询任务接口可以访问）"}


async def _test_ark(http, p):
    base = (p["config"].get("base_url") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
    await json_req(http, "GET", base + "/contents/generations/tasks", p["name"], params={"page_size": 1},
                   headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")})
    return {"ok": True, "detail": "Key 有效（任务列表可以访问）"}


async def _test_dashscope(http, p):
    import providers
    m = providers.default_model(p, "text") or "qwen3.8-flash"
    out = await providers.chat(http, p, m, "只回复两个字：成功", "测试", max_tokens=16, temperature=0)
    return {"ok": True, "detail": f"{m} 回复「{out[:20]}」"}


async def _test_openai(http, p):
    base = (p["config"].get("base_url") or "https://api.openai.com/v1").rstrip("/")
    await json_req(http, "GET", base + "/models", p["name"], headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")})
    return {"ok": True, "detail": "Key 有效（模型列表可以访问）"}


TESTS: dict = {"kling": _test_kling, "ark": _test_ark, "dashscope": _test_dashscope, "openai": _test_openai}
