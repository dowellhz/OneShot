"""Character replacement mapping, preview and production generation."""

from contextlib import asynccontextmanager, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import asyncio
import io
import json
import time

from PIL import Image
from aiohttp import StreamReader, web
from aiohttp.base_protocol import BaseProtocol
from aiohttp.test_utils import make_mocked_request
from yarl import URL
import av
import numpy as np

from oneshot.editing import image_editor
from oneshot.editing import image_routes
from oneshot.editing import timeline_routes
from oneshot.editing import video_remake
from oneshot.generation import prompts
from oneshot.storage import db
from oneshot.web import http as http_errors
from scripts import smoke_video_remake
import server

from remake_fixture import RemakeFixture, Request


class RemakeGeneration(RemakeFixture):
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

        with patch.object(image_routes, "run_image_tool", side_effect=segment):
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

        def submit(url, json, *, timeout=None):
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

        with patch.object(prompts, "to_english", translated):
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
        with patch.object(timeline_routes, "enqueue_film", wraps=server.enqueue_film) as enqueue, \
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
        with patch.object(prompts, "to_english", translated), redirect_stdout(io.StringIO()):
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
            with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
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
