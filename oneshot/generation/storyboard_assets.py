"""Normalize reusable scene and prop descriptions returned by the storyboard planner."""

import re

INSTRUCTIONS = """
添加 visual_assets 数组，只列多镜重复出现、需要保持外形一致的场景和关键道具，最多八项。
每项包含 key（小写英文短标识）、kind（scene 或 prop）、name（中文短名称）、look（可画出的固定布局、外形、材质和颜色）。
场景写没有演员的环境和空间布局。道具写独立物体。角色继续写入 characters。
每镜填写 visual_asset_keys，只引用该镜实际可见的场景和道具，不要为无关背景或一次性物体建素材。
"""

_KEY = re.compile(r"[a-z][a-z0-9_-]{0,39}\Z")


def bind_visual_assets(raw, shots):
    assets = {}
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        key, kind, name, look = (item.get(field) for field in ("key", "kind", "name", "look"))
        if not all(isinstance(value, str) and value.strip() for value in (key, kind, name, look)):
            continue
        if not _KEY.fullmatch(key) or kind not in ("scene", "prop") or key in assets:
            continue
        assets[key] = {"key":key,"kind":kind,"name":name.strip()[:80],"look":look.strip()[:600]}
        if len(assets) == 8:
            break
    used = set()
    for shot in shots:
        keys = list(dict.fromkeys(k for k in shot.pop("visual_asset_keys",[]) if isinstance(k,str) and k in assets))
        if keys:
            shot["visual_asset_keys"] = keys[:4]
            used.update(shot["visual_asset_keys"])
    return [asset for key, asset in assets.items() if key in used]
