"""Decode and encode bounded image and video previews for MCP responses."""
import base64
import io
from dataclasses import dataclass

from PIL import Image

from oneshot.assistant import agent_chat as chat
from oneshot.canvas import public_canvas
from oneshot.editing import image_editor
from oneshot.editing import render


@dataclass
class Preview:
    summary: dict
    images: list


def build_preview(root, ref, kind, times, max_side):
    try:
        if kind=="image":
            if times:
                raise chat.ToolError("取帧时间仅适用于视频")
            original = image_editor.load(root,ref)
            pictures = [(original,None)]
            details = {"width":original.width,"height":original.height}
        else:
            path = public_canvas.media_path(root,ref,"video")
            if path is None:
                raise chat.ToolError("找不到可预览的视频")
            width,height,duration,_ = render.probe(path,display=False)
            image_editor.check_size(width,height)
            if any(at>=duration for at in times):
                raise chat.ToolError("取帧时间必须早于视频结束（%.2f 秒）"%duration)
            pictures = [render.capture_frame(path,"time",at) for at in times] if times else [render.capture_frame(path,"first")]
            details = {"duration":duration}
    except (ValueError,OSError,IndexError,Image.DecompressionBombError) as exc:
        raise chat.ToolError("无法解码所选媒体，请检查素材是否仍然可用") from exc
    frames, images = [], []
    for image,at in pictures:
        image.thumbnail((max_side,max_side),Image.Resampling.LANCZOS)
        if "A" in image.getbands():
            matte = Image.new("RGB",image.size,(28,28,32))
            matte.paste(image,mask=image.getchannel("A"))
            image = matte
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer,"JPEG",quality=84)
        images.append({"type":"image","mimeType":"image/jpeg","data":base64.b64encode(buffer.getvalue()).decode("ascii")})
        frames.append({"width":image.width,"height":image.height,**({"time":at} if at is not None else {})})
    return Preview({"media_type":kind,**details,"frames":frames},images)
