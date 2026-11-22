"""Media and snapshot preparation for the public showcase."""

import hashlib
import json
import re
from io import BytesIO
from pathlib import Path

from aiohttp import BodyPartReader, web
from PIL import Image, ImageOps

import public_canvas
from render import capture_frame

VIDEO_LIMIT = 300_000_000
COVER_LIMIT = 20_000_000
UPLOAD_VIDEO_EXT = {".mp4", ".mov", ".webm"}
UPLOAD_VIDEO = re.compile(r"showcase:([a-f0-9]{64}\.(?:mp4|mov|webm))")


def upload_path(root, ref):
    match = UPLOAD_VIDEO.fullmatch(ref)
    return root / "showcase" / match[1] if match else None


def video_path(root, ref):
    private = upload_path(root,ref)
    return (private if private.is_file() else None) if private else public_canvas.media_path(root,ref,"video")


async def stream(part, output, limit, digest=None):
    size = 0
    while chunk := await part.read_chunk(size=64*1024):
        size += len(chunk)
        if size > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit,actual_size=size)
        output.write(chunk)
        if digest is not None:
            digest.update(chunk)
    if not size:
        raise ValueError("所选文件为空")


async def read_upload(req, folder, board_id):
    reader = await req.multipart()
    first = await reader.next()
    if not isinstance(first,BodyPartReader) or first.name != "metadata" or first.filename is not None:
        raise ValueError("请先提交作品信息")
    buffer = BytesIO()
    await stream(first,buffer,16_384)
    payload = json.loads(buffer.getvalue())
    files = {}
    async for part in reader:
        if not isinstance(part,BodyPartReader) or part.name not in {"video","cover"} or not part.filename or part.name in files:
            raise ValueError("请为成片和封面各选择一个文件")
        kind = part.name
        suffix = Path(part.filename).suffix.lower()
        extensions = UPLOAD_VIDEO_EXT if kind == "video" else public_canvas.IMAGE_EXT
        if suffix not in extensions:
            raise ValueError("请选择 MP4、MOV、WEBM 视频，或 PNG、JPG、WEBP 封面")
        file = folder / (kind + suffix)
        digest = hashlib.sha256(board_id.encode()+b"\0") if kind == "video" else None
        with file.open("wb") as output:
            await stream(part,output,VIDEO_LIMIT if kind == "video" else COVER_LIMIT,digest)
        files[kind] = (file,"showcase:"+digest.hexdigest()+suffix if digest is not None else None)
    return payload, files

def find_version(board, kind, node_id, ref):
    for node in board.get("nodes", []):
        if node.get("type") == kind and node.get("id") == node_id:
            for index, version in enumerate(node.get("versions", [])):
                if version.get("ref") == ref:
                    return index
    raise ValueError("找不到所选素材版本，请重新选择")


def capture(board, root, node_id, index):
    nodes = [{**node, "cur":index} if node["id"] == node_id else node for node in board["nodes"]]
    return public_canvas.capture({**board, "nodes":nodes}, root)


def cover_jpeg(video_path, image_path, *, check_video=False):
    if check_video or not image_path:
        still, _ = capture_frame(video_path, "first")
    if image_path:
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source)
    else:
        image = still
    image.thumbnail((960, 960), Image.Resampling.LANCZOS)
    encoded = BytesIO()
    image.convert("RGB").save(encoded, "JPEG", quality=85, optimize=True)
    return encoded.getvalue()
