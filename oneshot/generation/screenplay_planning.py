"""Confirm a story outline and audit story beats against the resulting shots."""

import re

from aiohttp import web

from oneshot.generation import screenplay_workbench as workbench


OUTLINE = """提取短片大纲，供用户在写剧本前确认。用用户的创作语言。
给出主角或主题的目标、按顺序发生的可见事件、结尾、必须保留的角色/道具/事件，以及目标时长。
完整剧情优先提取原文；只有一句创意时才补关键走向。不要把剧情升级为原文没有的冲突。
已有对白原文保留。只返回 JSON，字段 goal, events, ending, fixed, seconds。"""

AUDIT = """你是分镜连续性审查员。核对给定定稿中的每个事件在分镜里是否恰好实际发生一次。
对每个事件返回其所有发生位置，按镜头号、动作行号排序，并逐字引用该动作行中的短语。
同一句描述多件事时它们可以在同一动作行发生。一个事件跨多行时只标实际完成它的位置；动作已产生可见后果时，也可引用明确造成该后果的动作。持续状态、承接前镜的站位、对白提及、预告和首帧已存在的静态状态不算再次发生。质变必须在动作栏明确发生。例如“叼着球跑”只能证明奔跑，不能证明从地上叼起；“已经在地上滚”不能证明球刚触地。
检查首次可见状态：如果首帧已经提前展示了后面事件造成的独特结果，另在 premature 中引用该镜头的首帧原文。
事件从未实际呈现时 locations 必须为空。不要依据分镜的场次标签猜测位置。逐项核对全部输入事件，不新增、不省略、不给总分。
只返回 JSON {"events":[{"id":1,"locations":[{"shot":1,"action":1,"quote":"动作原文"}],
"premature":[{"shot":1,"quote":"首帧原文"}]}]}。编号全部从 1 起。"""


def normalize_outline(raw):
    if not isinstance(raw,dict) or type(raw.get("seconds")) is not int or not 5 <= raw["seconds"] <= 120:
        raise ValueError("大纲时长须为 5–120 秒")
    events = workbench._lines(raw.get("events"),"events",12,600)
    if not events:
        raise ValueError("大纲至少需要一个关键事件")
    return {"goal":workbench._str(raw.get("goal"),"goal",600,required=True),
            "events":events,"ending":workbench._str(raw.get("ending"),"ending",600,required=True),
            "fixed":workbench._lines(raw.get("fixed",[]),"fixed",30,600),"seconds":raw["seconds"]}


async def outline(llm, content, parse_json, target):
    fields = workbench._object({"goal":workbench._TEXT,"events":{"type":"array","items":workbench._TEXT},
                               "ending":workbench._TEXT,"fixed":{"type":"array","items":workbench._TEXT},
                               "seconds":{"type":"integer"}})
    raw = await workbench._chat_json(llm,OUTLINE,content,parse_json,fields,max_tokens=1450,temperature=.35)
    if isinstance(raw,dict) and type(target) is int and 5 <= target <= 120:
        raw["seconds"] = target
    return normalize_outline(raw)


def required_events(draft):
    events = []
    for scene, item in enumerate(draft["beats"],1):
        seen = set()
        for field in ("action","result"):
            for part in re.split(r"[。；;\n]+|(?<=[!?])\s+",item[field]):
                text = part.strip()
                if text and text not in seen:
                    events.append({"id":len(events)+1,"scene":scene,"text":text})
                    seen.add(text)
    return events


# For common object transitions, state-only descriptions cannot prove the requested contact.
_PHYSICAL_TRANSITIONS = (
    (r"叼起|衔起|\bpicks? (?:it |the ball )?up (?:in|with) (?:its|the) mouth",
     r"叼起|衔起|叼住|叼(?:到|入)|(?:用嘴|张嘴)(?:咬住|含住|夹住)|\b(?:pick\w* up|grabs? .+ with .+ mouth)"),
    (r"(?:球|物体).{0,10}(?:落地|触地|落在草地|接触地面)|\b(?:ball|object) lands?\b",
     r"落地|触地|落[到在至回].{0,8}(?:草地|地面|地上)|接触(?:草地|地面)|撞[到击向].{0,8}(?:草地|地面)|\b(?:lands?|hits? the ground|touches? down)\b"),
)


def _transition_visible(event, line):
    return all(not re.search(expected,event,re.I) or re.search(evidence,line,re.I)
               for expected,evidence in _PHYSICAL_TRANSITIONS)


def _is_negated(description, excerpt):
    if not isinstance(excerpt,str) or not excerpt:
        return False
    return bool(re.search(r"(?:尚未|还未|未|没有|not yet |has not )[^，。,.]{0,5}"+re.escape(excerpt),description,re.I))


def _position(entry, shots, *, frame=False):
    if not isinstance(entry,dict):
        return None
    shot, quote = entry.get("shot"), entry.get("quote")
    if type(shot) is not int or not 1 <= shot <= len(shots) or not isinstance(quote,str) or not quote.strip():
        return None
    if frame:
        return (shot,0) if quote in shots[shot-1]["keyframe"] else None
    action = entry.get("action")
    lines = shots[shot-1]["action"]
    return (shot,action) if type(action) is int and 1 <= action <= len(lines) and quote in lines[action-1] else None


