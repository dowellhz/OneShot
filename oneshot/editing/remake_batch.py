"""Submit batches of pinned character previews and record plan receipts."""
from __future__ import annotations

import json

from aiohttp import web

from oneshot.editing.remake_reference_assets import VIEWS, role_reference
from oneshot.editing.remake_regions import person_selection
from oneshot.editing.remake_shot_plan import start_preview_key
from oneshot.editing.remake_state import (
    MAX_SHOTS,
    mapped_shots,
    save,
    set_mapping,
)
from oneshot.editing.remake_submission import queue_one_shot
from oneshot.memory.creative_memory import fail


async def queue_shots(req, host, key, session, data):
    mapping = session.get("mapping")
    if not mapping or data.get("asset") != mapping["asset"] or data.get("person") != mapping["source"]:
        fail("人物映射已更新，请核对后重新提交", 409)
    requests = data.get("shots")
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_SHOTS:
        fail("请选择要批量生成的镜头")
    inputs = {}
    previews_only = data["action"] == "batch_previews"
    scope = mapped_shots(session)
    for item in requests:
        index = item.get("shot") if isinstance(item, dict) else None
        if type(index) is not int or index not in scope or index in inputs:
            fail("批量生成的镜头必须在人物映射范围内，且不可重复")
        if previews_only:
            view = item.get("view", "main")
            if not isinstance(view, str) or view not in VIEWS:
                fail("镜头参考角度无效")
            note = item.get("note", "")
            if not isinstance(note, str):
                fail("镜头修改要求格式不正确")
            frame_key = item.get("frame", "first")
            if not isinstance(frame_key, str):
                fail("预览画面格式不正确")
            reference = item.get("reference")
            if reference is not None and not isinstance(reference, str):
                fail("角色参考图格式不正确")
            inputs[index] = {"asset":mapping["asset"], "view":view, "note":note[:800], "frame":frame_key,
                             "reference":reference}
        else:
            motion, first_job = item.get("motion", ""), item.get("first_job")
            if not isinstance(motion, str) or not isinstance(first_job, str) or not first_job:
                fail("请提供已采用的首帧和有效的动作说明")
            inputs[index] = {"motion":motion[:1600], "first_job":first_job}

    outcome = {"submitted": [], "skipped": [], "failed": []}
    for index, params in inputs.items():
        shot = session["shots"][index]
        if shot.get("keep_original"):
            outcome["skipped"].append(index)
            continue
        try:
            submitted = await queue_one_shot(req, host, key, shot, params, mapping, previews_only)
        except web.HTTPException as error:
            try:
                message = json.loads(error.text).get("error") or error.reason
            except (ValueError, AttributeError):
                message = error.reason
            outcome["failed"].append({"shot": index, "error": message})
        except Exception:
            outcome["failed"].append({"shot": index, "error": "生成服务未能提交任务"})
        else:
            outcome["submitted" if submitted else "skipped"].append(index)
            if submitted:
                if previews_only and data.get("plan_id"):
                    shot["frames"][params["frame"]]["previews"][-1]["plan_id"] = data["plan_id"]
                # Keep each task reachable even if a later service call fails.
                save(key, session)
    return outcome


async def apply_remake_plan(req, host, key, session, data):
    indices = data.get("shots")
    if (not isinstance(indices, list) or not 1 <= len(indices) <= 4
            or any(type(i) is not int or not 0 <= i < len(session["shots"]) for i in indices)
            or len(set(indices)) != len(indices)):
        fail("请选择 1 至 4 个不同的镜头")
    role_reference(req, key[1], data)
    previous = session.get("mapping")
    scope = indices
    if previous and previous["source"] == data.get("person") and previous["asset"] == data.get("asset"):
        scope = list(dict.fromkeys([*previous["shots"], *indices]))
    set_mapping(req, key[1], session, {**data, "shots":scope})
    mapping = session["mapping"]
    outcome = {"submitted":[], "skipped":[], "failed":[], "needs_selection":[], "jobs":[]}
    requests = []
    for index in indices:
        shot = session["shots"][index]
        frame_key = start_preview_key(shot, mapping)
        if shot.get("keep_original"):
            outcome["skipped"].append(index)
        elif not frame_key or (person_selection(shot["frames"][frame_key], mapping) or {}).get("source_person") != mapping["source"]:
            outcome["needs_selection"].append(index)
        else:
            requests.append({"shot":index, "frame":frame_key, "view":"main", "reference":data.get("reference")})
    if requests:
        if data.get("plan_id"):
            save(key, session)
        queued = await queue_shots(req, host, key, session, {**data, "action":"batch_previews", "shots":requests})
        for field in queued:
            outcome[field].extend(queued[field])
        for item in requests:
            if item["shot"] in queued["submitted"]:
                frame = session["shots"][item["shot"]]["frames"][item["frame"]]
                outcome["jobs"].append({"index":item["shot"], "frame":item["frame"], "job":frame["previews"][-1]["job"]})
    return outcome


def remake_plan_result(session, plan_id, receipt):
    if receipt.get("result") is not None:
        return receipt["result"]
    jobs = [{"index":index, "frame":frame, "job":preview["job"]}
            for index, shot in enumerate(session["shots"])
            for frame, item in shot["frames"].items()
            for preview in item["previews"] if preview.get("plan_id") == plan_id]
    return {"submitted":[job["index"] for job in jobs], "jobs":jobs, "skipped":[], "needs_selection":[],
            "failed":[], "uncertain":True}
