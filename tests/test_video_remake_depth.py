"""Depth guide production, authorized reference delivery, and lease cleanup."""

from unittest.mock import patch
import io
import json
import sys
import time

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL
import av
import numpy as np

from oneshot.editing import video_depth
from oneshot.editing import video_remake
from oneshot.generation import motion_reference
from oneshot.storage import db
import server

from remake_fixture import RemakeFixture, Request


class RemakeDepth(RemakeFixture):
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
