"""成片渲染: a simple timeline (trim, transitions, subtitles, background music with ducking, narration) rendered with PyAV.

Timeline spec (all times in seconds). An image clip uses kind="image" and duration instead of in/out:
{
  "clips": [{"ref": "output:h3studio/x.mp4", "in": 0, "out": 5.2, "trans": "cut"|"fade"|"black", "volume": 1.0, "speed": 1.0,
             "subs": ["台词 1", "台词 2"]}],          # trans = transition INTO the next clip
  "aspect": "source"|"16:9"|"9:16"|"1:1"|"4:3"|"3:4", "fit": "pad"|"crop"|"blur",
  "subtitles": true, "sub_size": 1.0,
  "titles": [{"text": "开场", "start": 0.5, "end": 2.5, "position": "center", "style": "plain"}],
  "cutaways": [{"ref": "input:h3studio/insert.mp4", "kind": "video", "start": 3, "duration": 2, "in": 1}],
  "bgm": {"ref": "input:h3studio/song.mp3", "volume": 0.35, "duck": true} | null,
  "narration": [{"ref": "input:h3studio/n.wav", "start": 1.0, "volume": 1.0}],
  "audio_clips": [{"ref": "input:h3studio/fx.wav", "start": 1.2, "in": 0.3, "out": 1.3, "volume": 0.8}],
  "cover": 1.5 | null
}
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import struct
import time
import uuid
import wave
from collections import deque
from contextlib import closing
from fractions import Fraction
from pathlib import Path

from PIL import Image

FPS = 24
SR = 44100
AUDIO_OUTPUT_RATES = {"wav":[8000,16000,24000,32000,44100,48000],
                      "mp3":[8000,16000,24000,32000,44100,48000],"ogg":[48000]}
TRANS = 0.5                 # transition length
FONT = Path(__file__).resolve().parent / "fonts" / "NotoSansSC.ttf"
CAPTION_LIMIT = 300
TITLE_LIMIT = 20
TITLE_POSITIONS = {"top":.13, "center":.5, "lower_left":.76}
TITLE_STYLES = {"plain", "label"}
CUTAWAY_LIMIT = 24


def playlist_revision(spec):
    return hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


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
    from image_editor import load, number

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


def read_audio(path: Path, t0: float = 0.0, t1: float | None = None):
    """Decode an audio track (of a video or an audio file) to float32 stereo at SR; zeros if there is none."""
    import av
    import numpy as np
    parts = []
    end = None if t1 is None else int(round(t1 * SR))
    decoded = 0
    with av.open(str(path)) as c:
        if c.streams.audio:
            rs = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
            for f in c.decode(audio=0):
                for g in rs.resample(f):
                    parts.append(g.to_ndarray())
                    decoded += g.samples
                if end is not None and decoded >= end:
                    break
            else:
                for g in rs.resample(None):
                    parts.append(g.to_ndarray())
    pcm = np.concatenate(parts, axis=1).astype(np.float32) if parts else np.zeros((2, 0), np.float32)
    a = int(round(t0 * SR))
    pcm = pcm[:, a:end]
    if end is not None and pcm.shape[1] < end - a:
        pcm = np.concatenate([pcm, np.zeros((2, end - a - pcm.shape[1]), np.float32)], axis=1)
    return pcm


def audio_duration(path):
    import av
    with av.open(str(path)) as media:
        if not media.streams.audio:
            raise ValueError("文件没有音轨")
        stream = media.streams.audio[0]
        seconds = float(stream.duration * stream.time_base) if stream.duration else float(media.duration or 0) / 1e6
    if seconds <= 0:
        raise ValueError("音频时长不可用")
    return seconds


def audio_delivery_effects(frames, layout, sample_rate, sample_format, pitch, gain):
    import av

    clock = Fraction(1,sample_rate)
    graph = av.filter.Graph()
    tail = graph.add_abuffer(sample_rate=sample_rate,format="fltp",layout=layout,time_base=clock)
    filters = []
    if pitch:
        shifted_rate = round(sample_rate * 2**(pitch/12))
        filters.extend((("asetrate",str(shifted_rate)),("aresample",str(sample_rate)),
                        ("atempo",str(sample_rate/shifted_rate))))
    if gain != 1:
        filters.append(("volume",str(gain)))
    filters.extend((("aformat",f"sample_fmts={sample_format}"),("abuffersink",None)))
    for kind, config in filters:
        next_filter = graph.add(kind,config) if config is not None else graph.add(kind)
        tail.link_to(next_filter)
        tail = next_filter
    graph.configure()
    fifo = av.AudioFifo()
    total = emitted = 0
    reserve = max(4096,sample_rate//6) if pitch else 0

    def drain():
        while True:
            try:
                frame = graph.pull()
            except (av.error.BlockingIOError,av.error.EOFError):
                return
            frame.pts = None
            fifo.write(frame)

    def silence(fmt,samples):
        frame = av.AudioFrame(format=fmt,layout=layout,samples=samples)
        frame.sample_rate = sample_rate
        for plane in frame.planes:
            plane.update(bytes(plane.buffer_size))
        return frame

    for frame in frames:
        frame.pts, frame.time_base = total, clock
        total += frame.samples
        graph.push(frame)
        drain()
        count = min(max(0,fifo.samples-reserve),total-emitted)
        if count:
            emitted += count
            yield fifo.read(count)
    if pitch and total:
        padding = silence("fltp",reserve)
        padding.pts, padding.time_base = total, clock
        graph.push(padding)
    graph.push(None)
    drain()
    remaining = total-emitted
    count = min(remaining,fifo.samples)
    if count:
        yield fifo.read(count)
    if count < remaining:
        yield silence(sample_format,remaining-count)


def encode_audio_delivery(source, target, audio_format, sample_rate, cancelled, *, pitch=0, gain=1):
    import av

    codec, sample_format = {"wav":("pcm_s16le","s16"),"mp3":("libmp3lame","fltp"),"ogg":("libopus","s16")}[audio_format]
    written = 0
    try:
        with av.open(str(source)) as incoming, av.open(str(target), "w", format=audio_format) as outgoing:
            if not incoming.streams.audio:
                raise ValueError("文件没有音轨")
            original = incoming.streams.audio[0].codec_context
            channels = original.channels
            sample_rate = sample_rate or (48000 if audio_format=="ogg" else original.sample_rate)
            layout = "mono" if channels == 1 else "stereo"
            stream = outgoing.add_stream(codec,rate=sample_rate)
            stream.layout = layout
            if audio_format == "mp3":
                stream.bit_rate = 128_000 if sample_rate >= 32000 else 64_000 if sample_rate >= 16000 else 32_000
            if audio_format == "ogg":
                stream.bit_rate = 96_000 if layout == "stereo" else 64_000
            effects = pitch != 0 or gain != 1
            resampler = av.AudioResampler(format="fltp" if effects else sample_format,layout=layout,rate=sample_rate)
            clock = Fraction(1,sample_rate)

            def write(frames):
                nonlocal written
                for frame in frames:
                    frame.pts, frame.time_base = written, clock
                    written += frame.samples
                    for packet in stream.encode(frame):
                        outgoing.mux(packet)

            def frames():
                for frame in incoming.decode(audio=0):
                    if cancelled():
                        raise Cancelled()
                    frame.pts = None
                    yield from resampler.resample(frame)
                yield from resampler.resample(None)

            samples = frames()
            write(audio_delivery_effects(samples,layout,sample_rate,sample_format,pitch,gain) if effects else samples)
            if not written:
                raise ValueError("无法读取音频样本")
            for packet in stream.encode(None):
                outgoing.mux(packet)
        if cancelled():
            raise Cancelled()
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def audio_clip_info(root, clip):
    from image_editor import number

    path = _ref_path(root, clip["ref"])
    seconds = audio_duration(path)
    start = number(clip.get("start"), 0, float("inf"), "时间线起点", 0)
    in_point = number(clip.get("in"), 0, seconds, "音频入点", 0)
    out_point = min(seconds, number(clip.get("out"), in_point, seconds + .1, "音频出点", seconds))
    if out_point - in_point < 1 / SR:
        raise ValueError("音频出点须晚于入点")
    volume = number(clip.get("volume"), 0, 1, "音频音量", 1)
    return path, start, in_point, out_point, volume


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


def cutaway_layout(entries):
    """Validate and order the intervals of a picture-only track."""
    if not isinstance(entries,list) or len(entries) > CUTAWAY_LIMIT:
        raise ValueError(f"时间线最多可添加 {CUTAWAY_LIMIT} 段补画面")
    items = []
    for index, clip in enumerate(entries,1):
        if not isinstance(clip,dict) or not isinstance(clip.get("ref"),str) or clip.get("kind") not in ("video","image"):
            raise ValueError(f"第 {index} 段补画面需要图片或视频素材")
        start, duration, offset = clip.get("start"), clip.get("duration"), clip.get("in",0)
        if (not all(type(t) in (int,float) and 0 <= t < math.inf for t in (start,duration,offset)) or
                duration < 1/FPS or not start+duration < math.inf or (clip["kind"]=="image" and offset!=0)):
            raise ValueError(f"第 {index} 段补画面的时间无效")
        items.append({"index":index,"ref":clip["ref"],"kind":clip["kind"],"start":start,
                      "end":start+duration,"duration":duration,"in":offset})
    items.sort(key=lambda item:item["start"])
    for left, right in zip(items,items[1:]):
        if left["end"] > right["start"] + 1e-6:
            raise ValueError(f"第 {left['index']} 段和第 {right['index']} 段补画面重叠，请调整时间")
    return items


def cutaway_items(root, entries, *, display=True):
    from image_editor import load

    items = cutaway_layout(entries)
    for item in items:
        try:
            path = _ref_path(root,item["ref"])
            if item["kind"] == "image":
                load(root,item["ref"])
            else:
                _, _, length, _ = probe(path,display=display)
                offset = item["in"]
                if not 0 <= offset < length or offset+item["duration"] > length+1/FPS:
                    raise ValueError()
            item["path"] = path
        except (OSError,ValueError,IndexError,OverflowError) as error:
            raise ValueError(f"第 {item['index']} 段补画面的素材无法读取或超出原片范围") from error
    return items


def cutaway_frames(root, items, fit, total, display):
    """Stream only the frames actually used by the cutaway track."""
    from image_editor import load

    for item in items:
        first, last = (math.ceil(min(item[k],total/FPS)*FPS - 1e-8) for k in ("start","end"))
        if first >= last:
            continue
        if item["kind"] == "image":
            image = load(root,item["ref"])
            background = Image.new("RGB",image.size)
            background.paste(image,mask=image.getchannel("A"))
            picture = fit(background)
            for index in range(first,last):
                yield index,picture
        else:
            offset = item["in"] + max(0,first/FPS-item["start"])
            with closing(clip_frames(item["path"],offset,offset+(last-first)/FPS,fit,last-first,display=display,seek=True)) as pictures:
                for index in range(first,last):
                    picture = next(pictures,None)
                    if picture is None:
                        raise ValueError(f"第 {item['index']} 段补画面没有可用的视频帧")
                    yield index,picture


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

def original_pcm(path: Path, length: int, *, offset=0, audio_only=False):
    """Keep the original soundtrack aligned to the video time origin."""
    import av
    import numpy as np
    pcm = np.zeros((2, length), np.float32)
    with av.open(str(path)) as source:
        if not source.streams.audio:
            return pcm
        stream = source.streams.audio[0] if audio_only or not source.streams.video else source.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base)
        resample = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
        cursor = -offset

        def write(samples):
            nonlocal cursor
            chunk = samples.to_ndarray()
            at = round((samples.time - origin) * SR) - offset if samples.time is not None else cursor
            cursor = at + chunk.shape[1]
            start, end = max(0, at), min(length, cursor)
            if start < end:
                pcm[:, start:end] = chunk[:, start - at:end - at]

        for frame in source.decode(audio=0):
            for samples in resample.resample(frame):
                write(samples)
            if cursor >= length:
                return pcm
        for samples in resample.resample(None):
            write(samples)
    return pcm


def cut_audio_ranges(root, ref, ranges, output_ref):
    """Write a new stereo WAV and describe how its pieces map to the source clock."""
    import numpy as np

    source = _ref_path(root, ref)
    duration = audio_duration(source)
    samples = [(round(a * SR), round(min(duration,b) * SR)) for a,b in ranges]
    if ranges[-1][1] > duration + .001 or any(a >= b for a,b in samples):
        raise ValueError("剪辑区间超出音频时长，或区间过短")
    origin, end = samples[0][0], samples[-1][1]
    target = _ref_path(root, output_ref)
    offset = 0
    mapping = []
    for a,b in samples:
        mapping.append({"start":a/SR,"end":b/SR,"at":offset/SR})
        offset += b - a
    if not target.is_file():
        pcm = original_pcm(source,end-origin,offset=origin,audio_only=True)
        target.parent.mkdir(parents=True,exist_ok=True)
        temporary = target.with_name(f".{target.stem}.{uuid.uuid4().hex}.tmp")
        try:
            with wave.open(str(temporary),"wb") as output:
                output.setparams((2,2,SR,0,"NONE",""))
                for i,(a,b) in enumerate(samples):
                    piece = pcm[:,a-origin:b-origin].copy()
                    fade = min(round(.005 * SR),piece.shape[1] // 2)
                    if fade and i > 0:
                        piece[:,:fade] *= np.linspace(0,1,fade,dtype=np.float32)
                    if fade and i + 1 < len(samples):
                        piece[:,-fade:] *= np.linspace(1,0,fade,dtype=np.float32)
                    output.writeframes(np.round(np.clip(piece.T,-1,1)*32767).astype("<i2").tobytes())
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return {"ref":output_ref,"seconds":offset/SR,"ranges":mapping}


def transcription_wav(root, clip, *, audio_only=False):
    """Encode only the selected region of the clip's source soundtrack."""
    import numpy as np

    if audio_only:
        path, _, start, end, _ = audio_clip_info(root, clip)
        source, offset = path, round(start * SR)
    else:
        path, _, _, duration, start, end = clip_info(root, clip)
        if not 0 <= start < end <= duration + 1 / FPS or end - start > 90:
            raise ValueError("请将识别区间设在视频时长内，且每次最多 90 秒")
        source, offset = clip_source_audio(root, clip, start, end, {}) or (path, round(start * SR))
    if end - start > 90:
        raise ValueError("每次最多识别 90 秒")
    pcm = original_pcm(source, max(1, round((end - start) * SR)), offset=offset, audio_only=audio_only)
    channel = pcm.mean(axis=0)
    if np.max(np.abs(channel)) < .00001:
        raise ValueError("这段素材没有可识别的原声")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, SR, 0, "NONE", ""))
        wav.writeframes(np.round(np.clip(channel, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue(), start, end


def clip_source_audio(root, clip, start, end, sources):
    ref = clip.get("audio_ref")
    if not ref:
        return None
    if ref not in sources:
        path = _ref_path(root, ref)
        sources[ref] = path, probe(path, display=False)[2]
    path, duration = sources[ref]
    offset = float(clip["audio_start"])
    if not math.isfinite(offset) or not 0 <= offset + start < offset + end <= duration + 1 / FPS:
        raise ValueError("原片音轨的剪辑点超出范围")
    return path, round((offset + start) * SR)


def clip_speed(clip):
    from image_editor import number
    speed = number(clip.get("speed"), .5, 2, "播放速度", 1)
    if speed != 1 and clip.get("kind") == "image":
        raise ValueError("图片片段请调整停留时长")
    return speed


def change_audio_tempo(samples, speed, length):
    """Match the retimed picture while preserving the pitch of the source."""
    import av
    import numpy as np

    output = np.zeros((2, length), np.float32)
    if not samples.any():
        return output
    # Give atempo enough trailing samples to emit even sub-second edits.
    padded = np.pad(samples, ((0, 0), (0, 4096)))
    frame = av.AudioFrame.from_ndarray(padded, format="fltp", layout="stereo")
    frame.sample_rate, frame.time_base, frame.pts = SR, Fraction(1, SR), 0
    graph = av.filter.Graph()
    source = graph.add_abuffer(sample_rate=SR, format="fltp", layout="stereo", time_base=frame.time_base)
    tempo = graph.add("atempo", str(speed))
    planar = graph.add("aformat", "sample_fmts=fltp")
    sink = graph.add("abuffersink")
    source.link_to(tempo)
    tempo.link_to(planar)
    planar.link_to(sink)
    graph.configure()
    graph.push(frame)
    graph.push(None)
    position = 0
    while position < length:
        try:
            chunk = graph.pull().to_ndarray()
        except av.error.EOFError:
            break
        count = min(chunk.shape[1], length - position)
        output[:, position:position + count] = chunk[:, :count]
        position += count
    return output


def render(comfy_dir: Path, spec: dict, progress=lambda done, total: None, cancelled=lambda: False,
           *, source_audio: Path | None = None, display=True, max_side=None) -> dict:
    import av
    import broll
    import numpy as np
    from itertools import chain, repeat
    from image_editor import load
    titles = title_items(spec.get("titles", []))
    cutaways = cutaway_items(comfy_dir,spec.get("cutaways",[]),display=display)
    clips = [c for c in spec.get("clips") or [] if c.get("ref")]
    if not clips:
        raise ValueError("时间线上没有图片或视频")
    info, audio_sources = [], {}
    for c in clips:
        p, w, h, dur, t0, t1 = clip_info(comfy_dir, c, display=display)
        speed = clip_speed(c)
        is_still = c.get("kind") == "image"
        if is_still and source_audio is not None:
            raise ValueError("重制原片时间线仅支持视频")
        t0 = max(0.0, t0)
        exact = c.get("frames") if source_audio is not None else None
        if speed != 1 and source_audio is not None:
            raise ValueError("原片时间轴导出无法变速")
        if speed != 1 or not is_still and c.get("tight") is True:
            if not 0 <= t0 < t1 <= dur + 1 / FPS:
                raise ValueError("逐帧剪辑点超出视频范围")
            exact = max(1, math.floor((t1-t0) / speed * FPS + .5)) if speed != 1 else max(1, round((t1-t0)*FPS))
        if exact is None:
            minimum = 1 / FPS if spec.get("remake_audio") and c.get("audio_start") is not None else .5
            t1 = min(max(t1, t0 + minimum), dur if dur > 0 else t1)
        audio_window = clip_source_audio(comfy_dir, c, t0, t1, audio_sources)
        info.append({"path": p, "still": c["ref"] if is_still else None, "t0": t0, "t1": t1, "n": exact if exact is not None else max(1, int(round((t1 - t0) * FPS))),
                     "trans": c.get("trans") or "cut", "vol": float(c.get("volume", 1.0)), "subs": c.get("subs") or [],
                     "audio_start": c.get("audio_start"), "audio_window": audio_window, "tight":c.get("tight") is True,
                     "captions": subtitle_captions(c["captions"]) if "captions" in c else None,
                     "speed": speed, "w": w, "h": h})
    remake_source = _ref_path(comfy_dir, spec["remake_audio"]) if source_audio is None and spec.get("remake_audio") else None
    reference = source_audio if source_audio is not None else remake_source
    w, h = probe(reference, display=display)[:2] if reference is not None else (info[0]["w"], info[0]["h"])
    W, H = target_size(w, h, spec.get("aspect") or "source")
    if max_side and max(W, H) > max_side:
        scale = max_side / max(W, H)
        W, H = (max(2, round(side * scale / 2) * 2) for side in (W, H))
    fit = _fitter(W, H, spec.get("fit") or "pad")
    graphics = None
    if spec.get("broll") is not None:
        if len(clips) != 1:
            raise ValueError("B-roll 需要单一来源片段")
        kind = "image" if info[0]["still"] else "video"
        length = (info[0]["t1"]-info[0]["t0"])/info[0]["speed"]
        raw = spec["broll"]
        if isinstance(raw, dict) and kind == "image":
            raw = {**raw,"duration":length}
        graphics = broll.recipe(raw,kind,length)
    composite_graphics = broll.frames(graphics,W,H,FPS,title_overlay,FONT)
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
        if c["still"]:
            continue
        output_samples = round(c["n"] / FPS * SR)
        speed = c["speed"]
        source_samples = round((c["t1"] - c["t0"]) * SR) if speed != 1 else output_samples
        if c["audio_window"] is not None:
            path, offset = c["audio_window"]
            a = original_pcm(path, source_samples, offset=offset)
        elif original is not None and c["audio_start"] is not None:
            start = round((float(c["audio_start"]) + c["t0"]) * SR)
            if not 0 <= start <= original.shape[1]:
                raise ValueError("原声入点超出原片范围")
            a = np.zeros((2, source_samples), dtype=np.float32)
            end = min(start + source_samples, original.shape[1])
            a[:, :end - start] = original[:, start:end]
        elif speed != 1:
            a = original_pcm(c["path"], source_samples, offset=round(c["t0"] * SR))
        else:
            a = read_audio(c["path"], c["t0"], c["t1"])
        if speed != 1:
            a = change_audio_tempo(a, speed, output_samples)
        a = a * c["vol"]
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
        if c["subs"] or c["captions"]:
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
    track_captions = []
    for clip in spec.get("audio_clips") or []:
        path, start, in_point, out_point, volume = audio_clip_info(comfy_dir, clip)
        if spec.get("subtitles", True) and "captions" in clip:
            for a, b, text in subtitle_captions(clip["captions"]):
                begin = start + max(a, in_point) - in_point
                end = min(total / FPS, start + min(b, out_point) - in_point)
                if begin < end and text:
                    track_captions.append((begin, end, text))
        if start >= pcm.shape[1] / SR or not volume:
            continue
        offset = round(start * SR)
        if offset >= pcm.shape[1]:
            continue
        end = min(out_point, in_point + (pcm.shape[1] - offset) / SR)
        samples = read_audio(path, in_point, end)[:, :pcm.shape[1] - offset]
        pcm[:, offset:offset + samples.shape[1]] += samples * volume
    peak = float(np.max(np.abs(pcm))) if pcm.size else 0
    if peak > 0.98:
        pcm *= 0.98 / peak
    if source_audio is not None:
        pcm = original_pcm(source_audio, int(round(total / FPS * SR)))

    # ---- subtitles on the timeline
    cues, audio_cues, title_cues = [], [], []
    if spec.get("subtitles", True):
        subtitle_size = float(spec.get("sub_size") or 1.0)
        for i, c in enumerate(info):
            s, e = starts[i] / FPS, (starts[i] + c["n"]) / FPS
            visible_start = s + (info[i - 1]["ov"] if i else 0) / FPS
            visible_end = e - c["ov"] / FPS
            for a, b, text in clip_caption_times(c, s, visible_start, visible_end):
                ov, y = subtitle_overlay(text, W, H, subtitle_size)
                if c["captions"] is not None:
                    first, last = (math.ceil(t * FPS - 1e-8) for t in (a, b))
                else:
                    first, last = int(a * FPS), int(b * FPS)
                cues.append((first, last, ov, 0, y))
        for a, b, text in track_captions:
            first, last = (math.ceil(t * FPS - 1e-8) for t in (a, b))
            if first < last:
                ov, y = subtitle_overlay(text, W, H, subtitle_size)
                audio_cues.append((first, last, ov, 0, y))
    for item in titles:
        first, last = (math.ceil(min(item[k],total/FPS)*FPS - 1e-8) for k in ("start","end"))
        if first < last:
            ov, x, y = title_overlay(item,W,H)
            title_cues.append((first,last,ov,x,y))

    def burn(arr, k):
        voice_cue = next((cue for cue in audio_cues if cue[0] <= k < cue[1]), None)
        for a, b, ov, x, y in chain((voice_cue,) if voice_cue else cues, title_cues):
            if a <= k < b:
                h = min(ov.shape[0], H - y)
                w = ov.shape[1]
                al = ov[:h, :, 3:4] / 255.0
                part = arr[y:y + h, x:x + w].astype(np.float32)
                arr = arr.copy()
                arr[y:y + h, x:x + w] = (part * (1 - al) + ov[:h, :, :3] * al).astype(np.uint8)
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
    replacements = cutaway_frames(comfy_dir,cutaways,_fitter(W,H,"crop"),total,display)
    replacement = None

    def emit(arr):
        nonlocal k, cover, replacement
        if replacement is not None and replacement[0] == k:
            arr = replacement[1]
            replacement = next(replacements,None)
        arr = burn(composite_graphics(arr,k), k)
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
        replacement = next(replacements,None)
        held: deque = deque()          # tail of the previous clip waiting to be blended into this one
        for i, c in enumerate(info):
            blend_in = list(held); held.clear()
            nb = int(TRANS / 2 * FPS)
            exact = c["tight"] or c["speed"] != 1
            frames = c["n"] if exact or source_audio is not None or original is not None and c["audio_start"] is not None else None
            if c["still"]:
                image = load(comfy_dir, c["still"])
                background = Image.new("RGB", image.size)
                background.paste(image, mask=image.getchannel("A"))
                picture = fit(background)
                pictures = broll.still_motion(picture,graphics,c["n"],FPS) if graphics and graphics["mode"] == "motion" else repeat(picture,c["n"])
            else:
                pictures = clip_frames(c["path"], c["t0"], c["t1"], fit, frames, display=display, seek=exact, speed=c["speed"])
            for j, arr in enumerate(pictures):
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
    finally:
        replacements.close()
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
