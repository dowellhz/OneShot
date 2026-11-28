"""Probe, decode, size, and encode visual media for the editor."""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
import math
import struct

from PIL import Image

from oneshot.generation.media_files import FPS
from oneshot.generation.media_files import _new
from oneshot.generation.media_files import ref_path as _ref_path


class Cancelled(Exception):
    pass


def encode_silent(path, frames, width, height, fps, cancelled, on_frame):
    """Encode a sequence of PIL images as a silent, seekable MP4."""
    import av
    with av.open(str(path), "w", options={"movflags": "+faststart"}) as output:
        stream = output.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.options = {"preset": "fast", "crf": "16"}
        count = 0
        for image in frames:
            if cancelled():
                raise Cancelled()
            frame = av.VideoFrame.from_image(image.convert("RGB"))
            for packet in stream.encode(frame):
                output.mux(packet)
            count += 1
            on_frame(count)
        if not count:
            raise ValueError("没有可编码的视频帧")
        for packet in stream.encode():
            output.mux(packet)
    return count


DISPLAY_TRANSFORMS = {
    (-1, 0, 0, 1): Image.Transpose.FLIP_LEFT_RIGHT,
    (1, 0, 0, -1): Image.Transpose.FLIP_TOP_BOTTOM,
    (-1, 0, 0, -1): Image.Transpose.ROTATE_180,
    (0, -1, 1, 0): Image.Transpose.ROTATE_90,
    (0, 1, -1, 0): Image.Transpose.ROTATE_270,
    (0, 1, 1, 0): Image.Transpose.TRANSPOSE,
    (0, -1, -1, 0): Image.Transpose.TRANSVERSE,
}
SWAPS_AXES = {Image.Transpose.ROTATE_90, Image.Transpose.ROTATE_270, Image.Transpose.TRANSPOSE, Image.Transpose.TRANSVERSE}


def display_transform(frame):
    matrix = frame.side_data.get("DISPLAYMATRIX")
    if matrix is None or matrix.buffer_size < 36:
        return None
    a, b, u, c, d, v, _, _, w = struct.unpack_from("=9i", bytes(matrix))
    if u or v or w <= 0:
        return None
    signs = tuple(1 if value > 1 else -1 if value < -1 else 0 for value in (a, b, c, d))
    return DISPLAY_TRANSFORMS.get(signs)


def frame_image(frame, *, display=True, thumbnail_size=None):
    transform = display_transform(frame) if display else None
    if thumbnail_size:
        w, h = thumbnail_size[::-1] if transform in SWAPS_AXES else thumbnail_size
        frame = frame.reformat(width=w, height=h, format="rgb24")
    image = frame.to_image()
    return image.transpose(transform) if transform is not None else image


def probe(path: Path, *, display=True):
    import av
    with av.open(str(path)) as c:
        if not c.streams.video:
            raise ValueError("文件没有视频轨")
        v = c.streams.video[0]
        dur = float(v.duration * v.time_base) if v.duration else float(c.duration or 0) / 1e6
        if not v.duration and "matroska" in c.format.name.split(","):
            # Matroska/WebM reports the end timestamp, often with no stream.duration.
            # Prefer the video track's end so a longer soundtrack won't extend the picture.
            end = v.metadata.get("DURATION", "")
            try:
                hours, minutes, seconds = end.split(":")
                end_time = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            except ValueError:
                end_time = dur
            if not math.isfinite(end_time):
                end_time = dur
            dur = max(0, end_time - float((v.start_time or 0) * v.time_base))
        w, h = v.codec_context.width, v.codec_context.height
        if display:
            frame = next(c.decode(video=0), None)
            if frame is not None:
                w, h = frame.width, frame.height
                if display_transform(frame) in SWAPS_AXES:
                    w, h = h, w
        return w, h, dur, bool(c.streams.audio)


def clip_info(comfy_dir, clip, *, display=True):
    """Resolve the picture size and source interval for a video or still."""
    from oneshot.editing.image_editor import load, number

    path = _ref_path(comfy_dir, clip["ref"])
    kind = clip.get("kind", "video")
    if kind == "image":
        if clip.get("audio_start") is not None or clip.get("audio_ref") or clip.get("remake_shot"):
            raise ValueError("静态图片不能使用原片音轨")
        duration = number(clip.get("duration"), .5, 60, "图片停留时长", 3)
        w, h = load(comfy_dir, clip["ref"]).size
        return path, w, h, duration, 0.0, duration
    if kind != "video":
        raise ValueError("不支持的片段类型")
    w, h, duration, _ = probe(path, display=display)
    start = float(clip.get("in") or 0)
    end = float(clip["out"]) if clip.get("out") is not None else duration
    return path, w, h, duration, start, end


