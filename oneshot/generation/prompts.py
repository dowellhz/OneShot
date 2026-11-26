"""Prompt rewriting and storyboard, description, and analysis endpoints."""

import asyncio
import json
import os
import re
import time

from aiohttp import web

from engine import h3_int8
from oneshot import config
from oneshot.generation import fields as pfields
from oneshot.generation import graphs
from oneshot.generation import rewriter
from oneshot.generation import tools
from oneshot.memory import legacy_routes
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


def apply_fields(p: dict, for_llm: bool = False) -> dict:
    """Video nodes filled in field by field: merge the fields into prompt / sound / music."""
    f = p.get("fields")
    if p.get("kind", "video") != "video" or not isinstance(f, dict):
        return p
    if not pfields.has_content(f):
        raise web.HTTPBadRequest(text=json.dumps({"error": "至少填写场景、动作或对话中的一项"}, ensure_ascii=False), content_type="application/json")
    # character references: match 人物 names to the reference images (image node name / caption, or 1 person ↔ 1 image)
    subj, imgs = {}, [dict(im) for im in (p.get("images") or [])]
    if p.get("planned"):
        ppl = pfields.people(f)
        refs = [im for im in imgs if im.get("role") == "subject"][:9]
        for im in refs:   # a named character image (e.g. from the asset library) counts even if 人物 doesn't list it
            if not graphs.is_character_reference(im):
                continue
            canonical = http_errors.clean(im.get("memory_name"))
            nm = canonical or (im.get("name") or "").strip()
            if canonical or (nm and not re.fullmatch(r"(图片|image)\s*\d+.*", nm, re.I) and not any(n in nm for n in ppl)):
                ppl.setdefault(nm, http_errors.clean(im.get("caption")) or "the character in the reference image")
        for k, im in enumerate(refs):
            if not graphs.is_character_reference(im):
                continue
            label = f"{im.get('name') or ''} {im.get('caption') or ''}"
            hit = http_errors.clean(im.get("memory_name")) or next((n for n in ppl if n in label), None)
            if hit is None and len(ppl) == 1 and len(refs) == 1:
                hit = next(iter(ppl))
            if hit and hit not in subj:
                subj[hit] = k + 1
                im["caption"] = f"{hit}, {ppl[hit]}"
                voice = http_errors.clean(next((a.get("voice") for a in legacy_routes.lib_load() if a.get("id") == im.get("asset")), "") if im.get("asset") else "")
                if voice and voice not in (f.get("people") or ""):
                    f = dict(f)
                    lines = (f.get("people") or "").splitlines()
                    at = next((i for i, ln in enumerate(lines) if re.match(rf"\s*{re.escape(hit)}\s*[:：]", ln)), None)
                    if at is None:
                        lines.append(f"{hit}：{ppl[hit]}，声音：{voice}")
                    else:
                        lines[at] = lines[at].rstrip("。.，, ") + f"，声音：{voice}"
                    f["people"] = "\n".join(lines)
    if for_llm:
        prompt, snd, mus = pfields.for_rewriter(f, p.get("prompt") or "", subj), pfields._one(f.get("sound")), pfields._one(f.get("music"))
    else:
        prompt, snd, mus = pfields.compose(f, p.get("prompt") or "", subj)
    return {**p, "prompt": prompt, "sound": snd, "music": mus, "images": imgs}


_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")


_DBLOCK = re.compile(r"<d>.*?</d>", re.S)


_IMAGE_MENTION = re.compile(r"@图(\d+)")


_MARKS = re.compile(r"<(?:Picture|Subject|Video|Audio) \d+>|\(S\d+(?:,S\d+)*\)|<d>.*?</d>|@图\d+", re.S)


_TIMED_LINES = re.compile(rf"^[ \t]*({pfields.ACTION_TIME.pattern})", re.M)


XLATE_FILE = config.DATA_DIR / "xlate_cache.json"


try:
    _XLATE_CACHE: dict = json.loads(XLATE_FILE.read_text())
except Exception:
    _XLATE_CACHE = {}


XLATE_SYSTEM = """You translate the parts of a video-generation prompt from Chinese into natural, concrete English.
Input: a JSON object. Output: ONLY a JSON object with exactly the same keys and the same list lengths, every value translated.
Rules:
- Translate faithfully; do not add, drop or reorder actions, objects, counts, positions or constraints.
- Copy these verbatim, unchanged: every <d>...</d> block including its content and [Language] tag, every @图N image mention, every <Picture N>, <Subject N>, <Video N>, <Audio N>, and every speaker ID such as (S1).
- Copy each time range marker such as 0–0.5 s: exactly as written. Keep every line beginning with a time range on its own line and in the original order.
- Text that appears in double quotation marks as visible on-screen text stays as it is.
- Write descriptions, not speech. Use plain prose; no markdown, no explanations."""


def _needs_english(t: str) -> bool:
    return bool(t) and bool(_CJK.search(_IMAGE_MENTION.sub("", _DBLOCK.sub("", t))))


