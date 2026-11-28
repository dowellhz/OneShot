import asyncio
import json
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from chat_fixture import ChatFixture
from oneshot.generation import screenplay_workbench as workbench
from oneshot.generation import screenplay_planning, tools, wizard_script
import server


DRAFT = {
    "intent": "乔纳看见自己的名字",
    "fixed": ["女人抱的是米拉的画"],
    "beats": [
        {"setup": "十七号门口", "action": "女人抱画出门", "result": "乔纳靠近",
         "evidence": "包装纸带有署名", "dialogue": ["女人：你也是来看米拉的？", "乔纳：对。你买了她哪一张？"]},
        {"action": "女人翻转画作", "result": "背面出现乔纳的名字", "dialogue": []},
    ],
}
BRIEF = "女人问『你也是来看米拉的？』乔纳答『对。你买了她哪一张？』"


class WorkbenchRequests(ChatFixture):
    async def test_operations_are_receipted_and_revision_validates_the_original_dialogue(self):
        self.board["nodes"].append({"id": "screenplay", "type": "script", "data": {}})
        server.board_path("test").write_text(json.dumps(self.board))
        payload = {"board": "test", "script": "screenplay", "story": BRIEF, "target_seconds": 30}
        problem = {"scene": 1, "kind": "motivation", "evidence": "乔纳靠近", "problem": "缺少反应",
                   "suggestion": "让乔纳先停一下"}
        manufactured = {**problem, "evidence": "包装纸带有署名"}
        revised = {**DRAFT["beats"][0], "action": "女人抱画出门，乔纳先停一下"}
        missing = {**revised,"dialogue":revised["dialogue"][:-1]}
        consistency = {"constraint":"","before":""}
        dropped = {**revised,"action":"女人空手走出门"}
        conflict = {"constraint":"女人抱的是米拉的画","before":"女人抱画出门"}
        replies = [DRAFT, {"notes": [manufactured, problem]}, missing, revised, consistency, dropped, conflict]
        chat = AsyncMock(side_effect=["not JSON", *[json.dumps(reply,ensure_ascii=False) for reply in replies]])

        async def run(operation, suffix="", **changes):
            body = {**payload,"key":"screenplay-"+operation+suffix,"operation":operation,**changes}
            response = await self.client.post("/api/wizard/screenplay",json=body)
            self.assertEqual(await response.json(),{"state":"running"})
            tasks = tuple(self.app["remote_tasks"])
            if tasks:
                await asyncio.wait_for(asyncio.gather(*tasks), 2)
            return await (await self.client.post("/api/wizard/screenplay",json=body)).json()

        llm = self.app["llm"]
        with patch.object(llm,"available",return_value=True), patch.object(llm,"chat",chat,create=True):
            wrote = await run("write")
            draft = wrote["result"]["manuscript"]
            self.assertEqual(draft, workbench.manuscript(DRAFT))
            self.assertEqual(chat.await_count,2)
            self.assertEqual(chat.await_args.kwargs["temperature"],0)
            self.assertIn("beats",chat.await_args.kwargs["response_schema"]["properties"])
            checked = await run("review",manuscript=draft)
            self.assertEqual(checked["result"]["notes"],[problem])
            reader_content = chat.await_args.args[1][0]["text"]
            for value in (BRIEF, DRAFT["intent"], DRAFT["fixed"][0], manufactured["evidence"]):
                self.assertNotIn(value,reader_content)
            rejected = await run("revise","-bad",manuscript=draft,scene=1,notes="让乔纳先停一下")
            self.assertEqual(rejected["state"],"error")
            accepted = await run("revise","-good",manuscript=draft,scene=1,notes="让乔纳先停一下")
            self.assertEqual(accepted["result"],{"scene":1,"scene_data":workbench.scene(revised)})
            rejected = await run("revise","-changes-fact",manuscript=draft,scene=1,notes="让她空手出门")
            self.assertEqual(rejected["error"],"修订改动了指定事件或设定，请调整修改意见后重试")
            built = AsyncMock(return_value={"shots":[]})
            with patch.object(wizard_script.prompts,"build_storyboard",built):
                result = await run("compile",manuscript=draft)
                self.assertFalse(result["result"]["screenplay_audit"]["ok"])
                self.assertNotIn("shots",result["result"])
                self.assertEqual(built.await_count,3)
                self.assertEqual(built.await_args.kwargs["approved_screenplay"],draft)
                self.assertFalse(built.await_args.kwargs["screenplay_feedback"]["ok"])


