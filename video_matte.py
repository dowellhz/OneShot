"""Track character and foreground masks for shot-local video compositing."""
from __future__ import annotations

from contextlib import closing
from fractions import Fraction

import numpy as np

import image_editor
import render

TRACK_SIZE = 480


def tracking_shape(width, height):
    scale = min(1.0, TRACK_SIZE / max(height, width))
    return max(16, round(width * scale)), max(16, round(height * scale))


def tracking_gray(image, shape, cv):
    if image.ndim == 2:
        return image
    return cv.resize(cv.cvtColor(image, cv.COLOR_RGB2GRAY), shape, interpolation=cv.INTER_AREA)


class MaskTrack:
    def __init__(self, image, mask, cv):
        height, width = image.shape[:2]
        self.shape = tracking_shape(width, height)
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
        return tracking_gray(image, self.shape, self.cv)

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


def backward_masks(path, start, end, shape, fit, intervals, corrections, load_mask, cv, progress, cancelled, *, display):
    last_anchor = intervals[-1][1]
    grays = []
    with closing(render.clip_frames(path, start, end, fit, last_anchor + 1, display=display)) as frames:
        for index, frame in enumerate(frames):
            if cancelled():
                raise render.Cancelled()
            grays.append(tracking_gray(frame, shape, cv))
            if index % 8 == 0:
                progress(index + 1)

    backwards = {}
    done = len(grays)
    for left, right in intervals:
        track = MaskTrack(grays[right], load_mask(corrections[right]), cv)
        for index in range(right - 1, left, -1):
            if cancelled():
                raise render.Cancelled()
            try:
                track.advance(grays[index], index)
            except ValueError:
                break
            backwards[index] = (track.mask, (index - left) / (right - left))
            done += 1
            if done % 8 == 0:
                progress(done)
    return backwards


def reconcile_masks(forward, reverse, weight, cv):
    if forward is None:
        return reverse
    if np.array_equal(forward, reverse):
        return forward
    intersection = np.count_nonzero(forward & reverse)
    if intersection < .5 * max(np.count_nonzero(forward), np.count_nonzero(reverse)):
        # Strong disagreement means blending could place the replacement on the background.
        return forward if weight < .5 else reverse

    def signed(mask):
        return cv.distanceTransform(mask, cv.DIST_L2, 3) - cv.distanceTransform(cv.bitwise_not(mask), cv.DIST_L2, 3)

    blend = signed(forward) * (1 - weight) + signed(reverse) * weight
    return np.where(blend > 0, 255, 0).astype("uint8")


def follow_mask(track, image, index, fallback, cv):
    if track is not None:
        try:
            track.advance(image, index)
        except ValueError:
            if fallback is None:
                raise
            track = None
    if fallback is None and track is None:
        raise ValueError("无法从任一校正帧跟踪人物")
    height, width = image.shape[:2]
    if fallback is None:
        return track, track.at_size(width, height)
    merged = reconcile_masks(track.mask if track is not None else None, *fallback, cv)
    return track, cv.resize(merged, (width, height), interpolation=cv.INTER_NEAREST)


def mask_center(mask):
    xs = np.flatnonzero(np.any(mask, axis=0))
    ys = np.flatnonzero(np.any(mask, axis=1))
    if not len(xs) or not len(ys):
        raise ValueError("人物遮罩为空")
    return (float(xs[0] + xs[-1]) / 2, float(ys[0] + ys[-1]) / 2)


def composite_frame(original, replacement, original_mask, replacement_mask, cv, protect_mask=None):
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
    editable = original_mask if protect_mask is None else cv.subtract(original_mask, protect_mask)
    blur = cv.GaussianBlur(editable, (0, 0), max(.5, min(width, height) / 400))
    feather = np.where(editable > 0, blur, 0).astype("float32")[..., None] / 255
    return np.rint(original * (1 - feather) + aligned * feather).astype("uint8")


