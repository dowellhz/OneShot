"""Storage and validation for OneShot's JSON boards."""
from __future__ import annotations

import json
import math
import re
import uuid
from pathlib import Path

from aiohttp import web

import tools


BOARD_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")


def board_path(directory: Path, bid: str) -> Path:
    if not isinstance(bid, str) or not BOARD_ID.fullmatch(bid):
        raise web.HTTPBadRequest(text="bad board id")
    return directory / f"{bid}.json"


def board_meta(f: Path) -> dict:
    try:
        b = json.loads(f.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}
    return b if isinstance(b, dict) else {}


_URL_KEYS = {"url", "cover_url"}
_NUM_KEYS = {"seed", "w", "h", "seconds", "duration", "x", "y", "k", "cur", "count", "start", "volume", "in", "out", "sub_size", "speed", "seq"}


def clean_board(v, media_root: Path):
    """Board JSON comes from browsers (any teammate, for shared boards): links may only point at this site's media,
    ids must be plain, numbers must be numbers — so nothing in a board can inject markup into someone else's page."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if not isinstance(k, str) or len(k) > 64:
                continue
            if k in _URL_KEYS:
                if x is None or (isinstance(x, str) and x.startswith(("/media?ref=", "/static/")) and not re.search(r"[\s\"'<>`\\]", x)):
                    out[k] = x
                continue
            if k in _NUM_KEYS and x is not None and not isinstance(x, (int, float, dict, list)):
                try:
                    x = float(x)
                except (TypeError, ValueError):
                    continue
            if k in ("id", "from", "to", "img", "vid", "node", "script") and x is not None and not (isinstance(x, str) and BOARD_ID.fullmatch(x)):
                if k in ("id", "from", "to"):
                    raise web.HTTPBadRequest(text=json.dumps({"error": "项目数据格式不对（节点编号）"}, ensure_ascii=False), content_type="application/json")
                continue
            if k in ("ref", "cover") and isinstance(x, str) and x:          # media refs (cover: a ref or seconds)
                try:
                    tools.ref_path(media_root, x)
                except ValueError:
                    continue
            out[k] = clean_board(x, media_root)
        return out
    if isinstance(v, list):
        return [clean_board(x, media_root) for x in v[:5000]]
    if isinstance(v, str):
        return v[:20000]
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def can_see(u: dict, b: dict) -> bool:
    return u["role"] == "admin" or b.get("owner") in (None, u["id"]) or bool(b.get("shared"))


def write_board(path: Path, data: dict):
    """Atomically replace a board so readers see a complete revision."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
