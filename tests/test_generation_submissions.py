"""The resume API preserves a generation request across a lost response."""

import asyncio
from unittest.mock import AsyncMock, patch

from aiohttp import web

from chat_fixture import ChatFixture
from oneshot.generation import requests, submissions
from oneshot.storage import db


class GenerationSubmissions(ChatFixture):
    payload = {"board": "test", "kind": "image", "prompt": "A folded sail"}
    key = "stable-generation-0001"
    headers = {"X-OneShot-Submission": key, "X-OneShot-Node": "n1"}

    async def receipt(self, *, headers=None, node="n1"):
        return await self.client.get("/api/generate/receipt",
                                     params={"board": "test", "node": node, "key": self.key}, headers=headers)

    async def test_concurrent_submit_returns_the_existing_job_after_confirmation(self):
        entered, finished = asyncio.Event(), asyncio.Event()
        result = {"ids": ["known-job"], "image_model": {"provider": "local_h3"}}

        async def execute(_):
            entered.set()
            await finished.wait()
            return web.json_response(result)

        with patch.object(requests, "generate_canvas_request", side_effect=execute) as generate:
            first = asyncio.create_task(self.client.post("/api/generate", json=self.payload, headers=self.headers))
            try:
                await asyncio.wait_for(entered.wait(), timeout=2)
                duplicate = await self.client.post("/api/generate", json=self.payload, headers=self.headers)
                self.assertEqual(duplicate.status, 409)
                self.assertEqual(await (await self.receipt()).json(), {"state": "submitting"})
            finally:
                finished.set()
                response = await first
            self.assertEqual(await response.json(), result)
            retry = await self.client.post("/api/generate", json=self.payload, headers=self.headers)
            self.assertEqual(await retry.json(), result)
            invalid = await self.client.post("/api/generate", json={**self.payload, "prompt": "changed"},
                                             headers=self.headers)
            self.assertEqual(invalid.status, 400)
            generate.assert_awaited_once()

        with patch.object(submissions, "INSTANCE", "restarted-worker"):
            response = await self.receipt()
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(await response.json(), {"state": "accepted", "result": result})
        self.assertEqual((await self.receipt(headers={"X-Uid": "8"})).status, 403)
        self.board["collaborators"] = {"8": "editor"}
        submissions.canvas_routes.write_board(submissions.canvas_routes.board_path("test"), self.board)
        self.assertEqual(await (await self.receipt(headers={"X-Uid": "8"})).json(), {"state": "missing"})
        self.assertEqual(await (await self.receipt(node="n2")).json(), {"state": "missing"})

    async def test_prequeue_rejection_is_distinct_from_an_interrupted_worker(self):
        generate = AsyncMock(return_value=web.json_response({"error": "invalid"}, status=400))
        with patch.object(requests, "generate_canvas_request", generate):
            response = await self.client.post("/api/generate", json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 400)
        self.assertEqual(await (await self.receipt()).json(), {"state": "rejected"})
        db.run("UPDATE generation_submissions SET state='submitting',worker='old-worker'")
        self.assertEqual(await (await self.receipt()).json(), {"state": "uncertain"})

    async def test_receipt_recovers_a_partial_batch_when_later_submission_fails(self):
        async def generate(req):
            ids = []
            submissions.append_queued_job(req, ids, "first-job", {})
            raise web.HTTPBadGateway()

        with patch.object(requests, "generate_canvas_request", side_effect=generate):
            response = await self.client.post("/api/generate", json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 502)
        self.assertEqual(await (await self.receipt()).json(),
                         {"state": "accepted", "result": {"ids": ["first-job"], "meta": {}}})
