"""Provider layer: every AI capability goes through here, local (this 4090) or a third-party API.

Capabilities: text (scripts, rewriting), vision (look at pictures), image (generate / edit with references),
video (text / first frame / references), tts (narration), music, asr (transcription).

A provider instance = a catalog kind + its config (base URL, model ids) + sealed secrets (API keys), stored in db.providers.
routes(capability) gives the order to try: the default first, then fallbacks. Local providers are always available
without configuration (they are seeded on first start).
"""
from __future__ import annotations

import base64
import io
import json
import re
import time
import uuid
from pathlib import Path

import aiohttp

import db
from motion_reference import public_origin

CAPS = {
    "text": "文本（剧本、改写、扩写）",
    "vision": "看图（反推、看图填写、拉片）",
    "image": "生图 / 改图",
    "video": "生视频",
    "tts": "配音",
    "music": "配乐",
    "sfx": "音效",
    "seed_audio": "参考音频生成",
    "asr": "语音转写（创作助手）",
    "search": "公开网页搜索",
}

# --------------------------------------------------------------------------- catalog
# fields: config the admin fills in. secret fields are sealed in db and never sent back in full.
# models: per capability, the model ids offered in the UI (first = default); the admin can type others.
CATALOG: dict[str, dict] = {
    "brave_search": {"label":"Brave Search", "group":"multi", "caps":["search"],
                     "models":{"search":["web"]}, "fields":[{"k":"api_key","t":"搜索 API Key","secret":True}],
                     "desc":"用于创作助手搜索公开网页；支持限定站点及最近一天、一周、一月或一年。"},
    "local_h3": {"label": "本地 H3（4090）", "group": "local", "caps": ["image", "video"],
                 "models": {"image": ["h3-image"], "video": ["h3-video"]}, "fields": [],
                 "desc": "MiniMax H3 视频 + H3-Image，跑在这台 4090 上，不花钱，排队用 GPU"},
    "local_qwen": {"label": "本地 Qwen3.5-9B", "group": "local", "caps": ["text", "vision"],
                   "models": {"text": ["qwen3.5-9b"], "vision": ["qwen3.5-9b"]}, "fields": [],
                   "desc": "llama.cpp 按需启动；GPU 空闲时约 6 秒，生成视频时退到 CPU，较慢"},
    "local_kokoro": {"label": "本地 Kokoro 配音", "group": "local", "caps": ["tts"],
                     "models": {"tts": ["kokoro-82m-zh"]}, "fields": [],
                     "desc": "CPU 运行，每句约 1 秒，12 种中文声音"},
    "deepseek": {"label": "DeepSeek", "group": "llm", "caps": ["text", "vision"],
                 "models": {"text": ["deepseek-flash", "deepseek-v4-pro"], "vision": ["deepseek-flash"]},
                 "fields": [{"k": "base_url", "t": "接口地址", "default": "https://api.deepseek.com"},
                            {"k": "api_key", "t": "API Key", "secret": True, "hint": "platform.deepseek.com 创建"}],
                 "desc": "deepseek-flash 又快又便宜，也能看图；deepseek-v4-pro 更强（只能文本）"},
    "dashscope": {"label": "阿里云百炼（通义千问 / 万相）", "group": "multi", "caps": ["text", "vision", "image", "video"],
                  "models": {"text": ["qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"], "vision": ["qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"],
                             "image": ["wan2.7-image", "wan2.7-image-pro"], "video": []},
                  "fields": [{"k": "region", "t": "地域", "options": {"cn": "中国（北京）", "intl": "国际（新加坡）"}, "default": "cn"},
                             {"k": "api_key", "t": "API Key", "secret": True, "hint": "百炼控制台 → API-KEY"}],
                  "desc": "千问能看图，可以替代本地 Qwen 做反推、拉片"},
    "openai": {"label": "OpenAI", "group": "multi", "caps": ["text", "vision", "image"],
               "models": {"text": ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"], "vision": ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"], "image": ["gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-1.5"]},
               "fields": [{"k": "base_url", "t": "接口地址", "default": "https://api.openai.com/v1"},
                          {"k": "api_key", "t": "API Key", "secret": True}],
               "desc": "需要能访问 OpenAI 的网络"},
    "openai_compat": {"label": "OpenAI 兼容接口（Kimi / 智谱 / 本机 DeepSeek 等）", "group": "llm", "caps": ["text", "vision"],
                      "models": {"text": [], "vision": []},
                      "fields": [{"k": "base_url", "t": "接口地址", "hint": "例如 https://api.moonshot.cn/v1"},
                                 {"k": "api_key", "t": "API Key", "secret": True, "optional": True},
                                 {"k": "vision", "t": "模型能看图", "options": {"no": "不能", "yes": "能"}, "default": "no"}],
                      "desc": "任何兼容 /v1/chat/completions 的服务"},
    "asr_compat": {"label": "OpenAI 兼容语音转写", "group": "audio", "caps": ["asr"],
                   "models": {"asr": ["gpt-transcribe", "whisper-1", "gpt-4o-transcribe-diarize"]},
                   "fields": [{"k": "base_url", "t": "接口地址", "hint": "例如 https://api.openai.com/v1"},
                              {"k": "api_key", "t": "API Key", "secret": True, "optional": True}],
                   "desc": "兼容 /v1/audio/transcriptions 的本地或云端语音转写服务"},
    "elevenlabs": {"label": "ElevenLabs 语音与音效", "group": "audio", "caps": ["tts","sfx"],
                   "models": {"tts": ["eleven_multilingual_v2","eleven_v3","eleven_v4"],
                              "sfx": ["eleven_text_to_sound_v3"]},
                   "fields": [{"k": "api_key", "t": "API Key", "secret": True},
                              {"k": "voices", "t": "配音音色（可选）", "hint": "音色ID=名称，多个用逗号分隔"}],
                   "desc": "生成旁白、对白、环境音和拟音。填写音色 ID 后启用配音。"},
    "volc_seed_audio": {"label": "火山 Seed Audio", "group": "audio", "caps": ["seed_audio"],
                        "models":{"seed_audio":["seed-audio-1.0"]},
                        "fields":[{"k":"api_key","t":"豆包语音 API Key","secret":True}],
                        "desc":"支持文本配音、参考音频和参考图，使用豆包语音控制台的 API Key。"},
    "kling": {"label": "可灵 Kling", "group": "video", "caps": ["video"],
              "models": {"video": ["kling-4.0", "kling-4.0-flash", "kling-3.0-turbo", "kling-3.0", "kling-2.6"]},
              "fields": [{"k": "region", "t": "地域", "options": {"cn": "中国 api-beijing", "intl": "国际 api-singapore"}, "default": "cn"},
                         {"k": "api_key", "t": "API Key", "secret": True, "hint": "可灵开放平台控制台创建（只显示一次）"}],
              "desc": "4.0 最长 30 秒、1080p，自带音频；参考图走 Omni 接口"},
    "minimax": {"label": "MiniMax（云端 H3 / 语音 / 音乐）", "group": "multi", "caps": ["video", "tts", "music"],
                "models": {"video": ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"],
                           "tts": ["speech-2.8-hd", "speech-2.8-turbo"], "music": ["music-3.0"], "image": []},
                "fields": [{"k": "region", "t": "地域", "options": {"cn": "中国 api.minimax.cn", "intl": "国际 api.minimax.io"}, "default": "cn"},
                           {"k": "api_key", "t": "API Key", "secret": True}],
                "desc": "云端 H3（和本地同一个模型，最高 2K）、自然的中文配音、AI 配乐（音乐接口不再向新账号开放）"},
    "ark": {"label": "火山方舟（即梦 Seedance / Seedream）", "group": "multi", "caps": ["video", "image"],
            "models": {"video": ["doubao-seedance-2-5-260628", "doubao-seedance-2-5-flash-261115", "doubao-seedance-2-0-fast-260128"], "image": ["doubao-seedream-5-5-261028", "doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro-260628"], "text": [], "vision": []},
            "fields": [{"k": "base_url", "t": "接口地址", "default": "https://ark.cn-beijing.volces.com/api/v3"},
                       {"k": "api_key", "t": "API Key", "secret": True},
                       {"k": "motion_origin", "t": "参考视频公网地址（可选）", "hint": "填方舟可访问的 OneShot HTTPS 站点根地址"}],
            "desc": "即梦 Seedance 2.5 视频（带音频，最长 30 秒）与 Seedream 生图"},
}

