"""Video remake cancellation and job recovery after restart."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import asyncio
import json

from oneshot.generation import jobs as generation_jobs
from oneshot.generation import local as local_generation
from oneshot.generation import prompts
from oneshot.storage import db
import server

from remake_fixture import RemakeFixture, Request


class RemakeRecovery(RemakeFixture):
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
        with patch.object(local_generation, "engine_body", return_value=({}, {})), patch.object(prompts, "to_english", translate):
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
        with patch.object(local_generation, "engine_body", return_value=({}, {})), patch.object(prompts, "to_english", translate), \
                patch.object(generation_jobs, "follow_engine", skip_initial_poll):
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

        with patch.object(generation_jobs, "cancel_engine_jobs", cancel_engine):
            await server.cancel(Request("", {"id":8, "role":"member"}, {"ids":[pending_id]}))
            self.assertEqual(cancelled, [])
            self.assertNotIn(pending_id, server.JOBS)
            await server.cancel(Request("", self.user, {"ids":[pending_id]}))
        self.assertEqual(cancelled, [engine_id])
        task = db.one("SELECT state,error FROM tasks WHERE id=?", pending_id)
        self.assertEqual(task, {"state":"error", "error":"已取消"})
