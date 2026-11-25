from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from aiohttp import web

from chat_fixture import ChatFixture
from oneshot.generation import graphs, image_prompts, local


class ImagePreview(ChatFixture):
    async def test_reviewed_prompt_and_materials_are_used_at_submission(self):
        self.app["reviewed_image_prompts"] = image_prompts.ReviewedImagePrompts()
        self.app["llm"] = SimpleNamespace(available=lambda: True, running=lambda: False)
        saved = self.source["ref"]
        request = {
            "kind": "image", "board": "test", "prompt": '门牌上写“17”。参考 @图片1。',
            "image_text": "specified", "expand": True,
            "images": [{"ref": saved, "image_use": "camera"}],
        }
        expanded = AsyncMock(return_value="Night corridor, with a sign reading 17.")
        submit = AsyncMock(return_value=web.json_response({"ids": []}))
        templates = Path(self.tmp.name)
        (templates / "h3image_edit.json").write_text("{}")
        with patch.object(graphs, "TEMPLATES", templates), patch.object(
            image_prompts.rewriter, "expand_image", expanded
        ), patch.object(
            local, "engine_up", new=AsyncMock(return_value=True)
        ), patch.object(local, "generate_engine_image", submit):
            response = await self.client.post("/api/preview", json=request)
            self.assertEqual(response.status, 200, await response.text())
            preview = await response.json()
            self.assertEqual(preview["inputs"][0]["image_role"], "image_camera")
            self.assertIn("<Picture 1>", preview["prompt"])
            self.assertIn("人物和道具的位置以画面描述为准", preview["prompt"])
            submission = {**request, "image_preview": preview["image_preview"]}
            changed = {**submission, "images": [{"ref": saved, "image_use": "style"}]}
            response = await self.client.post("/api/generate", json=changed)
            self.assertEqual(response.status, 400)
            submit.assert_not_awaited()
            response = await self.client.post("/api/generate", json=submission)
            self.assertEqual(response.status, 200, await response.text())
        expanded.assert_awaited_once()
        submit.assert_awaited_once()
        payload = submit.await_args.args[1]
        self.assertEqual(payload["prompt"], preview["prompt"])
        self.assertFalse(payload["expand"])
        self.assertEqual(payload["images"], request["images"])

    async def test_expansion_cannot_replace_the_requested_sign(self):
        templates = Path(self.tmp.name)
        (templates / "h3image_t2i.json").write_text("{}")
        app = {"llm": SimpleNamespace(available=lambda: True)}
        raw = {"kind": "image", "prompt": '旧门牌写“17”', "image_text": "specified", "expand": True}
        with patch.object(graphs, "TEMPLATES", templates), patch.object(
            image_prompts.rewriter, "expand_image", new=AsyncMock(return_value="The sign reads 170.")
        ):
            prepared, expanded = await image_prompts.prepare(app, raw, None, review=True)
        self.assertFalse(expanded)
        self.assertFalse(prepared["expand"])
        self.assertIn('旧门牌写“17”', prepared["prompt"])
        self.assertNotIn("170", prepared["prompt"])


class GenerationConstraints(TestCase):
    def test_image_roles_and_visible_text_are_kept_separate(self):
        result = image_prompts.compose({"prompt": '门口双人，门牌“17”', "image_text": "specified",
                                        "images": [{"image_use": "composition"}, {"memory_kind": "character"}]})
        self.assertIn("门牌“17”", result)
        self.assertIn("@图1：仅参考机位", result)
        self.assertIn("@图2：仅参考指定角色", result)
        self.assertIn("不添加其他文字", result)

    def test_h3_dialogue_guard_keeps_lines_and_limits_other_speech(self):
        line = "<d>[Chinese] 是。你买了她哪一张？</d>"
        text = f"detailed_description:\n[Shot 1] {line}\n\noverall_soundscape:\nFootsteps.\n\nnon_diegetic_music:\nN/A"
        actual = graphs.no_speech_guard(text)
        self.assertIn(line, actual)
        self.assertIn("Footsteps. " + graphs.SCRIPTED_SPEECH_SOUND, actual)
        self.assertNotIn(graphs.NO_SPEECH_SOUND, actual)
        self.assertEqual(actual, graphs.no_speech_guard(actual))
        silent = graphs.no_speech_guard("detailed_description:\n[Shot 1] The door opens.")
        self.assertIn(graphs.NO_SPEECH_SOUND, silent)
