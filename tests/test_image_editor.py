import asyncio
import io
import json
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image, ImageChops, ImageDraw

import image_editor as editor
import image_upscale
import server


class ImageEdits(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.im = Image.new("RGBA", (300, 180), (30, 80, 120, 217))
        ImageDraw.Draw(self.im).rectangle((110, 50, 140, 90), fill=(200, 90, 30, 255))
        self.source = editor.save(self.root, self.im, kind="input")["ref"]
        self.mask = Image.new("L", self.im.size)
        ImageDraw.Draw(self.mask).rectangle((110, 50, 140, 90), fill=255)
        self.mask_ref = editor.save(self.root, self.mask, kind="input")["ref"]

    def tearDown(self):
        self.tmp.cleanup()

    def prepared(self, **kwargs):
        return editor.prepare(self.root, {"ref": self.source, "mask": self.mask_ref,
                                         "prompt": "换成绿色", "mode": "region", **kwargs})

    def generated(self, color="lime"):
        # Different model output size exercises result alignment / resizing.
        return [editor.save(self.root, Image.new("RGBA", (160, 160), color))]

    def test_region_preserves_every_unselected_rgba_pixel(self):
        spec = self.prepared(feather=12)["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        result = editor.load(self.root, output["ref"])
        self.assertEqual(result.size, self.im.size)
        for y in range(self.im.height):
            for x in range(self.im.width):
                if self.mask.getpixel((x, y)) == 0:
                    self.assertEqual(self.im.getpixel((x, y)), result.getpixel((x, y)))
        self.assertNotEqual(result.getpixel((125, 70)), self.im.getpixel((125, 70)))
        self.assertEqual(editor.load(self.root, self.source).tobytes(), self.im.tobytes())

    def test_result_blend_is_opacity(self):
        spec = self.prepared(feather=0, strength=.5)["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        pixel = editor.load(self.root, output["ref"]).getpixel((125, 70))
        self.assertTrue(98 <= pixel[0] <= 101)
        self.assertTrue(171 <= pixel[1] <= 174)

    def test_outpaint_preserves_original_and_fills_new_canvas(self):
        spec = self.prepared(mode="outpaint", padding={"left": 30, "top": 20, "right": 40})["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        result = editor.load(self.root, output["ref"])
        self.assertEqual(result.size, (370, 200))
        self.assertEqual(result.crop((30, 20, 330, 200)).tobytes(), self.im.tobytes())
        self.assertEqual(result.getpixel((0, 0)), (0, 255, 0, 255))

    def test_crop_rotate_flip_preserves_transparency_and_source(self):
        result = editor.transform(self.root, {"ref": self.source, "crop": {"x": 30, "y": 20, "w": 100, "h": 80}, "rotate": 90, "flip_x": True})
        actual = editor.load(self.root, result["ref"])
        expected = self.im.crop((30, 20, 130, 100)).rotate(-90, expand=True).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(actual.size, (80, 100))
        self.assertEqual(editor.load(self.root, self.source).tobytes(), self.im.tobytes())

    def test_rejects_invalid_inputs(self):
        blank = editor.save(self.root, Image.new("L", self.im.size), kind="input")["ref"]
        small = editor.save(self.root, Image.new("L", (10, 10), 255), kind="input")["ref"]
        for kwargs in ({"mask": blank}, {"mask": small}, {"feather": float("nan")}, {"strength": 2},
                       {"ref": "input:h3studio/../../../etc/passwd"}, {"mode": "unknown"}, {"prompt": ""},
                       {"mode": "outpaint", "padding": {}}, {"mode": "outpaint", "padding": {"left": -1}}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, OSError)):
                self.prepared(**kwargs)
        for crop in ({"x": 290, "y": 0, "w": 20, "h": 10}, {"x": -1, "y": 0, "w": 10, "h": 10}):
            with self.assertRaises(ValueError):
                editor.transform(self.root, {"ref": self.source, "crop": crop})


    def test_ordered_layers_opacity_position_and_hidden_layers(self):
        red = editor.save(self.root, Image.new("RGBA", (20, 20), (255, 0, 0, 255)), kind="input")
        blue = editor.save(self.root, Image.new("RGBA", (20, 20), (0, 0, 255, 255)), kind="input")
        r = editor.compose_layers(self.root, {"ref": self.source, "layers": [
            {"ref": red["ref"], "x": -10, "y": 10, "opacity": .5},
            {"ref": blue["ref"], "x": 0, "y": 10, "visible": False}]})
        im = editor.load(self.root, r["ref"])
        self.assertEqual(im.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(im.getpixel((5, 15)), (255, 0, 0, 128))
        self.assertEqual(im.getpixel((15, 15)), (0, 0, 0, 0))

    def test_selection_cutout_multiplies_existing_alpha(self):
        r = editor.cut_selection(self.root, {"ref": self.source, "mask": self.mask_ref})
        im = editor.load(self.root, r["ref"])
        self.assertEqual(im.getpixel((0, 0))[3], 0)
        self.assertEqual(im.getpixel((125, 70)), self.im.getpixel((125, 70)))

    def test_native_prepare_uses_real_mask_and_preserves_recipe(self):
        p = self.prepared(backend="native", denoise=.7, steps=30, seed=123)
        self.assertIsNotNone(p["_native_inpaint"])
        self.assertEqual(len(p["images"]), 1)
        native = p["_native_inpaint"]
        self.assertEqual(native["prompt"], "换成绿色")
        self.assertEqual(native["denoise"], .7)
        self.assertEqual(editor.load(self.root, native["mask"]).size, editor.load(self.root, native["image"]).size)
        result = editor.composite(self.root, p["_image_edit"], self.generated())[0]
        recipe = result["extra"]["edit"]["recipe"]
        self.assertEqual(recipe["mask"], self.mask_ref)
        self.assertEqual(recipe["seed"], 123)
        patch = editor.load(self.root, result["extra"]["edit"]["layer"]["ref"])
        self.assertEqual(patch.getpixel((0, 0))[3], 0)


class EditAPI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patchers = [patch.object(server.db, "DB_PATH", self.root / "memory.db"), patch.object(server.db, "_conn", None), patch.object(server, "LIBRARY", self.root / "library.json"), patch.object(server, "COMFY_DIR", self.root), patch.object(server, "EDIT_JOBS", self.root / "jobs"),
                         patch.object(server, "DATA", self.root / "data"), patch.object(server, "BOARDS", self.root / "boards"),
                         patch.object(server.db, "task_start"), patch.object(server.db, "task_update"), patch.object(server, "record")]
        for p in self.patchers:
            p.start()
        server.JOBS.clear()
        self.source = editor.save(self.root, Image.new("RGBA", (256, 192), (80, 120, 140, 255)), kind="input")["ref"]
        mask = Image.new("L", (256, 192))
        ImageDraw.Draw(mask).rectangle((50, 50, 100, 100), fill=255)
        self.mask = editor.save(self.root, mask, kind="input")["ref"]

        @web.middleware
        async def user(req, handler):
            req["user"] = {"id": int(req.headers.get("X-Test-Uid", "7")), "role": "admin"}
            return await handler(req)

        app = web.Application(middlewares=[user])
        self.http = aiohttp.ClientSession()
        app["creative_memory"] = server.creative_memory.Store(server)
        app["http"] = self.http
        app["llm"] = SimpleNamespace(running=lambda: False, available=lambda: False)
        app.add_routes(server.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        for task in asyncio.all_tasks():
            if task.get_coro().__name__ == "follow_engine":
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        await self.client.close()
        await self.http.close()
        server.db.conn().close()
        for p in reversed(self.patchers):
            p.stop()
        server.JOBS.clear()
        self.tmp.cleanup()

    def payload(self):
        return {"ref": self.source, "mask": self.mask, "mode": "region", "prompt": "改为绿色", "feather": 0}

    async def test_transform_and_validation_http(self):
        r = await self.client.post("/api/image-edit/transform", json={"ref": self.source, "rotate": 90})
        self.assertEqual(r.status, 200)
        self.assertEqual((await r.json())["w"], 192)

    async def test_decompose_stores_independent_layers_and_preserves_the_original(self):
        original = Image.new("RGBA",(64,48),(25,64,90,190))
        draw = ImageDraw.Draw(original)
        draw.rectangle((8,8,19,23),fill=(210,30,20,255))
        draw.rectangle((31,12,45,37),fill=(20,190,92,255))
        source = editor.save(self.root,original,kind="input")["ref"]

        async def segmentation(_app, tool, payload):
            self.assertEqual((tool,payload["ref"]),("decompose",source))
            labels = Image.new("L",original.size)
            draw = ImageDraw.Draw(labels)
            draw.rectangle((8,8,19,23),fill=1)
            draw.rectangle((31,12,45,37),fill=2)
            return editor.save(self.root,labels)

        with patch.object(server,"run_image_tool",segmentation):
            response = await self.client.post("/api/image-edit/decompose",json={"ref":source})
        self.assertEqual(response.status,200,await response.text())
        result = await response.json()
        layers = result["layer_stack"]["layers"]
        self.assertEqual([(l["name"],l["x"],l["y"],l["w"],l["h"]) for l in layers],
                         [("背景",0,0,64,48),("物体 1",8,8,12,16),("物体 2",31,12,15,26)])
        self.assertEqual(editor.load(self.root,layers[0]["ref"]).getpixel((9,9))[3],0)
        combined = editor.compose_layers(self.root,{"ref":source,"layers":layers})
        self.assertEqual(editor.load(self.root,combined["ref"]).tobytes(),original.tobytes())
        layers[1]["x"] += 12
        moved = editor.compose_layers(self.root,{"ref":source,"layers":layers})
        self.assertEqual(editor.load(self.root,moved["ref"]).getpixel((9,9))[3],0)
        self.assertEqual(editor.load(self.root,source).tobytes(),original.tobytes())

    async def test_upscale_rejects_invalid_scale_and_reports_missing_models(self):
        url = "/api/image-edit/upscale"
        with patch.object(server, "IMAGE_UPSCALE_MODELS", self.root / "uninstalled"):
            for scale, message in ((True,"2× 或 4×"),(3,"2× 或 4×"),("2","2× 或 4×"),(2,"超分模型")):
                response = await self.client.post(url, json={"ref":self.source,"scale":scale})
                self.assertEqual(response.status,400)
                self.assertIn(message,(await response.json())["error"])

    async def test_real_upscale_preserves_alpha_and_increases_resolution(self):
        if image_upscale.available_scales(server.IMAGE_UPSCALE_MODELS) != [2, 4]:
            self.skipTest("FSRCNN model fixtures not installed")
        source = Image.new("RGBA",(271,99),(30,60,90,180))
        ImageDraw.Draw(source).rectangle((180,20,270,60),fill=(225,10,40,255))
        path = editor.save(self.root,source,kind="input")["ref"]
        for scale in (2,4):
            response = await self.client.post("/api/image-edit/upscale",json={"ref":path,"scale":scale})
            self.assertEqual(response.status,200,await response.text())
            result = await response.json()
            self.assertNotEqual(result["ref"],path)
            image = editor.load(self.root,result["ref"])
            size = (271*scale,99*scale)
            self.assertEqual(image.size,size)
            alpha = source.getchannel("A").resize(size,Image.Resampling.LANCZOS)
            self.assertEqual(image.getchannel("A").tobytes(),alpha.tobytes())
            resized = source.convert("RGB").resize(size,Image.Resampling.LANCZOS)
            self.assertIsNotNone(ImageChops.difference(resized,image.convert("RGB")).getbbox())
        self.assertEqual(editor.load(self.root,path).tobytes(),source.tobytes())

    async def test_resize_fits_keep_exact_dimensions_and_alpha(self):
        original = Image.new("RGBA", (80,40), (80,100,120,160))
        original_ref = editor.save(self.root, original)["ref"]
        url = "/api/image-edit/transform"
        for fit in ("contain","cover","stretch"):
            size = {"width":96,"height":96,"fit":fit}
            response = await self.client.post(url,json={"ref":original_ref,"resize":size})
            self.assertEqual(response.status,200,await response.text())
            result = await response.json()
            self.assertEqual(result["resize"],size)
            pixels = editor.load(self.root,result["ref"])
            self.assertEqual(pixels.size,(96,96))
            self.assertEqual(pixels.getpixel((48,0))[3],0 if fit=="contain" else 160)
            self.assertEqual(pixels.getpixel((48,48))[3],160)
        self.assertEqual(editor.load(self.root,original_ref).tobytes(),original.tobytes())
        for size in ({"width":True,"height":96},{"width":8192,"height":8192},
                     {"width":5,"height":6,"fit":"unknown"}):
            self.assertEqual((await self.client.post(url,json={"ref":original_ref,"resize":size})).status,400)

    async def test_invalid_mask_returns_400(self):
        r = await self.client.post("/api/image-edit/generate", json={**self.payload(), "mask": "input:h3studio/missing.png"})
        self.assertEqual(r.status, 400)
        self.assertIn("error", await r.json())
        for endpoint in ("transform", "generate"):
            r = await self.client.post("/api/image-edit/" + endpoint, json=[])
            self.assertEqual(r.status, 400)

    async def test_remote_job_composites_before_done(self):
        provider = {"id": "fake", "kind": "openai", "name": "Mock", "enabled": True}

        async def run(*args):
            result = editor.save(self.root, Image.new("RGB", (256, 192), "lime"))
            return {"files": [{"ref": result["ref"], "path": editor.ref_path(self.root, result["ref"]), "kind": "image"}]}

        with patch.object(server.providers, "primary", return_value={"provider": provider, "model": "mock"}), patch.object(server.remote, "run", side_effect=run):
            r = await self.client.post("/api/image-edit/generate", json=self.payload())
            self.assertEqual(r.status, 200)
            jid = (await r.json())["ids"][0]
            for _ in range(100):
                if server.JOBS[jid]["state"] in ("done", "error"):
                    break
                await asyncio.sleep(.01)
            j = server.JOBS[jid]
            self.assertEqual(j["state"], "done", j.get("error"))
            result = editor.load(self.root, j["outputs"][0]["ref"])
            self.assertEqual(result.getpixel((0, 0)), (80, 120, 140, 255))
            self.assertEqual(result.getpixel((70, 70)), (0, 255, 0, 255))
            self.assertTrue((server.EDIT_JOBS / (jid + ".json")).is_file())
            recovered = {"id": jid, "meta": {}}
            server.restore_image_edit(recovered)
            self.assertEqual(recovered["meta"]["image_edit"]["source"], self.source)

    async def test_cancel_during_composite_does_not_publish(self):
        spec = editor.prepare(self.root, self.payload())["_image_edit"]
        j = {"id": "cancelled", "state": "running", "meta": {"image_edit": spec}}
        ready, release = asyncio.Event(), asyncio.Event()
        async def delayed(*args):
            ready.set()
            await release.wait()
            return [{"ref": "should-not-be-published"}]
        with patch.object(server.asyncio, "to_thread", side_effect=delayed):
            task = asyncio.create_task(server.complete_outputs(j, []))
            await ready.wait()
            j.update(cancel=True, state="error", error="已取消")
            release.set()
            await task
        self.assertEqual(j["state"], "error")
        self.assertNotIn("outputs", j)

    async def test_draft_roundtrip_restore_and_user_isolation(self):
        server.BOARDS.mkdir()
        (server.BOARDS / "draft-test.json").write_text(json.dumps({"owner": 7, "nodes": []}))
        endpoint = "/api/image-edit/drafts/draft-test/n1"
        draft = {"ref": self.source, "strokes": [{"tool": "rect", "points": [{"x": 1, "y": 2}, {"x": 40, "y": 50}]}],
                 "values": {"iePrompt": "保留我的提示词"}, "layers": [{"ref": self.source}], "updated": 100}
        r = await self.client.put(endpoint, json=draft)
        self.assertEqual(r.status, 200)
        r = await self.client.get(endpoint, params={"ref": self.source})
        self.assertEqual(await r.json(), draft)
        r = await self.client.get(endpoint, params={"ref": self.source}, headers={"X-Test-Uid": "8"})
        self.assertIsNone(await r.json())
        r = await self.client.post(endpoint, json={**draft, "updated": 200})
        self.assertEqual(r.status, 200)
        r = await self.client.get(endpoint, params={"ref": self.source})
        self.assertEqual((await r.json())["updated"], 200)

    async def test_batch_export_contains_exact_authorized_files(self):
        r = await self.client.post("/api/assets/export", json={"refs": [self.source, self.mask, self.source]})
        self.assertEqual(r.status, 200)
        with zipfile.ZipFile(io.BytesIO(await r.read())) as archive:
            self.assertEqual(len(archive.namelist()), 2)
            for item in archive.namelist():
                self.assertNotIn("/", item)
            self.assertEqual(archive.read(archive.namelist()[0]), editor.ref_path(self.root, self.source).read_bytes())
        r = await self.client.post("/api/assets/export", json={"refs": ["input:h3studio/../../secret.key"]})
        self.assertEqual(r.status, 400)

    async def test_layer_endpoints_preserve_transparency(self):
        r = await self.client.post("/api/image-edit/layers", json={"ref": self.source, "layers": [{"ref": self.source, "opacity": .5}]})
        self.assertEqual(r.status, 200)
        result = editor.load(self.root, (await r.json())["ref"])
        self.assertEqual(result.getpixel((0, 0))[3], 128)
        r = await self.client.post("/api/image-edit/selection-cutout", json={"ref": self.source, "mask": self.mask})
        self.assertEqual(r.status, 200)
        result = editor.load(self.root, (await r.json())["ref"])
        self.assertEqual(result.getpixel((0, 0))[3], 0)

    async def test_native_request_and_phase_relay(self):
        captured = []
        generated = editor.save(self.root, Image.new("RGB", (256, 192), "lime"))
        backend = web.Application()
        async def submit(req):
            captured.append(await req.json())
            return web.json_response({"id": "enative123456"})
        async def jobs(req):
            return web.json_response({"enative123456": {"state": "done", "out": str(editor.ref_path(self.root, generated["ref"]))}})
        backend.router.add_post("/jobs", submit); backend.router.add_get("/jobs", jobs)
        async with TestServer(backend) as stub:
            with patch.object(server, "ENGINE", str(stub.make_url("")).rstrip("/")):
                r = await self.client.post("/api/image-edit/generate", json={**self.payload(), "prompt": "a green roof", "backend": "native", "seed": 77})
                self.assertEqual(r.status, 200, await r.text())
                jid = (await r.json())["ids"][0]
                for _ in range(100):
                    if server.JOBS[jid]["state"] in ("done", "error"): break
                    await asyncio.sleep(.01)
                self.assertEqual(server.JOBS[jid]["state"], "done", server.JOBS[jid].get("error"))
                self.assertEqual(captured[0]["kind"], "inpaint")
                self.assertEqual(captured[0]["seed"], 77)
                self.assertTrue(Path(captured[0]["mask"]).is_file())
                output = server.JOBS[jid]["outputs"][0]
                self.assertEqual(output["extra"]["edit"]["recipe"]["seed"], 77)
                self.assertEqual(editor.load(self.root, output["ref"]).getpixel((0, 0)), (80, 120, 140, 255))

    async def test_engine_and_comfy_complete_with_region_protection(self):
        generated = editor.save(self.root, Image.new("RGB", (256, 192), "lime"))
        generated_path = editor.ref_path(self.root, generated["ref"])
        backend = web.Application()
        backend.router.add_post("/jobs", lambda r: web.json_response({"id": "e123456789abc"}))
        backend.router.add_get("/jobs", lambda r: web.json_response({"e123456789abc": {"state": "done", "out": str(generated_path)}}))
        backend.router.add_post("/prompt", lambda r: web.json_response({"prompt_id": "comfy-test"}))
        backend.router.add_get("/history/comfy-test", lambda r: web.json_response({"comfy-test": {"outputs": {"save": {"images": [{"filename": generated_path.name, "subfolder": "h3studio", "type": "output"}]}}}}))
        async with TestServer(backend) as stub:
            for engine, expected_id in ((True, "e123456789abc"), (False, "comfy-test")):
                with self.subTest(engine=engine), patch.object(server.providers, "primary", return_value=None), \
                     patch.object(server, "ENGINE", str(stub.make_url("")).rstrip("/")), \
                     patch.object(server, "COMFY", str(stub.make_url("")).rstrip("/")), \
                     patch.object(server, "engine_up", return_value=engine), \
                     patch.object(server, "graph_image", return_value=({}, {"mode_name": "image", "seed": 42})):
                    r = await self.client.post("/api/image-edit/generate", json=self.payload())
                    self.assertEqual(r.status, 200, await r.text())
                    jid = (await r.json())["ids"][0]
                    self.assertEqual(jid, expected_id)
                    if not engine:
                        await server.finish(self.client.app, jid)
                    for _ in range(100):
                        if server.JOBS[jid]["state"] in ("done", "error"):
                            break
                        await asyncio.sleep(.01)
                    j = server.JOBS[jid]
                    self.assertEqual(j["state"], "done", j.get("error"))
                    result = editor.load(self.root, j["outputs"][0]["ref"])
                    self.assertEqual(result.getpixel((0, 0)), (80, 120, 140, 255))
                    self.assertEqual(result.getpixel((70, 70)), (0, 255, 0, 255))


if __name__ == "__main__":
    unittest.main()
