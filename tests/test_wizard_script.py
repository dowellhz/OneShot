import asyncio
import json
from unittest.mock import patch

from chat_fixture import ChatFixture
from oneshot.generation import prompts
from oneshot.web.media import grant_media
import server


class WizardScript(ChatFixture):
    async def test_draft_finishes_without_polling_and_reattaches_to_the_same_result(self):
        self.board["nodes"].append({"id": "script", "type": "script", "data": {}})
        server.board_path("test").write_text(json.dumps(self.board))
        grant_media({"id": 7}, self.source["ref"])
        payload = {"board": "test", "script": "script", "key": "storyboard-attempt-123",
                   "story": "A penguin raises a flag.", "refs": [{"ref": self.source["ref"]}]}
        released = asyncio.Event()
        generated = {"title": "A Flag", "shots": [{"action": ["Raises flag."]}]}
        calls = []

        async def plan(app, user, raw):
            calls.append(raw["story"])
            await released.wait()
            return generated

        async def post(**changes):
            return await self.client.post("/api/wizard/screenplay", json={**payload, **changes})

        with patch.object(prompts, "build_storyboard", plan):
            self.assertEqual(await (await post()).json(), {"state": "running"})
            self.assertEqual(await (await post()).json(), {"state": "running"})
            self.assertEqual((await post(story="Different draft")).status, 400)
            denied = await self.client.post("/api/wizard/screenplay", json=payload, headers={"X-Uid": "8"})
            self.assertEqual(denied.status, 403)
            worker, = self.app["remote_tasks"]
            released.set()
            await asyncio.wait_for(worker, 2)
            self.assertEqual(await (await post()).json(), {"state": "done", "result": generated})
            self.assertEqual(calls, [payload["story"]])
