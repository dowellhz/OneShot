"""Keep image model choices, input references, and worker dispatch aligned."""

import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp import web
from PIL import Image

from engine import image_models
from oneshot import config
from oneshot.generation import image_prompts, local
from oneshot.providers import remote, remote_images, selection
from oneshot.providers.routes import canvas_model_choice


class ImageModelRoutes(IsolatedAsyncioTestCase):
    async def test_local_selection_is_gated_and_keeps_reference_roles(self):
        provider = {"id": "local_h3", "kind": "local_h3", "enabled": True}
        request = {"provider": "local_h3", "selected_model": "flux-2-klein-4b",
                   "prompt": "@图1 保留机位，把球移到草地", "images": [{"image_use": "camera"}]}
        with patch.object(selection.providers, "get", return_value=provider), \
             patch.object(selection.providers, "routes", return_value=[]), \
             patch.object(image_models, "installed", return_value=False):
            with self.assertRaises(web.HTTPBadRequest):
                selection.requested_generation_route(request, "image")
        with patch.object(selection.providers, "get", return_value=provider), \
             patch.object(selection.providers, "routes", return_value=[]), \
             patch.object(image_models, "installed", return_value=True):
            route = selection.requested_generation_route(request, "image")
            result, expanded = await image_prompts.prepare({}, request, route)
            self.assertEqual(result["prompt"], "图1 保留机位，把球移到草地\n\n参考图用途\n图1：仅参考机位、透视和景别，人物和道具的位置以画面描述为准。")
            self.assertFalse(expanded)
            self.assertEqual(canvas_model_choice(provider, "image", route["model"])["ref_limit"], 4)
            with self.assertRaises(web.HTTPBadRequest):
                await image_prompts.prepare({}, {**request, "images": request["images"] * 5}, route)

    async def test_engine_receives_the_qwen_model_and_tracks_the_task(self):
        response = MagicMock()
        response.__aenter__.return_value.json = AsyncMock(return_value={"id": "engine-image-test"})
        http = MagicMock()
        http.post.return_value = response
        req = MagicMock(app={"http": http})
        req.__getitem__.return_value = {"id": 7}
        with TemporaryDirectory() as folder, patch.object(config, "COMFY_DIR", Path(folder)), \
             patch.object(local.db, "task_start") as task, \
             patch.object(local.generation_jobs, "follow_engine", new_callable=AsyncMock), \
             patch.dict(local.generation_jobs.JOBS, clear=True):
            queued = await local.generate_engine_image(req, {"kind": "image", "prompt": "一颗球在地上", "ar": 16 / 9}, 1,
                                                       model="qwen-image-2.1")
            body = http.post.call_args.kwargs["json"]
            self.assertEqual((body["kind"], body["image_model"], body["steps"]), ("image", "qwen-image-2.1", 40))
            self.assertEqual(json.loads(queued.body)["meta"]["model"], "qwen-image-2.1")
            self.assertEqual(task.call_args.kwargs["model"], body["image_model"])

    async def test_gemini_retains_reference_order_and_discards_thought_images(self):
        provider = {"name": "Gemini", "kind": "gemini", "config": {}, "secrets": {"api_key": "fake-key"}}
        with TemporaryDirectory() as folder:
            root = Path(folder)
            first, second = root / "first.png", root / "second.png"
            Image.new("RGB", (32, 32), "red").save(first)
            Image.new("RGB", (32, 32), "blue").save(second)
            expected = second.read_bytes()
            result = {"candidates": [{"content": {"parts": [
                {"thought": True, "inlineData": {"mimeType": "image/png", "data": "discard"}},
                {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(expected).decode()}},
            ]}}]}
            with patch.object(remote_images, "json_req", new_callable=AsyncMock, return_value=result) as api:
                output = await remote.run(None, root, provider, "gemini-3.1-flash-image", "image",
                                          {"prompt": "按图2配色", "images": [first, second], "ar": 16 / 9})
            self.assertEqual(output["files"][0]["path"].read_bytes(), expected)
            self.assertTrue(api.call_args.args[2].endswith("/gemini-3.1-flash-image:generateContent"))
            request = api.call_args.kwargs["json"]
            self.assertEqual(request["generationConfig"]["imageConfig"], {"aspectRatio": "16:9", "imageSize": "2K"})
            self.assertEqual([part["text"] for part in request["contents"][0]["parts"] if "text" in part],
                             ["图1 (Image 1)", "图2 (Image 2)", "按图2配色"])
            self.assertEqual(api.call_args.kwargs["headers"], {"x-goog-api-key": "fake-key"})

    async def test_sunburst_uses_precision_mode_on_edit_endpoint(self):
        provider = {"name": "OpenAI", "kind": "openai", "config": {}, "secrets": {"api_key": "fake"}}
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "first.png"
            Image.new("RGB", (32, 32)).save(path)
            result = {"data": [{"b64_json": base64.b64encode(path.read_bytes()).decode()}]}
            with patch.object(remote_images, "json_req", new_callable=AsyncMock, return_value=result) as api:
                output = await remote.run(None, root, provider, "gpt-image-2.6-sunburst", "image",
                                          {"prompt": "把球移到草地", "images": [path]})
            self.assertTrue(output["files"][0]["path"].is_file())
            self.assertTrue(api.call_args.args[2].endswith("/images/edits"))
            self.assertEqual(api.call_args.kwargs["json"]["complexity"], "high")
            self.assertTrue(api.call_args.kwargs["json"]["images"][0]["image_url"].startswith("data:image/jpeg;"))
