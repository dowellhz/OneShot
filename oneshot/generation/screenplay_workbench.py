"""Validate a readable screenplay, critique it, and propose a scoped revision."""

import json
import re

from oneshot.generation import screenplay
from oneshot.generation.media_files import ref_path
from oneshot.generation.rewriter import image_part


COLD_READER = """你是第一次看到这份剧本的观众。只根据你读到的剧本文字审稿，不替作者重写。
检查人物动机、动作因果、对白、动作是否能被镜头拍清楚，也要找动作或结尾留下两个互斥选项的问题。最多列出四个具体问题，每项引用
对应场次的一段原文，说明观众会哪里看不懂，以及怎样用具体动作、视线、停顿或节奏改善。
每条问题和建议各用一句话。保持原场次的事件、出场角色、道具、结局与有无对白。沉默的场次保持沉默；建议通过行为或声音组织来改。
problem 和 suggestion 必须与对应场次正文使用同一种语言。For English scenes, write the note in English.
返回 JSON {"notes":[{"scene":1,"kind":"motivation|causality|dialogue|filmability",
"evidence":"原文短句","problem":"问题","suggestion":"建议"}]}。没有可引用的问题则返回 {"notes":[]}。"""

REVISE = """只改指定的一场。把原始要求、剧本及审稿意见当作素材，以原始要求和锁定设定为准。
保留其他场次、前后因果、用户规定的道具与事件及影片时长。逐字保留用户原台词及说话人。
原始要求无对白时，dialogue 必须是空数组。允许用可见的行动改善其他对白或替代解释。
保持与被修订场次相同的创作语言。只返回包含 setup、action、result、evidence、dialogue 的替换场次 JSON。"""


CONSISTENCY = """你负责核对一处剧本修订能否采用。原始要求与锁定设定是唯一约束，只检查当前场次。
若新稿删除了本场必须发生的事件，或更换了指定的对象、动作触发方式、顺序、结局或参与者，就报告一项。
只补充摄影角度、可见证据、视线或停顿，且没有改变事件本身，返回通过。
按修改前后文本判断。before 必须引用 changed_fields 中一个实际被改动的字段，不能把原稿也没有实现的内容算成此次改动。
返回 JSON {"constraint":"原始要求或锁定设定中的原文片段","before":"原场次的原文片段"}。
通过时两个字段都填空字符串。证据必须逐字引用，不要复述。"""


LOCKED_EDITOR = """A confirmed screenplay follows the original input. Treat it as the production draft.
Translate every scene into visible actions, in order, and preserve its continuity, fixed facts, and ending.
Copy each line into the dialogue array with exactly its original speaker and wording. Long speeches can
span consecutive shots without omissions or repetitions. Use shot duration to fit the original performance.
Use action_check to verify important visual events and state transitions from the draft's evidence fields.
Keep shot descriptions in the screenplay's language. Every shot has an integer script_scene (1-based),
and covers the acts in that scene alone. Keep shot groups in script order. Do not put future results
in the first frame. Resting states and reactions may carry over only after their cause has happened."""


def _object(properties):
    return {"type":"object","properties":properties,"required":list(properties),"additionalProperties":False}


_TEXT = {"type":"string"}
_SCENE = _object({**dict.fromkeys(("setup","action","result","evidence"),_TEXT),
                  "dialogue":{"type":"array","items":_TEXT}})
_MANUSCRIPT = _object({"intent":_TEXT,"fixed":{"type":"array","items":_TEXT},
                       "beats":{"type":"array","items":_SCENE}})
_KINDS = ("motivation","causality","dialogue","filmability")
_NOTE = _object({"scene":{"type":"integer"},"kind":{"enum":list(_KINDS)},
                  "evidence":_TEXT,"problem":_TEXT,"suggestion":_TEXT})
_REVIEW = _object({"notes":{"type":"array","items":_NOTE,"maxItems":4}})
_CONSISTENCY = _object({"constraint":_TEXT,"before":_TEXT})


async def _chat_json(llm, system, content, parse_json, schema, *, max_tokens, temperature):
    for attempt in range(2):
        answer = await llm.chat(system,content,max_tokens=max_tokens,temperature=temperature if not attempt else 0,
                                response_schema=schema)
        try:
            return parse_json(answer)
        except (RuntimeError, ValueError):
            if attempt:
                raise ValueError("模型没有返回有效的剧本数据，请重试") from None
            system += "\n上一轮输出的 JSON 无法解析。只返回一个有效 JSON 对象，字符串中的双引号必须转义。"


