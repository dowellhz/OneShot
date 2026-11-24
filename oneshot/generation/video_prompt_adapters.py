"""Compile model-facing video prompts without modifying the editable brief."""

import re


_REFERENCES = re.compile(r"(<d>.*?</d>)|@(图片|图|视频|音频|音)(\d+)", re.S)
_H3_LABELS = {"图片":"Picture","图":"Picture","视频":"Video","音频":"Audio","音":"Audio"}
_H3_CLOUD_PROMPT_LIMIT = 7000


def h3_reference_label(kind, number):
    return f"<{_H3_LABELS[kind]} {number}>"


def map_reference_tokens(prompt, label):
    return _REFERENCES.sub(lambda match: match[1] or label(match[2],match[3]),prompt)


def h3_cloud_prompt(prompt, *, images=(), reference=False):
    """Give H3 Context-IR a brief with explicit asset labels and identity bindings."""
    if reference:
        prompt = map_reference_tokens(prompt,h3_reference_label)
        identities = {}
        for index,image in enumerate(images,1):
            name = image.get("memory_name") or image.get("name")
            if (image.get("role") != "subject" or image.get("memory_kind") not in (None,"character")
                    or not isinstance(name,str) or not name.strip() or re.fullmatch(r"(图片|image)\s*\d+.*",name,re.I)):
                continue
            key = image.get("memory_id") or image.get("ref") or index
            _,pictures = identities.setdefault(key,(name.strip(),[]))
            pictures.append(h3_reference_label("图",index))
        if identities:
            bindings = [f"{'、'.join(pictures)} 用于保持「{name}」的身份和外观。"
                        for name,pictures in identities.values()]
            prompt = "\n".join([*bindings,prompt])
    return prompt[:_H3_CLOUD_PROMPT_LIMIT]