LOCAL_SEED = [("local_h3", "本地 H3"), ("local_qwen", "本地 Qwen"), ("local_kokoro", "本地配音")]


class ProviderError(RuntimeError):
    pass


# --------------------------------------------------------------------------- storage

def seed():
    """Local providers always exist; default routes point at them (and DeepSeek if it was set up before)."""
    for kind, name in LOCAL_SEED:
        if not db.one("SELECT id FROM providers WHERE id=?", kind):
            db.run("INSERT INTO providers (id, kind, name, config, enabled, created, updated) VALUES (?,?,?,?,1,?,?)",
                   kind, kind, name, "{}", time.time(), time.time())
    defaults = {"text": "local_qwen", "vision": "local_qwen", "image": "local_h3", "video": "local_h3", "tts": "local_kokoro"}
    for cap, pid in defaults.items():
        if not db.one("SELECT 1 FROM routes WHERE capability=?", cap):
            db.run("INSERT INTO routes VALUES (?,?,?,?)", cap, 0, pid, CATALOG[pid]["models"][cap][0])


def migrate_settings(settings_path: Path):
    """The earlier AI 设置 (data/settings.json, one remote LLM) becomes a provider + the first text route."""
    try:
        s = json.loads(settings_path.read_text()).get("llm") or {}
    except Exception:
        return
    if not s.get("base_url") or db.one("SELECT id FROM providers WHERE id='migrated_llm'"):
        return
    kind = "deepseek" if "deepseek.com" in s["base_url"] else "openai_compat"
    if s.get("model") in ("deepseek-chat", "deepseek-reasoner"):   # retired 2026-07-24
        s["model"] = "deepseek-flash"
    db.run("INSERT INTO providers (id, kind, name, config, secret, enabled, created, updated) VALUES (?,?,?,?,?,?,?,?)",
           "migrated_llm", kind, s.get("name") or ("DeepSeek" if kind == "deepseek" else "自定义模型"),
           json.dumps({"base_url": s["base_url"], "model": s.get("model")}), db.seal({"api_key": s.get("api_key", "")}),
           1, time.time(), time.time())
    if s.get("enabled"):
        set_route("text", [{"provider_id": "migrated_llm", "model": s.get("model")}, {"provider_id": "local_qwen", "model": "qwen3.5-9b"}])
    settings_path.rename(settings_path.with_suffix(".json.migrated"))


