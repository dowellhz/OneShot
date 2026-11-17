"""SAM2 selections / U2Net cutouts on CPU, and native SD inpainting on the GPU queue."""
from __future__ import annotations

import gc
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path(os.environ.get("ONESHOT_EDITOR_MODELS", str(ROOT / "models")))
_sam = _processor = _rembg = _inpaint = None


def capabilities():
    return {"segment": (MODELS / "sam2/model.safetensors").is_file(),
            "cutout": (MODELS / "sam2/model.safetensors").is_file(),
            "native": (MODELS / "inpaint/unet/diffusion_pytorch_model.fp16.safetensors").is_file()}


def image(path):
    from PIL import Image, ImageOps
    with Image.open(path) as im:
        if im.width * im.height > 32 * 1024 * 1024 or max(im.size) > 8192:
            raise ValueError("图片过大")
        return ImageOps.exif_transpose(im).convert("RGBA")


def segment(path, points, out):
    global _sam, _processor
    import torch
    from transformers import Sam2Model, Sam2Processor
    from PIL import Image
    if not capabilities()["segment"]:
        raise RuntimeError("SAM2 模型尚未准备完成")
    if not isinstance(points, list) or not 1 <= len(points) <= 32:
        raise ValueError("请提供 1–32 个选物点击")
    source = image(path)
    coords, labels = [], []
    for point in points:
        x, y = float(point["x"]), float(point["y"])
        if not 0 <= x < source.width or not 0 <= y < source.height or point.get("label", 1) not in (0, 1):
            raise ValueError("选物点击超出图片范围")
        coords.append([x, y]); labels.append(point.get("label", 1))
    if 1 not in labels:
        raise ValueError("至少点击一个要保留的物体")
    if _sam is None:
        _processor = Sam2Processor.from_pretrained(str(MODELS / "sam2"), local_files_only=True)
        _sam = Sam2Model.from_pretrained(str(MODELS / "sam2"), local_files_only=True).eval().to("cpu")
    inputs = _processor(images=source.convert("RGB"), input_points=[[coords]], input_labels=[[labels]], return_tensors="pt")
    with torch.inference_mode():
        outputs = _sam(**inputs)
    masks = _processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"])[0]
    best = int(outputs.iou_scores[0, 0].argmax())
    mask = Image.fromarray(masks[0, best].numpy().astype("uint8") * 255, "L")
    rgba = Image.new("RGBA", source.size, "white"); rgba.putalpha(mask); rgba.save(out)
    return {"width": source.width, "height": source.height, "score": float(outputs.iou_scores[0, 0, best])}


def cutout(path, out):
    python = os.environ.get("ONESHOT_CUTOUT_PYTHON", str(ROOT / "editor-venv/bin/python"))
    if not (MODELS / "rembg/u2netp.onnx").is_file() or not Path(python).is_file():
        return auto_cutout(path, out)
    import subprocess
    import json
    if not capabilities()["cutout"]:
        raise RuntimeError("抠图模型尚未准备完成")
    env = {**os.environ, "U2NET_HOME": str(MODELS / "rembg"), "OMP_NUM_THREADS": "4"}
    result = subprocess.run([python, str(Path(__file__).with_name("cutout_worker.py")), str(path), str(out)],
                            capture_output=True, text=True, timeout=170, env=env)
    if result.returncode:
        raise RuntimeError("智能抠图失败：" + result.stderr[-400:])
    return json.loads(result.stdout.strip().splitlines()[-1])


