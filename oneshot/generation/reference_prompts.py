"""Bind video prompts to the selected images, motion, and edit instructions."""

import re

from oneshot.editing import camera_plan
from oneshot.editing import image_camera
from oneshot.editing import object_edit
from oneshot.generation import fields as pfields
from oneshot.generation import graphs
from oneshot.generation import motion_reference
from oneshot.generation import prompts
from oneshot.generation import video_prompt_adapters
from oneshot.web import http as http_errors


def plain_prompt(p: dict) -> str:
    """Fields → one Chinese paragraph for third-party models (they don't speak H3's structured format)."""
    f = p.get("fields")
    if not isinstance(f, dict) or not pfields.has_content(f):
        return http_errors.clean(p.get("prompt"))
    lab = [("style", "风格"), ("scene", "场景"), ("people", "人物"), ("camera", "镜头"), ("action", "动作"), ("dialogue", "对白"), ("sound", "声音"), ("music", "配乐")]
    parts = [f"{t}：{'；'.join(x.strip() for x in str(f.get(k) or '').splitlines() if x.strip())}" for k, t in lab if str(f.get(k) or "").strip()]
    if http_errors.clean(p.get("prompt")):
        parts.append(http_errors.clean(p.get("prompt")))
    return "。".join(parts)


def remote_video_prompt(raw, provider, model):
    images = raw.get("images") or []
    if limit := image_reference_limit(raw,provider,model):
        if len(images)>limit:
            raise http_errors.bad(f"此模型最多支持 {limit} 张参考图")
        if any(not 1 <= int(mark) <= len(images) for mark in re.findall(r"@(?:图|图片)(\d+)",plain_prompt(raw))):
            raise http_errors.bad("提示词引用的参考图不存在，请重新选择")
        prompt = video_reference_prompt(raw,provider,model,guide_frames=True)
        return prompt, ["image_ref"]*len(images)
    frames = [i for i, image in enumerate(images) if image.get("role") != "subject"]
    subjects = [i for i, image in enumerate(images) if image.get("role") == "subject"]
    kling = provider["kind"] == "kling"
    roles = ["unused_image"] * len(images)
    labels = {}
    if frames:
        roles[frames[0]], labels[frames[0]] = "first_frame", "首帧画面"
        if len(frames) > 1 and not (kling and (subjects or "flash" in model)):
            roles[frames[-1]], labels[frames[-1]] = "last_frame", "尾帧画面"
    if kling or not frames:
        for number, i in enumerate(subjects[:7 if kling else 9], 1):
            roles[i], labels[i] = "subject", f"第 {number} 张人物参考图"

    def replace(match):
        i = int(match[1]) - 1
        if i not in labels:
            raise http_errors.bad(f"当前视频服务无法采用 {match[0]}，请调整参考素材或切换视频服务")
        return labels[i]

    prompt = prompts._IMAGE_MENTION.sub(replace,plain_prompt(raw))
    if is_cloud_h3(provider,model):
        prompt = video_prompt_adapters.h3_cloud_prompt(prompt)
    return prompt,roles


def wants_image_references(raw):
    images = raw.get("images") or []
    return len(images)>2 or any(image.get("role")=="subject" for image in images)


def image_reference_limit(raw, provider, model):
    if wants_image_references(raw):
        return motion_reference.image_reference_limit(provider,model)
    return None


def has_remote_image_references(raw, route):
    return bool(route and image_reference_limit(raw,route["provider"],route["model"]))


