"""Image editing and image tool endpoints."""

import asyncio
import hashlib
import json
import re
import time
import uuid
from urllib.parse import quote

import aiohttp
from aiohttp import web

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_see
from oneshot.editing import image_editor
from oneshot.editing import image_upscale
from oneshot.generation import requests as generation_requests
from oneshot.generation import tools
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


async def image_transform(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("图像编辑参数须为对象")
    try:
        r = await asyncio.to_thread(image_editor.transform, config.COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise http_errors.bad(str(e))
    media_routes.grant_media(req["user"], r.get("ref"))
    return web.json_response(r)


async def image_layers(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("图像编辑参数须为对象")
    try:
        fn = image_editor.cut_selection if req.path.endswith("selection-cutout") else image_editor.compose_layers
        result = await asyncio.to_thread(fn, config.COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise http_errors.bad(str(e))
    media_routes.grant_media(req["user"], result.get("ref"))
    return web.json_response(result)


async def image_openraster(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("图层导出参数须为对象")
    directory = config.DATA_DIR / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (uuid.uuid4().hex + ".ora")

    def build():
        try:
            image_editor.export_openraster(config.COMFY_DIR, p, destination)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        cutoff = time.time() - 86400
        for old in directory.glob("*.ora"):
            try:
                if old.stat().st_mtime < cutoff:
                    old.unlink(missing_ok=True)
            except FileNotFoundError:
                continue

    try:
        await asyncio.to_thread(build)
    except (ValueError, OSError, TypeError) as error:
        raise http_errors.bad(str(error)) from None
    name = image_editor.ora_name(p.get("name"), "OneShot")
    filename = quote(re.sub(r'[\\/:*?"<>|]', "_", name) + ".ora", safe="")
    headers = {"Content-Disposition": f"attachment; filename=\"OneShot.ora\"; filename*=UTF-8''{filename}",
               "Content-Type": "image/openraster", "Cache-Control": "no-store"}
    return web.FileResponse(destination, headers=headers)


def image_draft_path(req, ref):
    bid, nid = req.match_info["board"], req.match_info["node"]
    if not _ID.fullmatch(nid):
        raise http_errors.bad("节点编号格式不对")
    board = canvas_routes.board_path(bid)
    if not board.exists() or not can_see(req["user"], board_meta(board)):
        raise web.HTTPNotFound()
    try:
        tools.ref_path(config.COMFY_DIR, ref)
    except ValueError:
        raise http_errors.bad("图片引用格式不对")
    key = hashlib.sha256(f'{req["user"]["id"]}:{bid}:{nid}:{ref}'.encode()).hexdigest()
    return config.DATA_DIR / "image-drafts" / (key + ".json")


async def image_draft_get(req):
    path = image_draft_path(req, req.query.get("ref", ""))
    try:
        result = json.loads(await asyncio.to_thread(path.read_text))
    except FileNotFoundError:
        result = None
    return web.json_response(result)


async def image_draft_save(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise http_errors.bad("草稿格式不正确")
    path = image_draft_path(req, p["ref"])
    try:
        raw = json.dumps(p, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raise http_errors.bad("草稿包含无效数值")
    if len(raw.encode()) > 8 * 1024 * 1024:
        raise http_errors.bad("草稿过大，请减少选区笔画或图层")
    def write():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.stem + "." + uuid.uuid4().hex[:8] + ".tmp")
        tmp.write_text(raw); tmp.replace(path)
    await asyncio.to_thread(write)
    return web.json_response({"ok": True})


async def image_edit_capabilities(req):
    capabilities = {"segment": False, "cutout": False, "native": False, "decompose": False}
    try:
        async with req.app["http"].get(config.ENGINE + "/status", timeout=aiohttp.ClientTimeout(total=4)) as r:
            s = await r.json()
        capabilities.update(s.get("editor", {}))
    except Exception:
        pass
    capabilities["upscale"] = await asyncio.to_thread(image_upscale.available_scales, config.IMAGE_UPSCALE_MODELS)
    return web.json_response(capabilities)


async def image_upscale_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise http_errors.bad("请选择要放大的图片")
    media_routes.require_media(req["user"], [p["ref"]])
    try:
        result = await asyncio.to_thread(image_upscale.upscale, config.COMFY_DIR, config.IMAGE_UPSCALE_MODELS,
                                         p["ref"], p.get("scale"))
    except (ValueError, OSError) as error:
        raise http_errors.bad(str(error)) from None
    media_routes.grant_media(req["user"], result["ref"])
    return web.json_response(result)


async def image_edit_tool(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("图像编辑参数须为对象")
    tool = req.path.rsplit("/", 1)[-1]
    result = await run_image_tool(req.app, tool, p)
    media_routes.grant_media(req["user"], result.get("ref"))
    return web.json_response(result)


async def image_decompose_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not isinstance(p.get("ref"), str):
        raise http_errors.bad("请选择要分层的图片")
    media_routes.require_media(req["user"],[p["ref"]])
    labels = await run_image_tool(req.app,"decompose",p)
    path = tools.ref_path(config.COMFY_DIR,labels["ref"])
    try:
        result = await asyncio.to_thread(image_editor.decompose,config.COMFY_DIR,p["ref"],labels["ref"])
    except (ValueError,OSError) as error:
        raise http_errors.bad(str(error)) from None
    finally:
        path.unlink(missing_ok=True)
    media_routes.grant_media(req["user"],result["ref"])
    for layer in result["layer_stack"]["layers"]:
        media_routes.grant_media(req["user"],layer["ref"])
    return web.json_response(result)


async def image_fill_background_route(req):
    p = await req.json()
    if not isinstance(p, dict) or not all(isinstance(p.get(key), str) for key in ("ref", "background")):
        raise http_errors.bad("请选择要补全的分层背景")
    media_routes.require_media(req["user"],[p["ref"],p["background"]])
    try:
        result = await asyncio.to_thread(image_editor.fill_background, config.COMFY_DIR, p["ref"], p["background"],
                                         p.get("x"), p.get("y"))
    except (ImportError, ValueError, OSError) as error:
        raise http_errors.bad(str(error)) from None
    media_routes.grant_media(req["user"], result["ref"])
    return web.json_response(result)


async def run_image_tool(app, tool, p):
    try:
        image = tools.ref_path(config.COMFY_DIR, p.get("ref", ""))
        await asyncio.to_thread(image_editor.load, config.COMFY_DIR, p.get("ref", ""))
        prefix = {"segment":"selection","cutout":"cutout","decompose":"layer_labels"}[tool]
        out, ref = tools._new(config.COMFY_DIR, "output", prefix, ".png")
        async with app["http"].post(config.ENGINE + "/tools/" + tool,
                                       json={"image": str(image), "points": p.get("points"), "out": str(out)},
                                       timeout=aiohttp.ClientTimeout(total=180)) as r:
            result = await r.json()
            if r.status != 200:
                raise ValueError(result.get("error") or "图像工具执行失败")
        return {"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "w": result["width"], "h": result["height"],
                "score": result.get("score")}
    except (ValueError, OSError, TypeError, aiohttp.ClientError, asyncio.TimeoutError) as e:
        raise http_errors.bad(str(e) or "图像工具暂时不可用")


async def image_edit_generate(req):
    p = await req.json()
    if not isinstance(p, dict):
        raise http_errors.bad("图像编辑参数须为对象")
    try:
        raw = await asyncio.to_thread(image_editor.prepare, config.COMFY_DIR, p)
    except (ValueError, OSError, TypeError) as e:
        raise http_errors.bad(str(e))
    if raw.get("_native_inpaint"):
        memory = req.app["creative_memory"]
        raw["prompt"] = raw["_native_inpaint"]["prompt"]
        prepared = memory.prepare(req["user"], raw)
        if any(a.get("ref") for a in prepared.get("memory_used", [])):
            raise http_errors.bad("原生重绘不支持额外参考图；请切换到 H3 编辑以采用记忆参考图")
        return await generation_requests.submit_prepared_generation(req, prepared)
    return await generation_requests.generate_request(req, raw)
