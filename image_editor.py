"""Non-destructive image transforms and masked compositing for existing edit models.

Workflow inspired by Krita AI Diffusion's context / selection / history design;
implemented independently using Pillow and OneShot's existing image providers.
"""
from __future__ import annotations

import math
from pathlib import Path
from urllib.parse import quote

from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps

import image_camera
from tools import _new, ref_path

MAX_PIXELS = 32 * 1024 * 1024
MAX_SIDE = 8192
RESIZE_FITS = {"contain":"透明补边", "cover":"居中裁切", "stretch":"拉伸"}


def number(value, low, high, label, default=None):
    try:
        n = float(default if value is None else value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}必须是数字")
    if not math.isfinite(n) or not low <= n <= high:
        raise ValueError(f"{label}须在 {low}–{high} 之间")
    return n


def check_size(w, h):
    if min(w, h) < 1 or max(w, h) > MAX_SIDE or w * h > MAX_PIXELS:
        raise ValueError("图片最大边长为 8192 像素，总像素不能超过 3200 万")


def load(root: Path, ref: str) -> Image.Image:
    path = ref_path(root, ref)
    if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise ValueError("请选择 PNG / JPG / WEBP 图片")
    with Image.open(path) as im:
        check_size(*im.size)
        return ImageOps.exif_transpose(im).convert("RGBA")


