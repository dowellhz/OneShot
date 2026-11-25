"""Public canvas snapshot media access and revocation."""

import io

from PIL import Image
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from oneshot.editing import image_editor
from oneshot.web import auth
import server

from chat_fixture import ChatFixture


class CanvasSnapshots(ChatFixture):
    async def test_public_snapshot_is_frozen_scoped_and_revocable(self):
        board = "/api/board/test"
        guest = {"X-Uid":"8"}
        v = image_editor.save(server.COMFY_DIR, Image.new("RGB", (32,64), "blue"))
        server.grant_media({"id":7}, v["ref"])
        changed = self.load()
        changed["nodes"][0]["versions"].append(v)
        changed["nodes"][0].update(cur=1, data={"prompt":"内部生成参数", "asset":{"id":"internal"}})
        changed["nodes"][1]["data"].update(text="# 公开文案\n\n- 镜头说明", text_format="markdown", text_background="lilac")
        changed["edges"] = [{"from":"n2","to":"n1","role":"reference","source_ref":self.source["ref"]}]
        self.assertEqual((await self.client.put(board, json=changed)).status, 200)
        self.assertEqual((await self.client.put(board+"/snapshot", headers=guest)).status, 404)
        published = await self.client.put(board+"/snapshot")
        self.assertEqual(published.status, 201, await published.text())
        token = (await published.json())["token"]
        public = "/api/share/" + token
        page = await self.client.get("/share/"+token, headers=guest)
        self.assertEqual(page.status, 200)
        self.assertIn("no-referrer", page.headers["Referrer-Policy"])
        self.assertEqual((await (await self.client.put(board+"/snapshot")).json())["token"], token)
        current = self.load()
        current["nodes"][1]["data"].update(text="发布后的改动", text_background="sand")
        self.assertEqual((await self.client.put(board,json=current)).status, 200)
        response = await self.client.get(public, headers=guest)
        self.assertEqual(response.status, 200, await response.text())
        data = await response.json()
        self.assertEqual(data["nodes"][1]["text"], "# 公开文案\n\n- 镜头说明")
        self.assertEqual(data["nodes"][1]["text_format"], "markdown")
        self.assertEqual(data["nodes"][1]["text_background"], "lilac")
        self.assertEqual(data["nodes"][0]["media"], 0)
        self.assertNotIn("media", data)
        self.assertNotIn("data", data["nodes"][0])
        self.assertNotIn("source_ref", data["edges"][0])
        display = await self.client.get(public+"/media/0", headers=guest)
        self.assertEqual(display.status, 200)
        with Image.open(io.BytesIO(await display.read())) as image:
            self.assertEqual(image.getpixel((0,0))[:3], (0,0,255))
        self.assertEqual(display.headers["Cache-Control"],"no-store")
        self.assertEqual((await self.client.get(public+"/media/1", headers=guest)).status,404)
        self.assertEqual((await self.client.get("/media", params={"ref":v["ref"]},headers=guest)).status,404)

        copy = await self.client.post(public+"/copy", headers=guest, json={})
        self.assertEqual(copy.status, 201, await copy.text())
        bid = (await copy.json())["id"]
        repeated = await self.client.post(public+"/copy", headers=guest, json={})
        self.assertEqual((await repeated.json())["id"], bid)
        owned = await (await self.client.get("/api/board/"+bid, headers=guest)).json()
        self.assertEqual(owned["owner"],8)
        self.assertFalse(owned["shared"])
        self.assertEqual([item["ref"] for item in owned["nodes"][0]["versions"]],[v["ref"]])
        self.assertEqual(owned["nodes"][1]["data"],
                         {"text":"# 公开文案\n\n- 镜头说明","text_format":"markdown","text_background":"lilac"})

        self.assertEqual((await self.client.delete(board+"/snapshot")).status,200)
        for url in ("/share/"+token,public,public+"/media/0"):
            self.assertEqual((await self.client.get(url)).status,404)
        self.assertEqual((await self.client.post(public+"/copy",headers=guest,json={})).status,404)
        self.assertEqual((await self.client.get("/media",params={"ref":v["ref"]},headers=guest)).status,200)

    async def test_only_snapshot_reads_bypass_login(self):
        async def read(req):
            self.assertNotIn("user", req)
            return web.Response()
        token = "a"*43
        for path in ("/share/"+token, "/api/share/"+token, "/api/share/"+token+"/media/0"):
            self.assertEqual((await auth.middleware(make_mocked_request("GET",path), read)).status, 200)
        copy = make_mocked_request("POST","/api/share/"+token+"/copy")
        self.assertEqual((await auth.middleware(copy, read)).status,401)
