import asyncio
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import web
from PIL import Image, ImageDraw

import server
from chat_fixture import ChatFixture
from oneshot.generation import video_quality as quality
from oneshot.generation import video_quality_judge as judge
from oneshot.generation import video_quality_motion as motion
from oneshot.storage import db


def assessment(failures=()):
    return judge.assess_response(json.dumps({
        "checks": {key: {"status":"fail" if key in failures else "pass", "observation":"Visible result"}
                   for key in judge.CRITERIA},
    }))


class QualityJudge(unittest.IsolatedAsyncioTestCase):
    def test_motion_region_requires_a_local_change_between_matching_endpoints(self):
        beginning = Image.new("RGB",(160,90),"black")
        middle = beginning.copy()
        ImageDraw.Draw(middle).rectangle((74,15,96,29),fill="white")
        (left, top, right, bottom), poses, mask = motion.motion_region([beginning,middle,beginning])
        self.assertLess(left,.46)
        self.assertGreater(right,.6)
        self.assertLess(top,.16)
        self.assertGreater(bottom,.33)
        samples = [(beginning,0),(middle,2.5),(beginning,4.95)]
        self.assertTrue(motion.matches_anchor_poses(samples,poses,mask))
        samples[1] = (beginning,2.5)
        self.assertFalse(motion.matches_anchor_poses(samples,poses,mask))
        self.assertIsNone(motion.motion_region([beginning,middle,middle]))
        self.assertIsNone(motion.motion_region([beginning,Image.new("RGB",(160,90),"white"),beginning]))

    async def test_local_motion_can_clear_only_the_unmet_action(self):
        packet = [{"type":"text","text":"Cropped timing evidence"}]
        images = [{"role":"frame","time":seconds} for seconds in (0,2.5,4.95)]
        model = SimpleNamespace(local_vision=AsyncMock(side_effect=[
            '{"status":"fail","observation":"Paw stays down"}',
            '{"status":"pass","observation":"One paw raises then returns"}',
        ]))
        report = {**assessment(("action",)), "requirements":{"action":"raises one paw"}}
        with patch.object(motion,"review_content",return_value=packet) as crop:
            self.assertEqual((await motion.verify(model,report,images,"clip.mp4"))["score"],8)
            result = await motion.verify(model,report,images,"clip.mp4")
            self.assertEqual(result["score"],10)
            self.assertTrue(result["passed"])
            self.assertIn("One paw raises",result["evidence"])
            failed_visual = {**assessment(("action","visual")), "requirements":{"action":"raises one paw"}}
            self.assertFalse((await motion.verify(model,failed_visual,images,"clip.mp4"))["passed"])
        self.assertEqual(crop.call_count,2)
        self.assertEqual(model.local_vision.await_count,2)

    async def test_smooth_progression_passes_continuity_only_if_no_hard_cut(self):
        brief = "One continuous sunset shot. No abrupt cuts."
        initial = {**assessment(("camera",)), "requirements":{"camera":"One continuous sunset shot"},
                   "camera_observation":"Camera zooms in progressively from wide to close-up."}
        with patch.object(judge,"hard_cut_points",return_value=[51]):
            result = await judge.verify_camera_continuity(initial,brief,"clip.mp4")
        self.assertEqual(result["checks"]["camera"],"fail")
        with patch.object(judge,"hard_cut_points",return_value=[]) as detect:
            result = await judge.verify_camera_continuity(initial,brief+" Fixed camera.","clip.mp4")
            self.assertEqual(result["checks"]["camera"],"fail")
            detect.assert_not_called()
            result = await judge.verify_camera_continuity(initial,brief,"clip.mp4")
            self.assertEqual(result["score"],10)
            self.assertTrue(result["passed"])
            detect.assert_called_once_with("clip.mp4")

    def test_assessment_repair_uses_only_literal_requirements_for_failed_checks(self):
        brief = "The dog raises one paw. The camera slowly pushes in."
        checks = {key:{"status":"pass","observation":"Consistent","requirement":""} for key in judge.CRITERIA}
        checks["action"] = {"status":"fail","observation":"Dog stays still","requirement":"raises one paw"}
        checks["camera"] = {"status":"unclear","observation":"Movement not established","requirement":"adds a bright light"}
        report = judge.assess_response(json.dumps({"checks":checks}),brief)
        self.assertEqual(report["requirements"],{"action":"raises one paw"})
        retry = judge.correction(report,0,only_failures=True)
        self.assertIn("raises one paw",retry)
        self.assertNotIn("camera",retry)
        self.assertNotIn("bright light",retry)

    def test_extra_characters_trigger_subject_failure_when_cast_limit_is_explicit(self):
        brief = "The same single blue droplet glides through clouds."
        checks = {key:{"status":"pass","observation":"Consistent","requirement":""} for key in judge.CRITERIA}
        checks["visual"] = {"status":"fail","observation":"Unwanted secondary characters appear in the scene.",
                            "requirement":brief.rstrip(".")}
        report = judge.assess_response(json.dumps({"checks":checks}),brief)
        self.assertEqual(report["checks"]["subjects"],"fail")
        checks["visual"]["observation"] = "Some foreground trees enter the scene."
        report = judge.assess_response(json.dumps({"checks":checks}),brief)
        self.assertEqual(report["checks"]["subjects"],"pass")

    def test_timed_reference_labels_and_generated_frames_use_anchor_times(self):
        images=[{"ref":"test-a","role":"subject","index":1,"caption":"the woman"},
                {"ref":"test-b","role":"frame","index":2,"time":2.5,"caption":"at the doorway"}]
        with patch.object(judge.tools,"ref_path",return_value="image"), patch.object(
            judge.rewriter,"image_part",return_value={"type":"image_url"}
        ), patch.object(judge,"comparison_frames",return_value=[(2.5,{"type":"image_url"})]) as frames:
            content = judge.assessment_content("The woman moves quietly.",images,"clip.mp4")
        frames.assert_called_once_with("clip.mp4",[2.5])
        self.assertIn("subject identity reference",content[1]["text"])
        self.assertIn("required keyframe at 2.50 seconds",content[3]["text"])
        self.assertIn("2.50 seconds",content[5]["text"])

    async def test_retries_invalid_assessment_without_rendering_another_draft(self):
        verdict = json.dumps({"checks":{
            key: {"status":"fail" if key == "visual" else "pass",
                  "observation":"The surface is beige." if key == "visual" else "The ball remains stationary."}
            for key in judge.CRITERIA
        }})
        model = SimpleNamespace(local_vision=AsyncMock(side_effect=[
            '{"checks":{"action":"fail"},"evidence":"The ball remains still (action pass)."}',
            verdict,
        ]))
        frames = [{"type":"text","text":"Timestamped frames"}]
        with patch.object(judge,"assessment_content",return_value=frames):
            report = await judge.evaluate(model,"A single red ball remains still on a gray table.",[],"draft.mp4")
        self.assertEqual(report["score"],8)
        self.assertEqual(report["checks"]["action"],"pass")
        self.assertEqual(report["checks"]["visual"],"fail")
        self.assertIn("The surface is beige.",report["evidence"])
        self.assertNotIn("end state",judge.correction(report,0))
        self.assertEqual(model.local_vision.await_count,2)
        for call in model.local_vision.await_args_list:
            self.assertEqual(call.args[1],frames)
            schema = call.kwargs["response_schema"]["properties"]["checks"]
            self.assertEqual(set(schema["required"]),set(judge.CRITERIA))


