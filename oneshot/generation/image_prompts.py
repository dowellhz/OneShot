"""Compile image reference roles and keep a reviewed prompt stable until submission."""

from collections import OrderedDict
from hashlib import sha256
import json
import re
from time import monotonic
from uuid import uuid4

from engine import image_models
from oneshot import config
from oneshot.generation import graphs, rewriter
from oneshot.memory.memory_values import IMAGE_STORY_PROMPT_MARKER, MEMORY_PROMPT_MARKER
from oneshot.web import http as http_errors

REFERENCE_USES = {
    "source": "作为原图，保留本次编辑未要求修改的可见内容",
    "composition": "仅参考机位、透视、画面布局和主体站位",
    "camera": "仅参考机位、透视和景别，人物和道具的位置以画面描述为准",
    "character": "仅参考指定角色的身份、外貌和服装",
    "scene": "仅参考场景空间、环境材质和光线",
    "prop": "仅参考指定道具的形状、材质和配色",
    "style": "仅参考画面风格、色调和质感",
    "reference": "按画面描述中指定的用途参考",
}
_IMAGE_MENTION = re.compile(r"@(?:图片|图)(\d+)")
_QUOTED_TEXT = re.compile(r'“([^”]+)”|"([^"]+)"|「([^」]+)」')
_TEXT_OPTIONS = {
    "none": "画面中没有可见文字、字幕、字母或数字。",
    "specified": "仅呈现画面描述明确指定的文字，原样保留语言、拼写、数字和行序，不添加其他文字。",
}
_PREVIEW_LIMIT = 64
_PREVIEW_SECONDS = 600


def image_use(image):
    explicit = image.get("image_use")
    if explicit is not None:
        if not isinstance(explicit, str) or explicit not in REFERENCE_USES:
            raise http_errors.bad("图片参考用途无效")
        return explicit
    kind = image.get("memory_kind")
    if kind in ("character", "scene", "prop", "style"):
        return kind
    return "character" if image.get("story_cast") else "reference"


def reference_instructions(payload):
    instructions = []
    for index, image in enumerate(payload.get("images") or [], 1):
        use = image_use(image)
        if use == "reference":
            continue
        name = http_errors.clean(image.get("memory_name") or image.get("name"))[:80]
        binding = f"（{name}）" if name and use in ("character", "prop") else ""
        instructions.append(f"@图{index}{binding}：{REFERENCE_USES[use]}。")
    return instructions


def compose(payload):
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise http_errors.bad("提示词不能为空")
    instructions = reference_instructions(payload)
    policy = payload.get("image_text", "auto")
    if not isinstance(policy, str) or policy not in ("auto", *_TEXT_OPTIONS):
        raise http_errors.bad("画面文字设置无效")
    if instructions:
        prompt += "\n\n参考图用途\n" + "\n".join(instructions)
    if policy != "auto":
        prompt += "\n\n" + _TEXT_OPTIONS[policy]
    return prompt


def picture_labels(prompt):
    return _IMAGE_MENTION.sub(r"<Picture \1>", prompt)


def remote_labels(prompt):
    return _IMAGE_MENTION.sub(r"图\1", prompt)


def route_identity(route, payload):
    if route:
        return route["provider"]["id"], route["provider"]["kind"], route["model"]
    return None, "local_h3", payload.get("model", "h3img")


async def prepare(app, payload, route, *, review=False):
    _, adapter, model = route_identity(route, payload)
    prompt = compose(payload)
    if adapter == "gemini" and len(payload.get("images") or []) > 14:
        raise http_errors.bad("Nano Banana 2 最多使用 14 张参考图")
    if adapter == "local_h3" and model in image_models.MODELS:
        spec = image_models.MODELS[model]
        if not image_models.installed(model):
            raise http_errors.bad(f"{spec.label} 尚未安装")
        if len(payload.get("images") or []) > spec.references:
            raise http_errors.bad(f"{spec.label} 最多使用 {spec.references} 张参考图")
        return {**payload, "prompt": remote_labels(prompt), "expand": False}, False
    if adapter != "local_h3":
        return {**payload, "prompt": remote_labels(prompt)}, False
    if payload.get("model", "h3img") == "h3video":
        return {**payload, "prompt": re.sub(r"@\S+\d+", "", prompt).strip()}, False
    images = payload.get("images") or []
    if len(images) > 9:
        raise http_errors.bad("H3-Image 最多使用 9 张参考图")
    prompt = picture_labels(prompt)
    if not payload.get("expand"):
        return {**payload, "prompt": prompt}, False
    llm = app["llm"]
    edit = bool(images)
    path = graphs.TEMPLATES / ("h3image_edit.json" if edit else "h3image_t2i.json")
    if not llm.available() or not path.is_file():
        graph_expansion = not review and not reference_instructions(payload) and payload.get("image_text", "auto") == "auto"
        return {**payload, "prompt": prompt, "expand": graph_expansion}, False
    ar_text = f"{round(float(payload['ar']) * 100)}:100" if payload.get("ar") else "adaptive"
    try:
        template = json.loads(path.read_text())
        expanded = await rewriter.expand_image(llm, config.COMFY_DIR, template, graphs.H3IMG_IDS[edit],
                                               prompt, images, ar_text)
    except Exception as error:
        raise http_errors.bad(f"智能扩写失败：{error}") from error
    # Append explicit constraints again if the expander omitted or paraphrased them.
    constraints = [picture_labels(line) for line in reference_instructions(payload)]
    if policy := _TEXT_OPTIONS.get(payload.get("image_text")):
        constraints.append(policy)
    if payload.get("image_text") == "specified":
        brief = payload["prompt"].split(MEMORY_PROMPT_MARKER, 1)[0].split(IMAGE_STORY_PROMPT_MARKER, 1)[0]
        for match in _QUOTED_TEXT.finditer(brief):
            original = next(value for value in match.groups() if value is not None)
            if not re.search(r"(?<![A-Za-z0-9])" + re.escape(original) + r"(?![A-Za-z0-9])", expanded):
                return {**payload, "prompt": prompt, "expand": False}, False
    if constraints:
        expanded += "\n\n" + "\n".join(line for line in constraints if line not in expanded)
    return {**payload, "prompt": expanded.strip(), "expand": False}, True


def fingerprint(user, payload, route):
    # The prepared payload includes the pinned inputs and resolved world data.
    relevant = {key: payload.get(key) for key in ("board", "prompt", "images", "memory_used", "expand",
                                                   "ar", "model", "quality", "image_text")}
    value = json.dumps([user["id"], route_identity(route, payload), relevant],
                       ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(value.encode()).hexdigest()


class ReviewedImagePrompts:
    def __init__(self):
        self.entries = OrderedDict()

    def save(self, fingerprint, prepared, story_status, expanded):
        key = uuid4().hex
        self.entries[key] = (monotonic() + _PREVIEW_SECONDS, fingerprint,
                             prepared["prompt"], prepared.get("expand"), story_status, expanded)
        if len(self.entries) > _PREVIEW_LIMIT:
            self.entries.popitem(last=False)
        return key

    def resolve(self, key, fingerprint):
        item = self.entries.get(key)
        if item is None or item[0] < monotonic() or item[1] != fingerprint:
            raise http_errors.bad("生图预览已过期或生成设置已变化，请重新预览")
        return item[2:]
