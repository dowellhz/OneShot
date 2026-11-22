"""Capture only canvas content intended for unauthenticated sharing."""
import json
import math
from urllib.parse import quote

from tools import AUDIO_EXT, VIDEO_EXT, ref_path

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
SOURCE_RELATIONS = {"trim", "capture", "transcript", "audio_cut"}
PINNED_RELATIONS = SOURCE_RELATIONS | {"audio_ref", "video_ref"}
HEADERS = {"Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "X-Robots-Tag":"noindex, nofollow",
           "X-Content-Type-Options":"nosniff"}


def string(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def number(value, default=0, low=-1_000_000, high=1_000_000):
    return value if type(value) in (int, float) and low <= value <= high and math.isfinite(value) else default


def media_path(root, ref, kind=None):
    try:
        path = ref_path(root, ref)
    except (ValueError, OSError):
        return None
    extensions = {"image":IMAGE_EXT, "video":VIDEO_EXT, "audio":AUDIO_EXT}.get(kind, IMAGE_EXT | VIDEO_EXT | AUDIO_EXT)
    return path if path.suffix.lower() in extensions and path.is_file() else None


def capture(board, root):
    nodes, media = [], {}

    def publish(ref, kind):
        if not isinstance(ref, str) or not media_path(root, ref, kind):
            return None
        return media.setdefault(ref, len(media))

    for n in board.get("nodes", []):
        if not isinstance(n,dict) or not isinstance(n.get("id"),str):
            continue
        kind = n.get("type")
        if kind not in ("text", "image", "video", "audio", "script"):
            continue
        item = {"id":n["id"], "type":kind, "name":string(n.get("name"),120),
                "x":number(n.get("x")), "y":number(n.get("y"))}
        data = n.get("data") if isinstance(n.get("data"),dict) else {}
        if kind == "text":
            item["text"] = string(data.get("text"),20_000)
            if data.get("text_format") == "markdown":
                item["text_format"] = "markdown"
        elif kind == "script":
            shots = []
            for shot in data.get("shots") or []:
                if not isinstance(shot, dict):
                    continue
                row = {field:string(shot.get(field),400) for field in ("shot_size","camera")}
                row["duration"] = number(shot.get("duration"),5,0,600)
                for field in ("action","dialogue"):
                    values = shot.get(field)
                    row[field] = [string(v,2000) for v in values[:50]] if isinstance(values,list) else []
                frame = shot.get("frame")
                if isinstance(frame,dict) and (index := publish(frame.get("ref"),"image")) is not None:
                    row["media"] = index
                shots.append(row)
            item["script"] = {"title":string(data.get("title"),400),"style":string(data.get("style"),1500),"shots":shots}
        else:
            versions, index = n.get("versions") or [], n.get("cur")
            if type(index) is int and 0 <= index < len(versions):
                v = versions[index]
                slot = publish(v.get("ref"),kind) if isinstance(v,dict) else None
                if slot is not None:
                    item.update(media=slot, w=number(v.get("w"),512,1,32768), h=number(v.get("h"),512,1,32768))
                    if kind in ("video", "audio"):
                        item["seconds"] = number(v.get("seconds"),0,0,86_400)
        nodes.append(item)

    ids = {n["id"] for n in nodes}
    current_media = {n["id"]:n.get("media") for n in nodes if n["type"] in ("audio","video")}
    edges = []
    for edge in board.get("edges", []):
        if not isinstance(edge,dict) or not all(isinstance(edge.get(k),str) and edge[k] in ids for k in ("from","to")):
            continue
        kept = {key:string(edge[key],80) for key in ("from","to","role","relation") if key in edge}
        if edge.get("relation") in PINNED_RELATIONS:
            index = current_media.get(edge["from"])
            ref = edge.get("source_ref" if edge["relation"] in SOURCE_RELATIONS else "ref")
            if index is None or not isinstance(ref, str) or media.get(ref) != index:
                continue
            kept["media_ref"] = index
            if edge.get("extension") in ("before","after"):
                kept["extension"] = edge["extension"]
            if edge.get("segment_edit") is True:
                kept["segment_edit"] = True
            for point in ("start","end"):
                if point in edge:
                    kept[point] = number(edge[point],0,0,86_400)
            if edge.get("relation") == "capture" and edge.get("at") is not None:
                kept["at"] = number(edge["at"],0,0,86_400)
        if "time" in edge:
            kept["time"] = number(edge["time"],0,0,86_400)
        edges.append(kept)
    return {"name":string(board.get("name"),120) or "未命名画布", "nodes":nodes, "edges":edges, "media":list(media)}


def ref_url(ref):
    return "/media?ref=" + quote(ref,safe="")


def explanation_context(snapshot):
    """Offer published structure and brief excerpts without media URLs or internal keys."""
    nodes, budget = [], 14000
    for raw in snapshot["nodes"][:60]:
        item = {k:raw[k] for k in ("id","type","name")}
        if raw["type"] == "text":
            item["excerpt"] = string(raw.get("text"),700)
        elif raw["type"] == "script":
            script = raw["script"]
            item["style"] = string(script.get("style"),400)
            item["shots"] = [{"shot_size":shot["shot_size"][:80],"camera":shot["camera"][:120],
                              "seconds":shot["duration"],"action":[text[:120] for text in shot["action"][:2]]}
                             for shot in script["shots"][:4]]
        elif "media" in raw:
            item.update(available=True,width=raw["w"],height=raw["h"])
            if "seconds" in raw:
                item["seconds"] = raw["seconds"]
        budget -= len(json.dumps(item,ensure_ascii=False))
        if budget < 0:
            break
        nodes.append(item)
    ids = {node["id"] for node in nodes}
    edges = [{k:e[k] for k in ("from","to","role","relation","time","start","end") if k in e}
             for e in snapshot["edges"] if e["from"] in ids and e["to"] in ids][:100]
    return {"name":snapshot["name"],"nodes":nodes,"edges":edges,
            "node_count":len(snapshot["nodes"]),"edge_count":len(snapshot["edges"])}


def copy_board(snapshot, user_id):
    media, nodes = snapshot["media"], []
    for raw in snapshot["nodes"]:
        kind = raw["type"]
        data, versions = {}, []
        if kind == "text":
            data["text"] = raw["text"]
            if raw.get("text_format") == "markdown":
                data["text_format"] = "markdown"
        elif kind == "script":
            script = raw["script"]
            data = {**script, "shots":[]}
            for shot in script["shots"]:
                row = {k:v for k,v in shot.items() if k != "media"}
                if "media" in shot:
                    row["frame"] = {"ref":media[shot["media"]]}
                data["shots"].append(row)
        elif "media" in raw:
            ref = media[raw["media"]]
            version = {"ref":ref, "url":ref_url(ref), "w":raw["w"],"h":raw["h"],"source":"import"}
            if kind in ("video", "audio") and raw.get("seconds"):
                version["seconds"] = raw["seconds"]
            versions.append(version)
        n = {k:raw[k] for k in ("id","name","type","x","y")}
        nodes.append({**n,"data":data,"versions":versions,"cur":0 if versions else -1,"job":None})
    seq = 1 + max((int(n["id"][1:]) for n in nodes if n["id"].startswith("n") and n["id"][1:].isascii() and n["id"][1:].isdigit()), default=0)
    edges = []
    for edge in snapshot["edges"]:
        copied = dict(edge)
        if "media_ref" in copied:
            ref_key = "source_ref" if copied.get("relation") in SOURCE_RELATIONS else "ref"
            copied[ref_key] = media[copied.pop("media_ref")]
        edges.append(copied)
    return {"name":snapshot["name"]+"（副本）","nodes":nodes,"edges":edges,"owner":user_id,
            "shared":False,"rev":1,"groups":[],"view":{"x":100,"y":76,"k":1},"seq":seq}
