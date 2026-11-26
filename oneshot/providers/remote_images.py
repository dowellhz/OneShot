"""Remote image generation and image edit adapters."""

import base64
from urllib.parse import quote

import aiohttp

from oneshot.generation.media_files import _new
from oneshot.providers.catalog import ProviderError, data_url, download, json_req


def _size_for(ar: float, total: int, mult: int = 16, sep: str = "x") -> str:
    import math
    w = math.sqrt(total * ar); h = w / ar
    w, h = int(round(w / mult)) * mult, int(round(h / mult)) * mult
    return f"{w}{sep}{h}"


async def _save_images(http, comfy_dir, who, items):
    files = []
    for it in items:
        suffix = {"image/jpeg": ".jpg", "image/webp": ".webp"}.get(it.get("mime"), ".png")
        path, ref = _new(comfy_dir, "output", "img", suffix)
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
    if model == "gpt-image-2.6-sunburst":
        body["complexity"] = "high"
        body["quality"] = "high" if req.get("quality") == "16mp" else "medium"
    if req.get("images"):
        body["images"] = [{"image_url": data_url(x, 1536)} for x in req["images"][:16]]
        url = base + "/images/edits"
    else:
        url = base + "/images/generations"
    j = await json_req(http, "POST", url, p["name"], json=body, headers=h, timeout=aiohttp.ClientTimeout(total=360))
    items = [{"b64": d.get("b64_json")} for d in j.get("data") or [] if d.get("b64_json")]
    return {"files": await _save_images(http, comfy_dir, p["name"], items), "units": len(items)}


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image"
GEMINI_IMAGE_RATIOS = ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")


async def gemini_image(http, comfy_dir, p, model, req):
    references = req.get("images") or []
    if len(references) > 14:
        raise ProviderError("Nano Banana 2 最多使用 14 张参考图")
    parts = []
    for index, path in enumerate(references, 1):
        data = data_url(path, 1536).partition(",")[2]
        parts.extend([{"text": f"图{index} (Image {index})"},
                      {"inlineData": {"mimeType": "image/jpeg", "data": data}}])
    parts.append({"text": req["prompt"]})
    ratio = req.get("ar") or 1
    def distance(aspect):
        width, height = map(int, aspect.split(":"))
        return abs(width / height - ratio)

    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {
            "aspectRatio": min(GEMINI_IMAGE_RATIOS, key=distance),
            "imageSize": "4K" if req.get("quality") == "16mp" else "2K",
        }},
    }
    model_url = f"{GEMINI_URL}/{quote(model, safe='')}"
    headers = {"x-goog-api-key": p["secrets"].get("api_key", "")}
    response = await json_req(http, "POST", model_url + ":generateContent", p["name"], json=body,
                              headers=headers, timeout=aiohttp.ClientTimeout(total=360))
    for candidate in response.get("candidates") or []:
        for part in (candidate.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or {}
            if not part.get("thought") and inline.get("data") and inline.get("mimeType") in (
                "image/png", "image/jpeg", "image/webp",
            ):
                items = [{"b64": inline["data"], "mime": inline["mimeType"]}]
                return {"files": await _save_images(http, comfy_dir, p["name"], items), "units": 1}
    reason = (response.get("promptFeedback") or {}).get("blockReason")
    raise ProviderError(f"{p['name']} 没有返回图片" + (f"（{reason}）" if reason else ""))


async def test_gemini_image(http, p):
    await json_req(http, "GET", f"{GEMINI_URL}/{GEMINI_IMAGE_MODEL}", p["name"],
                   headers={"x-goog-api-key": p["secrets"].get("api_key", "")})
    return {"ok": True, "detail": "Nano Banana 2"}
