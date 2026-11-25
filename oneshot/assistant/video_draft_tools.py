"""Read and finalize draft video versions."""
from __future__ import annotations

import copy
import time

from oneshot.assistant.video_canvas_results import node_data, result_id
from oneshot.assistant.video_reference_inputs import reference_version, video_node
from oneshot.assistant.video_reference_plan import video_edit_snapshot
from oneshot.canvas import workflow_review


def read_draft_status(s, run, user, nid):
    _, node = video_node(s,run,user,nid,allow_film=True)
    now = time.time()
    drafts = []
    for index, version in enumerate(node.get("versions", []), 1):
        if source := s.host.video_draft_source(version.get("ref")):
            expiry = source["expires"]
            drafts.append({"version":index,"current":node.get("cur")==index-1,
                           "expires":expiry,"expired":expiry<=now,"resolution":"480p"})
    return {"node_id":nid,"name":node["name"],"drafts":drafts,"final_resolutions":["1080p","4k"],
            "text":"已读取样片版本。" if drafts else "这个节点还没有可列出的原生样片。"}


async def finalize_draft(s, run, user, cid, args):
    board, target = video_node(s,run,user,args["node_id"],allow_film=True)
    if target.get("job"):
        raise ValueError("请等待当前视频任务完成或取消后再生成定稿")
    selected, source = reference_version(s,run,user,selection=args,kind="clip")
    draft = s.host.video_draft_source(source["ref"])
    if not draft:
        raise ValueError("所选版本不是原生样片，请从样片版本生成定稿")
    if draft["expires"]<=time.time():
        raise ValueError("样片已过定稿有效期，请重新生成样片")

    _, recipe, data, inputs = video_edit_snapshot(s,run,board,target,selected["version"])
    recipe.pop("draft",None)
    data.pop("draft",None)
    resolution = args.get("resolution","1080p")
    recipe["quality"] = data["quality"] = "4k" if resolution == "4k" else "hd"
    record = copy.deepcopy(source.get("generation_record") or workflow_review.capture_generation(recipe))
    record.setdefault("settings", {})["resolution"] = resolution
    prompt = source.get("prompt") or recipe.get("prompt") or ""
    branch = args.get("placement") == "branch"
    target_id = None if branch else target["id"]
    draft_final = {"source_node":target["id"],"source_ref":source["ref"],"resolution":resolution}
    if branch:
        inputs = [{"from":target["id"],"to":result_id(cid),"relation":"draft_final","ref":source["ref"]}]
        data = {**node_data(recipe),**data,"prompt":prompt}
    name = target["name"][:28]+" · "+resolution.upper()+" 定稿" if branch else target["name"]+" · 定稿"
    await s.begin_generation(run,cid,"video",1,{"label":name,"ref":source["ref"],
        "node":target["id"],"resolution":resolution,"prompt":prompt,"placement":"branch" if branch else "tab"},target_id=target_id)
    result = await s.response(s.host.finalize_video_draft,user,{
        "board":run["board_id"],"node":target["id"],"ref":source["ref"],"resolution":resolution,"request_key":cid})
    return await s.wait_submitted_jobs(run,user,cid,{
        "ids":result["ids"],"name":name,"prompt":prompt,"kind":"video",
        "target_id":target_id,"recipe":recipe,"generation_record":record,
        **({"draft_branch":draft_final} if branch else {}),
        "memory_used":source.get("memory_used",[]),"version_history":{
            "input_edges":inputs,"node_data":data,"draft_final":draft_final}})