def localized_clip(root, source_ref, video_ref, mask_ref, start, end, progress, cancelled, *,
                   corrections=None, replacement_corrections=None, protections=None, display=True):
    import av
    try:
        import cv2 as cv
    except ImportError as error:
        raise RuntimeError("局部合成需要安装 opencv-python-headless") from error

    original = render._ref_path(root, source_ref)
    replacement = render._ref_path(root, video_ref)
    width, height, _, _ = render.probe(original, display=display)
    width, height = render.target_size(width, height, "source")
    total = round(end * render.FPS) - round(start * render.FPS)
    if total <= 0:
        raise ValueError("镜头时长无效")
    if render.probe(replacement, display=False)[2] * render.FPS + .51 < total:
        raise ValueError("生成视频短于原镜头")
    fit = render._fitter(width, height, "pad")
    def load_mask(ref):
        image = image_editor.load(root, ref).convert("L")
        mask = cv.resize(np.array(image), (width, height), interpolation=cv.INTER_NEAREST)
        return np.where(mask >= 128, 255, 0).astype("uint8")

    mask = load_mask(mask_ref)
    corrections = corrections or {}
    replacement_corrections = replacement_corrections or {}
    protections = protections or {}

    passes = []
    for path, begin, finish, marks in (
        (original, start, end, corrections), (replacement, 0, total / render.FPS, replacement_corrections)
    ):
        anchors = sorted({0, *marks})
        intervals = [(left, right) for left, right in zip(anchors, anchors[1:])
                     if right - left > 1 and marks.get(left, mask_ref) and marks[right]]
        budget = 2 * intervals[-1][1] + 1 if intervals else 0
        passes.append((path, begin, finish, marks, intervals, budget))
    work = total + sum(item[-1] for item in passes)
    preparation = 0
    reverse_tracks = []
    for path, begin, finish, marks, intervals, budget in passes:
        backward = {}
        if intervals:
            backward = backward_masks(path, begin, finish, tracking_shape(width, height), fit,
                                      intervals, marks, load_mask, cv,
                                      lambda done: progress(preparation + done, work), cancelled, display=display)
            preparation += budget
            progress(preparation, work)
        reverse_tracks.append(backward)
    original_backward, replacement_backward = reverse_tracks
    foreground_track = None
    original_track = replacement_track = None
    absent = False
    originals = render.clip_frames(original, start, end, fit, total, display=display)
    replacements = render.clip_frames(replacement, 0, total / render.FPS, fit, total, display=display)
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
                entering = absent
                if index in corrections:
                    absent = corrections[index] is None
                    if absent:
                        original_track = replacement_track = None
                if not absent:
                    if index == 0 or index in corrections:
                        original_mask = mask if index == 0 else load_mask(corrections[index])
                        original_track = MaskTrack(a, original_mask, cv)
                    else:
                        try:
                            original_track, original_mask = follow_mask(original_track, a, index, original_backward.get(index), cv)
                        except ValueError as error:
                            at = start + index / render.FPS
                            raise ValueError(f"原片 {at:.2f} 秒的人物选区失稳，请在附近添加校正帧") from error
                    ref_at_guide = replacement_corrections.get(index)
                    if index == 0 or entering or ref_at_guide:
                        replacement_mask = load_mask(ref_at_guide) if ref_at_guide else original_mask
                        replacement_track = MaskTrack(b, replacement_mask, cv)
                    else:
                        try:
                            replacement_track, replacement_mask = follow_mask(
                                replacement_track, b, index, replacement_backward.get(index), cv)
                        except ValueError as error:
                            at = start + index / render.FPS
                            raise ValueError(f"原片 {at:.2f} 秒对应的生成角色跟踪失稳，请在附近添加动作关键帧后重新生成") from error
                try:
                    if index in protections:
                        ref_at_frame = protections[index]
                        foreground_track = MaskTrack(a, load_mask(ref_at_frame), cv) if ref_at_frame else None
                    elif foreground_track is not None:
                        foreground_track.advance(a, index)
                except ValueError as error:
                    at = (round(start * render.FPS) + index) / render.FPS
                    raise ValueError(f"原片 {at:.2f} 秒的前景保护区无法跟踪，请在附近添加校正帧") from error
                protect_mask = foreground_track.at_size(width, height) if foreground_track is not None else None
                rgb = a if absent else composite_frame(a, b, original_mask, replacement_mask, cv, protect_mask)
                frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
                frame.pts, frame.time_base = index, Fraction(1, render.FPS)
                for packet in stream.encode(frame):
                    output.mux(packet)
                frames = index + 1
                if frames % 8 == 0:
                    progress(preparation + frames, work)
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
    progress(work, work)
    return {"ref": ref, "w": width, "h": height, "seconds": frames / render.FPS}