def get(pid: str) -> dict | None:
    r = db.one("SELECT * FROM providers WHERE id=?", pid)
    if not r:
        return None
    r["config"] = json.loads(r["config"] or "{}")
    r["secrets"] = db.unseal(r.pop("secret"))
    return r


def public(r: dict) -> dict:
    cat = CATALOG.get(r["kind"], {})
    out = {k: r[k] for k in ("id", "kind", "name", "enabled", "created", "updated")}
    out["config"] = r["config"]
    out["secrets"] = {k: db.mask(v) for k, v in (r.get("secrets") or {}).items()}
    out["caps"] = caps_of(r)
    out["group"] = cat.get("group")
    out["label"] = cat.get("label")
    return out


def caps_of(r: dict) -> list[str]:
    cat = CATALOG.get(r["kind"], {})
    caps = list(cat.get("caps", []))
    if r["kind"] == "openai_compat" and (r.get("config") or {}).get("vision") != "yes":
        caps = [c for c in caps if c != "vision"]
    if r["kind"] == "elevenlabs" and not (r.get("config") or {}).get("voices"):
        caps.remove("tts")
    return caps


def elevenlabs_voices(value):
    entries = re.split(r"[,，\n]+", value)
    voices = {}
    for entry in entries:
        if not entry.strip():
            continue
        voice_id, _, label = entry.partition("=")
        voice_id = voice_id.strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", voice_id) or voice_id in voices:
            raise ProviderError("请填写有效且不重复的 ElevenLabs 音色 ID")
        voices[voice_id] = (label.strip() or voice_id)[:60]
    if len(voices) > 30:
        raise ProviderError("每个 ElevenLabs 服务最多配置 30 个音色")
    return [{"id":voice_id,"name":label} for voice_id,label in voices.items()]


