"""Save and recover asset versions, default views, and links."""

from unittest.mock import patch
import io
import json

from PIL import Image
from aiohttp import FormData, web

from oneshot.editing import image_editor
from oneshot.generation import requests as generation_requests
import server

from memory_fixture import MemoryFixture


class MemoryAssetVersions(MemoryFixture):
    async def test_upload_and_generated_sources_preserve_default(self):
        raw = io.BytesIO(); Image.new('RGB', (48, 64), 'blue').save(raw, 'PNG')
        form = FormData(); form.add_field('file', raw.getvalue(), filename='person.png', content_type='image/png')
        r = await self.client.post('/api/upload', data=form)
        self.assertEqual(r.status, 200, await r.text()); upload = await r.json()
        a = await self.create(ref=upload['ref'], node_id=None, source_board='')
        self.assertEqual(a['media'][0]['source'], 'upload')
        p = {**a, 'ref': self.source['ref'], 'source_board': 'test', 'node_id': 'n1'}
        r = await self.client.post('/api/memory', json=p)
        b = await r.json(); self.assertEqual(r.status, 200, b)
        self.assertEqual(len(b['media']), 2)
        self.assertEqual(b['ref'], upload['ref'])
        r = await self.client.post('/api/memory', json={**b, 'default_ref': self.source['ref']})
        self.assertEqual((await r.json())['ref'], self.source['ref'])
        r = await self.client.post('/api/memory', json={**a, 'name': 'stale'})
        self.assertEqual(r.status, 409)

    async def test_character_main_approval_controls_default_and_invalidates_old_angles(self):
        asset = await self.create()
        source = asset["ref"]
        other = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"))["ref"]
        third = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "green"))["ref"]
        board = self.load()
        board["nodes"][0]["versions"].extend([{"ref": other}, {"ref": third}])
        server.board_path("test").write_text(json.dumps(board))

        async def update(ref, slot, **fields):
            return await self.client.post("/api/memory", json={
                "id": asset["id"], "ref": ref, "character_view": slot,
                "source_board": "test", **fields
            })

        self.assertEqual((await update(other, "face")).status, 400)
        response = await update(other, "main", character_card={"details": "戒指固定在本人左手"})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["default_ref"], other)
        response = await update(source, "face")
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result["character_views"], {"main": other, "face": source})
        payload = self.app["creative_memory"].prepare({"id": 7, "role": "member"}, {
            "kind": "image", "board": "test", "prompt": "@林森 正在读书"
        })
        self.assertEqual([item["ref"] for item in payload["images"]], [other])
        self.assertIn("戒指固定在本人左手", payload["prompt"])
        selected = {"kind":"video","board":"test","prompt":"@林森 回头","duration":5,
                    "images":[{"ref":third, "node_id":"n1"}],
                    "memory_views":[{"memory_id":asset["id"],"views":["main","face"]}]}
        payload = self.app["creative_memory"].prepare({"id":7,"role":"member"}, selected)
        self.assertEqual([(item["ref"],item["role"],item.get("memory_view")) for item in payload["images"]],
                         [(third,"frame",None),(other,"subject","main"),(source,"subject","face")])
        body, _ = server.engine_body(payload)
        self.assertEqual(len(body["keyframes"]),1)
        self.assertEqual(body["references"],[str(server.tools.ref_path(server.COMFY_DIR,ref)) for ref in (other,source)])
        face_token = "@{"+asset["id"]+"#face|同名素材}"
        handwritten = await self.client.post("/api/generate",json={"kind":"image","board":"test","prompt":"@林森#face"})
        self.assertEqual(handwritten.status,400,await handwritten.text())
        self.assertIn("选择已定稿视角",(await handwritten.json())["error"])
        with patch.object(generation_requests,"_generate_request",return_value=web.json_response({"ids":[]})):
            manual = await self.client.post("/api/generate",json={
                "kind":"video","board":"test","prompt":"慢慢回头","fields":{"people":face_token}})
        self.assertEqual(manual.status,200,await manual.text())
        applied = await manual.json()
        self.assertEqual(applied["memory_used"][0]["references"],[{"view":"face","ref":source}])
        self.assertEqual(applied["memory_context"]["memory_views"],[{"memory_id":asset["id"],"views":["face"]}])
        self.assertIn("林森",applied["memory_context"]["prompt"])
        self.assertNotIn("同名素材",applied["memory_context"]["prompt"])
        response = await update(third, "main")
        result = await response.json()
        self.assertEqual(result["character_views"], {"main": third})
        self.assertEqual(len(result["media"]), 3)
        stale = await self.client.post("/api/generate",json=selected)
        self.assertEqual(stale.status,400,await stale.text())
        self.assertIn("正面头肩尚未定稿",(await stale.json())["error"])

    async def test_deleted_asset_unlinks_board_and_can_be_saved_again(self):
        asset = await self.create()
        board = self.load()
        item = board["nodes"][0]
        item["data"]["asset"] = {"id": asset["id"], "kind": "character"}
        item["data"]["character_draft"] = {"asset": asset["id"], "slot": "main"}
        saved = await self.client.put("/api/board/test", json=board)
        self.assertEqual(saved.status, 200)
        board["rev"] = (await saved.json())["rev"]
        response = await self.client.delete("/api/memory/" + asset["id"])
        self.assertEqual(response.status, 200)
        loaded = await (await self.client.get("/api/board/test")).json()
        self.assertNotIn("asset", loaded["nodes"][0]["data"])
        self.assertNotIn("character_draft", loaded["nodes"][0]["data"])
        self.assertEqual(loaded["nodes"][0]["versions"][0]["ref"], item["versions"][0]["ref"])
        stale = await self.client.put("/api/board/test", json=board)
        self.assertEqual(stale.status, 200)
        self.assertNotIn("asset", self.load()["nodes"][0]["data"])
        recreated = await self.client.post("/api/library", json={
            "id": asset["id"], "recreate_deleted": True, "kind": "character",
            "name": asset["name"], "ref": asset["ref"], "source_board": "test", "node_id": item["id"]
        })
        self.assertEqual(recreated.status, 200, await recreated.text())
        replacement = await recreated.json()
        self.assertNotEqual(replacement["id"], asset["id"])
        self.assertEqual(replacement["board"], "test")

    async def test_character_result_is_visible_in_asset_library_after_job_recovery(self):
        asset = await self.create()
        result = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "green"))["ref"]
        job_id = "character-test"
        async def submit(req, payload):
            from oneshot.storage.db import task_start, task_update
            task_start(id=job_id, user_id=7, board_id="test", capability="image")
            task_update(job_id, state="done", outputs=[result])
            server.JOBS[job_id] = {"id": job_id, "state": "done", "outputs": [{"ref": result}]}
            return web.json_response({"ids": [job_id]})

        with patch.object(generation_requests, "_generate_request", submit):
            response = await self.client.post("/api/generate", json={
                "kind": "image", "board": "test", "prompt": "按 @图1 生成角色主图",
                "images": [{"ref": asset["ref"]}], "character_draft": {"asset": asset["id"], "slot": "main"}
            })
        self.assertEqual(response.status, 200, await response.text())
        server.JOBS.pop(job_id)
        listing = await (await self.client.get("/api/memory?board=test")).json()
        self.assertEqual(listing[0]["character_drafts"]["main"]["ref"], result)
        self.assertEqual(listing[0]["default_ref"], asset["ref"])
        detail = await (await self.client.get("/api/memory/" + asset["id"] + "?board=test")).json()
        self.assertEqual(detail["history"][0]["ref"], result)
        response = await self.client.post("/api/memory", json={
            "id": asset["id"], "character_view": "main", "ref": result, "source_board": "test"
        })
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["default_ref"], result)
