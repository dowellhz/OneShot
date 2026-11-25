"""Source analysis, shot boundaries, and session binding."""

from unittest.mock import AsyncMock, patch
import json
import time

from PIL import Image
from aiohttp import web
import numpy as np

from oneshot.editing import image_editor
from oneshot.editing import video_remake
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
from oneshot.web import http as http_errors
import server

from remake_fixture import RemakeFixture, Request


class VideoRemakeIntegration(RemakeFixture):
    async def test_remake_uses_the_next_long_enough_duration_and_splits_at_model_limit(self):
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test')")
        source = self.make_clip("model-limited",12,(100,90,80),300)
        alternate = "input:h3studio/alternate.mp4"
        server.board_path("test").write_text(json.dumps({"owner":7,"nodes":[
            {"id":"n3","type":"video","cur":1,"versions":[{"ref":source},{"ref":alternate}]}]}))
        key = (7,"test","n3",source)
        first = {"w":64,"h":64,"ref":self.source["ref"],"at":0,"approved":"approved-frame","previews":[
            {"job":"approved-frame","state":"done","ref":self.source["ref"],"asset":{"name":"测试人物"}}]}
        shot = {"start":0,"end":12,"summary":{},"frames":{"first":first}}
        video_remake.save(key,{"shots":[shot]})
        provider = server.providers.save(None,"kling","有限时长服务",{}, {},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":"kling-2.6"}])
        opened = json.loads((await server.remake(Request(source,self.user))).body)
        self.assertEqual(opened["video_limits"],[10])
        submit = AsyncMock(return_value=web.json_response({"ids":["remake-10"]}))
        with patch.object(generation_requests,"generate_request",submit):
            with self.assertRaises(web.HTTPBadRequest) as error:
                await server.remake(Request(source,self.user,{"action":"generate_video","shot":0}))
            self.assertIn("10 秒",error.exception.text)
            submit.assert_not_awaited()
            await video_remake.generate_shot(Request(source,self.user),server,key,{**shot,"end":6.5},{})
            self.assertEqual(submit.await_args.args[1]["duration"],10)
        assistant = server.agent_chat.AgentService({}, server)
        run = {"board_id":"test","data":{"bindings":{"n3":source}}}
        status = await assistant.execute(run, self.user, "status", "video_remake_status", {"node_id":"n3"})
        self.assertTrue(status["shots"][0]["requires_split"])
        args = {"node_id":"n3","shot":1,"cut_revision":status["cut_revision"]}
        with self.assertRaisesRegex(server.agent_chat.ToolError, "剪辑点已更新"):
            await assistant.execute(run, self.user, "stale", "video_remake_split_long", {**args,"cut_revision":1})
        self.assertEqual(len(video_remake.load(key)["shots"]),1)
        with patch.object(http_errors,"llm_call",side_effect=self.no_vision):
            split = await assistant.execute(run, self.user, "split", "video_remake_split_long", args)
        self.assertEqual(split["cut_revision"],1)
        self.assertEqual(split["split_shots"],[
            {"number":1,"start":0,"end":6},{"number":2,"start":6,"end":12}])
        self.assertFalse(any(item["requires_split"] for item in split["shots"]))
        self.assertEqual(split["remake"],{"node_id":"n3","source_ref":source,"shot_number":1,"shot_start":0})
        self.assertTrue(split["can_undo_cut"])
        self.assertEqual([(item["start"],item["end"]) for item in video_remake.load(key)["shots"]],[(0,6),(6,12)])
        self.assertIsNone(video_remake.load((*key[:3],alternate)))

    async def test_analysis_finds_color_cuts_on_the_render_timeline_without_splitting_flashes(self):
        def colors(tick):
            if tick in (18, 19):
                return (255, 255, 255)
            if tick < 37:
                return (200, 20, 20)
            if tick < 49:
                return (20, 112, 20)
            return (25, 25, 210)

        source = self.make_clip("precise-cuts", seconds=3, color=colors, frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
            response = await server.remake(Request(source, self.user, {"action":"analyze"}))
        shots = json.loads(response.body)["shots"]
        self.assertEqual([round(shot["start"] * 24) for shot in shots], [0, 37, 49])
        self.assertEqual([round(shot["end"] * 24) for shot in shots], [37, 49, 72])
        for index, tick in enumerate((0, 37, 49)):
            record = shots[index]["frames"]["first"]
            self.assertAlmostEqual(record["at"], tick / 24)
            pixels = image_editor.load(server.COMFY_DIR, record["ref"]).getpixel((32, 32))
            self.assertTrue(np.allclose(pixels[:3], colors(tick), atol=5))
        middle = shots[0]["frames"]["middle"]
        self.assertNotIn(round(middle["at"] * 24), (18, 19))

        class MotionVision:
            async def chat(self, system, content, **kwargs):
                images = [item for item in content if item["type"] == "image_url"]
                self_test.assertEqual(len(images), 6)
                self_test.assertIn("镜头内第 0.458 秒", content[-2]["text"])
                return json.dumps({"camera":"固定机位", "beats":[
                    {"sample":6,"action":"结束停留"}, {"sample":2,"action":"在画面右侧"},
                    {"sample":2,"action":"重复描述"}, {"sample":48,"action":"无效时间点"},
                ]})

        self_test = self
        request = Request(source, self.user, {"action":"analyze_motion", "shot":1})
        request.app["llm"] = MotionVision()
        analyzed = json.loads((await server.remake(request)).body)
        notes = analyzed["shots"][1]["motion_analysis"]
        self.assertEqual(notes, {"camera":"固定机位", "beats":[{"tick":2,"action":"在画面右侧"},
            {"tick":11,"action":"结束停留"}], "source_person":None})
        reopened = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(reopened["shots"][1]["motion_analysis"], notes)

    async def test_analyzed_people_and_motion_follow_shot_numbers_when_results_are_incomplete(self):
        colors = [(200, 20, 20), (20, 200, 20), (20, 20, 200), (200, 180, 20)]
        source = self.make_clip("missing-analysis", seconds=4, color=lambda tick: colors[tick // 24],
                                frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))

        class Vision:
            via = "test vision"
            retry = False
            offline = False

            def available(self):
                return True

            async def chat(self, system, content, **kwargs):
                if self.offline:
                    raise RuntimeError("visual model unavailable")
                if self.retry:
                    return json.dumps({"characters":[{"name":"红衣人", "look":"错误外貌"}, {"name":"绿衣人", "look":"穿绿衣"}],
                                       "shots":[{"shot":1,"camera":"错误机位"}, {"shot":2,"characters":["绿衣人"]},
                                                {"shot":3,"camera":"横移"}, {"shot":4,"camera":"错误机位"}]})
                return json.dumps({"characters":[{"name":"红衣人", "look":"穿红衣"}, {"name":"黄衣人", "look":"穿黄衣"}],
                                   "shots":[
                    {"shot":4, "characters":"黄衣人", "camera":"缓慢拉远", "action":["抬手"]},
                    {"shot":1, "characters":["红衣人"], "camera":"固定机位", "action":["转头"]},
                    {"shot":2, "characters":["红衣人"]},
                    {"shot":2, "characters":["黄衣人"]},
                    {"shot":5, "action":["无对应镜头"]},
                ]})

        vision = Vision()
        req = Request(source, self.user, {"action":"analyze"})
        req.app["llm"] = vision
        analyzed = json.loads((await server.remake(req)).body)
        self.assertIn("镜头 2、3 缺少视觉分析", analyzed["warning"])
        self.assertEqual([(s["start"], s["end"]) for s in analyzed["shots"]], [(0,1), (1,2), (2,3), (3,4)])
        summaries = [shot["summary"] for shot in analyzed["shots"]]
        self.assertEqual([s["characters"] for s in summaries], [["红衣人"], [], [], ["黄衣人"]])
        self.assertEqual([s["camera"] for s in summaries], ["固定机位", "", "", "缓慢拉远"])
        self.assertEqual([s["action"] for s in summaries], [["转头"], [], [], ["抬手"]])
        reopened = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(reopened["shots"], analyzed["shots"])
        self.assertEqual(reopened["warning"], analyzed["warning"])
        marked = json.loads((await server.remake(Request(source, self.user, {"action":"keep", "shot":1}))).body)
        retry = Request(source, self.user, {"action":"retry_analysis"})
        retry.app["llm"] = vision
        vision.offline = True
        failed = json.loads((await server.remake(retry)).body)
        self.assertEqual(failed["shots"], marked["shots"])
        self.assertEqual(failed["warning"], marked["warning"])
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test')")
        service = server.agent_chat.AgentService({"llm":vision, "creative_memory":server.creative_memory.Store(server)}, server)
        session_id, run_id = "retry-chat", "retry-run"
        run_data = {"bindings":{"n3":source}}
        db.conn().executescript(server.agent_chat.SCHEMA)
        now = time.time()
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", session_id, 7, "test", "重试分析", now, now)
        db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)", run_id, session_id, 7, "test", run_id,
               "running", json.dumps(run_data), None, now, now)
        service.emit(session_id, run_id, "model", {"role":"user", "content":"补充缺失的镜头分析"})
        before = await service.execute({"board_id":"test","data":run_data}, self.user, "status",
                                       "video_remake_status", {"node_id":"n3"})
        self.assertEqual(before["missing_analysis_shots"], [2,3])
        self.assertIn("镜头 2、3 缺少视觉分析", before["text"])
        vision.offline = False
        vision.retry = True
        tool_call = {
            "role":"assistant", "content":None, "tool_calls":[{
                "id":"retry-analysis", "type":"function", "function":{"name":"video_remake_analyze",
                    "arguments":json.dumps({"node_id":"n3", "retry":True})},
            }],
        }
        with patch.object(service, "model", side_effect=[tool_call, {"role":"assistant", "content":"分析已补齐"}]):
            await service.work(run_id)
        self.assertEqual(db.one("SELECT state,error FROM chat_runs WHERE id=?", run_id), {"state":"done","error":None})
        event = db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='tool_end'", run_id)
        result = json.loads(event["data"])["result"]
        self.assertEqual(result["missing_analysis_shots"], [])
        self.assertIsNone(result["warning"])
        self.assertIn("已补充 2 个镜头的视觉分析", result["text"])
        recovered = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertFalse(recovered["warning"])
        self.assertEqual(recovered["shots"][0], marked["shots"][0])
        self.assertEqual(recovered["shots"][3], marked["shots"][3])
        self.assertTrue(recovered["shots"][1]["keep_original"])
        self.assertEqual(recovered["shots"][1]["summary"]["characters"], ["绿衣人"])
        self.assertEqual(recovered["shots"][2]["summary"]["camera"], "横移")
        self.assertEqual([shot["frames"] for shot in recovered["shots"]], [shot["frames"] for shot in marked["shots"]])
        self.assertEqual(recovered["source_people"], [*marked["source_people"], {"name":"绿衣人", "look":"穿绿衣"}])

    async def test_long_shot_splits_into_balanced_segments_and_can_be_undone(self):
        source = self.make_clip("long-shot", seconds=30, color=lambda tick: (20 + (tick // 232) * 50, 20, 20), frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        key = (7, "test", "n3", source)
        split_frames = video_remake.original_frames(server, source, {0, 232, 400, 696})
        first, tail = split_frames[0], split_frames[696]
        first["previews"] = [{"job":"long-preview", "state":"queued"}]
        first["approved"] = "long-preview"
        at_cut = {**split_frames[232], "correction_tick":232, "selection":{"mask":self.source["ref"]}}
        in_segment = {**split_frames[400], "correction_tick":400, "person_absent":{"source":"人物甲"}}
        original = {"shots":[
            {"start":0, "end":29, "summary":{}, "frames":{
                "first":first, "correction-232":at_cut, "correction-400":in_segment,
            }},
            {"start":29, "end":30, "summary":{}, "frames":{"first":tail}},
        ], "mapping":{"source":"人物甲", "asset":"role", "shots":[0]}}
        video_remake.save(key, original)

        async def act(action, revision=0):
            request = Request(source, self.user, {"action":action, "shot":0, "cut_revision":revision})
            return json.loads((await server.remake(request)).body)

        with self.assertRaises(web.HTTPConflict):
            await act("split_long_shot")
        db.task_start(id="long-preview", user_id=7, state="done", outputs=[self.source["ref"]])
        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
            split = await act("split_long_shot")
        pairs = [(round(shot["start"] * 24), round(shot["end"] * 24)) for shot in split["shots"]]
        self.assertEqual(pairs, [(0,232), (232,464), (464,696), (696,720)])
        self.assertEqual(split["mapping"]["shots"], [0,1,2])
        self.assertEqual(split["selected_shot"], 0)
        self.assertEqual(split["shots"][0]["frames"]["first"]["approved"], "long-preview")
        self.assertEqual(split["shots"][0]["frames"]["first"]["ref"], split_frames[0]["ref"])
        second = split["shots"][1]["frames"]
        self.assertEqual(second["first"]["ref"], at_cut["ref"])
        self.assertEqual(second["first"]["selection"], at_cut["selection"])
        self.assertNotIn("correction_tick", second["first"])
        self.assertNotIn("correction-232", second)
        self.assertEqual(second["correction-400"], in_segment)
        self.assertNotIn("correction-400", split["shots"][0]["frames"])
        for index in range(3):
            image = image_editor.load(server.COMFY_DIR, split["shots"][index]["frames"]["first"]["ref"])
            self.assertAlmostEqual(image.getpixel((32,32))[0], 20 + index * 50, delta=5)
        with self.assertRaises(web.HTTPBadRequest):
            await act("split_long_shot", revision=1)
        undone = await act("undo_cut", revision=1)
        self.assertEqual([(shot["start"], shot["end"]) for shot in undone["shots"]], [(0,29), (29,30)])
        self.assertEqual(undone["mapping"]["shots"], [0])
        self.assertEqual(undone["shots"][0]["frames"]["first"]["previews"][0]["ref"], self.source["ref"])
        self.assertEqual(undone["shots"][0]["frames"]["correction-232"], at_cut)
        self.assertEqual(undone["shots"][0]["frames"]["correction-400"], in_segment)

    async def test_remake_session_follows_its_source_tab_after_board_changes(self):
        source = self.make_clip("moved-tab", seconds=2, color=(200, 30, 30), frequency=440)
        session = {"shots":[{"start":0, "end":2, "summary":{},
                            "frames":{"first":video_remake.frame_record(self.source["ref"], (64, 64))}}],
                   "cut_revision":3}
        old_key = (7, "test", "n3", source)
        video_remake.save(old_key, session)

        def board(nodes):
            server.board_path("test").write_text(json.dumps({"owner":7, "nodes":nodes}))

        def video(node, ref, lineage=None):
            version = {"ref":ref}
            if lineage:
                version["tab_nodes"] = lineage
            return {"id":node, "type":"video", "versions":[version], "cur":0}

        async def act(node, action=None, user=None):
            req = Request(source, user or self.user, {"action":action, "shot":0, "cut_revision":3} if action else None)
            req.match_info["node"] = node
            return json.loads((await server.remake(req)).body)

        board([video("n4", source, ["n3"]), video("n5", source)])
        split = await act("n4")
        self.assertEqual(split["session_node"], "n3")
        self.assertEqual(split["cut_revision"], 3)
        self.assertIsNone(await act("n5"))
        self.assertIsNone(await act("n4", user={"id":8, "role":"admin"}))
        with self.assertRaises(web.HTTPNotFound):
            await act("n3")
        await act("n4", "keep")
        self.assertTrue(video_remake.load(old_key)["shots"][0]["keep_original"])
        self.assertIsNone(video_remake.load((7, "test", "n4", source)))

        board([video("n8", source, ["n3", "n4"])])
        merged = await act("n8")
        self.assertEqual(merged["session_node"], "n3")
        self.assertTrue(merged["shots"][0]["keep_original"])

    async def test_private_media_checks_file_and_new_board_references(self):
        owner, teammate = self.user, {"id":8, "role":"member"}
        ref = self.source["ref"]
        server.grant_media(owner, ref)
        request = Request(ref, owner)
        request.query = {"ref":ref}
        response = await server.media(request)
        self.assertIn("private", response.headers["Cache-Control"])
        request["user"] = teammate
        with self.assertRaises(web.HTTPNotFound):
            await server.media(request)
        server.board_path("note").write_text(json.dumps({"owner":8,"nodes":[{"name":ref,"data":{"text":ref}}]}))
        with self.assertRaises(web.HTTPNotFound):
            await server.media(request)
        board = {"name":"私有项目", "nodes":[{"id":"n1","versions":[self.source]}]}
        save = Request(ref, teammate, board)
        save.match_info = {"bid":"team-test"}
        with self.assertRaises(web.HTTPForbidden):
            await server.put_board(save)
        save.path = "/api/render"
        with self.assertRaises(web.HTTPForbidden):
            await server.media_input_guard(save, server.render_film)
        server.board_path("source-board").write_text(json.dumps({**board, "owner":owner["id"], "shared":True}))
        self.assertEqual((await server.media(request)).status, 200)
        self.assertEqual((await server.put_board(save)).status, 200)
        generated = image_editor.save(server.COMFY_DIR, Image.new("RGB", (8, 8), "blue"))["ref"]
        db.task_start(id="asset-test-job", user_id=8, state="done", outputs=[generated])
        request.query = {"ref":generated}
        self.assertEqual((await server.media(request)).status, 200)
        request["user"] = owner
        with self.assertRaises(web.HTTPNotFound):
            await server.media(request)
