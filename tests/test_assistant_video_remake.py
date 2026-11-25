"""Assistant access to pinned video remake sessions and analysis."""

from unittest.mock import patch
import json
import time

from aiohttp import web

from oneshot.editing import video_remake
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from remake_fixture import RemakeFixture, Request


class AssistantRemake(RemakeFixture):
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

        with patch.object(generation_requests, "_generate_request", side_effect=generate) as submit:
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

        with patch.object(generation_requests, "_generate_request", side_effect=generate_video) as submit_video:
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
