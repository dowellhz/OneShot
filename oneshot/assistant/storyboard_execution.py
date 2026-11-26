"""Apply a saved assistant storyboard and generate its missing images."""

import json
import re
import uuid

from oneshot.assistant.chat_state import ToolError
from oneshot.storage import db

_CONTINUE = re.compile(r"(?:继续(?:做|生成)?|确认[，, ]*继续|加入画布并生成|continue|proceed)[。.!！ ]*", re.I)
_FRAME_CONTINUE = re.compile(r"(?:继续生成分镜图|continue generating storyboard frames)[。.!！ ]*",re.I)
TOOLS = {"storyboard_apply", "storyboard_generate_frame"}


def saved_plan(run, call_id=None):
    rows = db.q(
        """SELECT c.id,c.result FROM chat_calls c JOIN chat_runs r ON r.id=c.run_id
           WHERE r.session_id=? AND r.board_id=? AND r.user_id=? AND c.name='storyboard_create_plan'
           AND c.state='done' AND (? IS NULL OR c.id=?) ORDER BY c.rowid DESC LIMIT 1""",
        run["session_id"], run["board_id"], run["user_id"], call_id, call_id,
    )
    if rows:
        row = rows[0]
        plan = json.loads(row["result"]).get("storyboard_create")
        if plan and plan.get("board") == run["board_id"]:
            return row["id"], plan
    return None


def continuation(service, run, data, event):
    text = event["text"].strip()
    explicit = bool(_FRAME_CONTINUE.fullmatch(text))
    if (data.get("generation_mode") != "auto" or data.get("execution_scope","full") != "full"
            or not (explicit or _CONTINUE.fullmatch(text)) or data.get("selected")
            or event.get("documents") or data.get("attached_review") or data.get("attached_reviews")):
        return []
    saved = saved_plan(run)
    if not saved:
        return []
    call_id, plan = saved
    intervening = db.q(
        """SELECT json_extract(e.data,'$.text') AS text, json_extract(e.data,'$.selected') AS selected
           FROM chat_runs r JOIN chat_events e ON e.run_id=r.id AND e.kind='user'
           WHERE r.session_id=?
           AND r.rowid > (SELECT previous.rowid FROM chat_runs previous JOIN chat_calls c ON c.run_id=previous.id WHERE c.id=?)
           AND r.rowid < (SELECT rowid FROM chat_runs WHERE id=?)""",
        run["session_id"],call_id,run["id"],
    )
    if not explicit and any((item["selected"] and json.loads(item["selected"])) or
                            not (_CONTINUE.fullmatch(item["text"] or "") or _FRAME_CONTINUE.fullmatch(item["text"] or ""))
                            for item in intervening):
        return []
    try:
        board = service.board({"id":run["user_id"]},run["board_id"])
    except ToolError:
        return []
    nodes = {n["id"]:n for n in board["nodes"]}
    script = nodes.get(plan["id"])
    if script and (script.get("type")!="script" or script.get("locked")):
        return []
    shots = script["data"]["shots"] if script else plan["shots"]
    made = {pair["shot_id"]: nodes.get(pair.get("img")) for pair in (script or {}).get("data",{}).get("made",[])
            if pair.get("shot_id")}
    missing = [i for i,shot in enumerate(shots,1)
               if not ((image := made.get(shot.get("id"))) and (image.get("versions") or image.get("job")))]
    first = [("storyboard_apply",{"plan_call_id":call_id})] if not script else []
    return first + [("storyboard_generate_frame",{"node_id":plan["id"],"shot":i}) for i in missing[:4]]


def apply(service, run, user, cid, args):
    saved = saved_plan(run,args.get("plan_call_id"))
    if not saved:
        raise ToolError("当前对话中找不到这份分镜方案")
    _, plan = saved
    for image in plan["refs"]:
        service.source(run,user,image["node"],pinned_ref=image["ref"])
        service.host.require_media(user,[image["ref"]])

    def change(board):
        nid = plan["id"]
        if any(n["id"]==nid for n in board["nodes"]):
            return {"node_id":nid,"text":"分镜已在画布上"}
        title = plan.get("title") or "分镜脚本"
        data = {key:plan[key] for key in ("aspect","style","characters","title") if key in plan}
        data.update(prompt=plan["story"],shots=[{**shot,"id":"n"+uuid.uuid4().hex[:24]} for shot in plan["shots"]])
        x = max((n.get("x",0) for n in board["nodes"]),default=-540)+540
        board["nodes"].append({"id":nid,"type":"script","name":title[:80],"x":x,"y":0,"data":data,
                               "cur":-1,"versions":[],"job":None})
        board["edges"].extend({"from":i["node"],"to":nid,"ref":i["ref"]} for i in plan["refs"])
        return {"node_id":nid,"text":f"已加入「{title}」，共 {len(data['shots'])} 镜"}

    result = service.commit(run,user,cid,change)
    run["data"].pop("storyboard_create_pending",None)
    service.update(run)
    return result


