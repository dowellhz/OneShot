"""Prepare and briefly serve a motion guide to the selected video provider."""
from contextlib import closing, contextmanager
from ipaddress import ip_address
from itertools import islice
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit

from aiohttp import web
from aiohttp.web_log import AccessLogger

from oneshot.editing import render

LEASE_PREFIX = "/api/motion-guide/"
LEASE_PATH = re.compile(LEASE_PREFIX + r"[a-f0-9]{64}")
LEASE_SECONDS = 35 * 60
MIN_SECONDS = 2
_leases = {}
H3_CLOUD_MODELS = {"MiniMax-H3","MiniMax-H3-Highspeed","MiniMax-H3-Lite","MiniMax-H3-Max",
                   "MiniMax-H3-Max-Turbo","MiniMax-H3-MG","MiniMax-H3-NC"}
ARK_ENDPOINT_ID = re.compile(r"ep-[a-zA-Z0-9-]{1,100}")
ARK_VIDEO_MODELS = {
    "seedance-2.0": "doubao-seedance-2-0",
    "seedance-2.0-fast": "doubao-seedance-2-0-fast",
    "seedance-2.0-mini": "doubao-seedance-2-0-mini",
    "seedance-2.5": "doubao-seedance-2-5",
    "seedance-2.5-flash": "doubao-seedance-2-5-flash",
}


def video_model_for_limits(provider, model):
    if provider and provider.get("kind") == "ark" and isinstance(model,str) and ARK_ENDPOINT_ID.fullmatch(model):
        profile = (provider.get("config") or {}).get("video_endpoint_models",{}).get(model)
        return ARK_VIDEO_MODELS.get(profile,model)
    return model


def ark_multimodal_model(model):
    return isinstance(model,str) and bool(ARK_ENDPOINT_ID.fullmatch(model) or
        re.fullmatch(r"doubao-seedance-2-[05](?:-[a-z0-9]+)*",model))


def image_reference_limit(provider, model):
    if provider["kind"] == "ark" and ark_multimodal_model(model):
        return image_limit(video_model_for_limits(provider,model))
    if provider["kind"] == "minimax" and model in H3_CLOUD_MODELS:
        return image_limit(model)
    return None


def ordered_video_references(guide, clips, *, source_first=False):
    clips = list(clips)
    if not guide:
        return clips
    if source_first and clips:
        return [clips[0],guide,*clips[1:]]
    return [guide,*clips]


class PublicAccessLogger(AccessLogger):
    def log(self, request, response, time):
        if not LEASE_PATH.fullmatch(request.path):
            super().log(request, response, time)


def public_origin(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    message = "参考视频公网地址必须是 OneShot 的 HTTPS 站点根地址"
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError(message) from None
    if (parsed.scheme != "https" or not host or parsed.path not in ("", "/")
            or re.search(r"\s|[?#\\%]", value) or parsed.username is not None or port == 0):
        raise ValueError(message)
    try:
        public = ip_address(host).is_global
    except ValueError:
        public = bool(re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host)) and not host.endswith((".local", ".localhost", ".internal"))
    if not public:
        raise ValueError(message)
    authority = f"[{host}]" if ":" in host else host
    return "https://" + authority + (f":{port}" if port not in (None, 443) else "")


def supports_audio(provider, model):
    if provider.get("kind") == "minimax":
        return bool(provider.get("enabled") and provider.get("secrets", {}).get("api_key") and
                    isinstance(model,str) and model in H3_CLOUD_MODELS and has_public_origin(provider))
    return bool(provider.get("kind") == "ark" and provider.get("enabled")
                and provider.get("secrets", {}).get("api_key") and ark_multimodal_model(model))


def supports(provider, model):
    return supports_audio(provider, model) and has_public_origin(provider)


def has_public_origin(provider):
    try:
        return bool(public_origin((provider.get("config") or {}).get("motion_origin")))
    except ValueError:
        return False


def av_limits(model):
    if "seedance-2-5" in model:
        return (5 if "flash" in model else 10), 30
    return 3, 15


def image_limit(model):
    if "seedance-2-5" in model:
        return 10 if "flash" in model else 30
    return 9


def video_dimensions(ratio):
    return (2 * round(360 * ratio), 720) if ratio >= 1 else (720, 2 * round(360 / ratio))


def prepare_clip(source, destination, start, ticks, ratio, cancelled):
    width, height = video_dimensions(ratio)
    with closing(render.video_ticks(source, start, ticks, relative_time=True, seek=True)) as raw:
        frames = (render.frame_image(frame, thumbnail_size=(width, height)) for frame in raw)
        count = render.encode_silent(destination, frames, width, height, render.FPS, cancelled, lambda _: None)
    if count != ticks:
        raise ValueError("参考视频片段无法完整读取")


def eligible(w, h, ticks):
    return w > 0 and h > 0 and .4 <= w / h <= 2.5 and ticks >= MIN_SECONDS * render.FPS


def prepare(source, destination, ticks, cancelled):
    import av

    w, h, _, _ = render.probe(source, display=False)
    if not eligible(w, h, ticks):
        raise ValueError("动作参考需要至少 2 秒，且宽高比在 0.4 到 2.5 之间")
    width, height = video_dimensions(w / h)
    with av.open(str(source)) as video:
        frames = (frame.reformat(width=width, height=height, format="rgb24").to_image()
                  for frame in islice(video.decode(video=0), ticks + 1))
        count = render.encode_silent(destination, frames, width, height, render.FPS, cancelled, lambda _: None)
    if count != ticks:
        raise ValueError("动作参考长度已变更，请重新生成")


@contextmanager
def publish(origin, path, alive):
    token = secrets.token_hex(32)
    _leases[token] = (Path(path), time.monotonic() + LEASE_SECONDS, alive)
    try:
        yield origin + LEASE_PREFIX + token
    finally:
        _leases.pop(token, None)


async def serve(req):
    lease = _leases.get(req.match_info["token"])
    if not lease:
        raise web.HTTPNotFound()
    path, expiry, alive = lease
    if time.monotonic() >= expiry or not alive() or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Content-Type":"audio/wav" if path.suffix==".wav" else "video/mp4", "Cache-Control":"private, no-store",
                                           "X-Content-Type-Options":"nosniff"})
