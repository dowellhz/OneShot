"""Media permissions, uploads, downloads, and transfers."""

import asyncio
import json
import os
import re
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote
from urllib.parse import unquote
from xml.etree.ElementTree import ParseError

from aiohttp import web
from PIL.Image import DecompressionBombError

from oneshot import config
from oneshot.canvas import asset_transfers
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas import showcase
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_see
from oneshot.editing import image_editor
from oneshot.editing import render as film
from oneshot.generation import tools
from oneshot.memory import creative_memory
from oneshot.storage import db
from oneshot.web import history as media_history
from oneshot.web import http as http_errors


def refs_of_user(u: dict) -> set:
    seen = set()
    for f in canvas_routes.BOARDS.glob("*.json"):
        b = board_meta(f)
        if b and can_see(u, b):
            for n in b.get("nodes", []):
                for v in n.get("versions", []):
                    seen.add(v.get("ref"))
    return seen


def media_references(value, field=""):
    if isinstance(value, str):
        if not (field in {"ref", "refs", "url", "cover", "source", "base", "mask", "overlay", "mid",
                          "remake_audio", "first_frame", "corrections", "replacement_corrections", "protections"}
                or field.endswith(("_ref", "_url", "_mask"))):
            return set()
        if value.startswith("/media?ref="):
            value = unquote(value.removeprefix("/media?ref=").split("#", 1)[0].split("&", 1)[0])
        return {value} if value.startswith(("input:h3studio/", "output:h3studio/")) else set()
    if isinstance(value, (dict, list)):
        refs = set()
        if isinstance(value, dict):
            for key, item in value.items():
                refs.update(media_references(item, field if key.isdecimal() else key))
        else:
            for item in value:
                refs.update(media_references(item, field))
        return refs
    return set()


def grant_media(user, *refs):
    for ref in refs:
        if ref:
            db.run("INSERT OR IGNORE INTO media_grants VALUES(?,?)", ref, user["id"])


def can_read_media(user, ref, *, seen=frozenset()):
    from oneshot import app as application

    if user["role"] == "admin":
        return True
    uid = user["id"]
    if (db.one("SELECT 1 FROM memory_uploads WHERE ref=? AND owner=?", ref, uid)
            or db.one("SELECT 1 FROM media_grants WHERE ref=? AND user_id=?", ref, uid)
            or db.one("SELECT 1 FROM memory_outputs WHERE ref=? AND owner=?", ref, uid)
            or db.one("""SELECT 1 FROM tasks, json_each(CASE WHEN json_valid(tasks.outputs) THEN tasks.outputs END)
                         WHERE user_id=? AND json_each.value=? LIMIT 1""", uid, ref)):
        return True
    if ref in seen:
        return False
    if re.fullmatch(r"(?:input:h3studio/editbase|output:h3studio/edit-layer)_[^/]+\.png",ref):
        for row in db.q("SELECT request FROM tasks WHERE user_id=? AND capability='image' AND state='done' AND instr(request,?)>0",uid,ref):
            edits = media_history.task_settings(row["request"]).get("image_edits")
            if not isinstance(edits,dict):
                continue
            for edit in edits.values():
                if not isinstance(edit,dict):
                    continue
                layer = edit.get("layer")
                if ref != edit.get("base") and (not isinstance(layer,dict) or ref != layer.get("ref")):
                    continue
                source = edit.get("source")
                if isinstance(source,str) and source != ref and can_read_media(user,source,seen=seen | {ref}):
                    return True
    for row in db.q("SELECT board,data FROM video_remakes WHERE owner=? AND instr(data,?)>0", uid, ref):
        board = board_meta(canvas_routes.board_path(row["board"]))
        if board and can_see(user, board) and ref in media_references(json.loads(row["data"])):
            return True
    if db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_selections'") and db.one(
        """SELECT 1 FROM chat_selections s JOIN chat_sessions c ON c.id=s.session_id
           WHERE c.user_id=? AND (s.mask_ref=? OR s.preview_ref=?) LIMIT 1""", uid, ref, ref
    ):
        return True
    for path in canvas_routes.BOARDS.glob("*.json"):
        board = board_meta(path)
        if board and can_see(user, board) and ref in media_references(board):
            return True
    store = creative_memory.Store(application)
    teams = store.teams(user)
    for asset in store.all():
        if ref not in media_references(asset.get("media", [])):
            continue
        if asset["board"]:
            board = board_meta(canvas_routes.board_path(asset["board"]))
            if not board or not can_see(user, board):
                continue
        if asset["board"] or store.visible(asset,user,teams=teams):
            return True
    for path in (canvas_routes.SAMPLES / "samples.json", *(canvas_routes.SAMPLES / "boards").glob("*.json")):
        try:
            if ref in media_references(json.loads(path.read_text())):
                return True
        except (OSError, ValueError):
            continue
    return False