def all_providers() -> list[dict]:
    out = []
    for row in db.q("SELECT id FROM providers ORDER BY created"):
        p = get(row["id"])
        if p:
            out.append(p)
    return out


def save(pid: str | None, kind: str, name: str, config: dict, secrets: dict, enabled: bool) -> str:
    if kind not in CATALOG or CATALOG[kind]["group"] == "local":
        raise ProviderError("不能添加这种服务")
    cat = CATALOG[kind]
    conf = {}
    for f in cat["fields"]:
        if f.get("secret"):
            continue
        v = config.get(f["k"], f.get("default"))
        if v is not None:
            conf[f["k"]] = str(v).strip()
    for k in ("models",):                       # admin-chosen model ids per capability
        if isinstance(config.get(k), dict):
            conf[k] = {c: str(m).strip() for c, m in config[k].items() if c in CAPS and str(m).strip()}
    if kind == "ark":
        try:
            conf["motion_origin"] = public_origin(conf.get("motion_origin"))
        except ValueError as e:
            raise ProviderError(str(e)) from None
    if kind == "elevenlabs":
        conf["voices"] = ",".join(f"{voice['id']}={voice['name']}" for voice in elevenlabs_voices(conf.get("voices", "")))
    old = get(pid) if pid else None
    sec = dict(old["secrets"]) if old else {}
    for f in cat["fields"]:
        if f.get("secret") and secrets.get(f["k"]):
            sec[f["k"]] = secrets[f["k"]].strip()
    pid = pid or f"{kind}_{uuid.uuid4().hex[:6]}"
    db.run("INSERT OR REPLACE INTO providers (id, kind, name, config, secret, enabled, created, updated) VALUES (?,?,?,?,?,?,?,?)",
           pid, kind, (name or cat["label"]).strip()[:40], json.dumps(conf, ensure_ascii=False), db.seal(sec),
           1 if enabled else 0, old["created"] if old else time.time(), time.time())
    return pid


def delete(pid: str):
    if pid.startswith("local_"):
        raise ProviderError("本地服务不能删除，可以在路由里不用它")
    db.run("DELETE FROM providers WHERE id=?", pid)
    db.run("DELETE FROM routes WHERE provider_id=?", pid)


def routes(cap: str) -> list[dict]:
    """[{provider (full row), model}] in try order, enabled providers only."""
    out = []
    for r in db.q("SELECT * FROM routes WHERE capability=? ORDER BY rank", cap):
        p = get(r["provider_id"])
        if p and p["enabled"] and cap in caps_of(p):
            out.append({"provider": p, "model": r["model"] or default_model(p, cap)})
    return out


def set_route(cap: str, items: list[dict]):
    if cap not in CAPS:
        raise ProviderError("未知能力")
    db.run("DELETE FROM routes WHERE capability=?", cap)
    for i, it in enumerate(items[:5]):
        db.run("INSERT INTO routes VALUES (?,?,?,?)", cap, i, it["provider_id"], (it.get("model") or "").strip() or None)


def default_model(p: dict, cap: str) -> str | None:
    m = ((p.get("config") or {}).get("models") or {}).get(cap)
    if m:
        return m
    lst = CATALOG.get(p["kind"], {}).get("models", {}).get(cap) or []
    return lst[0] if lst else (p.get("config") or {}).get("model")


def primary(cap: str) -> dict | None:
    r = routes(cap)
    return r[0] if r else None


# --------------------------------------------------------------------------- helpers shared by adapters

def data_url(path: Path, max_side: int = 1536, quality: int = 90, *, min_side: int = 0) -> str:
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if min_side and min(im.size) < min_side:
        scale = min_side / min(im.size)
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


class ChatStreamUnsupported(ProviderError):
    pass


