"""Report downstream canvas and remake use of versioned assets."""
from __future__ import annotations

from aiohttp import web

from oneshot.memory.memory_http import store
from oneshot.memory.memory_values import CHARACTER_VIEWS, fail
from oneshot.storage import db


async def asset_impact(req):
    s = store(req)
    user, bid = req["user"], req.query.get("board")
    if not bid:
        fail("请选择画布")
    asset = s.get(user, req.match_info["mid"], bid)
    board = s.board(user, bid)
    projects = [(bid, board)]
    if req.query.get("all") == "1":
        for path in s.h.BOARDS.glob("*.json"):
            if path.stem == bid:
                continue
            other = s.h.board_meta(path)
            if other and s.h.can_see(user, other):
                projects.append((path.stem, other))
    result = {"canvas":[], "remake":[]}
    for project, data in projects:
        affected, remakes = impact_on_board(s, user, asset, project, data)
        result["canvas"].extend(affected)
        result["remake"].extend(remakes)
    return web.json_response(result)


def impact_on_board(s, user, asset, bid, board):
    from oneshot.editing import video_remake

    project = {"board":bid, "project":board.get("name") or bid}
    usable = s.visible(asset, user, bid, s.project(user, bid))
    views = {"main": asset.get("ref"), **asset.get("character_views", {})}
    bundle = asset.get("generation_media") or asset.get("generation_images")
    nodes = board.get("nodes", [])
    affected = []
    for node in nodes:
        for i, version in enumerate(node.get("versions", [])):
            saved = version.get("memory_used")
            used = next((m for m in saved if isinstance(m, dict) and m.get("id") == asset["id"]), None) if isinstance(saved, list) else None
            if not used:
                continue
            changed = []
            references = used.get("references")
            for entry in references if isinstance(references, list) and references else [{"ref":used.get("ref")}]:
                if not isinstance(entry, dict):
                    continue
                slot, previous = entry.get("view"), entry.get("ref")
                if slot is not None and (not isinstance(slot, str) or slot not in CHARACTER_VIEWS):
                    continue
                current = views.get(slot or "main")
                if slot is None and bundle:
                    current = previous if previous in bundle else None
                if isinstance(previous, str) and previous and previous != current:
                    changed.append({"view":slot,"previous":previous,"reference":current})
            if changed:
                affected.append({**project,"node":node["id"], "name":node["name"], "ref":version["ref"],
                                 "version":i + 1, "views":changed})
    remakes = []
    for row in db.q("SELECT node,source FROM video_remakes WHERE board=? AND owner=?", bid, user["id"]):
        target = next((n for n in nodes if n.get("type") == "video" and any(
            v.get("ref") == row["source"] and (n["id"] == row["node"] or row["node"] in (v.get("tab_nodes") or []))
            for v in n.get("versions", [])
        )), None)
        if not target:
            continue
        session = video_remake.load((user["id"], bid, row["node"], row["source"]))
        mapping = session.get("mapping")
        for i, shot in enumerate(session.get("shots", [])):
            adopted = video_remake.completed(shot.get("videos", []), shot.get("adopted_video"))
            current = list(adopted.get("roles") or [adopted]) if adopted else []
            current.extend(shot.get("role_layers", []))
            current.extend(preview for frame in shot["frames"].values()
                           if (preview := video_remake.completed(frame["previews"], frame.get("approved"))))
            previous = next((v["asset"] for v in current if v.get("asset", {}).get("id") == asset["id"]
                             and (ref := views.get(v["asset"].get("view", "main"))) and ref != v["asset"].get("ref")), None)
            if not previous:
                continue
            view = previous.get("view", "main")
            frame = video_remake.start_preview_key(shot, mapping)
            ready = bool(usable and mapping and mapping["asset"] == asset["id"]
                         and i in mapping["shots"] and not shot.get("keep_original")
                         and frame and video_remake.person_selection(shot["frames"][frame], mapping))
            remakes.append({**project,"node":target["id"],"name":target["name"],"ref":row["source"], "shot":i, "start":shot["start"],
                            "revision":session.get("cut_revision", 0), "person":mapping["source"] if ready else None,
                            "frame":frame, "view":view, "reference":views[view], "previous":previous["ref"]})
    return affected, remakes
