"""Exercise saved image prompts without contacting an engine or text provider."""
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web

import server
import chat_fixture
from oneshot.assistant.agent_chat import InternalRequest
from oneshot.generation import requests
from oneshot.storage import db


class ImageGenerationReplay(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.llm = SimpleNamespace(
            available=Mock(return_value=True),
            chat=AsyncMock(side_effect=[
                '{"visual_details":["绿色门框"]}',
                '{"visual_details":["灰色门框"]}',
            ]),
        )
        self.service = SimpleNamespace(app={
            "llm": self.llm,
            "creative_memory": SimpleNamespace(track=Mock(), observe=Mock()),
        })
        self.user = {"id": 7}
        self.world = {
            "kind": "image",
            "prompt": "在门口等人",
            "images": [{"ref": "input:h3studio/character.png"}],
            "seed": 12,
            "memory_used": [{"kind": "world", "desc": "旧门被漆成绿色"}],
        }
        self.route = {"provider": "original-provider", "model": "original-image-model"}

    async def test_retry_reuses_saved_visual_details_and_pinned_inputs(self):
        sent = []

        async def generate(req, payload, *, fixed_route=None):
            sent.append((copy.deepcopy(payload), fixed_route))
            return web.json_response({"ids": []})

        with patch.object(requests, "_generate_request", side_effect=generate):
            first = InternalRequest(self.service, self.user)
            initial = await requests.submit_prepared_generation(first, self.world)
            saved = json.loads(json.dumps(first["generation_snapshot"]))
            self.llm.available.return_value = False
            replay = await requests.submit_prepared_generation(
                InternalRequest(self.service, self.user), saved,
                fixed_route=self.route, replay=True,
            )

        self.assertIn("绿色门框", sent[0][0]["prompt"])
        self.assertEqual(sent[1], (sent[0][0], self.route))
        self.assertEqual(json.loads(initial.body)["image_story_context"], "applied")
        self.assertEqual(json.loads(replay.body)["image_story_context"], "applied")
        self.llm.chat.assert_awaited_once()

    async def test_retry_sends_effective_prompt_after_image_expansion(self):
        sent = []

        async def generate(req, payload, *, fixed_route=None):
            if payload.get("expand"):
                req["effective_image_prompt"] = "A person waiting by the green door."
            sent.append(req.get("effective_image_prompt", payload["prompt"]))
            return web.json_response({"ids": []})

        with patch.object(requests, "_generate_request", side_effect=generate):
            first = InternalRequest(self.service, self.user)
            await requests.submit_prepared_generation(first, {**self.world, "expand": True})
            snapshot = first["generation_snapshot"]
            self.assertFalse(snapshot["expand"])
            await requests.submit_prepared_generation(
                InternalRequest(self.service, self.user), snapshot,
                fixed_route=self.route, replay=True,
            )

        self.assertEqual(sent, ["A person waiting by the green door."] * 2)
        self.llm.chat.assert_awaited_once()

    async def test_legacy_story_snapshot_fails_before_submitting(self):
        with patch.object(requests, "_generate_request", new_callable=AsyncMock) as generate:
            with self.assertRaisesRegex(ValueError, "历史任务未保存实际提交的图片提示词"):
                await requests.submit_prepared_generation(
                    InternalRequest(self.service, self.user), self.world,
                    fixed_route=self.route, replay=True,
                )
            generate.assert_not_awaited()
        self.llm.chat.assert_not_awaited()


    async def test_legacy_story_snapshot_can_use_a_complete_recorded_prompt(self):
        recorded = "在门口等人" + requests.creative_memory.IMAGE_STORY_PROMPT_MARKER + "旧门被漆成绿色。"
        saved = requests.prepare_generation_replay(self.world, recorded)
        with patch.object(requests, "_generate_request", new_callable=AsyncMock) as generate:
            generate.return_value = web.json_response({"ids": []})
            request = InternalRequest(self.service, self.user)
            await requests.submit_prepared_generation(
                request, saved, fixed_route=self.route, replay=True,
            )
            generate.assert_awaited_once_with(request, {**self.world, "prompt": recorded}, fixed_route=self.route)
        self.llm.chat.assert_not_awaited()

    async def test_legacy_plain_prompt_can_still_be_retried(self):
        legacy = {**self.world, "memory_used": []}
        with patch.object(requests, "_generate_request", new_callable=AsyncMock) as generate:
            generate.return_value = web.json_response({"ids": []})
            request = InternalRequest(self.service, self.user)
            await requests.submit_prepared_generation(
                request, legacy, fixed_route=self.route, replay=True,
            )
            generate.assert_awaited_once_with(request, legacy, fixed_route=self.route)
        self.llm.chat.assert_not_awaited()

class StoryRetryEndpoint(chat_fixture.ChatFixture):
    async def check_story_retry(self, legacy=False):
        world = self.app["creative_memory"].put({"id": 7, "role": "member"}, {
            "kind": "world", "board": "test", "name": "旧城设定", "desc": "门框刷了绿色",
        })
        self.assertTrue(world["id"])
        self.svc.model.side_effect = [
            chat_fixture.call("image_generate", {"prompt": "@旧城设定 在门口等人"}),
            chat_fixture.answer(),
        ]
        llm = SimpleNamespace(available=lambda: True, chat=AsyncMock(side_effect=[
            '{"visual_details":["墨绿色门框"]}', '{"visual_details":["浅灰色门框"]}',
        ]))
        sent = []

        async def generate(req, payload, *, fixed_route=None):
            sent.append(copy.deepcopy(payload))
            req["generation_route"] = {"provider": None, "model": None}
            jid = f"story-retry-{len(sent)}"
            db.task_start(id=jid, user_id=7, board_id="test", capability="image", state="error")
            server.JOBS[jid] = {"state": "error", "created": 1, "meta": {"uid": 7}, "outputs": [], "error": "测试失败"}
            return web.json_response({"ids": [jid]})

        with patch.dict(self.app, {"llm": llm}), patch.object(requests, "_generate_request", side_effect=generate):
            run = await self.send("按旧城设定生成一张图")
            await self.wait(run, timeout=8)
            retry = db.one("SELECT snapshot,call_id FROM chat_retries JOIN chat_calls ON id=call_id WHERE run_id=?", run)
            self.assertIsNotNone(retry)
            if legacy:
                saved = json.loads(retry["snapshot"])
                saved["generation"].pop("_effective_image_snapshot")
                saved["generation"].pop("_image_story_status")
                saved["generation"]["prompt"] = "在门口等人"
                db.run("UPDATE chat_retries SET snapshot=? WHERE call_id=?", json.dumps(saved), retry["call_id"])
            endpoint = f"/api/chat/sessions/{self.sid}/calls/{retry['call_id']}/retry"
            response = await self.client.post(endpoint, json={})
            self.assertEqual(response.status, 200, await response.text())
            await self.wait((await response.json())["id"], timeout=8)

        self.assertIn("墨绿色门框", sent[0]["prompt"])
        self.assertEqual(sent[1], sent[0])
        llm.chat.assert_awaited_once()

    async def test_retry_endpoint_reuses_the_original_effective_story_prompt(self):
        await self.check_story_retry()

    async def test_retry_endpoint_recovers_an_exact_legacy_story_prompt(self):
        await self.check_story_retry(legacy=True)
