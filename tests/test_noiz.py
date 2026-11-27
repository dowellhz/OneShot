"""Noiz TTS requests, timeline permissions, and canvas audio generation."""

import io
import wave
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

from audio_fixture import AudioFixture
from oneshot.providers import catalog, noiz, remote


class NoizSpeech(AudioFixture):
    async def test_official_voice_is_available_to_timeline_and_canvas(self):
        pid = catalog.save(None, "noiz", "Noiz", {"voices": "voice1=Narrator"}, {"api_key": "test-key"}, True)
        voice, = [v for v in (await (await self.client.get("/api/voices")).json())["voices"] if v.get("provider") == pid]
        self.assertEqual(voice, {"id": "voice1", "name": "Narrator", "provider": pid, "service": "Noiz"})
        tone = self.tone()[0].read_bytes()
        requests = []

        async def vendor(_http, method, url, _limit, **kwargs):
            self.assertEqual(kwargs["headers"], {"Authorization": "test-key"})
            requests.append((method, url))
            if url == "https://noiz.ai/v1/voices":
                self.assertEqual(kwargs["params"], {"voice_type": "built-in", "skip": 0, "limit": 10})
                return b'{"code":0,"data":{"voices":[]}}'
            self.assertEqual(url, "https://noiz.ai/v1/text-to-speech")
            return tone

        payload = {"provider": pid, "voice": "voice1", "speed": 1.15}
        with patch.object(noiz, "response_bytes", side_effect=vendor):
            self.assertTrue((await remote.test(self.http, catalog.get(pid)))["ok"])
            spoken = await self.client.post("/api/tts", json={**payload, "text": "你好"})
            self.assertEqual(spoken.status, 200, await spoken.text())
            narration = await spoken.json()
            self.assertEqual(narration["seconds"], 3)
            audio = await self.client.get(narration["url"])
            self.assertEqual(audio.status, 200, await audio.text() if audio.status != 200 else "")
            self.assertEqual(await audio.read(), tone)
            generation = await self.client.post("/api/audio/generate", json={
                **payload, "board": "test", "mode": "tts", "prompt": "你好", "request_key": "noiz-official-voice",
            })
            self.assertEqual(generation.status, 200, await generation.text())
            await self.check_job((await generation.json())["ids"][0], "done")
            invalid = await self.client.post("/api/tts", json={**payload, "text": "你好", "voice": "other"})
            self.assertEqual(invalid.status, 400)
        self.assertEqual([method for method, _ in requests], ["GET", "POST", "POST"])
        with self.assertRaises(catalog.ProviderError):
            catalog.save(pid, "elevenlabs", "Another provider", {"voices": "v=Name"}, {}, True)

    async def test_international_uses_multipart_and_rejects_invalid_audio(self):
        tone = self.tone()[0].read_bytes()
        payloads = []

        async def synthesize(request):
            self.assertEqual(request.headers["Authorization"], "international-key")
            self.assertNotIn("sign", request.headers)
            form = await request.multipart()
            payloads.append({part.name: await part.text() async for part in form})
            if len(payloads) == 2:
                return web.json_response({"code": 402, "message": "Insufficient credits"})
            return web.Response(body=tone if len(payloads) == 1 else b"not audio", content_type="audio/wav")

        app = web.Application()
        app.router.add_post("/v1/text-to-speech", synthesize)
        async with TestServer(app) as vendor, aiohttp.ClientSession() as client:
            provider = {"kind": "noiz", "config": {"voices": "voice1=Voice"}, "secrets": {"api_key": "international-key"}}
            with patch.object(noiz, "INTERNATIONAL_API", str(vendor.make_url("/v1"))):
                output = await remote.run(client, self.tone()[0].parent, provider, "noiz-tts", "tts", {"text": "Hello"})
                with self.assertRaisesRegex(catalog.ProviderError, "额度不足"):
                    await remote.run(client, self.tone()[0].parent, provider, "noiz-tts", "tts", {"text": "Hello"})
                with self.assertRaisesRegex(catalog.ProviderError, "WAV"):
                    await remote.run(client, self.tone()[0].parent, provider, "noiz-tts", "tts", {"text": "Hello"})
            with wave.open(io.BytesIO(output["files"][0]["path"].read_bytes())) as spoken:
                self.assertEqual(spoken.getnframes(), 24000)
            self.assertEqual(payloads[0], {"text": "Hello", "voice_id": "voice1", "speed": "1.0", "output_format": "wav"})

    async def test_refuses_to_follow_redirects_with_api_key(self):
        async def redirect(_request):
            raise web.HTTPTemporaryRedirect("/other")

        async def unexpected(_request):
            self.fail("The authenticated request followed the redirect")

        app = web.Application()
        app.router.add_get("/v1/voices", redirect)
        app.router.add_get("/other", unexpected)
        async with TestServer(app) as vendor, aiohttp.ClientSession() as client:
            with patch.object(noiz, "INTERNATIONAL_API", str(vendor.make_url("/v1"))):
                with self.assertRaisesRegex(catalog.ProviderError, "307"):
                    await remote.test(client, {"kind": "noiz", "secrets": {"api_key": "test-key"}})
