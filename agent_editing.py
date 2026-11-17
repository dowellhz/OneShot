"""Stage-two assistant tools: durable selections, masked edits, layers and recipes."""
from __future__ import annotations

import asyncio
import base64
import copy
import io
import json
import time
import uuid
from urllib.parse import quote

from aiohttp import web
from PIL import Image, ImageChops, ImageFilter, ImageOps

import db

routes = web.RouteTableDef()
SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_selections (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, node_id TEXT NOT NULL, source_ref TEXT NOT NULL,
 mask_ref TEXT NOT NULL, preview_ref TEXT NOT NULL, method TEXT NOT NULL, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS chat_selections_session ON chat_selections(session_id, created);
CREATE INDEX IF NOT EXISTS chat_calls_run ON chat_calls(run_id);
"""
NAMES = {"image_select", "image_segment", "image_edit", "image_layers_get", "image_layers_edit", "image_extract", "image_history", "image_reuse", "image_compare"}


def register(tools, tool, prop, node, text, prompt):
    params = {"target": prop("string", enum=["whole", "foreground", "background", "selection"]), "selection_id": node,
              "strength": prop("number", minimum=.01, maximum=1), "feather": prop("integer", minimum=0, maximum=128),
              "denoise": prop("number", minimum=.1, maximum=1), "steps": prop("integer", minimum=10, maximum=50),
              "seed": prop("integer", minimum=-1, maximum=2**48), "provider": prop("string", maxLength=100)}
    for item in tools:
        fn = item["function"]
        if fn["name"] == "image_edit":
            fn["parameters"]["properties"].update(params)
            fn["description"] = "编辑图片并创建新结果。用户只改背景/主体时必须指定target=background/foreground，工具自动生成真实保护遮罩；指定selection使用选区ID。whole只用于整图修改。"
    tool("image_select", "生成并保存可跨轮复用的选区。foreground/background自动识别主体；manual等待用户在编辑器画区域；existing复用已保存选区。", {
        "node_id": node, "mode": prop("string", enum=["foreground", "background", "manual", "existing"]),
        "selection_id": node, "instruction": text}, ["node_id", "mode"])
    tool("image_layers_get", "查看图片的可编辑图层ID、顺序和参数。重绘结果自动拆成编辑前底图+生成区域，避免重复叠加。", {"node_id": node}, ["node_id"])
    layer_fields = {"name": node, "opacity": prop("number", minimum=0, maximum=1), "visible": prop("boolean"),
                    "x": prop("integer", minimum=-8192, maximum=8192), "y": prop("integer", minimum=-8192, maximum=8192),
                    "w": prop("integer", minimum=1, maximum=8192), "h": prop("integer", minimum=1, maximum=8192)}
    tool("image_layers_edit", "按图层ID调整、隐藏、排序或导入其他图片节点，合成并保存可继续编辑的新结果节点。先读取图层ID；顺序从底到顶。", {
        "node_id": node, "changes": prop("array", maxItems=16, items=prop("object", properties={"layer_id": node, **layer_fields}, required=["layer_id"], additionalProperties=False)),
        "add": prop("array", maxItems=8, items=prop("object", properties={"node_id": node, **layer_fields}, required=["node_id"], additionalProperties=False)),
        "remove": prop("array", items=node, maxItems=16), "order": prop("array", items=node, maxItems=16), "name": node}, ["node_id"])
    tool("image_extract", "提取生成区域或已保存选区，创建独立透明PNG节点。", {"node_id": node,
        "kind": prop("string", enum=["generated", "selection"]), "selection_id": node}, ["node_id", "kind"])
    tool("image_history", "读取图片历史版本、生成参数和已保存选区。version_index为从0开始的历史索引。", {"node_id": node}, ["node_id"])
    tool("image_reuse", "沿用历史编辑的原图、遮罩与生成参数重新生成，可覆盖提示词、种子和强度。保留原结果，不在已编辑图片上重复叠加。", {
        "node_id": node, "version_index": prop("integer", minimum=0, maximum=4999), "prompt": prompt,
        "backend": prop("string", enum=["h3", "native"]), "name": node, **{k: v for k, v in params.items() if k not in ("target", "selection_id")}}, ["node_id"])
    tool("image_compare", "向页面提供编辑前后对比，可指定另一张图片作为对照。", {"node_id": node, "before_node_id": node,
        "mode": prop("string", enum=["wipe", "split"])}, ["node_id"])


def ref_url(ref):
    return "/media?ref=" + quote(ref, safe="")


def selections(session_id):
    return db.q("SELECT * FROM chat_selections WHERE session_id=? ORDER BY created DESC LIMIT 20", session_id) if session_id else []


def lookup(s, run, node_id, source_ref, selection_id=None, mask_ref=None):
    s.board({"id": run["user_id"]}, run["board_id"])
    where, value = ("id", selection_id) if selection_id else ("mask_ref", mask_ref)
    row = db.one(f"SELECT * FROM chat_selections WHERE session_id=? AND {where}=?", run["session_id"], value)
    if not row or row["source_ref"] != source_ref or row["node_id"] != node_id:
        raise ValueError("选区不属于当前会话的这张源图，请重新选择区域")
    return row


def persist_selection(s, run, node_id, source_ref, mask, method):
    editor, root = s.host.image_editor, s.host.COMFY_DIR
    source = editor.load(root, source_ref)
    if mask.size != source.size:
        raise ValueError("选区尺寸必须与本轮引用的源图一致")
    mask = mask.convert("L")
    if not mask.getbbox():
        raise ValueError("选区为空，请选择需要修改的位置")
    # Feathering may soften an edit inside the selected area; protected pixels stay exactly zero.
    saved = editor.save(root, mask, "agentmask", "input")
    overlay = Image.composite(Image.new("RGBA", source.size, "#ef4acb"), source, mask.point(lambda a: round(a * .45)))
    overlay.thumbnail((768, 768))
    preview = editor.save(root, overlay, "selection-preview")
    sid = "m" + uuid.uuid4().hex[:20]
    db.run("INSERT INTO chat_selections VALUES(?,?,?,?,?,?,?,?)", sid, run["session_id"], node_id, source_ref, saved["ref"], preview["ref"], method, time.time())
    run["data"].setdefault("masks", {})[saved["ref"]] = source_ref
    s.update(run)
    result = {"selection_id": sid, "node_id": node_id, "source_ref": source_ref, "mask_ref": saved["ref"],
              "preview_ref": preview["ref"], "method": method, "selected_pixels": sum(mask.histogram()[1:]), "w": source.width, "h": source.height}
    s.emit(run["session_id"], run["id"], "selection", result)
    return result


async def automatic_selection(s, run, user, node_id, mode):
    _, version = s.source(run, user, node_id)
    result = await s.response(s.host.image_edit_tool, user, {"ref": version["ref"]}, "/api/image-edit/cutout")
    foreground = s.host.image_editor.load(s.host.COMFY_DIR, result["ref"]).getchannel("A")
    # Protect the entire antialiased foreground plus a small rim, rather than mixing across it.
    foreground = foreground.point(lambda a: 255 if a else 0)
    if mode == "background":
        mask = ImageOps.invert(foreground.filter(ImageFilter.MaxFilter(3)))
    else:
        mask = foreground
    if not foreground.getbbox() or foreground.getextrema() == (255, 255):
        raise ValueError("未能可靠区分主体和背景，请使用手动选区")
    return persist_selection(s, run, node_id, version["ref"], mask, mode)


async def wait_input(s, run, user, cid):
    s.update(run, "waiting_input")
    while True:
        if s.stopped(run):
            raise ValueError("用户已停止选区任务")
        if time.time() - run["created"] > 1800:
            raise ValueError("等待选区超过30分钟，请发送新消息继续")
        row = db.one("SELECT state,result FROM chat_calls WHERE id=? AND run_id=?", cid, run["id"])
        if not row:
            raise ValueError("选区请求已不存在")
        result = json.loads(row["result"])
        if row["state"] == "ready":
            selection = lookup(s, run, result["node_id"], result["source_ref"], result["selection_id"])
            s.update(run, "running")
            run["data"].setdefault("masks", {})[selection["mask_ref"]] = selection["source_ref"]
            s.update(run)
            return result
        if row["state"] != "input":
            raise ValueError("选区请求状态已变更")
        _, version = s.source(run, user, result["node_id"])
        if version["ref"] != result["source_ref"]:
            raise ValueError("源图版本已失效，请重新提交编辑要求")
        await asyncio.sleep(.5)


def layer_stack(s, version):
    stack = copy.deepcopy(version.get("layer_stack"))
    if stack:
        if not isinstance(stack, dict) or not isinstance(stack.get("layers"), list) or not 1 <= len(stack["layers"]) <= 16:
            raise ValueError("图层记录格式不正确")
        return stack
    edit = version.get("edit") or {}
    base = edit.get("base") if edit.get("layer") else version["ref"]
    if not base:
        raise ValueError("缺少编辑前底图，不能提取生成图层")
    image = s.host.image_editor.load(s.host.COMFY_DIR, base)
    def item(lid, name, ref):
        return {"id": lid, "name": name, "ref": ref, "x": 0, "y": 0, "w": image.width, "h": image.height, "opacity": 1, "visible": True}
    layers = [item("base", "编辑前原图" if edit.get("layer") else "原图", base)]
    if edit.get("layer"):
        layers.append(item("generated", "生成区域", edit["layer"]["ref"]))
    return {"base_ref": base, "layers": layers}


def reachable_refs(board):
    """Collect media already present in this board's version and edit records."""
    found = set()
    def walk(value, key=""):
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, k)
        elif isinstance(value, list):
            for v in value:
                walk(v, key)
        elif key in ("ref", "source", "base", "base_ref", "mask", "agent_source") and isinstance(value, str) and value.startswith(("input:", "output:")):
            found.add(value)
    for n in board.get("nodes", []):
        walk(n.get("versions", []))
    return found


