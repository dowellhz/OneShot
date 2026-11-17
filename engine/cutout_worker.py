"""Isolated CPU background-removal process; keeps its NumPy/ONNX dependencies out of H3."""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("U2NET_HOME", str(Path(__file__).resolve().parents[1] / "models/rembg"))
from PIL import Image, ImageChops, ImageOps
from rembg import new_session, remove

source = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGBA")
session = new_session("u2netp", providers=["CPUExecutionProvider"])
result = remove(source.convert("RGB"), session=session)
result.putalpha(ImageChops.multiply(result.getchannel("A"), source.getchannel("A")))
result.save(sys.argv[2])
print(json.dumps({"width": source.width, "height": source.height}))
