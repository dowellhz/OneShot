"""Develop the dramatic action before converting it to production shots."""

import json
import logging

logger = logging.getLogger(__name__)

WRITER = """你是为 15 到 60 秒短片写作的编剧。先写可表演的剧情，拍摄方案由下一步负责。
用原始要求、参考图、人物资料和世界观确定事实。素材名和原台词保持原样。用户写了完整剧本时，
整理其既有动作、对白、顺序与结局。照亮、掉落、看见等明确动作保留原有机制，避免擅自升级为爆炸、
追逐、冲突等事件。用户只给一句创意时，可以补足能让情节成立的细节。

让观众尽早看见人物想做什么，紧接着发生一件会改变局面的事。下一拍由前一拍的动作或选择引起。
结尾用一个具体动作、反应或画面兑现开头的问题。广告、教程或风景片以可见的过程和结果推进，
按题材允许安静的观察或表演，不强加冲突、反转或新人物。短片集中讲一件事，保留停顿与反应的时间。
用演员能表演的动作表达情绪，少写抽象感想和解说。台词简短、有具体对象、目的和人物语气，
不要解释观众已经看见的事。只在原始要求有台词或情节需要时加台词，尊重无对白要求。

只返回一个 JSON 对象，内容用用户的创作语言：
{"intent":"一句话概括片子要给观众的体验","fixed":["必须保留的具体事实、动作、原台词或限制"],
 "beats":[{"setup":"这拍开始时能看到什么","action":"谁做了什么","result":"动作造成的可见变化",
           "evidence":"从成片中能用来确认动作或结局的具体证据",
           "dialogue":["角色名：这一拍的台词"]}]}
按目标时长取舍。15 秒短片通常只有 2 至 3 个节拍，集中在开场事件、它揭开的变化和结局。
同时发生的反应、光影或环境变化写进同一节拍。把真正先后发生的转折分开，第一拍留住后面的事件。
必须出现的参与者逐一对应到各自的动作。名单、背景轮廓和对白提及不能代替明确要求的行动。
无台词用空数组。"""

SHOOTING_EDITOR = """你将收到编剧草稿。先做编辑核对，再输出分镜 JSON：
- 优先落实用户原文、原台词、剧情顺序、参考图和世界观。草稿里不符的内容直接删除或修正。
- 检查因果和节奏。每镜只呈现分配给它的动作，后面的动作留在对应镜头。通过动作和反应兑现结尾。
- 核对必须参与的角色、物件和事件在镜头中都实际发生过。前一镜动作完成后留下可见状态，下一镜从这个结果继续。
- 从目标时长倒推镜头预算。15 秒优先三镜各 5 秒。先删草稿擅自补入的走动、摸索和铺垫，
  保留原文的关键动作与台词。如果原文确实需要更多时间，再增加时长。
- 删掉解释画面的新增台词和重复的剧情信息。用户原台词保留原文与说话人，台词要能在镜头时长内说完。
- 一条动作写一个能完成的可见变化。与主动作同时发生的光影、水流或背景反应可写在该动作同一行，
  给真正发生在后面的动作单独一行。首帧只写动作开始前的状态，结尾写动作造成的状态。
- 在重要镜头填写 action_check，例如 {"evidence":"箭确实与弓弦分离，沿画面右侧飞出","moment":"松开的手在弦旁，箭尾在弓前半尺，箭身水平向右","seconds":1.4}。
  evidence 是怎样从成片确认该事件发生。只有必须看清短促瞬间才提供 moment 和 seconds。瞬间画面要有可见的距离、接触或落点。
- 有后果的物件交接、脱手或松弦动作，优先分配一个容易看清的角度。避免尾帧再次回到手中或画面外的位置无故反向。
- 旁白只在明确要求旁白时使用。无对白的段落保留为空数组。
- 分镜文字跟随用户的创作语言。用户提供的台词保留原语言，JSON 字段名保持固定。"""


async def screenplay_draft(llm, content, parse_json):
    """A drafting failure can fall back to the ordinary storyboard request."""
    try:
        draft = parse_json(await llm.chat(WRITER, content, max_tokens=2000, temperature=.55))
        if not isinstance(draft, dict) or not isinstance(draft.get("beats"), list) or not draft["beats"]:
            raise ValueError("missing screenplay beats")
        if any(not isinstance(beat, dict) or not isinstance(beat.get("action"), str)
               or not beat["action"].strip() for beat in draft["beats"]):
            raise ValueError("invalid screenplay beat")
    except (RuntimeError, ValueError) as error:
        logger.warning("Screenplay draft unavailable (%s), using the regular storyboard flow", type(error).__name__)
        return None
    return {"type": "text", "text": "以下是编剧草稿，请结合原始输入完成编辑和分镜。\n"
            + json.dumps(draft, ensure_ascii=False)}
