"""Prepare source audio for timeline edits and transcription."""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path
import io
import math
import uuid
import wave

from oneshot.editing.render_audio import audio_clip_info, audio_duration
from oneshot.editing.render_media import clip_info, probe
from oneshot.generation.media_files import FPS
from oneshot.generation.media_files import SR
from oneshot.generation.media_files import ref_path as _ref_path


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


def recording_preview_wav(audio):
    """Convert the available audio in an unfinished browser recording to a complete WAV."""
    import av

    rate = 16000
    remaining = 60 * rate * 2
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", ""))
        try:
            with av.open(io.BytesIO(audio), options={"protocol_whitelist":"pipe"}) as recording:
                if not recording.streams.audio:
                    raise ValueError("录音片段没有音轨")
                resample = av.AudioResampler(format="s16", layout="mono", rate=rate)
                for frame in recording.decode(audio=0):
                    for converted in resample.resample(frame):
                        pcm = converted.to_ndarray().tobytes()[:remaining]
                        wav.writeframesraw(pcm)
                        remaining -= len(pcm)
                    if not remaining:
                        break
        except av.FFmpegError:
            pass  # The last container block may still be in progress.
    if remaining == 60 * rate * 2:
        raise ValueError("录音片段尚不可读取")
    return output.getvalue()


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
