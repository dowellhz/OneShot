import io
import json
from unittest.mock import patch

from aiohttp import web
from PIL import Image

from oneshot.storage import db
import server
from oneshot.generation import requests as generation_requests
from chat_fixture import ChatFixture, answer, call


class GifExport(ChatFixture):
    def grid(self):
        source = Image.new("RGBA",(150,100))
        colors = ["red","green","blue","yellow","cyan","magenta"]
        for i,color in enumerate(colors):
            row, col = divmod(i,3)
            source.paste(color,(50*col+10,50*row+10,50*col+40,50*row+40))
        result = server.image_editor.save(server.COMFY_DIR,source,"gif-grid","input")
        server.grant_media({"id":7},result["ref"])
        return result

    async def test_grid_range_order_ping_pong_and_transparency(self):
        ref = self.grid()["ref"]
        params = {"ref":ref,"rows":2,"cols":3,"first":2,"last":5,"ping_pong":True}
        denied = await self.client.post("/api/image/gif",json=params,headers={"X-Uid":"8"})
        self.assertEqual(denied.status,403)
        for extra in ({"rows":True},{"cols":7},{"last":1},{"last":7},{"first":5}):
            invalid = await self.client.post("/api/image/gif",json={**params,**extra})
            self.assertEqual(invalid.status,400,await invalid.text())
        response = await self.client.post("/api/image/gif",json=params)
        self.assertEqual(response.status,200,await response.text())
        result = await response.json()
        self.assertEqual((result["width"],result["height"],result["seconds"]),(48,48,.75))
        gif_response = await self.client.get(result["url"])
        self.assertEqual((gif_response.status,gif_response.content_type),(200,"image/gif"))
        expected = [(0,128,0),(0,0,255),(255,255,0),(0,255,255),(255,255,0),(0,0,255)]
        with Image.open(io.BytesIO(await gif_response.read())) as gif:
            self.assertEqual(gif.n_frames,len(expected))
            self.assertEqual(gif.info["loop"],0)
            for index,color in enumerate(expected):
                gif.seek(index)
                frame = gif.convert("RGBA")
                self.assertEqual(frame.getpixel((20,20)),(*color,255))
                self.assertEqual(frame.getpixel((2,2))[3],0)

    def video(self, color=None):
        path, ref = server.film._new(server.COMFY_DIR, "input", "gif-source", ".mp4")
        colors = ["red","green","blue","yellow","cyan","magenta","white","black"]
        frames = (Image.new("RGB", (64, 48), color or colors[i % len(colors)]) for i in range(16))
        server.film.encode_silent(path, frames, 64, 48, 8, lambda:False, lambda _:None)
        return {"ref":ref,"w":64,"h":48,"seconds":2}

    async def test_gif_interval_encoding_loop_and_media_permission(self):
        ref = self.video()["ref"]
        server.grant_media({"id":7}, ref)
        params = {"ref":ref,"start":.25,"end":1.25,"fps":8,"size":256,"ping_pong":True}
        response = await self.client.post("/api/video/gif", json=params, headers={"X-Uid":"8"})
        self.assertEqual(response.status, 403, await response.text())
        response = await self.client.post("/api/video/gif", json=params)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual((result["width"],result["height"],result["seconds"]), (64,48,1.75))
        download = await self.client.get(result["url"])
        self.assertEqual((download.status,download.content_type), (200,"image/gif"))
        binary = await download.read()
        self.assertEqual(result["size_bytes"], len(binary))
        with Image.open(io.BytesIO(binary)) as gif:
            self.assertEqual((gif.info["loop"],gif.n_frames), (0,14))
            palette, delays = [], []
            for i in range(gif.n_frames):
                gif.seek(i)
                palette.append(gif.convert("RGB").getpixel((12,12)))
                delays.append(gif.info["duration"])
            self.assertEqual(palette[8:], palette[6:0:-1])
            red, green, blue = palette[0]
            self.assertGreater(blue, max(red,green)+100)
            self.assertEqual(sum(delays), 1750)
        denied = await self.client.get(result["url"],headers={"X-Uid":"8"})
        self.assertEqual(denied.status, 404)
        for invalid in ({"end":3}, {"start":.9,"end":1}, {"fps":True}, {"size":4096},
                        {"ping_pong":"true"}, {"start":10**350}):
            response = await self.client.post("/api/video/gif",json={**params,**invalid})
            self.assertEqual(response.status,400,await response.text())

    async def test_assistant_exports_explicit_historical_version_without_editing_the_board(self):
        older = self.video("red")
        current = self.video("blue")
        self.board["nodes"].append({"id":"n3","type":"video","name":"试拍","data":{},"x":100,"y":100,
                                    "versions":[older,current],"cur":1})
        file = server.board_path("test")
        server.write_board(file,self.board)
        baseline = file.read_text()
        self.svc.model.side_effect = [call("video_export_gif",{"node_id":"n3","version":1,"end":.5}),answer()]
        rid = await self.send("把视频第一版的前半秒导出 GIF", selected=["n3"])
        self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        row = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='video_export_gif'",rid)
        result = json.loads(row["result"])
        self.assertIn("版本 1",result["text"])
        self.assertEqual(file.read_text(),baseline)
        response = await self.client.get(result["gif"]["url"])
        self.assertEqual(response.status,200)
        with Image.open(io.BytesIO(await response.read())) as gif:
            red, green, blue = gif.convert("RGB").getpixel((12,12))
            self.assertGreater(red,max(green,blue)+100)

    async def test_assistant_can_generate_from_a_reference_image_then_export_its_result(self):
        video = self.video()
        generation = []

        async def submit(_req, payload):
            generation.append(payload)
            job = "e123456789020"
            server.JOBS[job] = {"state":"done","created":1,"meta":{"uid":7},
                                "outputs":[{"ref":video["ref"],"meta":{"width":64,"height":48,"duration":2}}]}
            return web.json_response({"ids":[job]})

        async def model(messages, _run):
            if messages[-1]["role"] != "tool":
                return call("video_generate", {"prompt":"纸折动物抬头后回到原位","duration":5,
                                               "frames":[{"node_id":"n1","role":"first"}]})
            result = json.loads(messages[-1]["content"])
            if result.get("nodes"):
                target, = result["nodes"]
                return call("video_export_gif", {"node_id":target["id"],"end":1,"fps":8}, mid="step2")
            self.assertIn("gif",result)
            return answer()

        self.svc.model.side_effect = model
        with patch.object(generation_requests, "generate_request", side_effect=submit):
            rid = await self.send("用参考图生成循环动图")
            self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        self.assertEqual(len(generation),1)
        self.assertEqual(generation[0]["images"][0]["ref"],self.source["ref"])
        saved = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='video_export_gif'",rid)
        self.assertEqual(json.loads(saved["result"])["gif"]["seconds"],1)

    async def test_assistant_can_generate_a_grid_then_export_it(self):
        grid = self.grid()
        generation = []

        async def submit(_req, payload):
            generation.append(payload)
            job = "x123456789022"
            server.JOBS[job] = {"state":"done","created":1,"meta":{"uid":7},
                                "outputs":[{"ref":grid["ref"],"meta":{"width":150,"height":100}}]}
            return web.json_response({"ids":[job]})

        async def model(messages, _run):
            if messages[-1]["role"] != "tool":
                return call("image_generate", {"prompt":"两行三列的循环动作序列帧","reference_ids":["n1"]})
            result = json.loads(messages[-1]["content"])
            if result.get("nodes"):
                target, = result["nodes"]
                return call("image_export_gif",{"node_id":target["id"],"rows":2,"cols":3},mid="gif-grid")
            self.assertIn("gif",result)
            return answer()

        self.svc.model.side_effect = model
        with patch.object(generation_requests,"generate_request",side_effect=submit):
            rid = await self.send("用参考图做一个两行三列的循环动画")
            self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        self.assertEqual(len(generation),1)
        self.assertEqual(generation[0]["kind"],"image")
        self.assertEqual(generation[0]["images"][0]["ref"],self.source["ref"])
        saved = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='image_export_gif'",rid)
        self.assertEqual(json.loads(saved["result"])["gif"]["seconds"],.75)
