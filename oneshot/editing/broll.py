"""Structured, locally rendered motion graphics for canvas media."""
import math

from PIL import Image, ImageDraw, ImageFont


MODES = {"title": "动态标题", "captions": "动态字幕卡", "chart": "条形图", "motion": "图片推拉"}
STYLES = {"plain", "card"}


def text(value, limit, label):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f"{label}需填写 1–{limit} 个字符")
    return value.strip()


def number(value, minimum, maximum, label):
    if type(value) not in (int, float) or not minimum <= value <= maximum:
        raise ValueError(f"{label}须在 {minimum:g}–{maximum:g} 范围内")
    return value


def recipe(value, kind, length=None):
    if not isinstance(value, dict):
        raise ValueError("请填写 B-roll 设置")
    mode, style = value.get("mode"), value.get("style", "card")
    if not isinstance(mode, str) or mode not in MODES or not isinstance(style, str) or style not in STYLES:
        raise ValueError("请选择 B-roll 类型和样式")
    if mode == "motion" and kind != "image":
        raise ValueError("推拉动画需要图片源素材")
    if kind == "image":
        length = number(value.get("duration", 4), .5, 12, "图片片段时长")
    start = number(value.get("start", 0), 0, length, "开始时间")
    end = number(value.get("end", length), 0, length, "结束时间")
    if end-start < 1/24-1e-9:
        raise ValueError("结束时间需至少晚于开始时间一帧")
    result = {"mode":mode, "style":style, "start":start, "end":end}
    if kind == "image":
        result["duration"] = length
    if mode == "motion":
        direction = value.get("direction", "in")
        if direction not in ("in", "out"):
            raise ValueError("请选择推进或拉远")
        return {**result,"direction":direction}
    if mode == "captions":
        lines = value.get("lines")
        if not isinstance(lines,list) or not 1<=len(lines)<=6:
            raise ValueError("请填写 1–6 行字幕卡")
        return {**result,"lines":[text(line,70,"每行字幕") for line in lines]}
    result["title"] = text(value.get("title"),100 if mode == "title" else 42,"标题")
    if mode == "chart":
        bars = value.get("bars")
        if not isinstance(bars,list) or not 2<=len(bars)<=6 or not all(isinstance(bar,dict) for bar in bars):
            raise ValueError("条形图需要 2–6 组真实数据")
        result["bars"] = [{"label":text(bar.get("label"),18,"条目名称"),"value":number(bar.get("value"),0,1e9,"条目数值")} for bar in bars]
    return result


def chart_layer(spec, width, height, fraction, font_path):
    w, h = round(width*.83), round(height*.68)
    layer = Image.new("RGBA",(w,h))
    draw = ImageDraw.Draw(layer)
    pad = max(3,round(w*.055))
    ink, accent = ((247,247,250,255),(169,188,243,255)) if spec["style"]=="card" else ((33,34,45,255),(100,108,183,255))
    background = (26,27,35,235) if spec["style"]=="card" else (244,244,249,240)
    draw.rounded_rectangle((0,0,w-1,h-1),radius=pad,fill=background)
    count = len(spec["bars"])
    heading = min(round(w*.063),round(h*.17))
    title = ImageFont.truetype(str(font_path),max(4,heading))
    while title.size>4 and draw.textlength(spec["title"],font=title)>w-2*pad:
        title = title.font_variant(size=max(4,round(title.size*.84)))
    draw.text((pad,pad),spec["title"],font=title,fill=ink,anchor="lt")
    top = pad+title.size+max(3,round(h*.08))
    step = max(2,(h-top-pad)//count)
    font = ImageFont.truetype(str(font_path),max(4,min(round(step*.40),round(w*.04))))
    longest = max((bar["value"] for bar in spec["bars"]),default=0) or 1
    axis, track = round(w*.40), max(1,round(w*.38))
    for index, bar in enumerate(spec["bars"]):
        y = top+step*index
        label = bar["label"]
        while len(label)>1 and draw.textlength(label,font=font)>axis-pad*1.35:
            label = label[:-1]
        draw.text((pad,y),label,font=font,fill=ink,anchor="lt")
        size = round(track * min(1,bar["value"]/longest) * fraction)
        if size:
            draw.rectangle((axis,y,axis+size,y+max(1,font.size)),fill=accent)
        draw.text((w-pad,y),f"{bar['value']:g}",font=font,fill=ink,anchor="rt")
    return layer, (width-w)//2, (height-h)//2


def frames(spec, width, height, fps, title_overlay, font_path):
    """Return a compositor with a short entrance and exit, reusing stable overlays."""
    if not spec or spec["mode"] == "motion":
        return lambda arr, _frame: arr
    import numpy as np

    first, last = (math.ceil(spec[key]*fps-1e-8) for key in ("start","end"))
    duration = max(1,last-first)
    entrance = min(12,max(1,duration//3))
    cache = {}

    def composite(arr, frame):
        if not first <= frame < last:
            return arr
        local = frame-first
        alpha = min(1.,(local+1)/entrance,(last-frame)/entrance)
        if spec["mode"] == "chart":
            phase = min(entrance,local+1)
            if phase not in cache:
                image,x,y = chart_layer(spec,width,height,phase/entrance,font_path)
                cache[phase] = (np.asarray(image),x,y)
            overlay,x,y = cache[phase]
        else:
            lines = spec.get("lines") or [spec["title"]]
            index = min(len(lines)-1,local*len(lines)//duration)
            if index not in cache:
                cache[index] = title_overlay({"text":lines[index],"position":"lower_left" if spec["mode"]=="captions" else "center",
                    "style":"label" if spec["style"]=="card" else "plain"},width,height)
            overlay,x,y = cache[index]
        h,w = overlay.shape[:2]
        opacity = overlay[:,:,3:4].astype(np.float32)*(alpha/255)
        edited = arr.copy()
        region = arr[y:y+h,x:x+w]
        edited[y:y+h,x:x+w] = (region*(1-opacity)+overlay[:,:,:3]*opacity).astype(np.uint8)
        return edited

    return composite


def still_motion(picture, spec, count, fps):
    import numpy as np

    image = Image.fromarray(picture)
    width,height = image.size
    for i in range(count):
        time = i / fps
        fraction = max(0.,min(1.,(time-spec["start"])/(spec["end"]-spec["start"])))
        if spec["direction"] == "out":
            fraction = 1-fraction
        scale = 1 + .19 * (fraction*fraction*(3-2*fraction))
        crop = (width/2*(1-1/scale),height/2*(1-1/scale),width/2*(1+1/scale),height/2*(1+1/scale))
        yield np.asarray(image.resize((width,height),Image.Resampling.BICUBIC,box=crop))
