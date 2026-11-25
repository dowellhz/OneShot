"""Encode a short deterministic video for pinned-version tests."""

from PIL import Image

import server


def make_video(blue=80):
    import av
    path, ref = server.tools._new(server.COMFY_DIR, "output", "test-video", ".mp4")
    with av.open(str(path), "w") as out:
        stream = out.add_stream("libx264", rate=6)
        stream.width = stream.height = 64
        stream.pix_fmt = "yuv420p"
        for i in range(12):
            frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), (20 * i, 60, blue)))
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return {"ref": ref, "url": "/media?ref=" + ref, "w": 64, "h": 64, "seconds": 2}
