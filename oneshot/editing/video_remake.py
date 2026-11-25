"""Serve the pinned video remake session and its editing actions."""
from __future__ import annotations

import re

from aiohttp import web

from oneshot.editing import video_depth
from oneshot.editing.remake_analysis import (
    analysis_warning,
    analyze,
    analyze_motion,
    fill_shot_analysis,
    suggest_entry,
)
from oneshot.editing.remake_batch import (
    apply_remake_plan,
    queue_shots,
    remake_plan_result,
)
from oneshot.editing.remake_cuts import edit_cuts
from oneshot.editing.remake_depth_guides import prepare_depth
from oneshot.editing.remake_export import (
    available_export,
    export_choice,
    export_plan as export_plan,
    export_review,
    export_video,
    prepare_playback,
    refresh_export_status,
)
from oneshot.editing.remake_localization import (
    approve_video,
    edit_role_layers,
    localize_shot,
    queue_combined_roles,
)
from oneshot.editing.remake_previews import generate_preview
from oneshot.editing.remake_reference_assets import VIEWS as VIEWS
from oneshot.editing.remake_regions import (
    batch_locate_people,
    locate_person,
    person_absent,
    person_selection as person_selection,
    select_area,
    selected_frame,
)
from oneshot.editing.remake_shot_plan import (
    preview_matches_regions,
    shot_guides as shot_guides,
    shot_start as shot_start,
    start_preview_key as start_preview_key,
    video_start_issue as video_start_issue,
)
from oneshot.editing.remake_source_media import capture_correction, original_frames as original_frames
from oneshot.editing.remake_state import (
    CUT_ACTIONS,
    MAX_SHOTS as MAX_SHOTS,
    _writes,
    activate_role_frames,
    completed,
    frame_record as frame_record,
    load,
    mapped_shots,
    matches_mapping,
    pending as pending,
    remake_key,
    save,
    set_mapping,
    update_jobs,
)
from oneshot.editing.remake_submission import (
    default_remake_durations,
    depth_motion as depth_motion,
    generate_shot,
    motion_providers,
    motion_routes,
    shot_video_limit,
)
from oneshot.memory.creative_memory import fail


def public_session(host, session, **extra):
    if session is None:
        return None
    result = {key: value for key, value in session.items() if key not in ("cut_archive", "cut_undo")}
    jobs = []
    for i, shot in enumerate(session["shots"]):
        version, issue = export_choice(shot, session.get("mapping"), i)
        jobs.append(version["job"] if version and not issue else None)
    result["reviewed_jobs"] = jobs
    result["remake_plans"] = {key:{"shots":receipt["shots"], "result":remake_plan_result(session, key, receipt)}
                              for key, receipt in session.get("remake_plans", {}).items()}
    if "export" in result:
        result["export"] = available_export(host, result["export"])
    durations = default_remake_durations(host)
    result["video_limits"] = [shot_video_limit(host,shot,session.get("mapping"),durations) for shot in session["shots"]]
    return {**result, "can_undo_cut": bool(session.get("cut_undo")), "export_review": export_review(session),
            "motion_providers": motion_providers(host),
            "depth_available": video_depth.configuration() is not None, **extra}


