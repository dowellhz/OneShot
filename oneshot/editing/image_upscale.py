"""Tiled FSRCNN enlargement with a separately resampled alpha channel."""
from __future__ import annotations

import logging
from pathlib import Path

from PIL import Image

from oneshot.editing import image_editor

SCALES = (2, 4)
TILE_SIZE = 256
TILE_MARGIN = 16


def model_path(directory: Path, scale: int) -> Path:
    return directory / f"FSRCNN_x{scale}.pb"


def available_scales(directory: Path) -> list[int]:
    installed = [scale for scale in SCALES if model_path(directory, scale).is_file()]
    if installed:
        try:
            from cv2 import dnn_superres
        except ImportError:
            return []
        if hasattr(dnn_superres, "DnnSuperResImpl_create"):
            return installed
    return []


def upscale(root: Path, directory: Path, ref: str, scale: int) -> dict:
    if type(scale) is not int or scale not in SCALES:
        raise ValueError("请选择 2× 或 4× 放大")
    if scale not in available_scales(directory):
        raise ValueError("服务端尚未安装此倍率的超分模型")
    from cv2 import dnn_superres, error as cv_error
    import numpy as np

    image = image_editor.load(root, ref)
    width, height = image.size
    size = (width * scale, height * scale)
    image_editor.check_size(*size)
    result = Image.new("RGB", size)
    model = dnn_superres.DnnSuperResImpl_create()
    try:
        model.readModel(str(model_path(directory, scale)))
        model.setModel("fsrcnn", scale)
        for top in range(0, height, TILE_SIZE):
            for left in range(0, width, TILE_SIZE):
                right, bottom = min(left + TILE_SIZE, width), min(top + TILE_SIZE, height)
                x, y = max(0, left - TILE_MARGIN), max(0, top - TILE_MARGIN)
                tile = image.crop((x, y, min(right + TILE_MARGIN, width), min(bottom + TILE_MARGIN, height)))
                bgr = np.ascontiguousarray(np.asarray(tile)[:, :, 2::-1])
                output = model.upsample(bgr)
                top_out, left_out = (top - y) * scale, (left - x) * scale
                pixels = output[top_out:top_out + (bottom - top) * scale,
                                left_out:left_out + (right - left) * scale, ::-1]
                result.paste(Image.fromarray(pixels), (left * scale, top * scale))
    except cv_error:
        logging.getLogger(__name__).exception("FSRCNN upscaling failed")
        raise ValueError("超分处理失败，请检查模型文件或尝试较小的图片") from None
    result.putalpha(image.getchannel("A").resize(size, Image.Resampling.LANCZOS))
    return image_editor.save(root, result, "upscale")
