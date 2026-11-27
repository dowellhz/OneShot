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
import math
import time
import wave
from pathlib import Path
from urllib.parse import quote

import aiohttp

from oneshot.generation.media_files import _new
from oneshot.generation.motion_reference import image_limit, ordered_video_references, video_model_for_limits
from oneshot.providers.catalog import ProviderError, data_url, default_model, download, json_req
from oneshot.providers.minimax import mm_base, mm_check, mm_headers
from oneshot.providers.noiz import noiz_tts, test_noiz
from oneshot.providers.remote_audio import (
    elevenlabs_music,
    MM_VOICES as MM_VOICES,
    elevenlabs_sfx,
    elevenlabs_tts,
    mm_music,
    mm_tts,
    volc_seed_audio,
)
from oneshot.providers.remote_images import ark_image, ds_image, gemini_image, oai_image, test_gemini_image


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
    path, ref = _new(comfy_dir, "output", "vid", ".mp4")
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


def video_durations(kind, model, *, provider=None):
    model = video_model_for_limits(provider,model)
    if kind == "kling":
        if model.startswith("kling-2.6"):
            return [5,10]
        maximum = 20 if model == "kling-4.0-flash" else 30 if model == "kling-4.0" else 15
        return list(range(3,maximum+1))
    if kind == "minimax":
        return list(range(5 if model.startswith("MiniMax-H3-Max") else 4,16))
    return list(range(4,31 if "2-5" in model else 16))


def video_duration(kind, model, duration, *, provider=None):
    seconds = round(duration or 5)
    return min(video_durations(kind,model,provider=provider),key=lambda value:abs(value-seconds))


def video_resolutions(kind, model, *, provider=None):
    model = video_model_for_limits(provider,model)
    if kind == "minimax":
        if model == "MiniMax-H3":
            return {"480p":"480P","std":"768P","hd":"2K"}
        if model == "MiniMax-H3-MG":
            return {"std":"768P","hd":"2K"}
        return {"std":"480P","hd":"768P"}
    if kind == "kling":
        if model == "kling-4.0-flash":
            return {"std":"720p"}
        options = {"std":"720p","hd":"1080p"}
        if model in ("kling-4.0","kling-3.0"):
            options["4k"] = "4k"
        return options
    if kind == "ark":
        known = model.startswith(("doubao-seedance-2-5","doubao-seedance-2-0"))
        fast = any(tag in model for tag in ("flash","fast","mini"))
        options = {"480p":"480p","std":"720p"} if known else {"std":"720p"}
        if not fast:
            options["hd"] = "1080p"
            if known:
                options["4k"] = "4k"
        return options
    return {"std":"480P","hd":"768P"}


def video_resolution(kind, model, quality, *, provider=None):
    options = video_resolutions(kind,model,provider=provider)
    return options.get(quality,options["std"]) if isinstance(quality,str) else options["std"]


async def kling_video(http, comfy_dir, p, model, req, on_submitted=None):
    """Kling text / first and last frame / omni references."""
    settings = {"resolution": video_resolution("kling",model,req.get("quality")),
                "duration": video_duration("kling", model, req.get("duration"))}
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
    body = {"model": model, "duration": video_duration("minimax", model, req.get("duration"))}
    body["resolution"] = video_resolution("minimax",model,req.get("quality"))
    video_urls = ([req["motion_url"]] if req.get("motion_url") else []) + list(req.get("video_urls") or [])
    audio_urls = req.get("audio_urls") or []
    if video_urls or audio_urls:
        content.extend({"type":"image_url","image_url":{"url":data_url(path,2048,min_side=300)},"role":"reference_image"}
                       for path in req.get("refs",[]))
        content.extend({"type":"video_url","video_url":{"url":url},"role":"reference_video"} for url in video_urls)
        content.extend({"type":"audio_url","audio_url":{"url":url},"role":"reference_audio"} for url in audio_urls)
        body["ratio"] = _ratio(req.get("ar") or 16 / 9)
        body["generate_audio"] = bool(req.get("audio",True))
    elif req.get("first") or req.get("last"):
        if req.get("first"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["first"], 2048)}, "role": "first_frame"})
        if req.get("last"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["last"], 2048)}, "role": "last_frame"})
        body["ratio"] = "adaptive"
    elif req.get("refs"):
        content += [{"type": "image_url", "image_url": {"url": data_url(x, 2048,min_side=300)}, "role": "reference_image"} for x in req["refs"][:9]]
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


