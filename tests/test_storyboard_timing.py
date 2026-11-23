import json
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

import tools


class StoryboardTiming(IsolatedAsyncioTestCase):
    async def test_replans_a_long_take_into_separate_usable_shots(self):
        actions = ["走到窗边","拉开窗帘","找到钥匙","走到门口","拿起大衣","打开门","回身关灯"]
        single = {"shots":[{"duration":5,"action":actions,"keyframe":"客厅门边"}]}
        split = {"shots":[
            {"duration":8,"action":actions[:3],"keyframe":"客厅门边"},
            {"duration":9,"action":actions[3:],"keyframe":"握钥匙站在窗边"},
        ]}
        llm = AsyncMock()
        llm.chat.side_effect = [json.dumps(single),json.dumps(split)]
        result = await tools.storyboard(llm,Path("."),"雨夜离家",[],None,None,"","16:9",15)
        self.assertEqual([shot["duration"] for shot in result["shots"]],[8,10])
        self.assertEqual(result["planned_seconds"],18)
        self.assertEqual([beat for shot in result["shots"] for beat in shot["action"]],actions)
        self.assertEqual(len({shot["keyframe"] for shot in result["shots"]}),2)
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
        self.assertEqual(llm.chat.await_count,2)
