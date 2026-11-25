"""Resolve individual pinned image and video input versions."""
from __future__ import annotations




def video_node(s, run, user, nid, *, allow_film=False):
    b = s.board(user, run["board_id"])
    n = next((n for n in b.get("nodes", []) if n["id"] == nid), None)
    if not n or n.get("type") != "video":
        raise ValueError("视频节点已不存在，请重新读取画布")
    if not allow_film and n.get("data", {}).get("film"):
        raise ValueError("这是剪辑成片，请使用原始镜头视频重新生成")
    return b, n


def reference_slot(record):
    slot = (record or {}).get("prompt_slot")
    return {"prompt_slot":slot} if type(slot) is int and slot>0 else {}


def image_reference(image):
    slot = reference_slot(image)
    ref = image.get("ref")
    return {**slot, "ref":ref} if ref and (slot or image.get("pinned") is True) else slot


def reference_version(s, run, user, selection=None, edge=None, *, kind="video"):
    nid = selection["node_id"] if selection else edge["from"]
    if kind != "audio":
        _, node = video_node(s, run, user, nid, allow_film=kind=="clip")
    else:
        board = s.board(user, run["board_id"])
        node = next((n for n in board["nodes"] if n["id"] == nid and n["type"] == "audio"), None)
        if node is None:
            raise ValueError("音频节点已不存在")
    versions = node.get("versions", [])
    if selection and "version" in selection:
        index = selection["version"] - 1
    elif edge or (nid in run["data"].get("bindings", {})):
        ref = edge.get("ref") if edge else run["data"]["bindings"][nid]
        index = next((i for i, v in enumerate(versions) if v.get("ref") == ref), -1)
    else:
        index = node.get("cur", -1)
    if not 0 <= index < len(versions) or (kind == "video" and versions[index].get("source") != "previs"):
        raise ValueError({"video":"请选择已渲染的白模 Tab", "clip":"请选择仍存在的视频版本", "audio":"请选择仍存在的音频版本"}[kind])
    version = versions[index]
    return {"node_id":nid, "ref":version["ref"], "name":node.get("name"), "version":index + 1, **reference_slot(edge)}, version
