"""Submit and finish preview, generation, and export jobs for video remakes."""
from __future__ import annotations

import copy
import json

from aiohttp import web

from oneshot.assistant.video_remake_tools import (
    apply_remake_action,
    mapped_remake,
    remake_source,
    remake_status,
)
from oneshot.editing import video_remake


async def preview_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key, session, mapping = mapped_remake(s, run, user, args)
    indices = [item["number"] - 1 for item in args["shots"]]
    if len(set(indices)) != len(indices) or any(index not in mapping["shots"] for index in indices):
        raise ValueError("请选择人物映射内的镜头，且每个镜头只提交一次")

    requests, needs_selection, kept = [], [], []
    for index, item in zip(indices, args["shots"]):
        shot = session["shots"][index]
        frame_key = video_remake.start_preview_key(shot, mapping)
        if shot.get("keep_original"):
            kept.append(index)
        elif not frame_key or not video_remake.person_selection(shot["frames"][frame_key], mapping):
            needs_selection.append(index)
        else:
            requests.append({"shot": index, "frame": frame_key, "view": item.get("view", "main"),
                             "note": item.get("note", "")})

    outcome = {"submitted": [], "skipped": [], "failed": []}
    if requests:
        await s.begin_generation(run,cid,"image",len(requests),{"label":"换角预览","node":nid,"args":args,"shots":requests})
        session = await apply_remake_action(s, user, nid, key, {
            "action": "batch_previews", "person": args["person"], "asset": args["asset_id"],
            "shots": requests, "cut_revision": args["cut_revision"],
        })
        outcome = session["batch_previews"]
        if outcome["skipped"]:
            run["data"]["generated"] -= len(outcome["skipped"])
            s.update(run)

    result = remake_status(s.host, nid, key, session)
    submitted = outcome["submitted"]
    result["preview"] = {
        "submitted": [index + 1 for index in submitted],
        "skipped": [index + 1 for index in sorted(kept + outcome["skipped"])],
        "needs_selection": [index + 1 for index in needs_selection],
        "failed": [{"shot": item["shot"] + 1, "error": item["error"]} for item in outcome["failed"]],
    }
    targets = submitted or needs_selection or outcome["skipped"]
    if targets:
        index = targets[0]
        result["remake"].update(shot_number=index + 1, shot_start=session["shots"][index]["start"])
        frame = video_remake.start_preview_key(session["shots"][index], mapping)
        if frame:
            result["remake"]["frame"] = frame
    result["text"] = f"已提交 {len(submitted)} 个镜头的换角预览。"
    if needs_selection:
        result["text"] += f"另有 {len(needs_selection)} 个镜头需要先确认选区。"
    if outcome["failed"]:
        result["text"] += f"{len(outcome['failed'])} 个镜头提交失败。"
    if submitted:
        frames_by_shot = {item["shot"]: item["frame"] for item in requests}
        targets = []
        for index in submitted:
            frame = frames_by_shot[index]
            job = session["shots"][index]["frames"][frame]["previews"][-1]["job"]
            targets.append({"shot": index, "frame": frame, "job": job})
        return await wait_remake_generation(s, run, user, cid, key, nid, "preview", targets, result["preview"])
    return result


async def generate_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key, session, mapping = mapped_remake(s, run, user, args)
    index = args["shot"] - 1
    if index not in mapping["shots"]:
        raise ValueError("请选择人物映射内的镜头")
    shot = session["shots"][index]
    if shot.get("keep_original"):
        raise ValueError("此镜头已设为保留原片，请在工作区核对")
    video_remake.update_jobs(s.host, user["id"], session)
    motion_provider = args.get("motion_provider")
    try:
        fps = s.host.film.FPS
        ref, approved, entry_tick = video_remake.shot_start(shot, mapping, fps)
        guides = video_remake.shot_guides(shot, approved, fps, mapping, entry_tick)
        if motion_provider:
            if not any(p["id"] == motion_provider for p in video_remake.motion_providers(s.host)):
                raise ValueError("所选视频服务未配置深度参考，请重新读取视频重制状态")
            ticks = round(shot["end"] * fps) - round(shot["start"] * fps)
            video_remake.depth_motion(user, s.host, key, shot, ref, shot["frames"]["first"], ticks, entry_tick, guides)
    except web.HTTPException as error:
        raise ValueError(json.loads(error.text)["error"]) from None
    if approved["job"] != args["first_job"]:
        raise ValueError("已采用的起始帧已变更，请重新读取视频重制状态")
    await s.begin_generation(run,cid,"video",1,{"label":f"重制镜头 {index+1}","node":nid,"args":args,
                                              "ref":ref,"duration":shot["end"]-shot["start"],"provider":motion_provider})
    if motion_provider:
        session = await apply_remake_action(s, user, nid, key, {
            "action":"generate_depth_video", "shot":index, "first_job":approved["job"], "provider":motion_provider,
            "motion":args.get("motion", ""), "cut_revision":args["cut_revision"],
        })
        job = session["shots"][index]["videos"][-1]["job"]
        return await wait_remake_generation(s, run, user, cid, key, nid, "video",
                                            [{"shot":index,"job":job}], {"shot":index + 1,"submitted":True})
    session = await apply_remake_action(s, user, nid, key, {
        "action": "batch_videos", "person": mapping["source"], "asset": mapping["asset"],
        "shots": [{"shot": index, "first_job": approved["job"], "motion": args.get("motion", "")}],
        "cut_revision": args["cut_revision"],
    })
    outcome = session["batch_videos"]
    if outcome["skipped"]:
        run["data"]["generated_video"] -= 1
        s.update(run)
    result = remake_status(s.host, nid, key, session)
    result["remake"].update(shot_number=index + 1, shot_start=shot["start"])
    result["video"] = {"shot": index + 1, "submitted": bool(outcome["submitted"])}
    if outcome["submitted"]:
        job = session["shots"][index]["videos"][-1]["job"]
        return await wait_remake_generation(s, run, user, cid, key, nid, "video",
                                            [{"shot": index, "job": job}], result["video"])
    elif outcome["failed"]:
        result["video"]["error"] = outcome["failed"][0]["error"]
        result["text"] = f"镜头 {index + 1} 提交失败。{result['video']['error']}"
    else:
        result["text"] = f"镜头 {index + 1} 正在处理或已有匹配的视频版本。"
    return result