def target_size(w0: int, h0: int, aspect: str):
    ar = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9}.get(aspect)
    if not ar:
        return max(2, w0 - w0 % 2), max(2, h0 - h0 % 2)
    px = w0 * h0
    w = math.sqrt(px * ar)
    h = w / ar
    w, h = int(round(w / 16)) * 16, int(round(h / 16)) * 16
    return max(16, w), max(16, h)


def _fitter(W: int, H: int, mode: str):
    from PIL import Image, ImageFilter
    import numpy as np

    def fit(img: Image.Image) -> np.ndarray:
        if img.size == (W, H):
            return np.asarray(img.convert("RGB"))
        iw, ih = img.size
        if mode == "crop":
            s = max(W / iw, H / ih)
            r = img.resize((max(W, round(iw * s)), max(H, round(ih * s))), Image.BILINEAR)
            x, y = (r.width - W) // 2, (r.height - H) // 2
            return np.asarray(r.crop((x, y, x + W, y + H)).convert("RGB"))
        s = min(W / iw, H / ih)
        fg = img.resize((max(2, round(iw * s)), max(2, round(ih * s))), Image.BILINEAR)
        if mode == "blur":
            sb = max(W / iw, H / ih) / 4
            small = img.resize((max(2, round(iw * sb)), max(2, round(ih * sb))), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
            bg = small.resize((max(W, round(small.width * 4)), max(H, round(small.height * 4))), Image.BILINEAR)
            x, y = (bg.width - W) // 2, (bg.height - H) // 2
            bg = bg.crop((x, y, x + W, y + H)).point(lambda v: int(v * 0.55))
        else:
            bg = Image.new("RGB", (W, H))
        bg.paste(fg, ((W - fg.width) // 2, (H - fg.height) // 2))
        return np.asarray(bg.convert("RGB"))
    return fit


def clip_frames(path: Path, t0: float, t1: float, fit, frame_count=None, *, display=True, seek=False, speed=1):
    """Frames of [t0, t1) resampled to FPS (each tick shows the frame on screen at that time)."""
    n = frame_count if frame_count is not None else max(1, int(round((t1 - t0) * FPS)))
    with closing(video_ticks(path, t0, n, relative_time=frame_count is not None, seek=seek, speed=speed)) as frames:
        for frame in frames:
            yield fit(frame_image(frame, display=display))


def video_ticks(path: Path, start: float, count: int, *, relative_time: bool, seek=False, speed=1):
    """Yield decoded frames on the render timeline without converting their pixels."""
    import av
    k = 0
    with av.open(str(path)) as c:
        stream = c.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base) if relative_time else 0
        if seek and start > 1:
            try:
                c.seek(int((origin + start) / stream.time_base), stream=stream, backward=True)
            except (OSError, ValueError):
                pass
        # Coarse container timestamps can round a frame past its nominal tick by half a time base.
        epsilon = max(1e-6, min(float(stream.time_base) / 2, .0005)) if relative_time else 1e-6
        lead = epsilon if relative_time else .5 / FPS
        last = None
        for f in c.decode(video=0):
            t = float(f.time if f.time is not None else origin) - origin
            while k < count and start + k * speed / FPS <= t + epsilon:
                yield f if last is None or start + k * speed / FPS >= t - lead else last
                k += 1
            if k >= count:
                break
            last = f
        while k < count and last is not None:  # the clip is shorter than asked: hold the last frame
            yield last
            k += 1


def capture_frame(path, position, at=None):
    """Return the displayed frame and its actual time relative to the video track."""
    import av

    with av.open(str(path)) as source:
        stream = source.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base)
        if position == "first":
            frame = next(source.decode(video=0), None)
        elif position == "last":
            frame = None
            for frame in source.decode(video=0):
                pass
        else:
            with closing(video_ticks(path, at, 1, relative_time=True, seek=True)) as frames:
                frame = next(frames, None)
    if frame is None:
        raise ValueError("视频没有可截取的画面")
    time = max(0, float(frame.time) - origin) if frame.time is not None else at or 0
    return frame_image(frame, display=True), round(time, 6)


# ------------------------------------------------------------------ subtitles


def clip_speed(clip):
    from oneshot.editing.image_editor import number
    speed = number(clip.get("speed"), .5, 2, "播放速度", 1)
    if speed != 1 and clip.get("kind") == "image":
        raise ValueError("图片片段请调整停留时长")
    return speed


def cover_frame(comfy_dir: Path, ref: str, at: float) -> dict:
    """One frame of a video, saved as a jpg (for picking a cover)."""
    import av
    src = _ref_path(comfy_dir, ref)
    img = None
    with av.open(str(src)) as c:
        for f in c.decode(video=0):
            img = frame_image(f)
            if float(f.time or 0) >= at:
                break
    if img is None:
        raise RuntimeError("读不出画面")
    p, r = _new(comfy_dir, "output", "cover", ".jpg")
    img.convert("RGB").save(p, quality=92)
    return {"ref": r, "w": img.width, "h": img.height}
