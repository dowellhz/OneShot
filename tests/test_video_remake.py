import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import av
from aiohttp import web
from PIL import Image

import db
import image_editor
import server


class Request(dict):
    def __init__(self, source, user, payload=None):
        super().__init__(user=user)
        self.query = {"source": source}
        self.match_info = {"board": "test", "node": "n3"}
        self.method = "POST" if payload else "GET"
        self.app = {"llm": object(), "creative_memory": server.creative_memory.Store(server)}
        self.payload = payload

    async def json(self):
        return self.payload


class VideoRemakeIntegration(IsolatedAsyncioTestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        root = Path(directory)
        self.enterContext(patch.object(db, "_conn", None))
        self.enterContext(patch.object(db, "DB_PATH", root / "remake.db"))
        self.enterContext(patch.object(server, "COMFY_DIR", root / "media"))
        self.enterContext(patch.object(server, "BOARDS", root / "boards"))
        self.enterContext(patch.object(server, "LIBRARY", root / "library.json"))
        self.addCleanup(db.conn().close)
        server.BOARDS.mkdir()
        self.user = {"id": 7, "role": "member"}
        self.source = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "red"), "asset", "input")

    async def test_shot_preview_uses_asset_reference_and_preserves_unselected_pixels(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "remake-test", ".mp4")
        with av.open(str(path), "w") as clip:
            stream = clip.add_stream("libx264", rate=6)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            for _ in range(12):
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), (40, 70, 100)))
                for packet in stream.encode(frame):
                    clip.mux(packet)
            for packet in stream.encode():
                clip.mux(packet)
        board = {"owner": 7, "nodes": [
            {"id": "n1", "type": "image", "versions": [self.source]},
            {"id": "n3", "type": "video", "name": "原片", "data": {}, "versions": [{"ref": source}], "cur": 0},
        ]}
        server.board_path("test").write_text(json.dumps(board))
        asset = server.creative_memory.Store(server).put(self.user, {
            "name": "新角色", "kind": "character", "board": "test",
            "ref": self.source["ref"], "source_board": "test",
        })

        async def act(action=None, **kwargs):
            payload = {"action": action, "shot": 0, **kwargs} if action else None
            response = await server.remake(Request(source, self.user, payload))
            self.assertEqual(response.status, 200)
            return json.loads(response.body)

        with self.assertRaises(web.HTTPNotFound):
            await server.remake(Request(source, {"id":8, "role":"member"}))
        self.assertIsNone(await act())
        with patch.object(server, "llm_call", side_effect=self.no_vision):
            analyzed = await act("analyze")
        frame = analyzed["shots"][0]["frames"]["first"]
        self.assertTrue(frame["ref"].endswith(".png"))
        with self.assertRaises(web.HTTPBadRequest):
            await act("preview", asset=asset["id"])
        await act("select", rect=[.25, .25, .75, .75])
        job = "remake-test-job"

        async def submit(req, payload):
            self.assertEqual(payload["images"][2]["ref"], self.source["ref"])
            self.assertIn("@图3", payload["prompt"])
            synthetic = image_editor.save(server.COMFY_DIR, Image.new("RGB",(64,64),"white"))
            output = image_editor.composite(server.COMFY_DIR, payload["_image_edit"], [synthetic])[0]
            db.task_start(id=job, user_id=7, board_id="test", state="done", outputs=[output["ref"]])
            return web.json_response({"ids":[job]})

        with patch.object(server, "_generate_request", side_effect=submit):
            started = await act("preview", asset=asset["id"], view="main")
        result = started["shots"][0]["frames"]["first"]["previews"][0]
        self.assertEqual(result["state"], "done")
        original = image_editor.load(server.COMFY_DIR, frame["ref"])
        output = image_editor.load(server.COMFY_DIR, result["ref"])
        self.assertEqual(output.getpixel((0, 0)), original.getpixel((0, 0)))
        self.assertNotEqual(output.getpixel((32, 32)), original.getpixel((32, 32)))
        await act("approve", job=job)
        reopened = await act()
        self.assertEqual(reopened["shots"][0]["frames"]["first"]["approved"], job)
        self.assertEqual(reopened["role"]["asset"], asset["id"])
        kept = await act("keep")
        self.assertTrue(kept["shots"][0]["keep_original"])

    @staticmethod
    async def no_vision(req, coroutine):
        coroutine.close()
        raise web.HTTPServiceUnavailable()
