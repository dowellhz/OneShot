"""Concatenate clips with aligned audio and video."""
from fractions import Fraction
from pathlib import Path

from oneshot.generation.media_files import FPS, SR, _new, ref_path


def concat(comfy_dir: Path, refs: list) -> dict:
    import av
    import numpy as np
    from PIL import Image
    if len(refs) < 2:
        raise ValueError("至少选两段视频")
    srcs = [ref_path(comfy_dir, r) for r in refs]
    with av.open(str(srcs[0])) as c0:
        W, H = c0.streams.video[0].codec_context.width, c0.streams.video[0].codec_context.height
    W, H = W - W % 2, H - H % 2
    path, ref = _new(comfy_dir, "output", "cut", ".mp4")
    out = av.open(str(path), "w")
    vo = out.add_stream("libx264", rate=FPS)
    vo.width, vo.height, vo.pix_fmt = W, H, "yuv420p"
    vo.options = {"crf": "18", "preset": "medium"}
    ao = out.add_stream("aac", rate=SR)
    ao.layout = "stereo"
    vpts = 0
    audio = []

    def fit(frame):
        if frame.width == W and frame.height == H:
            return frame.reformat(format="yuv420p")
        img = frame.to_image()
        s = min(W / img.width, H / img.height)
        img = img.resize((max(2, round(img.width * s)), max(2, round(img.height * s))))
        bg = Image.new("RGB", (W, H))
        bg.paste(img, ((W - img.width) // 2, (H - img.height) // 2))
        return av.VideoFrame.from_image(bg).reformat(format="yuv420p")

    for src in srcs:
        n0 = vpts
        with av.open(str(src)) as c:
            t_next, last = 0.0, None
            for f in c.decode(video=0):      # resample to 24 fps by time: each output tick shows the frame on screen then
                t = float(f.time or 0)
                while t_next <= t + 1e-6:
                    g = fit(f if last is None or t_next >= t - 0.5 / FPS else last)
                    g.pts = vpts; g.time_base = Fraction(1, FPS); vpts += 1
                    for pkt in vo.encode(g):
                        out.mux(pkt)
                    t_next += 1 / FPS
                last = f
        nframes = vpts - n0
        want = round(nframes / FPS * SR)
        pcm = np.zeros((2, 0), dtype=np.float32)
        with av.open(str(src)) as c:
            if c.streams.audio:
                rs = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
                parts = []
                for f in c.decode(audio=0):
                    for g in rs.resample(f):
                        parts.append(g.to_ndarray())
                for g in rs.resample(None):
                    parts.append(g.to_ndarray())
                if parts:
                    pcm = np.concatenate(parts, axis=1).astype(np.float32)
        if pcm.shape[1] < want:
            pcm = np.concatenate([pcm, np.zeros((2, want - pcm.shape[1]), dtype=np.float32)], axis=1)
        audio.append(pcm[:, :want])
    for pkt in vo.encode():
        out.mux(pkt)
    pcm = np.concatenate(audio, axis=1)
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
    return {"ref": ref, "w": W, "h": H, "seconds": round(vpts / FPS, 2)}
