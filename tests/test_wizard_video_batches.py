"""The server can advance a saved shot batch without a browser polling it."""

import asyncio
from unittest.mock import patch

from aiohttp import web
import numpy as np

from chat_fixture import ChatFixture
from remake_fixture import RemakeFixture
from oneshot import config
from oneshot.generation import wizard_batches
from oneshot.generation.tools import ref_path
from oneshot.editing.render_media import probe
from oneshot.editing import render
from oneshot.storage import db
from oneshot.web.media import grant_media


class WizardVideoBatches(ChatFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.board["nodes"] += [
            {"id": "script", "type": "script", "data": {"made": [{"vid": "v1"}, {"vid": "v2"}]}},
            {"id": "v1", "type": "video", "data": {}, "versions": []},
            {"id": "v2", "type": "video", "data": {}, "versions": []},
        ]
        wizard_batches.canvas_routes.write_board(wizard_batches.canvas_routes.board_path("test"), self.board)
        self.batch_id = "test-shot-batch-12345"
        self.path = "/api/wizard/video-batches"
        self.body = {"board": "test", "id": self.batch_id, "script": "script", "entries": [
            {"node": node, "key": "test-shot-request-12345-" + node,
             "payload": {"board": "test", "kind": "video", "prompt": node,
                         "images": [{"ref": self.source["ref"]}]}}
            for node in ("v1", "v2")
        ]}

    async def asyncTearDown(self):
        await wizard_batches.stop(self.app)
        await super().asyncTearDown()

    async def wait_state(self, state):
        for _ in range(250):
            row = db.one("SELECT state FROM wizard_video_batches WHERE id=?", self.batch_id)
            if row and row["state"] == state:
                return
            await asyncio.sleep(.02)
        self.fail(f"Batch did not reach {state}")

    async def test_offline_batch_and_server_restart_do_not_resubmit_the_first_shot(self):
        submitted = []
        first_polled = asyncio.Event()
        completed = False

        async def generate(request):
            payload = await request.json()
            submitted.append(payload["prompt"])
            return web.json_response({"ids": [payload["prompt"] + "-job"]})

        async def poll(request):
            job = request.query["ids"]
            first_polled.set()
            if not completed:
                return web.json_response({job: {"state": "running"}})
            return web.json_response({job: {"state": "done", "outputs": [{"ref": "output:h3studio/" + job + ".mp4"}]}})

        with (
            patch.object(wizard_batches.requests, "generate_canvas_request", side_effect=generate),
            patch.object(wizard_batches.jobs, "jobs", side_effect=poll),
        ):
            response = await self.client.post(self.path, json=self.body)
            self.assertEqual(response.status, 200, await response.text())
            await asyncio.wait_for(first_polled.wait(), timeout=2)
            self.assertEqual(submitted, ["v1"])
            await wizard_batches.stop(self.app)
            self.assertEqual(wizard_batches.entries(self.batch_id)[0]["state"], "running")
            completed = True
            wizard_batches.recover(self.app)
            await self.wait_state("done")
            result = await self.client.get(self.path + "/" + self.batch_id, params={"board": "test"})
            self.assertEqual([step["state"] for step in (await result.json())["entries"]], ["done", "done"])
            repeated = await self.client.post(self.path, json=self.body)
            self.assertEqual(repeated.status, 200)
            self.assertEqual(submitted, ["v1", "v2"])
            denied = await self.client.get(self.path + "/" + self.batch_id, params={"board": "test"},
                                           headers={"X-Uid": "8"})
            self.assertEqual(denied.status, 403)

    async def test_pause_keeps_later_shots_waiting_until_resume(self):
        submitted = []
        first_polled = asyncio.Event()
        complete_first = asyncio.Event()

        async def generate(request):
            payload = await request.json()
            submitted.append(payload["prompt"])
            return web.json_response({"ids": [payload["prompt"] + "-job"]})

        async def poll(request):
            job = request.query["ids"]
            if job == "v1-job":
                first_polled.set()
                await complete_first.wait()
            return web.json_response({job: {"state": "done", "outputs": [{"ref": "output:h3studio/res.mp4"}]}})

        with (
            patch.object(wizard_batches.requests, "generate_canvas_request", side_effect=generate),
            patch.object(wizard_batches.jobs, "jobs", side_effect=poll),
        ):
            response = await self.client.post(self.path, json=self.body)
            self.assertEqual(response.status, 200, await response.text())
            await asyncio.wait_for(first_polled.wait(), timeout=2)
            path = self.path + "/" + self.batch_id
            paused = await self.client.put(path, json={"board": "test", "paused": True})
            self.assertEqual(paused.status, 200)
            overlap = await self.client.post(self.path, json={**self.body, "id": "another-shot-batch-12345"})
            self.assertEqual(overlap.status, 409)
            complete_first.set()
            await asyncio.gather(*self.app["wizard_video_workers"].values())
            self.assertEqual(submitted, ["v1"])
            self.assertEqual(wizard_batches.entries(self.batch_id)[1]["state"], "waiting")
            resumed = await self.client.put(path, json={"board": "test", "paused": False})
            self.assertEqual(resumed.status, 200)
            await self.wait_state("done")
            self.assertEqual(submitted, ["v1", "v2"])

    async def test_a_failed_shot_does_not_block_an_independent_later_shot(self):
        submitted = []

        async def generate(request):
            node = (await request.json())["prompt"]
            submitted.append(node)
            if node == "v1":
                return web.json_response({"error": "provider rejected first shot"}, status=400)
            return web.json_response({"ids": ["second-job"]})

        async def poll(_):
            return web.json_response({"second-job": {"state": "done", "outputs": [{"ref": "output:h3studio/second.mp4"}]}})

        with (
            patch.object(wizard_batches.requests, "generate_canvas_request", side_effect=generate),
            patch.object(wizard_batches.jobs, "jobs", side_effect=poll),
        ):
            response = await self.client.post(self.path, json=self.body)
            self.assertEqual(response.status, 200, await response.text())
            await self.wait_state("done")
        self.assertEqual(submitted, ["v1", "v2"])
        first, second = wizard_batches.entries(self.batch_id)
        self.assertEqual((first["state"], first["error"], second["state"]),
                         ("error", "provider rejected first shot", "done"))

    async def test_server_renders_an_editable_cut_with_pinned_assets_and_measured_timing(self):
        a = RemakeFixture.make_clip("pinned", 3, (180, 30, 40), 220)
        b = RemakeFixture.make_clip("generated", 2, (25, 140, 30), 330)
        grant_media({"id": 7}, b)
        _, _, script, first, _ = self.board["nodes"]
        first.update(versions=[{"ref":a}],cur=0)
        script["data"] = {
            "shots":[{"id":"s1","duration":1.5,"dialogue":["阿明：出发！"]},{"id":"s2","duration":1}],
            "made":[{"shot_id":"s1","vid":"v1"},{"shot_id":"s2","vid":"v2"}],
            "wizard_media":{"clips":[{"node":"v1","ref":a,"start":1,"end":1.5}]},
        }
        wizard_batches.canvas_routes.write_board(wizard_batches.canvas_routes.board_path("test"), self.board)
        payload = {**self.body, "entries":self.body["entries"][1:],
                   "assembly":[{"node":"v1","ref":a},{"node":"v2","ref":None}]}

        async def generate(_):
            return web.json_response({"ids":["second-job"]})

        async def poll(_):
            return web.json_response({"second-job":{"state":"done","outputs":[{"ref":b}]}})

        with (
            patch.object(wizard_batches.requests, "generate_canvas_request", side_effect=generate),
            patch.object(wizard_batches.jobs, "jobs", side_effect=poll),
            patch.object(render,"subtitle_overlay",return_value=(np.full((4,64,4),255,np.float32),50)),
        ):
            response = await self.client.post(self.path,json=payload)
            self.assertEqual(response.status,200,await response.text())
            await self.wait_state("done")
        returned = await self.client.get(self.path+"/"+self.batch_id,params={"board":"test"})
        film = (await returned.json())["film"]
        self.assertEqual(film["state"], "done", film.get("error"))
        clips = film["timeline"]["clips"]
        self.assertEqual([(c["ref"],c["in"],c["out"]) for c in clips], [(a,0,1.5),(b,0,1),(a,1,1.5)])
        self.assertEqual(clips[0]["subs"],["出发！"])
        output = wizard_batches.jobs.JOBS[film["job_id"]]["outputs"][0]["ref"]
        self.assertAlmostEqual(probe(ref_path(config.COMFY_DIR,output))[2],3,places=2)
