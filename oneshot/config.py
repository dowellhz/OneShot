"""Paths shared by the web application and its feature modules."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
STATIC_DIR = ROOT / "static"
