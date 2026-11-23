import asyncio
import io
import json
import sys
import time
import wave
from contextlib import asynccontextmanager, redirect_stdout
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, skipUnless
from unittest.mock import patch

import av
import numpy as np
from aiohttp import StreamReader, web
from aiohttp.base_protocol import BaseProtocol
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request
from PIL import Image, ImageDraw
from yarl import URL

import db
import image_editor
import motion_reference
import server
import video_depth
import video_remake
import video_matte
from scripts import smoke_video_remake


class Request(dict):
    def __init__(self, source, user, payload=None):
        super().__init__(user=user)
        self.query = {"source": source}
        self.match_info = {"board": "test", "node": "n3"}
        self.method = "POST" if payload else "GET"
        self.app = {"llm": object(), "creative_memory": server.creative_memory.Store(server)}
        self.payload = payload

    async def json(self):
        return self.payload


class VideoRemakeIntegration(IsolatedAsyncioTestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        root = Path(directory)
        self.enterContext(patch.object(db, "_conn", None))
        self.enterContext(patch.object(db, "DB_PATH", root / "remake.db"))
        self.enterContext(patch.object(server, "COMFY_DIR", root / "media"))
        self.enterContext(patch.object(server, "BOARDS", root / "boards"))
        self.enterContext(patch.object(server, "LIBRARY", root / "library.json"))
        self.enterContext(patch.object(server, "JOBS", {}))
        self.enterContext(patch.object(server, "PREP_TAIL", [None]))
        self.enterContext(patch.object(server, "STATS", {}))
        self.enterContext(patch.object(server, "STATS_FILE", root / "stats.json"))
        self.enterContext(patch.object(server, "RENDER_LOCK", asyncio.Lock()))
        self.addCleanup(db.conn().close)
        server.BOARDS.mkdir()
        self.user = {"id": 7, "role": "member"}
        self.source = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "red"), "asset", "input")

    async def test_shot_depth_guide_keeps_exact_cut_and_can_reopen(self):
        source = self.make_clip("depth-cuts", seconds=3, color=lambda i: (43, 43, 43) if i < 25 else (160, 160, 160),
                                frequency=550)
        server.board_path("test").write_text(json.dumps({"owner":7, "collaborators":{"8":"reviewer"}, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        # Use an exact odd-frame cut. A deterministic inference fixture leaves media preparation
        # and the final encode running through the real queue and renderer.
        key = (7, "test", "n3", source)
        ranges = [(0, 25 / 24), (25 / 24, 3)]
        shots = [{"start":a, "end":b, "summary":{},
                  "frames":{"first":{"previews":[], "w":64, "h":64}}} for a, b in ranges]
        video_remake.save(key, {"shots":shots,"display_oriented":True})
        payload = {"action":"prepare_depth", "shot":1}
        with patch.object(video_depth, "configuration", return_value=None):
            with self.assertRaises(web.HTTPServiceUnavailable):
                await server.remake(Request(source, self.user, payload))
        with self.assertRaises(web.HTTPForbidden):
            video_remake.prepare_depth(Request(source, {"id":8,"role":"member"}, payload),
                                      server, (8, *key[1:]), {}, shots[1])

        model_home = server.BOARDS.parent / "depth-fixture"
        (model_home / "checkpoints").mkdir(parents=True)
        (model_home / video_depth.CHECKPOINT).touch()
        (model_home / "run.py").write_text(
            "import os, shutil, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            "value = lambda flag: args[args.index(flag) + 1]\n"
            "assert Path('checkpoints/video_depth_anything_vits.pth').is_file()\n"
            "assert os.environ['CUDA_VISIBLE_DEVICES'] == ''\n"
            "assert value('--encoder') == 'vits' and value('--target_fps') == '12'\n"
            "assert '--grayscale' in args and '--fp32' in args\n"
            "shutil.copyfile(value('--input_video'), Path(value('--output_dir')) / 'shot_vis.mp4')\n"
        )
        with patch.dict("os.environ", {"ONESHOT_DEPTH_HOME":str(model_home), "ONESHOT_DEPTH_PYTHON":sys.executable}):
            response = json.loads((await server.remake(Request(source, self.user, payload))).body)
            depth = response["shots"][1]["depth"]
            self.assertEqual(depth["start"], 25 / 24)
            self.assertTrue(response["depth_available"])
            repeated = json.loads((await server.remake(Request(source, self.user, payload))).body)
            self.assertEqual(repeated["shots"][1]["depth"]["job"], depth["job"])
            with self.assertRaises(web.HTTPConflict):
                await server.remake(Request(source, self.user, {"action":"move_cut", "shot":1, "at":1.5}))
            await self.wait_for_render(depth["job"])
            reopened = json.loads((await server.remake(Request(source, self.user))).body)
        output = reopened["shots"][1]["depth"]
        self.assertEqual(output["state"], "done")
        self.assertNotIn("depth", reopened["shots"][0])
        ref = output["ref"]
        self.assertTrue(server.can_read_media(self.user, ref))
        self.assertFalse(server.can_read_media({"id":8,"role":"member"}, ref))
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, ref))) as result:
            self.assertEqual(len(result.streams.audio), 0)
            self.assertEqual(result.streams.video[0].average_rate, 24)
            frames = list(result.decode(video=0))
            self.assertEqual(len(frames), 47)
            self.assertEqual(frames[0].width, output["w"])
            self.assertGreater(np.asarray(frames[0].to_image()).mean(), 150)

    async def test_depth_reference_is_sent_as_a_video_and_lease_expires_on_completion(self):
        source = self.make_clip("depth-source-original", 3, (110, 80, 90), 530)
        guide = self.make_clip("depth-reference-fixture", 3, (110, 110, 110), 100)
        result_ref = self.make_clip("depth-provider-output", 4, (140, 100, 70), 880)
        preview = self.source["ref"]
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        key = (7, "test", "n3", source)
        shot = {"start":0, "end":3, "summary":{}, "depth":{"job":"rendered-guide","state":"done","ref":guide,"start":0,"end":3},
                "frames":{"first":{"w":64,"h":64,"approved":"approved-frame","previews":[
                    {"job":"approved-frame", "state":"done", "ref":preview, "asset":{"name":"测试人物"}},
                ]}}}
        video_remake.save(key, {"shots":[shot],"display_oriented":True})
        provider = {"id":"motion-test", "name":"测试方舟", "kind":"ark", "enabled":True,
                    "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"test-key"}}
        route = {"provider":provider, "model":"ep-seedance-test"}
        request = Request(source, self.user, {"action":"generate_depth_video", "shot":0, "provider":provider["id"],
                                             "first_job":"approved-frame"})
        request.app["http"] = object()
        app = web.Application(middlewares=[server.auth.middleware])
        app.router.add_get(motion_reference.LEASE_PREFIX + "{token}", motion_reference.serve)
        sent = []

        async with TestClient(TestServer(app)) as client:
            async def json_req(_http, method, url, _name, **kwargs):
                if method == "GET":
                    return {"status":"succeeded","content":{"video_url":"https://api.example/result.mp4"}}
                body = kwargs["json"]
                self.assertEqual(body["duration"], 4)
                self.assertFalse(body["generate_audio"])
                self.assertEqual(body["ratio"], "1:1")
                text, image, motion = body["content"]
                self.assertEqual(image["role"], "reference_image")
                self.assertEqual(motion["role"], "reference_video")
                self.assertIn("@视频1", text["text"])
                signed_url = URL(motion["video_url"]["url"])
                sent.append(signed_url.path)
                self.assertEqual(signed_url.host, "studio.example")
                response = await client.head(signed_url.path)
                self.assertEqual(response.status, 200)
                response = await client.get(signed_url.path, headers={"Range":"bytes=0-63"})
                self.assertEqual(response.status, 206)
                self.assertEqual(len(await response.read()), 64)
                response = await client.get(signed_url.path)
                self.assertEqual(response.headers["Cache-Control"], "private, no-store")
                with av.open(io.BytesIO(await response.read())) as video:
                    self.assertFalse(video.streams.audio)
                    self.assertEqual(video.streams.video[0].width, 720)
                    self.assertEqual(video.streams.video[0].average_rate, 24)
                    self.assertEqual(sum(1 for _ in video.decode(video=0)), 72)
                return {"id":"test-cloud-job"}

            async def save_result(*args):
                return {"files":[{"ref":result_ref, "path":server.tools.ref_path(server.COMFY_DIR, result_ref), "kind":"video"}]}

            with patch.object(server.providers, "routes", return_value=[route]), \
                    patch.object(server.providers, "all_providers", return_value=[]), \
                    patch.object(server.remote, "json_req", side_effect=json_req), \
                    patch.object(server.remote, "_save_video", side_effect=save_result):
                with self.assertRaises(web.HTTPServiceUnavailable):
                    await server.remake(Request(source, self.user, {**request.payload,"provider":"unknown"}))
                with self.assertRaises(web.HTTPConflict):
                    await server.remake(Request(source, self.user, {**request.payload,"first_job":"stale-first-frame"}))
                submitted = json.loads((await server.remake(request)).body)
                record = submitted["shots"][0]["videos"][0]
                job = record["job"]
                self.assertEqual(record["depth_ref"], guide)
                self.assertEqual(record["motion_model"], "ep-seedance-test")
                self.assertEqual(submitted["motion_providers"][0]["id"], "motion-test")
                await self.wait_for_render(job)
                self.assertEqual(server.JOBS[job]["state"], "done", server.JOBS[job].get("error"))
                self.assertEqual((await client.get(sent[0])).status, 404)
                self.assertEqual((await client.post(sent[0])).status, 401)
                reopened = json.loads((await server.remake(Request(source, self.user))).body)
                self.assertEqual(reopened["shots"][0]["videos"][0]["ref"], result_ref)
                logs = db.one("SELECT request FROM tasks WHERE id=?", job)["request"]
                self.assertNotIn(sent[0], logs)
                self.assertNotIn(sent[0], json.dumps(reopened))

                reopened["mapping"] = {"source":"人物甲", "asset":"new-role", "shots":[0]}
                adopted = reopened["shots"][0]["frames"]["first"]["previews"][0]
                adopted.update(source_person="人物甲", asset={"id":"new-role","name":"测试人物"})
                video_remake.save(key, reopened)
                db.run("INSERT INTO users(id,username,role,disabled,pw_hash) VALUES(7,'test','member',0,'disabled')")
                db.conn().executescript(server.agent_chat.SCHEMA)
                now = time.time()
                run = {"id":"depth-run", "session_id":"depth-session", "board_id":"test", "state":"running",
                       "created":now, "data":{"bindings":{"n3":source}}}
                db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", run["session_id"], 7, "test", "测试", now, now)
                db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)", run["id"], run["session_id"], 7, "test",
                       "depth-run-key", "running", json.dumps(run["data"]), None, now, now)
                db.run("INSERT INTO chat_calls VALUES(?,?,?,?,?,?,?)", "depth-call", run["id"], "video_remake_generate",
                       "{}", "executing", None, now)
                assistant = server.agent_chat.AgentService(request.app, server)
                status = await assistant.execute(run, self.user, "status", "video_remake_status", {"node_id":"n3"})
                self.assertTrue(status["shots"][0]["depth_ready"])
                self.assertEqual(status["motion_providers"][0]["id"], provider["id"])
                result = await assistant.execute(run, self.user, "depth-call", "video_remake_generate",
                                                 {"node_id":"n3", "person":"人物甲", "asset_id":"new-role",
                                                  "shot":1, "cut_revision":0, "motion_provider":provider["id"],
                                                  "first_job":"approved-frame"})
                self.assertTrue(result["video"]["completed"])
                self.assertEqual(run["data"]["generated_video"], 1)
                self.assertEqual(len(set(sent)), 2)
                self.assertEqual((await client.get(sent[-1])).status, 404)

            temporarily_available = True
            with motion_reference.publish("https://studio.example", server.tools.ref_path(server.COMFY_DIR, guide),
                                          lambda: temporarily_available) as url:
                link = URL(url).path
                self.assertEqual((await client.head(link)).status, 200)
                temporarily_available = False
                self.assertEqual((await client.head(link)).status, 404)
            with patch.object(motion_reference, "LEASE_SECONDS", -1):
                with motion_reference.publish("https://studio.example", server.tools.ref_path(server.COMFY_DIR, guide),
                                              lambda: True) as url:
                    self.assertEqual((await client.head(URL(url).path)).status, 404)

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
        with patch.object(server, "llm_call", side_effect=self.no_vision):
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

    async def test_assistant_reads_the_bound_video_remake_session_for_its_user(self):
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test'),(8,'member','test')")
        source, other = "input:h3studio/source.mp4", "input:h3studio/other.mp4"
        server.board_path("test").write_text(json.dumps({"owner":7, "shared":True, "nodes":[
            {"id":"n3", "type":"video", "cur":1, "versions":[{"ref":source}, {"ref":other}]},
        ]}))
        frame = video_remake.frame_record(self.source["ref"], (64,64))
        frame["previews"] = [{"job":"assistant-preview", "state":"queued"}]
        key = (7, "test", "n3", source)
        video_remake.save(key, {
            "shots":[{"start":0, "end":2, "frames":{"first":frame}}],
            "mapping":{"source":"原片人物", "asset":"role", "asset_name":"新角色", "shots":[0]},
        })
        db.task_start(id="assistant-preview", user_id=7, state="done", outputs=[self.source["ref"]])
        service = server.agent_chat.AgentService({}, server)
        run = {"board_id":"test", "data":{"bindings":{"n3":source}}}
        params = {"node_id":"n3"}
        result = await service.execute(run, self.user, "status", "video_remake_status", params)
        self.assertEqual(result["remake"], {"node_id":"n3", "source_ref":source})
        self.assertTrue(result["analyzed"])
        self.assertEqual(result["mapping"]["asset"], "新角色")
        self.assertFalse(result["can_export"])
        self.assertEqual(result["shots"][0]["number"], 1)
        self.assertFalse(result["shots"][0]["pending"])
        self.assertIn("待审核", result["shots"][0]["review_issue"])
        self.assertEqual(video_remake.load(key)["shots"][0]["frames"]["first"]["previews"][0]["state"], "queued")
        self.assertEqual(server.JOBS, {})
        shared_user = {"id":8, "role":"member"}
        self.assertFalse((await service.execute(run, shared_user, "status", "video_remake_status", params))["analyzed"])
        run["data"]["bindings"] = {}
        self.assertFalse((await service.execute(run, self.user, "status", "video_remake_status", params))["analyzed"])

    async def test_assistant_analysis_persists_the_pinned_source_and_reuses_saved_shots(self):
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test')")
        source = self.make_clip("assistant-source", seconds=2,
                                color=lambda tick: (200, 20, 20) if tick < 24 else (20, 20, 200), frequency=440)
        other = "input:h3studio/other.mp4"
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "cur":1, "versions":[{"ref":source}, {"ref":other}]},
            {"id":"n1", "type":"image", "versions":[self.source]},
        ]}))

        class Vision:
            via = "test vision"
            calls = 0

            def available(self):
                return True

            async def chat(self, system, content, **kwargs):
                self.calls += 1
                if "这一帧" in system:
                    assert json.loads(content[0]["text"]) == {"name":"人物甲", "appearance":"红衣"}
                    return json.dumps({"point":[.4, .6]})
                return json.dumps({"characters":[{"name":"人物甲", "look":"红衣"}],
                                   "shots":[{"characters":["人物甲"], "camera":"固定机位"}] * 2})

        vision = Vision()
        memory = server.creative_memory.Store(server)
        asset = memory.put(self.user, {"name":"林森", "kind":"character", "board":"test",
                                      "ref":self.source["ref"], "source_board":"test"})
        service = server.agent_chat.AgentService({"llm":vision, "creative_memory":memory}, server)
        run = {"board_id":"test", "data":{"bindings":{"n3":source}}}
        result = await service.execute(run, self.user, "analyze", "video_remake_analyze", {"node_id":"n3"})
        self.assertEqual(result["remake"]["source_ref"], source)
        self.assertTrue(result["analyzed"])
        self.assertIsNone(result["warning"])
        self.assertEqual(result["source_people"], [{"name":"人物甲", "look":"红衣"}])
        self.assertEqual(result["shots"][0]["suggested_people"], ["人物甲"])
        self.assertEqual([(shot["start"], shot["end"]) for shot in result["shots"]], [(0,1), (1,2)])
        workspace = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(workspace["shots"][0]["summary"]["camera"], "固定机位")
        self.assertIsNone(video_remake.load((7, "test", "n3", other)))

        request = Request(source, self.user, {"action":"move_cut", "shot":1, "at":1.25})
        request.app["llm"] = vision
        await server.remake(request)
        again = await service.execute(run, self.user, "repeat", "video_remake_analyze", {"node_id":"n3"})
        self.assertEqual(vision.calls, 2)
        self.assertIsNone(again["warning"])
        self.assertEqual([(shot["start"], shot["end"]) for shot in again["shots"]], [(0,1.25), (1.25,2)])

        params = {"node_id":"n3", "person":"人物甲", "asset_id":asset["id"], "shots":[2]}
        with self.assertRaises(server.agent_chat.ToolError):
            await service.execute(run, self.user, "map", "video_remake_map", {**params, "cut_revision":result["cut_revision"]})
        with self.assertRaises(server.agent_chat.ToolError):
            await service.execute(run, self.user, "map", "video_remake_map", {**params, "cut_revision":again["cut_revision"], "shots":[3]})
        mapped = await service.execute(run, self.user, "map", "video_remake_map",
                                       {**params, "cut_revision":again["cut_revision"], "look":"红衣"})
        self.assertEqual(mapped["mapping"], {"source":"人物甲", "asset":"林森", "asset_id":asset["id"], "shots":[2]})
        self.assertTrue(mapped["shots"][0]["keep_original"])
        workspace = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(workspace["mapping"]["shots"], [1])
        self.assertEqual(workspace["mapping"]["look"], "红衣")

        locate_args = {"node_id":"n3", "person":"人物甲", "asset_id":asset["id"], "cut_revision":mapped["cut_revision"]}
        with self.assertRaises(server.agent_chat.ToolError):
            await service.execute(run, self.user, "locate", "video_remake_locate", {**locate_args, "shots":[1]})
        located = await service.execute(run, self.user, "locate", "video_remake_locate", locate_args)
        self.assertEqual(located["location"], {"located":[2], "skipped":[], "failed":[]})
        self.assertEqual(located["remake"]["shot_number"], 2)
        self.assertEqual(located["remake"]["shot_start"], 1.25)
        self.assertTrue(located["shots"][1]["position_suggested"])
        self.assertFalse(located["shots"][1]["start_frame_selected"])
        workspace = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(workspace["shots"][1]["frames"]["first"]["person_hint"]["point"], [.4, .6])
        repeat = await service.execute(run, self.user, "repeat_location", "video_remake_locate", locate_args)
        self.assertEqual(repeat["location"]["skipped"], [2])
        self.assertEqual(repeat["remake"]["shot_number"], 2)
        self.assertEqual(vision.calls, 3)

        preview_args = {**locate_args, "shots":[{"number":2, "note":"保留窗边道具"}]}
        unconfirmed = await service.execute(run, self.user, "preview", "video_remake_preview", preview_args)
        self.assertEqual(unconfirmed["preview"]["needs_selection"], [2])
        self.assertNotIn("generated", run["data"])
        revision = preview_args["cut_revision"]
        await server.remake(Request(source, self.user, {"action":"set_absence", "shot":1, "absent":True, "cut_revision":revision}))
        correction = json.loads((await server.remake(Request(source, self.user, {
            "action":"capture_correction", "shot":1, "at":1.5, "cut_revision":revision,
        }))).body)["captured_frame"]
        await server.remake(Request(source, self.user, {
            "action":"select", "shot":1, "frame":correction, "rect":[.2,.2,.8,.8], "cut_revision":revision,
        }))
        db.conn().executescript(server.agent_chat.SCHEMA)
        now = time.time()
        run.update(id="assistant-preview", session_id="assistant-remake", state="running", created=now)
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", run["session_id"], 7, "test", "换角预览", now, now)
        db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)", run["id"], run["session_id"], 7, "test",
               "preview", "running", json.dumps(run["data"]), None, now, now)
        db.run("INSERT INTO chat_calls VALUES(?,?,?,?,?,?,?)", "preview", run["id"], "video_remake_preview",
               json.dumps(preview_args), "executing", None, 0)

        async def generate(req, payload):
            self.assertIn("保留窗边道具", payload["prompt"])
            self.assertEqual(payload["images"][2]["ref"], asset["ref"])
            db.task_start(id="assistant-image", user_id=7, state="done", outputs=[self.source["ref"]])
            return web.json_response({"ids":["assistant-image"]})

        with patch.object(server, "_generate_request", side_effect=generate) as submit:
            run["data"]["generated"] = 4
            with self.assertRaises(server.agent_chat.ToolError):
                await service.execute(run, self.user, "preview", "video_remake_preview", preview_args)
            run["data"]["generated"] = 0
            queued = await service.execute(run, self.user, "preview", "video_remake_preview", preview_args)
            repeated = await service.execute(run, self.user, "repeat-preview", "video_remake_preview", preview_args)
        submit.assert_awaited_once()
        self.assertEqual(queued["preview"]["submitted"], [2])
        self.assertEqual(queued["preview"]["completed"], [2])
        self.assertEqual(queued["remake"]["frame"], correction)
        self.assertEqual(queued["remake"]["preview_job"], "assistant-image")
        self.assertEqual(repeated["preview"]["skipped"], [2])
        self.assertEqual(run["data"]["generated"], 1)
        pending_call = db.one("SELECT state,result FROM chat_calls WHERE id=?", "preview")
        self.assertEqual(pending_call["state"], "waiting")
        server.JOBS.pop("assistant-image")
        resumed = await service.wait_jobs(run, self.user, "preview", json.loads(pending_call["result"]))
        self.assertEqual(resumed["remake"], queued["remake"])
        workspace = json.loads((await server.remake(Request(source, self.user))).body)
        entry = workspace["shots"][1]["frames"][correction]
        self.assertEqual(entry["previews"][0]["job"], "assistant-image")
        self.assertNotIn("approved", entry)
        video_args = {**locate_args, "shot":2, "first_job":"assistant-image", "motion":"第一秒回头"}
        with self.assertRaisesRegex(ValueError, "首次入画"):
            await service.execute(run, self.user, "video", "video_remake_generate", video_args)
        self.assertNotIn("generated_video", run["data"])
        await server.remake(Request(source, self.user, {
            "action":"approve", "job":"assistant-image", "shot":1, "frame":correction, "cut_revision":revision,
        }))
        ready = await service.execute(run, self.user, "ready", "video_remake_status", {"node_id":"n3"})
        self.assertEqual(ready["shots"][1]["approved_start_job"], "assistant-image")
        with self.assertRaisesRegex(ValueError, "起始帧已变更"):
            await service.execute(run, self.user, "video", "video_remake_generate", {**video_args, "first_job":"old"})
        server.providers.seed()

        async def generate_video(req, payload):
            self.assertEqual(payload["provider"], "local_h3")
            self.assertEqual([item["time"] for item in payload["images"]], [0, .25])
            self.assertEqual(payload["images"][1]["ref"], self.source["ref"])
            self.assertIn("第一秒回头", payload["prompt"])
            db.task_start(id="assistant-video", user_id=7, state="done", outputs=[source])
            return web.json_response({"ids":["assistant-video"]})

        with patch.object(server, "_generate_request", side_effect=generate_video) as submit_video:
            generated = await service.execute(run, self.user, "video", "video_remake_generate", video_args)
            with self.assertRaises(server.agent_chat.ToolError):
                await service.execute(run, self.user, "video", "video_remake_generate", video_args)
        submit_video.assert_awaited_once()
        self.assertEqual(generated["video"], {"shot":2, "submitted":True, "completed":True, "failed":[]})
        self.assertEqual(generated["remake"]["video_job"], "assistant-video")
        workspace = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(workspace["shots"][1]["videos"][-1]["job"], "assistant-video")
        self.assertFalse(workspace["shots"][1].get("adopted_video"))
        self.assertEqual(set(server.JOBS), {"assistant-image", "assistant-video"})

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
        with patch.object(server, "llm_call", side_effect=self.no_vision):
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

    async def test_cancelling_while_engine_is_accepting_a_job_stops_that_job(self):
        pending_id = "p-remake"
        meta = {"prompt":"remake", "cls":"video", "units":1, "est":10, "label":"重制", "uid":7,
                "board":"test", "engine":True, "seed":1}
        server.JOBS[pending_id] = {"id":pending_id, "state":"queued", "meta":meta, "created":0, "prep":True}
        server.JOBS["other"] = {"state":"queued", "meta":{"uid":7}}
        db.task_start(id=pending_id, user_id=7, state="queued")
        submitted = asyncio.Event()
        engine_reply = asyncio.Event()
        engine_cancels = []

        class EngineResponse:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def json(self):
                submitted.set()
                await engine_reply.wait()
                return {"id":"engine-accepted"}

        def post(url, json, **kwargs):
            if url.endswith("/cancel"):
                engine_cancels.extend(json["ids"])
            return EngineResponse()

        async def translate(app, payload):
            return payload

        request = Request("", self.user, {"ids":[pending_id]})
        request.app.update(http=SimpleNamespace(post=post), llm=SimpleNamespace(running=lambda: False))
        with patch.object(server, "engine_body", return_value=({}, {})), patch.object(server, "to_english", translate):
            task = asyncio.create_task(server.prepare_engine(request.app, {}, [pending_id], None))
            await asyncio.wait_for(submitted.wait(), 1)
            try:
                await server.cancel(request)
            finally:
                engine_reply.set()
                await task
        self.assertEqual(engine_cancels, ["engine-accepted"])
        self.assertEqual(server.JOBS["other"]["state"], "queued")
        self.assertEqual(server.JOBS[pending_id]["error"], "已取消")
        self.assertEqual(db.one("SELECT state FROM tasks WHERE id=?", pending_id)["state"], "error")

    async def test_submitted_video_recovers_its_result_after_oneshot_restarts(self):
        pending_id, engine_id = "p123456789abc", "e123456789abc"
        source = self.make_clip("recovered", seconds=1, color=(200, 30, 30), frequency=440)
        meta = {"prompt":"remake", "cls":"video", "units":1, "est":10, "label":"重制", "uid":7,
                "board":"test", "engine":True, "seed":1}
        server.JOBS[pending_id] = {"id":pending_id, "kind":"video", "state":"queued", "meta":meta, "created":0, "prep":True}
        db.task_start(id=pending_id, user_id=7, board_id="test", state="queued",
                      capability="video", provider_kind="local_h3")

        class EngineResponse:
            def __init__(self, data):
                self.data = data

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def raise_for_status(self):
                pass

            async def json(self):
                return self.data

        def submit(url, json):
            self.assertTrue(url.endswith("/jobs"))
            Path(json["out"]).write_bytes(server.tools.ref_path(server.COMFY_DIR, source).read_bytes())
            return EngineResponse({"id":engine_id})

        def status(url, params, **kwargs):
            self.assertTrue(url.endswith("/jobs"))
            self.assertEqual(params["ids"], engine_id)
            return EngineResponse({engine_id: {"state":"done"}})

        async def translate(app, payload):
            return payload

        async def skip_initial_poll(app):
            pass

        request = Request("", self.user)
        request.query["ids"] = pending_id
        request.app.update(http=SimpleNamespace(post=submit, get=status), llm=SimpleNamespace(running=lambda: False))
        with patch.object(server, "engine_body", return_value=({}, {})), patch.object(server, "to_english", translate), \
                patch.object(server, "follow_engine", skip_initial_poll):
            await server.prepare_engine(request.app, {}, [pending_id], None)
        receipt = json.loads(db.one("SELECT request FROM tasks WHERE id=?", pending_id)["request"])["engine"]
        self.assertEqual(receipt["id"], engine_id)
        expected_ref = receipt["out_ref"]
        server.JOBS.clear()

        other_user = Request("", {"id":8, "role":"member"})
        other_user.query["ids"] = pending_id
        self.assertEqual(json.loads((await server.jobs(other_user)).body), {})
        self.assertNotIn(pending_id, server.JOBS)
        await server.jobs(request)
        task = await self.wait_for_render(pending_id)
        self.assertEqual(json.loads(task["outputs"]), [expected_ref])
        for restart in (False, True):
            if restart:
                server.JOBS.clear()
            result = json.loads((await server.jobs(request)).body)[pending_id]
            self.assertEqual(result["state"], "done")
            self.assertEqual(result["outputs"][0]["ref"], expected_ref)

    async def test_submitted_video_can_be_cancelled_after_oneshot_restarts(self):
        pending_id, engine_id = "p123456789abc", "e123456789abc"
        db.task_start(id=pending_id, user_id=7, capability="video", provider_kind="local_h3",
                      request={"engine":{"id":engine_id, "out_ref":"output:h3studio/pending.mp4"}})
        cancelled = []

        async def cancel_engine(app, ids):
            cancelled.extend(ids)

        with patch.object(server, "cancel_engine_jobs", cancel_engine):
            await server.cancel(Request("", {"id":8, "role":"member"}, {"ids":[pending_id]}))
            self.assertEqual(cancelled, [])
            self.assertNotIn(pending_id, server.JOBS)
            await server.cancel(Request("", self.user, {"ids":[pending_id]}))
        self.assertEqual(cancelled, [engine_id])
        task = db.one("SELECT state,error FROM tasks WHERE id=?", pending_id)
        self.assertEqual(task, {"state":"error", "error":"已取消"})

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

    async def test_variable_rate_source_uses_displayed_frame_in_previews_and_export(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "variable-rate", ".mkv")
        colors = [(200, 20, 20), (20, 200, 20), (20, 20, 200), (200, 200, 20)]
        with av.open(str(path), "w") as output:
            stream = output.add_stream("libx264", rate=24)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            stream.codec_context.time_base = Fraction(1, 1000)
            rate = server.film.SR
            audio = output.add_stream("pcm_s16le", rate=rate)
            audio.layout = "stereo"
            for pts, color in zip((500, 555, 605, 690), colors):
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), color))
                frame.pts, frame.time_base = pts, stream.codec_context.time_base
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
            for i in range(0, rate // 2, 1024):
                times = np.arange(i, min(i + 1024, rate // 2)) / rate
                samples = (8000 * np.sin(2 * np.pi * 440 * times)).astype(np.int16)
                frame = av.AudioFrame.from_ndarray(np.repeat(samples, 2)[None, :], format="s16", layout="stereo")
                frame.sample_rate, frame.time_base = rate, Fraction(1, rate)
                frame.pts = i + round(.6 * rate)
                output.mux(audio.encode(frame))
            output.mux(audio.encode())
        with av.open(str(path)) as written:
            self.assertEqual([round(frame.time * 1000) for frame in written.decode(video=0)], [500, 555, 605, 690])
        raw = path.read_bytes()

        async def read_part(decode=False):
            return raw

        async def next_part():
            return SimpleNamespace(filename="variable-rate.MKV", read=read_part)

        async def multipart():
            return SimpleNamespace(next=next_part)

        upload = Request("", self.user)
        upload.multipart = multipart
        imported = json.loads((await server.upload(upload)).body)
        self.assertEqual(imported["type"], "video")
        source = imported["ref"]
        path = server.tools.ref_path(server.COMFY_DIR, source)
        duration = server.film.probe(path)[2]
        self.assertAlmostEqual(duration, .232, delta=.002)
        expected = [colors[index] for index in (0, 0, 1, 2, 2, 3)]
        previews = await asyncio.to_thread(video_remake.original_frames, server, source, set(range(6)))
        for tick, color in enumerate(expected):
            preview = image_editor.load(server.COMFY_DIR, previews[tick]["ref"])
            self.assertTrue(np.allclose(preview.getpixel((32, 32))[:3], color, atol=5))

        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        listed = json.loads((await server.assets(Request("", self.user))).body)
        self.assertEqual([(entry["ref"], entry["type"]) for entry in listed], [(source, "video")])

        async def act(action=None):
            request = Request(source, self.user, {"action":action} if action else None)
            return json.loads((await server.remake(request)).body)

        converting = await act("prepare_playback")
        self.assertEqual(converting["shots"], [])
        job = converting["playback"]["job"]
        self.assertEqual((await act("prepare_playback"))["playback"]["job"], job)
        task = await self.wait_for_render(job)
        server.JOBS.pop(job)
        ref = json.loads(task["outputs"])[0]
        self.assertEqual((await act())["playback"]["ref"], ref)
        with patch.object(server, "llm_call", side_effect=self.no_vision):
            analyzed = await act("analyze")
        self.assertEqual(analyzed["playback"]["ref"], ref)
        self.assertEqual(analyzed["shots"][0]["end"], duration)
        final = server.tools.ref_path(server.COMFY_DIR, ref)
        with av.open(str(final)) as result:
            self.assertEqual(result.streams.video[0].codec_context.name, "h264")
            self.assertEqual(result.streams.audio[0].codec_context.name, "aac")
            pixels = [frame.to_ndarray(format="rgb24")[32,32] for frame in result.decode(video=0)]
        self.assertEqual(len(pixels), 6)
        self.assertTrue(np.allclose(pixels, expected, atol=8))
        waveform = server.film.read_audio(final)[0]
        self.assertLess(np.max(np.abs(waveform[:round(.08 * rate)])), .01)
        self.assertGreater(np.max(np.abs(waveform[round(.12 * rate):round(.20 * rate)])), .1)

    @skipUnless(hasattr(av.video.stream.VideoStream, "set_display_rotation"), "rotated MP4 fixture needs PyAV display matrix writing")
    async def test_rotated_phone_video_uses_display_coordinates_through_export(self):
        def clip(name, image, rotated=False):
            path, ref = server.tools._new(server.COMFY_DIR, "input", name, ".mp4")
            with av.open(str(path), "w") as output:
                stream = output.add_stream("libx264", rate=24)
                stream.width, stream.height = image.size
                stream.pix_fmt = "yuv420p"
                if rotated:
                    stream.set_display_rotation(90, hflip=True)
                for _ in range(48):
                    for packet in stream.encode(av.VideoFrame.from_image(image)):
                        output.mux(packet)
                for packet in stream.encode():
                    output.mux(packet)
            return path, ref

        landscape = Image.new("RGB", (96, 64), (200, 30, 30))
        draw = ImageDraw.Draw(landscape)
        draw.rectangle((48, 0, 95, 31), fill=(30, 30, 200))
        draw.rectangle((48, 32, 95, 63), fill=(30, 160, 30))
        path, source = clip("phone", landscape, rotated=True)
        _, replacement = clip("portrait", Image.new("RGB", (64, 96), (210, 210, 30)))
        self.assertEqual(server.film.probe(path, display=False)[:2], (96, 64))
        self.assertEqual(server.tools.video_info(path), {"w":64, "h":96, "seconds":2})
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))

        async def act(action, **fields):
            response = await server.remake(Request(source, self.user, {"action":action, "shot":0, **fields}))
            return json.loads(response.body)

        with patch.object(server, "llm_call", side_effect=self.no_vision):
            analyzed = await act("analyze")
        first = analyzed["shots"][0]["frames"]["first"]
        self.assertEqual((first["w"], first["h"]), (64, 96))
        image = image_editor.load(server.COMFY_DIR, first["ref"])
        self.assertGreater(image.getpixel((8, 8))[1], 140)
        self.assertGreater(image.getpixel((56, 8))[2], 180)
        capture = await act("capture_correction", at=1)
        frame = capture["shots"][0]["frames"][capture["captured_frame"]]
        self.assertEqual((frame["w"], frame["h"]), (64, 96))
        session = await act("select", rect=[.58,.15,.9,.4])
        first = session["shots"][0]["frames"]["first"]
        session["shots"][0]["videos"] = [{
            "job":"portrait-remake", "state":"done", "ref":replacement,
            "first_frame":first["ref"], "mask":first["selection"]["mask"], "asset":{"id":"test"},
        }]
        video_remake.save((7, "test", "n3", source), session)
        local = await act("localize", job="portrait-remake")
        job = local["shots"][0]["videos"][-1]["job"]
        await self.wait_for_render(job)
        await act("approve_video", job=job)
        export = await act("export")
        task = await self.wait_for_render(export["export"]["job"])
        final = server.tools.ref_path(server.COMFY_DIR, json.loads(task["outputs"])[0])
        self.assertEqual(server.film.probe(final)[:2], (64, 96))
        with av.open(str(final)) as result:
            frame = next(result.decode(video=0)).to_ndarray(format="rgb24")
        self.assertGreater(frame[22,48,0], 185)
        self.assertGreater(frame[22,48,1], 185)
        self.assertGreater(frame[8,8,1], 140)
        self.assertGreater(frame[8,56,2], 180)
        legacy = video_remake.original_frames(server, source, {0}, display=False)[0]
        video_remake.save((7, "test", "n3", source), {"shots":[{"start":0, "end":2,
            "frames":{"first":legacy}, "summary":{}}]})
        old_capture = await act("capture_correction", at=1)
        old_frame = old_capture["shots"][0]["frames"][old_capture["captured_frame"]]
        self.assertEqual((old_frame["w"], old_frame["h"]), (96, 64))

    async def test_remake_sends_the_reviewed_asset_preview_to_the_engine_and_exports(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "remake-test", ".mp4")
        with av.open(str(path), "w") as clip:
            stream = clip.add_stream("libx264", rate=6)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            for _ in range(12):
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), (40, 70, 100)))
                for packet in stream.encode(frame):
                    clip.mux(packet)
            for packet in stream.encode():
                clip.mux(packet)
        board = {"owner": 7, "nodes": [
            {"id": "n1", "type": "image", "versions": [self.source]},
            {"id": "n3", "type": "video", "name": "原片", "data": {}, "versions": [{"ref": source}], "cur": 0},
        ]}
        server.board_path("test").write_text(json.dumps(board))
        asset = server.creative_memory.Store(server).put(self.user, {
            "name": "新角色", "kind": "character", "board": "test",
            "ref": self.source["ref"], "source_board": "test",
        })

        class Vision:
            via = "test vision"
            point = [1.5, .5]

            def available(self):
                return True

            def running(self):
                return False

            async def chat(self, system, content, **kwargs):
                if "这一帧" in system:
                    assert json.loads(content[0]["text"]) == {"name":"人物1", "appearance":"红衣、短发"}
                    assert content[1]["type"] == "image_url"
                    return json.dumps({"point":self.point})
                return json.dumps({"characters":[{"name":"人物1", "look":"红衣、短发"}],
                                   "shots":[{"characters":["人物1"]}]})

        vision = Vision()
        engine = None

        async def act(action=None, **kwargs):
            payload = {"action": action, "shot": 0, **kwargs} if action else None
            req = Request(source, self.user, payload)
            req.app["llm"] = vision
            if engine:
                req.app["http"] = engine
            response = await server.remake(req)
            self.assertEqual(response.status, 200)
            return json.loads(response.body)

        with self.assertRaises(web.HTTPNotFound):
            await server.remake(Request(source, {"id":8, "role":"member"}))
        self.assertIsNone(await act())
        analyzed = await act("analyze")
        self.assertEqual(analyzed["source_people"], [{"name":"人物1", "look":"红衣、短发"}])
        frame = analyzed["shots"][0]["frames"]["first"]
        self.assertTrue(frame["ref"].endswith(".png"))
        with self.assertRaises(web.HTTPBadRequest):
            await act("preview", asset=asset["id"])
        await act("map_person", person="人物1", asset=asset["id"], shots=[0])
        with self.assertRaises(web.HTTPBadRequest):
            await act("locate_person", person="人物1")
        vision.point = [.5, .5]
        located = await act("locate_person", person="人物1")
        located_frame = located["shots"][0]["frames"]["first"]
        self.assertEqual(located_frame["person_hint"]["point"], vision.point)
        self.assertNotIn("selection", located_frame)
        await act("map_person", person="人物1", look="戴眼镜", asset=asset["id"], shots=[0])
        with self.assertRaises(web.HTTPConflict):
            await act("apply_person_hint", person="人物1")
        await act("map_person", person="人物1", asset=asset["id"], shots=[0])

        async def segment(app, tool, params):
            self.assertEqual(tool, "segment")
            self.assertEqual(params["ref"], frame["ref"])
            self.assertEqual(params["points"], [{"x":32, "y":32, "positive":True}])
            mask = Image.new("L", (64, 64))
            mask.paste(255, (16, 16, 48, 48))
            return image_editor.save(server.COMFY_DIR, mask, "segment", "input")

        with patch.object(server, "run_image_tool", side_effect=segment):
            selected = await act("apply_person_hint", person="人物1")
            self.assertEqual(selected["shots"][0]["frames"]["first"]["selection"]["source_person"], "人物1")
            with self.assertRaises(web.HTTPConflict):
                await act("apply_person_hint", person="人物1")
        await act("map_person", person="另一人", asset=asset["id"], shots=[0])
        with self.assertRaises(web.HTTPBadRequest):
            await act("preview", asset=asset["id"])
        await act("map_person", person="人物1", asset=asset["id"], shots=[0])
        with self.assertRaises(web.HTTPBadRequest):
            await act("select", frame="middle", layer="protection", rect=[.5, .5, .65, .65])
        await act("select", layer="protection", rect=[.5, .5, .65, .65])
        rendered = self.make_clip("engine-result", seconds=2, color=(240, 240, 240), frequency=880)

        class EngineResponse:
            def __init__(self, payload):
                self.payload = payload

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def raise_for_status(self):
                pass

            async def json(self):
                return self.payload

        calls = []
        outcomes = {}

        def submit(url, json):
            self.assertTrue(url.endswith("/jobs"))
            jid = f"e{len(calls) + 1:012x}"
            calls.append(json)
            path = Path(json["out"])
            if json["kind"] == "image":
                Image.new("RGB", (64,64), "white").save(path)
            else:
                path.write_bytes(server.tools.ref_path(server.COMFY_DIR, rendered).read_bytes())
            outcomes[jid] = {"state":"done", "out":str(path)}
            return EngineResponse({"id":jid})

        def status(url, params=None, **kwargs):
            if url.endswith("/status"):
                return EngineResponse({"ready":True, "image_ready":True})
            self.assertTrue(url.endswith("/jobs"))
            return EngineResponse({jid:outcomes[jid] for jid in params["ids"].split(",")})

        engine = SimpleNamespace(get=status, post=submit)
        server.providers.seed()
        started = await act("preview", asset=asset["id"], view="main")
        job = started["shots"][0]["frames"]["first"]["previews"][0]["job"]
        await self.wait_for_render(job)
        self.assertEqual(calls[0]["images"][2], str(server.tools.ref_path(server.COMFY_DIR, asset["ref"])))
        self.assertIn("<Picture 3>", calls[0]["prompt"])
        result = (await act())["shots"][0]["frames"]["first"]["previews"][0]
        self.assertEqual(result["state"], "done")
        original = image_editor.load(server.COMFY_DIR, frame["ref"])
        output = image_editor.load(server.COMFY_DIR, result["ref"])
        self.assertEqual(output.getpixel((0, 0)), original.getpixel((0, 0)))
        self.assertEqual(output.getpixel((36, 36)), original.getpixel((36, 36)))
        self.assertNotEqual(output.getpixel((25, 25)), original.getpixel((25, 25)))
        await act("approve", job=job)
        reopened = await act()
        self.assertEqual(reopened["shots"][0]["frames"]["first"]["approved"], job)
        self.assertEqual(reopened["role"]["asset"], asset["id"])

        async def translated(app, payload):
            return {**payload, "prompt":"Preserve the reviewed character and camera position."}

        with patch.object(server, "to_english", translated):
            generated = await act("generate_video")
            video_job = generated["shots"][0]["videos"][-1]["job"]
            await self.wait_for_render(video_job)
        self.assertEqual(calls[1]["kind"], "video")
        self.assertEqual(calls[1]["image"], str(server.tools.ref_path(server.COMFY_DIR, result["ref"])))
        adjusted = await act("select", rect=[.20,.25,.75,.75])
        current_mask = adjusted["shots"][0]["frames"]["first"]["selection"]["mask"]
        localized = await act("localize", job=video_job)
        localized_version = localized["shots"][0]["videos"][-1]
        self.assertEqual(localized_version["source_mask"], current_mask)
        self.assertEqual(localized_version["mask"], result["mask"])
        local_job = localized_version["job"]
        await self.wait_for_render(local_job)
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test')")
        service = server.agent_chat.AgentService({"creative_memory":server.creative_memory.Store(server)}, server)
        db.conn().executescript(server.agent_chat.SCHEMA)
        now = time.time()
        run = {"id":"export-run", "session_id":"export-chat", "board_id":"test",
               "state":"running", "created":now, "data":{"bindings":{"n3":source}}}
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", run["session_id"], 7, "test", "重制导出", now, now)
        for rid, state in ((run["id"], "running"), ("export-observer", "stopping")):
            db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)", rid, run["session_id"], 7, "test",
                   rid, state, json.dumps(run["data"]), None, now, now)
        async def assistant_export(revision=0, *, current_run=run, call="export"):
            return await service.execute(current_run, self.user, call, "video_remake_export", {
                "node_id":"n3", "cut_revision":revision,
            })

        with self.assertRaisesRegex(ValueError, "剪辑点已更新"):
            await assistant_export(1)
        blocked = await assistant_export()
        self.assertEqual(blocked["remake"]["shot_number"], 1)
        self.assertIsNone(blocked["export_state"])
        review = await service.execute(run, self.user, "review_choices", "video_remake_status", {"node_id":"n3", "shot":1})
        self.assertEqual(review["review_board"], "test")
        self.assertEqual([(v["number"], v["job"], v["mode"]) for v in review["review_versions"]],
                         [(1, video_job, "whole"), (2, local_job, "local")])
        review_args = {"node_id":"n3", "shot":1, "cut_revision":review["cut_revision"]}
        with self.assertRaises(server.agent_chat.ToolError):
            await service.execute(run, self.user, "review", "video_remake_review",
                                  {**review_args, "decision":"adopt", "video_job":"another-shot"})
        adopted = await service.execute(run, self.user, "review", "video_remake_review",
                                        {**review_args, "decision":"adopt", "video_job":local_job})
        self.assertEqual(adopted["remake"]["video_job"], local_job)
        self.assertTrue(adopted["can_export"])
        self.assertEqual((await act())["shots"][0]["adopted_video"], local_job)
        service.emit(run["session_id"], run["id"], "model",
                     {"role":"user", "content":"合成重制视频，保留原声"})
        model_call = {
            "role":"assistant", "content":None, "tool_calls":[{
                "id":"export-for-remake", "type":"function",
                "function":{"name":"video_remake_export",
                            "arguments":json.dumps({"node_id":"n3", "cut_revision":0})},
            }],
        }
        reply = {"role":"assistant", "content":"成片已就绪"}
        with patch.object(server, "enqueue_film", wraps=server.enqueue_film) as enqueue, \
                patch.object(service, "model", side_effect=[model_call, reply]) as model:
            async with server.RENDER_LOCK:
                waiting = asyncio.create_task(service.work(run["id"]))
                for _ in range(50):
                    call = db.one("SELECT id,state,result FROM chat_calls WHERE run_id=? AND name=?",
                                  run["id"], "video_remake_export")
                    if call and call["state"] == "waiting":
                        break
                    if waiting.done():
                        self.fail(db.one("SELECT state,error FROM chat_runs WHERE id=?", run["id"]))
                    await asyncio.sleep(.02)
                self.assertIsNotNone(call)
                self.assertEqual(call["state"], "waiting")
                pending_export = json.loads(call["result"])
                export_job = pending_export["ids"][0]
                observer = {**run, "id":"export-observer"}
                with self.assertRaisesRegex(server.agent_chat.ToolError, "停止"):
                    await assistant_export(current_run=observer, call="observe")
                self.assertFalse(server.JOBS[export_job].get("cancel"))
            await waiting
            completed_call = db.one("SELECT state,result FROM chat_calls WHERE id=?", call["id"])
            self.assertEqual(completed_call["state"], "done")
            downloadable = json.loads(completed_call["result"])
            self.assertEqual(downloadable["export_state"], "done")
            completed_run = db.one("SELECT state,error FROM chat_runs WHERE id=?", run["id"])
            self.assertEqual(completed_run, {"state":"done", "error":None})
            delivered = model.await_args_list[1].args[0][-1]
            self.assertEqual(delivered["role"], "tool")
            self.assertEqual(delivered["tool_call_id"], "export-for-remake")
            self.assertEqual(json.loads(delivered["content"])["export_ref"], downloadable["export_ref"])
            tool_event = db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='tool_end'", run["id"])
            self.assertEqual(json.loads(tool_event["data"])["result"]["export_ref"], downloadable["export_ref"])
            reply_event = db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='assistant'", run["id"])
            self.assertEqual(json.loads(reply_event["data"])["text"], reply["content"])
            server.JOBS.pop(export_job)
            resumed = await service.wait_jobs(run, self.user, call["id"], pending_export)
            self.assertEqual(resumed["export_ref"], downloadable["export_ref"])
            self.assertEqual((await assistant_export())["export_ref"], downloadable["export_ref"])
        enqueue.assert_called_once()
        self.assertTrue(db.q("SELECT data FROM chat_events WHERE session_id=? AND kind='progress'", run["session_id"]))
        final = (await act())["export"]
        self.assertEqual(final["state"], "done")
        self.assertEqual(downloadable["export_ref"], final["ref"])
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, final["ref"]))) as movie:
            first = next(movie.decode(video=0)).to_ndarray(format="rgb24")
        self.assertTrue(np.allclose(first[0,0], original.getpixel((0, 0))[:3], atol=8))
        self.assertTrue(np.allclose(first[36,36], original.getpixel((36, 36))[:3], atol=8))
        self.assertGreater(first[25,25,0], 170)
        self.assertGreater(first[25,14,0], 140)

        server.tools.ref_path(server.COMFY_DIR, final["ref"]).unlink()
        missing = (await act())["export"]
        self.assertEqual(missing["state"], "error")
        self.assertIsNone(missing["ref"])
        self.assertIn("请重新合成", missing["error"])
        status = await service.execute(run, self.user, "status", "video_remake_status", {"node_id":"n3"})
        self.assertEqual(status["export_state"], "error")
        self.assertIsNone(status["export_ref"])
        self.assertTrue(status["can_export"])
        rebuilt = await assistant_export()
        self.assertEqual(rebuilt["export_state"], "done")
        self.assertNotEqual(rebuilt["export_ref"], final["ref"])
        self.assertEqual((await act())["export"]["ref"], rebuilt["export_ref"])

        await act("select", rect=[.3,.3,.7,.7])
        with self.assertRaises(web.HTTPConflict) as changed:
            await act("generate_video")
        self.assertIn("首帧选区已更新", changed.exception.text)
        with self.assertRaises(web.HTTPConflict):
            await act("approve", job=job)
        kept = await service.execute(run, self.user, "keep", "video_remake_review", {**review_args, "decision":"keep"})
        self.assertTrue(kept["shots"][0]["keep_original"])
        self.assertTrue((await act())["shots"][0]["keep_original"])
        stale = await assistant_export()
        self.assertEqual(stale["export_state"], "stale")
        self.assertIsNone(stale["export_ref"])

        source_ref = self.make_clip("smoke-source", seconds=2, color=(40, 70, 100), frequency=440)
        source_path = server.tools.ref_path(server.COMFY_DIR, source_ref)
        reference_path = server.tools.ref_path(server.COMFY_DIR, self.source["ref"])
        app = web.Application()
        app["http"] = engine
        app["llm"] = vision
        app["creative_memory"] = server.creative_memory.Store(server)
        app.add_routes(server.routes)
        app.add_routes(server.creative_memory.routes)

        @asynccontextmanager
        async def request(method, path, *, params=None, data=None, allow_redirects=False, **options):
            url = URL(path).with_query(params or {})
            headers, payload = None, None
            if data is not None:
                form = data()
                headers = form.headers
                loop = asyncio.get_running_loop()
                payload = StreamReader(BaseProtocol(loop), limit=2**16)

                async def write(chunk):
                    payload.feed_data(chunk)

                await form.write(SimpleNamespace(write=write))
                payload.feed_eof()
            req = make_mocked_request(method, str(url), app=app, headers=headers, payload=payload)
            req._match_info = await app.router.resolve(req)
            req._match_info.add_app(app)
            req["user"] = self.user

            async def body():
                return options["json"]

            req.json = body
            response = await req.match_info.handler(req)
            if isinstance(response, web.FileResponse):
                async def chunks(size):
                    yield server.tools.ref_path(server.COMFY_DIR, params["ref"]).read_bytes()

                yield SimpleNamespace(status=response.status, content=SimpleNamespace(iter_chunked=chunks))
            else:
                async def response_json():
                    return json.loads(response.body)

                yield SimpleNamespace(status=response.status, json=response_json)

        client = SimpleNamespace(request=request, get=lambda path, **kwargs: request("GET", path, **kwargs))
        output_dir = server.BOARDS.parent / "smoke-result"
        output_dir.mkdir()
        args = SimpleNamespace(source=source_path, reference=reference_path, output=output_dir, shot=1,
                               timeout=15, person=None, rect=[.25, .25, .75, .75], motion="缓慢转身")
        with patch.object(server, "to_english", translated), redirect_stdout(io.StringIO()):
            await smoke_video_remake.smoke(client, args)
        evidence = json.loads((output_dir / "report.json").read_text())
        self.assertGreater(evidence["export"]["audio_correlation"], .99)
        self.assertEqual(evidence["export"]["seconds"], 2)
        self.assertEqual([call["kind"] for call in calls], ["image", "video", "image", "video"])
        self.assertEqual({path.name for path in output_dir.iterdir()}, {"preview.png", "localized.mp4", "export.mp4", "report.json"})

    async def test_remake_plan_asset_impact_and_two_role_layers_keep_independent_selections(self):
        db.run("INSERT INTO users(id,username,pw_hash) VALUES(7,'owner','test')")
        source = self.make_clip("roles-source", seconds=2, color=(40, 70, 90), frequency=440)
        first_take = self.make_clip("roles-first", seconds=2, color=(240, 32, 32), frequency=880)
        second_take = self.make_clip("roles-second", seconds=2, color=(32, 220, 32), frequency=880)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "name":"原片", "cur":0, "versions":[{"ref":source}]},
            {"id":"n1", "type":"image", "name":"参考", "versions":[self.source]},
        ]}))
        memory = server.creative_memory.Store(server)
        assets = [memory.put(self.user, {"name":name,"kind":"character","board":"test","ref":self.source["ref"]})
                  for name in ("林森", "裴简")]
        key = (7, "test", "n3", source)

        async def act(action=None, **fields):
            payload = {"action":action, "shot":0, **fields} if action else None
            with patch.object(server, "llm_call", side_effect=self.no_vision):
                return json.loads((await server.remake(Request(source, self.user, payload))).body)

        await act("analyze")
        service = server.agent_chat.AgentService({"creative_memory":memory}, server)
        planned = await service.execute({"board_id":"test","data":{"bindings":{"n3":source}}},
            self.user, "plan", "video_remake_plan",
            {"node_id":"n3", "asset_id":assets[0]["id"], "person":"甲", "shots":[1]})
        self.assertFalse(planned["remake_plan"]["shots"][0]["selection_ready"])
        self.assertNotIn("mapping", video_remake.load(key))
        plan_fields = {"person":"甲","asset":assets[0]["id"],"reference":assets[0]["ref"],"shots":[0],"plan_id":"saved-plan"}
        applied = await act("apply_plan", **plan_fields)
        self.assertEqual(applied["apply_plan"]["needs_selection"], [0])
        self.assertFalse(applied["apply_plan"]["jobs"])
        self.assertEqual((await act())["remake_plans"]["saved-plan"]["result"], applied["apply_plan"])

        original_masks = []
        for i, (name, asset, ref, rect) in enumerate(zip(("甲","乙"), assets, (first_take,second_take),
                ([.08,.20,.44,.8],[.56,.20,.92,.8]))):
            await act("map_person", person=name, asset=asset["id"], shots=[0])
            selected = await act("select", rect=rect)
            mask = selected["shots"][0]["frames"]["first"]["selection"]["mask"]
            original_masks.append(mask)
            state = video_remake.load(key)
            shot = state["shots"][0]
            role = {"id":asset["id"], "name":asset["name"], "ref":asset["ref"], "view":"main"}
            generated = {"job":f"raw-{i}", "state":"done", "ref":ref, "asset":role, "source_person":name,
                         "first_frame":shot["frames"]["first"]["ref"], "mask":mask}
            shot.setdefault("videos", []).append(generated)
            video_remake.save(key, state)
            localized = await act("localize", job=generated["job"])
            job = localized["shots"][0]["videos"][-1]["job"]
            await self.wait_for_render(job)
            await act("add_role_layer", job=job)

        replayed = await act("apply_plan", **plan_fields)
        self.assertEqual(replayed["apply_plan"], applied["apply_plan"])
        self.assertEqual(replayed["mapping"]["source"], "乙")
        restored = await act("map_person", person="甲", asset=assets[0]["id"], shots=[0])
        self.assertEqual(restored["shots"][0]["frames"]["first"]["selection"]["mask"], original_masks[0])
        self.assertEqual(len(restored["export_review"]["remaining"]), 1)
        submitted = await act("combine_roles")
        job = submitted["shots"][0]["videos"][-1]["job"]
        await self.wait_for_render(job)
        adopted = await act("approve_video", job=job)
        self.assertEqual(adopted["reviewed_jobs"], [job])
        combined = adopted["shots"][0]["videos"][-1]
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, combined["ref"]))) as clip:
            frame = next(clip.decode(video=0)).to_ndarray(format="rgb24")
        self.assertGreater(frame[32,16,0], 160)
        self.assertGreater(frame[32,48,1], 160)
        self.assertTrue(np.allclose(frame[2,2], [40,70,90], atol=12))

        new_ref = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"), "new-role", "input")["ref"]
        db.run("INSERT INTO memory_uploads VALUES(?,?,?)", new_ref, self.user["id"], time.time())
        memory.put(self.user, {"id":assets[0]["id"],"ref":new_ref,"default_ref":new_ref})
        req = Request(source, self.user)
        req.match_info = {"mid":assets[0]["id"]}
        req.query = {"board":"test"}
        impact = json.loads((await server.creative_memory.asset_impact(req)).body)
        self.assertEqual([(item["shot"],item["previous"],item["reference"]) for item in impact["remake"]],
                         [(0,assets[0]["ref"],new_ref)])
        used = {"id":assets[0]["id"], "ref":assets[0]["ref"]}
        for project, owner, shared in (("own",7,False), ("team",8,True), ("secret",8,False)):
            server.board_path(project).write_text(json.dumps({"owner":owner,"name":project,"shared":shared,
                "nodes":[{"id":"n1","name":"镜头","versions":[{"ref":source,"memory_used":[used]}]}]}))
        req.query["all"] = "1"
        across = json.loads((await server.creative_memory.asset_impact(req)).body)
        self.assertEqual({item["board"] for item in across["canvas"]}, {"own","team"})
        with self.assertRaises(web.HTTPConflict):
            await act("apply_plan", person="甲", asset=assets[0]["id"], reference=assets[0]["ref"], shots=[0])
        self.assertEqual((await act())["reviewed_jobs"], [job])

        changed = await act("move_role_layer", job=combined["roles"][1]["job"])
        self.assertEqual(changed["reviewed_jobs"], [None])
        self.assertIn("重新合成", changed["export_review"]["remaining"][0]["error"])

    def test_editable_remake_timeline_uses_the_original_audio_for_reordered_and_trimmed_clips(self):
        source = self.make_clip("audio-original", seconds=3, color=(40, 70, 90), frequency=440, audio_delay=1)
        take = self.make_clip("audio-take", seconds=2, color=(100, 190, 10), frequency=880)
        result = server.film.render(server.COMFY_DIR, {"remake_audio":source, "subtitles":False, "clips":[
            {"ref":take,"in":.25,"out":1.25,"audio_start":1},
            {"ref":source,"in":0,"out":.5,"audio_start":0},
        ]})
        path = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        pcm = server.film.read_audio(path)[0]
        rate = server.film.SR
        self.assertAlmostEqual(result["seconds"], 1.5, places=2)
        self.assertEqual(np.argmax(np.abs(np.fft.rfft(pcm[:rate]))), 440)
        self.assertLess(np.max(np.abs(pcm[round(1.1*rate):])), .025)

    def test_segment_replacements_can_keep_the_timestamp_aligned_original_sound(self):
        source = self.make_clip("segment-original", 3, (40, 70, 90), 440, audio_delay=1)
        take = self.make_clip("segment-take", 2, (10, 40, 210), 880)
        clips = [
            {"ref":source,"in":0,"out":.5,"audio_ref":source,"audio_start":0,"tight":True},
            {"ref":take,"in":.25,"out":1.75,"audio_ref":source,"audio_start":.25,"tight":True},
            {"ref":source,"in":2,"out":3,"audio_ref":source,"audio_start":0,"tight":True},
        ]
        spec = {"clips":clips}
        self.assertTrue(server.film_preflight(spec)["ok"])
        result = server.film.render(server.COMFY_DIR, spec)
        output = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        rate = server.film.SR
        pcm = server.film.read_audio(output)[0]
        self.assertAlmostEqual(result["seconds"], 3)
        self.assertLess(np.max(np.abs(pcm[:round(.9*rate)])), .025)
        for start in (1.25, 2.25):
            sample = pcm[round(start*rate):round((start+.5)*rate)]
            self.assertEqual(np.argmax(np.abs(np.fft.rfft(sample))) * 2, 440)
        with av.open(str(output)) as media:
            frames = list(media.decode(video=0))
        self.assertEqual(len(frames), 72)
        self.assertGreater(frames[24].to_ndarray(format="rgb24")[0,0,2], 190)
        clips[1]["audio_start"] = 2
        check = server.film_preflight(spec)
        self.assertEqual(check["issues"][0]["clip"], 1)
        self.assertIn("原片音轨", check["issues"][0]["error"])

    async def test_captions_use_the_selected_soundtrack_and_render_at_source_times(self):
        source = self.make_clip("caption-picture", 3, (30, 30, 30), 880)
        original = self.make_clip("caption-original", 4, (20, 20, 20), 440)
        server.write_board(server.board_path("test"), {"owner":7,"collaborators":{"8":"reviewer"},"nodes":[
            {"id":"n3","type":"video","versions":[{"ref":source}]},
            {"id":"n4","type":"video","versions":[{"ref":original}]},
        ]})

        @web.middleware
        async def fixture_user(req, handler):
            req["user"] = {"id":int(req.headers.get("X-Uid", "7")),"role":"member"}
            return await handler(req)

        @asynccontextmanager
        async def post(url, *, data, **kwargs):
            fields = {options["name"]:value for options, _, value in data._fields}
            self.assertEqual((url, fields["model"], fields["response_format"], fields["timestamp_granularities[]"]),
                             ("https://captions.invalid/v1/audio/transcriptions","whisper-1","verbose_json","segment"))
            with wave.open(io.BytesIO(fields["file"])) as wav:
                rate = wav.getframerate()
                self.assertEqual(wav.getnframes(), rate * 2)
                pcm = np.frombuffer(wav.readframes(rate), dtype="<i2")
                self.assertEqual(np.argmax(np.abs(np.fft.rfft(pcm))), 440)

            async def transcribed():
                return {"text":"测试字幕", "segments":[{"start":.5,"end":1.5,"text":"测试字幕"}]}

            yield SimpleNamespace(status=200,json=transcribed)

        app = web.Application(middlewares=[fixture_user,server.media_input_guard])
        app["http"] = SimpleNamespace(post=post)
        app.router.add_post("/api/video/captions", server.video_captions)
        providers = server.providers
        primary = providers.save(None,"asr_compat","字幕",{"base_url":"https://captions.invalid/v1"},{},True)
        providers.set_route("asr",[{"provider_id":primary,"model":"whisper-1"}])
        clip = {"ref":source,"in":1,"out":3,"audio_ref":original,"audio_start":.5,"speed":2}
        async with TestClient(TestServer(app)) as client:
            api = "/api/video/captions"
            self.assertEqual((await client.post(api,json={"board":"test",**clip},headers={"X-Uid":"8"})).status,403)
            response = await client.post(api,json={"board":"test",**clip})
            self.assertEqual(response.status,200,await response.text())
            clip["captions"] = (await response.json())["captions"]
        self.assertEqual(clip["captions"],[{"start":1.5,"end":2.5,"text":"测试字幕"}])
        spec = {"clips":[clip]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        # Use a solid strip to verify the actual frame timestamps independently of the machine's fonts.
        with patch.object(server.film,"subtitle_overlay",return_value=(np.full((4,64,4),255,np.float32),50)):
            result = server.film.render(server.COMFY_DIR,spec)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,result["ref"]))) as media:
            shown = [i for i,frame in enumerate(media.decode(video=0)) if frame.to_ndarray(format="rgb24")[51,32,0] > 200]
        self.assertEqual(shown,list(range(6,18)))

    def test_cutaways_replace_only_picture_on_the_main_timeline(self):
        source = self.make_clip("cutaway-main",3,(26,26,26),440)
        insert = self.make_clip("cutaway-video",2,lambda tick:(225,26,26) if tick<24 else (26,26,225),880)
        still = image_editor.save(server.COMFY_DIR,Image.new("RGBA",(48,64),(26,220,26,255)),"input")["ref"]
        cutaways = [{"kind":"video","ref":insert,"start":.5,"duration":1,"in":1},
                    {"kind":"image","ref":still,"start":1.5,"duration":.5}]
        spec = {"clips":[{"ref":source,"in":0,"out":3}],"cutaways":cutaways,"subtitles":False,"cover":.75}
        self.assertTrue(server.film_preflight(spec)["ok"])
        with self.assertRaisesRegex(ValueError,"补画面重叠"):
            server.film_preflight({**spec,"cutaways":[cutaways[0],{**cutaways[1],"start":1.4}]})
        result = server.film.render(server.COMFY_DIR,spec)
        path = server.tools.ref_path(server.COMFY_DIR,result["ref"])
        with av.open(str(path)) as media:
            pixels = [frame.to_ndarray(format="rgb24")[32,32] for frame in media.decode(video=0)]
        self.assertEqual(len(pixels),72)
        self.assertTrue(all(max(px) < 70 for px in pixels[:12]+pixels[48:]))
        self.assertTrue(all(px[2] > 190 for px in pixels[12:36]))
        self.assertTrue(all(px[1] > 190 for px in pixels[36:48]))
        rate = server.film.SR
        soundtrack = server.film.read_audio(path)[0][rate//2:rate*3//2]
        self.assertEqual(int(np.argmax(np.abs(np.fft.rfft(soundtrack)))),440)
        with Image.open(server.tools.ref_path(server.COMFY_DIR,result["cover"])) as cover:
            self.assertGreater(cover.getpixel((32,32))[2],190)

    def test_titles_are_burned_into_the_timed_picture_and_cover(self):
        from PIL import ImageFont

        source = self.make_clip("title-background", 2, (28, 28, 28), 440)
        spec = {"clips":[{"ref":source,"in":0,"out":2}],"subtitles":False,"cover":.75,
                "titles":[{"text":"Scene I","start":.51,"end":1.02,"position":"lower_left","style":"label"}]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        with self.assertRaisesRegex(ValueError, "第 1 条标题"):
            server.film_preflight({**spec,"titles":[{**spec["titles"][0],"end":.2}]})
        font = ImageFont.load_default(size=12)
        with patch.object(ImageFont,"truetype",side_effect=lambda _path,size:font.font_variant(size=size)):
            result = server.film.render(server.COMFY_DIR,spec)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,result["ref"]))) as media:
            visible = []
            for index, frame in enumerate(media.decode(video=0)):
                image = frame.to_ndarray(format="rgb24")
                self.assertLess(image[:30].max(),80)
                if image[40:57,:46].max() > 150:
                    visible.append(index)
        self.assertEqual(visible,list(range(13,25)))
        with Image.open(server.tools.ref_path(server.COMFY_DIR,result["cover"])) as cover:
            self.assertGreater(np.asarray(cover)[40:57,:46].max(),150)

    def test_film_clip_speed_changes_frame_timing_without_changing_audio_pitch(self):
        source = self.make_clip("retime-source", 2,
                                lambda tick: (240,20,20) if tick < 24 else (20,40,225), 440)
        alternate_audio = self.make_clip("retime-original-sound", 2, (30,30,30), 660)
        clips = [
            {"ref":source,"in":0,"out":2,"speed":2},
            {"ref":source,"in":1,"out":2,"speed":.5,"audio_ref":alternate_audio,"audio_start":0},
        ]
        spec = {"clips":clips}
        self.assertTrue(server.film_preflight(spec)["ok"])
        result = server.film.render(server.COMFY_DIR, spec)
        output = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        with av.open(str(output)) as media:
            frames = list(media.decode(video=0))
        self.assertEqual(len(frames), 72)
        for index, channel in ((11,0),(12,2),(24,2),(71,2)):
            self.assertGreater(frames[index].to_ndarray(format="rgb24")[0,0,channel], 195)
        self.assertAlmostEqual(result["seconds"], 3)
        rate = server.film.SR
        pcm = server.film.read_audio(output)[0]
        for begin, pitch in ((.25,440),(1.25,660)):
            samples = pcm[round(begin*rate):round((begin+.5)*rate)]
            self.assertEqual(np.argmax(np.abs(np.fft.rfft(samples))) * 2, pitch)
        clips[1]["speed"] = 3
        self.assertIn("播放速度", server.film_preflight(spec)["issues"][0]["error"])

    async def test_capture_at_playhead_keeps_tail_capture_available(self):
        source = self.make_clip("playhead", seconds=2, frequency=440,
                                color=lambda tick: (220,30,30) if tick < 24 else (30,30,220))
        for fields, channel, timestamp in (({"at":.52},0,.5), ({"position":"first"},0,0),
                                           ({"position":"last"},2,47/24), ({"at":None},2,47/24)):
            request = Request(source, self.user, {"ref":source,**fields})
            result = json.loads((await server.lastframe(request)).body)
            image = image_editor.load(server.COMFY_DIR, result["ref"])
            self.assertGreater(image.getpixel((32,32))[channel], 190)
            self.assertEqual((result["w"],result["h"]), (64,64))
            self.assertAlmostEqual(result["at"], timestamp, places=5)
            self.assertTrue(server.can_read_media(self.user, result["ref"]))

    async def test_frame_preview_reads_first_and_last_without_creating_assets(self):
        source = self.make_clip("review-boundary", seconds=2, frequency=440,
                                color=lambda tick: (220,30,30) if tick < 24 else (30,30,220))
        server.grant_media(self.user,source)
        before = set(server.COMFY_DIR.rglob("*"))
        for position,channel in (("first",0),("last",2)):
            request = Request(source,self.user)
            request.query = {"ref":source,"position":position}
            response = await server.video_frame_preview(request)
            self.assertEqual(response.content_type,"image/png")
            self.assertIn("no-store",response.headers["Cache-Control"])
            with Image.open(io.BytesIO(response.body)) as frame:
                self.assertGreater(frame.getpixel((32,32))[channel],190)
        self.assertEqual(set(server.COMFY_DIR.rglob("*")),before)
        outsider = Request(source,{"id":99,"role":"member"})
        outsider.query = {"ref":source,"position":"last"}
        with self.assertRaises(web.HTTPNotFound):
            await server.video_frame_preview(outsider)

    async def test_film_checks_missing_clips_and_replays_an_accepted_export(self):
        source = self.make_clip("checked-film", seconds=1, color=(40,70,90), frequency=440)
        spec = {"clips":[{"ref":source,"in":0,"out":1}], "subtitles":False}
        check = server.film_preflight({**spec,"clips":[*spec["clips"],{"ref":"input:h3studio/missing.mp4"}]})
        self.assertFalse(check["ok"])
        self.assertEqual(check["issues"][0]["clip"], 1)
        self.assertEqual(check["dimensions"], (64,64))
        with patch.object(server, "enqueue_film", wraps=server.enqueue_film) as enqueue:
            req = Request(source, self.user, {"spec":spec,"request_key":"same-render-attempt-1"})
            first = json.loads((await server.render_film(req)).body)
            repeat = json.loads((await server.render_film(req)).body)
            self.assertEqual(repeat["ids"], first["ids"])
            enqueue.assert_called_once()
            await self.wait_for_render(first["ids"][0])
            server.JOBS.pop(first["ids"][0], None)
            after_restart = json.loads((await server.render_film(req)).body)
            self.assertEqual(after_restart["ids"], first["ids"])

    async def test_mixed_film_exports_still_and_video_with_their_timing_and_audio(self):
        video = self.make_clip("mixed-film", seconds=1, color=(20, 30, 220), frequency=440)
        still = {"kind":"image", "ref":self.source["ref"], "duration":.75, "trans":"fade"}
        spec = {"clips":[still, {"ref":video, "in":0, "out":1}], "subtitles":False, "cover":.2}
        self.assertEqual(server.film_preflight(spec)["dimensions"], (64, 64))
        for invalid in ({"duration":0}, {"duration":61}, {"duration":"NaN"}, {"ref":video}):
            check = server.film_preflight({"clips":[{**still, **invalid}]})
            self.assertFalse(check["ok"])
            self.assertEqual(check["issues"][0]["clip"], 0)
        response = await server.render_film(Request(video, self.user, {"spec":spec, "request_key":"mixed-film-render"}))
        result = await self.wait_for_render(json.loads(response.body)["ids"][0])
        ref = json.loads(result["outputs"])[0]
        path = server.tools.ref_path(server.COMFY_DIR, ref)
        with av.open(str(path)) as output:
            frames = [frame.to_image().getpixel((32, 32)) for frame in output.decode(video=0)]
        self.assertEqual(len(frames), 33)
        self.assertGreater(frames[3][0], 235)
        self.assertGreater(frames[13][0], 70)
        self.assertGreater(frames[13][2], 45)
        self.assertGreater(frames[-1][2], 190)
        pcm = server.film.read_audio(path)[0]
        self.assertLess(np.abs(pcm[:server.film.SR // 4]).max(), .025)
        self.assertGreater(np.abs(pcm[-server.film.SR // 2:]).max(), .10)

    def test_timed_audio_is_trimmed_mixed_and_capped_to_the_picture(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "fx", ".wav")
        rate = server.film.SR
        ticks = np.arange(rate // 2)
        signal = np.concatenate([np.sin(ticks * (2 * np.pi * frequency / rate)) for frequency in (440, 660)])
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes((signal * 16000).astype("<i2").tobytes())
        timed = {"ref":source, "start":.5, "in":.5, "out":1, "volume":.5}
        spec = {"clips":[{"kind":"image", "ref":self.source["ref"], "duration":1.5}], "audio_clips":[timed, {**timed, "start":1.25}]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        for change in ({"out":.5}, {"start":-1}, {"volume":2}):
            invalid = {**spec, "audio_clips":[{**timed, **change}]}
            self.assertEqual(server.film_preflight(invalid)["issues"][0]["audio"], 0)
        result = server.film.render(server.COMFY_DIR, spec)
        self.assertEqual(result["seconds"], 1.5)
        pcm = server.film.read_audio(server.tools.ref_path(server.COMFY_DIR, result["ref"]))[0]
        for start in (.1, 1.05):
            self.assertLess(np.max(np.abs(pcm[round(start * rate):round((start + .1) * rate)])), .025)
        measured = pcm[round(.6 * rate):round(.8 * rate)]
        frequency = np.argmax(np.abs(np.fft.rfft(measured))) * rate / len(measured)
        self.assertEqual(frequency, 660)
        self.assertTrue(.13 < np.abs(measured).max() < .22)
        self.assertGreater(np.abs(pcm[round(1.35 * rate):round(1.45 * rate)]).max(), .13)

    def test_editable_remake_timeline_uses_original_dimensions(self):
        _, source = server.tools._new(server.COMFY_DIR, "input", "landscape-original", ".mp4")
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, source)), "w") as output:
            stream = output.add_stream("libx264", rate=24)
            stream.width, stream.height, stream.pix_fmt = 96, 64, "yuv420p"
            for _ in range(24):
                for packet in stream.encode(av.VideoFrame.from_image(Image.new("RGB", (96, 64), "gray"))):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
        take = self.make_clip("square-take", seconds=1, color=(100,190,10), frequency=880)
        result = server.film.render(server.COMFY_DIR, {"remake_audio":source, "subtitles":False, "clips":[
            {"ref":take, "in":0, "out":1, "audio_start":0},
        ]})
        self.assertEqual((result["w"], result["h"]), (96,64))

    async def test_role_changes_keep_other_approved_shots_and_restore_only_the_corresponding_masks(self):
        source = self.make_clip("role-change", seconds=2, color=(40,70,90), frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
            {"id":"n1", "type":"image", "versions":[self.source]},
        ]}))
        memory = server.creative_memory.Store(server)
        asset = memory.put(self.user, {"name":"角色", "kind":"character", "board":"test", "ref":self.source["ref"]})
        key = (7, "test", "n3", source)
        first = video_remake.frame_record(self.source["ref"], (64,64))
        second = video_remake.frame_record(self.source["ref"], (64,64))
        video_remake.save(key, {"shots":[{"start":0,"end":1,"frames":{"first":first}},
                                        {"start":1,"end":2,"frames":{"first":second}}]})

        async def act(action, **fields):
            req = Request(source, self.user, {"shot":0, "action":action, **fields})
            return json.loads((await server.remake(req)).body)

        await act("map_person", person="甲", asset=asset["id"], shots=[0])
        await act("select", rect=[.1,.1,.8,.8])
        protected = await act("select", layer="protection", rect=[.2,.2,.4,.4])
        original = protected["shots"][0]["frames"]["first"]
        prepared = video_remake.load(key)
        prepared["shots"][0]["videos"] = [{"job":"first", "state":"done", "ref":source,
                                            "source_person":"甲", "asset":{"id":asset["id"]}}]
        video_remake.save(key, prepared)
        await act("approve_video", job="first")
        other = await act("map_person", person="乙", asset=asset["id"], shots=[1])
        self.assertEqual(other["reviewed_jobs"], ["first", None])
        self.assertEqual([i["shot"] for i in other["export_review"]["remaining"]], [1])
        await act("keep", shot=1)
        adopted = video_remake.load(key)
        self.assertEqual(video_remake.export_plan(adopted, source, 24, 2)["clips"][0]["in"], 0)
        await act("map_person", person="甲", asset=asset["id"], shots=[0])
        await act("remove_mapping")
        different = await act("map_person", person="乙", asset=asset["id"], shots=[0])
        self.assertNotIn("protection", different["shots"][0]["frames"]["first"])
        self.assertNotIn("selection", different["shots"][0]["frames"]["first"])
        restored = await act("map_person", person="甲", asset=asset["id"], shots=[0])
        frame = restored["shots"][0]["frames"]["first"]
        self.assertEqual(frame["protection"], original["protection"])
        self.assertEqual(frame["selection"], original["selection"])

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

    async def test_batch_first_previews_saves_accepted_jobs_and_retries_only_missing_shots(self):
        source = self.make_clip("batch", seconds=3, color=(210, 30, 30), frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n1", "type":"image", "versions":[self.source]},
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        asset = server.creative_memory.Store(server).put(self.user, {
            "name":"替换角色", "kind":"character", "board":"test",
            "ref":self.source["ref"], "source_board":"test",
        })
        video_remake.save((7, "test", "n3", source), {"shots":[
            {"start":index, "end":index + 1, "summary":{},
             "frames":{"first":video_remake.frame_record(self.source["ref"], (64,64))}}
            for index in range(3)
        ]})

        async def act(action=None, **fields):
            response = await server.remake(Request(source, self.user, {"action":action, **fields} if action else None))
            return json.loads(response.body)

        await act("map_person", person="人物甲", asset=asset["id"], shots=[0,1])
        locate_args = {"person":"人物甲", "asset":asset["id"], "shots":[0,1]}
        with patch.object(server.tools, "locate_shot_person", side_effect=[{"point":[.5,.5]}, {"point":None}]) as locate:
            with self.assertRaises(web.HTTPConflict):
                await act("batch_locate_people", **locate_args, look="旧外貌描述")
            with self.assertRaises(web.HTTPBadRequest):
                await act("batch_locate_people", **{**locate_args, "shots":[0,2]})
            locate.assert_not_called()
            located = await act("batch_locate_people", **locate_args)
        self.assertEqual(located["batch_locate_people"]["located"], [0])
        self.assertEqual(located["batch_locate_people"]["failed"][0]["shot"], 1)
        first = (await act())["shots"][0]["frames"]["first"]
        self.assertEqual(first["person_hint"]["point"], [.5,.5])
        self.assertNotIn("selection", first)
        await act("set_absence", shot=1, frame="first", absent=True)
        with patch.object(server.tools, "locate_shot_person") as locate:
            repeat = await act("batch_locate_people", **locate_args)
            self.assertEqual(repeat["batch_locate_people"]["skipped"], [0,1])
            locate.assert_not_called()
        for index in (0, 2):
            await act("select", shot=index, rect=[.25,.25,.75,.75])
        async def candidate(llm, samples, person, appearance):
            self.assertEqual(person, "人物甲")
            ticks = [tick for tick, _ in samples]
            if ticks == [5, 9, 14, 18, 23]:
                return {"sample":2, "point":[.3,.4]}
            self.assertEqual(ticks, [6, 7, 8])
            return {"sample":1, "point":[.5,.6]}

        with patch.object(server.tools, "locate_shot_entry", side_effect=candidate) as locate_entry:
            suggested = await act("suggest_entry", shot=1, person="人物甲")
        self.assertEqual(locate_entry.await_count, 2)
        entry = suggested["captured_frame"]
        located_entry = suggested["shots"][1]["frames"][entry]
        self.assertEqual(located_entry["at"], 1.25)
        self.assertEqual(located_entry["person_hint"]["point"], [.5,.6])
        self.assertNotIn("selection", located_entry)
        later = (await act("capture_correction", shot=1, at=1.5))["captured_frame"]
        for key in (later, entry):
            await act("select", shot=1, frame=key, rect=[.25,.25,.75,.75])
        requests = []

        async def submit(req, payload):
            requests.append(payload)
            job = f"batch-{len(requests)}"
            if len(requests) == 1:
                db.task_start(id=job, user_id=7, state="done", outputs=[self.source["ref"]])
            elif len(requests) == 2:
                saved = video_remake.load((7, "test", "n3", source))
                self.assertEqual(saved["shots"][0]["frames"]["first"]["previews"][0]["job"], "batch-1")
                raise server.bad("任务暂时无法提交")
            return web.json_response({"ids":[job]})

        async def batch(*shots):
            return (await act("batch_previews", person="人物甲", asset=asset["id"], shots=[
                {"shot":index, "frame":entry if index == 1 else "first", "view":view} for index, view in shots
            ]))["batch_previews"]

        with patch.object(server, "_generate_request", side_effect=submit):
            with self.assertRaises(web.HTTPBadRequest):
                await batch((0, "main"), (2, "main"))
            stale = await act("batch_previews", person="人物甲", asset=asset["id"],
                              shots=[{"shot":1, "frame":later}])
            self.assertIn("入画帧已变更", stale["batch_previews"]["failed"][0]["error"])
            self.assertEqual(len(requests), 0)
            partial = await batch((0, "main"), (1, "main"))
            self.assertEqual(partial["submitted"], [0])
            self.assertEqual(partial["failed"], [{"shot":1, "error":"任务暂时无法提交"}])
            self.assertEqual((await act())["shots"][0]["frames"]["first"]["previews"][0]["job"], "batch-1")
            self.assertEqual(await batch((0, "main"), (1, "main")),
                             {"submitted":[1], "skipped":[0], "failed":[]})
            self.assertEqual(await batch((0, "main"), (1, "main")),
                             {"submitted":[], "skipped":[0,1], "failed":[]})
            updated = await act("batch_previews", person="人物甲", asset=asset["id"],
                                shots=[{"shot":0, "view":"main", "note":"保留茶杯"}])
            self.assertEqual(updated["batch_previews"]["submitted"], [0])
        self.assertEqual(len(requests), 4)
        self.assertIn("保留茶杯", requests[-1]["prompt"])
        await act("approve", shot=0, job="batch-1")
        db.task_start(id="batch-3", user_id=7, state="done", outputs=[self.source["ref"]])
        frames = (await act())["shots"][1]["frames"]
        self.assertEqual(frames["first"]["previews"], [])
        self.assertEqual(frames[later]["previews"], [])
        self.assertEqual(frames[entry]["previews"][0]["job"], "batch-3")
        await act("approve", shot=1, frame=entry, job="batch-3")
        server.providers.seed()
        video_requests = []

        async def submit_video(req, payload):
            video_requests.append(payload)
            job = f"movie-{len(video_requests)}"
            db.task_start(id=job, user_id=7, state="done", outputs=[source])
            return web.json_response({"ids":[job]})

        video_inputs = [{"shot":0, "first_job":"batch-1", "motion":"回头"},
                        {"shot":1, "first_job":"batch-3", "motion":"挥手"}]
        with patch.object(server, "_generate_request", side_effect=submit_video):
            mismatch = await act("batch_videos", person="人物甲", asset=asset["id"], shots=[
                {"shot":0, "first_job":"stale", "motion":"回头"},
            ])
            self.assertEqual(mismatch["batch_videos"]["failed"][0]["shot"], 0)
            self.assertEqual(video_requests, [])
            queued = await act("batch_videos", person="人物甲", asset=asset["id"], shots=video_inputs)
            self.assertEqual(queued["batch_videos"]["submitted"], [0,1])
            repeated = await act("batch_videos", person="人物甲", asset=asset["id"], shots=video_inputs)
            self.assertEqual(repeated["batch_videos"]["skipped"], [0,1])
        self.assertEqual(len(video_requests), 2)
        self.assertIn("回头", video_requests[0]["prompt"])
        self.assertIn("挥手", video_requests[1]["prompt"])
        self.assertEqual(video_requests[1]["images"][1]["time"], .25)

        db.task_start(id="batch-4", user_id=7, state="done", outputs=[self.source["ref"]])
        replacement = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"), "asset", "input")
        board = json.loads(server.board_path("test").read_text())
        board["nodes"][0]["versions"].append(replacement)
        server.board_path("test").write_text(json.dumps(board))
        server.creative_memory.Store(server).put(self.user, {
            "id":asset["id"], "ref":replacement["ref"], "default_ref":replacement["ref"], "source_board":"test",
        })
        with patch.object(server, "_generate_request", side_effect=submit):
            stale = await act("batch_previews", person="人物甲", asset=asset["id"],
                              shots=[{"shot":0, "view":"main", "reference":self.source["ref"]}])
            self.assertIn("角色参考图已更新", stale["batch_previews"]["failed"][0]["error"])
            self.assertEqual(len(requests), 4)
            refreshed = await batch((0, "main"), (1, "main"))
        self.assertEqual(refreshed["submitted"], [0,1])
        self.assertEqual([payload["images"][2]["ref"] for payload in requests[-2:]], [replacement["ref"]] * 2)
        first = (await act())["shots"][0]["frames"]["first"]
        self.assertEqual(first["approved"], "batch-1")
        self.assertEqual(first["previews"][-1]["asset"]["ref"], replacement["ref"])

    async def test_reviewed_shot_export_keeps_source_cut_and_continuous_audio(self):
        source = self.make_clip("original", seconds=4, color=lambda tick: (210 if tick < 24 else 160, 30, 30),
                                frequency=440, audio_delay=.5)
        remake = self.make_clip("replacement", seconds=3, color=(30, 210, 30), frequency=880)
        too_short = self.make_clip("short", seconds=1, color=(30, 30, 210), frequency=880)
        board = {"owner": 7, "nodes": [{"id":"n3", "type":"video", "versions":[{"ref":source}]}]}
        board["nodes"].append({"id":"n1", "type":"image", "versions":[self.source]})
        server.board_path("test").write_text(json.dumps(board))
        asset = server.creative_memory.Store(server).put(self.user, {
            "name":"新角色", "kind":"character", "board":"test", "ref":self.source["ref"], "source_board":"test",
        })
        shot_frame = video_remake.original_frames(server, source, {0})[0]
        selected = Image.new("L", (64, 64))
        selected.paste(255, (16,16,48,48))
        mask = image_editor.save(server.COMFY_DIR, selected, "mask", "input")["ref"]
        shot_frame["previews"] = [{
            "job":"frame-preview", "state":"done", "ref":self.source["ref"], "mask":mask,
            "asset":{"id":asset["id"], "name":asset["name"], "ref":self.source["ref"]},
            "source_person":"穿红衣的人",
        }]
        shot_frame["approved"] = "frame-preview"
        key = (7, "test", "n3", source)
        video_remake.save(key, {"shots":[
            {"start":0, "end":2, "summary":{"action":["转身"], "camera":"固定机位"},
             "frames":{"first":shot_frame, "middle":video_remake.frame_record(self.source["ref"], (64, 64))}},
            {"start":2, "end":4, "summary":{},
             "frames":{"first":video_remake.frame_record(self.source["ref"], (64, 64))}},
        ]})

        cut_revision = 0

        async def act(action, **kwargs):
            nonlocal cut_revision
            response = await server.remake(Request(source, self.user, {
                "action":action, "shot":0, "cut_revision":cut_revision, **kwargs,
            }))
            result = json.loads(response.body)
            cut_revision = result.get("cut_revision", 0)
            return result

        with self.assertRaises(web.HTTPBadRequest):
            await act("map_person", person="穿红衣的人", asset=asset["id"], shots=[])
        mapped = await act("map_person", person="穿红衣的人", asset=asset["id"], shots=[0])
        self.assertEqual(mapped["mapping"]["shots"], [0])
        self.assertEqual(mapped["export_review"]["adopted"], 0)
        self.assertEqual([item["shot"] for item in mapped["export_review"]["remaining"]], [0])
        with self.assertRaises(web.HTTPBadRequest):
            await act("generate_video", shot=1)

        results = iter([too_short, remake, remake])
        requests = []
        async def generate(req, raw):
            requests.append(raw)
            job = f"shot-gen-{len(requests)}"
            db.task_start(id=job, user_id=7, board_id="test", state="done", outputs=[next(results)])
            return web.json_response({"ids":[job]})

        with patch.object(server, "generate_request", side_effect=generate):
            await act("generate_video", motion="第一秒回头")
            self.assertEqual(requests[0]["images"][0]["ref"], self.source["ref"])
            self.assertIn("第一秒回头", requests[0]["prompt"])
            self.assertIn("口部动作和停顿", requests[0]["prompt"])
            _, normal = server.graph_video({**requests[0], "_preserve_speech_motion": False})
            _, remake_prompt = server.graph_video(requests[0])
            self.assertIn(server.NO_SPEECH, normal["full_prompt"])
            self.assertNotIn(server.NO_SPEECH, remake_prompt["full_prompt"])
            with self.assertRaises(web.HTTPBadRequest):
                await act("approve_video", job="shot-gen-1")
            with self.assertRaises(web.HTTPBadRequest):
                await act("export")
        with self.assertRaises(web.HTTPBadRequest):
            await act("capture_correction", at=2.5)
        captured = await act("capture_correction", at=1)
        correction = captured["captured_frame"]
        self.assertEqual(captured["shots"][0]["frames"][correction]["correction_tick"], 24)
        selected_frame = await act("select", frame=correction, rect=[.375,.25,.875,.75])
        corrected_mask = selected_frame["shots"][0]["frames"][correction]["selection"]["mask"]
        guide_ref = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "orange"))["ref"]
        return_ref = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "green"))["ref"]
        guide_outputs = iter([("guide", guide_ref), ("return-guide", return_ref)])

        async def render_guide(req, payload):
            job, ref = next(guide_outputs)
            db.task_start(id=job, user_id=7, state="done", outputs=[ref])
            return web.json_response({"ids":[job]})

        with patch.object(server, "_generate_request", side_effect=render_guide):
            await act("preview", frame=correction, asset=asset["id"])
        reviewed = await act("approve", frame=correction, job="guide")
        self.assertEqual(reviewed["shots"][0]["frames"]["first"]["approved"], "frame-preview")
        self.assertEqual(reviewed["shots"][0]["frames"][correction]["approved"], "guide")
        snapshot = reviewed["shots"][0]
        snapshot["frames"][correction]["protection"] = {"mask":corrected_mask}
        with self.assertRaises(web.HTTPConflict) as outdated:
            video_remake.shot_guides(snapshot, shot_frame["previews"][0], server.film.FPS, reviewed["mapping"])
        self.assertIn("1.00 秒的动作关键帧选区已更新", outdated.exception.text)
        exit_frame = (await act("capture_correction", at=1.25))["captured_frame"]
        await act("set_absence", frame=exit_frame, absent=True)
        return_frame = (await act("capture_correction", at=1.5))["captured_frame"]
        resumed = await act("select", frame=return_frame, rect=[.375,.25,.875,.75])
        return_mask = resumed["shots"][0]["frames"][return_frame]["selection"]["mask"]
        with self.assertRaises(web.HTTPBadRequest) as missing_guide:
            await act("localize", job="shot-gen-1")
        self.assertIn("人物重新入画", missing_guide.exception.text)
        with patch.object(server, "_generate_request", side_effect=render_guide):
            await act("preview", frame=return_frame, asset=asset["id"])
        await act("approve", frame=return_frame, job="return-guide")
        with self.assertRaises(web.HTTPBadRequest):
            await act("generate_video")
        server.providers.seed()
        with patch.object(server, "generate_request", side_effect=generate):
            guided = await act("generate_video")
        self.assertEqual(requests[1]["provider"], "local_h3")
        self.assertEqual(guided["shots"][0]["videos"][-1]["guides"], [{"tick":24,"ref":guide_ref}, {"tick":36,"ref":return_ref}])
        body, _ = server.engine_body(requests[1])
        self.assertEqual([frame["frame"] for frame in body["keyframes"]], [0, 24, 36])
        self.assertEqual(body["keyframes"][1]["path"], str(server.tools.ref_path(server.COMFY_DIR, guide_ref)))
        corrected = await act("select", frame=correction, rect=[.375,.25,.875,.75])
        revised_mask = corrected["shots"][0]["frames"][correction]["selection"]["mask"]
        self.assertNotEqual(revised_mask, corrected_mask)

        protected = await act("select", layer="protection", rect=[.58,.55,.72,.72])
        protection_mask = protected["shots"][0]["frames"]["first"]["protection"]["mask"]
        await act("clear_protection", frame=correction)
        original_only = (await act("capture_correction", at=1.125))["captured_frame"]
        selected = await act("select", frame=original_only, rect=[.375,.25,.875,.75])
        original_only_mask = selected["shots"][0]["frames"][original_only]["selection"]["mask"]
        advance = video_matte.MaskTrack.advance
        failed_forward = []

        def lose_forward_track(track, image, index):
            if index == 18 and image.ndim == 3 and track.initial_area >= 512:
                failed_forward.append("original" if image[0, 0, 0] > image[0, 0, 1] else "replacement")
                raise ValueError("forward tracking lost the subject")
            advance(track, image, index)

        with patch.object(video_matte.MaskTrack, "advance", lose_forward_track):
            local = await act("localize", job="shot-gen-2")
            localized = local["shots"][0]["videos"][-1]
            self.assertEqual(localized["corrections"], {"24":revised_mask, "27":original_only_mask, "30":None, "36":return_mask})
            self.assertEqual(localized["replacement_corrections"], {"24":corrected_mask, "30":None, "36":return_mask})
            self.assertEqual(localized["protections"], {"0":protection_mask, "24":None})
            local_job = localized["job"]
            await act("remove_correction", frame=correction)
            await act("remove_correction", frame=original_only)
            await self.wait_for_render(local_job)
        self.assertEqual(failed_forward, ["original", "replacement"])
        approved = await act("approve_video", job=local_job)
        self.assertEqual(approved["export_review"], {"adopted":1, "remaining":[]})
        reassigned = await act("map_person", person="另一人", asset=asset["id"], shots=[0])
        self.assertEqual(reassigned["export_review"]["adopted"], 0)
        self.assertIn("之前的人物映射", reassigned["export_review"]["remaining"][0]["error"])
        with self.assertRaises(web.HTTPBadRequest):
            await act("export")
        expanded = await act("map_person", person="穿红衣的人", asset=asset["id"], shots=[0,1])
        self.assertEqual(expanded["export_review"]["adopted"], 1)
        self.assertEqual([item["shot"] for item in expanded["export_review"]["remaining"]], [1])
        with self.assertRaises(web.HTTPBadRequest):
            await act("export")
        await act("map_person", person="穿红衣的人", asset=asset["id"], shots=[0])
        submitted = await act("export")
        self.assertEqual([(c["ref"], c["frames"]) for c in submitted["export"]["clips"]],
                         [(video_remake.completed(submitted["shots"][0]["videos"], local_job)["ref"], 48), (source, 48)])
        self.assertEqual((submitted["export"]["w"], submitted["export"]["h"], submitted["export"]["duration"]), (64, 64, 4))
        job = submitted["export"]["job"]
        task = await self.wait_for_render(job)
        final = json.loads(task["outputs"])[0]
        path = server.tools.ref_path(server.COMFY_DIR, final)
        self.assertAlmostEqual(server.film.probe(path)[2], 4, places=2)
        evidence = smoke_video_remake.verify_export(server.tools.ref_path(server.COMFY_DIR, source), path)
        self.assertGreater(evidence["audio_correlation"], .99)
        different_sound = self.make_clip("different-audio", seconds=4, color=(180, 30, 30), frequency=880)
        with self.assertRaisesRegex(RuntimeError, "原声音轨或时间轴不匹配"):
            smoke_video_remake.verify_export(server.tools.ref_path(server.COMFY_DIR, different_sound), path)
        with av.open(str(path)) as container:
            frames = [frame.to_ndarray(format="rgb24") for frame in container.decode(video=0)]
        self.assertEqual(len(frames), 4 * server.film.FPS)
        self.assertGreater(frames[47][32,32,1], frames[47][32,32,0])
        self.assertGreater(frames[47][0,0,0], frames[47][0,0,1])
        self.assertGreater(frames[6][32,19,1], frames[6][32,19,0])
        self.assertGreater(frames[17][32,19,0], frames[17][32,19,1])
        self.assertGreater(frames[23][32,19,0], frames[23][32,19,1])
        self.assertGreater(frames[24][32,19,0], frames[24][32,19,1])
        self.assertGreater(frames[23][40,41,0], frames[23][40,41,1])
        self.assertGreater(frames[24][40,41,1], frames[24][40,41,0])
        self.assertGreater(frames[29][32,32,1], frames[29][32,32,0])
        for tick in range(30, 36):
            self.assertGreater(frames[tick][32,32,0], frames[tick][32,32,1])
        self.assertGreater(frames[36][32,32,1], frames[36][32,32,0])
        self.assertGreater(frames[48][32,32,0], frames[48][32,32,1])
        audio = server.film.read_audio(path)[0]
        self.assertLess(np.max(np.abs(audio[:int(server.film.SR * .4)])), .01)
        self.assertGreater(np.max(np.abs(audio[int(server.film.SR * .6):server.film.SR])), .1)
        for t in (1, 3):
            chunk = audio[t * server.film.SR:(t + 1) * server.film.SR]
            frequency = np.argmax(np.abs(np.fft.rfft(chunk)))
            self.assertEqual(frequency, 440)
        server.JOBS.pop(job)
        reopened = json.loads((await server.remake(Request(source, self.user))).body)
        self.assertEqual(reopened["export"]["ref"], final)
        self.assertEqual(reopened["export_review"], {"adopted":1, "remaining":[]})
        self.assertTrue((await act("keep"))["export"]["stale"])
        self.assertFalse((await act("approve_video", job=local_job))["export"]["stale"])

        with patch.object(server, "llm_call", side_effect=self.no_vision):
            split = await act("split_shot", at=1.02)
        self.assertEqual(split["selected_shot"], 1)
        self.assertEqual([(s["start"], s["end"]) for s in split["shots"]], [(0,1), (1,2), (2,4)])
        self.assertEqual(split["mapping"]["shots"], [0, 1])
        self.assertNotIn("videos", split["shots"][0])
        new_first = image_editor.load(server.COMFY_DIR, split["shots"][1]["frames"]["first"]["ref"])
        self.assertAlmostEqual(new_first.getpixel((32, 32))[0], 160, delta=5)
        self.assertTrue(split["export"]["stale"])
        self.assertNotIn("cut_archive", split)
        with self.assertRaises(web.HTTPConflict):
            await act("keep", cut_revision=0)
        restored = await act("undo_cut", shot=1)
        self.assertEqual(restored["shots"][0]["adopted_video"], local_job)
        self.assertEqual(restored["mapping"]["shots"], [0])

        await act("set_absence", frame="first", absent=True)
        with patch.object(server, "generate_request", side_effect=generate):
            entry = await act("generate_video")
        self.assertEqual(entry["shots"][0]["videos"][-1]["entry_tick"], 36)
        self.assertEqual([p["ref"] for p in requests[2]["images"]], [shot_frame["ref"], return_ref])
        self.assertEqual([p["time"] for p in requests[2]["images"]], [0, 1.5])
        with self.assertRaises(web.HTTPBadRequest) as raw:
            await act("approve_video", job="shot-gen-3")
        self.assertIn("保留开头原片", raw.exception.text)
        prefix = await act("localize", job="shot-gen-3")
        prefix_version = prefix["shots"][0]["videos"][-1]
        self.assertIsNone(prefix_version["corrections"]["0"])
        self.assertEqual(prefix_version["entry_tick"], 36)
        prefix_task = await self.wait_for_render(prefix_version["job"])
        prefix_path = server.tools.ref_path(server.COMFY_DIR, json.loads(prefix_task["outputs"])[0])
        with av.open(str(prefix_path)) as container:
            composed = [f.to_ndarray(format="rgb24")[32,32] for f in container.decode(video=0)]
        self.assertTrue(all(pixel[0] > pixel[1] for pixel in composed[:36]))
        self.assertGreater(composed[36][1], composed[36][0])
        await act("approve_video", job=prefix_version["job"])
        await act("set_absence", frame="first", absent=False)

        with patch.object(server, "llm_call", side_effect=self.no_vision):
            moved = await act("move_cut", shot=1, at=2.5)
            self.assertEqual(moved["shots"][0]["end"], 2.5)
            self.assertEqual(moved["mapping"]["shots"], [])
            merged = await act("merge_shots", shot=1)
        self.assertEqual(len(merged["shots"]), 1)
        self.assertEqual((merged["shots"][0]["start"], merged["shots"][0]["end"]), (0,4))

    async def wait_for_render(self, job):
        for _ in range(150):
            task = db.one("SELECT state,outputs,error FROM tasks WHERE id=?", job)
            if task["state"] in ("done","error"):
                break
            await asyncio.sleep(.02)
        self.assertEqual(task["state"], "done", task["error"])
        return task

    def test_matte_tracks_motion_and_preserves_background_outside_the_mask(self):
        import cv2
        toy = np.random.default_rng(42).integers(40, 240, (24, 24), dtype=np.uint8)

        def frame(x, replacement=False):
            image = np.full((64, 96, 3), 18 if replacement else 12, dtype=np.uint8)
            sprite = np.stack([toy, toy, toy], axis=-1)
            if replacement:
                sprite[..., 1] = 240
            image[20:44, x:x+24] = sprite
            return image

        mask = np.zeros((64, 96), dtype=np.uint8)
        mask[20:44, 10:34] = 255
        source_track = video_matte.MaskTrack(frame(10), mask, cv2)
        generated_track = video_matte.MaskTrack(frame(10, True), mask, cv2)
        for k in range(1, 19):
            original = frame(10+k)
            generated = frame(10+k//2, True)
            source_track.advance(original, k)
            generated_track.advance(generated, k)
        observed = source_track.at_size(96, 64)
        generated_mask = generated_track.at_size(96, 64)
        self.assertAlmostEqual(video_matte.mask_center(observed)[0], 39.5, delta=4)
        result = video_matte.composite_frame(original, generated, observed, generated_mask, cv2)
        self.assertTrue(np.array_equal(result[observed==0], original[observed==0]))
        self.assertGreater(result[32,39,1], 170)

    @staticmethod
    def make_clip(name, seconds, color, frequency, audio_delay=0):
        path, ref = server.tools._new(server.COMFY_DIR, "input", name, ".mp4")
        rate = server.film.SR
        with av.open(str(path), "w") as clip:
            video = clip.add_stream("libx264", rate=24)
            video.width = video.height = 64
            video.pix_fmt = "yuv420p"
            audio = clip.add_stream("aac", rate=rate)
            audio.layout = "stereo"
            for tick in range(24 * seconds):
                image = av.VideoFrame.from_image(Image.new("RGB", (64,64), color(tick) if callable(color) else color))
                for packet in video.encode(image):
                    clip.mux(packet)
            for packet in video.encode():
                clip.mux(packet)
            for i in range(0, rate * seconds, 1024):
                times = np.arange(i, min(i + 1024, rate * seconds)) / rate
                samples = (np.sin(2 * np.pi * frequency * times) * .25).astype(np.float32)
                frame = av.AudioFrame.from_ndarray(np.stack([samples, samples]), format="fltp", layout="stereo")
                frame.sample_rate = rate
                frame.time_base = Fraction(1, rate)
                frame.pts = i + round(audio_delay * rate)
                for packet in audio.encode(frame):
                    clip.mux(packet)
            for packet in audio.encode():
                clip.mux(packet)
        return ref

    @staticmethod
    async def no_vision(req, coroutine):
        coroutine.close()
        raise web.HTTPServiceUnavailable()