def evaluate(draft, shots, response):
    """Require evidence for each mapping and check coverage, repetition, and order."""
    if not shots:
        return {"ok":False,"events":[],"issue":"镜头没有按定稿场次完整分配"}
    events = required_events(draft)
    rows = response.get("events") if isinstance(response,dict) else None
    indexed = {}
    for row in rows if isinstance(rows,list) else []:
        if isinstance(row,dict) and type(row.get("id")) is int:
            key = row["id"]
            indexed[key] = row if key not in indexed else {}
    results, previous = [], (0,0)
    owners = [set() for _ in shots]
    for event in events:
        row = indexed.get(event["id"],{})
        locations, premature = row.get("locations"), row.get("premature")
        found = [_position(entry,shots) for entry in locations] if isinstance(locations,list) else [None]
        early = []
        for entry in premature if isinstance(premature,list) else [None]:
            position = _position(entry,shots,frame=True)
            if position and _is_negated(shots[position[0]-1]["keyframe"],entry["quote"]):
                continue
            early.append(position)
        hits = sorted({position for position in found if position and
                       _transition_visible(event["text"],shots[position[0]-1]["action"][position[1]-1])})
        issues = []
        if None in found or None in early or (any(found) and not hits):
            issues.append("evidence")
        if not hits:
            issues.append("missing")
        if len(hits)>1:
            issues.append("duplicate")
        if hits and hits[0]<previous:
            issues.append("order")
        for shot,_ in hits:
            owners[shot-1].add(event["scene"])
        before = [position for position in early if position and (not hits or position<hits[0])]
        if before:
            issues.append("premature")
        if hits:
            previous = max(previous,hits[-1])
        results.append({**event,"shots":sorted({shot for shot,_ in hits+before}),"issues":issues})
    mixed = {index for index,scenes in enumerate(owners,1) if len(scenes)>1}
    for event in results:
        if mixed.intersection(event["shots"]) and "order" not in event["issues"]:
            event["issues"].append("order")
    if not results or any(event["issues"] for event in results):
        return {"ok":False,"events":results}
    groups, scene = [], min(set.union(*owners))
    for assigned in owners:
        if assigned:
            scene = next(iter(assigned))
        groups.append(scene)
    for number, item in enumerate(draft["beats"],1):
        try:
            workbench.verify_storyboard_dialogue({"beats":[item]},[shot for shot,owner in zip(shots,groups) if owner==number])
        except ValueError:
            return {"ok":False,"events":results,"issue":"对白没有保留在定稿指定的场次"}
    return {"ok":True,"events":results,"shot_scenes":groups}


async def audit(llm, draft, shots, parse_json):
    if not shots:
        return evaluate(draft,shots,{})
    text, integer = workbench._TEXT, {"type":"integer"}
    hit = workbench._object({"shot":integer,"action":integer,"quote":text})
    early = workbench._object({"shot":integer,"quote":text})
    row = workbench._object({"id":integer,"locations":{"type":"array","items":hit},
                            "premature":{"type":"array","items":early}})
    schema = workbench._object({"events":{"type":"array","items":row}})
    payload = {"events":required_events(draft),"shots":[{"shot":index,**{key:shot[key] for key in
               ("action","keyframe")}} for index,shot in enumerate(shots,1)]}
    checked = await workbench._chat_json(llm,AUDIT,[workbench._text(payload)],parse_json,schema,max_tokens=4600,temperature=.05)
    return evaluate(draft,shots,checked)


async def compile_checked(build, llm, draft, parse_json):
    feedback = None
    for _ in range(3):
        try:
            result = await build(feedback)
        except (ValueError,web.HTTPBadRequest) as error:
            cause = error if isinstance(error,ValueError) else error.__context__
            if not isinstance(cause,ValueError):
                raise
            feedback = {"ok":False,"events":[],"issue":str(cause)[:260]}
            continue
        report = await audit(llm,draft,result["shots"],parse_json)
        if report["ok"]:
            shots = [{**shot,"script_scene":scene} for shot,scene in zip(result["shots"],report["shot_scenes"])]
            return {**result,"shots":shots,"screenplay_audit":report}
        feedback = report
    return {"screenplay_audit":feedback}


def shot_schema():
    text, integer, number = workbench._TEXT, {"type":"integer"}, {"type":"number"}
    strings = {"type":"array","items":text}
    frames = {"type":"object","properties":{"end":text,"middle":text,"middle_time":number},"required":["end"],
              "additionalProperties":False}
    moment = {"type":"object","properties":{"evidence":text,"moment":text,"seconds":number},"required":["evidence"],
              "additionalProperties":False}
    shot = {"type":"object","properties":{
        "script_scene":integer,"duration":integer,**dict.fromkeys(("shot_size","camera","scene","sound","keyframe"),text),
        **dict.fromkeys(("action","dialogue","characters","visual_asset_keys"),strings),
        "asset_refs":{"type":"array","items":workbench._object({"id":text,"view":text})},
        "motion_frames":frames,"action_check":moment,"continues_previous":{"type":"boolean"}},
        "required":["script_scene","duration","shot_size","camera","scene","action","dialogue","keyframe","characters","sound"],
        "additionalProperties":False}
    character = workbench._object(dict.fromkeys(("name","look","voice"),text))
    asset = workbench._object(dict.fromkeys(("key","kind","name","look"),text))
    return {"type":"object","properties":{"title":text,"style":text,"characters":{"type":"array","items":character},
            "visual_assets":{"type":"array","items":asset},"shots":{"type":"array","items":shot}},
            "required":["title","style","characters","shots"],"additionalProperties":False}
