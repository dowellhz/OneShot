"""Storage and validation for OneShot's JSON boards."""
from __future__ import annotations

import json
import math
import re
import uuid
from copy import deepcopy
from pathlib import Path

from aiohttp import web

import db
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


def seed_audio_edges(board):
    nodes = {n["id"]:n for n in board.get("nodes",[]) if isinstance(n,dict) and isinstance(n.get("id"),str)}
    edges = [e for e in board.get("edges",[]) if isinstance(e,dict) and e.get("relation")!="seed_audio_ref"]
    for target in nodes.values():
        data = target.get("data")
        if target.get("type")!="audio" or not isinstance(data,dict) or data.get("mode")!="seed_audio":
            continue
        refs = data.get("references")
        if not isinstance(refs,list):
            continue
        seen = set()
        valid_refs = [item for item in refs if isinstance(item,dict) and isinstance(item.get("node_id"),str)
                      and isinstance(item.get("ref"),str) and item.get("kind") in ("image","audio")]
        for slot,item in enumerate(valid_refs[:3],1):
            ref = item["ref"]
            source = nodes.get(item["node_id"])
            if not ref or ref in seen or not source or source is target or source.get("type")!=item["kind"]:
                continue
            versions = source.get("versions")
            if not isinstance(versions,list) or not any(isinstance(v,dict) and v.get("ref")==ref for v in versions):
                continue
            seen.add(ref)
            edges.append({"from":source["id"],"to":target["id"],"relation":"seed_audio_ref","ref":ref,"slot":slot})
    return edges


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


def access_role(u: dict, b: dict) -> str | None:
    if u["role"] == "admin" or b.get("owner") in (None, u["id"]):
        return "owner"
    members = b.get("collaborators")
    role = members.get(str(u["id"])) if isinstance(members, dict) else None
    if role in ("reviewer", "editor"):
        return role
    team = b.get("team")
    if isinstance(team,str) and team:
        return "editor" if db.one("""SELECT 1 FROM canvas_team_members WHERE team_id=? AND user_id=?""",team,u["id"]) else None
    return "editor" if b.get("shared") else None


def can_see(u: dict, b: dict) -> bool:
    return access_role(u, b) is not None


def can_edit(u: dict, b: dict) -> bool:
    return access_role(u, b) in ("owner", "editor")


def prune_seed_audio_refs(data, keep):
    if not isinstance(data,dict) or data.get("mode")!="seed_audio" or not isinstance(data.get("references"),list):
        return 0
    refs, numbers = [], {}
    for index,item in enumerate(data["references"],1):
        if not isinstance(item,dict) or not keep(item):
            continue
        refs.append(item)
        if item.get("kind")=="audio":
            numbers[str(index)] = f"@音频{len(refs)}"
    removed = len(data["references"]) - len(refs)
    if removed:
        data["references"] = refs
        if isinstance(data.get("prompt"),str):
            data["prompt"] = re.sub(r"@音频([0-9]+)", lambda m: numbers.get(m[1].lstrip("0"),""),data["prompt"])
    return removed


def template_upstream_nodes(board, nodes, selected):
    upstream = {}

    def connect(target, source):
        if isinstance(source,str) and source in nodes:
            upstream.setdefault(target,set()).add(source)

    for edge in board.get("edges", []):
        target = edge.get("to")
        if isinstance(target,str) and target in nodes:
            connect(target, edge.get("from"))
    for target, node in nodes.items():
        recipes = [node.get("data")]
        for version in node.get("versions", []):
            edges = version.get("input_edges")
            if isinstance(edges,list):
                for edge in edges:
                    if isinstance(edge,dict):
                        connect(target, edge.get("from"))
            recipes.append(version.get("audio_recipe"))
        for recipe in recipes:
            if isinstance(recipe,dict) and recipe.get("mode")=="seed_audio" and isinstance(recipe.get("references"),list):
                for item in recipe["references"]:
                    if isinstance(item,dict):
                        connect(target,item.get("node_id"))

    included = set(selected)
    pending = list(included)
    while pending:
        unseen = upstream.get(pending.pop(),set()) - included
        included.update(unseen)
        pending.extend(unseen)
    return included


