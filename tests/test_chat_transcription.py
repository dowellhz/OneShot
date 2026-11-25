"""Assistant recording transcription and upload validation."""

from unittest.mock import AsyncMock, patch
import io
import wave

import aiohttp

from oneshot.editing import transcription_routes
from oneshot.storage import db
import server

from chat_fixture import ChatFixture


class ChatTranscription(ChatFixture):
    async def test_transcription_uses_configured_routes_without_adding_messages(self):
        provider = server.providers
        response = await self.client.get("/api/transcription")
        self.assertEqual(await response.json(), {"available": False})
        response = await self.client.post("/api/transcription", json={})
        self.assertEqual(response.status, 503)

        primary = provider.save(None, "asr_compat", "主服务", {"base_url": "https://primary.invalid/v1"}, {}, True)
        backup = provider.save(None, "asr_compat", "备用服务", {"base_url": "https://backup.invalid/v1"}, {}, True)
        provider.set_route("asr", [{"provider_id": primary}, {"provider_id": backup, "model": "backup-model"}])
        response = await self.client.get("/api/transcription")
        self.assertEqual(await response.json(), {"available": True})

        def form(audio):
            data = aiohttp.FormData()
            data.add_field("file", audio, filename="test.wav", content_type="audio/wav")
            return data

        transcribe = AsyncMock(side_effect=[provider.ProviderError("offline"), "把这张图调暖"])
        with patch.object(provider, "transcribe", transcribe):
            response = await self.client.post("/api/transcription", data=form(b"<html>"))
            self.assertEqual(response.status, 400)
            with patch.object(transcription_routes, "ASR_AUDIO_LIMIT", 12):
                response = await self.client.post("/api/transcription", data=form(b"RIFF0000WAVEdata"))
                self.assertEqual(response.status, 413)
            transcribe.assert_not_awaited()
            response = await self.client.post("/api/transcription", data=form(b"RIFF0000WAVE"))
        self.assertEqual(await response.json(), {"text": "把这张图调暖"})
        self.assertEqual([(c.args[1]["id"], c.args[2]) for c in transcribe.await_args_list],
                         [(primary, "gpt-transcribe"), (backup, "backup-model")])
        self.assertFalse(db.q("SELECT id FROM chat_runs"))

        sample = io.BytesIO()
        with wave.open(sample, "wb") as audio:
            audio.setparams((2,2,48000,0,"NONE",""))
            audio.writeframes(b"\x12\x01\x20\x01" * 48000)
        preview = AsyncMock(return_value="初步转写")
        with patch.object(provider,"transcribe",preview):
            response = await self.client.post("/api/transcription?preview=1",data=form(b"RIFF0000WAVE"))
            self.assertEqual(response.status,400)
            preview.assert_not_awaited()
            response = await self.client.post("/api/transcription?preview=1",data=form(sample.getvalue()))
        self.assertEqual(await response.json(),{"text":"初步转写"})
        _, _, _, payload, extension, content_type = preview.await_args.args
        self.assertEqual((extension,content_type),(".wav","audio/wav"))
        with wave.open(io.BytesIO(payload),"rb") as audio:
            self.assertEqual((audio.getnchannels(),audio.getframerate()),(1,16000))
            self.assertGreater(audio.getnframes(),15000)
        self.assertFalse(db.q("SELECT id FROM chat_runs"))