def require_media(user, refs):
    if user["role"] != "admin" and any(not can_read_media(user, ref) for ref in refs):
        raise web.HTTPForbidden(text=json.dumps({"error": "没有权限访问所选素材"}, ensure_ascii=False),
                                content_type="application/json")


@web.middleware
async def media_input_guard(req, handler):
    if req.method == "POST" and (req.path in {
        "/api/preview", "/api/generate", "/api/lastframe", "/api/rewrite", "/api/storyboard",
        "/api/describe", "/api/analyze", "/api/split", "/api/concat", "/api/render", "/api/render/check", "/api/cover",
        "/api/video/trim", "/api/video/captions",
    } or req.path.startswith("/api/image-edit/")):
        try:
            payload = await req.json()
        except (ValueError, UnicodeError):
            raise http_errors.bad("请求格式不正确") from None
        require_media(req["user"], media_references(payload))
    return await handler(req)


async def assets(req):
    u = req["user"]
    mine = None if u["role"] == "admin" else refs_of_user(u)
    out = []
    for kind in ("output", "input"):
        d = config.COMFY_DIR / kind / "h3studio"
        if not d.is_dir():
            continue
        for f in d.iterdir():
            ext = f.suffix.lower()
            if ext not in CANVAS_MEDIA_EXT or f.name.startswith("shotmid_"):
                continue
            ref = f"{kind}:h3studio/{f.name}"
            if mine is not None and ref not in mine:
                continue
            src = ("concat" if f.name.startswith("cut_") else "gen") if kind == "output" else (
                "frame" if f.name.startswith(("last_", "shot_")) else "tile" if f.name.startswith("tile")
                else "gen" if ext in AUDIO_MEDIA_EXT and f.name.startswith("narr_") else "upload")
            typ = "video" if ext in tools.VIDEO_EXT else "audio" if ext in AUDIO_MEDIA_EXT else "image"
            out.append({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "type": typ,
                        "source": src,
                        "mtime": f.stat().st_mtime})
    out.sort(key=lambda a: -a["mtime"])
    return web.json_response(out[:300])


async def upload(req):
    reader = await req.multipart()
    part = await reader.next()
    ext = os.path.splitext(part.filename or "x.png")[1].lower() or ".png"
    if ext == ".ora":
        return await upload_openraster(req, part)
    raw = await part.read(decode=False)
    name = f"u_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
    if ext in tools.VIDEO_EXT:
        dst = config.COMFY_DIR / "input" / "h3studio" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
        ref = f"input:h3studio/{name}"
        try:
            info = await asyncio.get_running_loop().run_in_executor(None, tools.video_info, dst)
        except Exception as e:
            dst.unlink(missing_ok=True)
            raise web.HTTPBadRequest(text=json.dumps({"error": f"读不了这个视频：{e}"}, ensure_ascii=False), content_type="application/json")
        db.run("INSERT OR IGNORE INTO memory_uploads VALUES(?,?,?)", ref, req["user"]["id"], time.time())
        return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe=""), "type": "video", **info})
    if ext not in creative_memory.IMAGE_EXT:
        raise http_errors.bad("只支持 PNG / JPG / WEBP 图片，或 MP4 / MOV / WEBM / M4V / MKV 视频")
    dst = config.COMFY_DIR / "input" / "h3studio" / name

    def store():
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as im:     # refuses anything that is not really an image
            im.verify()
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
    try:
        await asyncio.get_running_loop().run_in_executor(None, store)
    except Exception as e:
        raise http_errors.bad(f"读不了这张图片：{e}")
    ref = f"input:h3studio/{name}"
    db.run("INSERT OR IGNORE INTO memory_uploads VALUES(?,?,?)", ref, req["user"]["id"], time.time())
    return web.json_response({"ref": ref, "url": "/media?ref=" + quote(ref, safe="")})


async def upload_openraster(req, part):
    try:
        with tempfile.TemporaryFile() as source:
            limit = 64 * 1024 * 1024
            while chunk := await part.read_chunk(64 * 1024):
                if source.tell() + len(chunk) > limit:
                    raise http_errors.bad("OpenRaster 文件不能超过 64 MB")
                source.write(chunk)
            result = await asyncio.to_thread(image_editor.import_openraster, config.COMFY_DIR, source)
    except ValueError as error:
        raise http_errors.bad(str(error)) from None
    except (zipfile.BadZipFile, ParseError, OSError, KeyError, RuntimeError, DecompressionBombError):
        raise http_errors.bad("读不了这个 OpenRaster 文件，请检查图层文件是否完整") from None
    grant_media(req["user"], result["ref"], *(layer["ref"] for layer in result["layer_stack"]["layers"]))
    return web.json_response(result)