def validate_stack(s, run, user, stack):
    allowed = reachable_refs(s.board(user, run["board_id"]))
    if stack.get("base_ref") not in allowed or any(l.get("ref") not in allowed for l in stack["layers"]):
        raise ValueError("图层素材不在当前画布，请先导入图片节点")
    ids = [l.get("id") for l in stack["layers"]]
    if any(not isinstance(i, str) or not i or len(i) > 40 for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("图层编号格式不正确")


async def execute(s, run, user, cid, name, args):
    h = s.host
    n, version = s.source(run, user, args["node_id"])
    source_ref = version["ref"]
    if name == "image_select":
        mode = args["mode"]
        if mode == "existing":
            return lookup(s, run, n["id"], source_ref, args.get("selection_id"))
        if mode in ("foreground", "background"):
            return await automatic_selection(s, run, user, n["id"], mode)
        pending = {"call_id": cid, "node_id": n["id"], "source_ref": source_ref, "name": n.get("name"),
                   "instruction": args.get("instruction") or "请在图片上画出需要修改的区域，然后点击「发送选区给助手」。"}
        db.run("UPDATE chat_calls SET state='input',result=?,updated=? WHERE id=?", json.dumps(pending, ensure_ascii=False), time.time(), cid)
        s.emit(run["session_id"], run["id"], "selection_request", pending)
        return await wait_input(s, run, user, cid)
    if name == "image_segment":
        points = [{"x": p["x"], "y": p["y"], "label": 1 if p.get("positive", True) else 0} for p in args["points"]]
        result = await s.response(h.image_edit_tool, user, {"ref": source_ref, "points": points}, "/api/image-edit/segment")
        mask = h.image_editor.load(h.COMFY_DIR, result["ref"]).getchannel("A")
        if args.get("invert"):
            mask = ImageOps.invert(mask)
        return persist_selection(s, run, n["id"], source_ref, mask, "click")
    if name == "image_edit":
        target = args.get("target") or ("selection" if args.get("mask_ref") or args.get("selection_id") else "whole")
        selection = None
        if args.get("selection_id") or args.get("mask_ref"):
            selection = lookup(s, run, n["id"], source_ref, args.get("selection_id"), args.get("mask_ref"))
            if target == "whole":
                raise ValueError("已有选区时不能同时要求整图修改，请明确编辑范围")
        elif target in ("background", "foreground"):
            selection = await automatic_selection(s, run, user, n["id"], target)
        elif target == "selection":
            raise ValueError("请先生成选区，或通过手动选区工具等待用户画区域")
        payload = {"ref": source_ref, "mode": "region" if selection else "whole", "prompt": args["prompt"],
                   "backend": args.get("backend", "h3"), "feather": args.get("feather", 4), "strength": args.get("strength", 1),
                   "denoise": args.get("denoise", .95), "steps": args.get("steps", 25), "seed": args.get("seed", -1)}
        if selection:
            payload["mask"] = selection["mask_ref"]
        if args.get("provider"):
            payload["provider"] = args["provider"]
        return await s.submit_generation(run, user, cid, payload, args.get("name") or n.get("name", "图片") + " · 修改", h.image_edit_generate)
    if name == "image_history":
        return {"node_id": n["id"], "bound_ref": source_ref, "versions": [
            {"version_index": i, "ref": v["ref"], "prompt": (v.get("prompt") or "")[:800], "seed": v.get("seed"),
             "w": v.get("w"), "h": v.get("h"), "recipe": (v.get("edit") or {}).get("recipe"), "has_layers": bool(v.get("layer_stack") or (v.get("edit") or {}).get("layer"))}
            for i, v in list(enumerate(n.get("versions", [])))[-40:]],
            "selections": [m for m in selections(run["session_id"]) if m["node_id"] == n["id"] and m["source_ref"] == source_ref]}
    if name == "image_reuse":
        if "version_index" in args:
            if args["version_index"] >= len(n["versions"]):
                raise ValueError("历史版本已不存在")
            version = n["versions"][args["version_index"]]
        recipe = copy.deepcopy((version.get("edit") or {}).get("recipe"))
        if not isinstance(recipe, dict) or not recipe.get("ref") or not recipe.get("prompt"):
            raise ValueError("这个版本没有可复用的编辑参数")
        allowed = reachable_refs(s.board(user, run["board_id"]))
        if recipe["ref"] not in allowed or recipe.get("mask") and recipe["mask"] not in allowed:
            raise ValueError("原图或遮罩已不可用，不能复用参数")
        keys = ("ref", "mask", "mode", "prompt", "backend", "strength", "feather", "denoise", "steps", "seed", "provider", "padding")
        payload = {k: recipe[k] for k in keys if k in recipe}
        payload.update({k: args[k] for k in keys if k in args})
        return await s.submit_generation(run, user, cid, payload, args.get("name") or n.get("name", "图片") + " · 重试", h.image_edit_generate)
    if name == "image_compare":
        before = source_ref
        if args.get("before_node_id"):
            _, original = s.source(run, user, args["before_node_id"])
            before = original["ref"]
        else:
            before = (version.get("edit") or {}).get("source") or version.get("agent_source")
        if not before or before not in reachable_refs(s.board(user, run["board_id"])):
            raise ValueError("缺少编辑前图片，请指定对照图片节点")
        result = {"node_id": n["id"], "before_ref": before, "after_ref": source_ref, "mode": args.get("mode", "wipe")}
        s.emit(run["session_id"], run["id"], "compare", result)
        return {**result, "requested": True}
    if name == "image_extract":
        if args["kind"] == "generated":
            result = (version.get("edit") or {}).get("layer")
            if not result:
                raise ValueError("这个版本没有可提取的生成区域")
            result = copy.deepcopy(result)
        else:
            selection = lookup(s, run, n["id"], source_ref, args.get("selection_id"))
            result = await s.response(h.image_layers, user, {"ref": source_ref, "mask": selection["mask_ref"]}, "/api/image-edit/selection-cutout")
        return s.add_results(run, user, cid, [{**result, "source": "edit", "agent_source": source_ref}], n.get("name", "图片") + " · 透明图层")
    stack = layer_stack(s, version)
    validate_stack(s, run, user, stack)
    if name == "image_layers_get":
        return {"node_id": n["id"], **stack}
    layers = stack["layers"]
    for change in args.get("changes", []):
        layer = next((l for l in layers if l["id"] == change["layer_id"]), None)
        if not layer:
            raise ValueError("图层已不存在，请重新读取图层列表")
        layer.update({k: v for k, v in change.items() if k != "layer_id"})
    remove = set(args.get("remove", []))
    if remove - {l["id"] for l in layers}:
        raise ValueError("要删除的图层已不存在")
    layers[:] = [l for l in layers if l["id"] not in remove]
    for i, addition in enumerate(args.get("add", [])):
        src, v = s.source(run, user, addition["node_id"])
        image = h.image_editor.load(h.COMFY_DIR, v["ref"])
        layers.append({"id": "l" + uuid.uuid5(uuid.NAMESPACE_URL, cid + str(i)).hex[:16], "name": src.get("name", "导入图层"),
                       "ref": v["ref"], "x": 0, "y": 0, "w": image.width, "h": image.height, "opacity": 1, "visible": True,
                       **{k: val for k, val in addition.items() if k != "node_id"}})
    if not 1 <= len(layers) <= 16:
        raise ValueError("请保留1至16个图层")
    if "order" in args:
        if len(args["order"]) != len(layers) or set(args["order"]) != {l["id"] for l in layers}:
            raise ValueError("图层顺序必须恰好包含所有保留的图层ID")
        stack["layers"] = layers = [next(l for l in layers if l["id"] == lid) for lid in args["order"]]
    result = await s.response(h.image_layers, user, {"ref": stack["base_ref"], "layers": layers}, "/api/image-edit/layers")
    return s.add_results(run, user, cid, [{**result, "layer_stack": stack, "source": "edit", "agent_source": source_ref,
                                         "edit": {"mode": "layers", "source": source_ref}}], args.get("name") or n.get("name", "图片") + " · 图层")


def pending_inputs(session_id):
    rows = db.q("SELECT c.id,c.run_id,c.result FROM chat_calls c JOIN chat_runs r ON c.run_id=r.id WHERE r.session_id=? AND c.state='input' AND r.state NOT IN ('done','error','stopped')", session_id)
    return [{**json.loads(row["result"]), "run_id": row["run_id"]} for row in rows]


def decode_mask(s, source_ref, encoded):
    if not isinstance(encoded, str) or not encoded.startswith("data:image/png;base64,") or len(encoded) > 12 * 1024 * 1024:
        raise ValueError("请提交有效的PNG选区（最大8MB）")
    raw = base64.b64decode(encoded.split(",", 1)[1], validate=True)
    source = s.host.image_editor.load(s.host.COMFY_DIR, source_ref)
    with Image.open(io.BytesIO(raw)) as im:
        if im.format != "PNG" or im.size != source.size:
            raise ValueError("选区尺寸必须与请求的源图一致")
        # The editor exports an opaque black/white mask; transparency cannot become an all-white edit.
        rgba = im.convert("RGBA")
        mask = ImageChops.multiply(rgba.convert("L"), rgba.getchannel("A"))
    if not mask.getbbox():
        raise ValueError("选区为空，请先画出需要修改的区域")
    return mask


@routes.post("/api/chat/runs/{rid}/selection")
async def submit_selection(req):
    from agent_chat import service, session_for, TERMINAL
    s = service(req)
    row = db.one("SELECT * FROM chat_runs WHERE id=? AND user_id=?", req.match_info["rid"], req["user"]["id"])
    if not row:
        raise web.HTTPNotFound()
    session_for(req, row["session_id"])
    payload = await req.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("call_id"), str):
        return web.json_response({"error": "选区请求编号格式不正确"}, status=400)
    cid = payload["call_id"]
    if not hasattr(s, "input_locks"):
        s.input_locks = {}
    async with s.input_locks.setdefault(cid, asyncio.Lock()):
        call = db.one("SELECT * FROM chat_calls WHERE id=? AND run_id=?", cid, row["id"])
        if not call or call["name"] != "image_select":
            raise web.HTTPNotFound()
        pending = json.loads(call["result"] or "{}")
        if call["state"] in ("ready", "done") and pending.get("selection_id"):
            return web.json_response(pending)
        if call["state"] != "input" or db.one("SELECT state FROM chat_runs WHERE id=?", row["id"])["state"] in TERMINAL | {"stopping"}:
            return web.json_response({"error": "本轮已结束或选区请求已变更"}, status=409)
        run = {**row, "data": json.loads(row["data"])}
        try:
            _, version = s.source(run, req["user"], pending["node_id"])
            if version["ref"] != pending["source_ref"]:
                raise ValueError("源图已变更，请重新选择区域")
            mask = await asyncio.to_thread(decode_mask, s, version["ref"], payload.get("mask_data"))
            s.source(run, req["user"], pending["node_id"])
            if s.stopped(run):
                return web.json_response({"error": "本轮已停止"}, status=409)
            result = persist_selection(s, run, pending["node_id"], version["ref"], mask, "manual")
            db.run("UPDATE chat_calls SET state='ready',result=?,updated=? WHERE id=?", json.dumps(result, ensure_ascii=False), time.time(), cid)
            return web.json_response(result)
        except (ValueError, OSError) as e:
            return web.json_response({"error": str(e)[:300]}, status=400)
