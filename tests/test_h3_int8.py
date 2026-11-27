import asyncio
from unittest.mock import AsyncMock, patch

import server
from engine import sulphur
from oneshot.generation import local as local_generation
from chat_fixture import ChatFixture


class Int8Video(ChatFixture):
    async def test_select_preview_and_queue_ref2va_with_anchors(self):
        server.providers.seed()
        model = server.h3_int8.MODEL
        images = [dict(self.source, role="frame", index=1, time=0),
                  dict(self.source, role="subject", index=2),
                  dict(self.source, role="frame", index=3, time=2),
                  dict(self.source, role="frame", index=4, time=5)]
        request = {"kind": "video", "provider": "local_h3", "selected_model": model,
                   "board": "test", "planned": True, "images": images, "quality": "std", "seed": 72,
                   "prompt": "The actor in @图2 follows the poses shown in @图1, @图3 and @图4."}
        with patch.object(server.h3_int8, "installed", return_value=False):
            preview = await self.client.post("/api/preview", json=request)
            self.assertEqual(preview.status, 400)
        with patch.object(server.h3_int8, "installed", return_value=True), patch.object(
            local_generation, "engine_up", new=AsyncMock(return_value=True)
        ), patch.object(local_generation, "prepare_engine", new=AsyncMock()) as prepare:
            local = next(x for x in server.canvas_provider_choices("video") if x["id"] == "local_h3")
            self.assertEqual(local["model"], "h3-video")
            self.assertIn(model, [x["id"] for x in local["models"]])
            preview = await self.client.post("/api/preview", json=request)
            self.assertEqual(preview.status, 200, await preview.text())
            self.assertIn(server.h3_int8.LABEL, (await preview.json())["mode"])
            response = await self.client.post("/api/generate", json=request)
            self.assertEqual(response.status, 200, await response.text())
            result = await response.json()
            self.assertEqual(result["video_model"], {"provider": "local_h3", "selected_model": model})
            await asyncio.sleep(0)
            prepared = prepare.await_args.args[1]
        graph, metadata = server.graph_video(prepared, native=True)
        self.assertEqual(graph["1"]["inputs"]["unet_name"], server.h3_int8.WEIGHTS)
        self.assertEqual(graph["5"]["inputs"]["ref_images.ref_image_0"], ["s0", 0])
        self.assertEqual([graph[f"guide{i}"]["inputs"]["frame_idx"] for i in range(3)], [0, 48, 120])
        self.assertEqual(graph["14"]["inputs"]["audio"], ["13", 0])
        self.assertEqual((metadata["model"], metadata["height"], metadata["seed"]), (model, 480, 72))
        self.assertIn("actor in <Picture 1>", metadata["full_prompt"])

    def test_first_and_last_images_use_ref2va_guides(self):
        request = {"_int8": True, "prompt": "The subject turns left.", "mode": "fl2v",
                   "images": [self.source, self.source], "turbo": False}
        graph, _ = server.graph_video(request)
        self.assertEqual(graph["5"]["class_type"], "MiniMaxH3ReferenceToVideo")
        self.assertEqual([graph[f"guide{i}"]["inputs"]["frame_idx"] for i in range(2)], [0, 120])
        self.assertNotIn("6", graph)

    async def test_sulphur_previews_and_queues_the_pinned_checkpoint(self):
        server.providers.seed()
        request = {"kind":"video", "provider":"local_h3", "selected_model":sulphur.MODEL, "board":"test",
                   "prompt":"A yellow ball rolls across the grass.", "mode":"fl2v",
                   "images":[self.source, self.source], "quality":"std", "seed":17}
        with patch.object(server.h3_int8, "installed", side_effect=lambda *args: bool(args)), patch.object(
            local_generation, "engine_up", new=AsyncMock(return_value=True)
        ), patch.object(local_generation, "prepare_engine", new=AsyncMock()) as prepare:
            preview = await self.client.post("/api/preview", json=request)
            self.assertEqual(preview.status, 200, await preview.text())
            self.assertIn(sulphur.LABEL, (await preview.json())["mode"])
            queued = await self.client.post("/api/generate", json=request)
            self.assertEqual(queued.status, 200, await queued.text())
            self.assertEqual((await queued.json())["video_model"]["selected_model"], sulphur.MODEL)
            await asyncio.sleep(0)
            prepared = prepare.await_args.args[1]
            invalid = await self.client.post("/api/preview", json={**request, "planned":True})
            self.assertEqual(invalid.status, 400)
        graph, meta = server.graph_video(prepared)
        self.assertEqual(graph["1"]["inputs"]["unet_name"], sulphur.WEIGHTS)
        self.assertEqual(graph["5"]["inputs"]["first_frame"], ["img0", 0])
        self.assertEqual(graph["5"]["inputs"]["last_frame"], ["img1", 0])
        self.assertEqual(graph["8"]["inputs"]["sampler_name"], "euler")
        self.assertEqual((meta["model"], meta["steps"], meta["seed"]), (sulphur.MODEL, 20, 17))
