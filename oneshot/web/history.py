"""Generation history and media favorites."""

import json
import time
from urllib.parse import quote

from aiohttp import web

from oneshot import config
from oneshot.canvas import board_store
from oneshot.canvas import routes as canvas_routes
from oneshot.canvas.board_store import BOARD_ID as _ID
from oneshot.canvas.board_store import board_meta
from oneshot.canvas.board_store import can_see
from oneshot.editing import render as film
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import tools
from oneshot.generation.audio import AUDIO_GENERATION_MODES, AUDIO_SETTINGS
from oneshot.memory import creative_memory
from oneshot.storage import db
from oneshot.web import auth
from oneshot.web import http as http_errors
from oneshot.web import media as media_routes


HISTORY_CAPABILITIES = {"image": ("image",), "video": ("video","render"), "audio": tuple(AUDIO_GENERATION_MODES)}


HISTORY_EXTENSIONS = {"image": creative_memory.IMAGE_EXT, "video": tools.VIDEO_EXT, "audio": tools.AUDIO_EXT}


def readable_history_image_edit(edit, user, permitted):
    if not isinstance(edit,dict):
        return None
    for ref in media_routes.media_references(edit):
        key = (ref,"image")
        if key not in permitted:
            try:
                permitted[key] = tools.ref_path(config.COMFY_DIR,ref).is_file() and media_routes.can_read_media(user,ref)
            except (OSError,ValueError):
                permitted[key] = False
        if not permitted[key]:
            return None
    return edit


def history_seed_refs(recipe, user, permitted):
    selected = set()
    selected_kind = None

    def keep(item):
        nonlocal selected_kind
        ref, kind, ident = item.get("ref"), item.get("kind"), item.get("node_id")
        if not isinstance(ref,str) or kind not in ("audio","image") or not isinstance(ident,str) or not _ID.fullmatch(ident):
            return False
        if ref in selected or selected_kind not in (None,kind) or len(selected) >= (3 if kind=="audio" else 1):
            return False
        key = (ref,kind)
        if key not in permitted:
            try:
                path = tools.ref_path(config.COMFY_DIR,ref)
                permitted[key] = path.suffix.lower() in HISTORY_EXTENSIONS[kind] and path.is_file() and media_routes.can_read_media(user,ref)
            except (OSError,ValueError):
                permitted[key] = False
        if not permitted[key]:
            return False
        selected.add(ref)
        selected_kind = kind
        return True

    return board_store.prune_seed_audio_refs(recipe,keep)


