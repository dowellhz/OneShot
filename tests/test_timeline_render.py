"""Timeline captions, cuts, transitions, overlays, and routed source audio."""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch
import io
import json
import wave

from PIL import Image
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import av
import numpy as np

from oneshot.editing import image_editor
from oneshot.editing import timeline_routes
import server

from remake_fixture import RemakeFixture, Request


class TimelineRender(RemakeFixture):
    def test_editable_remake_timeline_uses_the_original_audio_for_reordered_and_trimmed_clips(self):
        source = self.make_clip("audio-original", seconds=3, color=(40, 70, 90), frequency=440, audio_delay=1)
        take = self.make_clip("audio-take", seconds=2, color=(100, 190, 10), frequency=880)
        result = server.film.render(server.COMFY_DIR, {"remake_audio":source, "subtitles":False, "clips":[
            {"ref":take,"in":.25,"out":1.25,"audio_start":1},
            {"ref":source,"in":0,"out":.5,"audio_start":0},
        ]})
        path = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        pcm = server.film.read_audio(path)[0]
        rate = server.film.SR
        self.assertAlmostEqual(result["seconds"], 1.5, places=2)
        self.assertEqual(np.argmax(np.abs(np.fft.rfft(pcm[:rate]))), 440)
        self.assertLess(np.max(np.abs(pcm[round(1.1*rate):])), .025)

    def test_segment_replacements_can_keep_the_timestamp_aligned_original_sound(self):
        source = self.make_clip("segment-original", 3, (40, 70, 90), 440, audio_delay=1)
        take = self.make_clip("segment-take", 2, (10, 40, 210), 880)
        clips = [
            {"ref":source,"in":0,"out":.5,"audio_ref":source,"audio_start":0,"tight":True},
            {"ref":take,"in":.25,"out":1.75,"audio_ref":source,"audio_start":.25,"tight":True},
            {"ref":source,"in":2,"out":3,"audio_ref":source,"audio_start":0,"tight":True},
        ]
        spec = {"clips":clips}
        self.assertTrue(server.film_preflight(spec)["ok"])
        result = server.film.render(server.COMFY_DIR, spec)
        output = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        rate = server.film.SR
        pcm = server.film.read_audio(output)[0]
        self.assertAlmostEqual(result["seconds"], 3)
        self.assertLess(np.max(np.abs(pcm[:round(.9*rate)])), .025)
        for start in (1.25, 2.25):
            sample = pcm[round(start*rate):round((start+.5)*rate)]
            self.assertEqual(np.argmax(np.abs(np.fft.rfft(sample))) * 2, 440)
        with av.open(str(output)) as media:
            frames = list(media.decode(video=0))
        self.assertEqual(len(frames), 72)
        self.assertGreater(frames[24].to_ndarray(format="rgb24")[0,0,2], 190)
        clips[1]["audio_start"] = 2
        check = server.film_preflight(spec)
        self.assertEqual(check["issues"][0]["clip"], 1)
        self.assertIn("原片音轨", check["issues"][0]["error"])

    async def test_captions_use_the_selected_soundtrack_and_render_at_source_times(self):
        source = self.make_clip("caption-picture", 3, (30, 30, 30), 880)
        original = self.make_clip("caption-original", 4, (20, 20, 20), 440)
        silent = self.make_clip("caption-silent", 2, (20, 20, 20), 0)
        audio_only = "input:h3studio/caption-original.wav"
        path = server.tools.ref_path(server.COMFY_DIR, audio_only)
        rate = server.film.SR
        with wave.open(str(path), "wb") as tone:
            tone.setparams((1, 2, rate, 0, "NONE", ""))
            tone.writeframes((3000 * np.sin(2 * np.pi * 440 * np.arange(4 * rate) / rate)).astype("<i2").tobytes())
        server.write_board(server.board_path("test"), {"owner":7,"collaborators":{"8":"reviewer"},"nodes":[
            {"id":"n3","type":"video","versions":[{"ref":source}]},
            {"id":"n4","type":"video","versions":[{"ref":original}]},
            {"id":"n5","type":"video","versions":[{"ref":silent}]},
            {"id":"n6","type":"audio","versions":[{"ref":audio_only}]},
        ]})

        @web.middleware
        async def fixture_user(req, handler):
            req["user"] = {"id":int(req.headers.get("X-Uid", "7")),"role":"member"}
            return await handler(req)

        @asynccontextmanager
        async def post(url, *, data, **kwargs):
            fields = {options["name"]:value for options, _, value in data._fields}
            self.assertEqual((url, fields["model"], fields["response_format"], fields["timestamp_granularities[]"]),
                             ("https://captions.invalid/v1/audio/transcriptions","whisper-1","verbose_json","segment"))
            with wave.open(io.BytesIO(fields["file"])) as wav:
                rate = wav.getframerate()
                self.assertEqual(wav.getnframes(), rate * 2)
                pcm = np.frombuffer(wav.readframes(rate), dtype="<i2")
                self.assertEqual(np.argmax(np.abs(np.fft.rfft(pcm))), 440)

            async def transcribed():
                return {"text":"测试字幕", "segments":[{"start":.5,"end":1.5,"text":"测试字幕"}]}

            yield SimpleNamespace(status=200,json=transcribed)

        app = web.Application(middlewares=[fixture_user,server.media_input_guard])
        app["http"] = SimpleNamespace(post=post)
        app.router.add_post("/api/video/captions", server.video_captions)
        providers = server.providers
        primary = providers.save(None,"asr_compat","字幕",{"base_url":"https://captions.invalid/v1"},{},True)
        providers.set_route("asr",[{"provider_id":primary,"model":"whisper-1"}])
        clip = {"ref":source,"in":1,"out":3,"audio_ref":original,"audio_start":.5,"speed":2}
        async with TestClient(TestServer(app)) as client:
            api = "/api/video/captions"
            self.assertEqual((await client.post(api,json={"board":"test",**clip},headers={"X-Uid":"8"})).status,403)
            response = await client.post(api,json={"board":"test",**clip})
            self.assertEqual(response.status,200,await response.text())
            clip["captions"] = (await response.json())["captions"]
            response = await client.post(api,json={"board":"test",**clip,"audio_ref":audio_only})
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual((await response.json())["captions"],clip["captions"])
            self.assertEqual((await client.post(api,json={"board":"test","ref":audio_only})).status,400)
            response = await client.post(api,json={"board":"test","ref":silent,"allow_silence":True})
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual(await response.json(), {"captions":[],"silent":True})
            response = await client.post(api,json={"board":"test","ref":silent})
            self.assertEqual(response.status, 400)
        self.assertEqual(clip["captions"],[{"start":1.5,"end":2.5,"text":"测试字幕"}])
        spec = {"clips":[clip]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        # Use a solid strip to verify the actual frame timestamps independently of the machine's fonts.
        with patch.object(server.film,"subtitle_overlay",return_value=(np.full((4,64,4),255,np.float32),50)):
            result = server.film.render(server.COMFY_DIR,spec)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,result["ref"]))) as media:
            shown = [i for i,frame in enumerate(media.decode(video=0)) if frame.to_ndarray(format="rgb24")[51,32,0] > 200]
        self.assertEqual(shown,list(range(6,18)))

    def test_cutaways_replace_only_picture_on_the_main_timeline(self):
        source = self.make_clip("cutaway-main",3,(26,26,26),440)
        insert = self.make_clip("cutaway-video",2,lambda tick:(225,26,26) if tick<24 else (26,26,225),880)
        still = image_editor.save(server.COMFY_DIR,Image.new("RGBA",(48,64),(26,220,26,255)),"input")["ref"]
        cutaways = [{"kind":"video","ref":insert,"start":.5,"duration":1,"in":1},
                    {"kind":"image","ref":still,"start":1.5,"duration":.5}]
        spec = {"clips":[{"ref":source,"in":0,"out":3}],"cutaways":cutaways,"subtitles":False,"cover":.75}
        self.assertTrue(server.film_preflight(spec)["ok"])
        with self.assertRaisesRegex(ValueError,"补画面重叠"):
            server.film_preflight({**spec,"cutaways":[cutaways[0],{**cutaways[1],"start":1.4}]})
        result = server.film.render(server.COMFY_DIR,spec)
        path = server.tools.ref_path(server.COMFY_DIR,result["ref"])
        with av.open(str(path)) as media:
            pixels = [frame.to_ndarray(format="rgb24")[32,32] for frame in media.decode(video=0)]
        self.assertEqual(len(pixels),72)
        self.assertTrue(all(max(px) < 70 for px in pixels[:12]+pixels[48:]))
        self.assertTrue(all(px[2] > 190 for px in pixels[12:36]))
        self.assertTrue(all(px[1] > 190 for px in pixels[36:48]))
        rate = server.film.SR
        soundtrack = server.film.read_audio(path)[0][rate//2:rate*3//2]
        self.assertEqual(int(np.argmax(np.abs(np.fft.rfft(soundtrack)))),440)
        with Image.open(server.tools.ref_path(server.COMFY_DIR,result["cover"])) as cover:
            self.assertGreater(cover.getpixel((32,32))[2],190)

    def test_titles_are_burned_into_the_timed_picture_and_cover(self):
        from PIL import ImageFont

        source = self.make_clip("title-background", 2, (28, 28, 28), 440)
        spec = {"clips":[{"ref":source,"in":0,"out":2}],"subtitles":False,"cover":.75,
                "titles":[{"text":"Scene I","start":.51,"end":1.02,"position":"lower_left","style":"label"}]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        with self.assertRaisesRegex(ValueError, "第 1 条标题"):
            server.film_preflight({**spec,"titles":[{**spec["titles"][0],"end":.2}]})
        font = ImageFont.load_default(size=12)
        with patch.object(ImageFont,"truetype",side_effect=lambda _path,size:font.font_variant(size=size)):
            result = server.film.render(server.COMFY_DIR,spec)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,result["ref"]))) as media:
            visible = []
            for index, frame in enumerate(media.decode(video=0)):
                image = frame.to_ndarray(format="rgb24")
                self.assertLess(image[:30].max(),80)
                if image[40:57,:46].max() > 150:
                    visible.append(index)
        self.assertEqual(visible,list(range(13,25)))
        with Image.open(server.tools.ref_path(server.COMFY_DIR,result["cover"])) as cover:
            self.assertGreater(np.asarray(cover)[40:57,:46].max(),150)

    def test_film_clip_speed_changes_frame_timing_without_changing_audio_pitch(self):
        source = self.make_clip("retime-source", 2,
                                lambda tick: (240,20,20) if tick < 24 else (20,40,225), 440)
        alternate_audio = self.make_clip("retime-original-sound", 2, (30,30,30), 660)
        clips = [
            {"ref":source,"in":0,"out":2,"speed":2},
            {"ref":source,"in":1,"out":2,"speed":.5,"audio_ref":alternate_audio,"audio_start":0},
        ]
        spec = {"clips":clips}
        self.assertTrue(server.film_preflight(spec)["ok"])
        result = server.film.render(server.COMFY_DIR, spec)
        output = server.tools.ref_path(server.COMFY_DIR, result["ref"])
        with av.open(str(output)) as media:
            frames = list(media.decode(video=0))
        self.assertEqual(len(frames), 72)
        for index, channel in ((11,0),(12,2),(24,2),(71,2)):
            self.assertGreater(frames[index].to_ndarray(format="rgb24")[0,0,channel], 195)
        self.assertAlmostEqual(result["seconds"], 3)
        rate = server.film.SR
        pcm = server.film.read_audio(output)[0]
        for begin, pitch in ((.25,440),(1.25,660)):
            samples = pcm[round(begin*rate):round((begin+.5)*rate)]
            self.assertEqual(np.argmax(np.abs(np.fft.rfft(samples))) * 2, pitch)
        clips[1]["speed"] = 3
        self.assertIn("播放速度", server.film_preflight(spec)["issues"][0]["error"])

    async def test_capture_at_playhead_keeps_tail_capture_available(self):
        source = self.make_clip("playhead", seconds=2, frequency=440,
                                color=lambda tick: (220,30,30) if tick < 24 else (30,30,220))
        for fields, channel, timestamp in (({"at":.52},0,.5), ({"position":"first"},0,0),
                                           ({"position":"last"},2,47/24), ({"at":None},2,47/24)):
            request = Request(source, self.user, {"ref":source,**fields})
            result = json.loads((await server.lastframe(request)).body)
            image = image_editor.load(server.COMFY_DIR, result["ref"])
            self.assertGreater(image.getpixel((32,32))[channel], 190)
            self.assertEqual((result["w"],result["h"]), (64,64))
            self.assertAlmostEqual(result["at"], timestamp, places=5)
            self.assertTrue(server.can_read_media(self.user, result["ref"]))

    async def test_frame_preview_reads_first_and_last_without_creating_assets(self):
        source = self.make_clip("review-boundary", seconds=2, frequency=440,
                                color=lambda tick: (220,30,30) if tick < 24 else (30,30,220))
        server.grant_media(self.user,source)
        before = set(server.COMFY_DIR.rglob("*"))
        for position,channel,query in (("first",0,{}),("last",2,{}),("time",2,{"at":"1.25"})):
            request = Request(source,self.user)
            request.query = {"ref":source,"position":position,**query}
            response = await server.video_frame_preview(request)
            self.assertEqual(response.content_type,"image/png")
            self.assertIn("no-store",response.headers["Cache-Control"])
            with Image.open(io.BytesIO(response.body)) as frame:
                self.assertGreater(frame.getpixel((32,32))[channel],190)
        self.assertEqual(set(server.COMFY_DIR.rglob("*")),before)
        outsider = Request(source,{"id":99,"role":"member"})
        outsider.query = {"ref":source,"position":"last"}
        with self.assertRaises(web.HTTPNotFound):
            await server.video_frame_preview(outsider)
        for query in ({"position":"time"},{"position":"time","at":"nan"},{"position":"last","at":"1.25"}):
            request.query = {"ref":source,**query}
            with self.assertRaises(web.HTTPBadRequest):
                await server.video_frame_preview(request)

    async def test_film_checks_missing_clips_and_replays_an_accepted_export(self):
        source = self.make_clip("checked-film", seconds=1, color=(40,70,90), frequency=440)
        spec = {"clips":[{"ref":source,"in":0,"out":1}], "subtitles":False}
        check = server.film_preflight({**spec,"clips":[*spec["clips"],{"ref":"input:h3studio/missing.mp4"}]})
        self.assertFalse(check["ok"])
        self.assertEqual(check["issues"][0]["clip"], 1)
        self.assertEqual(check["dimensions"], (64,64))
        with patch.object(timeline_routes, "enqueue_film", wraps=server.enqueue_film) as enqueue:
            req = Request(source, self.user, {"spec":spec,"request_key":"same-render-attempt-1"})
            first = json.loads((await server.render_film(req)).body)
            repeat = json.loads((await server.render_film(req)).body)
            self.assertEqual(repeat["ids"], first["ids"])
            enqueue.assert_called_once()
            await self.wait_for_render(first["ids"][0])
            server.JOBS.pop(first["ids"][0], None)
            after_restart = json.loads((await server.render_film(req)).body)
            self.assertEqual(after_restart["ids"], first["ids"])

    async def test_mixed_film_exports_still_and_video_with_their_timing_and_audio(self):
        video = self.make_clip("mixed-film", seconds=1, color=(20, 30, 220), frequency=440)
        still = {"kind":"image", "ref":self.source["ref"], "duration":.75, "trans":"fade"}
        spec = {"clips":[still, {"ref":video, "in":0, "out":1}], "subtitles":False, "cover":.2}
        self.assertEqual(server.film_preflight(spec)["dimensions"], (64, 64))
        for invalid in ({"duration":0}, {"duration":61}, {"duration":"NaN"}, {"ref":video}):
            check = server.film_preflight({"clips":[{**still, **invalid}]})
            self.assertFalse(check["ok"])
            self.assertEqual(check["issues"][0]["clip"], 0)
        response = await server.render_film(Request(video, self.user, {"spec":spec, "request_key":"mixed-film-render"}))
        result = await self.wait_for_render(json.loads(response.body)["ids"][0])
        ref = json.loads(result["outputs"])[0]
        path = server.tools.ref_path(server.COMFY_DIR, ref)
        with av.open(str(path)) as output:
            frames = [frame.to_image().getpixel((32, 32)) for frame in output.decode(video=0)]
        self.assertEqual(len(frames), 33)
        self.assertGreater(frames[3][0], 235)
        self.assertGreater(frames[13][0], 70)
        self.assertGreater(frames[13][2], 45)
        self.assertGreater(frames[-1][2], 190)
        pcm = server.film.read_audio(path)[0]
        self.assertLess(np.abs(pcm[:server.film.SR // 4]).max(), .025)
        self.assertGreater(np.abs(pcm[-server.film.SR // 2:]).max(), .10)

    def test_timed_audio_is_trimmed_mixed_and_capped_to_the_picture(self):
        path, source = server.tools._new(server.COMFY_DIR, "input", "fx", ".wav")
        rate = server.film.SR
        ticks = np.arange(rate // 2)
        signal = np.concatenate([np.sin(ticks * (2 * np.pi * frequency / rate)) for frequency in (440, 660)])
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes((signal * 16000).astype("<i2").tobytes())
        timed = {"ref":source, "start":.5, "in":.5, "out":1, "volume":.5}
        spec = {"clips":[{"kind":"image", "ref":self.source["ref"], "duration":1.5}], "audio_clips":[timed, {**timed, "start":1.25}]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        for change in ({"out":.5}, {"start":-1}, {"volume":2}):
            invalid = {**spec, "audio_clips":[{**timed, **change}]}
            self.assertEqual(server.film_preflight(invalid)["issues"][0]["audio"], 0)
        result = server.film.render(server.COMFY_DIR, spec)
        self.assertEqual(result["seconds"], 1.5)
        pcm = server.film.read_audio(server.tools.ref_path(server.COMFY_DIR, result["ref"]))[0]
        for start in (.1, 1.05):
            self.assertLess(np.max(np.abs(pcm[round(start * rate):round((start + .1) * rate)])), .025)
        measured = pcm[round(.6 * rate):round(.8 * rate)]
        frequency = np.argmax(np.abs(np.fft.rfft(measured))) * rate / len(measured)
        self.assertEqual(frequency, 660)
        self.assertTrue(.13 < np.abs(measured).max() < .22)
        self.assertGreater(np.abs(pcm[round(1.35 * rate):round(1.45 * rate)]).max(), .13)

    def test_editable_remake_timeline_uses_original_dimensions(self):
        _, source = server.tools._new(server.COMFY_DIR, "input", "landscape-original", ".mp4")
        with av.open(str(server.tools.ref_path(server.COMFY_DIR, source)), "w") as output:
            stream = output.add_stream("libx264", rate=24)
            stream.width, stream.height, stream.pix_fmt = 96, 64, "yuv420p"
            for _ in range(24):
                for packet in stream.encode(av.VideoFrame.from_image(Image.new("RGB", (96, 64), "gray"))):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
        take = self.make_clip("square-take", seconds=1, color=(100,190,10), frequency=880)
        result = server.film.render(server.COMFY_DIR, {"remake_audio":source, "subtitles":False, "clips":[
            {"ref":take, "in":0, "out":1, "audio_start":0},
        ]})
        self.assertEqual((result["w"], result["h"]), (96,64))