def reference_audio_wav(path, seconds, start=0):
    import numpy as np
    from oneshot.editing.render import SR, read_audio

    samples = read_audio(path,t0=start,t1=start+seconds)
    pcm = (np.clip(samples, -1, 1).T * 32767).astype("<i2")
    with io.BytesIO() as sink:
        with wave.open(sink, "wb") as audio:
            audio.setparams((2, 2, SR, 0, "NONE", "not compressed"))
            audio.writeframes(pcm.tobytes())
        return sink.getvalue()


def ark_audio_url(path, seconds, start=0):
    return "data:audio/wav;base64," + base64.b64encode(reference_audio_wav(path,seconds,start)).decode("ascii")


def supports_video_draft(provider, model):
    name = (video_model_for_limits(provider,model) or "").lower()
    return provider["kind"] == "ark" and "seedance-2-5" in name and not any(x in name for x in ("flash","fast","mini"))


async def ark_video_body(model, req, *, provider=None):
    if draft_task := req.get("draft_task"):
        return {"model":model, "content":[{"type":"draft_task","draft_task":{"id":draft_task}}],
                "resolution":req["resolution"], "watermark":False}
    profile_model = video_model_for_limits(provider,model)
    content = [{"type": "text", "text": req["prompt"]}]
    extension, edit = req.get("extension"), req.get("segment_edit")
    video_urls = ordered_video_references(req.get("motion_url"),req.get("video_urls") or [],
                                          source_first=bool(extension or edit))
    audio_refs = req.get("audio_refs") or []
    if video_urls or audio_refs:
        content.extend({"type": "image_url", "image_url": {"url": data_url(path, 2048, min_side=300)}, "role": "reference_image"}
                       for path in req["refs"])
        content.extend({"type":"video_url", "video_url":{"url":url}, "role":"reference_video"} for url in video_urls)
        for path,start,seconds in audio_refs:
            sound = await asyncio.to_thread(ark_audio_url,path,seconds,start)
            content.append({"type":"audio_url", "audio_url":{"url":sound}, "role":"reference_audio"})
    elif req.get("first"):
        content.append({"type": "image_url", "image_url": {"url": data_url(req["first"], 2048)}, "role": "first_frame"})
        if req.get("last"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["last"], 2048)}, "role": "last_frame"})
    elif req.get("refs"):
        limit = image_limit(profile_model)
        if len(req["refs"]) > limit:
            raise ProviderError(f"此模型最多支持 {limit} 张参考图")
        content += [{"type":"image_url","image_url":{"url":data_url(path,2048,min_side=300)},"role":"reference_image"}
                    for path in req["refs"]]
    body = {"model": model, "content": content, "resolution": video_resolution("ark",model,req.get("quality"),provider=provider),
            "ratio": "adaptive" if req.get("first") else _ratio(req.get("ar") or 16 / 9),
            "duration": video_duration("ark", model, req.get("duration"),provider=provider), "watermark": False}
    if video_urls or audio_refs or "seedance-2" in profile_model:
        body["generate_audio"] = bool(req.get("audio", True))
    if extension and "seedance-2-5" in profile_model:
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
    body = await ark_video_body(model,req,provider=p)
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
    ("gemini", "image"): gemini_image,
    ("minimax", "tts"): mm_tts,
    ("noiz", "tts"): noiz_tts,
    ("minimax", "music"): mm_music,
    ("elevenlabs", "sfx"): elevenlabs_sfx,
    ("elevenlabs", "tts"): elevenlabs_tts,
    ("elevenlabs", "music"): elevenlabs_music,
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
    from oneshot.providers import catalog as providers
    m = providers.default_model(p, "text") or "qwen3.8-flash"
    out = await providers.chat(http, p, m, "只回复两个字：成功", "测试", max_tokens=16, temperature=0)
    return {"ok": True, "detail": f"{m} 回复「{out[:20]}」"}


async def _test_openai(http, p):
    base = (p["config"].get("base_url") or "https://api.openai.com/v1").rstrip("/")
    await json_req(http, "GET", base + "/models", p["name"], headers={"Authorization": "Bearer " + p["secrets"].get("api_key", "")})
    return {"ok": True, "detail": "Key 有效（模型列表可以访问）"}


TESTS: dict = {"kling": _test_kling, "ark": _test_ark, "dashscope": _test_dashscope, "openai": _test_openai,
               "gemini": test_gemini_image, "noiz": test_noiz}