class ApprovedDialogue(IsolatedAsyncioTestCase):
    def test_explicit_silence_is_preserved_in_both_languages(self):
        draft = workbench.manuscript(DRAFT)
        for brief in ("15秒短片。全程无对白。", "A short film without spoken dialogue."):
            with self.subTest(brief=brief), self.assertRaisesRegex(ValueError, "无对白"):
                workbench.verify_silence(brief,draft)
        workbench.verify_silence(BRIEF,draft)
        workbench.verify_silence("第一镜无对白，第二镜再开口。",draft)

    def test_source_dialogue_stays_locked_when_a_quote_spans_scenes(self):
        for line in ("乔纳：对。", "乔纳：你买了她哪一张？"):
            with self.subTest(line=line):
                self.assertEqual(workbench.locked_lines({"dialogue":[line]},BRIEF),[line])

    async def test_camera_evidence_alone_does_not_change_events(self):
        llm = AsyncMock()
        beat = workbench.manuscript(DRAFT)["beats"][0]
        await workbench.verify_revision(llm,BRIEF,DRAFT["fixed"],beat,{**beat,"evidence":"近景看清署名"},tools.parse_json)
        llm.chat.assert_not_awaited()

    def test_matches_text_and_speaker_across_shots(self):
        draft = workbench.manuscript(DRAFT)
        first, second = DRAFT["beats"][0]["dialogue"]
        shots = [{"dialogue":[first,"乔纳（点头）：对。"]},{"dialogue":["乔纳：你买了她哪一张？"]}]
        workbench.verify_storyboard_dialogue(draft,shots)
        for changed in ([], [second,first], [first,second.replace("乔纳","女人")],
                        [first,second.replace("你买了她哪一张","你选了哪一张")],
                        [first,second,"路人：你说什么？"]):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                workbench.verify_storyboard_dialogue(draft,[{"dialogue":changed}])


    async def test_compile_uses_the_approved_draft_and_refuses_a_changed_speaker(self):
        llm = AsyncMock()
        lines = DRAFT["beats"][0]["dialogue"]
        shot = {"duration":8,"action":["女人抱画出门"],"dialogue":lines}
        llm.chat.side_effect = [json.dumps({"shots":[shot]}),
                                json.dumps({"shots":[{**shot,"dialogue":lines[::-1]}]})]
        draft = workbench.manuscript(DRAFT)
        args = (llm,Path("."),BRIEF,[],None,None,"","16:9")
        planned = await tools.storyboard(*args,approved_screenplay=draft,prepare_assets=True)
        self.assertEqual(llm.chat.await_count,1)
        self.assertEqual(planned["shots"][0]["dialogue"],lines)
        self.assertIn("背面出现乔纳的名字",llm.chat.await_args.args[1][-1]["text"])
        with self.assertRaisesRegex(ValueError,"拆镜改动了定稿对白"):
            await tools.storyboard(*args,approved_screenplay=draft,prepare_assets=True)


