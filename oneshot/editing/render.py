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

from collections import deque
from fractions import Fraction
from pathlib import Path
import hashlib
import json
import math

from PIL import Image

from oneshot.editing.render_audio import (
    AUDIO_OUTPUT_RATES,
    audio_clip_info,
    audio_delivery_effects,
    audio_duration,
    encode_audio_delivery,
    read_audio,
)
from oneshot.editing.render_cutaways import (
    CUTAWAY_LIMIT,
    cutaway_frames,
    cutaway_items,
    cutaway_layout,
)
from oneshot.editing.render_gif import (
    GIF_FPS,
    GIF_SECONDS,
    GIF_SIZES,
    export_gif,
    export_grid_gif,
    write_gif,
)
from oneshot.editing.render_media import (
    Cancelled,
    DISPLAY_TRANSFORMS,
    SWAPS_AXES,
    _fitter,
    capture_frame,
    clip_frames,
    clip_info,
    clip_speed,
    cover_frame,
    display_transform,
    encode_silent,
    frame_image,
    probe,
    target_size,
    video_ticks,
)
from oneshot.editing.render_overlays import (
    CAPTION_LIMIT,
    FONT,
    TITLE_LIMIT,
    TITLE_POSITIONS,
    TITLE_STYLES,
    _wrap,
    clip_caption_times,
    cue_times,
    subtitle_captions,
    subtitle_overlay,
    title_items,
    title_overlay,
)
from oneshot.editing.render_timeline_audio import (
    change_audio_tempo,
    clip_source_audio,
    cut_audio_ranges,
    original_pcm,
    recording_preview_wav,
    transcription_wav,
)
from oneshot.generation.media_files import FPS
from oneshot.generation.media_files import SR
from oneshot.generation.media_files import _new
from oneshot.generation.media_files import ref_path as _ref_path


TRANS = 0.5                 # transition length


def playlist_revision(spec):
    return hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def render(comfy_dir: Path, spec: dict, progress=lambda done, total: None, cancelled=lambda: False,
           *, source_audio: Path | None = None, display=True, max_side=None) -> dict:
    import av
    from oneshot.editing import broll
    import numpy as np
    from itertools import chain, repeat
    from oneshot.editing.image_editor import load
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
