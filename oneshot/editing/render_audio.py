"""Read source audio and encode audio delivery files."""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path

from oneshot.editing.render_media import Cancelled
from oneshot.generation.media_files import SR
from oneshot.generation.media_files import ref_path as _ref_path


AUDIO_OUTPUT_RATES = {"wav":[8000,16000,24000,32000,44100,48000],
                      "mp3":[8000,16000,24000,32000,44100,48000],"ogg":[48000]}


def read_audio(path: Path, t0: float = 0.0, t1: float | None = None):
    """Decode an audio track (of a video or an audio file) to float32 stereo at SR; zeros if there is none."""
    import av
    import numpy as np
    parts = []
    start = max(0,int(round(t0 * SR)))
    end = None if t1 is None else int(round(t1 * SR))
    decoded = 0

    def retain(frame):
        nonlocal decoded
        left = max(0,start-decoded)
        right = frame.samples if end is None else min(frame.samples,end-decoded)
        if left < right:
            parts.append(frame.to_ndarray()[:,left:right])
        decoded += frame.samples

    with av.open(str(path)) as c:
        if c.streams.audio:
            rs = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
            for f in c.decode(audio=0):
                for g in rs.resample(f):
                    retain(g)
                if end is not None and decoded >= end:
                    break
            else:
                for g in rs.resample(None):
                    retain(g)
    pcm = np.concatenate(parts, axis=1).astype(np.float32) if parts else np.zeros((2, 0), np.float32)
    if end is not None and pcm.shape[1] < end - start:
        pcm = np.concatenate([pcm,np.zeros((2,end-start-pcm.shape[1]),np.float32)],axis=1)
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
    from oneshot.editing.image_editor import number

    path = _ref_path(root, clip["ref"])
    seconds = audio_duration(path)
    start = number(clip.get("start"), 0, float("inf"), "时间线起点", 0)
    in_point = number(clip.get("in"), 0, seconds, "音频入点", 0)
    out_point = min(seconds, number(clip.get("out"), in_point, seconds + .1, "音频出点", seconds))
    if out_point - in_point < 1 / SR:
        raise ValueError("音频出点须晚于入点")
    volume = number(clip.get("volume"), 0, 1, "音频音量", 1)
    return path, start, in_point, out_point, volume
