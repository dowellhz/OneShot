"""Validate and rasterize captions and titles for video overlays."""
from __future__ import annotations

import math

from PIL import Image

from oneshot.config import ROOT


FONT = ROOT / "fonts" / "NotoSansSC.ttf"
CAPTION_LIMIT = 300
TITLE_LIMIT = 20
TITLE_POSITIONS = {"top":.13, "center":.5, "lower_left":.76}
TITLE_STYLES = {"plain", "label"}


def _wrap(draw, text: str, font, maxw: int, limit=3):
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) > maxw and cur:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines[:limit]


def subtitle_overlay(text: str, W: int, H: int, scale: float = 1.0):
    """RGBA strip (numpy) with outlined text, and its top row in the frame."""
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
    size = max(14, int(min(W, H) * 0.055 * scale))
    font = ImageFont.truetype(str(FONT), size)
    try:
        font.set_variation_by_name("Medium")
    except Exception:
        pass
    probe_d = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    lines = _wrap(probe_d, text, font, int(W * 0.86))
    lh = int(size * 1.32)
    sh = lh * len(lines) + size // 2
    img = Image.new("RGBA", (W, sh), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=font)
        d.text(((W - tw) / 2, size // 4 + i * lh), ln, font=font, fill=(255, 255, 255, 255),
               stroke_width=max(2, size // 12), stroke_fill=(0, 0, 0, 230))
    a = np.asarray(img).astype(np.float32)
    y = int(H * 0.93) - sh
    return a, max(0, y)


def cue_times(lines, start: float, end: float):
    """Spread a clip's subtitle lines over its time on the timeline, proportional to their length."""
    lines = [x for x in lines if x.strip()]
    if not lines:
        return []
    a, b = start + 0.15, max(start + 0.3, end - 0.15)
    w = [len(x) + 4 for x in lines]
    tot, t, out = sum(w), a, []
    for x, k in zip(lines, w):
        d = (b - a) * k / tot
        out.append((t, t + d, x))
        t += d
    return out


def subtitle_captions(value):
    """Validate timed captions stored on a source media clock."""
    if not isinstance(value, list) or len(value) > CAPTION_LIMIT:
        raise ValueError("字幕条数或格式无效")
    result = []
    last = 0
    for cue in value:
        if not isinstance(cue, dict):
            raise ValueError("字幕格式无效")
        start, end, text = (cue.get(key) for key in ("start", "end", "text"))
        if (type(start) not in (int,float) or type(end) not in (int,float) or not 0 <= last <= start < end < math.inf or
                not isinstance(text, str) or len(text) > 500):
            raise ValueError("字幕时间须按顺序排列且不能重叠，单条文字最多 500 字")
        result.append((start, end, text.strip()))
        last = end
    return result


def clip_caption_times(clip, start, visible_start, visible_end):
    if clip["captions"] is None:
        return cue_times(clip["subs"], visible_start, visible_end)
    t0 = clip["t0"]
    cues = []
    for a, b, text in clip["captions"]:
        a = max(visible_start, start + (a - t0) / clip["speed"])
        b = min(visible_end, start + (b - t0) / clip["speed"])
        if text and a < b:
            cues.append((a,b,text))
    return cues


def title_items(items):
    if not isinstance(items, list) or len(items) > TITLE_LIMIT:
        raise ValueError(f"时间线最多可添加 {TITLE_LIMIT} 条标题")
    clean = []
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 条标题格式无效")
        text, start, end = (item.get(k) for k in ("text", "start", "end"))
        position, style = item.get("position", "center"), item.get("style", "plain")
        if (not isinstance(text, str) or len(text) > 120 or type(start) not in (int, float) or
                type(end) not in (int, float) or not 0 <= start < end < math.inf or
                not isinstance(position, str) or position not in TITLE_POSITIONS or
                not isinstance(style, str) or style not in TITLE_STYLES):
            raise ValueError(f"请检查第 {index} 条标题的文字、时间和样式")
        text = " ".join(text.split())
        if text:
            clean.append({"text":text,"start":start,"end":end,"position":position,"style":style})
    return clean


def title_overlay(item, width, height):
    from PIL import ImageDraw, ImageFont
    import numpy as np

    position = item["position"]
    centered = position != "lower_left"
    label = item["style"] == "label"
    size = max(8, round(min(width,height) * (.075 if position == "center" else .05)))
    max_width = max(1, int(width * (.86 if centered else .72)))
    measure = ImageDraw.Draw(Image.new("RGBA", (1,1)))
    try:
        font = ImageFont.truetype(str(FONT), size)
    except OSError as error:
        raise ValueError("找不到标题字体，请在部署目录安装 fonts/NotoSansSC.ttf") from error
    while True:
        padding = max(2, round(size * (.4 if label else .18)))
        lines = _wrap(measure,item["text"],font,max(1,max_width-2*padding),limit=None)
        line_height = sum(font.getmetrics())
        if (len(lines) <= 3 and line_height*len(lines)+2*padding <= height) or size <= 5:
            break
        size = max(5,int(size*.85))
        font = font.font_variant(size=size)
    widths = [measure.textlength(line,font=font) for line in lines]
    w = min(max_width,math.ceil(max(widths))+2*padding)
    h = min(height,line_height*len(lines)+2*padding)
    overlay = Image.new("RGBA",(w,h))
    draw = ImageDraw.Draw(overlay)
    if label:
        draw.rounded_rectangle((0,0,w-1,h-1),radius=padding,fill=(20,20,23,220))
    for index, (line, measured) in enumerate(zip(lines,widths)):
        x = (w-measured)/2 if centered else padding
        draw.text((x,padding+index*line_height),line,font=font,fill="white",anchor="lt",
                  stroke_width=0 if label else max(1,size//16),stroke_fill=(0,0,0,220))
    x = (width-w)//2 if centered else int(width*.07)
    y = round(height*TITLE_POSITIONS[position] - h/2)
    return np.asarray(overlay), x, max(0,min(y,height-h))


# ------------------------------------------------------------------ the renderer
