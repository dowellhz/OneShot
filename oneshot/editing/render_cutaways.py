"""Validate and schedule the picture inserts on a timeline."""
from __future__ import annotations

from contextlib import closing
import math

from PIL import Image

from oneshot.editing.render_media import clip_frames, probe
from oneshot.generation.media_files import FPS
from oneshot.generation.media_files import ref_path as _ref_path


CUTAWAY_LIMIT = 24


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
    from oneshot.editing.image_editor import load

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
    from oneshot.editing.image_editor import load

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