async def to_english(app, p: dict, *, local_only=False) -> dict:
    """H3's prompt format is English except dialogue/lyrics in <d> and visible text. Translate the rest before generation."""
    if p.get("kind", "video") != "video":
        return p
    prompt = p.get("prompt") or ""
    structured = any(k in prompt for k in ("subject_definitions:", "integrated_multimodal_description:"))
    src = {}
    if not structured and _needs_english(prompt):
        src["prompt"] = prompt
    for k in ("sound", "music"):
        if _needs_english(p.get(k) or ""):
            src[k] = p[k]
    imgs = [dict(im) for im in (p.get("images") or [])]
    caps = [i for i, im in enumerate(imgs) if _needs_english(im.get("caption") or "")]
    if caps:
        src["captions"] = [imgs[i]["caption"] for i in caps]
    if not src:
        return p
    key = json.dumps(src, ensure_ascii=False, sort_keys=True)
    if local_only:
        key = "local:" + key
    if any(_IMAGE_MENTION.search(value) for entry in src.values() for value in (entry if isinstance(entry, list) else [entry])):
        key = "image-mentions:" + key
    if pfields.ACTION_TIME.search(src.get("prompt", "")):
        key = "action-timing:" + key
    out = _XLATE_CACHE.get(key)
    if out is None:
        llm = app["llm"]
        available = llm.local_vision_available if local_only else llm.available
        if not available():
            return {**p, "_xlate_err": "没有可用的文本模型"}
        try:
            chat = llm.local_vision if local_only else llm.chat
            text = await chat(XLATE_SYSTEM, json.dumps(src, ensure_ascii=False, indent=1), max_tokens=4000, temperature=0.2)
            text = rewriter.strip_fences(text)
            out = json.loads(text[text.index("{"): text.rindex("}") + 1])
            for k, v in src.items():
                o = out.get(k)
                if k == "captions":
                    if not isinstance(o, list) or len(o) != len(v):
                        raise ValueError("captions mismatch")
                    o = [str(x) for x in o]
                    out[k] = o
                elif not isinstance(o, str) or not o.strip():
                    raise ValueError(f"{k} missing")
                for a, b in (zip(v, o) if k == "captions" else [(v, o)]):
                    if sorted(_MARKS.findall(a)) != sorted(_MARKS.findall(b)):
                        raise ValueError(f"{k}: markers or <d> blocks changed")
                    if (pfields.ACTION_TIME.findall(a) != pfields.ACTION_TIME.findall(b)
                            or _TIMED_LINES.findall(a) != _TIMED_LINES.findall(b)):
                        raise ValueError(f"{k}: action timing changed")
                    if _needs_english(b):
                        raise ValueError(f"{k}: still Chinese")
        except Exception as e:
            print(f"to_english failed: {e}", flush=True)
            return {**p, "_xlate_err": str(e)[:200]}
        if len(_XLATE_CACHE) > 500:
            for k in list(_XLATE_CACHE)[:100]:
                del _XLATE_CACHE[k]
        _XLATE_CACHE[key] = out
        try:
            tmp = XLATE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_XLATE_CACHE, ensure_ascii=False))
            os.replace(tmp, XLATE_FILE)
        except Exception as e:
            print(f"xlate cache save failed: {e}", flush=True)
    q = {**p}
    for k in ("prompt", "sound", "music"):
        if k in src:
            q[k] = out[k]
    for i, c in zip(caps, out.get("captions", [])):
        imgs[i]["caption"] = c
    q["images"] = imgs
    return q


async def rewrite(req):
    raw = await req.json()
    int8 = raw.get("provider") == "local_h3" and raw.get("selected_model") == h3_int8.MODEL
    p = apply_fields(graphs.int8_video_input(raw) if int8 else raw, for_llm=True)
    if not http_errors.clean(p.get("prompt")):
        raise web.HTTPBadRequest(text=json.dumps({"error": "先写一段描述"}, ensure_ascii=False), content_type="application/json")
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    if p.get("planned"):
        p["end"] = ((graphs.engine_video_frames(seconds) if int8 else graphs.frames_for(seconds)) - 4) / 24
    else:
        p["end"] = seconds
    t0 = time.time()
    try:
        r = await rewriter.rewrite_video(req.app["llm"], config.COMFY_DIR, p)
    except Exception as e:
        raise web.HTTPBadRequest(text=json.dumps({"error": str(e)}, ensure_ascii=False), content_type="application/json")
    r["seconds"] = round(time.time() - t0, 1)
    return web.json_response(r)


async def storyboard(req):
    p = await req.json()
    if not http_errors.clean(p.get("story")):
        raise http_errors.bad("先写一段剧情")
    candidates = req.app["creative_memory"].storyboard_assets(req["user"],p["board"],p["story"]) if p.get("board") else []
    return await http_errors.llm_call(req, tools.storyboard(req.app["llm"], config.COMFY_DIR, p["story"], p.get("refs") or [], p.get("shots"),
                                                p.get("seconds"), http_errors.clean(p.get("style")), p.get("aspect") or "16:9", p.get("target_seconds"),
                                                **({"motion_frames":True} if p.get("motion_frames") is True else {}),
                                                **({"prepare_assets":True} if p.get("prepare_assets") is True else {}),
                                                **({"asset_candidates":candidates} if candidates else {})))


async def describe(req):
    p = await req.json()
    if not p.get("images"):
        raise http_errors.bad("没有图片")
    return await http_errors.llm_call(req, tools.describe(req.app["llm"], config.COMFY_DIR, p["images"], p.get("mode") or "prompt"))


async def analyze(req):
    """拉片: cut the video into shots, then describe each one."""
    p = await req.json()
    try:
        cut = await asyncio.get_running_loop().run_in_executor(None, tools.find_shots, config.COMFY_DIR, p["ref"], int(p.get("max_shots") or 12))
    except Exception as e:
        raise http_errors.bad(f"切分镜头失败：{e}")
    media_routes.grant_media(req["user"], *media_routes.media_references(cut))
    return await http_errors.llm_call(req, tools.analyze_shots(req.app["llm"], config.COMFY_DIR, cut))