def frame_prompt(script, shot, previous):
    data = script["data"]
    cast = {c["name"]:c.get("look") for c in data.get("characters",[]) if isinstance(c,dict) and c.get("name")}
    details = [f"{name}：{cast[name]}" for name in shot.get("characters",[]) if cast.get(name)]
    tokens = ["@{"+a["id"]+"#"+a.get("view","main")+"|"+a["name"]+"}"
              for a in shot.get("asset_refs",[]) if a.get("id") and a.get("name") and (a.get("kind")!="world" or a.get("explicit"))]
    visual = "，".join(v for v in (data.get("style"),shot.get("scene"),shot.get("shot_size"),shot.get("camera"),
                                   *details,shot.get("keyframe") or "，".join(shot.get("action",[])[:1])) if v)
    return "。".join(v for v in ("参考 @图1 保持角色造型与服装，场景和构图按本镜描述" if previous else "",
                                 visual,"单张电影分镜图，无文字","参考资产 "+" ".join(tokens) if tokens else "") if v)


async def generate_frame(service, run, user, cid, args):
    number, nid = args["shot"], args["node_id"]
    board = service.board(user,run["board_id"])
    nodes = {n["id"]:n for n in board["nodes"]}
    script = nodes.get(nid)
    if not script or script.get("type")!="script" or script.get("locked"):
        raise ToolError("分镜脚本不存在或已锁定")
    shots = script["data"].get("shots",[])
    if not 1 <= number <= len(shots):
        raise ToolError("所选镜头不存在")
    shot = shots[number-1]
    if not shot.get("id"):
        raise ToolError("分镜镜头缺少编号，请先保存分镜")
    pairs = {p.get("shot_id"):p for p in script["data"].get("made",[])}
    target = nodes.get(pairs.get(shot["id"],{}).get("img"))
    if target and target.get("versions"):
        return {"node_id":target["id"],"text":f"第 {number} 镜已有分镜图"}
    previous = nodes.get(pairs.get(shots[number-2].get("id"),{}).get("img")) if number>1 else None
    prior = service.current(previous) if previous else None
    same_scene = number>1 and (not shot.get("scene") or shot.get("scene")==shots[number-2].get("scene"))
    edges = [e for e in board["edges"] if e["to"]==nid and e.get("ref") and nodes.get(e["from"],{}).get("type")=="image"]
    fixed = {edge["from"]:edge["ref"] for edge in edges}
    if prior and (same_scene or not fixed):
        fixed = {previous["id"]:prior["ref"],**fixed}
    images = service.image_references(run,user,list(fixed)[:4],fixed)
    prompt = frame_prompt(script,shot,bool(prior and previous["id"] in fixed))
    aspect = script["data"].get("aspect","16:9")
    data = {"prompt":prompt,"caption":shot.get("keyframe",""),"aspect":aspect,"quality":"4mp"}
    name = f"镜{number} · 分镜图"
    if target is None:
        iid = "n"+uuid.uuid4().hex[:24]

        def create(current):
            item = next(n for n in current["nodes"] if n["id"]==nid)
            item["data"].setdefault("made",[]).append({"shot_id":shot["id"],"img":iid})
            current["nodes"].append({"id":iid,"type":"image","name":name,"data":data,"cur":-1,"job":None,
                                     "versions":[],"x":script["x"]+570+380*((number-1)%4),
                                     "y":script["y"]+330*((number-1)//4)})
            current["edges"].extend({"from":im["node_id"],"to":iid,"ref":im["ref"]} for im in images)
            return {"node_id":iid}

        target_id = service.commit(run,user,"frame_"+cid,create)["node_id"]
    else:
        target_id = target["id"]
    payload = service.image_request({"prompt":prompt,"aspect":aspect},images)
    return await service.submit_generation(run,user,cid,payload,name,service.host.generate_request,
                                           target_id=target_id,target_data=data)
