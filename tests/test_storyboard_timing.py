import json
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from oneshot.generation import tools


class StoryboardTiming(IsolatedAsyncioTestCase):
    async def test_idea_to_film_keeps_only_declared_assets_used_by_the_shot(self):
        llm = AsyncMock()
        storyboard = json.dumps({
            "visual_assets":[
                {"key":"kitchen","kind":"scene","name":"厨房","look":"浅木餐桌与左侧窗户"},
                {"key":"mug","kind":"prop","name":"蓝杯","look":"带白色杯柄的蓝杯"},
                {"key":"unused","kind":"prop","name":"汽车","look":"蓝色"},
            ],
            "shots":[
                {"duration":5,"keyframe":"窗旁的蓝杯","visual_asset_keys":["kitchen","mug","mug","bad"]},
                {"duration":5,"keyframe":"厨房全景","visual_asset_keys":["kitchen"]},
            ]})
        draft = {"intent":"从窗边看见蓝杯","fixed":["蓝杯"],
                 "beats":[{"action":"晨光扫过杯柄","result":"把蓝杯从暗处照亮","dialogue":[]}]}
        llm.chat.side_effect = [json.dumps(draft,ensure_ascii=False),storyboard]
        result = await tools.storyboard(llm,Path("."),"厨房和蓝杯",[],None,None,"","16:9",prepare_assets=True)
        self.assertEqual([asset["key"] for asset in result["visual_assets"]],["kitchen","mug"])
        self.assertEqual([shot["visual_asset_keys"] for shot in result["shots"]],[["kitchen","mug"],["kitchen"]])
        self.assertIn("visual_assets",llm.chat.await_args.args[0])
        self.assertIn("你是为 15 到 60 秒短片写作的编剧",llm.chat.await_args_list[0].args[0])
        self.assertIn("用户原台词保留原文与说话人",llm.chat.await_args.args[0])
        self.assertIn("晨光扫过杯柄",llm.chat.await_args.args[1][-1]["text"])
        self.assertIn("厨房和蓝杯",llm.chat.await_args.args[1][0]["text"])

    async def test_unusable_screenplay_draft_keeps_idea_to_film_available(self):
        llm = AsyncMock()
        llm.chat.side_effect = ['{"beats":[{"dialogue":[]}]}', '{"shots":[{"duration":5,"keyframe":"窗外街灯"}]}']
        out = await tools.storyboard(llm,Path("."),"雨夜",[],None,None,"","16:9",prepare_assets=True)
        self.assertEqual(out["shots"][0]["keyframe"],"窗外街灯")
        self.assertEqual(len(llm.chat.await_args.args[1]),1)

    async def test_motion_storyboards_keep_distinct_phases_and_continuity(self):
        llm = AsyncMock()
        llm.chat.return_value = json.dumps({"shots":[
            {"duration":5,"keyframe":"她站在门内","action":["她走出门"],
             "motion_frames":{"middle":"她一脚踩过门槛","middle_time":1.25,"end":"她停在门外"}},
            {"duration":5,"keyframe":"她停在门外","action":["她举起画"],"continues_previous":True,
             "motion_frames":{"middle":"她把画举到眼前","middle_time":4,"end":"她把画举到眼前"}},
        ]})
        result = await tools.storyboard(llm,Path("."),"她走出门举起画",[],None,None,"","16:9",motion_frames=True)
        first,second = result["shots"]
        self.assertIn("motion_frames",llm.chat.await_args.args[0])
        self.assertEqual(first["motion_frames"],{"middle":"她一脚踩过门槛","middle_time":1.25,"end":"她停在门外"})
        self.assertTrue(second["continues_previous"])
        self.assertEqual(second["motion_frames"],{"end":"她把画举到眼前"})

    def test_bad_middle_times_do_not_create_a_middle_frame(self):
        for time in (None, False, 0, 5, "1.2", float("nan")):
            with self.subTest(time=time):
                frames = tools.motion_frame_plan({"middle":"刚离手","middle_time":time,"end":"球贴地滚动"},5,"手握着球")
                self.assertEqual(frames,{"end":"球贴地滚动"})

    def test_visible_action_checkpoint_overrides_generic_middle_picture(self):
        first = "箭尾搭在拉满的弦上"
        end = "弓弦松开，箭已经离开画面右侧"
        evidence = "箭尾与弦分离，沿右侧飞出"
        instant = "弦前半尺有一支水平的箭，右手已张开"
        original = {"keyframe": first, "motion_frames": {"end": end, "middle": first, "middle_time": 2}}
        check = {"evidence": evidence, "moment": instant, "seconds": 1.4}
        shots, failures = tools.storyboard_shots([{**original, "action_check": check}], 5)
        self.assertFalse(failures)
        self.assertEqual(shots[0]["motion_frames"], {"end": end, "middle": instant, "middle_time": 1.4})
        self.assertEqual(shots[0]["action_check"], check)
        shots, _ = tools.storyboard_shots([{**original, "action_check": {**check, "moment": end}}], 5)
        self.assertEqual(shots[0]["motion_frames"], {"end": end})
        self.assertEqual(shots[0]["action_check"], {"evidence": evidence})

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