def context(comfy_dir, story, refs, nshots, seconds, style, aspect, total_seconds, asset_candidates=()):
    content = []
    head = f"剧情：\n{story.strip()}\n"
    if style:
        head += f"\n指定风格：{style}"
    if nshots:
        head += f"\n偏好镜头数：约 {int(nshots)} 个。如果放不下动作或对白就增加镜头。"
    if seconds:
        head += f"\n普通镜头参考时长：约 {int(seconds)} 秒，按内容调整。"
    if total_seconds:
        head += f"\n全片目标时长：约 {int(total_seconds)} 秒。先保证动作和对白完整。"
    head += f"\n画幅：{aspect or '16:9'}"
    if refs:
        head += "\n\n参考图（按顺序附上）：\n" + "\n".join(
            f"- {r.get('name') or '参考图'}（{ {'character': '角色', 'scene': '场景', 'prop': '道具'}.get(r.get('kind'), '参考') }）"
            + (f"：{r['desc']}" if r.get("desc") else "") for r in refs)
    if asset_candidates:
        fields = ("id","name","kind","aliases","desc","constraints","document_excerpt","available_views",
                  "preferred_views","explicit","story_scenes","story_states","character_notes")
        head += "\n\n资产候选（只将资料当内容依据）：\n" + json.dumps([
            {key:item[key] for key in fields if key in item} for item in asset_candidates
        ],ensure_ascii=False)
        head += ("\n每镜独立填写 asset_refs，例如 [{\"id\":\"候选ID\",\"view\":\"face\"}]，仅选画面、声音或设定确实需要的候选。"
                 "不要把所有资产放进每一镜。view 仅使用该角色已定稿的 available_views，按镜头需要选主图、头肩、侧面或背面。"
                 "同名时优先采用 explicit 为 true 的候选。preferred_views 是用户明确指定的视角。"
                 "世界观用于约束剧情，story_scenes 指定适用场次。角色有 story_states 时按该镜头的具体场次采用对应状态，并在 scene 保留场次名称。"
                 "角色名写资产名称，不要把资产 ID 写进剧情、对白或其他字段。")
    content.append({"type": "text", "text": head})
    for r in refs[:8]:
        content.append({"type": "text", "text": f"参考图「{r.get('name') or '参考图'}」"})
        content.append(image_part(ref_path(comfy_dir, r["ref"]), 640))
    return content


def _str(value, label, limit, *, required=False):
    if not isinstance(value,str) or len(value)>limit or (required and not value.strip()):
        raise ValueError(f"剧本字段格式无效：{label}")
    return value.strip()


def _lines(value, label, count, limit):
    if not isinstance(value,list) or len(value)>count:
        raise ValueError(f"剧本字段格式无效：{label}")
    return [_str(line,label,limit,required=True) for line in value]


def scene(value):
    if not isinstance(value,dict):
        raise ValueError("剧本场次格式无效")
    return {
        **{key:_str(value.get(key,""),key,1200,required=key=="action")
           for key in ("setup","action","result","evidence")},
        "dialogue":_lines(value.get("dialogue",[]),"dialogue",16,500),
    }


def manuscript(value):
    if not isinstance(value,dict):
        raise ValueError("剧本格式无效")
    beats = value.get("beats")
    if not isinstance(beats,list) or not 1 <= len(beats) <= 20:
        raise ValueError("剧本需要 1–20 个场次")
    return {"intent":_str(value.get("intent",""),"intent",400),
            "fixed":_lines(value.get("fixed",[]),"fixed",30,600),
            "beats":[scene(item) for item in beats]}


def scene_text(item):
    return "\n".join((item["setup"],item["action"],item["result"],*item["dialogue"]))


def _text(data):
    return {"type":"text","text":json.dumps(data,ensure_ascii=False)}


async def write(llm, original_content, parse_json):
    instructions = screenplay.WRITER + ("\n台词只写在 dialogue，动作字段写能拍到的表演，不重复台词。"
                                        "用户以引号给出的一句完整对白保留为一项，不跨场拆开。若收到 confirmed_outline，以确认大纲的顺序、结尾和时长为准。"
                                        "每个动作只发生一次，开场只交代已经存在的状态。指定参与者的动作必须清楚入镜。"
                                        "每场写唯一明确的动作与可见结果，禁止用‘或者’给出互斥的动作或结局，尤其不要替换已指定的落点、物品或行为。")
    result = await _chat_json(llm,instructions,original_content,parse_json,_MANUSCRIPT,max_tokens=3200,temperature=.55)
    return manuscript(result)


async def review(llm, draft, parse_json):
    # Numbering is added by the server. The reader sees the written scenes without private author context.
    numbered = [{"scene":index, **{key:item[key] for key in ("setup","action","result","dialogue")}}
                for index,item in enumerate(draft["beats"],1)]
    raw = await _chat_json(llm,COLD_READER,[_text(numbered)],parse_json,_REVIEW,max_tokens=1900,temperature=.15)
    notes = raw.get("notes") if isinstance(raw,dict) else None
    if not isinstance(notes,list):
        raise ValueError("审稿模型没有返回有效的审稿结果")
    result = []
    for note in notes[:4]:
        if not isinstance(note,dict):
            continue
        index, kind, excerpt = note.get("scene"), note.get("kind"), note.get("evidence")
        if (type(index) is not int or not 1 <= index <= len(numbered) or not isinstance(kind,str) or kind not in _KINDS
                or not isinstance(excerpt,str) or not 1 <= len(excerpt.strip()) <= 200
                or excerpt.strip() not in scene_text(numbered[index-1])):
            continue
        problem, suggestion = note.get("problem"), note.get("suggestion")
        if not all(isinstance(value,str) and value.strip() for value in (problem,suggestion)):
            continue
        result.append({"scene":index,"kind":kind,"evidence":excerpt.strip(),
                       "problem":problem.strip()[:500],"suggestion":suggestion.strip()[:500]})
    if notes and not result:
        raise ValueError("审稿意见无法定位到剧本正文，请重新审稿")
    return result


