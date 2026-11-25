"""Isolated video remake requests, storage, and deterministic media fixtures."""

from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
import asyncio

from PIL import Image
from aiohttp import web
import av
import numpy as np

from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.editing import image_editor
from oneshot.editing import timeline_routes
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import local as local_generation
from oneshot.memory import legacy_routes
from oneshot.storage import db
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


class RemakeFixture(IsolatedAsyncioTestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        root = Path(directory)
        self.enterContext(patch.object(db, "_conn", None))
        self.enterContext(patch.object(db, "DB_PATH", root / "remake.db"))
        self.enterContext(patch.object(config, "COMFY_DIR", root / "media"))
        self.enterContext(patch.object(canvas_routes, "BOARDS", root / "boards"))
        self.enterContext(patch.object(legacy_routes, "LIBRARY", root / "library.json"))
        self.enterContext(patch.object(generation_jobs, "JOBS", {}))
        self.enterContext(patch.object(local_generation, "PREP_TAIL", [None]))
        self.enterContext(patch.object(generation_jobs, "STATS", {}))
        self.enterContext(patch.object(generation_jobs, "STATS_FILE", root / "stats.json"))
        self.enterContext(patch.object(timeline_routes, "RENDER_LOCK", asyncio.Lock()))
        self.addCleanup(db.conn().close)
        server.BOARDS.mkdir()
        self.user = {"id": 7, "role": "member"}
        self.source = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "red"), "asset", "input")

    async def wait_for_render(self, job):
        for _ in range(150):
            task = db.one("SELECT state,outputs,error FROM tasks WHERE id=?", job)
            if task["state"] in ("done","error"):
                break
            await asyncio.sleep(.02)
        self.assertEqual(task["state"], "done", task["error"])
        return task

    @staticmethod
    def make_clip(name, seconds, color, frequency, audio_delay=0):
        path, ref = server.tools._new(server.COMFY_DIR, "input", name, ".mp4")
        rate = server.film.SR
        with av.open(str(path), "w") as clip:
            video = clip.add_stream("libx264", rate=24)
            video.width = video.height = 64
            video.pix_fmt = "yuv420p"
            audio = clip.add_stream("aac", rate=rate)
            audio.layout = "stereo"
            for tick in range(24 * seconds):
                image = av.VideoFrame.from_image(Image.new("RGB", (64,64), color(tick) if callable(color) else color))
                for packet in video.encode(image):
                    clip.mux(packet)
            for packet in video.encode():
                clip.mux(packet)
            for i in range(0, rate * seconds, 1024):
                times = np.arange(i, min(i + 1024, rate * seconds)) / rate
                samples = (np.sin(2 * np.pi * frequency * times) * .25).astype(np.float32)
                frame = av.AudioFrame.from_ndarray(np.stack([samples, samples]), format="fltp", layout="stereo")
                frame.sample_rate = rate
                frame.time_base = Fraction(1, rate)
                frame.pts = i + round(audio_delay * rate)
                for packet in audio.encode(frame):
                    clip.mux(packet)
            for packet in audio.encode():
                clip.mux(packet)
        return ref

    @staticmethod
    async def no_vision(req, coroutine):
        coroutine.close()
        raise web.HTTPServiceUnavailable()