class SceneCoverage(IsolatedAsyncioTestCase):
    def setUp(self):
        self.draft = workbench.manuscript({"beats":[
            {"action":"掷球","result":"球落地"},{"action":"狗叼球","result":"狗交还绿球"}]})
        self.shots = [
            {"script_scene":1,"action":["掷球","球落地"],"keyframe":"女子持球","dialogue":[]},
            {"script_scene":2,"action":["狗叼球","狗交还绿球"],"keyframe":"球在地上","dialogue":[]},
        ]
        self.mapping = {"events":[{"id":index,"locations":[{"shot":1+(index-1)//2,"action":1+(index-1)%2,"quote":event["text"]}],
                                  "premature":[]} for index,event in enumerate(screenplay_planning.required_events(self.draft),1)]}

    def test_coverage_blocks_omissions_repetitions_future_events_and_fabricated_evidence(self):
        self.assertTrue(screenplay_planning.evaluate(self.draft,self.shots,self.mapping)["ok"])
        self.shots[0]["action"].append("狗叼球")
        self.shots[0]["keyframe"] = "狗已把绿球交还"
        self.mapping["events"][1]["locations"] = []
        self.mapping["events"][2]["locations"].append({"shot":1,"action":3,"quote":"狗叼球"})
        self.mapping["events"][3]["premature"].append({"shot":1,"quote":"狗已把绿球交还"})
        self.mapping["events"][0]["locations"][0]["quote"] = "不存在的动作"
        report = screenplay_planning.evaluate(self.draft,self.shots,self.mapping)
        self.assertFalse(report["ok"])
        self.assertEqual([event["issues"] for event in report["events"]],
                         [["evidence","missing"],["missing"],["duplicate"],["premature"]])
        self.mapping["events"][0]["locations"][0]["quote"] = "掷球"
        mixed = screenplay_planning.evaluate(self.draft,self.shots,self.mapping)
        self.assertIn("order",mixed["events"][2]["issues"])

    def test_carrying_the_ball_cannot_stand_in_for_picking_it_up(self):
        self.draft["beats"][1]["action"] = "狗从地上叼起球"
        self.shots[1]["action"][0] = "狗嘴里叼着球跑"
        self.mapping["events"][2]["locations"][0]["quote"] = "嘴里叼着球"
        report = screenplay_planning.evaluate(self.draft,self.shots,self.mapping)
        self.assertEqual(report["events"][2]["issues"],["evidence","missing"])

    def test_dialogue_cannot_move_to_another_scene(self):
        self.draft["beats"][1]["dialogue"] = ["她：过来。"]
        self.shots[0]["dialogue"] = ["她：过来。"]
        result = screenplay_planning.evaluate(self.draft,self.shots,self.mapping)
        self.assertEqual(result["issue"],"对白没有保留在定稿指定的场次")

    async def test_retry_only_installs_checked_storyboard(self):
        first_shots = [{**self.shots[0],"action":["掷球","球落地","狗叼球"]},self.shots[1]]
        build = AsyncMock(side_effect=[{"shots":first_shots},{"shots":self.shots}])
        llm = AsyncMock()
        wrong = json.loads(json.dumps(self.mapping))
        wrong["events"][2]["locations"] = [{"shot":1,"action":3,"quote":"狗叼球"}]
        llm.chat.side_effect = [json.dumps(wrong,ensure_ascii=False),json.dumps(self.mapping,ensure_ascii=False)]
        out = await screenplay_planning.compile_checked(build,llm,self.draft,tools.parse_json)
        self.assertTrue(out["screenplay_audit"]["ok"])
        self.assertEqual(out["shots"],self.shots)
        self.assertFalse(build.await_args.args[0]["ok"])

    async def test_outline_keeps_user_duration_and_requires_events(self):
        llm = AsyncMock()
        raw = {"goal":"捡球","events":["抛球","叼球"],"ending":"把球送回手中","fixed":["只有一只狗"],"seconds":60}
        llm.chat.return_value = json.dumps(raw,ensure_ascii=False)
        result = await screenplay_planning.outline(llm,[],tools.parse_json,15)
        self.assertEqual(result,{**raw,"seconds":15})
        with self.assertRaises(ValueError):
            screenplay_planning.normalize_outline({**raw,"events":[]})
