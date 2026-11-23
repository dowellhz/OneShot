"""Stage-two integration: masks are real, effects survive refresh, recipes retain their source."""
import asyncio
import base64
import copy
import io
import json
import time
from unittest.mock import AsyncMock, patch

from aiohttp import web
from PIL import Image, ImageDraw

import agent_editing as edit
import db
import image_editor
import server
from test_agent_chat import ChatFixture, answer, call


class EditingIntegration(ChatFixture):
    async def run_row(self):
        rid = await self.send()
        await self.wait(rid)
        row = db.one("SELECT * FROM chat_runs WHERE id=?", rid)
        row["data"] = json.loads(row["data"])
        return row

    def mask(self):
        mask = Image.new("L", (128, 96))
        ImageDraw.Draw(mask).rectangle((30, 20, 80, 70), fill=255)
        return mask

    def png_data(self, mask):
        buf = io.BytesIO()
        mask.save(buf, "PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    def foreground(self):
        rgba = Image.new("RGBA", (128, 96), "white")
        rgba.putalpha(self.mask())
        return image_editor.save(server.COMFY_DIR, rgba)

    async def test_image_camera_request_uses_structured_instructions_and_preserves_recipe(self):
        view = {"yaw":-90,"pitch":30,"distance":-35,"lens":24,"framing":"全景",
                "sensor":"s35","optics":"anamorphic","aperture":"2.8"}
        payload = {"ref":self.source["ref"],"mode":"whole","camera_view":view,"count":3,"prompt":""}

        async def generate(_req, raw):
            self.assertEqual(raw["count"],3)
            for instruction in ("90 degrees to the left", "look down 30 degrees", "closer to", "24 mm lens", "wide shot",
                                "Super 35", "oval bokeh", "f/2.8", "shallow depth of field"):
                self.assertIn(instruction,raw["prompt"])
            spec = raw["_image_edit"]
            self.assertEqual((spec["recipe"]["ref"],spec["recipe"]["camera_view"]),(payload["ref"],view))
            output = image_editor.composite(server.COMFY_DIR,spec,[self.source])[0]
            self.assertEqual(output["extra"]["edit"]["recipe"]["camera_view"],view)
            rows = server.workflow_review.argument_rows(output["extra"],{}, {})
            camera_row = next(row["value"] for row in rows if row["label"]=="图片机位")
            self.assertIn("24 mm",camera_row)
            self.assertIn("f/2.8",camera_row)
            return web.json_response({"ids":["camera-qa"]})

        url = "/api/image-edit/generate"
        with patch.object(server,"generate_request",side_effect=generate) as called:
            for invalid in ({"count":5},{"backend":"native"},{"strength":.5},
                            *({"camera_view":{**view,key:value}} for key,value in
                              (("yaw",181),("aperture","0.8"),("sensor","unknown"),("optics",[])))):
                self.assertEqual((await self.client.post(url,json={**payload,**invalid})).status,400)
            called.assert_not_awaited()
            response = await self.client.post(url,json=payload)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(await response.json(),{"ids":["camera-qa"]})

    async def fake_generation(self, req):
        payload = await req.json()
        self.generated.append(payload)
        raw = image_editor.prepare(server.COMFY_DIR, payload)
        spec = raw["_image_edit"]
        bounds = spec["bounds"]
        green = image_editor.save(server.COMFY_DIR, Image.new("RGBA", (bounds[2] - bounds[0], bounds[3] - bounds[1]), "lime"))
        outputs = image_editor.composite(server.COMFY_DIR, spec, [green])
        jid = "e" + str(len(self.generated)).zfill(12)
        server.JOBS[jid] = {"created": 1, "state": "done", "meta": {"uid": 7, "seed": 123}, "outputs": outputs}
        return web.json_response({"ids": [jid]})

    async def test_assistant_camera_uses_pinned_version_approval_and_reusable_optics(self):
        self.generated = []
        old = self.source["ref"]
        newer = image_editor.save(server.COMFY_DIR,Image.new("RGBA",(128,96),"navy"),"input")
        node = self.board["nodes"][0]
        node["versions"].append(newer)
        node["cur"] = 1
        server.write_board(server.board_path("test"),self.board)
        camera = {"yaw":-90,"pitch":20,"distance":0,"lens":85,"framing":"近景","sensor":"full-frame","aperture":"1.4"}
        self.svc.model.side_effect = [call("image_camera",{"node_id":"n1","camera_view":camera}),answer(),
                                      call("image_reuse",{"node_id":"n1","version_index":2}),answer()]
        session = f"/api/chat/sessions/{self.sid}"
        with patch.object(server,"image_edit_generate",side_effect=self.fake_generation) as generate:
            response = await self.client.post(session+"/messages",json={"text":"把旧版从左侧拍一张近景",
                "request_key":"assistant-camera-pin","generation_mode":"manual","selected":["n1"],
                "selected_versions":[{"node_id":"n1","ref":old}]})
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            for _ in range(120):
                state = await (await self.client.get(session)).json()
                if state["approvals"]:
                    break
                await asyncio.sleep(.01)
            approval, = state["approvals"]
            self.assertIn("85 mm",approval["plan"]["camera_summary"])
            self.assertIn("f/1.4",approval["plan"]["camera_summary"])
            generate.assert_not_awaited()
            approval_url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(approval_url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.wait(rid))["state"],"done")
            self.assertEqual(len(self.load()["nodes"][0]["versions"]),3)
            rid = await self.send("用刚才的镜头参数再生成",key="assistant-camera-reuse")
            self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertEqual([(req["ref"],req["camera_view"],req["prompt"]) for req in self.generated],
                         [(old,camera,""),(old,camera,"")])
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual(len(versions),4)
        for v in versions[-2:]:
            self.assertEqual(v["edit"]["recipe"]["camera_view"],camera)

    async def test_assistant_relight_persists_and_reuses_structured_lighting(self):
        self.generated = []
        settings = {"x":70,"y":-55,"depth":-75,"key":55,"exposure":0,"temperature":-50,"rim":35}
        self.svc.model.side_effect = [call("image_relight",{"node_id":"n1","relight":settings}),answer(),
                                      call("image_reuse",{"node_id":"n1","version_index":1}),answer()]
        with patch.object(server,"image_edit_generate",side_effect=self.fake_generation):
            self.assertEqual((await self.wait(await self.send("用冷色背光重新布光")))["state"],"done")
            self.assertEqual((await self.wait(await self.send("用同样参数再来一版",key="relight-reuse")))["state"],"done")
        self.assertEqual([(req["ref"],req["relight"],req["prompt"]) for req in self.generated],
                         [(self.source["ref"],settings,"")]*2)
        prepared = image_editor.prepare(server.COMFY_DIR,self.generated[0])
        self.assertIn("right, above and behind the subject",prepared["prompt"])
        self.assertIn("7550 K",prepared["prompt"])
        self.assertIn("Do not add lettering",prepared["prompt"])
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual(len(versions),3)
        self.assertEqual(versions[-1]["edit"]["recipe"]["relight"],settings)
        rows = server.workflow_review.argument_rows(versions[-1],{}, {})
        self.assertIn("7550 K",next(row["value"] for row in rows if row["label"]=="图片布光"))
        with self.assertRaisesRegex(ValueError,"需要使用整图编辑"):
            image_editor.prepare(server.COMFY_DIR,{**self.generated[0],"mode":"region"})

    async def test_completed_image_edit_restores_recipe_and_layer_after_job_cache_loss(self):
        raw = image_editor.prepare(server.COMFY_DIR,{"ref":self.source["ref"],"mode":"whole",
                                  "relight":{"depth":-75,"temperature":-50},"seed":42})
        jid = "e123456789abc"
        db.task_start(id=jid,user_id=7,board_id="test",capability="image",state="running")
        job = {"id":jid,"kind":"image","state":"running","created":time.time(),"meta":{
            "uid":7,"seed":42,"mode_name":"图片重新布光","image_edit":raw["_image_edit"]}}
        await server.complete_outputs(job,[self.source])
        self.assertEqual(job["state"],"done",job.get("error"))
        output, = job["outputs"]
        denied = await self.client.get("/api/jobs",params={"ids":jid},headers={"X-Uid":"8"})
        self.assertEqual(await denied.json(),{})
        response = await self.client.get("/api/jobs",params={"ids":jid})
        self.assertEqual(response.status,200,await response.text())
        restored = (await response.json())[jid]
        self.assertEqual(restored["outputs"][0]["extra"],output["extra"])
        self.assertEqual((restored["meta"]["seed"],restored["meta"]["mode_name"]),(42,"图片重新布光"))
        history = "/api/generation-history?kind=image"
        item, = (await (await self.client.get(history)).json())["items"]
        edit = output["extra"]["edit"]
        self.assertEqual(item["image_edit"],edit)
        self.assertEqual((item["source"],item["width"],item["height"]),("edit",128,96))
        for ref in (edit["base"],edit["layer"]["ref"]):
            self.assertEqual((await self.client.get("/media",params={"ref":ref})).status,200)
            self.assertEqual((await self.client.get("/media",params={"ref":ref},headers={"X-Uid":"8"})).status,404)
        without_source = self.load()
        without_source["nodes"] = []
        server.write_board(server.board_path("test"),without_source)
        item, = (await (await self.client.get(history)).json())["items"]
        self.assertTrue(item["available"])
        self.assertTrue(item["image_edit_unavailable"])
        self.assertNotIn("image_edit",item)
        self.assertEqual((await self.client.get("/media",params={"ref":edit["base"]})).status,404)

    async def wait_input(self, rid):
        for _ in range(100):
            r = await self.client.get(f"/api/chat/sessions/{self.sid}")
            data = await r.json()
            if data["inputs"]:
                return data["inputs"][0]
            await asyncio.sleep(.01)
        self.fail("no manual input request")

    async def test_automatic_background_edit_preserves_foreground(self):
        self.generated = []
        self.svc.model.side_effect = [call("image_edit", {"node_id": "n1", "prompt": "green background", "target": "background", "backend": "native", "feather": 0}), answer()]
        with patch.object(server, "image_edit_tool", AsyncMock(return_value=web.json_response(self.foreground()))), patch.object(server, "image_edit_generate", side_effect=self.fake_generation):
            rid = await self.send()
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(self.generated[0]["mode"], "region")
        self.assertEqual(self.generated[0]["backend"], "native")
        b = self.load()
        self.assertEqual(len(b["nodes"]), 2)
        self.assertEqual(len(b["nodes"][0]["versions"]), 2)
        self.assertEqual(b["nodes"][0]["cur"], 1)
        source = image_editor.load(server.COMFY_DIR, self.source["ref"])
        result = image_editor.load(server.COMFY_DIR, b["nodes"][0]["versions"][-1]["ref"])
        for y in range(20, 71):
            for x in range(30, 81):
                self.assertEqual(result.getpixel((x, y)), source.getpixel((x, y)))
        self.assertNotEqual(result.getpixel((0, 0)), source.getpixel((0, 0)))
        self.assertEqual(len(edit.selections(self.sid)), 1)

    async def test_selection_cross_turn_reuse_and_wrong_source_rejection(self):
        run = await self.run_row()
        saved = edit.persist_selection(self.svc, run, "n1", self.source["ref"], self.mask(), "manual")
        self.generated = []
        self.svc.model.side_effect = [call("image_edit", {"node_id": "n1", "prompt": "green", "selection_id": saved["selection_id"], "target": "selection"}), answer()]
        with patch.object(server, "image_edit_generate", side_effect=self.fake_generation):
            rid = await self.send("继续修改同一选区", "request002")
            await self.wait(rid)
        self.assertEqual(self.generated[0]["mask"], saved["mask_ref"])
        with self.assertRaises(ValueError):
            edit.lookup(self.svc, run, "n1", "input:h3studio/other.png", saved["selection_id"])
        foreign = {**run, "session_id": "another-session"}
        with self.assertRaises(ValueError):
            edit.lookup(self.svc, foreign, "n1", self.source["ref"], saved["selection_id"])

    async def test_attach_mask_pins_the_source_even_after_switching_versions(self):
        endpoint = f"/api/chat/sessions/{self.sid}/selection"
        payload = {"node_id": "n1", "source_ref": self.source["ref"], "mask_data": self.png_data(self.mask())}
        self.assertEqual((await self.client.post(endpoint, json=payload, headers={"X-Uid": "8"})).status, 404)
        self.assertEqual((await self.client.post(endpoint, json={**payload, "mask_data": self.png_data(Image.new("L", (128, 96)))})).status, 400)
        response = await self.client.post(endpoint, json=payload)
        self.assertEqual(response.status, 200, await response.text())
        selection = await response.json()
        self.assertEqual((await self.client.get("/media", params={"ref": selection["preview_ref"]})).status, 200)

        board = self.load()
        board["nodes"][0]["versions"].append(self.foreground())
        board["nodes"][0]["cur"] = 1
        server.board_path("test").write_text(json.dumps(board))
        message = {"text": "只改圈选区域", "request_key": "edit-draft", "selected": ["n1"], "selection_id": selection["selection_id"]}
        now = time.time()
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)", "other", 7, "test", "其他对话", now, now)
        self.assertEqual((await self.client.post("/api/chat/sessions/other/messages", json=message)).status, 400)

        self.generated = []
        self.svc.model.side_effect = [call("image_edit", {"node_id": "n1", "prompt": "green", "feather": 0}), answer()]
        with patch.object(server, "image_edit_generate", side_effect=self.fake_generation):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json=message)
            self.assertEqual(response.status, 200, await response.text())
            run = await self.wait((await response.json())["id"])
        self.assertEqual(run["state"], "done")
        self.assertEqual(self.generated[0]["ref"], self.source["ref"])
        self.assertEqual(self.generated[0]["mask"], selection["mask_ref"])
        self.assertEqual(self.generated[0]["mode"], "region")
        result = image_editor.load(server.COMFY_DIR, self.load()["nodes"][0]["versions"][-1]["ref"])
        self.assertEqual(result.getpixel((0, 0)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((40, 40)), (0, 255, 0, 255))

    async def test_region_review_edits_are_masked_and_keep_the_original_version(self):
        comments = "/api/board/test/comments"
        original = self.source["ref"]
        boxes = [[.25,.25,.5,.5],[.625,.5,.875,.75]]
        ids = []
        for i,box in enumerate(boxes):
            response = await self.client.post(comments,json={"body":f"区域 {i+1} 调成绿色",
                "anchor":{"node":"n1","ref":original,"box":box},"request_key":f"image-region-review-{i}"})
            self.assertEqual(response.status,201,await response.text())
            ids.append((await response.json())["id"])
        invalid = await self.client.post(comments,json={"body":"反向区域","request_key":"invalid-image-region",
            "anchor":{"node":"n1","ref":original,"box":[.8,.2,.1,.9]}})
        self.assertEqual(invalid.status,400)
        board = self.load()
        board["nodes"][0]["versions"].append(self.foreground())
        board["nodes"][0]["cur"] = 1
        server.board_path("test").write_text(json.dumps(board))
        self.generated = []
        self.svc.model.side_effect = [
            call("image_edit",{"node_id":"n1","prompt":"绿色","feather":0}),
            call("image_edit",{"node_id":"n1","review_id":ids[1],"prompt":"只改第二处","feather":0},"one-review"),
            answer()]
        with patch.object(server,"image_edit_generate",side_effect=self.fake_generation):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json={
                "text":"按区域批注修改","review_ids":ids,"request_key":"apply-image-review-regions"})
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual((await self.wait((await response.json())["id"]))["state"],"done")
        self.assertEqual([(r["ref"],r["mode"]) for r in self.generated],[(original,"region")]*2)
        masks = [image_editor.load(server.COMFY_DIR,r["mask"]).convert("L") for r in self.generated]
        self.assertEqual([m.getpixel((40,30)) for m in masks],[255,0])
        self.assertEqual([m.getpixel((96,60)) for m in masks],[255,255])
        self.assertEqual([m.getpixel((70,40)) for m in masks],[0,0])
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual(len(versions),4)
        last = image_editor.load(server.COMFY_DIR,versions[-1]["ref"])
        self.assertEqual(last.getpixel((40,30)),(255,0,0,255))
        self.assertEqual(last.getpixel((96,60)),(0,255,0,255))

    async def test_manual_input_blocks_generation_then_continues_and_is_idempotent(self):
        self.generated = []
        async def model(messages, run):
            tool_results = [m for m in messages if m["role"] == "tool"]
            if not tool_results:
                return call("image_select", {"node_id": "n1", "mode": "manual", "instruction": "画出屋顶"})
            if len(tool_results) == 1:
                selection = json.loads(tool_results[0]["content"])
                return call("image_edit", {"node_id": "n1", "prompt": "blue roof", "target": "selection", "selection_id": selection["selection_id"]}, "edit")
            return answer()
        self.svc.model.side_effect = model
        with patch.object(server, "image_edit_generate", side_effect=self.fake_generation):
            rid = await self.send()
            pending = await self.wait_input(rid)
            self.assertEqual(db.one("SELECT state FROM chat_runs WHERE id=?", rid)["state"], "waiting_input")
            self.assertFalse(self.generated)
            endpoint = f"/api/chat/runs/{rid}/selection"
            self.assertEqual((await self.client.post(endpoint, json={"call_id": pending["call_id"], "mask_data": self.png_data(self.mask())}, headers={"X-Uid": "8"})).status, 404)
            self.assertEqual((await self.client.post(endpoint, json={"call_id": pending["call_id"], "mask_data": self.png_data(Image.new('L', (1, 1)))})).status, 400)
            payload = {"call_id": pending["call_id"], "mask_data": self.png_data(self.mask())}
            first = await self.client.post(endpoint, json=payload)
            self.assertEqual(first.status, 200, await first.text())
            first = await first.json()
            second = await (await self.client.post(endpoint, json=payload)).json()
            self.assertEqual(first["selection_id"], second["selection_id"])
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(len(self.generated), 1)
        mask = image_editor.load(server.COMFY_DIR, self.generated[0]["mask"]).convert("L")
        self.assertEqual(mask.getpixel((0, 0)), 0)
        self.assertEqual(mask.getpixel((40, 40)), 255)

    async def test_manual_input_survives_worker_restart(self):
        self.svc.model.side_effect = [call("image_select", {"node_id": "n1", "mode": "manual"}), answer()]
        rid = await self.send()
        pending = await self.wait_input(rid)
        self.svc.closing = True
        task = self.svc.tasks[rid]
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)
        self.svc.closing = False
        self.svc.launch(rid)
        await asyncio.sleep(.01)
        data = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
        self.assertEqual(data["inputs"][0]["call_id"], pending["call_id"])
        r = await self.client.post(f"/api/chat/runs/{rid}/selection", json={"call_id": pending["call_id"], "mask_data": self.png_data(self.mask())})
        self.assertEqual(r.status, 200)
        self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(db.one("SELECT COUNT(*) n FROM chat_calls WHERE run_id=?", rid)["n"], 1)

    async def test_manual_cancel_does_not_continue(self):
        self.svc.model.return_value = call("image_select", {"node_id": "n1", "mode": "manual"})
        rid = await self.send()
        pending = await self.wait_input(rid)
        await self.client.post(f"/api/chat/runs/{rid}/stop", json={})
        self.assertEqual((await self.wait(rid))["state"], "stopped")
        self.assertEqual((await self.client.post(f"/api/chat/runs/{rid}/selection", json={"call_id": pending["call_id"], "mask_data": self.png_data(self.mask())})).status, 409)
        self.assertEqual(len(self.load()["nodes"]), 2)

    async def edited_version(self):
        mask = image_editor.save(server.COMFY_DIR, self.mask(), "mask", "input")
        raw = image_editor.prepare(server.COMFY_DIR, {"ref": self.source["ref"], "mask": mask["ref"], "mode": "region", "prompt": "blue", "feather": 0, "seed": 42})
        generated = image_editor.save(server.COMFY_DIR, Image.new("RGBA", (128, 96), "blue"))
        output = image_editor.composite(server.COMFY_DIR, raw["_image_edit"], [generated])[0]
        version = {"ref": output["ref"], "url": output["url"], "w": 128, "h": 96, **output["extra"]}
        b = self.load()
        b["nodes"][0]["versions"].append(version)
        b["nodes"][0]["cur"] = 1
        server.board_path("test").write_text(json.dumps(b))
        return version

    async def test_layers_use_canonical_base_and_zero_opacity_restores_original(self):
        version = await self.edited_version()
        run = await self.run_row()
        stack = await self.svc.execute(run, {"id": 7, "role": "member"}, "get-layers", "image_layers_get", {"node_id": "n1"})
        self.assertEqual([l["id"] for l in stack["layers"]], ["base", "generated"])
        self.assertEqual(stack["base_ref"], version["edit"]["base"])
        result = await self.svc.execute(run, {"id": 7, "role": "member"}, "change-layers", "image_layers_edit", {"node_id": "n1", "changes": [{"layer_id": "generated", "opacity": 0}]})
        node = next(n for n in self.load()["nodes"] if n["id"] == result["nodes"][0]["id"])
        output = image_editor.load(server.COMFY_DIR, node["versions"][-1]["ref"])
        original = image_editor.load(server.COMFY_DIR, self.source["ref"])
        self.assertEqual(output.tobytes(), original.tobytes())
        self.assertEqual(node["versions"][-1]["layer_stack"]["layers"][1]["opacity"], 0)
        self.assertEqual(self.load()["nodes"][0]["versions"][1], version)

    async def test_layer_import_position_visibility_and_undo(self):
        run = await self.run_row()
        b = self.load()
        blue = image_editor.save(server.COMFY_DIR, Image.new("RGBA", (20, 20), "blue"))
        b["nodes"].append({"id": "n3", "type": "image", "name": "blue", "x": 900, "y": 0, "data": {}, "versions": [blue], "cur": 0})
        server.board_path("test").write_text(json.dumps(b))
        result = await self.svc.execute(run, {"id": 7, "role": "member"}, "import-layer", "image_layers_edit", {"node_id": "n1", "add": [{"node_id": "n3", "x": 10, "y": 15, "w": 20, "h": 20}]})
        v = next(n for n in self.load()["nodes"] if n["id"] == result["nodes"][0]["id"])["versions"][-1]
        im = image_editor.load(server.COMFY_DIR, v["ref"])
        self.assertEqual(im.getpixel((15, 20)), (0, 0, 255, 255))
        self.assertEqual(im.getpixel((0, 0)), (255, 0, 0, 255))
        undone = await self.client.post(f"/api/chat/runs/{run['id']}/undo", json={})
        self.assertEqual(undone.status, 200)
        self.assertEqual(len(self.load()["nodes"]), 3)

    async def test_extract_generated_patch_is_transparent_and_recipe_uses_original(self):
        version = await self.edited_version()
        run = await self.run_row()
        result = await self.svc.execute(run, {"id": 7, "role": "member"}, "extract", "image_extract", {"node_id": "n1", "kind": "generated"})
        patch_version = next(n for n in self.load()["nodes"] if n["id"] == result["nodes"][0]["id"])["versions"][-1]
        im = image_editor.load(server.COMFY_DIR, patch_version["ref"])
        self.assertEqual(im.getpixel((0, 0))[3], 0)
        self.generated = []
        with patch.object(server, "image_edit_generate", side_effect=self.fake_generation):
            await self.svc.execute(run, {"id": 7, "role": "member"}, "reuse", "image_reuse", {"node_id": "n1", "prompt": "green", "seed": 73})
        self.assertEqual(self.generated[0]["ref"], self.source["ref"])
        self.assertEqual(self.generated[0]["mask"], version["edit"]["recipe"]["mask"])
        self.assertEqual(self.generated[0]["seed"], 73)
        self.assertNotEqual(self.generated[0]["ref"], version["ref"])
        history = await self.svc.execute(run, {"id": 7, "role": "member"}, "history", "image_history", {"node_id": "n1"})
        self.assertEqual(history["versions"][1]["recipe"]["seed"], 42)

    async def test_sequential_modifications_share_node_and_undo_preserves_links(self):
        b = self.load()
        b["edges"] = [{"from": "n2", "to": "n1"}]
        server.board_path("test").write_text(json.dumps(b))
        self.svc.model.side_effect = [call("image_transform", {"node_id": "n1", "rotate": 90}),
                                     call("image_transform", {"node_id": "n1", "rotate": 90}, "second"), answer()]
        rid = await self.send("先旋转，再继续旋转同一张图")
        self.assertEqual((await self.wait(rid))["state"], "done")
        final = self.load(); n = final["nodes"][0]
        self.assertEqual(len(final["nodes"]), 2)
        self.assertEqual(len(n["versions"]), 3)
        self.assertEqual(n["cur"], 2)
        self.assertEqual((n["name"], n["x"], n["y"]), ("产品", 30, 40))
        self.assertEqual(final["edges"], b["edges"])
        self.assertEqual(n["versions"][2]["agent_source"], n["versions"][1]["ref"])
        self.assertEqual((n["versions"][2]["w"], n["versions"][2]["h"]), (128, 96))
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["nodes"], b["nodes"])
        self.assertEqual(self.load()["edges"], b["edges"])

    async def test_agent_resizes_the_pinned_image_in_the_same_node(self):
        size = {"width":200,"height":280,"fit":"contain"}
        self.svc.model.side_effect = [call("image_transform", {"node_id":"n1","resize":size}), answer()]
        rid = await self.send("保持比例，将图片改成 200×280 并用透明补边")
        self.assertEqual((await self.wait(rid))["state"],"done")
        final = self.load()
        self.assertEqual(len(final["nodes"]),2)
        original, result = final["nodes"][0]["versions"]
        self.assertEqual(original["ref"],self.source["ref"])
        self.assertEqual((result["w"],result["h"]),(200,280))
        self.assertEqual(result["edit"],{"source":original["ref"],"mode":"local","resize":size})

    async def test_compare_references_and_invalid_layer_are_safe(self):
        version = await self.edited_version()
        run = await self.run_row()
        compared = await self.svc.execute(run, {"id": 7, "role": "member"}, "compare", "image_compare", {"node_id": "n1"})
        self.assertEqual(compared["before_ref"], self.source["ref"])
        self.assertEqual(compared["after_ref"], version["ref"])
        before = self.load()
        with self.assertRaises(ValueError):
            await self.svc.execute(run, {"id": 7, "role": "member"}, "bad-layer", "image_layers_edit", {"node_id": "n1", "changes": [{"layer_id": "missing", "opacity": .5}]})
        self.assertEqual(before, self.load())