async def media(req):
    ref = req.query.get("ref", "")
    try:
        f = tools.ref_path(config.COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest()
    gif = f.suffix == ".gif" and bool(showcase.EXPORTED_GIF.fullmatch(ref))
    if (f.suffix.lower() not in MEDIA_EXT and not gif) or not f.is_file():
        raise web.HTTPNotFound()
    if not can_read_media(req["user"], ref):
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})


AUDIO_MEDIA_EXT = tools.AUDIO_EXT


CANVAS_MEDIA_EXT = MEDIA_EXT = creative_memory.IMAGE_EXT | tools.VIDEO_EXT | AUDIO_MEDIA_EXT


def resolve_asset_exports(user, refs):
    if not isinstance(refs, list) or not 1 <= len(refs) <= 100 or not all(isinstance(ref, str) for ref in refs):
        raise http_errors.bad("请选择 1–100 个素材")
    allowed = None if user["role"] == "admin" else refs_of_user(user)
    paths = []
    for ref in dict.fromkeys(refs):
        try:
            path = tools.ref_path(config.COMFY_DIR, ref)
        except ValueError:
            raise http_errors.bad("素材引用不正确")
        if (allowed is not None and ref not in allowed and not can_read_media(user,ref)) or not path.is_file() or path.suffix.lower() not in MEDIA_EXT:
            raise http_errors.bad("素材不存在或没有访问权限")
        paths.append(path)
    return paths


async def export_assets(req):
    p = await req.json()
    paths = resolve_asset_exports(req["user"],p.get("refs") if isinstance(p,dict) else None)
    return await serve_asset_archive([(f"{i:02d}_{path.name}",path) for i,path in enumerate(paths,1)],"OneShot-assets.zip")


async def start_asset_transfer(req):
    p = await req.json()
    refs = p.get("refs") if isinstance(p,dict) else None
    paths = resolve_asset_exports(req["user"],refs)
    name = p.get("name","OneShot-素材.zip")
    if not isinstance(name,str):
        raise http_errors.bad("下载文件名无效")
    name = re.sub(r'[\x00-\x1f/\\]',"_",name.strip().removesuffix(".zip"))[:100] or "OneShot-素材"
    try:
        item = asset_transfers.start(req["user"]["id"],list(dict.fromkeys(refs)),paths,name+".zip",config.DATA_DIR/"transfers")
    except OSError:
        raise http_errors.bad("源文件已失效，请重新选择素材") from None
    return web.json_response(asset_transfers.describe(item),status=202)


async def asset_transfer_status(req):
    item = asset_transfers.lookup(req["user"]["id"],req.match_info["key"])
    return web.json_response(asset_transfers.describe(item),headers={"Cache-Control":"no-store"})


async def download_asset_transfer(req):
    item = asset_transfers.lookup(req["user"]["id"],req.match_info["key"])
    try:
        resolve_asset_exports(req["user"],item["refs"])
    except web.HTTPException:
        if item["state"] in ("ready","sent"):
            asset_transfers.update(item,"error",error="下载权限或源文件已变化，请重新选择素材")
        raise
    return await asset_transfers.send(req,item)


async def serve_asset_archive(entries, filename):
    directory = config.DATA_DIR / "exports"; directory.mkdir(parents=True, exist_ok=True)
    dst = directory / (uuid.uuid4().hex + ".zip")
    def archive():
        try:
            with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
                for name, content in entries:
                    if isinstance(content,bytes):
                        z.writestr(name,content)
                    else:
                        z.write(content,name)
        except Exception:
            dst.unlink(missing_ok=True)
            raise
        # Exports contain only references already authorized above. Remove old archives.
        for old in directory.glob("*.zip"):
            if old != dst and time.time() - old.stat().st_mtime > 86400:
                old.unlink(missing_ok=True)
    await asyncio.to_thread(archive)
    disposition = 'attachment; filename="OneShot-assets.zip"'
    if filename != "OneShot-assets.zip":
        disposition += "; filename*=UTF-8''" + quote(filename,safe="")
    return web.FileResponse(dst, headers={"Content-Disposition":disposition,"Cache-Control":"no-store"})


def media_info(path: Path, kind: str) -> dict:
    try:
        if kind == "video":
            w, h, dur, _ = film.probe(path)
            return {"width": w, "height": h, "duration": round(dur, 2)}
        if kind == "image":
            from PIL import Image
            with Image.open(path) as im:
                return {"width": im.width, "height": im.height}
        if kind == "audio":
            return {"duration":film.audio_duration(path)}
    except Exception:
        pass
    return {}
