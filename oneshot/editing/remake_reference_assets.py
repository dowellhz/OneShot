"""Resolve approved asset views for remake roles."""
from __future__ import annotations

from pathlib import Path

from oneshot.memory.creative_memory import IMAGE_EXT
from oneshot.memory.creative_memory import fail


VIEWS = {"main", "face", "side", "back", "detail"}


def role_reference(req, board, data):
    asset_id = data.get("asset")
    view = data.get("view", "main")
    if not isinstance(asset_id, str) or not isinstance(view, str) or view not in VIEWS:
        fail("请选择一个角色资产和参考角度")
    asset = req.app["creative_memory"].get(req["user"], asset_id, board)
    if asset["kind"] != "character":
        fail("请选择角色资产")
    ref = asset.get("character_views", {}).get(view) or (asset["ref"] if view == "main" else "")
    if data.get("reference") is not None and data["reference"] != ref:
        fail("资产库角色参考图已更新，请重新打开视频重制后再生成", 409)
    if not ref or Path(ref).suffix.lower() not in IMAGE_EXT:
        fail("该角色没有可用的参考图")
    return asset, view, ref
