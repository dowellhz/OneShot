"""Video dialogue, timing, and media bindings across translation."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import json
import tempfile
import unittest

from oneshot.generation import fields
from oneshot.generation import prompts
import server

from chat_fixture import ChatFixture


class VideoDialogueFields(unittest.TestCase):
    def test_explicit_action_times_preserve_line_order_and_dialogue(self):
        prompt, _, _ = fields.compose({
            "scene":"空走廊",
            "action":"0–0.5 秒 保持站姿\n0.5 至 2.25 秒：乔纳低声问：“谁？”\n2.25-4.6 seconds 回到门口",
            "people":"乔纳：旧夹克",
        })
        self.assertEqual(prompt.splitlines()[-3:], [
            "0–0.5 s: 保持站姿。",
            "0.5–2.25 s: 乔纳 (S1)低声问: <d>[Chinese] 谁？</d>.",
            "2.25–4.6 s: 回到门口。",
        ])

    def test_unique_short_speaker_name_keeps_reference_binding(self):
        prompt, _, _ = fields.compose(
            {"people":"乔纳·里德：旧夹克\n抱画女人：米色外套",
             "dialogue":"抱画女人（试探）：你也是来看米拉的？\n乔纳（点头）：对。\n乔纳·里德：你买了哪一张？"},
            subj={"乔纳·里德":1,"抱画女人":2})
        self.assertIn("抱画女人 <Subject 2> (S1)",prompt)
        self.assertEqual(prompt.count("乔纳·里德 <Subject 1> (S2)"),2)
        self.assertIn("<d>[Chinese] 对。</d>",prompt)
        ambiguous, _, _ = fields.compose(
            {"people":"乔纳·里德：旧夹克\n乔纳·另一个：新夹克","dialogue":"乔纳：你好。"},
            subj={"乔纳·里德":1,"乔纳·另一个":2})
        self.assertIn("乔纳 (S1) says",ambiguous)

    def test_rewrite_request_keeps_character_identity_and_spoken_words(self):
        prompt = fields.for_rewriter({
            "people":"乔纳·里德：旧夹克\n抱画女人：米色外套",
            "action":"乔纳低声问：“你还好吗？”",
            "dialogue":"抱画女人：Je vais bien.\n乔纳（点头）：好。\n“走吧。”",
        },subj={"乔纳·里德":1,"抱画女人":2})
        self.assertIn("乔纳 = 乔纳·里德 <Subject 1>",prompt)
        self.assertIn("乔纳·里德 <Subject 1> (S1)低声问: <d>你还好吗？</d>",prompt)
        self.assertIn("抱画女人 <Subject 2> (S2) says: <d>Je vais bien.</d>",prompt)
        self.assertIn("乔纳·里德 <Subject 1> (S1) says: <d>走吧。</d>",prompt)
        self.assertIn("add the correct language tag",prompt)


class VideoTimingTranslation(unittest.IsolatedAsyncioTestCase):
    async def test_translation_preserves_exact_times_on_separate_lines(self):
        source = {"prompt":"0–0.5 s: 保持站姿。\n0.5–2.25 s: 走到门口。"}
        expected = "0–0.5 s: Hold still.\n0.5–2.25 s: Walk to the door."
        llm = SimpleNamespace(available=lambda:True, chat=AsyncMock())
        with patch.object(prompts, "_XLATE_CACHE", {}), tempfile.TemporaryDirectory() as folder, \
                patch.object(prompts, "XLATE_FILE", Path(folder)/"timing.json"):
            for invalid in (expected.replace("2.25", "2.5"), expected.replace("\n", " ")):
                llm.chat.return_value = json.dumps({"prompt":invalid})
                rejected = await server.to_english({"llm":llm}, source)
                self.assertIn("action timing changed", rejected["_xlate_err"])
                self.assertEqual(rejected["prompt"], source["prompt"])
            llm.chat.return_value = json.dumps({"prompt":expected})
            translated = await server.to_english({"llm":llm}, source)
        self.assertEqual(translated["prompt"], expected)


class VideoPreviewTranslation(ChatFixture):
    async def test_video_preview_keeps_media_bindings_during_translation(self):
        images = [
            {"name": "走廊首帧", "ref": self.source["ref"], "time": 0, "role": "frame", "index": 1},
            {"name": "乔纳·里德", "ref": self.source["ref"], "role": "subject", "index": 2},
            {"name": "抱画女人", "ref": self.source["ref"], "role": "subject", "index": 3},
        ]
        raw = {"kind": "video", "board": "test", "planned": True, "images": images,
               "prompt": "从@图1开始，@图2与@图3交谈。"}
        llm = SimpleNamespace(available=lambda: True, chat=AsyncMock(side_effect=[
            json.dumps({"prompt": "Start at image one and show two people talking."}),
            json.dumps({"prompt": "Start at @图1, then @图2 talks with @图3."}),
        ]))
        with patch.object(server.providers, "primary", return_value=None), patch.object(
            prompts, "_XLATE_CACHE", {}
        ), patch.object(prompts, "XLATE_FILE", self.root / "translate.json"), patch.dict(self.app, {"llm": llm}):
            failed = await self.client.post("/api/preview", json=raw)
            self.assertEqual(failed.status, 200, await failed.text())
            fallback = await failed.json()
            self.assertIn("未翻译", fallback["mode"])
            self.assertIn("从<Picture 3>开始，<Picture 1>与<Picture 2>交谈。", fallback["prompt"])
            response = await self.client.post("/api/preview", json=raw)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual([item["role"] for item in result["inputs"]], ["frame", "subject", "subject"])
        self.assertIn("Start at <Picture 3>, then <Picture 1> talks with <Picture 2>.", result["prompt"])
        self.assertFalse(server.JOBS)

    async def test_third_party_video_preview_uses_translated_reference_roles(self):
        provider = {"id": "video", "name": "视频服务", "kind": "kling", "enabled": True}
        raw = {"kind": "video", "provider": "video", "board": "test",
               "images": [{"name": "走廊", "ref": self.source["ref"], "role": "frame"},
                          {"name": "乔纳·里德", "ref": self.source["ref"], "role": "subject"}],
               "fields": {"action": "从@图1开始，@图2向左看。"}, "prompt": ""}
        with patch.object(server.providers, "get", return_value=provider), patch.object(
            server.providers, "default_model", return_value="kling-3.0"
        ):
            response = await self.client.post("/api/preview", json=raw)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertIn("从首帧画面开始，第 1 张人物参考图向左看。", result["prompt"])
        self.assertEqual([item["role"] for item in result["inputs"]], ["first_frame", "subject"])
        self.assertFalse(server.JOBS)
