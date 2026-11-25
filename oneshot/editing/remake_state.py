"""Store pinned video remake sessions, shots, mappings, and job receipts."""
from __future__ import annotations

from pathlib import Path
import json

from oneshot.editing.remake_reference_assets import role_reference
from oneshot.generation.tools import VIDEO_EXT
from oneshot.memory.creative_memory import IMAGE_EXT
from oneshot.memory.creative_memory import fail
from oneshot.storage import db


MAX_SECONDS = 60
MAX_SHOT_SECONDS = 14
MAX_SHOTS = 12
MAX_PREVIEWS = 20
MAX_CORRECTIONS = 8
CUT_ACTIONS = ("split_shot", "split_long_shot", "move_cut", "merge_shots", "undo_cut")


_writes = set()


def original_video(host, user, board_id, node_id, source):
    board = host.board_meta(host.board_path(board_id))
    if not board or not host.can_see(user, board):
        fail("画布不存在或不可访问", 404)
    node = next((n for n in board.get("nodes", []) if n["id"] == node_id and n["type"] == "video"), None)
    if not isinstance(source, str) or not node:
        fail("原片版本已不存在，请重新打开视频节点", 404)
    versions = node.get("versions", [])
    matches = [v for v in versions if v.get("ref") == source]
    if not matches:
        fail("原片版本已不存在，请重新打开视频节点", 404)
    selected = node.get("cur")
    if type(selected) is int and 0 <= selected < len(versions) and versions[selected].get("ref") == source:
        return versions[selected]
    return matches[0]


def remake_key(host, user, board, node, source):
    version = original_video(host, user, board, node, source)
    lineage = version.get("tab_nodes")
    lineage = [item for item in lineage if isinstance(item, str) and item] if isinstance(lineage, list) else []
    if not lineage:
        return (user["id"], board, node, source)
    existing = {row["node"] for row in db.q(
        "SELECT node FROM video_remakes WHERE owner=? AND board=? AND source=?", user["id"], board, source,
    )}
    # A moved tab reuses the most recent existing session in its own source lineage.
    location = next((item for item in [node, *reversed(lineage)] if item in existing), lineage[0])
    return (user["id"], board, location, source)


def load(key):
    row = db.one("SELECT data FROM video_remakes WHERE owner=? AND board=? AND node=? AND source=?", *key)
    if not row:
        return None
    session = json.loads(row["data"])
    if session.get("warning"):
        for shot in [*session["shots"], *session.get("cut_archive", {}).values()]:
            shot.setdefault("analysis_missing", not any(shot.get("summary", {}).values()))
    return session


def save(key, session):
    db.run("""INSERT INTO video_remakes VALUES(?,?,?,?,?)
              ON CONFLICT(owner, board, node, source) DO UPDATE SET data=excluded.data""",
           *key, json.dumps(session, ensure_ascii=False, allow_nan=False))


def job_status(host, owner, job_id):
    live = host.JOBS.get(job_id)
    if live:
        exports = [o.get("ref") for o in live.get("outputs") or []]
        return live.get("state"), exports, live.get("error")
    task = db.one("SELECT state,outputs,error FROM tasks WHERE id=? AND user_id=?", job_id, owner)
    if task:
        return task["state"], json.loads(task["outputs"] or "[]"), task["error"]
    return "queued", [], None


def sync_job(host, owner, record, extensions):
    if record.get("state") in ("done", "error"):
        return
    state, refs, error = job_status(host, owner, record["job"])
    record["state"] = state or "queued"
    if state == "done":
        ref = next((r for r in refs if isinstance(r, str) and Path(r).suffix.lower() in extensions), "")
        if ref:
            record["ref"] = ref
        else:
            record.update(state="error", error="任务没有返回所需的媒体文件")
    elif state == "error":
        record["error"] = error or "生成失败"


def update_jobs(host, owner, session):
    for shot in session["shots"]:
        for frame in shot["frames"].values():
            for preview in frame["previews"]:
                sync_job(host, owner, preview, IMAGE_EXT)
        for video in shot.get("videos", []):
            sync_job(host, owner, video, VIDEO_EXT)
        if depth := shot.get("depth"):
            sync_job(host, owner, depth, VIDEO_EXT)
            if depth["state"] == "done" and not host.tools.ref_path(host.COMFY_DIR, depth["ref"]).is_file():
                depth.update(state="error", error="深度参考文件已丢失，请重新生成")
                depth.pop("ref", None)
    if session.get("export"):
        sync_job(host, owner, session["export"], VIDEO_EXT)
    if session.get("playback"):
        sync_job(host, owner, session["playback"], VIDEO_EXT)


def completed(versions, job):
    return next((v for v in versions if v["job"] == job and v["state"] == "done" and v.get("ref")), None)


def pending(versions):
    return any(item["state"] not in ("done", "error") for item in versions)


def frame_record(ref, dimensions):
    return {"ref": ref, "w": dimensions[0], "h": dimensions[1], "previews": []}


def mapped_shots(session):
    mapping = session.get("mapping")
    return set(mapping["shots"]) if mapping else None


def matches_mapping(version, mapping):
    if not mapping:
        return True
    roles = version.get("roles") or [version]
    return any(role.get("asset", {}).get("id") == mapping["asset"] and role.get("source_person") == mapping["source"]
               for role in roles)


def set_mapping(req, board, session, data):
    source = data.get("person")
    shots = data.get("shots")
    look = data.get("look", "")
    if not isinstance(source, str) or not source.strip() or len(source.strip()) > 60:
        fail("请选择或填写原片人物")
    if (not isinstance(shots, list) or not shots or
            any(type(index) is not int or not 0 <= index < len(session["shots"]) for index in shots)):
        fail("请勾选已确认出现该人物的镜头")
    if not isinstance(look, str) or len(look.strip()) > 240:
        fail("原片外貌提示限 240 字以内")
    asset, _, _ = role_reference(req, board, {**data, "view": "main"})
    source = source.strip()
    activate_role_frames(session, source)
    session["mapping"] = {"source": source, "asset": asset["id"],
                          "asset_name": asset["name"], "shots": sorted(set(shots)), "look": look.strip()}


def activate_role_frames(session, source):
    previous = session.get("mapping", {}).get("source")
    if previous != source:
        fields = ("selection", "protection", "person_absent", "person_hint", "approved")
        for shot in session["shots"]:
            for frame in shot["frames"].values():
                stored = frame.get("role_states", {})
                frame_owner = (previous or (frame.get("selection") or {}).get("source_person")
                               or (frame.get("person_absent") or {}).get("source")
                               or (frame.get("person_hint") or {}).get("source"))
                if frame_owner and frame_owner == source:
                    continue
                if frame_owner:
                    stored[frame_owner] = {key:frame.pop(key) for key in fields if key in frame}
                    frame["role_states"] = stored
                elif stored:
                    for key in fields:
                        frame.pop(key, None)
                frame.update(stored.pop(source, {}))


def person_appearance(session, mapping):
    if not mapping:
        return ""
    return mapping.get("look") or next((p["look"] for p in session.get("source_people", [])
                                         if p["name"] == mapping["source"]), "")


def submitted_job(response):
    ids = json.loads(response.body).get("ids") or []
    if not ids:
        fail("服务未返回任务编号")
    return {"job": ids[0], "state": "queued"}
