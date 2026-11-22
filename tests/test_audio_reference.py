import asyncio
import base64
import io
import wave
from unittest.mock import patch

from aiohttp import FormData

import server
from test_agent_chat import ChatFixture


class AudioReferences(ChatFixture):
    async def test_uploaded_audio_routes_as_reference_and_is_pinned_to_board_version(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", ""))
            audio.writeframes(b"\x00\x08" * 16000)
        data = FormData()
        data.add_field("file", buffer.getvalue(), filename="对白.wav", content_type="audio/wav")
        upload = await self.client.post("/api/upload_audio", data=data)
        self.assertEqual(upload.status, 200, await upload.text())
        sound = await upload.json()
        self.assertEqual(sound["seconds"], 2)
        self.board["nodes"].append({"id":"n3","type":"audio","name":"对白","data":{},
                                    "versions":[sound, {"ref":"input:h3studio/alternate.wav"}], "cur":1})
        self.board["collaborators"] = {"8":"reviewer"}
        self.board["edges"] = []
        server.write_board(server.board_path("test"), self.board)
        sounds = [{"ref":sound["ref"], "node_id":"n3", "version":1}]
        request = {"kind":"video", "board":"test", "provider":"ark-audio", "audio_refs":sounds,
                   "prompt":"按 @音1 的语调说话。", "duration":5, "ar":1}
        provider = {"id":"ark-audio", "name":"方舟", "enabled":True, "kind":"ark",
                    "config":{}, "secrets":{"api_key":"fixture"}}
        route = {"provider":provider, "model":"doubao-seedance-2-5-fixture"}
        submitted = []

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "GET":
                return {"status":"succeeded", "content":{"video_url":"https://provider.example/result.mp4"}}
            submitted.append(kwargs["json"])
            return {"id":"sound-job"}

        with patch.object(server.providers, "routes", return_value=[route]), \
                patch.object(server.providers, "all_providers", return_value=[]), \
                patch.object(server.remote, "json_req", side_effect=upstream), \
                patch.object(server.remote, "_save_video", return_value={"files":[]}):
            self.assertEqual((await self.client.post("/api/generate", json=request, headers={"X-Uid":"8"})).status, 403)
            self.assertEqual((await self.client.post("/api/generate", json={**request,"audio_refs":[{**sounds[0],"node_id":"n1"}]})).status, 400)
            self.assertEqual((await self.client.post("/api/generate", json={**request,"audio_refs":sounds * 16})).status, 400)
            response = await self.client.post("/api/generate", json=request)
            self.assertEqual(response.status, 200, await response.text())
            jid = (await response.json())["ids"][0]
            for _ in range(300):
                if server.JOBS[jid]["state"] in ("done","error"):
                    break
                await asyncio.sleep(.01)
            self.assertEqual(server.JOBS[jid]["state"], "done", server.JOBS[jid].get("error"))
            text, audio = submitted[0]["content"]
            self.assertIn("@音频1", text["text"])
            self.assertEqual(audio["role"], "reference_audio")
            data_url = audio["audio_url"]["url"]
            self.assertTrue(data_url.startswith("data:audio/wav;base64,"))
            with wave.open(io.BytesIO(base64.b64decode(data_url.split(",",1)[1]))) as rendered:
                self.assertEqual(rendered.getnframes(), 2 * rendered.getframerate())
                self.assertNotEqual(rendered.readframes(100), b"\x00" * 400)
            route["model"] = "doubao-seedance-2-0-fixture"
            self.assertEqual((await self.client.post("/api/generate", json=request)).status, 400)

        self.board["nodes"][-1]["cur"] = 0
        self.board["nodes"].append({"id":"n4","type":"video","data":{},"versions":[],"cur":-1})
        self.board["edges"].append({"from":"n3","to":"n4","relation":"audio_ref","ref":sound["ref"]})
        snapshot = server.public_canvas.capture(self.board, server.COMFY_DIR)
        copied = server.public_canvas.copy_board(snapshot, 8)
        self.assertEqual(copied["nodes"][-2]["versions"][0]["seconds"], 2)
        self.assertEqual(copied["edges"][0]["ref"], sound["ref"])