def task_settings(serialized):
    try:
        value = json.loads(serialized or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def generation_history_metadata(job):
    if job["state"] == "done" and job.get("kind") == "audio":
        transcript = next((out["extra"]["audio_transcript"] for out in job.get("outputs",[])
                           if out.get("extra",{}).get("audio_transcript")),None)
        task = db.one("SELECT request FROM tasks WHERE id=?", job["id"]) if transcript else None
        if task:
            request = task_settings(task["request"])
            request["audio_transcript"] = transcript
            return {"request":json.dumps(request,ensure_ascii=False)}
        return {}
    if job["state"] != "done" or job.get("kind") not in ("image", "video"):
        return {}
    meta = job.get("meta") or {}
    settings = {key: meta[key] for key in ("seed", "width", "height") if type(meta.get(key)) is int}
    if meta.get("prompt"):
        settings["prompt"] = http_errors.clean(meta["prompt"])[:2000]
    if job["kind"] == "video":
        settings.update(generation_jobs.video_job_details(meta))
    image_edits = {output["ref"]:output["extra"]["edit"] for output in job.get("outputs") or []
                   if job["kind"]=="image" and output.get("ref") and isinstance(output.get("extra",{}).get("edit"),dict)}
    if not settings and not image_edits:
        return {}
    task = db.one("SELECT request FROM tasks WHERE id=?", job["id"])
    if not task:
        return {}
    request = task_settings(task["request"])
    request["history"] = settings
    if image_edits:
        request["image_edits"] = image_edits
        if meta.get("mode_name"):
            settings["mode_name"] = meta["mode_name"]
    return {"request": json.dumps(request, ensure_ascii=False)}


async def generation_history(req):
    user = req["user"]
    kind = req.query.get("kind", "all")
    if kind != "all" and kind not in HISTORY_CAPABILITIES:
        raise http_errors.bad("不支持的历史类型")
    capabilities = sum(HISTORY_CAPABILITIES.values(), ()) if kind == "all" else HISTORY_CAPABILITIES[kind]
    conditions = ["user_id=?", "state='done'", "outputs IS NOT NULL",
                  "capability IN (" + ",".join("?" for _ in capabilities) + ")"]
    if "render" in capabilities:
        conditions.append("(capability!='render' OR json_type(CASE WHEN json_valid(request) THEN request END,'$.broll')='object')")
    params = [user["id"], *capabilities]
    if bid := req.query.get("board"):
        board = board_meta(canvas_routes.board_path(bid))
        if not board or not can_see(user, board):
            return auth.err(404, "画布不存在或无权访问")
        conditions.append("board_id=?")
        params.append(bid)
    query = req.query.get("q", "").strip()[:120]
    if query:
        conditions.append("instr(lower(coalesce(label,'') || ' ' || coalesce(model,'') || ' ' || coalesce(request,'') || ' ' || outputs),lower(?))>0")
        params.append(query)
    if cursor := req.query.get("before"):
        if not cursor.isascii() or not cursor.isdecimal() or len(cursor) > 18 or int(cursor) < 1:
            raise http_errors.bad("历史页码不正确")
        conditions.append("rowid<?")
        params.append(int(cursor))
    page_size = 24
    rows = db.q("SELECT rowid AS cursor,id,label,model,capability,finished,created,outputs,request FROM tasks WHERE " +
                " AND ".join(conditions) + " ORDER BY rowid DESC LIMIT ?", *params, page_size+1)
    items, permitted = [], {}
    for task in rows[:page_size]:
        try:
            refs = json.loads(task["outputs"])
        except (ValueError, TypeError):
            continue
        if not isinstance(refs,list):
            continue
        request = task_settings(task["request"])
        history, recipe = (request.get(key) for key in ("history", "recipe"))
        history = history if isinstance(history, dict) else {}
        recipe = recipe if isinstance(recipe, dict) else {}
        edits = request.get("image_edits")
        graphics = request.get("broll") if task["capability"]=="render" else None
        graphics_prompt = (graphics.get("title") or "\n".join(graphics.get("lines",[]))) if graphics else ""
        prompt = http_errors.clean(graphics_prompt or history.get("prompt") or recipe.get("prompt") or request.get("prompt") or request.get("text"))[:2000]
        item_kind = next(kind for kind,caps in HISTORY_CAPABILITIES.items() if task["capability"] in caps)
        audio = {key: recipe[key] for key in AUDIO_SETTINGS if key in recipe}
        if item_kind == "audio":
            audio.update(mode=task["capability"], prompt=http_errors.clean(recipe.get("prompt"))[:3000] or prompt)
        missing = history_seed_refs(audio,user,permitted)
        ext = HISTORY_EXTENSIONS[item_kind]
        for index, ref in enumerate(refs):
            if not isinstance(ref, str):
                continue
            try:
                file = tools.ref_path(config.COMFY_DIR, ref)
            except (ValueError, OSError):
                continue
            if file.suffix.lower() not in ext:
                continue
            available = file.is_file()
            saved_edit = edits.get(ref) if item_kind=="image" and isinstance(edits,dict) else None
            image_edit = readable_history_image_edit(saved_edit,user,permitted) if available else None
            dimensions = {key:history[key] for key in ("width","height") if type(history.get(key)) is int}
            if image_edit and isinstance(layer := image_edit.get("layer"),dict):
                for key, source in (("width","w"),("height","h")):
                    if type(layer.get(source)) is int:
                        dimensions[key] = layer[source]
            items.append({"id": f"{task['id']}:{index}", "type": item_kind, "ref": ref, "available": available,
                          "url": "/media?ref=" + quote(ref, safe="") if available else None,
                          "label": task["label"] or file.stem, "model": "B-roll" if graphics else task["model"], "prompt": prompt,
                          "created": task["finished"] or task["created"],
                          **({"source":"broll","broll_recipe":graphics} if graphics else {}),
                          **({"source":"edit","image_edit":image_edit} if image_edit else {}),
                          **({"image_edit_unavailable":True} if available and saved_edit and not image_edit else {}),
                          **({"audio_recipe": audio} if item_kind == "audio" else {}),
                          **({"missing_audio_references":missing} if missing else {}),
                          **({"audio_transcript":request["audio_transcript"]}
                             if item_kind == "audio" and isinstance(request.get("audio_transcript"),dict) else {}),
                          **({"seed":history["seed"]} if type(history.get("seed")) is int else {}), **dimensions})
    if items:
        saved = {row["ref"] for row in db.q("SELECT ref FROM media_favorites WHERE user_id=? AND ref IN (SELECT value FROM json_each(?))",
                                             user["id"], json.dumps([item["ref"] for item in items]))}
        for item in items:
            item["favorite"] = item["ref"] in saved
    return web.json_response({"items": items, "next": rows[page_size-1]["cursor"] if len(rows)>page_size else None},
                             headers={"Cache-Control": "private, no-store"})


async def list_media_favorites(req):
    user = req["user"]
    headers = {"Cache-Control": "private, no-store"}
    if "ref" in req.query:
        saved = db.one("SELECT 1 FROM media_favorites WHERE user_id=? AND ref=?", user["id"], req.query["ref"])
        return web.json_response({"favorite": bool(saved)}, headers=headers)
    kind = req.query.get("kind", "all")
    if kind != "all" and kind not in HISTORY_EXTENSIONS:
        raise http_errors.bad("不支持的收藏类型")
    filters, params = ["user_id=?"], [user["id"]]
    if kind != "all":
        filters.append("kind=?")
        params.append(kind)
    if query := req.query.get("q", "").strip()[:120]:
        filters.append("instr(lower(label || ' ' || data),lower(?))>0")
        params.append(query)
    if cursor := req.query.get("before"):
        if not cursor.isascii() or not cursor.isdecimal() or len(cursor)>18 or int(cursor)<1:
            raise http_errors.bad("收藏页码不正确")
        filters.append("rowid<?")
        params.append(int(cursor))
    page_size = 24
    rows = db.q("SELECT rowid AS cursor,ref,kind,label,data,created FROM media_favorites WHERE " +
                " AND ".join(filters) + " ORDER BY rowid DESC LIMIT ?", *params, page_size+1)
    items, permitted = [], {}
    for row in rows[:page_size]:
        ref = row["ref"]
        try:
            available = tools.ref_path(config.COMFY_DIR,ref).is_file() and media_routes.can_read_media(user,ref)
        except (ValueError,OSError):
            available = False
        data = task_settings(row["data"])
        missing = data.pop("missing_audio_references",0) + history_seed_refs(data.get("audio_recipe"),user,permitted)
        items.append({**data, **({"missing_audio_references":missing} if missing else {}),
                      "id":ref, "ref":ref, "label":row["label"], "type":row["kind"],
                      "created":row["created"], "favorite":True, "available":available,
                      "url":"/media?ref=" + quote(ref,safe="") if available else None})
    return web.json_response({"items":items,"next":rows[page_size-1]["cursor"] if len(rows)>page_size else None}, headers=headers)


async def update_media_favorite(req):
    user = req["user"]
    payload = await req.json()
    if not isinstance(payload,dict) or type(payload.get("favorite")) is not bool or not isinstance(payload.get("ref"),str):
        raise http_errors.bad("收藏请求不正确")
    ref, favorite = payload["ref"], payload["favorite"]
    if not favorite:
        db.run("DELETE FROM media_favorites WHERE user_id=? AND ref=?",user["id"],ref)
        return web.json_response({"favorite":False})
    try:
        path = tools.ref_path(config.COMFY_DIR,ref)
    except (ValueError,OSError):
        raise http_errors.bad("素材引用不正确") from None
    kind = next((kind for kind,extensions in HISTORY_EXTENSIONS.items() if path.suffix.lower() in extensions),None)
    if not kind or not path.is_file() or not media_routes.can_read_media(user,ref):
        return auth.err(404,"素材不存在或无权访问")
    data = {key: http_errors.clean(payload.get(key))[:limit] for key,limit in (("prompt",2000),("model",160),("source",40))}
    data.update({key:payload[key] for key in ("width","height") if type(payload.get(key)) is int and 0<payload[key]<=32768})
    if type(payload.get("seed")) is int and abs(payload["seed"]) < 2**53:
        data["seed"] = payload["seed"]
    recipe = payload.get("audio_recipe")
    if kind == "audio" and isinstance(recipe,dict):
        data["audio_recipe"] = {key:http_errors.clean(recipe.get(key))[:120] for key in ("voice","provider")}
        if isinstance(recipe.get("lyrics"),str):
            data["audio_recipe"]["lyrics"] = recipe["lyrics"][:3000]
        mode = recipe.get("mode")
        data["audio_recipe"].update(mode=mode if isinstance(mode,str) and mode in AUDIO_GENERATION_MODES else "tts",
                                   prompt=http_errors.clean(recipe.get("prompt"))[:3000] or data["prompt"])
        if type(recipe.get("speed")) in (int,float) and .5 <= recipe["speed"] <= 2:
            data["audio_recipe"]["speed"] = recipe["speed"]
        if mode in ("tts","seed_audio") and recipe.get("subtitles") is True:
            data["audio_recipe"]["subtitles"] = True
        if mode == "seed_audio" and isinstance(recipe.get("references"),list):
            keys = ("node_id","ref","kind")
            data["audio_recipe"]["references"] = [{key:item.get(key) for key in keys} if isinstance(item,dict) else None
                                                   for item in recipe["references"][:3]]
            if missing := history_seed_refs(data["audio_recipe"],user,{}):
                data["missing_audio_references"] = missing
        output = recipe.get("audio_format")
        rate = recipe.get("sample_rate")
        if isinstance(output,str) and output in film.AUDIO_OUTPUT_RATES and type(rate) is int and rate in film.AUDIO_OUTPUT_RATES[output]:
            data["audio_recipe"].update(audio_format=output,sample_rate=rate)
        pitch, gain = recipe.get("pitch_semitones"), recipe.get("gain")
        if type(pitch) is int and -12 <= pitch <= 12:
            data["audio_recipe"]["pitch_semitones"] = pitch
        if type(gain) in (int,float) and .5 <= gain <= 2:
            data["audio_recipe"]["gain"] = gain
        if mode == "sfx":
            if type(recipe.get("duration_seconds")) in (int,float) and .5 <= recipe["duration_seconds"] <= 30:
                data["audio_recipe"]["duration_seconds"] = recipe["duration_seconds"]
            if type(recipe.get("prompt_influence")) in (int,float) and 0 <= recipe["prompt_influence"] <= 1:
                data["audio_recipe"]["prompt_influence"] = recipe["prompt_influence"]
            if type(recipe.get("loop")) is bool:
                data["audio_recipe"]["loop"] = recipe["loop"]
    label = http_errors.clean(payload.get("label"))[:120] or path.stem
    db.run("INSERT OR IGNORE INTO media_favorites(user_id,ref,kind,label,data,created) VALUES(?,?,?,?,?,?)",
           user["id"],ref,kind,label,json.dumps(data,ensure_ascii=False),time.time())
    return web.json_response({"favorite":True})