async def read_chat_stream(content, progress):
    message = {"role":"assistant","content":"","reasoning_content":""}
    calls, packet = {}, []
    pending_size = 0
    finished = False
    async for line in content:
        line = line.rstrip(b"\r\n")
        if line.startswith(b"data:"):
            pending_size += len(line)
            if pending_size > 512_000:
                raise ProviderError("模型流式数据过长")
            packet.append(line[5:].lstrip(b" "))
            continue
        if line or not packet:
            continue
        data = b"\n".join(packet)
        packet.clear()
        pending_size = 0
        if data == b"[DONE]":
            finished = True
            break
        chunk = json.loads(data)
        if chunk.get("error"):
            raise ProviderError("模型流式回复中断")
        for choice in chunk.get("choices") or []:
            if choice.get("index",0) != 0:
                continue
            delta = choice.get("delta") or {}
            for key in ("content","reasoning_content"):
                if isinstance(fragment := delta.get(key),str):
                    message[key] += fragment
                    if len(message[key]) > 128_000:
                        raise ProviderError("模型回复过长")
                    if key=="content":
                        progress(message[key])
            for piece in delta.get("tool_calls") or []:
                index = piece.get("index")
                if type(index) is not int or not 0 <= index < 8:
                    raise ProviderError("模型流式工具编号无效")
                call = calls.setdefault(index,{"id":"","type":"function","function":{"name":"","arguments":""}})
                call["id"] += piece.get("id") or ""
                if len(call["id"])>200 or piece.get("type") not in (None,"function"):
                    raise ProviderError("模型流式工具格式无效")
                for field, fragment in (piece.get("function") or {}).items():
                    if field in call["function"] and isinstance(fragment,str):
                        call["function"][field] += fragment
                        if len(call["function"][field])>20_000:
                            raise ProviderError("模型流式工具参数过长")
            if choice.get("finish_reason"):
                if choice["finish_reason"]=="length":
                    raise ProviderError("模型流式回复达到长度上限")
                finished = True
    if not finished:
        raise ProviderError("模型未完成流式回复")
    if calls:
        message["tool_calls"] = [calls[index] for index in sorted(calls)]
    return {"choices":[{"message":message}]}


async def json_req(http: aiohttp.ClientSession, method: str, url: str, who: str, *, chat_progress=None, **kw) -> dict:
    kw.setdefault("timeout", aiohttp.ClientTimeout(total=180))
    try:
        async with http.request(method, url, **kw) as r:
            if chat_progress is not None and r.status < 400 and r.content_type == "text/event-stream":
                return await read_chat_stream(r.content,chat_progress)
            text = await r.text()
            try:
                j = json.loads(text) if text else {}
            except ValueError:
                j = {"raw": text[:300]}
            if r.status >= 400:
                if chat_progress is not None and (r.status in (405,415,501) or
                        r.status in (400,422) and "stream" in _errmsg(j).casefold()):
                    raise ChatStreamUnsupported("模型接口不支持流式回复")
                raise ProviderError(f"{who} 返回错误（{r.status}）：{_errmsg(j)}")
            return j
    except aiohttp.ClientError as e:
        raise ProviderError(f"连不上 {who}：{e.__class__.__name__} {e}")


def _errmsg(j) -> str:
    if isinstance(j, dict):
        e = j.get("error") or j.get("message") or j.get("base_resp") or j.get("msg") or j
        if isinstance(e, dict):
            e = e.get("message") or e.get("status_msg") or e.get("code") or e
        return str(e)[:300]
    return str(j)[:300]


async def download(http: aiohttp.ClientSession, url: str, dst: Path, who: str):
    try:
        async with http.get(url, timeout=aiohttp.ClientTimeout(total=600)) as r:
            if r.status >= 400:
                raise ProviderError(f"下载 {who} 的结果失败（{r.status}）")
            with open(dst, "wb") as f:
                async for chunk in r.content.iter_chunked(1 << 16):
                    f.write(chunk)
    except aiohttp.ClientError as e:
        raise ProviderError(f"下载 {who} 的结果失败：{e}")


# --------------------------------------------------------------------------- text / vision (OpenAI-compatible)

def llm_endpoint(p: dict) -> tuple[str, dict]:
    k, c, s = p["kind"], p["config"], p["secrets"]
    if k == "deepseek":
        base = c.get("base_url") or "https://api.deepseek.com"
    elif k == "dashscope":
        base = "https://dashscope.aliyuncs.com/compatible-mode/v1" if c.get("region", "cn") == "cn" else "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    elif k == "ark":
        base = c.get("base_url") or "https://ark.cn-beijing.volces.com/api/v3"
    else:
        base = c.get("base_url") or ""
    base = base.rstrip("/")
    url = base + "/chat/completions" if base.endswith(("/v1", "/v3", "compatible-mode/v1")) or "deepseek.com" in base else base + "/v1/chat/completions"
    h = {"Content-Type": "application/json"}
    if s.get("api_key"):
        h["Authorization"] = "Bearer " + s["api_key"]
    return url, h


