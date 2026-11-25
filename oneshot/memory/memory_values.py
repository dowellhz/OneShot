"""Creative memory fields, media types, and reference token validation."""
from __future__ import annotations

from pathlib import Path
import hashlib
import json
import re

from aiohttp import web

from oneshot.generation.tools import story_scene_matches
from oneshot.memory import document_import


KINDS = {"character", "scene", "prop", "style", "document", "world"}
IMAGE_STORY_KINDS = {"world", "document"}
MEMORY_PROMPT_MARKER = "\n\n创作参考资料（仅作内容依据）："
IMAGE_STORY_PROMPT_MARKER = "\n\n本镜画面要求："
NAMED_REFERENCE = re.compile(r"@\{([A-Za-z0-9_-]{1,80})(?:#(main|face|side|back|detail))?\|([^{}\r\n@]{1,60})\}")
NUMBERED_AV_REFERENCE = re.compile(r"@(视频|音频|音)(\d+)")
CHARACTER_VIEW_LABELS = {"main":"标准主图", "face":"正面头肩", "side":"全身侧面", "back":"全身背面", "detail":"固定细节"}
CHARACTER_VIEWS = set(CHARACTER_VIEW_LABELS)
CHARACTER_FIELDS = {
    "code": "角色编号", "appearance": "外貌锚点", "hair": "发型",
    "costume": "默认服装", "details": "固定细节", "performance": "表演特征",
    "variation": "允许变化", "style": "正片风格",
}


def character_notes(asset, state=None):
    card = asset.get("character_card", {}) if asset["kind"] == "character" else {}
    notes = [f"{label}：{card[key]}" for key, label in CHARACTER_FIELDS.items()
             if card.get(key) and (key != "costume" or not (state and state.get("notes")))]
    if state and state.get("notes"):
        notes.append(f"本场状态（优先于默认设定）：{state['notes']}")
    return "；".join(notes)


def generation_context(asset, query, state=None):
    return {"name":asset["name"],"kind":asset["kind"],"desc":asset.get("desc") or "",
            "constraints":asset.get("constraints") or "","character_notes":character_notes(asset,state),
            "document_excerpt":document_import.passage(asset["document"],query) if asset.get("document") else ""}


def story_character_state(asset, query):
    states = asset.get("story_states", [])
    matches = [state for state in states if story_scene_matches([state["scene"]],query)]
    return max(matches, key=lambda state:len(state["scene"]), default=None)


def recorded_reference_slots(asset):
    if isinstance(asset.get("references"),list):
        return [(entry["view"],entry["ref"]) for entry in asset["references"]]
    return [(None,asset["ref"])] if asset.get("ref") else []


def validate_numbered_av_references(payload, tokens):
    if not tokens:
        return
    videos = payload.get("video_refs")
    sounds = payload.get("audio_refs")
    videos = (len(videos) if isinstance(videos,list) else 0) + bool(payload.get("previs_guide"))
    sounds = len(sounds) if isinstance(sounds,list) else 0
    limits = {"视频":videos,"音频":sounds,"音":sounds}
    for token in tokens:
        kind, number = token.groups()
        if number not in (str(index) for index in range(1,limits[kind]+1)):
            fail(f"提示词中的 {token[0]} 没有对应的参考素材，请重新选择")


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}


def generation_media_type(ref, media=None):
    suffix = Path(ref).suffix.lower()
    return "image" if suffix in IMAGE_EXT else "audio" if suffix in AUDIO_EXT or (media or {}).get("type") == "audio" else "video"


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def fail(message, status=400):
    cls = {400: web.HTTPBadRequest, 403: web.HTTPForbidden, 404: web.HTTPNotFound, 409: web.HTTPConflict,
           503: web.HTTPServiceUnavailable}.get(status, web.HTTPBadRequest)
    raise cls(text=dumps({"error": message}), content_type="application/json")


def text(value, limit=6000):
    if not isinstance(value, str):
        fail("记忆字段必须是文本")
    return value.strip()[:limit]


def view_selection_schema(prop):
    return prop("array", maxItems=8, items=prop("object", properties={
        "memory_id":prop("string", minLength=1, maxLength=80),
        "views":prop("array", minItems=1, maxItems=3, items=prop("string", enum=list(CHARACTER_VIEW_LABELS))),
    }, required=["memory_id","views"], additionalProperties=False),
    description="指定本次生成使用的已定稿角色视角；只填需要的视角，普通 @角色仍采用默认参考图")


def requested_views(value):
    if not isinstance(value, list) or len(value) > 8:
        fail("角色视角参数无效")
    result = {}
    for item in value:
        if not isinstance(item, dict) or set(item) != {"memory_id","views"}:
            fail("角色视角参数无效")
        mid, slots = item["memory_id"], item["views"]
        if (not isinstance(mid, str) or not 1 <= len(mid) <= 80 or mid in result
                or not isinstance(slots, list) or not 1 <= len(slots) <= 3
                or any(not isinstance(slot, str) or slot not in CHARACTER_VIEWS for slot in slots)
                or len(set(slots)) != len(slots)):
            fail("每个角色可选择 1–3 个不同的已定稿视角")
        result[mid] = slots
    return result


def view_tokens(content):
    result = {}
    for match in NAMED_REFERENCE.finditer(content):
        mid, view, _ = match.groups()
        if view:
            slots = result.setdefault(mid, [])
            if view not in slots:
                slots.append(view)
    return result


def generation_asset_key(assets):
    bindings = [[asset["id"],asset["mtime"],asset.get("ref"),asset.get("references",[])] for asset in assets]
    return hashlib.sha256(dumps(bindings).encode()).hexdigest()


def view_selections(views):
    return [{"memory_id":mid, "views":slots} for mid, slots in views.items()]


def mention_pattern(alias):
    return "@" + re.escape(alias) + (r"(?![A-Za-z0-9_])" if alias.isascii() else "")