def save(root: Path, im: Image.Image, prefix="edit", kind="output") -> dict:
    path, ref = _new(root, kind, prefix, ".png")
    im.save(path)
    return {"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "w": im.width, "h": im.height}


def rectangle(value, w, h):
    if not isinstance(value, dict):
        raise ValueError("请先拖出裁剪选区")
    x = int(number(value.get("x"), 0, w - 1, "选区 X"))
    y = int(number(value.get("y"), 0, h - 1, "选区 Y"))
    cw = int(number(value.get("w"), 1, w - x, "选区宽度"))
    ch = int(number(value.get("h"), 1, h - y, "选区高度"))
    return x, y, x + cw, y + ch


def resize_spec(value):
    if not isinstance(value, dict):
        raise ValueError("请设置输出宽度和高度")
    w, h, fit = value.get("width"), value.get("height"), value.get("fit", "contain")
    if type(w) is not int or type(h) is not int:
        raise ValueError("输出宽度和高度须为整数像素")
    check_size(w,h)
    if not isinstance(fit,str) or fit not in RESIZE_FITS:
        raise ValueError("请选择透明补边、居中裁切或拉伸")
    return {"width":w,"height":h,"fit":fit}


def resize_image(im, spec):
    w, h, fit = spec["width"], spec["height"], spec["fit"]
    if im.size == (w,h):
        return im
    if fit == "stretch":
        return im.resize((w,h),Image.Resampling.LANCZOS)
    if fit == "cover":
        return ImageOps.fit(im,(w,h),method=Image.Resampling.LANCZOS)
    scale = min(w/im.width,h/im.height)
    inner = (max(1,round(im.width*scale)),max(1,round(im.height*scale)))
    resized = im.resize(inner,Image.Resampling.LANCZOS)
    result = Image.new("RGBA",(w,h))
    result.paste(resized,((w-inner[0])//2,(h-inner[1])//2))
    return result


def transform(root: Path, p: dict) -> dict:
    size = resize_spec(p["resize"]) if "resize" in p else None
    im = load(root, p.get("ref", ""))
    if p.get("crop") is not None:
        im = im.crop(rectangle(p["crop"], *im.size))
    angle = number(p.get("rotate"), -270, 270, "旋转角度", 0)
    if angle % 90:
        raise ValueError("旋转角度须为 90 的倍数")
    if angle:
        im = im.rotate(-angle, expand=True)
    if p.get("flip_x"):
        im = ImageOps.mirror(im)
    if p.get("flip_y"):
        im = ImageOps.flip(im)
    alpha = im.getchannel("A")
    rgb = im.convert("RGB")
    for k, cls in (("brightness", ImageEnhance.Brightness), ("contrast", ImageEnhance.Contrast), ("saturation", ImageEnhance.Color)):
        rgb = cls(rgb).enhance(number(p.get(k), 0, 2, k, 1))
    im = rgb.convert("RGBA")
    im.putalpha(alpha)
    if size is not None:
        return {**save(root,resize_image(im,size),"resize"),"resize":size}
    return save(root,im)


def compose_layers(root: Path, p: dict) -> dict:
    """Flatten ordered RGBA layers, keeping transparency and per-layer opacity."""
    base = load(root, p.get("ref", ""))
    layers = p.get("layers")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 16:
        raise ValueError("图层数量须为 1–16")
    canvas = Image.new("RGBA", base.size)
    total = 0
    for item in layers:
        if not isinstance(item, dict):
            raise ValueError("图层格式不正确")
        if not item.get("visible", True):
            continue
        im = load(root, item.get("ref", ""))
        total += im.width * im.height
        if total > MAX_PIXELS * 4:
            raise ValueError("图层总像素过多，请先合并部分图层")
        opacity = number(item.get("opacity"), 0, 1, "图层不透明度", 1)
        x = int(number(item.get("x"), -MAX_SIDE, MAX_SIDE, "图层 X", 0))
        y = int(number(item.get("y"), -MAX_SIDE, MAX_SIDE, "图层 Y", 0))
        w = int(number(item.get("w"), 1, MAX_SIDE, "图层宽度", im.width))
        h = int(number(item.get("h"), 1, MAX_SIDE, "图层高度", im.height))
        check_size(w, h)
        if im.size != (w, h):
            im = im.resize((w, h), Image.Resampling.LANCZOS)
        if opacity < 1:
            im.putalpha(im.getchannel("A").point(lambda a: round(a * opacity)))
        canvas.alpha_composite(im, (x, y))
    return save(root, canvas, "layers")


def cut_selection(root: Path, p: dict) -> dict:
    source = load(root, p.get("ref", ""))
    mask = load(root, p.get("mask", "")).convert("L")
    if mask.size != source.size or not mask.getbbox():
        raise ValueError("请选择有效的同尺寸选区")
    source.putalpha(ImageChops.multiply(source.getchannel("A"), mask))
    return save(root, source, "cutout")


def prepare(root: Path, p: dict) -> dict:
    """Validate an AI edit and return generation fields plus a private compositing spec.

    White mask pixels are editable. Feathering is inward so unselected pixels
    remain byte-for-byte identical, even if an edit model changes its whole input.
    Strength is the compositing opacity, not a model-specific denoise parameter.
    """
    source = load(root, p.get("ref", ""))
    mode = p.get("mode", "region")
    if mode not in ("region", "whole", "outpaint"):
        raise ValueError("未知图像编辑模式")
    camera = image_camera.validate(p["camera_view"]) if "camera_view" in p else None
    prompt = str(p.get("prompt") or "").strip()
    if (not prompt and camera is None) or len(prompt) > 8000:
        raise ValueError("请输入 1–8000 字的修改要求")
    strength = number(p.get("strength"), 0.01, 1, "结果融合比例", 1)
    feather = number(p.get("feather"), 0, 128, "边缘羽化", 8)
    backend = p.get("backend", "h3")
    if backend not in ("h3", "native"):
        raise ValueError("未知重绘引擎")
    count = 1
    if camera is not None:
        if mode != "whole" or backend != "h3" or strength != 1:
            raise ValueError("换机位需要使用整图编辑并采用完整生成结果")
        count = p.get("count",1)
        if type(count) is not int or not 1 <= count <= 4:
            raise ValueError("请选择 1–4 张机位候选图")
    denoise = number(p.get("denoise"), .1, 1, "重绘强度", .95)
    steps = int(number(p.get("steps"), 10, 50, "采样步数", 25))
    mask = Image.new("L", source.size, 255)
    if mode == "region":
        mask_im = load(root, p.get("mask", ""))
        if mask_im.size != source.size:
            raise ValueError("遮罩尺寸必须与原图一致")
        mask = mask_im.convert("L")
        if not mask.getbbox():
            raise ValueError("请先用画笔或矩形选择要修改的区域")
    elif mode == "outpaint":
        padding = p.get("padding") or {}
        if not isinstance(padding, dict):
            raise ValueError("扩图边距格式不正确")
        left, top, right, bottom = [int(number(padding.get(k), 0, 2048, "扩图边距", 0)) for k in ("left", "top", "right", "bottom")]
        if not any((left, top, right, bottom)):
            raise ValueError("至少设置一个扩图边距")
        w, h = source.width + left + right, source.height + top + bottom
        check_size(w, h)
        base = Image.new("RGBA", (w, h), (127, 127, 127, 255))
        base.paste(source, (left, top))
        mask = Image.new("L", (w, h), 255)
        mask.paste(0, (left, top, left + source.width, top + source.height))
        source = base
        # Original pixels are protected; the new canvas must be fully generated.
        strength, feather = 1, 0
    bounds = (0, 0, *source.size)
    if mode == "region":
        x0, y0, x1, y1 = mask.getbbox()
        pad = max(64, round(max(x1 - x0, y1 - y0) * .5))
        bounds = (max(0, x0 - pad), max(0, y0 - pad), min(source.width, x1 + pad), min(source.height, y1 + pad))
    base_ref = save(root, source, "editbase", "input")["ref"]
    mask_ref = save(root, mask, "editmask", "input")["ref"]
    context = source.crop(bounds)
    context_ref = save(root, context, "editcontext", "input")["ref"]
    images = [{"ref": context_ref}]
    if mode == "region" and backend != "native":
        highlight = mask.crop(bounds).point(lambda x: round(x * .55))
        guide = Image.composite(Image.new("RGBA", context.size, "#ef4acb"), context, highlight)
        images.append({"ref": save(root, guide, "editguide", "input")["ref"]})
        instruction = ("@图1 是待编辑原图。@图2 的粉色覆盖区仅用于标示编辑位置。"
                       "请在 @图1 的对应区域按要求修改，保持构图、位置和其他内容一致，输出完整的 @图1 画面，不能出现粉色标记。修改要求：")
    elif mode == "outpaint":
        instruction = "扩展 @图1 的画面：把四周灰色留白补成连贯自然的场景，保持原有主体的位置、比例、细节和光线。要求："
    elif camera is not None:
        instruction = ("@图1 提供原始机位、主体、服装和场景。以同一时刻的新相机视角重新构图，"
                       "保持主体身份、姿态、画风、场景结构和光照一致。"
                       + image_camera.instructions(camera) + "。合理补足新机位下可见的部分，不添加文字、边框或分镜格。")
        if prompt:
            instruction += "补充要求："
    else:
        instruction = "根据要求编辑 @图1，保持未要求修改的内容和构图一致。要求："
    spec = {"base": base_ref, "mask": mask_ref, "bounds": list(bounds), "strength": strength,
            "feather": feather, "mode": mode, "source": p["ref"], "prompt": prompt}
    spec["recipe"] = {k: p[k] for k in ("ref", "mask", "mode", "prompt", "strength", "feather", "padding", "seed", "provider", "backend", "denoise", "steps") if k in p}
    spec["recipe"].setdefault("backend", backend)
    if camera is not None:
        spec["recipe"].update(camera_view=camera,count=count,quality=p.get("quality","4mp"))
    native = None
    if backend == "native":
        native = {"image": context_ref, "mask": save(root, mask.crop(bounds), "native-mask", "input")["ref"],
                  "prompt": prompt, "denoise": denoise, "steps": steps}
    return {"kind": "image", "model": "h3img", "prompt": instruction + prompt, "images": images,
            "ar": context.width / context.height, "quality": p.get("quality", "4mp"), "count": count,
            "seed": p.get("seed", -1), "provider": p.get("provider"), "label": p.get("label"),
            "board": p.get("board"), "memory_ids": p.get("memory_ids", []), "_image_edit": spec, "_native_inpaint": native}


def composite(root: Path, spec: dict, outputs: list) -> list:
    base = load(root, spec["base"])
    mask = load(root, spec["mask"]).convert("L")
    if spec["feather"]:
        # Multiply the blurred mask by the original to keep its outside exactly zero.
        mask = ImageChops.multiply(mask, mask.filter(ImageFilter.GaussianBlur(spec["feather"])))
    mask = mask.point(lambda x: round(x * spec["strength"]))
    bounds = tuple(spec["bounds"])
    result = []
    if not outputs:
        raise ValueError("模型没有返回可用于编辑的图片")
    for output in outputs:
        generated = load(root, output["ref"]).resize((bounds[2] - bounds[0], bounds[3] - bounds[1]), Image.Resampling.LANCZOS)
        layer = base.copy()
        layer.paste(generated, bounds[:2])
        edited = save(root, Image.composite(layer, base, mask))
        patch = Image.new("RGBA", base.size)
        patch.paste(generated, bounds[:2])
        patch.putalpha(ImageChops.multiply(patch.getchannel("A"), mask))
        patch_result = save(root, patch, "edit-layer")
        result.append({"ref": edited["ref"], "url": edited["url"], "meta": {"width": edited["w"], "height": edited["h"]},
                       "extra": {"source": "edit", "edit": {"mode": spec["mode"], "source": spec["source"], "base": spec["base"], "prompt": spec["prompt"],
                                                              "recipe": spec.get("recipe"), "layer": patch_result}}})
    return result