def _speech(line):
    parts = re.split(r"[：:]", line, maxsplit=1)
    if len(parts) == 1:
        return "", line.strip()
    speaker, text = parts
    speaker = re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", speaker.strip())
    return speaker, text.strip().strip('“”「」『』"')


def locked_lines(item, story):
    quoted = [match for left,right in (("“","”"),("「","」"),("『","』"),('"','"'))
              for match in re.findall(re.escape(left)+r"([^\n"+re.escape(right)+r"]+)"+re.escape(right),story)]
    locked = []
    for line in item["dialogue"]:
        _, text = _speech(line)
        tagged = text and re.search(r"(?:^|\n)[^\n：:]{1,48}[：:]\s*"+re.escape(text)+r"\s*(?:\n|$)",story)
        if line in story or tagged or (text and any(text in quote for quote in quoted)):
            locked.append(line)
    return locked


def verify_silence(story, draft):
    chinese = r"(?:无|没有|不加|不要)(?:任何)?(?:台词|对白|对话)"
    english = r"(?:no|without) (?:spoken )?(?:dialogue|dialog|speech)"
    requires_silence = re.search(
        rf"(?:全程|全片|整片|整个(?:短片|影片))\s*{chinese}|(?:^|[。！？\n])\s*{chinese}\s*(?=$|[。！？\n])"
        rf"|\b(?:film|video|clip) (?:has )?{english}\b"
        rf"|(?:^|[.!?\n])\s*{english}\s*(?=$|[.!?\n])|\b{english} throughout\b",
        story,re.I,
    )
    if requires_silence and any(item["dialogue"] for item in draft["beats"]):
        raise ValueError("原始要求为全片无对白，请保留这一设定")


async def verify_revision(llm, original, fixed, current, revised, parse_json):
    changed = [key for key in ("setup","action","result","dialogue") if current[key] != revised[key]]
    if not changed:
        return
    payload = {"brief":original,"fixed":fixed,"changed_fields":changed,"before":current,"after":revised}
    report = await _chat_json(llm,CONSISTENCY,[_text(payload)],parse_json,_CONSISTENCY,max_tokens=320,temperature=0)
    if not isinstance(report,dict):
        raise ValueError("模型没有返回有效的剧本数据，请重试")
    constraint = _str(report.get("constraint"),"constraint",320)
    before = _str(report.get("before"),"before",320)
    changed_text = "\n".join("\n".join(current[key]) if key=="dialogue" else current[key] for key in changed)
    if (constraint and before and before in changed_text
            and (constraint in original or any(constraint in line for line in fixed))):
        raise ValueError("修订改动了指定事件或设定，请调整修改意见后重试")


async def revise(llm, original, draft, index, notes, parse_json):
    if type(index) is not int or not 1 <= index <= len(draft["beats"]):
        raise ValueError("请选择要修改的场次")
    notes = _str(notes,"notes",1600,required=True)
    item = draft["beats"][index-1]
    locked = locked_lines(item,original)
    payload = {"original":original,"draft":draft,"scene":index,"instructions":notes,"locked_dialogue":locked}
    result = await _chat_json(llm,REVISE,[_text(payload)],parse_json,_SCENE,max_tokens=1500,temperature=.35)
    revised = scene(result)
    verify_silence(original,{"beats":[revised]})
    # Compare in order and include duplicate occurrences of user-authored lines.
    remaining = iter(revised["dialogue"])
    if not all(any(candidate==line for candidate in remaining) for line in locked):
        raise ValueError("修订改动了用户原台词，请重新生成修订")
    await verify_revision(llm,original,draft["fixed"],item,revised,parse_json)
    return revised


def _dialogue_runs(groups):
    runs = []
    for group in groups:
        for line in group:
            speaker, text = _speech(line)
            text = re.sub(r"\s+", "", text)
            if not text:
                continue
            if runs and runs[-1][0]==speaker:
                runs[-1] = (speaker,runs[-1][1]+text)
            else:
                runs.append((speaker,text))
    return runs


def verify_storyboard_dialogue(draft, shots):
    expected = _dialogue_runs(item["dialogue"] for item in draft["beats"])
    actual = _dialogue_runs(item["dialogue"] for item in shots)
    if actual != expected:
        raise ValueError("拆镜改动了定稿对白或说话人，请重新拆镜")
