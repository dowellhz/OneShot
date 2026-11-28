"""Compare plain and outline-confirmed drafts using the same local model.

Run from the repository root with an isolated H3_LLM_PORT and a free GPU,
or pass --cpu. Output JSON contains anonymized A/B drafts and a separate
answer key so a reader can compare before consulting the model's scores.
"""

import argparse
import asyncio
import json
import random
from pathlib import Path

import aiohttp

from oneshot.generation import screenplay_planning as planning, screenplay_workbench as workbench, tools
from oneshot.generation.rewriter import LLM


CASES = (
    ("画市", 30, "乔纳在十七号看画间门口等。抱画女人走出门，问『你也是来看米拉的？』乔纳答『对。你买了她哪一张？』她没有马上回答，把画转过去。包装背面露出米拉写给乔纳的名字。",
     "乔纳等在十七号门口", ["抱画女人出门及问答", "女人停顿后转画"], "包装背面露出乔纳的名字", ["保留两句原台词及说话人", "转画之后才看到名字"]),
    ("企鹅海战", 15, "企鹅水手举起信号弹。一阵浪把它打落到船底，光照出积水里的木梁裂缝。船长按帽堵漏，其他企鹅舀水。全程无对白。",
     "水手遇见船底进水", ["水手举起信号弹", "浪撞落信号弹", "积水中的光照出裂缝"], "船长拿帽子堵漏，其他企鹅舀水", ["浪打落信号弹，不能变成主动抛掷", "无对白", "最终使用帽子"]),
    ("草坪上的白西高地", 15, "草坪上只有一名女子、一只白色西高地和一颗绿球。女子掷球，球落地滚动，狗追上叼球，再把球带回她手中。全程无对白。",
     "女子与白色西高地玩捡球", ["女子掷球", "球落地滚动", "狗追上叼球"], "狗把球带回女子手中", ["一人一狗一球", "落地后才叼球", "无对白"]),
    ("三只猫的果茶", 15, "戴黑蝴蝶结的猫妈妈和小猫在餐桌边。猫爸爸剪短杯里的红吸管，小猫这才喝到果茶。猫妈妈说『慢慢喝。』全片只有这句台词。",
     "帮助小猫喝到果茶", ["小猫够不到吸管", "猫爸爸剪短红吸管", "小猫喝到果茶"], "猫妈妈说『慢慢喝。』", ["三只猫各自参与", "先剪再喝", "唯一台词由猫妈妈说"]),
    ("清晨手冲", 15, "早餐前从手摇研磨开始，再把热水注入手冲壶。窗边的女孩端杯尝第一口。画面最后停在杯口蒸汽，无对白。",
     "把手冲过程拍清楚", ["研磨咖啡豆", "倒热水", "女孩喝第一口"], "杯口蒸汽", ["顺序不能提前", "无对白"]),
    ("洱海骑行", 30, "女孩骑电动车沿洱海，经过白墙青瓦的村子后在露台停下，看太阳落进苍山。保持旅行随笔的节奏，无对白，无意外或追逐。",
     "记录女孩沿洱海短途骑行", ["沿洱海骑行", "经过白墙青瓦村落", "在露台停下"], "看夕阳落进苍山", ["无意外或追逐", "无对白"]),
)

JUDGE = """先逐项判断每稿是否保留 brief 和 fixed 中明确要求的动作、顺序、对白、角色道具和结尾。
凡改掉或缺少必须内容则符合=false，并引用正文中能够证明的片段或说明缺少哪一项。
只在通过约束时比较人物动机、因果、对白、可拍性，各项 1–5 分，相同可以同分。
返回 JSON，A、B 分别包含 passed（布尔）、reason（简短理由）、craft（四项总分；未通过时为0）。"""


async def main(args):
    async with aiohttp.ClientSession() as http:
        llm = LLM("http://127.0.0.1:1",lambda:http)
        class Model:
            async def chat(self, system, content, max_tokens=2000, temperature=.6, *, response_schema=None):
                return await llm._local_chat(system,content,max_tokens,temperature,force_cpu=args.cpu,response_schema=response_schema)
        model = Model()
        author_key, comparisons, evaluation = {}, {}, {}
        try:
            for index,(name,seconds,brief,goal,events,ending,fixed) in enumerate(CASES,1):
                print(name,flush=True)
                outline = planning.normalize_outline(dict(goal=goal,events=events,ending=ending,fixed=fixed,seconds=seconds))
                content = workbench.context(Path("."),brief,[],None,None,"","16:9",seconds)
                plain = await workbench.write(model,content,tools.parse_json)
                guided = await workbench.write(model,[*content,workbench._text({"confirmed_outline":outline})],tools.parse_json)
                variants = [("plain",plain),("outline",guided)]
                random.Random(index+92).shuffle(variants)
                variants = dict(zip(("A","B"),variants))
                author_key[name] = {label:pair[0] for label,pair in variants.items()}
                comparisons[name] = {"brief":brief,"fixed":fixed,**{label:pair[1] for label,pair in variants.items()}}
                grade = workbench._object({"passed":{"type":"boolean"},"reason":{"type":"string"},"craft":{"type":"integer"}})
                schema = workbench._object({"A":grade,"B":grade})
                evaluation[name] = await workbench._chat_json(model,JUDGE,[workbench._text(comparisons[name])],tools.parse_json,
                                                               schema,max_tokens=850,temperature=0)
                print(json.dumps({"case":name,"blind":evaluation[name],"key":author_key[name],"device":llm.device},ensure_ascii=False),flush=True)
                args.output.write_text(json.dumps({"comparisons":comparisons,"scores":evaluation,"key":author_key},ensure_ascii=False,indent=2))
        finally:
            llm.stop()


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--cpu",action="store_true")
    parser.add_argument("--output",required=True,type=Path)
    asyncio.run(main(parser.parse_args()))
