"""Read and apply pinned object editing settings."""
from __future__ import annotations

from aiohttp import web

from oneshot.assistant.video_reference_inputs import reference_version, video_node
from oneshot.assistant.video_reference_plan import video_edit_snapshot
from oneshot.editing import object_edit


def read_object_settings(s, run, user, args):
    board, node = video_node(s, run, user, args["node_id"])
    current, recipe, data, incoming = video_edit_snapshot(s,run,board,node,args.get("version"))
    plan = data.get("object_edit") or recipe.get("object_edit")
    source_edge = next((e for e in incoming if e.get("relation")=="video_ref" and e.get("segment_edit")), None)
    if not plan or source_edge is None:
        raise ValueError("这个视频版本没有已保存的物体选区，请先在画布框选并创建物体编辑节点")
    source, _ = reference_version(s,run,user,edge=source_edge,kind="clip")
    source.update({key:source_edge[key] for key in ("start","end") if key in source_edge})
    return {"node_id":node["id"],"version":next((i for i,v in enumerate(node.get("versions",[]),1) if v is current),None),
            "source":source,"object_edit":object_edit.validate(plan),"text":"已读取原片范围、框选和替换参考。"}


def object_replacement(s, run, user, selection):
    nid, mid, index = selection.get("node_id"), selection.get("memory_id"), selection.get("version")
    if bool(nid) == bool(mid) or (mid and index is not None):
        raise ValueError("请选择一个图片节点及版本，或一项资产")
    if mid:
        try:
            asset = s.app["creative_memory"].get(user,mid,run["board_id"])
        except web.HTTPException:
            raise ValueError("该参考资产不存在或不可访问") from None
        ref, label = asset.get("ref"), asset.get("name")
    elif index is None:
        node, version = s.source(run,user,nid)
        ref, label = version["ref"], node.get("name")
    else:
        board = s.board(user,run["board_id"])
        node = next((n for n in board["nodes"] if n["id"]==nid and n["type"]=="image"),None)
        versions = node.get("versions",[]) if node else []
        if not 1 <= index <= len(versions):
            raise ValueError("所选参考图版本已移除")
        ref, label = versions[index-1]["ref"], node.get("name")
    if not ref or not ref.lower().endswith((".png",".jpg",".jpeg",".webp")):
        raise ValueError("替换参考须为图片")
    return {"replacement_ref":ref,"replacement_name":label}


def update_object_plan(s, run, user, plan, changes):
    merged = {**(plan or {}), **{key:changes[key] for key in ("action","at","box") if key in changes}}
    if "replacement" in changes:
        if changes.get("action") == "remove":
            raise ValueError("移除物体无需指定替换参考")
        merged.update(action="replace",**object_replacement(s,run,user,changes["replacement"]))
    return object_edit.validate(merged)
