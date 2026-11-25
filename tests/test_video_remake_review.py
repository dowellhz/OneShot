"""Review decisions, batch previews, and export with original audio."""

from unittest.mock import patch
import json

from PIL import Image
from aiohttp import web
import av
import numpy as np

from oneshot.editing import image_editor
from oneshot.editing import video_matte
from oneshot.editing import video_remake
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
from oneshot.web import http as http_errors
from scripts import smoke_video_remake
import server

from remake_fixture import RemakeFixture, Request


class RemakeReview(RemakeFixture):
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

        with patch.object(generation_requests, "_generate_request", side_effect=submit):
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
        with patch.object(generation_requests, "_generate_request", side_effect=submit_video):
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
        with patch.object(generation_requests, "_generate_request", side_effect=submit):
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

        with patch.object(generation_requests, "generate_request", side_effect=generate):
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

        with patch.object(generation_requests, "_generate_request", side_effect=render_guide):
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
        with patch.object(generation_requests, "_generate_request", side_effect=render_guide):
            await act("preview", frame=return_frame, asset=asset["id"])
        await act("approve", frame=return_frame, job="return-guide")
        with self.assertRaises(web.HTTPBadRequest):
            await act("generate_video")
        server.providers.seed()
        with patch.object(generation_requests, "generate_request", side_effect=generate):
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

        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
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
        with patch.object(generation_requests, "generate_request", side_effect=generate):
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

        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
            moved = await act("move_cut", shot=1, at=2.5)
            self.assertEqual(moved["shots"][0]["end"], 2.5)
            self.assertEqual(moved["mapping"]["shots"], [])
            merged = await act("merge_shots", shot=1)
        self.assertEqual(len(merged["shots"]), 1)
        self.assertEqual((merged["shots"][0]["start"], merged["shots"][0]["end"]), (0,4))
