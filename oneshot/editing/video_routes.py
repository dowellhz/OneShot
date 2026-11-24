"""Video frame, trim, GIF, and remake endpoints."""

import asyncio
import io
import math
from urllib.parse import quote

from aiohttp import web
from PIL.Image import DecompressionBombError

from oneshot import config
from oneshot.editing import render as film
from oneshot.editing import timeline_routes
from oneshot.editing import video_remake
from oneshot.generation import tools
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


async def lastframe(req):
    data = await req.json()
    if not isinstance(data, dict) or not isinstance(data.get("ref"), str):
        raise http_errors.bad("请选择要截帧的视频")
    ref, at = data["ref"], data.get("at")
    position = data.get("position", "last" if at is None else "time")
    if position not in ("first", "last", "time") or (position == "time") != (at is not None):
        raise http_errors.bad("请选择首帧、末帧，或指定截帧时间")
    if at is not None and (type(at) not in (int, float) or not math.isfinite(at) or at < 0):
        raise http_errors.bad("截帧时间无效")
    try:
        src = tools.ref_path(config.COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest()
    def grab():
        img, time = film.capture_frame(src, position, at)
        dst, new_ref = tools._new(config.COMFY_DIR, "input", "last" if position == "last" else "frame", ".png")
        img.save(dst)
        return new_ref, img.size, time

    try:
        new_ref, size, time = await asyncio.to_thread(grab)
    except (OSError, ValueError, IndexError) as e:
        raise http_errors.bad(str(e)) from None
    media_routes.grant_media(req["user"], new_ref)
    return web.json_response({"ref": new_ref, "url": "/media?ref=" + quote(new_ref, safe=""), "w": size[0], "h": size[1],
                              "at":time, "position":position})


async def video_frame_preview(req):
    ref, position = req.query.get("ref",""), req.query.get("position")
    raw_at = req.query.get("at")
    if position not in ("first","last","time") or (position=="time")!=(raw_at is not None):
        raise http_errors.bad("请选择首帧、末帧，或指定截帧时间")
    try:
        at = float(raw_at) if raw_at is not None else None
    except ValueError:
        raise http_errors.bad("截帧时间无效") from None
    if at is not None and (not math.isfinite(at) or at<0):
        raise http_errors.bad("截帧时间无效")
    try:
        source = tools.ref_path(config.COMFY_DIR,ref)
    except ValueError:
        raise web.HTTPNotFound() from None
    if source.suffix.lower() not in tools.VIDEO_EXT or not source.is_file() or not media_routes.can_read_media(req["user"],ref):
        raise web.HTTPNotFound()

    def preview():
        image, _ = film.capture_frame(source,position,at)
        image.thumbnail((960,960))
        buffer = io.BytesIO()
        image.save(buffer,format="PNG")
        return buffer.getvalue()

    try:
        body = await asyncio.to_thread(preview)
    except (OSError, ValueError, IndexError) as error:
        raise http_errors.bad(str(error)) from None
    return web.Response(body=body,content_type="image/png",headers={"Cache-Control":"private, no-store"})


async def trim_video(req):
    data = await req.json()
    if not isinstance(data, dict) or data.get("action") not in ("detect", "render"):
        raise http_errors.bad("视频裁剪请求无效")
    points = data.get("points")
    if not isinstance(points, list) or not 2 <= len(points) <= 13 or any(type(point) is not int for point in points):
        raise http_errors.bad("请选择有效的入点和出点，最多可切成 12 段")
    if any(a >= b for a, b in zip(points, points[1:])) or points[0] < 0:
        raise http_errors.bad("剪辑点必须按时间顺序排列")

    def work():
        ref = data["ref"]
        path = tools.ref_path(config.COMFY_DIR, ref)
        duration = film.probe(path, display=False)[2]
        if points[-1] > round(duration * film.FPS):
            raise ValueError("剪辑点超出原视频范围")
        if data["action"] == "detect":
            return {"cuts":tools.video_split_points(path, points[0], points[-1], film.FPS, 12)}
        results = []
        try:
            for start, end in zip(points, points[1:]):
                clip = {"ref":ref, "in":start / film.FPS, "out":end / film.FPS, "tight":True,
                        "audio_ref":ref, "audio_start":0}
                result = film.render(config.COMFY_DIR, {"clips":[clip], "subtitles":False})
                result.update(start=start / film.FPS, end=end / film.FPS)
                results.append(result)
        except Exception:
            for result in results:
                tools.ref_path(config.COMFY_DIR, result["ref"]).unlink(missing_ok=True)
            raise
        return {"clips":results}

    try:
        async with timeline_routes.RENDER_LOCK:
            result = await asyncio.to_thread(work)
    except (KeyError, TypeError, ValueError, OSError, IndexError) as error:
        raise http_errors.bad(f"无法处理视频：{error}") from None
    for clip in result.get("clips", []):
        clip["url"] = "/media?ref=" + quote(clip["ref"], safe="")
    media_routes.grant_media(req["user"], *(clip["ref"] for clip in result.get("clips", [])))
    return web.json_response(result)


async def video_gif(req):
    data, options = await read_gif_request(req, fps_default=12)
    ref = data["ref"]
    start, end = data.get("start", 0), data.get("end")
    if (type(start) not in (int,float) or not 0 <= start < math.inf or
            end is not None and (type(end) not in (int,float) or not 0 < end < math.inf)):
        raise http_errors.bad("GIF 区间无效")
    try:
        path = tools.ref_path(config.COMFY_DIR, ref)
    except ValueError:
        raise http_errors.bad("找不到所选视频版本") from None
    if path.suffix.lower() not in tools.VIDEO_EXT or not path.is_file():
        raise http_errors.bad("找不到所选视频版本")
    return await make_gif(req, film.export_gif, path, start=start, end=end, **options)


async def image_gif(req):
    data, options = await read_gif_request(req, fps_default=8)
    rows, cols = data.get("rows"), data.get("cols")
    if any(type(value) is not int or not 1 <= value <= 6 for value in (rows,cols)):
        raise http_errors.bad("宫格行列数要在 1–6 之间")
    first, last = data.get("first",1), data.get("last",rows*cols)
    if type(first) is not int or type(last) is not int or not 1 <= first < last <= rows*cols:
        raise http_errors.bad("请选择至少两格连续画面")
    return await make_gif(req,film.export_grid_gif,data["ref"],rows=rows,cols=cols,first=first,last=last,**options)


async def read_gif_request(req, *, fps_default):
    try:
        data = await req.json()
    except (ValueError, UnicodeError):
        raise http_errors.bad("请求格式不正确") from None
    if not isinstance(data, dict) or not isinstance(data.get("ref"), str):
        raise http_errors.bad("请选择素材版本")
    fps, size, ping_pong = data.get("fps", fps_default), data.get("size", 360), data.get("ping_pong", False)
    if (type(fps) is not int or fps not in film.GIF_FPS or type(size) is not int or size not in film.GIF_SIZES or
            type(ping_pong) is not bool):
        raise http_errors.bad("GIF 尺寸、帧率或循环设置无效")
    media_routes.require_media(req["user"], {data["ref"]})
    return data, {"fps":fps,"size":size,"ping_pong":ping_pong}


async def make_gif(req, render_gif, source, **options):
    try:
        async with timeline_routes.RENDER_LOCK:
            result = await asyncio.to_thread(render_gif,config.COMFY_DIR,source,**options)
    except ValueError as error:
        raise http_errors.bad(str(error)) from None
    except (OSError, IndexError, DecompressionBombError):
        raise http_errors.bad("无法读取所选素材") from None
    media_routes.grant_media(req["user"], result["ref"])
    result["url"] = "/media?ref=" + quote(result["ref"], safe="")
    return web.json_response(result)


async def remake(req):
    from oneshot import app as application

    return await video_remake.handle(req, application)


async def split(req):
    p = await req.json()
    rows, cols = int(p.get("rows") or 3), int(p.get("cols") or 3)
    if not (1 <= rows <= 6 and 1 <= cols <= 6):
        raise http_errors.bad("宫格行列数要在 1~6 之间")
    try:
        tiles = await asyncio.get_running_loop().run_in_executor(None, tools.split_grid, config.COMFY_DIR, p["ref"], rows, cols)
    except Exception as e:
        raise http_errors.bad(f"拆分失败：{e}")
    for t in tiles:
        t["url"] = "/media?ref=" + quote(t["ref"], safe="")
    media_routes.grant_media(req["user"], *(tile["ref"] for tile in tiles))
    return web.json_response({"tiles": tiles})


async def concat(req):
    p = await req.json()
    try:
        r = await asyncio.get_running_loop().run_in_executor(None, tools.concat, config.COMFY_DIR, p.get("refs") or [])
    except Exception as e:
        raise http_errors.bad(f"拼接失败：{e}")
    r["url"] = "/media?ref=" + quote(r["ref"], safe="")
    media_routes.grant_media(req["user"], r["ref"])
    return web.json_response(r)