class VideoQuality(ChatFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        server.providers.seed()
        self.app["remote_tasks"] = set()
        self.app["llm"] = SimpleNamespace(local_vision_available=lambda: True, release_gpu=AsyncMock())
        self.request_data = {
            "kind":"video", "board":"test", "provider":"local_h3", "selected_model":"h3-video",
            "quality_precheck":True, "quality":"hd", "duration":5, "seed":321, "turbo":True,
            "planned":True, "images":[{**self.source, "role":"frame", "index":1, "time":0}],
            "prompt":"A continuous still shot. Then the actor says <d>[English] Hello.</d>",
        }

    async def generate(self):
        response = await self.client.post("/api/generate", json=self.request_data)
        self.assertEqual(response.status, 200, await response.text())
        jid, = (await response.json())["ids"]
        return jid

    async def test_transient_engine_status_retries_before_creating_one_job(self):
        readiness = AsyncMock(side_effect=[False,False,True])
        run = AsyncMock()
        with patch.object(quality.local,"engine_up",new=readiness), patch.object(quality,"run",new=run):
            jid = await self.generate()
            await asyncio.gather(*self.app["remote_tasks"])
        self.assertEqual(readiness.await_count,3)
        run.assert_awaited_once()
        self.assertEqual(run.await_args.args[1]["id"],jid)

    async def test_job_poll_distinguishes_draft_queue_and_sampling(self):
        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"run",new=AsyncMock()
        ):
            jid = await self.generate()
        job = quality.jobs.JOBS[jid]
        self.assertEqual(job["phase"],"quality_prepare")
        job.update(state="running",phase="quality_draft")
        for engine_status, expected in (
            ({"state":"queued","ahead":3},(3,None,None)),
            ({"state":"running","phase":"sampling","value":2,"max":4},(None,2,4)),
            ({"state":"running","phase":"decoding","value":4,"max":4},(None,None,None)),
        ):
            quality.track_render_progress(job,engine_status)
            response = await self.client.get("/api/jobs",params={"ids":jid})
            status = (await response.json())[jid]
            self.assertEqual(tuple(status[key] for key in ("engine_queue","value","max")),expected)

    def test_keyframe_collision_detected_after_conversion_to_h3_frames(self):
        first = {"role":"frame","time":0,"ref":"input:h3studio/first.png"}
        last = {"role":"frame","time":5,"ref":"input:h3studio/last.png"}
        middle = {"role":"frame","time":6,"ref":"input:h3studio/middle.png"}
        with self.assertRaisesRegex(web.HTTPBadRequest,"Bad Request"):
            quality.validate_keyframe_times([first,middle,last],5)
        quality.validate_keyframe_times([first,{**middle,"time":2.5},last],5)
        quality.validate_keyframe_times([first,{**middle,"role":"subject"},last],5)

    async def test_render_timeout_starts_at_gpu_execution(self):
        phases = [{"state":"queued","ahead":3},{"state":"running"},{"state":"running"},{"state":"done"}]
        clock = iter((0,1900,2000,3700))
        with patch.object(quality,"time",SimpleNamespace(monotonic=lambda: next(clock))), patch.object(
            quality,"asyncio",SimpleNamespace(sleep=AsyncMock())
        ), patch.object(quality,"engine_request",new=AsyncMock(side_effect=[{"engine":phase} for phase in phases])):
            await quality.wait_draft({},{},"engine")

        for phase, times, message in (
            ("queued",(0,7200),"排队超时"),
            ("running",(0,0,1800),"定稿超时"),
        ):
            clock = iter(times)
            with patch.object(quality,"time",SimpleNamespace(monotonic=lambda: next(clock))), patch.object(
                quality,"asyncio",SimpleNamespace(sleep=AsyncMock())
            ), patch.object(quality,"engine_request",new=AsyncMock(return_value={"engine":{"state":phase}})):
                with self.assertRaisesRegex(TimeoutError,message):
                    await quality.wait_final({},{},"engine")

    async def test_transient_status_timeout_keeps_the_same_engine_job(self):
        poll = AsyncMock(side_effect=[TimeoutError(),{"engine":{"state":"running"}},
                                      TimeoutError(),{"engine":{"state":"done"}}])
        with patch.object(quality,"asyncio",SimpleNamespace(sleep=AsyncMock())), patch.object(
            quality,"engine_request",new=poll
        ):
            await quality.wait_draft({},{},"engine")
        self.assertEqual(poll.await_count,4)
        self.assertTrue(all(call.args[1]=="/jobs" and call.kwargs=={"params":{"ids":"engine"}}
                            for call in poll.await_args_list))

    async def test_five_attempts_then_pick_best_and_submit_original_settings(self):
        render = AsyncMock(side_effect=[f"engine-{i}" for i in range(6)])
        scores = [assessment(("action", "order")), assessment(("action",)), assessment(("camera",)),
                  assessment(("action", "camera")), assessment(("subjects", "action")), assessment()]
        evaluate = AsyncMock(side_effect=scores)
        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"submit",render
        ), patch.object(quality,"wait_draft",new=AsyncMock()), patch.object(
            quality.judge,"evaluate",evaluate
        ), patch.object(quality,"wait_final",new=AsyncMock()), patch.object(quality.media,"media_info",return_value={}):
            jid = await self.generate()
            await asyncio.gather(*self.app["remote_tasks"])
        bodies = [call.args[1] for call in render.await_args_list]
        self.assertEqual([body["kind"] for body in bodies], ["video_int8"] * 5 + ["video"])
        self.assertEqual({body["seed"] for body in bodies}, {321})
        self.assertEqual(len({body["prompt"] for body in bodies[:5]}), 5)
        self.assertEqual(bodies[-1]["prompt"], bodies[1]["prompt"])
        self.assertEqual(bodies[-1]["height"], 768)
        self.assertTrue(all(body["graph"]["5"]["inputs"]["height"] == 480 for body in bodies[:5]))
        self.assertEqual([body["graph"]["guide0"]["inputs"]["frame_idx"] for body in bodies[:5]], [0] * 5)
        self.assertEqual(bodies[-1]["keyframes"][0]["frame"], 0)
        self.assertTrue(all("<d>[English] Hello.</d>" in body["prompt"] for body in bodies))
        self.assertEqual({call.args[1] for call in evaluate.await_args_list}, {self.request_data["prompt"]})
        receipt = json.loads(db.one("SELECT request FROM tasks WHERE id=?",jid)["request"])
        self.assertEqual(receipt["engine"]["id"], "engine-5")
        review = receipt["history"]["quality_review"]
        self.assertEqual(review["selected"], 2)
        self.assertTrue(review["fallback"])
        self.assertEqual(len(review["attempts"]), 5)

    async def test_first_pass_stops_screening(self):
        render = AsyncMock(side_effect=["draft","final"])
        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"submit",render
        ), patch.object(quality,"wait_draft",new=AsyncMock()), patch.object(
            quality.judge,"evaluate",new=AsyncMock(return_value=assessment())
        ), patch.object(quality,"wait_final",new=AsyncMock()), patch.object(quality.media,"media_info",return_value={}):
            jid = await self.generate()
            await asyncio.gather(*self.app["remote_tasks"])
        self.assertEqual(render.await_count, 2)
        self.assertTrue(quality.jobs.JOBS[jid]["meta"]["quality_review"]["passed"])

    async def test_visual_only_final_failure_is_reported_without_another_render(self):
        render = AsyncMock(side_effect=["draft","final"])
        evaluate = AsyncMock(side_effect=[assessment(),assessment(("visual",))])
        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"submit",render
        ), patch.object(quality,"wait_draft",new=AsyncMock()), patch.object(quality,"wait_final",new=AsyncMock()), patch.object(
            quality.judge,"evaluate",evaluate
        ), patch.object(quality.media,"media_info",return_value={}):
            jid = await self.generate()
            await asyncio.gather(*self.app["remote_tasks"])
        self.assertEqual(render.await_count,2)
        review = quality.jobs.JOBS[jid]["meta"]["quality_review"]
        self.assertEqual(review["final_assessment"]["checks"]["visual"],"fail")
        self.assertEqual(review["final_selected"],1)

    async def test_image_conditioned_final_repairs_and_keeps_only_the_better_result(self):
        submissions = []
        async def render(app, body):
            submissions.append(body)
            if body["kind"] == "video":
                Path(body["out"]).write_bytes(b"final")
            return f"engine-{len(submissions)}"

        initial = assessment(("subjects",))
        initial["requirements"] = {"subjects":"A continuous still shot"}
        verdicts = [assessment(),initial,assessment()]
        async def complete(job, outputs):
            job.update(state="done",outputs=outputs)

        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"submit",side_effect=render
        ), patch.object(quality,"wait_draft",new=AsyncMock()), patch.object(quality,"wait_final",new=AsyncMock()), patch.object(
            quality.judge,"evaluate",new=AsyncMock(side_effect=verdicts)
        ), patch.object(quality.media,"media_info",return_value={}), patch.object(
            quality.jobs,"complete_outputs",side_effect=complete
        ):
            jid = await self.generate()
            await asyncio.gather(*self.app["remote_tasks"])
        self.assertEqual([body["kind"] for body in submissions],["video_int8","video","video"])
        first, second = submissions[1:]
        self.assertEqual(first["keyframes"],second["keyframes"])
        self.assertEqual(first["seed"],second["seed"])
        self.assertIn("Make this requirement explicit",second["prompt"])
        self.assertIn("<d>[English] Hello.</d>",second["prompt"])
        self.assertFalse(Path(first["out"]).exists())
        self.assertTrue(Path(second["out"]).exists())
        job = quality.jobs.JOBS[jid]
        review = job["meta"]["quality_review"]
        self.assertEqual(review["final_selected"],2)
        self.assertEqual([result["score"] for result in review["final_attempts"]],[8,10])
        self.assertEqual(review["final_assessment"]["score"],10)
        self.assertEqual(job["outputs"][0]["ref"].split("/")[-1],Path(second["out"]).name)

    async def test_cancel_aborts_draft_and_skips_final(self):
        active = asyncio.Event()

        async def wait(app, job, eid):
            active.set()
            while not job.get("cancel"):
                await asyncio.sleep(0.01)
            quality.check_cancelled(job)

        render = AsyncMock(return_value="draft")
        cancel = AsyncMock()
        with patch.object(quality.local,"engine_up",new=AsyncMock(return_value=True)), patch.object(
            quality,"submit",render
        ), patch.object(quality,"wait_draft",wait), patch.object(quality.jobs,"cancel_engine_jobs",cancel):
            jid = await self.generate()
            await asyncio.wait_for(active.wait(), timeout=2)
            response = await self.client.post("/api/cancel", json={"ids":[jid]})
            self.assertEqual(response.status, 200)
            await asyncio.gather(*self.app["remote_tasks"],return_exceptions=True)
        render.assert_awaited_once()
        self.assertIn(["draft"], [call.args[1] for call in cancel.await_args_list])
        self.assertEqual(quality.jobs.JOBS[jid]["state"], "error")

    async def test_rejects_more_than_one_final(self):
        response = await self.client.post("/api/generate", json={**self.request_data, "count":2})
        self.assertEqual(response.status, 400)

    async def test_preview_includes_the_screening_route(self):
        response = await self.client.post("/api/preview", json=self.request_data)
        self.assertEqual(response.status, 200, await response.text())
        preview = await response.json()
        self.assertIn("最多 5 次", preview["mode"])
        self.assertEqual(preview["inputs"][0]["ref"], self.source["ref"])
        self.assertIn("<d>[English] Hello.</d>", preview["prompt"])
