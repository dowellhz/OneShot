"""成片渲染: a simple timeline (trim, transitions, subtitles, background music with ducking, narration) rendered with PyAV.

Timeline spec (all times in seconds):
{
  "clips": [{"ref": "output:h3studio/x.mp4", "in": 0, "out": 5.2, "trans": "cut"|"fade"|"black", "volume": 1.0,
             "subs": ["台词 1", "台词 2"]}],          # trans = transition INTO the next clip
  "aspect": "source"|"16:9"|"9:16"|"1:1"|"4:3"|"3:4", "fit": "pad"|"crop"|"blur",
  "subtitles": true, "sub_size": 1.0,
  "bgm": {"ref": "input:h3studio/song.mp3", "volume": 0.35, "duck": true} | null,
  "narration": [{"ref": "input:h3studio/n.wav", "start": 1.0, "volume": 1.0}],
  "cover": 1.5 | null
}
"""
from __future__ import annotations

import math
import struct
import time
import uuid
from collections import deque
from contextlib import closing
from fractions import Fraction
from pathlib import Path

from PIL import Image

FPS = 24
SR = 44100
TRANS = 0.5                 # transition length
FONT = Path(__file__).resolve().parent / "fonts" / "NotoSansSC.ttf"


class Cancelled(Exception):
    pass


def _ref_path(comfy_dir: Path, ref: str) -> Path:
    from tools import ref_path
    return ref_path(comfy_dir, ref)


def _new(comfy_dir: Path, kind: str, prefix: str, ext: str):
    name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}{ext}"
    d = comfy_dir / kind / "h3studio"
    d.mkdir(parents=True, exist_ok=True)
    return d / name, f"{kind}:h3studio/{name}"


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


def read_audio(path: Path, t0: float = 0.0, t1: float | None = None):
    """Decode an audio track (of a video or an audio file) to float32 stereo at SR; zeros if there is none."""
    import av
    import numpy as np
    parts = []
    with av.open(str(path)) as c:
        if c.streams.audio:
            rs = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
            for f in c.decode(audio=0):
                for g in rs.resample(f):
                    parts.append(g.to_ndarray())
            for g in rs.resample(None):
                parts.append(g.to_ndarray())
    pcm = np.concatenate(parts, axis=1).astype(np.float32) if parts else np.zeros((2, 0), np.float32)
    a = int(round(t0 * SR))
    b = None if t1 is None else int(round(t1 * SR))
    pcm = pcm[:, a:b]
    if b is not None and pcm.shape[1] < b - a:
        pcm = np.concatenate([pcm, np.zeros((2, b - a - pcm.shape[1]), np.float32)], axis=1)
    return pcm


def target_size(w0: int, h0: int, aspect: str):
    ar = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9}.get(aspect)
    if not ar:
        return w0 - w0 % 2, h0 - h0 % 2
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


def clip_frames(path: Path, t0: float, t1: float, fit, frame_count=None, *, display=True):
    """Frames of [t0, t1) resampled to FPS (each tick shows the frame on screen at that time)."""
    n = frame_count if frame_count is not None else max(1, int(round((t1 - t0) * FPS)))
    with closing(video_ticks(path, t0, n, relative_time=frame_count is not None)) as frames:
        for frame in frames:
            yield fit(frame_image(frame, display=display))


def video_ticks(path: Path, start: float, count: int, *, relative_time: bool):
    """Yield decoded frames on the render timeline without converting their pixels."""
    import av
    k = 0
    with av.open(str(path)) as c:
        stream = c.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base) if relative_time else 0
        # Coarse container timestamps can round a frame past its nominal tick by half a time base.
        epsilon = max(1e-6, min(float(stream.time_base) / 2, .0005)) if relative_time else 1e-6
        lead = epsilon if relative_time else .5 / FPS
        last = None
        for f in c.decode(video=0):
            t = float(f.time if f.time is not None else origin) - origin
            while k < count and start + k / FPS <= t + epsilon:
                yield f if last is None or start + k / FPS >= t - lead else last
                k += 1
            if k >= count:
                break
            last = f
        while k < count and last is not None:  # the clip is shorter than asked: hold the last frame
            yield last
            k += 1


