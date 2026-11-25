"""Read, analyze, and prepare video remake sessions."""
from __future__ import annotations

from aiohttp import web

from oneshot.assistant.video_reference_inputs import video_node
from oneshot.editing import video_remake


def remake_source(s, run, user, nid):
    _, n = video_node(s, run, user, nid, allow_film=True)
    ref = run["data"].get("bindings", {}).get(nid) or (s.current(n) or {}).get("ref")
    try:
        return video_remake.remake_key(s.host, user, run["board_id"], nid, ref)
    except web.HTTPException:
        raise ValueError("原片版本已不存在，请重新选择视频") from None


async def apply_remake_action(s, user, nid, key, payload):
    async def invoke(req):
        req.method = "POST"
        req.match_info = {"board": key[1], "node": nid}
        return await s.host.remake(req)

    return await s.response(invoke, user, payload, query={"source": key[3]})


async def split_long_remake_shot(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    previous = video_remake.load(key)
    session = await apply_remake_action(s, user, nid, key, {
        "action": "split_long_shot", "shot": args["shot"] - 1, "cut_revision": args["cut_revision"],
    })
    result = remake_status(s.host, nid, key, session)
    first = session["selected_shot"]
    count = len(session["shots"]) - len(previous["shots"]) + 1
    children = result["shots"][first:first + count]
    result["remake"].update(shot_number=children[0]["number"], shot_start=children[0]["start"])
    result["split_shots"] = [{field: shot[field] for field in ("number", "start", "end")} for shot in children]
    result["can_undo_cut"] = session["can_undo_cut"]
    result["text"] = (f"原第 {args['shot']} 镜已拆成 {count} 个镜头，"
                      f"新编号为第 {children[0]['number']} 至 {children[-1]['number']} 镜。"
                      + result["text"])
    return result


async def analyze_remake(s, run, user, nid, *, retry=False):
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        session = await apply_remake_action(s, user, nid, key, {"action": "analyze"})
        return remake_status(s.host, nid, key, session)
    missing = sum(bool(shot.get("analysis_missing")) for shot in session["shots"])
    if retry and missing:
        session = await apply_remake_action(s, user, nid, key, {
            "action": "retry_analysis", "cut_revision": session.get("cut_revision", 0),
        })
    result = remake_status(s.host, nid, key, session)
    recovered = missing - len(result["missing_analysis_shots"])
    if recovered:
        result["text"] = f"已补充 {recovered} 个镜头的视觉分析。" + result["text"]
    return result


def plan_remake(s, run, user, args, cid):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    if not session or not session["shots"]:
        raise ValueError("请先分析原片")
    asset = s.app["creative_memory"].get(user, args["asset_id"], key[1])
    reference = asset.get("character_views", {}).get("main") or asset.get("ref")
    if asset["kind"] != "character" or not reference:
        raise ValueError("请选择已有参考图的角色资产")
    person = args["person"].strip()
    if not person or len(set(args["shots"])) != len(args["shots"]):
        raise ValueError("请指定原片人物和不重复的镜头")
    mapping = {"source":person, "asset":asset["id"]}
    planned = []
    for number in args["shots"]:
        if not 1 <= number <= len(session["shots"]):
            raise ValueError("请选择存在的镜头")
        shot = session["shots"][number - 1]
        frame_key = video_remake.start_preview_key(shot, mapping)
        selection = video_remake.person_selection(shot["frames"][frame_key], mapping) if frame_key else None
        ready = not shot.get("keep_original") and selection and selection.get("source_person") == person
        planned.append({"shot":number, "start":shot["start"], "selection_ready":bool(ready), "keep":bool(shot.get("keep_original"))})
    if run.get("id"):
        run["data"]["remake_plan_pending"] = True
        s.update(run)
    return {"text":"勾选要处理的镜头，再确认提交换角计划。", "remake":{"node_id":nid,"source_ref":key[3]},
            "remake_plan":{"id":cid, "board":key[1], "cut_revision":session.get("cut_revision", 0), "asset":asset["id"],
                           "asset_name":asset["name"], "reference":reference, "person":person, "look":args.get("look", ""),
                           "shots":planned}}


async def map_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = await apply_remake_action(s, user, nid, key, {
        "action": "map_person", "person": args["person"], "asset": args["asset_id"],
        "shots": [number - 1 for number in args["shots"]], "cut_revision": args["cut_revision"],
        "look": args.get("look", ""),
    })
    result = remake_status(s.host, nid, key, session)
    mapping = session["mapping"]
    result["text"] = f"已保存人物映射：{mapping['source']} → {mapping['asset_name']}，共 {len(mapping['shots'])} 个镜头。"
    return result


async def locate_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    session = video_remake.load(key)
    mapping = (session or {}).get("mapping")
    if not mapping or mapping["source"] != args["person"] or mapping["asset"] != args["asset_id"]:
        raise ValueError("请先读取或保存当前视频版本的人物映射")
    indices = [number - 1 for number in args["shots"]] if "shots" in args else mapping["shots"]
    session = await apply_remake_action(s, user, nid, key, {
        "action": "batch_locate_people", "person": args["person"], "asset": args["asset_id"],
        "shots": indices, "cut_revision": args["cut_revision"], "look": mapping.get("look", ""),
    })
    result = remake_status(s.host, nid, key, session)
    outcome = session["batch_locate_people"]
    located = [index + 1 for index in outcome["located"]]
    result["location"] = {
        "located": located, "skipped": [index + 1 for index in outcome["skipped"]],
        "failed": [{"shot": item["shot"] + 1, "error": item["error"]} for item in outcome["failed"]],
    }
    suggested = next((shot for shot in result["shots"] if shot["number"] - 1 in indices and shot["position_suggested"]), None)
    if suggested:
        result["remake"].update(shot_number=suggested["number"], shot_start=suggested["start"])
    result["text"] = (f"{len(located)} 个镜头已标出候选位置，请在工作区核对。" if located else
                      "本次未新增候选位置，可在工作区查看已有标记或手动选择。")
    return result


def mapped_remake(s, run, user, args):
    key = remake_source(s, run, user, args["node_id"])
    session = video_remake.load(key)
    mapping = (session or {}).get("mapping")
    if not mapping or mapping["source"] != args["person"] or mapping["asset"] != args["asset_id"]:
        raise ValueError("请先读取或保存当前视频版本的人物映射")
    if session.get("cut_revision", 0) != args["cut_revision"]:
        raise ValueError("剪辑点已更新，请重新读取视频重制状态")
    return key, session, mapping


async def review_remake(s, run, user, args):
    nid = args["node_id"]
    key = remake_source(s, run, user, nid)
    shot_number = args["shot"]
    adopt = args["decision"] == "adopt"
    job = args.get("video_job")
    if adopt and not job:
        raise ValueError("请先读取镜头的已完成版本，再指定要采用的版本")
    session = await apply_remake_action(s, user, nid, key, {
        "action": "approve_video" if adopt else "keep", "shot": shot_number - 1, "job": job,
        "cut_revision": args["cut_revision"],
    })
    result = remake_status(s.host, nid, key, session)
    result["remake"].update(shot_number=shot_number, shot_start=session["shots"][shot_number - 1]["start"])
    if adopt:
        result["remake"]["video_job"] = job
    result["text"] = f"已采用镜头 {shot_number} 的指定版本。" if adopt else f"镜头 {shot_number} 已设为保留原片。"
    return result


def remake_status(host, nid, key, session, *, review_shot=None):
    result = {"remake": {"node_id": nid, "source_ref": key[3]}, "shots": [], "analyzed": False}
    if not session or not session["shots"]:
        return {**result, "text": "该原片尚未分析，可打开视频重制工作区开始。"}
    video_remake.update_jobs(host, key[0], session)
    video_remake.refresh_export_status(session, key[3], host.film.FPS)
    review = video_remake.export_review(session)
    mapping = session.get("mapping")
    out = video_remake.available_export(host, session.get("export")) or {}
    if review_shot is not None:
        if not 1 <= review_shot <= len(session["shots"]):
            raise ValueError("请选择存在的镜头")
        shot = session["shots"][review_shot - 1]
        result["remake"].update(shot_number=review_shot, shot_start=shot["start"])
        result["review_board"] = key[1]
        in_scope = mapping is None or review_shot - 1 in mapping["shots"]
        result["review_versions"] = [
            {"number": index + 1, "job": version["job"], "mode": version.get("mode", "whole"),
             "adopted": not shot.get("keep_original") and shot.get("adopted_video") == version["job"],
             "review_issue": video_remake.video_start_issue(shot, version, mapping)
                             if in_scope or version.get("mode") == "combined" else "该镜头不在替换范围"}
            for index, version in enumerate(shot.get("videos", []))
            if version["state"] == "done" and version.get("ref")
            and (version.get("mode") == "combined" or video_remake.matches_mapping(version, mapping))
        ]
    issues = {item["shot"]: item["error"] for item in review["remaining"]}
    durations = video_remake.default_remake_durations(host)
    for index, shot in enumerate(session["shots"]):
        reviewed, issue = video_remake.export_choice(shot, mapping, index)
        frame_key = video_remake.start_preview_key(shot, mapping)
        frame = shot["frames"].get(frame_key, {})
        videos = shot.get("videos", [])
        frames = [item for record in shot["frames"].values() for item in record["previews"]]
        adopted_frame = video_remake.completed(frame.get("previews", []), frame.get("approved"))
        people = shot.get("summary", {}).get("characters")
        hint = frame.get("person_hint") or {}
        selected = bool(video_remake.person_selection(frame, mapping))
        frame_approved = bool(adopted_frame and video_remake.matches_mapping(adopted_frame, mapping) and
                              video_remake.preview_matches_regions(frame, adopted_frame, mapping))
        limit = video_remake.shot_video_limit(host,shot,mapping,durations)
        fps = host.film.FPS
        ticks = round(shot["end"] * fps) - round(shot["start"] * fps)
        result["shots"].append({
            "number": index + 1, "start": shot["start"], "end": shot["end"],
            "max_source_seconds":limit,"requires_split":ticks > limit * fps,
            "suggested_people": [name[:60] for name in people[:24] if isinstance(name, str)] if isinstance(people, list) else [],
            "keep_original": bool(shot.get("keep_original") or
                                  mapping and index not in mapping["shots"] and not reviewed and not issue),
            "start_frame_selected": selected,
            "position_suggested": bool(mapping and not selected and not video_remake.person_absent(frame, mapping) and
                                       hint.get("point") and hint.get("source") == mapping["source"] and
                                       hint.get("look") == mapping.get("look", "")),
            "start_frame_approved": frame_approved,
            "approved_start_job": adopted_frame["job"] if frame_approved else None,
            "depth_ready": bool(shot.get("depth", {}).get("ref") and shot["depth"]["state"] == "done"),
            "video_available": any(item.get("ref") and video_remake.matches_mapping(item, mapping) for item in videos),
            "pending": video_remake.pending(frames + videos), "review_issue": issues.get(index),
        })
    count = len(result["shots"])
    missing = [index for index, shot in enumerate(session["shots"], 1) if shot.get("analysis_missing")]
    warning = session.get("warning") or None
    text = f"共 {count} 个镜头，{len(issues)} 个待审核。"
    if warning:
        text += warning
    return {**result, "analyzed": True, "text": text, "missing_analysis_shots": missing,
            "cut_revision": session.get("cut_revision", 0),
            "motion_providers": video_remake.motion_providers(host),
            "source_people": session.get("source_people", []), "warning": warning,
            "mapping": {"source": mapping["source"], "asset": mapping.get("asset_name"), "asset_id": mapping["asset"],
                        "shots": [index + 1 for index in mapping["shots"]]} if mapping else None,
            "adopted": review["adopted"], "can_export": bool(review["adopted"] and not issues and
                                                          out.get("state") not in ("queued", "running")),
            "export_state": "stale" if out.get("stale") else out.get("state"),
            "export_ref": out.get("ref") if out.get("state") == "done" else None}