async def handle(req, host):
    source = req.query.get("source")
    board, node = req.match_info["board"], req.match_info["node"]
    if req.method == "GET":
        key = remake_key(host, req["user"], board, node, source)
        session = load(key)
        if session:
            update_jobs(host, key[0], session)
            refresh_export_status(session, source, host.film.FPS)
        return web.json_response(public_session(host, session, session_node=key[2]))
    data = await req.json()
    if not isinstance(data, dict):
        fail("请求格式不正确")
    key = remake_key(host, req["user"], board, node, source)
    if key in _writes:
        fail("此原片正在处理，请稍候", 409)
    _writes.add(key)
    try:
        response = {}
        session = load(key)
        action = data.get("action")
        plan_id = data.get("plan_id") if action == "apply_plan" else None
        if plan_id is not None:
            if not isinstance(plan_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", plan_id):
                fail("计划编号无效")
            if session and (receipt := session.get("remake_plans", {}).get(plan_id)):
                update_jobs(host, key[0], session)
                return web.json_response(public_session(host, session, session_node=key[2],
                    apply_plan=remake_plan_result(session, plan_id, receipt)))
        if session and data.get("cut_revision", 0) != session.get("cut_revision", 0):
            fail("剪辑点已更新，请重新打开视频重制界面", 409)
        if action == "analyze":
            if not session or not session["shots"]:
                session = {**(session or {}), **await analyze(req, host, source)}
        elif action == "prepare_playback":
            session = session or {"shots": []}
            update_jobs(host, key[0], session)
            await prepare_playback(req, host, key, session)
        elif not session or not session["shots"]:
            fail("请先分析原片")
        elif action == "retry_analysis":
            shots = session["shots"]
            await fill_shot_analysis(req, host, session, shots, [
                index for index, shot in enumerate(shots) if shot.get("analysis_missing")
            ])
        elif action == "export":
            update_jobs(host, key[0], session)
            await export_video(req, host, key, session)
        elif action == "map_person":
            set_mapping(req, board, session, data)
        elif action == "apply_plan":
            update_jobs(host, key[0], session)
            if plan_id is None:
                response[action] = await apply_remake_plan(req, host, key, session, data)
            else:
                plans = session.setdefault("remake_plans", {})
                receipt = plans[plan_id] = {"shots":data.get("shots"), "result":None}
                try:
                    response[action] = await apply_remake_plan(req, host, key, session, data)
                except web.HTTPException:
                    plans.pop(plan_id, None)
                    save(key, session)
                    raise
                receipt["result"] = response[action]
        elif action == "remove_mapping":
            activate_role_frames(session, None)
            session.pop("mapping", None)
        elif action == "batch_locate_people":
            response[action] = await batch_locate_people(req, host, session, data)
        elif action in ("batch_previews", "batch_videos"):
            update_jobs(host, key[0], session)
            response[action] = await queue_shots(req, host, key, session, data)
        elif action in CUT_ACTIONS:
            update_jobs(host, key[0], session)
            response["selected_shot"] = await edit_cuts(req, host, source, session, data)
        else:
            update_jobs(host, key[0], session)
            shot, frame = selected_frame(session, data)
            mapping = session.get("mapping")
            scoped = mapped_shots(session)
            adopting_combined = action == "approve_video" and any(
                v["job"] == data.get("job") and v.get("mode") == "combined" for v in shot.get("videos", [])
            )
            if (scoped is not None and data["shot"] not in scoped and
                    not adopting_combined and
                    action in ("preview", "approve", "generate_video", "generate_depth_video", "localize", "approve_video",
                               "locate_person", "apply_person_hint", "set_absence", "analyze_motion", "suggest_entry")):
                fail("此镜头未包含在人物映射范围内，请先确认该镜头")
            if action == "set_absence":
                absent = data.get("absent")
                if (frame is not shot["frames"]["first"] and "correction_tick" not in frame) or type(absent) is not bool:
                    fail("请在首帧或校正帧标记人物出画")
                if absent:
                    frame["person_absent"] = {"source": mapping["source"] if mapping else None}
                elif person_absent(frame, mapping):
                    frame.pop("person_absent")
            elif action in ("select", "clear_protection"):
                layer = "protection" if action == "clear_protection" else data.get("layer", "selection")
                if layer not in ("selection", "protection"):
                    fail("请选择人物选区或前景保护区")
                if layer == "protection" and frame is not shot["frames"]["first"] and "correction_tick" not in frame:
                    fail("请在首帧或校正帧标记前景保护区")
                if action == "clear_protection":
                    # A null anchor stops protection inherited from an earlier frame.
                    frame["protection"] = {"mask": None}
                else:
                    if layer == "selection" and person_absent(frame, mapping):
                        fail("请先取消人物出画标记")
                    person = mapping["source"] if mapping and data["shot"] in scoped else None
                    await select_area(req, host, frame, data, layer, source_person=person)
            elif action in ("locate_person", "apply_person_hint"):
                await locate_person(req, host, session, frame, data)
            elif action == "analyze_motion":
                await analyze_motion(req, host, source, session, shot, mapping)
            elif action == "prepare_depth":
                prepare_depth(req, host, key, session, shot)
            elif action == "suggest_entry":
                response["captured_frame"] = await suggest_entry(req, host, source, session, shot, mapping, data)
            elif action == "capture_correction":
                response["captured_frame"] = await capture_correction(host, source, shot, data.get("at"),
                                                                      display=session.get("display_oriented", False))
            elif action == "remove_correction":
                if "correction_tick" not in frame:
                    fail("请选择要移除的校正帧")
                del shot["frames"][data["frame"]]
            elif action == "preview":
                session["role"] = await generate_preview(req, host, key, frame, data, mapping)
            elif action == "approve":
                if person_absent(frame, mapping):
                    fail("请先取消人物出画标记")
                preview = completed(frame["previews"], data.get("job"))
                if not preview or not preview.get("ref"):
                    fail("请选择已完成的预览")
                if not matches_mapping(preview, mapping):
                    fail("这个预览属于之前的人物映射，请为当前角色重新生成")
                if not preview_matches_regions(frame, preview, mapping):
                    fail("此预览的选区已更新，请重新生成预览", 409)
                frame["approved"] = preview["job"]
            elif action == "clear_guide":
                if "correction_tick" not in frame:
                    fail("请选择要取消的动作关键帧")
                frame.pop("approved", None)
            elif action == "generate_video":
                await generate_shot(req, host, key, shot, data, mapping)
            elif action == "generate_depth_video":
                route = next((r for r in motion_routes(host) if r["provider"]["id"] == data.get("provider")), None)
                if not route:
                    fail("请先在控制台配置支持参考视频的 Seedance 服务", 503)
                await generate_shot(req, host, key, shot, data, mapping, motion_route=route)
            elif action == "localize":
                localize_shot(req, host, key, shot, data.get("job"), mapping, display=session.get("display_oriented", False))
            elif action in ("add_role_layer", "remove_role_layer", "move_role_layer"):
                edit_role_layers(shot, data, mapping)
            elif action == "combine_roles":
                queue_combined_roles(req, host, key, shot, display=session.get("display_oriented", False))
            elif action == "approve_video":
                await approve_video(host, shot, data.get("job"), mapping)
            elif action == "keep":
                shot["keep_original"] = True
            else:
                fail("未知的视频重制操作")
        update_jobs(host, key[0], session)
        refresh_export_status(session, source, host.film.FPS)
        session["warning"] = analysis_warning(session["shots"])
        save(key, session)
        return web.json_response(public_session(host, session, session_node=key[2], **response))
    finally:
        _writes.discard(key)