def resolve_camera_plan(raw):
    if "camera_plan" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("extension"):
        raise http_errors.bad("镜头重拍需要指定原视频片段")
    try:
        return camera_plan.validate(raw["camera_plan"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None


def apply_video_optics(raw):
    if "video_optics" not in raw:
        return raw
    if raw.get("kind","video") != "video":
        raise http_errors.bad("视频镜头参数仅用于视频生成")
    try:
        settings = image_camera.validate_optics(raw["video_optics"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None
    if not settings:
        return raw
    description = "，".join(image_camera.optics_instructions(settings)) + "。"
    fields = raw.get("fields")
    if isinstance(fields,dict) and pfields.has_content(fields):
        camera = str(fields.get("camera") or "").strip()
        return {**raw,"fields":{**fields,"camera":"\n".join(filter(None,(camera,description)))}}
    prompt = str(raw.get("prompt") or "").strip()
    prompt, structured = graphs._append_to_section(prompt,("detailed_description","integrated_multimodal_description"),description)
    return {**raw,"prompt":prompt if structured else "\n".join(filter(None,(prompt,description)))}


def resolve_object_edit(raw):
    if "object_edit" not in raw:
        return None
    if raw.get("segment_edit") is not True or not raw.get("video_refs") or raw.get("camera_plan") or raw.get("extension"):
        raise http_errors.bad("物体编辑需要指定原视频片段")
    try:
        return object_edit.validate(raw["object_edit"])
    except ValueError as error:
        raise http_errors.bad(str(error)) from None


def numbered_reference_inputs(inputs, payload, *, h3_labels=False):
    image_count = len(payload.get("images") or [])
    pictures, media = inputs[:image_count],inputs[image_count:]
    guide = next((item for item in media if item.get("role")=="previs"),None)
    videos = motion_reference.ordered_video_references(guide,(item for item in media if item.get("role")=="video_ref"),
                    source_first=bool(payload.get("extension") or payload.get("segment_edit")))
    audio = [item for item in media if item.get("role")=="audio_ref"]
    for prefix,group in (("图片",pictures),("视频",videos),("音频",audio)):
        for index,item in enumerate(group,1):
            item["prompt_reference"] = (video_prompt_adapters.h3_reference_label(prefix,index) if h3_labels
                                        else f"@{prefix}{index}")
    return pictures + videos + audio


def set_video_preview_image_role(item, role):
    if role=="image_ref" and item.get("role") in ("subject","frame"):
        item["image_role"] = item["role"]
    item["role"] = role


def is_cloud_h3(provider, model):
    return provider["kind"] == "minimax" and model in motion_reference.H3_CLOUD_MODELS


def video_reference_prompt(raw, provider, model, *, guide_frames=False):
    prompt = reference_prompt(raw,guide_frames=guide_frames)
    if is_cloud_h3(provider,model):
        return video_prompt_adapters.h3_cloud_prompt(prompt,images=raw.get("images") or [],reference=True)
    return prompt


def reference_prompt(raw, *, guide_frames=False):
    retake = resolve_camera_plan(raw)
    object_plan = resolve_object_edit(raw)
    prompt = plain_prompt(raw)
    if not prompt and not retake and not object_plan:
        raise http_errors.bad("请描述正式视频的内容或画面风格")
    prompt = video_prompt_adapters.map_reference_tokens(
        prompt,lambda kind,number: "@"+{"图":"图片","音":"音频"}.get(kind,kind)+number)
    images = raw.get("images") or []
    frames = [(i,entry) for i,entry in enumerate(images,1)
              if entry.get("role")=="frame" or guide_frames and entry.get("role")!="subject"]
    if frames:
        guidance = []
        duration = raw.get("duration")
        for index,(i,entry) in enumerate(frames):
            at = entry.get("time")
            if raw.get("planned") and isinstance(at,(int,float)) and 0 <= at <= 30:
                position = ("开头" if at <= .01 else "结尾"
                            if isinstance(duration,(int,float)) and at >= duration-.25 else f"约在 {at:g} 秒")
            elif index==0:
                position = "开头"
            elif index==len(frames)-1:
                position = "结尾"
            elif isinstance(at,(int,float)) and 0 < at <= 30:
                position = f"约在 {at:g} 秒"
            else:
                continue
            guidance.append(f"{position}参考 @图片{i} 的构图。")
        if any(graphs.is_character_reference(image) for image in images):
            guidance.append("关键帧里出现的人物与各自的角色参考图共用同一身份。除非镜头明确要求分身，同一角色同时只出现一位。")
        prompt = "".join(guidance) + "\n" + prompt
    extension = raw.get("extension")
    edit = raw.get("segment_edit")
    if raw.get("previs_guide"):
        n = 2 if extension or edit else 1
        guidance = "人物走位和空间关系，机位服从重拍方案。" if retake else "镜头运动、人物走位和空间构图。"
        prompt = (f"参考 @视频{n} 的{guidance}"
                  "按描述和参考图生成正式画面，使用正式场景的材质、光线和色彩。\n" + prompt)
    if extension in ("before","after"):
        direction = "向前" if extension=="before" else "向后"
        boundary = "开头之前" if extension=="before" else "结尾之后"
        prompt = (f"{direction}延长 @视频1。只生成接在原视频{boundary}的新片段。"
                  "让人物外观、场景、光线和动作在接点自然衔接。\n" + prompt)
    if object_plan:
        prompt = (object_edit.instructions(object_plan,len(raw.get("images") or [])+1)+"\n"+prompt).strip()
    elif retake:
        direction = camera_plan.instructions(retake)
        prompt = ("按下列机位方案重拍 @视频1。保留人物外观、原场景、动作内容和发生顺序。"
                  f"保持原片段的时长和画幅。{direction}\n{prompt}").strip()
    elif edit:
        prompt = ("编辑 @视频1 中指定的内容，保留其他人物、场景和镜头节奏。保持原片段的时长和画幅。\n" + prompt)
    return prompt