def auto_cutout(path, out):
    """Rank SAM2 masks by confidence, foreground extent and background-border contact.

    Several independent point prompts share one image encoder pass. The result is
    an automatic foreground suggestion; click selections remain available for refinement.
    """
    global _sam, _processor
    import torch
    import numpy as np
    from transformers import Sam2Model, Sam2Processor
    from PIL import Image, ImageChops, ImageFilter
    source = image(path)
    if not capabilities()["segment"]:
        raise RuntimeError("智能抠图模型尚未准备完成")
    if _sam is None:
        _processor = Sam2Processor.from_pretrained(str(MODELS / "sam2"), local_files_only=True)
        _sam = Sam2Model.from_pretrained(str(MODELS / "sam2"), local_files_only=True).eval().to("cpu")
    points = [[[source.width * x, source.height * y]] for y in (.3, .5, .7) for x in (.3, .5, .7)]
    # Processor label shape is (image, object, point).
    inputs = _processor(images=source.convert("RGB"), input_points=[points], input_labels=[[[1] for _ in points]], return_tensors="pt")
    with torch.inference_mode():
        outputs = _sam(**inputs)
    masks = _processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"])[0]
    best, best_score = None, -float("inf")
    for obj in range(masks.shape[0]):
        for candidate in range(masks.shape[1]):
            mask = masks[obj, candidate].numpy().astype(bool)
            area = float(mask.mean())
            if not .005 < area < .95:
                continue
            border = np.concatenate((mask[0], mask[-1], mask[:, 0], mask[:, -1])).mean()
            central = mask[int(source.height * .35):int(source.height * .65), int(source.width * .35):int(source.width * .65)].mean()
            quality = float(outputs.iou_scores[0, obj, candidate])
            score = .6 * quality + .25 * area ** .25 + .15 * central - .8 * border
            if score > best_score:
                best, best_score = mask, score
    if best is None:
        raise ValueError("未找到明确前景，请用智能选物点击主体后转为透明图层")
    mask = Image.fromarray(best.astype("uint8") * 255, "L")
    mask = ImageChops.multiply(mask, mask.filter(ImageFilter.GaussianBlur(.7)))
    source.putalpha(ImageChops.multiply(source.getchannel("A"), mask)); source.save(out)
    return {"width": source.width, "height": source.height, "score": float(best_score)}


def drop_inpaint():
    global _inpaint
    if _inpaint is not None:
        _inpaint = None
        gc.collect()
        import torch
        torch.cuda.empty_cache()


def inpaint(req, progress, cancelled):
    global _inpaint
    import torch
    from diffusers import StableDiffusionInpaintPipeline
    from PIL import Image
    if not capabilities()["native"]:
        raise RuntimeError("原生遮罩模型尚未准备完成")
    progress("loading", 0, req.get("steps", 25))
    if _inpaint is None:
        _inpaint = StableDiffusionInpaintPipeline.from_pretrained(str(MODELS / "inpaint"), variant="fp16", dtype=torch.float16,
                                                               local_files_only=True, use_safetensors=True).to("cuda")
        _inpaint.enable_attention_slicing()
    source, mask = image(req["image"]).convert("RGB"), image(req["mask"]).convert("L")
    if source.size != mask.size:
        raise ValueError("原生遮罩尺寸不匹配")
    scale = 768 / max(source.size)
    w, h = (max(64, round(side * scale / 8) * 8) for side in source.size)
    steps = max(10, min(50, int(req.get("steps", 25))))
    strength = max(.1, min(1., float(req.get("denoise", .95))))
    total = max(1, int(steps * strength))
    def callback(pipe, step, timestep, kwargs):
        if cancelled():
            raise InterruptedError("已取消")
        progress("decoding" if step + 1 >= total else "sampling", step + 1, total)
        return kwargs
    if cancelled():
        raise InterruptedError("已取消")
    result = _inpaint(prompt=req["prompt"], image=source.resize((w, h), Image.Resampling.LANCZOS),
                      mask_image=mask.resize((w, h), Image.Resampling.NEAREST), width=w, height=h,
                      num_inference_steps=steps, strength=strength, guidance_scale=7.5,
                      generator=torch.Generator(device="cuda").manual_seed(int(req.get("seed", 0))), callback_on_step_end=callback)
    progress("decoding", total, total)
    if cancelled():
        raise InterruptedError("已取消")
    if result.nsfw_content_detected and any(result.nsfw_content_detected):
        raise ValueError("模型未返回可用图像，请调整提示词后重试")
    result.images[0].resize(source.size, Image.Resampling.LANCZOS).save(req["out"])