# ------------------------------------------------------------------ subtitles

def _wrap(draw, text: str, font, maxw: int):
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) > maxw and cur:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines[:3]


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


# ------------------------------------------------------------------ the renderer

def original_pcm(path: Path, length: int):
    """Keep the original soundtrack aligned to the video time origin."""
    import av
    import numpy as np
    pcm = np.zeros((2, length), np.float32)
    with av.open(str(path)) as source:
        if not source.streams.audio:
            return pcm
        video = source.streams.video[0]
        origin = float((video.start_time or 0) * video.time_base)
        resample = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
        cursor = 0

        def write(samples):
            nonlocal cursor
            chunk = samples.to_ndarray()
            at = round((samples.time - origin) * SR) if samples.time is not None else cursor
            cursor = at + chunk.shape[1]
            start, end = max(0, at), min(length, cursor)
            if start < end:
                pcm[:, start:end] = chunk[:, start - at:end - at]

        for frame in source.decode(audio=0):
            for samples in resample.resample(frame):
                write(samples)
        for samples in resample.resample(None):
            write(samples)
    return pcm


def render(comfy_dir: Path, spec: dict, progress=lambda done, total: None, cancelled=lambda: False,
           *, source_audio: Path | None = None, display=True, max_side=None) -> dict:
    import av
    import numpy as np
    from PIL import Image
    clips = [c for c in spec.get("clips") or [] if c.get("ref")]
    if not clips:
        raise ValueError("时间线上没有视频")
    info = []
    for c in clips:
        p = _ref_path(comfy_dir, c["ref"])
        w, h, dur, _ = probe(p, display=display)
        t0 = max(0.0, float(c.get("in") or 0))
        t1 = float(c.get("out") or dur)
        exact = c.get("frames") if source_audio is not None else None
        if exact is None:
            minimum = 1 / FPS if spec.get("remake_audio") and c.get("audio_start") is not None else .5
            t1 = min(max(t1, t0 + minimum), dur if dur > 0 else t1)
        info.append({"path": p, "t0": t0, "t1": t1, "n": exact if exact is not None else max(1, int(round((t1 - t0) * FPS))),
                     "trans": c.get("trans") or "cut", "vol": float(c.get("volume", 1.0)), "subs": c.get("subs") or [],
                     "audio_start": c.get("audio_start"), "w": w, "h": h})
    remake_source = _ref_path(comfy_dir, spec["remake_audio"]) if source_audio is None and spec.get("remake_audio") else None
    reference = source_audio if source_audio is not None else remake_source
    w, h = probe(reference, display=display)[:2] if reference is not None else (info[0]["w"], info[0]["h"])
    W, H = target_size(w, h, spec.get("aspect") or "source")
    if max_side and max(W, H) > max_side:
        scale = max_side / max(W, H)
        W, H = (max(2, round(side * scale / 2) * 2) for side in (W, H))
    fit = _fitter(W, H, spec.get("fit") or "pad")
    nt = max(1, int(round(TRANS * FPS)))
    # timeline layout: a fade overlaps the next clip by nt frames; a dip to black does not
    starts, pos = [], 0
    for i, c in enumerate(info):
        starts.append(pos)
        ov = nt if i + 1 < len(info) and c["trans"] == "fade" else 0
        ov = min(ov, c["n"] // 2, info[i + 1]["n"] // 2) if ov else 0
        c["ov"] = ov
        pos += c["n"] - ov
    total = pos

    # ---- audio: clips, then narration, then music under everything
    pcm = np.zeros((2, int(round(total / FPS * SR)) + SR), np.float32)
    speech = np.zeros(pcm.shape[1], np.float32)        # 1 where dialogue / narration is heard (for ducking)
    original = None
    if remake_source is not None:
        duration = probe(remake_source, display=False)[2]
        if not 0 < duration <= 60:
            raise ValueError("重制原声音轨须来自 60 秒以内的原片")
        original = original_pcm(remake_source, round(duration * SR))
    for i, c in enumerate(info):
        if source_audio is not None:
            break
        if original is not None and c["audio_start"] is not None:
            start = round((float(c["audio_start"]) + c["t0"]) * SR)
            if not 0 <= start <= original.shape[1]:
                raise ValueError("原声入点超出原片范围")
            length = round(c["n"] / FPS * SR)
            a = np.zeros((2, length), dtype=np.float32)
            end = min(start + length, original.shape[1])
            a[:, :end - start] = original[:, start:end] * c["vol"]
        else:
            a = read_audio(c["path"], c["t0"], c["t1"]) * c["vol"]
        L = a.shape[1]
        g = np.ones(L, np.float32)
        r = int(round(c["ov"] / FPS * SR)) if c["ov"] else 0
        rin = int(round(info[i - 1]["ov"] / FPS * SR)) if i and info[i - 1]["ov"] else 0
        if r:
            g[L - r:] *= np.linspace(1, 0, r, dtype=np.float32)
        if rin:
            g[:rin] *= np.linspace(0, 1, rin, dtype=np.float32)
        if c["trans"] == "black" and i + 1 < len(info):
            k = min(L, int(TRANS / 2 * SR)); g[L - k:] *= np.linspace(1, 0, k, dtype=np.float32)
        if i and info[i - 1]["trans"] == "black":
            k = min(L, int(TRANS / 2 * SR)); g[:k] *= np.linspace(0, 1, k, dtype=np.float32)
        s = int(round(starts[i] / FPS * SR))
        pcm[:, s:s + L] += a[:, :pcm.shape[1] - s] * g[:pcm.shape[1] - s]
        if c["subs"]:
            speech[s:s + L] = 1
    narr = np.zeros_like(pcm)
    for n in spec.get("narration") or []:
        try:
            a = read_audio(_ref_path(comfy_dir, n["ref"])) * float(n.get("volume", 1.0))
        except Exception:
            continue
        s = int(round(float(n.get("start") or 0) * SR))
        L = max(0, min(a.shape[1], pcm.shape[1] - s))
        narr[:, s:s + L] += a[:, :L]
        speech[s:s + L] = 1
    if narr.any():   # the clips' own sound steps back under narration
        env = _smooth(np.maximum(_activity(narr), 0), SR // 5)
        pcm *= 1 - 0.55 * env
        pcm += narr
    bgm = spec.get("bgm") or {}
    if bgm.get("ref"):
        m = read_audio(_ref_path(comfy_dir, bgm["ref"]))
        if m.shape[1]:
            reps = int(np.ceil(pcm.shape[1] / m.shape[1]))
            m = np.tile(m, (1, reps))[:, :pcm.shape[1]] * float(bgm.get("volume", 0.35))
            Lt = int(round(total / FPS * SR))
            fi, fo = min(Lt, SR), min(Lt, 2 * SR)
            m[:, :fi] *= np.linspace(0, 1, fi, dtype=np.float32)
            m[:, Lt - fo:Lt] *= np.linspace(1, 0, fo, dtype=np.float32)
            m[:, Lt:] = 0
            if bgm.get("duck", True):
                m *= 1 - 0.65 * _smooth(speech, int(SR * 0.3))
            pcm += m
    pcm = pcm[:, :int(round(total / FPS * SR))]
    peak = float(np.max(np.abs(pcm))) if pcm.size else 0
    if peak > 0.98:
        pcm *= 0.98 / peak
    if source_audio is not None:
        pcm = original_pcm(source_audio, int(round(total / FPS * SR)))

    # ---- subtitles on the timeline
    cues = []
    if spec.get("subtitles", True):
        for i, c in enumerate(info):
            s = (starts[i] + (info[i - 1]["ov"] if i else 0)) / FPS      # not over a crossfade: two lines would overlap
            for a, b, text in cue_times(c["subs"], s, (starts[i] + c["n"] - c["ov"]) / FPS):
                ov, y = subtitle_overlay(text, W, H, float(spec.get("sub_size") or 1.0))
                cues.append((int(a * FPS), int(b * FPS), ov, y))

    def burn(arr, k):
        for a, b, ov, y in cues:
            if a <= k < b:
                h = min(ov.shape[0], H - y)
                al = ov[:h, :, 3:4] / 255.0
                part = arr[y:y + h].astype(np.float32)
                arr = arr.copy()
                arr[y:y + h] = (part * (1 - al) + ov[:h, :, :3] * al).astype(np.uint8)
        return arr

    # ---- video
    path, ref = _new(comfy_dir, "output", "film", ".mp4")
    out = av.open(str(path), "w")
    vo = out.add_stream("libx264", rate=FPS)
    vo.width, vo.height, vo.pix_fmt = W, H, "yuv420p"
    vo.options = {"crf": "18", "preset": "medium"}
    ao = out.add_stream("aac", rate=SR)
    ao.layout = "stereo"
    cover_k = None if spec.get("cover") is None else int(float(spec["cover"]) * FPS)
    cover = None
    k = 0

    def emit(arr):
        nonlocal k, cover
        arr = burn(arr, k)
        if cover_k is not None and k == min(cover_k, total - 1):
            cover = Image.fromarray(arr)
        fr = av.VideoFrame.from_ndarray(arr, format="rgb24")
        fr.pts = k; fr.time_base = Fraction(1, FPS)
        for pkt in vo.encode(fr):
            out.mux(pkt)
        k += 1
        if k % 12 == 0:
            progress(k, total)
            if cancelled():
                raise Cancelled()

    try:
        held: deque = deque()          # tail of the previous clip waiting to be blended into this one
        for i, c in enumerate(info):
            blend_in = list(held); held.clear()
            nb = int(TRANS / 2 * FPS)
            frames = c["n"] if source_audio is not None or original is not None and c["audio_start"] is not None else None
            for j, arr in enumerate(clip_frames(c["path"], c["t0"], c["t1"], fit, frames, display=display)):
                if j < len(blend_in):                       # crossfade
                    a = (j + 1) / (len(blend_in) + 1)
                    arr = (blend_in[j].astype(np.float32) * (1 - a) + arr.astype(np.float32) * a).astype(np.uint8)
                if i and info[i - 1]["trans"] == "black" and j < nb:
                    arr = (arr.astype(np.float32) * (j / nb)).astype(np.uint8)
                if c["trans"] == "black" and i + 1 < len(info) and j >= c["n"] - nb:
                    arr = (arr.astype(np.float32) * ((c["n"] - 1 - j) / nb)).astype(np.uint8)
                if c["ov"] and j >= c["n"] - c["ov"]:
                    held.append(arr)
                else:
                    emit(arr)
        for arr in held:
            emit(arr)
        for pkt in vo.encode():
            out.mux(pkt)
        apts = 0
        for i in range(0, pcm.shape[1], 1024):
            chunk = np.ascontiguousarray(pcm[:, i:i + 1024])
            af = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="stereo")
            af.sample_rate = SR
            af.pts = apts; af.time_base = Fraction(1, SR)
            apts += chunk.shape[1]
            for pkt in ao.encode(af):
                out.mux(pkt)
        for pkt in ao.encode():
            out.mux(pkt)
        out.close()
    except BaseException:
        out.close()
        path.unlink(missing_ok=True)
        raise
    progress(total, total)
    res = {"ref": ref, "w": W, "h": H, "seconds": round(k / FPS, 2)}
    if cover is not None:
        cp, cr = _new(comfy_dir, "output", "cover", ".jpg")
        cover.save(cp, quality=92)
        res["cover"] = cr
    return res


def _activity(pcm):
    import numpy as np
    return (np.abs(pcm).max(axis=0) > 0.01).astype(np.float32)


def _smooth(x, n: int):
    """Envelope with soft edges: a box filter wide enough to ramp in and out."""
    import numpy as np
    if not x.any():
        return x
    n = max(1, n)
    k = np.ones(n, np.float32) / n
    y = np.convolve(x, k, mode="same")
    return np.clip(y * 2, 0, 1)


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
