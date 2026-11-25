"""Export a video interval or ordered image grid as a GIF."""
from __future__ import annotations

from contextlib import closing
import math

from PIL import Image

from oneshot.editing.render_media import (
    frame_image,
    probe,
    video_ticks,
)
from oneshot.generation.media_files import FPS
from oneshot.generation.media_files import _new


GIF_FPS = (8, 12, 15)
GIF_SIZES = (256, 360, 480)
GIF_SECONDS = 8


def export_gif(root, source, *, start=0, end=None, fps=12, size=360, ping_pong=False):
    width, height, duration, _ = probe(source)
    if width <= 0 or height <= 0 or not math.isfinite(duration):
        raise ValueError("无法读取视频的画面尺寸或时长")
    end = min(duration, start + 3) if end is None else end
    if not 0 <= start < end <= duration + .005 or not .25 <= end - start <= GIF_SECONDS:
        raise ValueError("请选择原片内 0.25–8 秒的视频区间")
    end = min(end, duration)
    scale = min(1, size / max(width, height))
    dimensions = (max(1, round(width * scale)), max(1, round(height * scale)))
    count = max(2, round((end - start) * fps))
    with closing(video_ticks(source, start, count, relative_time=True, seek=True, speed=FPS / fps)) as ticks:
        frames = [frame_image(frame, thumbnail_size=dimensions).quantize(colors=128) for frame in ticks]
    if not frames:
        raise ValueError("找不到可导出的画面")
    return {**write_gif(root, frames, fps, ping_pong), "start":start, "end":end}


def export_grid_gif(root, ref, *, rows, cols, first, last, fps, size, ping_pong):
    from oneshot.editing.image_editor import load
    from oneshot.generation.tools import grid_boxes

    source = load(root,ref)
    boxes = grid_boxes(*source.size,rows,cols)[first-1:last]
    width = min(right-left for left,_,right,_ in boxes)
    height = min(bottom-top for _,top,_,bottom in boxes)
    if min(width,height)<1:
        raise ValueError("图片太小，无法按此行列拆分")
    ratio = min(1, size / max(width,height))
    dimensions = (max(1,round(width*ratio)), max(1,round(height*ratio)))
    frames = []
    transparent = False
    for box in boxes:
        frame = source.crop(box).resize(dimensions,Image.Resampling.LANCZOS)
        palette = frame.convert("RGB").quantize(colors=127)
        alpha = frame.getchannel("A")
        if alpha.getextrema()[0] < 128:
            transparent = True
            palette.putpalette((palette.getpalette()[:381] + [0] * 768)[:768])
            palette.paste(255,mask=alpha.point(lambda value: 255 if value < 128 else 0))
        frames.append(palette)
    options = {"transparency":255,"optimize":False,"background":255} if transparent else {}
    return {**write_gif(root,frames,fps,ping_pong,**options),"first":first,"last":last}


def write_gif(root, frames, fps, ping_pong, **options):
    if ping_pong:
        frames.extend(frames[-2:0:-1])
    delays = [(round((i + 1) * 100 / fps) - round(i * 100 / fps)) * 10 for i in range(len(frames))]
    dst, ref = _new(root, "output", "gif", ".gif")
    temporary = dst.with_suffix(".part")
    try:
        frames[0].save(temporary, format="GIF", save_all=True, append_images=frames[1:], duration=delays,
                       loop=0, disposal=2, **options)
        temporary.replace(dst)
    finally:
        temporary.unlink(missing_ok=True)
    return {"ref":ref, "width":frames[0].width, "height":frames[0].height, "seconds":sum(delays) / 1000,
            "size_bytes":dst.stat().st_size}