async def chat(http, p: dict, model: str, system: str, content, max_tokens=2000, temperature=0.6) -> str:
    import re
    url, h = llm_endpoint(p)
    vision = isinstance(content, list) and any(x.get("type") == "image_url" for x in content if isinstance(x, dict))
    user = content if vision else (content if isinstance(content, str) else "\n".join(x.get("text", "") for x in content if isinstance(x, dict)))
    body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "stream": False}
    if p["kind"] == "openai":
        body["max_completion_tokens"] = max(max_tokens, 4000)   # counts reasoning tokens too
        body["reasoning_effort"] = "low"
    elif p["kind"] == "dashscope":
        body["max_completion_tokens"] = max_tokens
        body["enable_thinking"] = False
        body["temperature"] = temperature
    else:
        body["max_tokens"] = max_tokens
        body["temperature"] = temperature
        if p["kind"] == "deepseek":
            body["thinking"] = {"type": "disabled"}             # on by default for V4.1; we want speed
    j = await json_req(http, "POST", url, p["name"], json=body, headers=h, timeout=aiohttp.ClientTimeout(total=300))
    try:
        text = j["choices"][0]["message"].get("content") or ""
    except Exception:
        raise ProviderError(f"{p['name']} 返回格式不对：{_errmsg(j)}")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


async def transcribe(http, p: dict, model: str, audio: bytes, extension: str, content_type: str, *, timed=False):
    base = p["config"].get("base_url", "").rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise ProviderError("请填写语音转写接口地址")
    if not base.endswith("/v1"):
        base += "/v1"
    key = p["secrets"].get("api_key")
    headers = {"Authorization": "Bearer " + key} if key else {}
    form = aiohttp.FormData()
    form.add_field("model", model)
    form.add_field("file", audio, filename="voice" + extension, content_type=content_type)
    if timed:
        if "transcribe-diarize" in model:
            form.add_field("response_format", "diarized_json")
            form.add_field("chunking_strategy", "auto")
        else:
            form.add_field("response_format", "verbose_json")
            if model == "whisper-1":
                form.add_field("timestamp_granularities[]", "segment")
    try:
        async with http.post(base + "/audio/transcriptions", data=form, headers=headers,
                             timeout=aiohttp.ClientTimeout(total=90), allow_redirects=False) as response:
            if response.status != 200:
                raise ProviderError(f"语音转写服务返回 HTTP {response.status}")
            payload = await response.json()
    except (aiohttp.ClientError, TimeoutError, ValueError) as e:
        raise ProviderError("语音转写服务连接失败或返回格式异常") from e
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise ProviderError("语音转写服务缺少文本结果")
    if timed:
        if not isinstance(payload.get("segments"), list) or (not payload["segments"] and payload["text"].strip()):
            raise ProviderError("语音转写服务未返回时间码")
        return payload["segments"]
    return payload["text"].strip()[:8000]


async def test(http, p: dict) -> dict:
    """Cheapest real call per kind; returns {ok, detail}."""
    t0 = time.time()
    k = p["kind"]
    caps = caps_of(p)
    if k.startswith("local_"):
        return {"ok": True, "detail": "本地服务"}
    if "asr" in caps:
        import wave
        sample = io.BytesIO()
        with wave.open(sample, "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", ""))
            wav.writeframes(bytes(16000 * 2))
        model = default_model(p, "asr")
        await transcribe(http, p, model, sample.getvalue(), ".wav", "audio/wav")
        return {"ok": True, "detail": f"{model} 转写接口可用"}
    if "text" in caps or "vision" in caps:
        cap = "text" if "text" in caps else "vision"
        model = default_model(p, cap)
        if not model:
            raise ProviderError("先填写模型名")
        out = await chat(http, p, model, "只回复两个字：成功", "测试", max_tokens=16, temperature=0)
        return {"ok": True, "detail": f"{model} 回复「{out[:20]}」，{time.time() - t0:.1f}s"}
    import remote
    return await remote.test(http, p)
