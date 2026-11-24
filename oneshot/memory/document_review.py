"""Capture and resolve selections on editable canvas documents."""

import hashlib

MAX_PASSAGE = 4000
CONTEXT_LENGTH = 48


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def capture(text, selection):
    if not isinstance(selection, dict):
        raise ValueError("文本批注需要指定选中的原文")
    start, end, quote = (selection.get(key) for key in ("start", "end", "quote"))
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text):
        raise ValueError("文本批注的位置无效")
    if end - start > MAX_PASSAGE:
        raise ValueError(f"每条批注最多选择 {MAX_PASSAGE} 个字符")
    if text[start:end] != quote:
        raise ValueError("文档已更新，请重新选择原文")
    if not quote.strip():
        raise ValueError("请选择需要批注的原文")
    return {"start": start, "end": end, "quote": quote, "digest": digest(text),
            "before": text[max(0, start - CONTEXT_LENGTH):start], "after": text[end:end + CONTEXT_LENGTH]}


def locate(text, passage):
    quote = passage["quote"]
    if digest(text) == passage["digest"]:
        return passage["start"], passage["end"]
    before, after = passage["before"], passage["after"]
    match = None
    start = text.find(quote)
    while start >= 0:
        end = start + len(quote)
        if text[max(0, start - len(before)):start] == before and text[end:end + len(after)] == after:
            if match is not None:
                return None
            match = (start, end)
        start = text.find(quote, start + 1)
    return match


def visible_anchor(anchor):
    if anchor and (passage := anchor.get("passage")):
        return {**anchor,"passage":{"quote":passage["quote"]}}
    return anchor
