import json
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

import tools


class StoryboardTiming(IsolatedAsyncioTestCase):
    async def test_replans_a_long_take_into_separate_usable_shots(self):
        actions = ["走到窗边","拉开窗帘","找到钥匙","走到门口","拿起大衣","打开门","回身关灯"]
        single = {"shots":[{"duration":5,"action":actions,"keyframe":"客厅门边"},
                           {"duration":5,"action":["雨落在窗上"],"keyframe":"窗外街灯"}]}
        split = {"replacements":[{"shot":1,"shots":[
            {"duration":8,"action":actions[:3],"keyframe":"客厅门边"},
            {"duration":9,"action":actions[3:],"keyframe":"握钥匙站在窗边"},
        ]}]}
        llm = AsyncMock()
        llm.chat.side_effect = [json.dumps(single),json.dumps(split)]
        result = await tools.storyboard(llm,Path("."),"雨夜离家",[],None,None,"","16:9",15)
        self.assertEqual([shot["duration"] for shot in result["shots"]],[8,10,5])
        self.assertEqual(result["planned_seconds"],23)
        self.assertEqual([beat for shot in result["shots"] for beat in shot["action"]],actions+["雨落在窗上"])
        self.assertEqual([shot["keyframe"] for shot in result["shots"]],["客厅门边","握钥匙站在窗边","窗外街灯"])
        self.assertIn("全片目标时长：约 15 秒",llm.chat.await_args_list[0].args[1][0]["text"])
        self.assertIn("needed_seconds",llm.chat.await_args.args[1][-1]["text"])

    async def test_an_underestimated_shot_rounds_up_without_retry(self):
        llm = AsyncMock()
        dialogue = "雨马上就到你再等一会我放下东西就过来"
        llm.chat.return_value = json.dumps({"shots":[{"duration":5,"action":["说完放下伞"],"dialogue":[dialogue]}]})
        result = await tools.storyboard(llm,Path("."),"雨夜",[],None,5,"","16:9")
        self.assertEqual(result["shots"][0]["duration"],8)
        self.assertEqual(result["shots"][0]["dialogue"],[dialogue])
        self.assertEqual(llm.chat.await_count,1)

    async def test_rejects_a_duration_the_model_could_not_split(self):
        llm = AsyncMock()
        llm.chat.return_value = json.dumps({"shots":[{"duration":20,"action":["看向窗外"]}]})
        with self.assertRaisesRegex(ValueError,"超过单镜 14 秒"):
            await tools.storyboard(llm,Path("."),"雨夜",[],None,None,"","16:9")
        self.assertEqual(llm.chat.await_count,3)

    async def test_split_requires_enough_total_time_and_preserves_the_speaker(self):
        dialogue = "林森：先推开门，再看看屋里。"
        original = {"shots":[{"duration":30,"action":["开门"],"dialogue":[dialogue]}]}
        proposed = [
            {"duration":10,"dialogue":["林森：先推开门"],"action":["开门"],"keyframe":"手按门把"},
            {"duration":10,"dialogue":["林森：再看看屋里"],"keyframe":"侧身看屋内"},
            {"duration":10,"keyframe":"屋内全景"},
        ]

        def response(items):
            return json.dumps({"replacements":[{"shot":1,"shots":items}]})

        llm = AsyncMock()
        llm.chat.side_effect = [json.dumps(original),response(proposed[:2]),response(proposed[:2])]
        with self.assertRaisesRegex(ValueError,"总时长不足"):
            await tools.storyboard(llm,Path("."),"进屋",[],None,None,"","16:9")
        changed_speaker = response([proposed[0],{**proposed[1],"dialogue":["另一位：再看看屋里"]},proposed[2]])
        llm.chat.side_effect = [json.dumps(original),changed_speaker,changed_speaker]
        with self.assertRaisesRegex(ValueError,"改变了原动作或台词"):
            await tools.storyboard(llm,Path("."),"进屋",[],None,None,"","16:9")
        llm.chat.side_effect = [json.dumps(original),response(proposed[:2]),response(proposed)]
        result = await tools.storyboard(llm,Path("."),"进屋",[],None,None,"","16:9")
        self.assertEqual(result["planned_seconds"],30)
        self.assertEqual(len(result["shots"]),3)
        self.assertIn("总时长不足",llm.chat.await_args.args[1][-1]["text"])
