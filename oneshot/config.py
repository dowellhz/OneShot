"""Paths shared by the web application and its feature modules."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
STATIC_DIR = ROOT / "static"

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
PORT = int(os.environ.get("H3STUDIO_PORT", "8190"))
IMAGE_UPSCALE_MODELS = Path(os.environ.get("IMAGE_UPSCALE_MODELS", MODELS_DIR / "upscale"))
COMFY_DIR = Path(os.environ.get("COMFY_DIR", str(Path.home() / "ComfyUI")))
ENGINE = os.environ.get("H3_ENGINE_URL", "http://127.0.0.1:8189")
