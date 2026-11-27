"""Reusable voices and background music at their normal application entry points."""

import asyncio
import time
from unittest.mock import AsyncMock, patch
import wave

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import numpy as np

from audio_fixture import AudioFixture
from oneshot import config
from oneshot.editing import render as film
from oneshot.generation.media_files import ref_path
from oneshot.providers import catalog, noiz, remote_audio
from oneshot.storage import db
from oneshot.web import auth, routing


class AudioCreation(AudioFixture):
    async def test_voice_admin_clones_publishes_and_removes_without_sending_credentials_to_clients(self):
        pid = catalog.save(None, "noiz", "Noiz", {}, {"api_key": "fixture-key"}, True)
        app = web.Application(middlewares=[auth.middleware])
        app["http"] = self.http
        app.add_routes(routing.console_routes)
        db.run("UPDATE users SET role='admin' WHERE id=7")
        for token, user_id in (("test-admin", 7), ("test-member", 8)):
            db.run("INSERT INTO sessions VALUES (?,?,?,?)", token, user_id, time.time(), time.time() + 3600)
        api = f"/api/admin/providers/{pid}/voices"
        admin = {"Cookie": f"{auth.COOKIE}=test-admin"}
        member = {"Cookie": f"{auth.COOKIE}=test-member"}
        audio_path, _ = self.tone()
        sample = audio_path.read_bytes()

        def upload(data):
            form = aiohttp.FormData()
            form.add_field("name", "Actor")
            form.add_field("language", "en")
            form.add_field("file", data, filename="sample.wav", content_type="audio/wav")
            return form

        async def vendor(_http, method, url, _limit, **kwargs):
            self.assertEqual(kwargs["headers"], {"Authorization": "fixture-key"})
            if method == "POST":
                self.assertEqual(url, "https://noiz.ai/v1/voices")
                return b'{"code":0,"data":{"voice_id":"actor1","voice_display_name":"Actor"}}'
            self.assertEqual(kwargs["params"], {"voice_type": "built-in", "skip": 1, "limit": 10, "keyword": "Official"})
            return b'{"code":0,"data":{"voices":[{"voice_id":"official1","display_name":"Official"}],"total_count":21}}'

        async with TestClient(TestServer(app)) as client:
            with patch.object(noiz, "response_bytes", side_effect=vendor) as request:
                response = await client.post(api, data=upload(sample), headers=member)
                self.assertEqual(response.status, 403)
                self.assertEqual((await client.post(api, data=upload(b"fake"), headers=admin)).status, 400)
                request.assert_not_called()
                response = await client.post(api, data=upload(sample), headers=admin)
                self.assertEqual(response.status, 200, await response.text())
                self.assertEqual((await response.json())["saved"], [{"id": "actor1", "name": "Actor"}])
                listing = await (await client.get(api + "?kind=built-in&page=1&q=Official", headers=admin)).json()
                self.assertTrue(listing["more"])
                self.assertEqual(listing["voices"], [{"id": "official1", "name": "Official"}])
                response = await client.put(api + "/official1?kind=built-in&page=1&q=Official", headers=admin)
                self.assertEqual(response.status, 200, await response.text())
                self.assertNotIn("fixture-key", await response.text())
                removed = await (await client.delete(api + "/actor1", headers=admin)).json()
                self.assertEqual(removed["saved"], [{"id": "official1", "name": "Official"}])
                self.assertEqual(request.await_count, 3)
            with patch.object(noiz, "response_bytes", return_value=b'{"code":400,"message":"credit limit exceeded"}'):
                limited = await client.post(api, data=upload(sample), headers=admin)
                self.assertEqual(limited.status, 400)
                self.assertIn("额度不足", await limited.text())
        self.assertEqual(catalog.get(pid)["config"]["voices"], "official1=Official")

    async def test_elevenlabs_soundtrack_reuses_audio_jobs_with_instrumental_and_duration(self):
        pid = catalog.save(None, "elevenlabs", "ElevenLabs", {}, {"api_key": "fixture-key"}, True)
        path, ref = self.tone()
        vendor = AsyncMock(return_value={"files": [{"path": path, "ref": ref, "kind": "audio"}]})
        with patch.object(remote_audio, "elevenlabs_audio", vendor):
            response = await self.client.post("/api/audio/generate", json={
                "mode":"music", "board":"test", "provider":pid, "prompt":"Gentle piano", "duration_seconds":3,
                "request_key":"instrumental-music-test",
            })
            self.assertEqual(response.status, 200, await response.text())
            created = await response.json()
            self.assertEqual(created["recipe"]["duration_seconds"], 3)
            job = await self.check_job(created["ids"][0], "done")
            self.assertEqual(job["outputs"][0]["meta"]["duration"], 3)
        self.assertEqual(vendor.call_args.args[3:6], ("music", {
            "model_id":"music_v1", "prompt":"Gentle piano", "force_instrumental":True, "music_length_ms":3000,
        }, "music"))

    async def test_rendered_film_has_soundtrack_and_dialogue(self):
        refs = []
        for frequency in (330, 660):
            path, ref = self.tone()
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 8000, 0, "NONE", ""))
                samples = (4000 * np.sin(2*np.pi*frequency*np.arange(8000)/8000)).astype("<i2")
                output.writeframes(samples.tobytes())
            refs.append(ref)
        result = await asyncio.to_thread(film.render, config.COMFY_DIR, {
            "clips": [{"ref": self.source["ref"], "kind": "image", "duration": 3}],
            "bgm": {"ref": refs[0], "volume": .35, "duck": True},
            "narration": [{"ref": refs[1], "start": 1, "volume": 1}],
        }, display=False)
        pcm = film.read_audio(ref_path(config.COMFY_DIR, result["ref"]))[0]
        segment = pcm[int(1.2*film.SR):int(1.8*film.SR)]
        def amplitude(frequency):
            return abs(np.dot(segment, np.exp(-2j*np.pi*frequency*np.arange(len(segment))/film.SR))) / len(segment)
        self.assertGreater(amplitude(330), .001)
        self.assertGreater(amplitude(660), .01)
