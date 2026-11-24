"""Compatibility endpoints for provider settings."""

import json
import os
import time

import aiohttp
from aiohttp import web

from oneshot.generation import rewriter
from oneshot.web import http as http_errors


LLM_PRESETS = {
    "deepseek": {"name": "DeepSeek", "base_url": "https://api.deepseek.com", "model": "deepseek-flash"},
    "local": {"name": "本机 DeepSeek", "base_url": "http://127.0.0.1:8080/v1", "model": "deepseek"},
}


def settings_load() -> dict:
    try:
        return json.loads(rewriter.SETTINGS.read_text())
    except Exception:
        return {}


def mask(k: str) -> str:
    return (k[:3] + "…" + k[-4:]) if k and len(k) > 10 else ("已设置" if k else "")


async def get_settings(_):
    r = dict(settings_load().get("llm") or {})
    r["api_key_masked"] = mask(r.pop("api_key", ""))
    return web.json_response({"llm": r, "presets": LLM_PRESETS})


async def put_settings(req):
    p = (await req.json()).get("llm") or {}
    s = settings_load()
    cur = s.get("llm") or {}
    new = {k: http_errors.clean(p.get(k)) for k in ("provider", "name", "base_url", "model")}
    new["enabled"] = bool(p.get("enabled"))
    new["api_key"] = http_errors.clean(p["api_key"]) if p.get("api_key") is not None else cur.get("api_key", "")   # omitted = keep
    if new["enabled"] and not (new["base_url"] and new["model"]):
        raise http_errors.bad("请填写接口地址和模型名")
    s["llm"] = new
    rewriter.SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = rewriter.SETTINGS.with_suffix(".tmp"); tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1)); os.chmod(tmp, 0o600); tmp.replace(rewriter.SETTINGS)
    return web.json_response({"ok": True})


async def test_settings(req):
    """Try the remote with a tiny request; also list its models when it can."""
    p = (await req.json()).get("llm") or {}
    cur = settings_load().get("llm") or {}
    cfg = {"name": http_errors.clean(p.get("name")) or "DeepSeek", "base_url": http_errors.clean(p.get("base_url")), "model": http_errors.clean(p.get("model")),
           "api_key": http_errors.clean(p["api_key"]) if p.get("api_key") else cur.get("api_key", "")}
    if not cfg["base_url"] or not cfg["model"]:
        raise http_errors.bad("请填写接口地址和模型名")
    t0 = time.time()
    try:
        out = await rewriter.remote_chat(req.app["http"], cfg, "只回复两个字：成功", "测试", max_tokens=16, temperature=0)
    except Exception as e:
        raise http_errors.bad(str(e) or e.__class__.__name__)
    models = []
    try:
        u = cfg["base_url"].rstrip("/") + ("/models" if cfg["base_url"].rstrip("/").endswith("/v1") or "deepseek.com" in cfg["base_url"] else "/v1/models")
        async with req.app["http"].get(u, headers={"Authorization": "Bearer " + cfg["api_key"]} if cfg["api_key"] else {},
                                       timeout=aiohttp.ClientTimeout(total=10)) as r:
            models = [m.get("id") for m in (await r.json(content_type=None)).get("data", []) if m.get("id")]
    except Exception:
        pass
    return web.json_response({"reply": out[:40], "seconds": round(time.time() - t0, 1), "models": models})
