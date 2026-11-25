"""Determine approved shot starts, guides, and readiness."""
from __future__ import annotations

from oneshot.editing.remake_regions import person_absent, person_selection
from oneshot.editing.remake_state import completed, matches_mapping
from oneshot.memory.creative_memory import fail


def correction_frames(shot):
    return sorted((f for f in shot["frames"].values() if "correction_tick" in f), key=lambda f: f["correction_tick"])


def start_preview_key(shot, mapping):
    frames = shot["frames"]
    if not person_absent(frames["first"], mapping):
        return "first"
    eligible = (key for key, frame in frames.items()
                if "correction_tick" in frame and person_selection(frame, mapping))
    return min(eligible, key=lambda key: frames[key]["correction_tick"], default=None)


def preview_matches_regions(frame, preview, mapping):
    selection = person_selection(frame, mapping)
    return ((not selection or selection["mask"] == preview.get("mask")) and
            frame.get("protection", {}).get("mask") == preview.get("protection"))


def shot_start(shot, mapping, fps):
    first = shot["frames"]["first"]
    if person_absent(first, mapping):
        entry = shot["frames"].get(start_preview_key(shot, mapping))
        if entry:
            approved = completed(entry["previews"], entry.get("approved"))
            if approved and matches_mapping(approved, mapping):
                if not preview_matches_regions(entry, approved, mapping):
                    fail("入画帧选区已更新，请重新生成并采用预览", 409)
                return first["ref"], approved, entry["correction_tick"] - round(shot["start"] * fps)
        fail("请在人物首次入画的校正帧中选中人物，生成预览并用作动作关键帧")
    approved = completed(first["previews"], first.get("approved"))
    if not approved:
        fail("请先采用这个镜头的首帧预览")
    if not matches_mapping(approved, mapping):
        fail("首帧属于之前的人物映射，请重新生成并采用首帧")
    if not preview_matches_regions(first, approved, mapping):
        fail("首帧选区已更新，请重新生成并采用预览", 409)
    return approved["ref"], approved, 0


def shot_guides(shot, approved, fps, mapping=None, entry_tick=0):
    start_tick = round(shot["start"] * fps)
    guides = []
    for frame in correction_frames(shot):
        tick = frame["correction_tick"] - start_tick
        if tick < entry_tick or person_absent(frame, mapping):
            continue
        preview = completed(frame["previews"], frame.get("approved"))
        if (preview and preview["asset"]["id"] == approved["asset"]["id"] and
                preview.get("source_person") == approved.get("source_person")):
            if not preview_matches_regions(frame, preview, mapping):
                fail(f"{frame['correction_tick'] / fps:.2f} 秒的动作关键帧选区已更新，请重新生成预览或取消此关键帧", 409)
            guides.append({"tick": tick, "ref": preview["ref"]})
    return guides


def video_start_issue(shot, version, mapping):
    if version.get("mode") == "combined":
        return None if shot.get("role_layers") == version.get("roles") else "角色情况已更新，请重新合成并审核"
    first = shot["frames"]["first"]
    person = version.get("source_person")
    role_frame = first.get("role_states", {}).get(person, first)
    starts_absent = person_absent(role_frame, {"source":person} if person else mapping)
    if starts_absent != bool(version.get("entry_tick")):
        return "首帧出画标记已变更，请重新生成并审核镜头视频"
    if starts_absent and version.get("mode") != "local":
        return "请先做局部合成以保留开头原片，再采用此镜头"
    return None
