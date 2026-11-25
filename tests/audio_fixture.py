"""Pinned source audio and generated job assertions for integration tests."""

import asyncio
import wave

import server

from chat_fixture import ChatFixture


class AudioFixture(ChatFixture):
    def setUp(self):
        self.local = {"provider":{"id":"kokoro","kind":"local_kokoro","name":"本地声音"},
                      "model":"kokoro-fixture","voices":[{"id":"zf_001","name":"自然女声"}]}
        self.music = {"provider":{"id":"minimax","kind":"minimax","name":"音乐服务"},
                      "model":"music-fixture","voices":[]}

    def tone(self):
        path, ref = server.film._new(server.COMFY_DIR,"output","tone",".wav")
        with wave.open(str(path),"wb") as out:
            out.setparams((1,2,8000,0,"NONE",""))
            out.writeframes(b"\x00\x04" * 24000)
        return path, ref

    async def check_job(self, jid, state):
        for _ in range(280):
            j = server.JOBS[jid]
            if j["state"] == state:
                return j
            if j["state"] == "error":
                self.fail(j.get("error"))
            await asyncio.sleep(.01)
        self.fail(f"Job did not reach {state}")
