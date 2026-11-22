import asyncio
import io
import wave
from unittest.mock import patch

import db
import server
from test_agent_chat import ChatFixture, answer, call


class AudioGeneration(ChatFixture):
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

    async def test_separation_keeps_both_stems_aligned_and_restores_the_receipt(self):
        _, ref = self.tone()
        _, newer = self.tone()
        self.board["collaborators"] = {"8":"reviewer"}
        self.board["nodes"].append({"id":"n3","type":"audio","name":"原声","versions":[{"ref":ref},{"ref":newer}],"cur":1})
        server.write_board(server.board_path("test"),self.board)
        opened, release = asyncio.Event(), asyncio.Event()
        module = server.audio_separation
        calls = []

        async def separate_mix(binary, mix, folder, cancelled):
            calls.append(binary)
            with wave.open(str(mix),"rb") as wav:
                self.assertEqual((wav.getnchannels(),wav.getframerate(),wav.getnframes()),(2,44100,44100))
                count = wav.getnframes()
            opened.set()
            await release.wait()
            stem_dir = folder / module.MODEL / mix.stem
            stem_dir.mkdir(parents=True)
            for value, stem in enumerate(module.STEMS,1):
                with wave.open(str(stem_dir/(stem+".wav")),"wb") as wav:
                    wav.setparams((2,2,44100,0,"NONE",""))
                    wav.writeframes(bytes([value,0,value,0])*count)

        payload = {"board":"test","node":"n3","ref":ref,"start":.5,"end":1.5,"request_key":"separate-request-one"}
        url = "/api/audio/separate"
        binding = {key:payload[key] for key in ("board","node","ref")}
        with patch.object(module,"executable",return_value="/tmp/demucs"), patch.object(module,"demix",side_effect=separate_mix):
            self.assertEqual((await self.client.post(url,json=payload,headers={"X-Uid":"8"})).status,403)
            self.assertEqual((await self.client.post(url,json={**payload,"ref":self.source["ref"]})).status,400)
            self.assertEqual((await self.client.post(url,json={**payload,"end":9})).status,400)
            submitted = await self.client.post(url,json=payload)
            self.assertEqual(submitted.status,200,await submitted.text())
            receipt = await submitted.json()
            await asyncio.wait_for(opened.wait(),1)
            self.assertEqual(await (await self.client.post(url,json=payload)).json(),receipt)
            self.assertEqual(await (await self.client.post(url,json={**payload,"request_key":"separate-request-duplicate"})).json(),receipt)
            different = await self.client.post(url,json={**payload,"end":2,"request_key":"separate-request-other"})
            self.assertEqual(different.status,409)
            latest = await (await self.client.get(url,params=binding)).json()
            self.assertEqual(latest,{"available":True,"latest":receipt})
            release.set()
            jid = receipt["id"]
            completed = await self.check_job(jid,"done")
            self.assertEqual(calls,["/tmp/demucs"])
            self.assertEqual(receipt["range"],{"start":.5,"end":1.5})
            self.assertEqual([o["extra"]["stem"] for o in completed["outputs"]],list(module.STEMS))
            self.assertEqual([o["meta"]["duration"] for o in completed["outputs"]],[1,1])
            server.JOBS.pop(jid)
            restored = await (await self.client.get("/api/jobs",params={"ids":jid})).json()
            self.assertEqual([o["extra"]["stem"] for o in restored[jid]["outputs"]],list(module.STEMS))
            self.assertEqual([o["meta"]["duration"] for o in restored[jid]["outputs"]],[1,1])
            self.assertEqual(self.load()["nodes"][-1]["cur"],1)
            self.svc.model.side_effect = [call("audio_separate",{"node_id":"n3","start":.5,"end":1.5}),answer()]
            message = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json={
                "text":"分离这段人声与伴奏","request_key":"assistant-separation-test",
                "selected":["n3"],"selected_versions":[{"node_id":"n3","ref":ref}]})
            self.assertEqual(message.status,200,await message.text())
            run = await self.wait((await message.json())["id"])
            self.assertEqual(run["state"],"done",run["error"])
            board = self.load()
            nodes = board["nodes"][-2:]
            self.assertEqual([n["type"] for n in nodes],["audio","audio"])
            self.assertEqual([n["versions"][0]["audio_separation"]["stem"] for n in nodes],list(module.STEMS))
            self.assertEqual([e["source_ref"] for e in board["edges"] if e["relation"]=="audio_separation"],[ref,ref])
            self.assertEqual([n["cur"] for n in board["nodes"] if n["id"]=="n3"],[1])

    async def test_canvas_transcript_extracts_owned_audio_range_and_falls_back_to_text(self):
        _, ref = self.tone()
        self.board["collaborators"] = {"8":"reviewer"}
        self.board["nodes"].append({"id":"n3","type":"audio","versions":[{"ref":ref}],"cur":0})
        server.write_board(server.board_path("test"), self.board)
        route = {"provider":{"id":"asr"},"model":"whisper-1"}
        submitted = []

        async def recognize(_http, _provider, _model, wav, extension, kind, *, timed=False):
            submitted.append(timed)
            self.assertEqual((extension,kind),(".wav","audio/wav"))
            with wave.open(io.BytesIO(wav)) as audio:
                self.assertEqual(audio.getnframes(),audio.getframerate())
                self.assertEqual(audio.getnchannels(),1)
            if len(submitted) == 1:
                return [{"start":.25,"end":.75,"text":" 第一条 "}]
            if timed:
                raise server.providers.ProviderError("没有时间码")
            return "纯文本台词"

        url = "/api/audio/transcript"
        request = {"board":"test","node":"n3","ref":ref,"in":1,"out":2}
        with patch.object(server.providers,"routes",return_value=[route]), patch.object(server.providers,"transcribe",side_effect=recognize):
            self.assertEqual((await self.client.post(url,json=request,headers={"X-Uid":"8"})).status,403)
            self.assertEqual((await self.client.post(url,json={**request,"ref":self.source["ref"]})).status,400)
            self.assertEqual((await self.client.post(url,json={**request,"out":4})).status,400)
            response = await self.client.post(url,json=request)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(await response.json(),{"text":"第一条","captions":[{"start":1.25,"end":1.75,"text":"第一条"}],"start":1,"end":2})
            fallback = await (await self.client.post(url,json=request)).json()
            self.assertEqual((fallback["text"],fallback["captions"]),("纯文本台词",[]))
        self.assertEqual(submitted,[True,True,False])

    async def test_audio_captions_follow_the_trimmed_track_in_exported_video(self):
        import av
        import numpy as np

        _, ref = self.tone()
        track = {"ref":ref,"start":1,"in":.5,"out":1.5,"volume":1,
                 "captions":[{"start":.75,"end":2,"text":"旁白字幕"}]}
        still = {"ref":self.source["ref"],"kind":"image","duration":2,"subs":["镜头字幕"]}
        spec = {"clips":[{**still,"trans":"fade"},still],"audio_clips":[track]}
        self.assertTrue(server.film_preflight(spec)["ok"])
        invalid = {**track,"captions":[{"start":2,"end":1,"text":"倒序"}]}
        self.assertEqual(server.film_preflight({**spec,"audio_clips":[invalid]})["issues"][0]["audio"],0)

        def overlay(text, width, _height, _size):
            color = (20,210,20,255) if text == "旁白字幕" else (20,20,210,255)
            return np.tile(np.array(color,dtype=np.float32),(12,width,1)), 0

        with patch.object(server.film,"subtitle_overlay",side_effect=overlay):
            rendered = await asyncio.to_thread(server.film.render, server.COMFY_DIR, spec)
        path = server.tools.ref_path(server.COMFY_DIR,rendered["ref"])
        with av.open(str(path)) as media:
            frames = [frame.to_ndarray(format="rgb24")[5,16] for frame in media.decode(video=0)]
        for at, channel in ((1.0,2),(1.25,1),(1.75,1),(2.25,2)):
            actual = frames[round(at * server.film.FPS)]
            self.assertGreater(actual[channel],150, f"unexpected subtitle at {at}: {actual}")

    async def test_audio_cut_keeps_selected_pieces_and_can_be_retried(self):
        path, ref = self.tone()
        with wave.open(str(path),"wb") as source:
            source.setparams((1,2,8000,0,"NONE",""))
            for value in (8000,0,-8000):
                source.writeframes(value.to_bytes(2,"little",signed=True) * 8000)
        original = path.read_bytes()
        self.board["collaborators"] = {"8":"reviewer"}
        self.board["nodes"].append({"id":"n3","type":"audio","versions":[{"ref":ref}],"cur":0})
        server.write_board(server.board_path("test"), self.board)
        payload = {"board":"test","node":"n3","ref":ref,"ranges":[{"start":.25,"end":.75},{"start":2.25,"end":2.75}]}
        url = "/api/audio/cut"
        self.assertEqual((await self.client.post(url,json=payload,headers={"X-Uid":"8"})).status,403)
        self.assertEqual((await self.client.post(url,json={**payload,"ranges":payload["ranges"][::-1]})).status,400)
        self.assertEqual((await self.client.post(url,json={**payload,"ranges":[{"start":2,"end":4}]})).status,400)
        response = await self.client.post(url,json=payload)
        self.assertEqual(response.status,200,await response.text())
        data = await response.json()
        self.assertEqual(data["seconds"],1)
        self.assertEqual(data["ranges"],[{"start":.25,"end":.75,"at":0},{"start":2.25,"end":2.75,"at":.5}])
        self.assertEqual(await (await self.client.post(url,json=payload)).json(),data)
        output = await self.client.get(data["url"])
        self.assertEqual(output.status,200)
        with wave.open(io.BytesIO(await output.read())) as audio:
            rate = audio.getframerate()
            self.assertEqual(audio.getnframes(),rate)
            for at,sign in ((.25,1),(.75,-1)):
                audio.setpos(round(at*rate))
                self.assertGreater(sign * int.from_bytes(audio.readframes(1)[:2],"little",signed=True),1000)
        self.assertEqual(path.read_bytes(),original)

    async def test_speech_requests_are_idempotent_cancelable_and_readable_after_restart(self):
        self.board["collaborators"]={"8":"reviewer"}
        self.board["nodes"].append({"id":"n3","type":"audio","data":{},"versions":[],"cur":-1})
        server.write_board(server.board_path("test"),self.board)
        release=asyncio.Event()

        async def speak(_root, prompt, voice, speed):
            self.assertEqual((prompt,voice,speed),("你好，\n欢迎登车。","zf_001",.8))
            await release.wait()
            return {"ref":self.tone()[1]}

        base={"board":"test","node":"n3","mode":"tts","provider":"kokoro","prompt":"你好，\n欢迎登车。","speed":.8,
              "request_key":"first-speech-attempt"}
        path="/api/audio/generate"
        with patch.object(server,"audio_routes",return_value=[self.local]),patch.object(server.tts,"say",side_effect=speak) as mock:
            self.assertEqual((await self.client.post(path,json=base,headers={"X-Uid":"8"})).status,403)
            self.assertEqual((await self.client.post(path,json={**base,"voice":"not-present"})).status,400)
            result=await self.client.post(path,json=base)
            self.assertEqual(result.status,200,await result.text())
            jid=(await result.json())["ids"][0]
            await self.check_job(jid,"running")
            self.assertEqual((await (await self.client.post(path,json=base)).json())["ids"],[jid])
            self.assertEqual((await self.client.post(path,json={**base,"prompt":"different"})).status,409)
            self.assertEqual((await self.client.post(path,json={**base,"request_key":"parallel-submission"})).status,409)
            release.set()
            done=await self.check_job(jid,"done")
            self.assertEqual(mock.await_count,1)
            self.assertEqual(done["outputs"][0]["meta"]["duration"],3)
            self.assertEqual((await self.client.get(done["outputs"][0]["url"])).status,200)
            server.JOBS.pop(jid)
            replay=await (await self.client.get("/api/jobs?ids="+jid)).json()
            self.assertEqual(replay[jid]["outputs"][0]["meta"]["duration"],3)

            release.clear()
            second=await (await self.client.post(path,json={**base,"request_key":"second-speech-attempt"})).json()
            active=second["ids"][0]
            await self.check_job(active,"running")
            await self.client.post("/api/cancel",json={"ids":[active]})
            release.set()
            await asyncio.sleep(.02)
            self.assertEqual(db.one("SELECT state FROM tasks WHERE id=?",active)["state"],"error")
            self.assertFalse(server.JOBS[active].get("outputs"))

    async def test_assistant_music_and_regeneration_keep_one_audio_node(self):
        requests=[]

        async def remote_synth(_http,_root,_provider,model,cap,payload):
            self.assertEqual((model,cap),("music-fixture","music"))
            requests.append(payload)
            path,ref=self.tone()
            return {"files":[{"path":path,"ref":ref,"kind":"audio"}]}

        with patch.object(server,"audio_routes",side_effect=lambda mode:[self.music] if mode=="music" else [self.local]), \
                patch.object(server.remote,"run",side_effect=remote_synth):
            self.svc.model.side_effect=[call("audio_generate",{"mode":"music","prompt":"慢拍爵士","name":"站台配乐"}),answer()]
            await self.wait(await self.send("生成站台配乐",selected=[],placement={"x":-420,"y":-180}))
            node=self.load()["nodes"][-1]
            self.assertEqual((node["x"],node["y"]),(-420,-180))
            self.svc.model.side_effect=[call("audio_generate",{"node_id":node["id"],"prompt":"提速一点","lyrics":"列车来了"}),answer()]
            await self.wait(await self.send("在原音频加歌词","regenerate-audio",[node["id"]]))
        self.assertEqual(requests,[{"prompt":"慢拍爵士","lyrics":""},{"prompt":"提速一点","lyrics":"列车来了"}])
        nodes=self.load()["nodes"]
        self.assertEqual(len(nodes),3)
        self.assertEqual(nodes[-1]["id"],node["id"])
        self.assertEqual(nodes[-1]["type"],"audio")
        self.assertEqual((nodes[-1]["x"],nodes[-1]["y"]),(-420,-180))
        self.assertEqual([v["source"] for v in nodes[-1]["versions"]],["audio_gen"]*2)
        self.assertEqual([v["audio_recipe"]["lyrics"] for v in nodes[-1]["versions"]],["","列车来了"])

    async def test_assistant_music_retry_reuses_failed_placeholder(self):
        submitted = []

        async def synth(_http,_root,_provider,model,cap,payload):
            submitted.append((model,cap,payload))
            if len(submitted) == 1:
                raise ValueError("合成失败")
            path,ref = self.tone()
            return {"files":[{"path":path,"ref":ref,"kind":"audio"}]}

        with patch.object(server,"audio_routes",return_value=[self.music]), patch.object(server.remote,"run",side_effect=synth):
            self.svc.model.side_effect = [call("audio_generate",{"mode":"music","prompt":"慢拍爵士","lyrics":"到站了"}),answer()]
            await self.wait(await self.send("生成音乐",selected=[]))
            failed = self.load()["nodes"][-1]
            self.assertTrue(failed["agent_error"])
            state = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            cid = next(e["data"]["call_id"] for e in state["events"] if e["kind"] == "tool_end" and e["data"].get("retry_count"))
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/calls/{cid}/retry",json={})
            self.assertEqual(response.status,200,await response.text())
            retry = await self.wait((await response.json())["id"])
            self.assertEqual(retry["state"],"done",retry["error"])
        self.assertEqual(submitted, [("music-fixture","music",{"prompt":"慢拍爵士","lyrics":"到站了"})]*2)
        nodes = self.load()["nodes"]
        self.assertEqual(len(nodes),3)
        self.assertEqual(nodes[-1]["id"],failed["id"])
        self.assertEqual(nodes[-1]["versions"][0]["source"],"audio_gen")
        self.assertNotIn("agent_error",nodes[-1])
