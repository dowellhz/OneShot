"""Track a shot's first-frame mask and composite a remade clip over the original."""
from __future__ import annotations

from fractions import Fraction

import numpy as np

import image_editor
import render

TRACK_SIZE = 480


class MaskTrack:
    def __init__(self, image, mask, cv):
        height, width = image.shape[:2]
        scale = min(1.0, TRACK_SIZE / max(height, width))
        self.shape = (max(16, round(width * scale)), max(16, round(height * scale)))
        x, y = np.meshgrid(np.arange(self.shape[0], dtype="float32"), np.arange(self.shape[1], dtype="float32"))
        self.grid = np.stack((x, y), axis=-1)
        self.cv = cv
        self.previous = self.gray(image)
        self.mask = cv.resize(mask, self.shape, interpolation=cv.INTER_NEAREST)
        self.initial_area = np.count_nonzero(self.mask)
        if self.initial_area < 16:
            raise ValueError("首帧选区太小，无法跟踪")
        self.unstable_frames = 0

    def gray(self, image):
        return self.cv.resize(self.cv.cvtColor(image, self.cv.COLOR_RGB2GRAY), self.shape, interpolation=self.cv.INTER_AREA)

    def advance(self, image, index):
        cv = self.cv
        current = self.gray(image)
        flow = cv.calcOpticalFlowFarneback(current, self.previous, None, .5, 3, 21, 3, 5, 1.2, 0)
        mapping = self.grid + flow
        before = cv.remap(self.previous, mapping, None, cv.INTER_LINEAR)
        mask = cv.remap(self.mask, mapping, None, cv.INTER_LINEAR)
        mask = np.where(mask >= 128, 255, 0).astype("uint8")
        area = np.count_nonzero(mask)
        if area < max(16, self.initial_area * .25) or area > self.initial_area * 2.5:
            raise ValueError(f"第 {index / render.FPS:.1f} 秒的遮罩已脱离主体，请改用整镜重制")
        error = cv.absdiff(current, before)[mask > 0].mean()
        self.unstable_frames = self.unstable_frames + 1 if error > 55 else 0
        if self.unstable_frames >= 3:
            raise ValueError(f"第 {index / render.FPS:.1f} 秒附近的运动无法稳定跟踪，请改用整镜重制")
        self.previous, self.mask = current, mask

    def at_size(self, width, height):
        return self.cv.resize(self.mask, (width, height), interpolation=self.cv.INTER_NEAREST)


def mask_center(mask):
    xs = np.flatnonzero(np.any(mask, axis=0))
    ys = np.flatnonzero(np.any(mask, axis=1))
    if not len(xs) or not len(ys):
        raise ValueError("人物遮罩为空")
    return (float(xs[0] + xs[-1]) / 2, float(ys[0] + ys[-1]) / 2)


def composite_frame(original, replacement, original_mask, replacement_mask, cv):
    height, width = original.shape[:2]
    ox, oy = mask_center(original_mask)
    rx, ry = mask_center(replacement_mask)
    shift_x, shift_y = round(ox - rx), round(oy - ry)
    if abs(shift_x) > width * .22 or abs(shift_y) > height * .22:
        raise ValueError("生成角色与原片位置偏差过大，请重试镜头视频")
    matrix = np.float32([[1, 0, shift_x], [0, 1, shift_y]])
    aligned = cv.warpAffine(replacement, matrix, (width, height), borderMode=cv.BORDER_REPLICATE)
    moved_mask = cv.warpAffine(replacement_mask, matrix, (width, height), flags=cv.INTER_NEAREST)
    overlap = np.count_nonzero(original_mask & moved_mask)
    if overlap < np.count_nonzero(original_mask) * .55:
        raise ValueError("生成角色与原片的轮廓差异过大，请改用整镜重制")
    blur = cv.GaussianBlur(original_mask, (0, 0), max(.5, min(width, height) / 400))
    feather = np.where(original_mask > 0, blur, 0).astype("float32")[..., None] / 255
    return np.rint(original * (1 - feather) + aligned * feather).astype("uint8")


def localized_clip(root, source_ref, video_ref, mask_ref, start, end, progress, cancelled):
    import av
    try:
        import cv2 as cv
    except ImportError as error:
        raise RuntimeError("局部合成需要安装 opencv-python-headless") from error

    original = render._ref_path(root, source_ref)
    replacement = render._ref_path(root, video_ref)
    width, height, _, _ = render.probe(original)
    width, height = render.target_size(width, height, "source")
    total = round(end * render.FPS) - round(start * render.FPS)
    if total <= 0:
        raise ValueError("镜头时长无效")
    if render.probe(replacement)[2] * render.FPS + .51 < total:
        raise ValueError("生成视频短于原镜头")
    fit = render._fitter(width, height, "pad")
    mask_image = image_editor.load(root, mask_ref).convert("L")
    mask = cv.resize(np.array(mask_image), (width, height), interpolation=cv.INTER_NEAREST)
    mask = np.where(mask >= 128, 255, 0).astype("uint8")
    originals = render.clip_frames(original, start, end, fit, total)
    replacements = render.clip_frames(replacement, 0, total / render.FPS, fit, total)
    path, ref = render._new(root, "output", "remake-local", ".mp4")
    frames = 0
    try:
        with av.open(str(path), "w") as output:
            stream = output.add_stream("libx264", rate=render.FPS)
            stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
            stream.options = {"crf": "17", "preset": "fast"}
            for index, (a, b) in enumerate(zip(originals, replacements, strict=True)):
                if cancelled():
                    raise render.Cancelled()
                if index == 0:
                    original_track, replacement_track = MaskTrack(a, mask, cv), MaskTrack(b, mask, cv)
                    original_mask = replacement_mask = mask
                else:
                    original_track.advance(a, index)
                    replacement_track.advance(b, index)
                    original_mask = original_track.at_size(width, height)
                    replacement_mask = replacement_track.at_size(width, height)
                rgb = composite_frame(a, b, original_mask, replacement_mask, cv)
                frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
                frame.pts, frame.time_base = index, Fraction(1, render.FPS)
                for packet in stream.encode(frame):
                    output.mux(packet)
                frames = index + 1
                if frames % 8 == 0:
                    progress(frames, total)
            if frames != total:
                raise ValueError("镜头没有返回完整画面")
            for packet in stream.encode():
                output.mux(packet)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        originals.close()
        replacements.close()
    progress(total, total)
    return {"ref": ref, "w": width, "h": height, "seconds": frames / render.FPS}
