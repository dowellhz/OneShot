"""Rotation and variable-rate display coordinates through remake export."""

from fractions import Fraction
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch
import asyncio
import json

from PIL import Image, ImageDraw
import av
import numpy as np

from oneshot.editing import image_editor
from oneshot.editing import video_remake
from oneshot.web import http as http_errors
import server

from remake_fixture import RemakeFixture, Request


class RemakeSourceDisplay(RemakeFixture):
    async def test_variable_rate_source_uses_displayed_frame_in_previews_and_export(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "variable-rate", ".mkv")
        colors = [(200, 20, 20), (20, 200, 20), (20, 20, 200), (200, 200, 20)]
        with av.open(str(path), "w") as output:
            stream = output.add_stream("libx264", rate=24)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            stream.codec_context.time_base = Fraction(1, 1000)
            rate = server.film.SR
            audio = output.add_stream("pcm_s16le", rate=rate)
            audio.layout = "stereo"
            for pts, color in zip((500, 555, 605, 690), colors):
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), color))
                frame.pts, frame.time_base = pts, stream.codec_context.time_base
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
            for i in range(0, rate // 2, 1024):
                times = np.arange(i, min(i + 1024, rate // 2)) / rate
                samples = (8000 * np.sin(2 * np.pi * 440 * times)).astype(np.int16)
                frame = av.AudioFrame.from_ndarray(np.repeat(samples, 2)[None, :], format="s16", layout="stereo")
                frame.sample_rate, frame.time_base = rate, Fraction(1, rate)
                frame.pts = i + round(.6 * rate)
                output.mux(audio.encode(frame))
            output.mux(audio.encode())
        with av.open(str(path)) as written:
            self.assertEqual([round(frame.time * 1000) for frame in written.decode(video=0)], [500, 555, 605, 690])
        raw = path.read_bytes()

        async def read_part(decode=False):
            return raw

        async def next_part():
            return SimpleNamespace(filename="variable-rate.MKV", read=read_part)

        async def multipart():
            return SimpleNamespace(next=next_part)

        upload = Request("", self.user)
        upload.multipart = multipart
        imported = json.loads((await server.upload(upload)).body)
        self.assertEqual(imported["type"], "video")
        source = imported["ref"]
        path = server.tools.ref_path(server.COMFY_DIR, source)
        duration = server.film.probe(path)[2]
        self.assertAlmostEqual(duration, .232, delta=.002)
        expected = [colors[index] for index in (0, 0, 1, 2, 2, 3)]
        previews = await asyncio.to_thread(video_remake.original_frames, server, source, set(range(6)))
        for tick, color in enumerate(expected):
            preview = image_editor.load(server.COMFY_DIR, previews[tick]["ref"])
            self.assertTrue(np.allclose(preview.getpixel((32, 32))[:3], color, atol=5))

        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))
        listed = json.loads((await server.assets(Request("", self.user))).body)
        self.assertEqual([(entry["ref"], entry["type"]) for entry in listed], [(source, "video")])

        async def act(action=None):
            request = Request(source, self.user, {"action":action} if action else None)
            return json.loads((await server.remake(request)).body)

        converting = await act("prepare_playback")
        self.assertEqual(converting["shots"], [])
        job = converting["playback"]["job"]
        self.assertEqual((await act("prepare_playback"))["playback"]["job"], job)
        task = await self.wait_for_render(job)
        server.JOBS.pop(job)
        ref = json.loads(task["outputs"])[0]
        self.assertEqual((await act())["playback"]["ref"], ref)
        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
            analyzed = await act("analyze")
        self.assertEqual(analyzed["playback"]["ref"], ref)
        self.assertEqual(analyzed["shots"][0]["end"], duration)
        final = server.tools.ref_path(server.COMFY_DIR, ref)
        with av.open(str(final)) as result:
            self.assertEqual(result.streams.video[0].codec_context.name, "h264")
            self.assertEqual(result.streams.audio[0].codec_context.name, "aac")
            pixels = [frame.to_ndarray(format="rgb24")[32,32] for frame in result.decode(video=0)]
        self.assertEqual(len(pixels), 6)
        self.assertTrue(np.allclose(pixels, expected, atol=8))
        waveform = server.film.read_audio(final)[0]
        self.assertLess(np.max(np.abs(waveform[:round(.08 * rate)])), .01)
        self.assertGreater(np.max(np.abs(waveform[round(.12 * rate):round(.20 * rate)])), .1)

    @skipUnless(hasattr(av.video.stream.VideoStream, "set_display_rotation"), "rotated MP4 fixture needs PyAV display matrix writing")
    async def test_rotated_phone_video_uses_display_coordinates_through_export(self):
        def clip(name, image, rotated=False):
            path, ref = server.tools._new(server.COMFY_DIR, "input", name, ".mp4")
            with av.open(str(path), "w") as output:
                stream = output.add_stream("libx264", rate=24)
                stream.width, stream.height = image.size
                stream.pix_fmt = "yuv420p"
                if rotated:
                    stream.set_display_rotation(90, hflip=True)
                for _ in range(48):
                    for packet in stream.encode(av.VideoFrame.from_image(image)):
                        output.mux(packet)
                for packet in stream.encode():
                    output.mux(packet)
            return path, ref

        landscape = Image.new("RGB", (96, 64), (200, 30, 30))
        draw = ImageDraw.Draw(landscape)
        draw.rectangle((48, 0, 95, 31), fill=(30, 30, 200))
        draw.rectangle((48, 32, 95, 63), fill=(30, 160, 30))
        path, source = clip("phone", landscape, rotated=True)
        _, replacement = clip("portrait", Image.new("RGB", (64, 96), (210, 210, 30)))
        self.assertEqual(server.film.probe(path, display=False)[:2], (96, 64))
        self.assertEqual(server.tools.video_info(path), {"w":64, "h":96, "seconds":2})
        server.board_path("test").write_text(json.dumps({"owner":7, "nodes":[
            {"id":"n3", "type":"video", "versions":[{"ref":source}]},
        ]}))

        async def act(action, **fields):
            response = await server.remake(Request(source, self.user, {"action":action, "shot":0, **fields}))
            return json.loads(response.body)

        with patch.object(http_errors, "llm_call", side_effect=self.no_vision):
            analyzed = await act("analyze")
        first = analyzed["shots"][0]["frames"]["first"]
        self.assertEqual((first["w"], first["h"]), (64, 96))
        image = image_editor.load(server.COMFY_DIR, first["ref"])
        self.assertGreater(image.getpixel((8, 8))[1], 140)
        self.assertGreater(image.getpixel((56, 8))[2], 180)
        capture = await act("capture_correction", at=1)
        frame = capture["shots"][0]["frames"][capture["captured_frame"]]
        self.assertEqual((frame["w"], frame["h"]), (64, 96))
        session = await act("select", rect=[.58,.15,.9,.4])
        first = session["shots"][0]["frames"]["first"]
        session["shots"][0]["videos"] = [{
            "job":"portrait-remake", "state":"done", "ref":replacement,
            "first_frame":first["ref"], "mask":first["selection"]["mask"], "asset":{"id":"test"},
        }]
        video_remake.save((7, "test", "n3", source), session)
        local = await act("localize", job="portrait-remake")
        job = local["shots"][0]["videos"][-1]["job"]
        await self.wait_for_render(job)
        await act("approve_video", job=job)
        export = await act("export")
        task = await self.wait_for_render(export["export"]["job"])
        final = server.tools.ref_path(server.COMFY_DIR, json.loads(task["outputs"])[0])
        self.assertEqual(server.film.probe(final)[:2], (64, 96))
        with av.open(str(final)) as result:
            frame = next(result.decode(video=0)).to_ndarray(format="rgb24")
        self.assertGreater(frame[22,48,0], 185)
        self.assertGreater(frame[22,48,1], 185)
        self.assertGreater(frame[8,8,1], 140)
        self.assertGreater(frame[8,56,2], 180)
        legacy = video_remake.original_frames(server, source, {0}, display=False)[0]
        video_remake.save((7, "test", "n3", source), {"shots":[{"start":0, "end":2,
            "frames":{"first":legacy}, "summary":{}}]})
        old_capture = await act("capture_correction", at=1)
        old_frame = old_capture["shots"][0]["frames"][old_capture["captured_frame"]]
        self.assertEqual((old_frame["w"], old_frame["h"]), (96, 64))
