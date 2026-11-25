import asyncio
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from xml.etree.ElementTree import fromstring

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image, ImageChops, ImageDraw

import server
from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.editing import image_editor as editor
from oneshot.editing import image_routes
from oneshot.editing import image_upscale
from oneshot.generation import graphs
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import local as local_generation
from oneshot.memory import legacy_routes
from oneshot.web import media as media_routes


class EditAPI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patchers = [patch.object(server.db, "DB_PATH", self.root / "memory.db"), patch.object(server.db, "_conn", None), patch.object(legacy_routes, "LIBRARY", self.root / "library.json"), patch.object(config, "COMFY_DIR", self.root), patch.object(generation_jobs, "EDIT_JOBS", self.root / "jobs"),
                         patch.object(config, "DATA_DIR", self.root / "data"), patch.object(canvas_routes, "BOARDS", self.root / "boards"),
                         patch.object(server.db, "task_start"), patch.object(server.db, "task_update"), patch.object(generation_jobs, "record")]
        for p in self.patchers:
            p.start()
        server.JOBS.clear()
        self.source = editor.save(self.root, Image.new("RGBA", (256, 192), (80, 120, 140, 255)), kind="input")["ref"]
        mask = Image.new("L", (256, 192))
        ImageDraw.Draw(mask).rectangle((50, 50, 100, 100), fill=255)
        self.mask = editor.save(self.root, mask, kind="input")["ref"]

        @web.middleware
        async def user(req, handler):
            req["user"] = {"id": int(req.headers.get("X-Test-Uid", "7")),
                           "role": req.headers.get("X-Test-Role", "admin")}
            return await handler(req)

        app = web.Application(middlewares=[user, server.media_input_guard])
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

    async def test_openraster_download_keeps_editable_layers_and_matching_preview(self):
        top = editor.save(self.root, Image.new("RGBA", (9, 6), (170, 20, 60, 180)))["ref"]
        hidden = editor.save(self.root, Image.new("RGBA", (6, 6), (0, 255, 30, 255)))["ref"]
        name = "镜头 & 背景"
        payload = {"name":name,"ref":self.source,"layers":[
            {"name":"底图","ref":self.source},
            {"name":"预留 <绿色>","ref":hidden,"visible":False},
            {"name":"前景","ref":top,"x":-2,"y":4,"w":16,"h":12,"opacity":.5},
        ]}
        with patch.object(media_routes, "can_read_media", side_effect=lambda _user, ref: ref != hidden):
            denied = await self.client.post("/api/image-edit/openraster",json=payload,headers={"X-Test-Role":"user"})
        self.assertEqual(denied.status,403)
        response = await self.client.post("/api/image-edit/openraster",json=payload)
        self.assertEqual(response.status,200,await response.read() if response.status != 200 else "")
        self.assertEqual(response.content_type,"image/openraster")
        self.assertIn("filename*=UTF-8''",response.headers["Content-Disposition"])
        flattened = editor.compose_layers(self.root,payload)
        with zipfile.ZipFile(io.BytesIO(await response.read())) as archive:
            self.assertEqual((archive.infolist()[0].filename,archive.infolist()[0].compress_type),
                             ("mimetype",zipfile.ZIP_STORED))
            self.assertEqual(archive.read("mimetype"),b"image/openraster")
            document = fromstring(archive.read("stack.xml"))
            self.assertEqual((document.get("name"),document.get("w"),document.get("h")),(name,"256","192"))
            layers = document.findall("./stack/layer")
            self.assertEqual([layer.get("name") for layer in layers],["前景","预留 <绿色>","底图"])
            self.assertEqual([layers[0].get(key) for key in ("x","y","opacity")],["-2","4","0.5"])
            self.assertEqual(layers[1].get("visibility"),"hidden")
            with Image.open(archive.open(layers[0].get("src"))) as foreground:
                self.assertEqual(foreground.size,(16,12))
                expected = editor.load(self.root,top).resize((16,12),Image.Resampling.LANCZOS)
                self.assertEqual(foreground.tobytes(),expected.tobytes())
            with Image.open(archive.open("mergedimage.png")) as merged:
                self.assertEqual(merged.tobytes(),editor.load(self.root,flattened["ref"]).tobytes())
            with Image.open(archive.open("Thumbnails/thumbnail.png")) as thumbnail:
                self.assertLessEqual(max(thumbnail.size),256)

    async def test_openraster_upload_round_trips_the_layer_stack(self):
        source = editor.save(self.root,Image.new("RGBA",(32,24),(30,110,190,140)))["ref"]
        document = self.root / "layers.ora"
        payload = {"ref":self.source,"layers":[
            {"name":"背景","ref":self.source},
            {"name":"遮挡","ref":self.mask,"visible":False},
            {"name":"前景","ref":source,"x":-3,"y":4,"opacity":.4},
        ]}
        editor.export_openraster(self.root,payload,document)
        form = aiohttp.FormData()
        form.add_field("image",document.read_bytes(),filename="分层.ora",content_type="image/openraster")
        response = await self.client.post("/api/upload",data=form,headers={"X-Test-Role":"user"})
        self.assertEqual(response.status,200,await response.text())
        result = await response.json()
        self.assertEqual((result["w"],result["h"],result["type"]),(256,192,"image"))
        layers = result["layer_stack"]["layers"]
        self.assertEqual([layer["name"] for layer in layers],["背景","遮挡","前景"])
        self.assertEqual([layers[2][key] for key in ("x","y","opacity")],[-3,4,.4])
        self.assertFalse(layers[1]["visible"])
        self.assertEqual(editor.load(self.root,layers[2]["ref"]).tobytes(),editor.load(self.root,source).tobytes())
        self.assertEqual(editor.load(self.root,result["ref"]).tobytes(),
                         editor.load(self.root,editor.compose_layers(self.root,payload)["ref"]).tobytes())
        for ref in [result["ref"], *(layer["ref"] for layer in layers)]:
            peek = await self.client.get("/media",params={"ref":ref},headers={"X-Test-Role":"user"})
            self.assertEqual(peek.status,200)
            await peek.read()

    async def test_openraster_rejects_unsupported_layer_group_without_leaving_media(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data,"w") as archive:
            archive.writestr("mimetype","image/openraster")
            archive.writestr("stack.xml",'<image w="256" h="192"><stack><stack/>'
                             '<layer name="底图" src="data/base.png"/></stack></image>')
            archive.write(editor.ref_path(self.root,self.source),"data/base.png")
        previous = set(self.root.rglob("*.png"))
        form = aiohttp.FormData()
        form.add_field("image",data.getvalue(),filename="group.ora",content_type="image/openraster")
        response = await self.client.post("/api/upload",data=form)
        self.assertEqual(response.status,400)
        self.assertIn("独立图层",(await response.json())["error"])
        self.assertEqual(set(self.root.rglob("*.png")),previous)

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

        with patch.object(image_routes,"run_image_tool",segmentation):
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

    async def test_fill_background_replaces_subject_holes_and_preserves_transparency(self):
        original = Image.new("RGBA",(64,48))
        draw = ImageDraw.Draw(original)
        draw.rectangle((3,3,60,44),fill=(25,64,90,200))
        draw.rectangle((16,12,26,28),fill=(210,30,20,255))
        labels = Image.new("L", original.size)
        ImageDraw.Draw(labels).rectangle((16,12,26,28),fill=1)
        source = editor.save(self.root,original,kind="input")["ref"]
        label = editor.save(self.root,labels)["ref"]
        layers = editor.decompose(self.root,source,label)["layer_stack"]["layers"]
        background = layers[0]
        self.assertEqual(background["decomposition_bounds"],{"x":3,"y":3,"w":58,"h":42})
        params = {"ref":source,"background":background["ref"],"x":background["x"],"y":background["y"]}

        response = await self.client.post("/api/image-edit/fill-background",json=params)
        self.assertEqual(response.status,200,await response.text())
        filled = editor.load(self.root,(await response.json())["ref"])
        self.assertEqual(filled.getpixel((0,0)),(0,0,0,0))
        self.assertEqual(filled.getpixel((4,4)),original.getpixel((4,4)))
        for value, expected in zip(filled.getpixel((20,20)),(25,64,90,200)):
            self.assertAlmostEqual(value,expected,delta=4)
        self.assertEqual(editor.load(self.root,source).tobytes(),original.tobytes())

        response = await self.client.post("/api/image-edit/fill-background",json={**params,"x":-1})
        self.assertEqual(response.status,400)

    async def test_upscale_rejects_invalid_scale_and_reports_missing_models(self):
        url = "/api/image-edit/upscale"
        with patch.object(config, "IMAGE_UPSCALE_MODELS", self.root / "uninstalled"):
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
            version = {**result,"source":"edit","edit":{"source":path,"mode":"upscale","scale":scale,"model":"FSRCNN"}}
            board = {"nodes":[{"id":"n1","name":"图片","type":"image","cur":1,"versions":[{"ref":path},version]}],"edges":[]}
            report = server.workflow_review.build(board,"n1",2)
            current = next(row for row in report["steps"] if row["version"]==2)
            self.assertIn({"label":"智能放大","value":f"{scale}× · FSRCNN"},current["settings"])
            self.assertTrue(any(entry["ref"]==path and entry["version"]==1 for entry in current["inputs"]))
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
            with patch.object(config, "ENGINE", str(stub.make_url("")).rstrip("/")):
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
                     patch.object(config, "ENGINE", str(stub.make_url("")).rstrip("/")), \
                     patch.object(config, "COMFY", str(stub.make_url("")).rstrip("/")), \
                     patch.object(local_generation, "engine_up", return_value=engine), \
                     patch.object(graphs, "graph_image", return_value=({}, {"mode_name": "image", "seed": 42})):
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