def workflow_template(board, selected=None, include_upstream=False):
    """Copy the editable workflow while dropping permissions and running tasks."""
    snapshot = deepcopy({key:board[key] for key in ("nodes","edges","groups","seq","view","wiz") if key in board})
    nodes = {n["id"]:n for n in board["nodes"]}
    ids = set(nodes) if selected is None else set(selected)
    if include_upstream and selected is not None:
        ids = template_upstream_nodes(board,nodes,ids)

    def keep_edges(edges):
        return [e for e in edges if e.get("from") in ids and e.get("to") in ids]

    def clean_data(data):
        if not isinstance(data,dict):
            return
        if isinstance(data.get("made"),list):
            data["made"] = [{k:v for k,v in item.items() if k not in ("img","vid") or v in ids}
                            for item in data["made"] if item.get("img") in ids or item.get("vid") in ids]
            for item in data["made"]:
                if isinstance(item.get("motion_frames"),dict):
                    item["motion_frames"] = {phase:ref for phase,ref in item["motion_frames"].items()
                                             if isinstance(ref,str) and ref in ids}
        clean_timeline(data.get("film"))
        clean_audio_references(data)

    def clean_audio_references(data):
        prune_seed_audio_refs(data, lambda item: isinstance(item.get("node_id"),str) and item["node_id"] in ids)

    def clean_timeline(timeline):
        if not isinstance(timeline,dict):
            return
        script = timeline.get("story_script")
        if script is not None and (not isinstance(script, str) or script not in ids):
            timeline.pop("story_script", None)
        for item in timeline.get("cutaways") or []:
            if isinstance(item,dict):
                nid = item.get("node")
                if not isinstance(nid,str) or nid not in ids:
                    item.pop("node",None)
        for clip in timeline.get("clips") or []:
            if not isinstance(clip,dict):
                continue
            source = nodes.get(clip.get("node"))
            if source and not clip.get("ref"):
                versions, index = source.get("versions") or [], source.get("cur",-1)
                if type(index) is int and 0 <= index < len(versions):
                    version = versions[index]
                    clip.update(ref=version.get("ref"), media_seconds=version.get("seconds") or source.get("data",{}).get("duration",5))
            clip.pop("remake_shot",None)

    snapshot["nodes"] = [n for n in snapshot["nodes"] if n["id"] in ids]
    snapshot["edges"] = keep_edges(snapshot.get("edges",[]))
    groups = [{**g,"nodes":[nid for nid in g["nodes"] if nid in ids]} for g in snapshot.get("groups",[])]
    snapshot["groups"] = [g for g in groups if len(g["nodes"])>1]
    if selected is not None:
        snapshot.pop("wiz",None)
    for node in snapshot.get("nodes", []):
        node["job"] = None
        for key in ("agent_call","agent_error","agent_pending"):
            node.pop(key,None)
        clean_data(node.get("data"))
        for version in node.get("versions",[]):
            clean_audio_references(version.get("audio_recipe"))
            if isinstance(version.get("input_edges"),list):
                version["input_edges"] = keep_edges(version["input_edges"])
            origin = version.get("copied_from")
            if isinstance(origin,dict) and (not isinstance(origin.get("node"),str) or origin["node"] not in ids):
                origin.pop("node",None)
            draft = version.get("draft_final")
            if isinstance(draft,dict) and (not isinstance(draft.get("source_node"),str) or draft["source_node"] not in ids):
                draft.pop("source_node",None)
            for record, field, key in (("generation_record","inputs","node_id"), ("film_recipe","clips","node"),
                                       ("film_recipe","cutaways","node")):
                recipe = version.get(record)
                if isinstance(recipe, dict) and isinstance(recipe.get(field), list):
                    for entry in recipe[field]:
                        if isinstance(entry, dict):
                            nid = entry.get(key)
                            if not isinstance(nid, str) or nid not in ids:
                                entry.pop(key, None)
            clean_data(version.get("node_data"))
            if isinstance(version.get("film_recipe"), dict):
                clean_timeline(version["film_recipe"].get("timeline"))
    snapshot["edges"] = seed_audio_edges(snapshot)
    return snapshot


def write_board(path: Path, data: dict):
    """Atomically replace a board so readers see a complete revision."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
