import asyncio
import json
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, skipUnless
from unittest.mock import patch

import av
import numpy as np
from aiohttp import web
from PIL import Image, ImageDraw

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
        self.enterContext(patch.object(server, "PREP_TAIL", [None]))
        self.enterContext(patch.object(server, "STATS", {}))
        self.enterContext(patch.object(server, "STATS_FILE", root / "stats.json"))
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

    async def test_long_shot_splits_into_balanced_segments_and_can_be_undone(self):
        source = self.make_clip("long-shot", seconds=30, color=lambda tick: (20 + (tick // 232) * 50, 20, 20), frequency=440)
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        key = (7, "test", "n3", source)
        first, tail = (video_remake.frame_record(self.source["ref"], (64,64)) for _ in range(2))
        first["previews"] = [{"job":"long-preview", "state":"queued"}]
        original = {"shots":[
            {"start":0, "end":29, "summary":{}, "frames":{"first":first}},
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
        for index in range(3):
            image = image_editor.load(server.COMFY_DIR, split["shots"][index]["frames"]["first"]["ref"])
            self.assertAlmostEqual(image.getpixel((32,32))[0], 20 + index * 50, delta=5)
        with self.assertRaises(web.HTTPBadRequest):
            await act("split_long_shot", revision=1)
        undone = await act("undo_cut", revision=1)
        self.assertEqual([(shot["start"], shot["end"]) for shot in undone["shots"]], [(0,29), (29,30)])
        self.assertEqual(undone["mapping"]["shots"], [0])
        self.assertEqual(undone["shots"][0]["frames"]["first"]["previews"][0]["ref"], self.source["ref"])

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
        await act("approve_video", job=local_job)
        export = await act("export")
        export_job = export["export"]["job"]
        await self.wait_for_render(export_job)
        server.JOBS.pop(export_job)
        final = (await act())["export"]
        self.assertEqual(final["state"], "done")
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, final["ref"]))) as movie:
            first = next(movie.decode(video=0)).to_ndarray(format="rgb24")
        self.assertTrue(np.allclose(first[0,0], original.getpixel((0, 0))[:3], atol=8))
        self.assertTrue(np.allclose(first[36,36], original.getpixel((36, 36))[:3], atol=8))
        self.assertGreater(first[25,25,0], 170)
        self.assertGreater(first[25,14,0], 140)

        await act("select", rect=[.3,.3,.7,.7])
        with self.assertRaises(web.HTTPConflict) as changed:
            await act("generate_video")
        self.assertIn("首帧选区已更新", changed.exception.text)
        with self.assertRaises(web.HTTPConflict):
            await act("approve", job=job)
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