async def wait_remake_generation(s, run, user, cid, key, nid, kind, targets, outcome):
    return await s.wait_submitted_jobs(run, user, cid, {
        "ids": [target["job"] for target in targets],
        "remake_generation": {"key": key, "node_id": nid, "kind": kind, "targets": targets, "outcome": outcome},
    })


def finish_remake_generation(s, run, user, info, states):
    key = authorized_remake_key(s, run, user, info)
    session = video_remake.load(key)
    result = remake_status(s.host, info["node_id"], key, session)
    kind = info["kind"]
    outcome = copy.deepcopy(info["outcome"])
    completed = []
    failed = outcome.setdefault("failed", [])
    shots = (session or {}).get("shots", [])
    for target in info["targets"]:
        index, job = target["shot"], target["job"]
        shot = shots[index] if index < len(shots) else {}
        frame = shot.get("frames", {}).get(target.get("frame"), {})
        versions = frame.get("previews", []) if kind == "preview" else shot.get("videos", [])
        if video_remake.completed(versions, job):
            completed.append(target)
        else:
            failed.append({"shot": index + 1, "error": states[job].get("error") or "画面或剪辑点已更新，请在重制工作区核对"})
    result[kind] = outcome
    outcome["completed"] = [item["shot"] + 1 for item in completed] if kind == "preview" else bool(completed)
    if completed:
        target = completed[0]
        index = target["shot"]
        result["remake"].update(shot_number=index + 1, shot_start=shots[index]["start"])
        if kind == "preview":
            result["remake"].update(frame=target["frame"], preview_job=target["job"])
        else:
            result["remake"]["video_job"] = target["job"]
        result["text"] = f"{len(completed)} 个换角预览已生成，可打开审核。" if kind == "preview" else f"镜头 {index + 1} 的重制视频已生成，可打开审核。"
        if failed:
            result["text"] += f"另有 {len(failed)} 个镜头待处理。"
    else:
        result["error"] = failed[0]["error"]
    return result


async def export_remake(s, run, user, cid, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        raise ValueError("请先分析原片")
    if args["cut_revision"] != session.get("cut_revision", 0):
        raise ValueError("剪辑点已更新，请重新读取视频重制状态")
    result = remake_status(s.host, nid, key, session)
    export = session.get("export") or {}
    if export.get("state") in ("queued", "running"):
        return await s.wait_submitted_jobs(run, user, cid, {
            "ids": [export["job"]], "remake_export": {"key": key, "node_id": nid}, "cancel_on_stop": False,
        })
    unresolved = next((shot for shot in result["shots"] if shot["review_issue"]), None)
    if unresolved:
        number = unresolved["number"]
        result["remake"].update(shot_number=number, shot_start=unresolved["start"])
        result["text"] = f"镜头 {number} {unresolved['review_issue']}"
        return result
    if not result["can_export"]:
        result["text"] = "请先采用至少一个重制镜头。"
        return result
    if result["export_ref"] and not args.get("rebuild"):
        result["text"] = "当前审核版本的成片已就绪，可直接下载。"
        return result
    session = await apply_remake_action(s, user, nid, key, {"action": "export", "cut_revision": args["cut_revision"]})
    return await s.wait_submitted_jobs(run, user, cid, {
        "ids": [session["export"]["job"]], "remake_export": {"key": key, "node_id": nid},
    })


def authorized_remake_key(s, run, user, info):
    key = tuple(info["key"])
    if key[:2] != (user["id"], run["board_id"]):
        raise ValueError("无权读取该视频重制任务")
    s.board(user, key[1])
    return key


def finish_remake_export(s, run, user, pending, state):
    info = pending["remake_export"]
    key = authorized_remake_key(s, run, user, info)
    session = video_remake.load(key)
    result = remake_status(s.host, info["node_id"], key, session)
    if state["state"] == "error":
        result.pop("export_ref", None)
        result["error"] = state.get("error") or "成片合成失败"
    elif ((session or {}).get("export") or {}).get("job") != pending["ids"][0] or result.get("export_state") == "stale":
        result.pop("export_ref", None)
        result["text"] = "当前审核内容或成片任务已更新，请打开重制工作区。"
    elif result.get("export_ref"):
        result["text"] = "成片已合成并保留原声，可直接下载。"
    else:
        result["error"] = "成片文件暂不可用，可在重制工作区重新合成。"
    return result
