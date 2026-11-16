"""Third-party generation adapters (image / video / tts / music). Each returns local files saved under
ComfyUI's output/h3studio, so everything downstream (canvas, 剪辑台, assets) treats them like local results.

Entry points used by the server:
  await run(http, comfy_dir, provider, model, cap, req, progress) -> {"files": [{"path", "ref", "kind"}], "cost": float|None, "units": ...}
  await test(http, provider) -> {"ok", "detail"}
req (normalized by the server):
  image: {prompt, images: [Path], ar, n, size_hint}
  video: {prompt, first: Path|None, last: Path|None, refs: [Path], duration, ar, quality, audio: bool}
  tts:   {text, voice, speed}
  music: {prompt, lyrics, instrumental}
"""
from __future__ import annotations

import asyncio
import base64
import time
import uuid
from pathlib import Path

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
    await download(http, url, path, who)
    return {"files": [{"path": path, "ref": ref, "kind": "video"}]}


def _b64(path) -> str:
    return data_url(path, 2048).split(",", 1)[1]


async def kling_video(http, comfy_dir, p, model, req):
    """Kling (new path-versioned API, Bearer key): text / first(+last) frame / omni references; poll /tasks."""
    base = "https://api-singapore.klingai.com" if p["config"].get("region") == "intl" else "https://api-beijing.klingai.com"
    h = {"Authorization": "Bearer " + p["secrets"].get("api_key", ""), "Content-Type": "application/json"}
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
    j = await json_req(http, "POST", base + path, p["name"], json=body, headers=h)
    if j.get("code"):
        raise ProviderError(f"{p['name']} 错误 {j.get('code')}：{j.get('message')}")
    tid = (j.get("data") or {}).get("id")

    async def check():
        q = await json_req(http, "GET", base + "/tasks", p["name"], params={"task_ids": tid}, headers=h)
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


async def mm_video(http, comfy_dir, p, model, req):
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
    tid = j.get("task_id")
    if not tid:
        raise ProviderError(f"{p['name']} 没有返回任务号：{str(j)[:200]}")

    async def check():
        q = await json_req(http, "GET", mm_base(p) + f"/v2/query/video_generation/{tid}", p["name"], headers=mm_headers(p))
        t = q.get("task") or {}
        if t.get("status") in ("failed", "cancelled"):
            raise ProviderError(f"{p['name']} 生成失败：{(t.get('error') or {}).get('message') or t.get('status')}")
        if t.get("status") == "succeeded":
            return (t.get("content") or {}).get("url")
        return None
    return await _save_video(http, comfy_dir, p["name"], await _poll(check, p["name"]))


async def ark_video(http, comfy_dir, p, model, req):
    """Seedance (Volcengine Ark content generation tasks)."""
    base = (p["config"].get("base_url") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
    h = {"Authorization": "Bearer " + p["secrets"].get("api_key", ""), "Content-Type": "application/json"}
    content = [{"type": "text", "text": req["prompt"]}]
    if req.get("first"):
        content.append({"type": "image_url", "image_url": {"url": data_url(req["first"], 2048)}, "role": "first_frame"})
        if req.get("last"):
            content.append({"type": "image_url", "image_url": {"url": data_url(req["last"], 2048)}, "role": "last_frame"})
    elif req.get("refs"):
        content += [{"type": "image_url", "image_url": {"url": data_url(x, 2048)}, "role": "reference_image"} for x in req["refs"][:9]]
    fast = "flash" in model or "fast" in model or "mini" in model
    body = {"model": model, "content": content, "resolution": "720p" if fast or req.get("quality") != "hd" else "1080p",
            "ratio": "adaptive" if req.get("first") else _ratio(req.get("ar") or 16 / 9),
            "duration": max(4, min(30 if "2-5" in model else 15, int(round(req.get("duration") or 5)))), "watermark": False}
    if "seedance-2" in model:
        body["generate_audio"] = bool(req.get("audio", True))
    j = await json_req(http, "POST", base + "/contents/generations/tasks", p["name"], json=body, headers=h)
    tid = j.get("id")
    if not tid:
        raise ProviderError(f"{p['name']} 没有返回任务号：{str(j)[:200]}")

    async def check():
        q = await json_req(http, "GET", base + f"/contents/generations/tasks/{tid}", p["name"], headers=h)
        st = q.get("status")
        if st in ("failed", "cancelled", "expired"):
            raise ProviderError(f"{p['name']} 生成失败：{(q.get('error') or {}).get('message') or st}")
        if st == "succeeded":
            return (q.get("content") or {}).get("video_url")
        return None
    return await _save_video(http, comfy_dir, p["name"], await _poll(check, p["name"]))


# =========================================================================== dispatch

async def run(http, comfy_dir: Path, p: dict, model: str | None, cap: str, req: dict, progress=lambda s: None) -> dict:
    k = p["kind"]
    fn = ADAPTERS.get((k, cap))
    if not fn:
        raise ProviderError(f"{p['name']} 暂不支持「{cap}」")
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
}


async def test(http, p: dict) -> dict:
    k = p["kind"]
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
