import asyncio
import json
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import av
import numpy as np
from aiohttp import web
from PIL import Image

import db
import image_editor
import server
import video_remake
import video_matte


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
        self.enterContext(patch.object(server, "RENDER_LOCK", asyncio.Lock()))
        self.addCleanup(db.conn().close)
        server.BOARDS.mkdir()
        self.user = {"id": 7, "role": "member"}
        self.source = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "red"), "asset", "input")

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

    async def test_shot_preview_uses_asset_reference_and_preserves_unselected_pixels(self):
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

            async def chat(self, system, content, **kwargs):
                if "这一帧" in system:
                    assert json.loads(content[0]["text"]) == {"name":"人物1", "appearance":"红衣、短发"}
                    assert content[1]["type"] == "image_url"
                    return json.dumps({"point":self.point})
                return json.dumps({"characters":[{"name":"人物1", "look":"红衣、短发"}],
                                   "shots":[{"characters":["人物1"]}]})

        vision = Vision()

        async def act(action=None, **kwargs):
            payload = {"action": action, "shot": 0, **kwargs} if action else None
            req = Request(source, self.user, payload)
            req.app["llm"] = vision
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
        job = "remake-test-job"

        async def submit(req, payload):
            self.assertEqual(payload["images"][2]["ref"], self.source["ref"])
            self.assertIn("@图3", payload["prompt"])
            synthetic = image_editor.save(server.COMFY_DIR, Image.new("RGB",(64,64),"white"))
            output = image_editor.composite(server.COMFY_DIR, payload["_image_edit"], [synthetic])[0]
            db.task_start(id=job, user_id=7, board_id="test", state="done", outputs=[output["ref"]])
            return web.json_response({"ids":[job]})

        with patch.object(server, "_generate_request", side_effect=submit):
            started = await act("preview", asset=asset["id"], view="main")
        result = started["shots"][0]["frames"]["first"]["previews"][0]
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
        kept = await act("keep")
        self.assertTrue(kept["shots"][0]["keep_original"])

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
        for index in range(3):
            await act("select", shot=index, rect=[.25,.25,.75,.75])
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
                {"shot":index, "view":view} for index, view in shots
            ]))["batch_previews"]

        with patch.object(server, "_generate_request", side_effect=submit):
            with self.assertRaises(web.HTTPBadRequest):
                await batch((0, "main"), (2, "main"))
            self.assertEqual(len(requests), 0)
            partial = await batch((0, "main"), (1, "main"))
            self.assertEqual(partial["submitted"], [0])
            self.assertEqual(partial["failed"], [{"shot":1, "error":"任务暂时无法提交"}])
            self.assertEqual((await act())["shots"][0]["frames"]["first"]["previews"][0]["job"], "batch-1")
            self.assertEqual(await batch((0, "main"), (1, "main")),
                             {"submitted":[1], "skipped":[0], "failed":[]})
            self.assertEqual(await batch((0, "main"), (1, "main")),
                             {"submitted":[], "skipped":[0,1], "failed":[]})
        self.assertEqual(len(requests), 3)
        await act("approve", shot=0, job="batch-1")
        db.task_start(id="batch-3", user_id=7, state="done", outputs=[self.source["ref"]])
        await act("approve", shot=1, job="batch-3")
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

        protected = await act("select", layer="protection", rect=[.58,.55,.72,.72])
        protection_mask = protected["shots"][0]["frames"]["first"]["protection"]["mask"]
        await act("clear_protection", frame=correction)
        advance = video_matte.MaskTrack.advance
        failed_forward = []

        def lose_forward_track(track, image, index):
            if index == 18 and image.ndim == 3 and image[0, 0, 0] > image[0, 0, 1] and track.initial_area >= 512:
                failed_forward.append(index)
                raise ValueError("forward tracking lost the subject")
            advance(track, image, index)

        with patch.object(video_matte.MaskTrack, "advance", lose_forward_track):
            local = await act("localize", job="shot-gen-2")
            localized = local["shots"][0]["videos"][-1]
            self.assertEqual(localized["corrections"], {"24":corrected_mask, "30":None, "36":return_mask})
            self.assertEqual(localized["protections"], {"0":protection_mask, "24":None})
            local_job = localized["job"]
            await act("remove_correction", frame=correction)
            await self.wait_for_render(local_job)
        self.assertEqual(failed_forward, [18])
        await act("approve_video", job=local_job)
        await act("map_person", person="另一人", asset=asset["id"], shots=[0])
        with self.assertRaises(web.HTTPBadRequest):
            await act("export")
        await act("map_person", person="穿红衣的人", asset=asset["id"], shots=[0,1])
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
