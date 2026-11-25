"""Audio generation providers, assistant requests, and retry semantics."""

from types import SimpleNamespace
from unittest.mock import Mock
from unittest.mock import patch
import asyncio
import base64
import json
import wave

import av
import numpy as np

from oneshot.editing import audio_routes
from oneshot.providers import remote_audio
from oneshot.storage import db
import server

from audio_fixture import AudioFixture
from chat_fixture import answer
from chat_fixture import call


class AudioGeneration(AudioFixture):
    async def test_audio_history_and_favorites_restore_only_accessible_seed_references(self):
        missing, available, result = [self.tone()[1] for _ in range(3)]
        user = {"id":7}
        server.grant_media(user,missing,available)
        refs = [{"node_id":f"source-{i}","ref":ref,"kind":"audio"} for i,ref in enumerate((missing,available),1)]
        recipe = {"mode":"seed_audio","prompt":"使用 @音频2","references":refs}
        db.task_start(id="seed-restore",user_id=7,board_id="test",capability="seed_audio",state="done",
                      request={"recipe":recipe},outputs=[result])
        history = "/api/generation-history?kind=audio"
        favorites = "/api/media-favorites"
        before, = (await (await self.client.get(history)).json())["items"]
        self.assertEqual(before["audio_recipe"],recipe)
        starred = await self.client.post(favorites,json={"ref":result,"favorite":True,"audio_recipe":recipe})
        self.assertEqual(starred.status,200,await starred.text())
        db.run("DELETE FROM media_grants WHERE ref=? AND user_id=7",missing)
        for api in (history,favorites+"?kind=audio"):
            item, = (await (await self.client.get(api)).json())["items"]
            self.assertEqual(item["missing_audio_references"],1)
            self.assertEqual(item["audio_recipe"],{"mode":"seed_audio","prompt":"使用 @音频1","references":refs[1:]}
                             if api==history else {"mode":"seed_audio","voice":"","provider":"",
                                                   "prompt":"使用 @音频1","references":refs[1:]})
            self.assertNotIn(missing,json.dumps(item))

    async def test_seed_audio_uses_pinned_audio_and_image_references(self):
        pid = server.providers.save(None,"volc_seed_audio","参考音频",{},{"api_key":"fixture"},True)
        path, ref = self.tone()
        current_path, current_ref = self.tone()
        current_path.write_bytes(path.read_bytes().replace(b"\x00\x04",b"\x10\x03"))
        self.board["nodes"].append({"id":"voice","type":"audio","name":"旧音色","data":{},"versions":[{"ref":ref},{"ref":current_ref}],"cur":1})
        server.write_board(server.board_path("test"),self.board)
        image_ref = self.source["ref"]
        received = []

        async def vendor(_http, method, url, name, **kwargs):
            self.assertEqual((method,url),("POST","https://openspeech.bytedance.com/api/v3/tts/create"))
            self.assertEqual(kwargs["headers"]["X-Api-Key"],"fixture")
            received.append(kwargs["json"])
            return {"audio":base64.b64encode(path.read_bytes()).decode(),"original_duration":3,
                    "subtitle":{"sentences":[{"start_time":100,"end_time":2400,"text":"欢迎登车"}]}}

        audio = {"node_id":"voice","ref":ref}
        image = {"node_id":"n1","ref":image_ref}
        payload = {"mode":"seed_audio","board":"test","provider":pid,"prompt":"参考音色说欢迎登车","subtitles":True,
                   "references":[audio],"request_key":"seed-audio-fixture"}
        api = "/api/audio/generate"
        with patch.object(remote_audio,"json_req",side_effect=vendor):
            for invalid in ({"references":[audio,image]},{"references":[{**audio,"ref":image_ref}]},{"prompt":"采用 @音频2"}):
                self.assertEqual((await self.client.post(api,json={**payload,**invalid})).status,400)
            response = await self.client.post(api,json=payload)
            self.assertEqual(response.status,200,await response.text())
            created = await response.json()
            done = await self.check_job(created["ids"][0],"done")
            self.assertEqual(done["outputs"][0]["extra"]["audio_transcript"]["cues"],[{"start":.1,"end":2.4,"text":"欢迎登车"}])
            self.svc.model.side_effect=[call("audio_generate",{"mode":"seed_audio","provider":pid,"prompt":"欢迎登车",
                                                                 "reference_ids":["n1"]}),answer()]
            await self.wait(await self.send("用选中的参考图配音",selected=["n1"]))
        self.assertEqual(created["recipe"]["references"],[{**audio,"kind":"audio"}])
        self.assertIn("@音频1",received[0]["text_prompt"])
        self.assertEqual(base64.b64decode(received[0]["references"][0]["audio_data"]),path.read_bytes())
        self.assertEqual(received[0]["audio_config"],{"format":"wav","sample_rate":24000,"enable_subtitle":True})
        self.assertEqual(base64.b64decode(received[1]["references"][0]["image_data"]),
                         server.tools.ref_path(server.COMFY_DIR,image_ref).read_bytes())
        assistant_audio = self.load()["nodes"][-1]["versions"][0]
        self.assertEqual(assistant_audio["audio_recipe"]["references"],[{**image,"kind":"image"}])
        self.assertEqual(assistant_audio["generation_record"]["inputs"][0]["ref"],image_ref)
        edge = self.load()["edges"][-1]
        self.assertEqual((edge["relation"],edge["from"],edge["ref"],edge["slot"]),("seed_audio_ref","n1",image_ref,1))
        board = self.load()
        board["nodes"].append({"id":"draft","type":"audio","name":"演示","data":{"mode":"seed_audio",
                                  "references":[{**audio,"kind":"audio"}]},"versions":[],"cur":-1})
        snapshot = server.public_canvas.capture(board,server.COMFY_DIR)
        self.assertNotIn(ref,snapshot["media"])
        self.assertFalse(any(e["to"]=="draft" for e in snapshot["edges"]))
        copy = server.public_canvas.copy_board(snapshot,7)
        copied_audio = next(n for n in copy["nodes"] if n["id"]==edge["to"])
        self.assertEqual(copied_audio["data"]["references"],[{**image,"kind":"image"}])

    async def test_workflow_review_traces_seed_audio_recipe_before_current_connections(self):
        refs = [self.tone()[1] for _ in range(4)]
        reference_list = [{"node_id":"voice","ref":ref,"kind":"audio"} for ref in refs[:2]]
        self.board["nodes"].extend([
            {"id":"voice","type":"audio","name":"人声","data":{},"versions":[{"ref":ref} for ref in refs[:2]],"cur":1},
            {"id":"result","type":"audio","name":"对白","cur":0,"data":{"mode":"seed_audio",
                "references":[{"node_id":"n1","ref":self.source["ref"],"kind":"image"}]},
             "versions":[{"ref":refs[2],"source":"audio_gen",
                 "audio_recipe":{"mode":"seed_audio","prompt":"对照 @音频1 和 @音频2","references":reference_list}},
                 {"ref":refs[3],"source":"audio_gen","audio_recipe":{"mode":"seed_audio","references":[]}}]},
        ])
        self.board["edges"] = server.board_store.seed_audio_edges(self.board)
        server.write_board(server.board_path("test"),self.board)
        api = "/api/board/test/workflow-review?node=result"
        report = await (await self.client.get(api)).json()
        self.assertEqual([(step["node"],step["version"]) for step in report["steps"]],
                         [("voice",1),("voice",2),("result",1)])
        inputs = report["steps"][-1]["inputs"]
        self.assertEqual([(row["ref"],row["token"],row["evidence"]) for row in inputs],
                         [(ref,f"@音频{i}","版本配方") for i,ref in enumerate(refs[:2],1)])
        self.assertIn("音频参考 @音频1 · 人声 版本 1",report["markdown"])
        self.assertNotIn(self.board["nodes"][0]["name"],report["markdown"])
        self.board["nodes"][-1]["cur"] = 1
        server.write_board(server.board_path("test"),self.board)
        latest = await (await self.client.get(api)).json()
        self.assertEqual(latest["steps"][-1]["inputs"],[])

    async def test_audio_delivery_encodes_requested_format_and_keeps_recipe(self):
        _, ref = self.tone()
        p = {"mode":"tts","board":"test","prompt":"配音音频","provider":"kokoro","audio_format":"ogg",
             "sample_rate":48000,"request_key":"audio-delivery-ogg-1"}
        api = "/api/audio/generate"
        async def speak(*_):
            return {"ref":ref}
        with patch.object(audio_routes,"audio_routes",return_value=[self.local]), patch.object(server.tts,"say",side_effect=speak):
            self.assertEqual((await self.client.post(api,json={**p,"sample_rate":44100})).status,400)
            self.assertEqual((await self.client.post(api,json={**p,"audio_format":"flac"})).status,400)
            response = await self.client.post(api,json=p)
            self.assertEqual(response.status,200,await response.text())
            payload = await response.json()
            done = await self.check_job(payload["ids"][0],"done")
            output = done["outputs"][0]
        self.assertNotEqual(output["ref"],ref)
        audio = server.tools.ref_path(server.COMFY_DIR,output["ref"])
        self.assertEqual(audio.suffix,".ogg")
        with av.open(str(audio)) as decoded:
            stream = decoded.streams.audio[0]
            self.assertEqual((stream.rate,stream.codec_context.name,stream.channels),(48000,"opus",1))
            self.assertEqual(sum(frame.samples for frame in decoded.decode(audio=0)),144000)
        self.assertEqual(output["extra"]["audio_recipe"],payload["recipe"])
        history = await (await self.client.get("/api/generation-history?kind=audio")).json()
        self.assertEqual(history["items"][0]["audio_recipe"],payload["recipe"])
        favorite = await self.client.post("/api/media-favorites",json={"ref":output["ref"],"favorite":True,
                                                                     "audio_recipe":payload["recipe"]})
        self.assertEqual(favorite.status,200,await favorite.text())
        starred = await (await self.client.get("/api/media-favorites")).json()
        settings = starred["items"][0]["audio_recipe"]
        self.assertEqual((settings["audio_format"],settings["sample_rate"]),("ogg",48000))

    async def test_audio_effects_change_pitch_and_gain_without_changing_length(self):
        source, ref = self.tone()
        rate, size = 8000, 24001
        samples = (10000*np.sin(np.arange(size)*2*np.pi*350/rate)).astype("<i2")
        with wave.open(str(source),"wb") as wav:
            wav.setparams((1,2,rate,0,"NONE",""))
            wav.writeframes(samples.tobytes())
        payload = {"mode":"tts","board":"test","provider":"kokoro","prompt":"测试音高","pitch_semitones":12,"gain":.5,
                   "request_key":"audio-effects-fixture"}
        async def speak(*_):
            return {"ref":ref}
        with patch.object(audio_routes,"audio_routes",return_value=[self.local]), patch.object(server.tts,"say",side_effect=speak):
            for invalid in ({"pitch_semitones":12.5},{"gain":2.1}):
                self.assertEqual((await self.client.post("/api/audio/generate",json={**payload,**invalid})).status,400)
            response = await self.client.post("/api/audio/generate",json=payload)
            self.assertEqual(response.status,200,await response.text())
            created = await response.json()
            done = await self.check_job(created["ids"][0],"done")
        output = done["outputs"][0]
        path = server.tools.ref_path(server.COMFY_DIR,output["ref"])
        self.assertEqual(path.suffix,".wav")
        with wave.open(str(path),"rb") as wav:
            self.assertEqual((wav.getframerate(),wav.getnframes()),(rate,size))
            pcm = np.frombuffer(wav.readframes(size),dtype="<i2").astype(float)
        middle = pcm[rate:2*rate]
        hz = int(np.argmax(np.abs(np.fft.rfft(middle))))
        self.assertEqual(hz,700)
        self.assertAlmostEqual(np.sqrt(np.mean(middle**2))/np.sqrt(np.mean(samples[rate:2*rate].astype(float)**2)),.5,places=2)
        self.assertEqual((output["extra"]["audio_recipe"]["pitch_semitones"],output["extra"]["audio_recipe"]["gain"]),(12,.5))

    async def test_elevenlabs_voices_and_model_specific_speed(self):
        provider_id = server.providers.save(None,"elevenlabs","配置配音",{},{"api_key":"fixture"},True)
        self.assertFalse(any(row["id"] == provider_id for row in server.audio_service_options("tts")))
        self.assertTrue(any(row["id"] == provider_id for row in server.audio_service_options("sfx")))
        with self.assertRaisesRegex(server.providers.ProviderError, "有效且不重复"):
            server.providers.save(provider_id,"elevenlabs","配置配音",{"voices":"some/voice"}, {}, True)
        config = {"voices":"voice_1=旁白，voice_2=对白"}
        server.providers.save(provider_id,"elevenlabs","配置配音",config,{},True)
        options = next(row for row in server.audio_service_options("tts") if row["id"] == provider_id)
        self.assertEqual(options["voices"],[{"id":"voice_1","name":"旁白"},{"id":"voice_2","name":"对白"}])
        self.assertEqual(options["speed_range"],[.7,1.2])
        wav, _ = self.tone()
        requests = []

        async def chunks(_):
            yield wav.read_bytes()

        class Response:
            async def __aenter__(self):
                return SimpleNamespace(status=200, content_type="audio/mpeg",headers={},
                                       content=SimpleNamespace(iter_chunked=chunks))

            async def __aexit__(self, *_):
                return False

        def post(url, **kwargs):
            requests.append((url,kwargs["json"]))
            return Response()

        remote = server.remote.run
        async def synth(_http, *args):
            return await remote(Mock(post=post), *args)

        api = "/api/audio/generate"
        payload = {"board":"test","mode":"tts","provider":provider_id,"prompt":"火车即将到站",
                   "voice":"voice_2","speed":.8,"request_key":"eleven-tts-check-1"}
        with patch.object(server.remote,"run",side_effect=synth):
            for invalid in ({"voice":"unconfigured"},{"speed":1.3}):
                self.assertEqual((await self.client.post(api,json={**payload,**invalid})).status,400)
            response = await self.client.post(api,json=payload)
            self.assertEqual(response.status,200,await response.text())
            generated = await response.json()
            await self.check_job(generated["ids"][0],"done")
            self.assertEqual(generated["recipe"]["voice"],"voice_2")
            self.assertEqual(generated["recipe"]["speed"],.8)
            server.providers.save(provider_id,"elevenlabs","配置配音",{**config,"models":{"tts":"eleven_v3"}},{},True)
            payload["request_key"] = "eleven-tts-check-2"
            self.assertEqual((await self.client.post(api,json=payload)).status,400)
            response = await self.client.post(api,json={**payload,"speed":1})
            self.assertEqual(response.status,200,await response.text())
            result = await response.json()
            await self.check_job(result["ids"][0],"done")
        url = "https://api.elevenlabs.io/v1/text-to-speech/voice_2"
        self.assertEqual(requests,[
            (url,{"model_id":"eleven_multilingual_v2","text":"火车即将到站","voice_settings":{"speed":.8}}),
            (url,{"model_id":"eleven_v3","text":"火车即将到站"}),
        ])

    async def test_generated_subtitles_are_linked_and_survive_task_recovery(self):
        pid = server.providers.save(None,"elevenlabs","字幕配音",{"voices":"voice_1=旁白"},{"api_key":"fixture"},True)
        wav, _ = self.tone()
        text = "到站。请下车。"
        chars = list(text)
        result = json.dumps({"audio_base64":base64.b64encode(wav.read_bytes()).decode(),
                             "alignment":{"characters":chars,"character_start_times_seconds":[i*.3 for i in range(len(chars))],
                                          "character_end_times_seconds":[(i+1)*.3 for i in range(len(chars))]}}).encode()
        sent = []

        async def chunks(_):
            yield result

        class Response:
            async def __aenter__(self):
                return SimpleNamespace(status=200, content_type="application/json", headers={},
                                       content=SimpleNamespace(iter_chunked=chunks))

            async def __aexit__(self, *_):
                return False

        def post(url, **kwargs):
            self.assertTrue(url.endswith("/text-to-speech/voice_1/with-timestamps"))
            sent.append(kwargs["json"])
            return Response()

        remote = server.remote.run
        async def synth(_http, *args):
            return await remote(Mock(post=post), *args)

        with patch.object(server.remote,"run",side_effect=synth):
            self.svc.model.side_effect=[call("audio_generate",{"mode":"tts","provider":pid,"prompt":text,"subtitles":True,
                                                               "pitch_semitones":-3,"gain":1.3}),answer()]
            await self.wait(await self.send("生成配音和字幕",selected=[]))
        self.assertEqual(len(sent),1)
        board = self.load()
        audio = next(n for n in board["nodes"] if n["type"]=="audio")
        version = audio["versions"][0]
        subtitle = next(n for n in board["nodes"] if n["name"].endswith("字幕"))
        cues = [{"start":0,"end":.9,"text":"到站。"},{"start":.9,"end":2.1,"text":"请下车。"}]
        self.assertEqual(subtitle["data"]["transcript"]["cues"],cues)
        self.assertEqual(subtitle["data"]["transcript"]["source_ref"],version["ref"])
        self.assertEqual(board["edges"][-1],{"from":audio["id"],"to":subtitle["id"],"relation":"transcript","source_ref":version["ref"]})
        task = db.one("SELECT * FROM tasks WHERE capability='tts'")
        server.JOBS.pop(task["id"],None)
        recovered = server.restore_logged_job(self.app,task)
        self.assertEqual(recovered["outputs"][0]["extra"]["audio_transcript"]["cues"],cues)
        history = await (await self.client.get("/api/generation-history?kind=audio")).json()
        self.assertEqual(history["items"][0]["audio_transcript"],version["audio_transcript"])

    async def test_sound_effects_generate_restore_and_regenerate(self):
        provider = {"id":"sfx-test","name":"测试音效","kind":"elevenlabs","config":{},
                    "secrets":{"api_key":"fixture"}, "enabled":True}
        route = {"provider":provider,"model":"eleven_text_to_sound_v3","voices":[]}
        tone, _ = self.tone()
        submissions = []

        async def chunks(size):
            self.assertEqual(size, 65536)
            yield tone.read_bytes()

        class Response:
            async def __aenter__(self):
                return SimpleNamespace(status=200,content_type="audio/mpeg",headers={"character-cost":"21"},
                                       content=SimpleNamespace(iter_chunked=chunks))

            async def __aexit__(self, *_):
                return False

        def post(url, **kwargs):
            self.assertEqual(url, "https://api.elevenlabs.io/v1/sound-generation")
            self.assertEqual(kwargs["headers"], {"xi-api-key":"fixture"})
            self.assertFalse(kwargs["allow_redirects"])
            submissions.append(kwargs["json"])
            return Response()

        remote = server.remote.run
        async def synth(_http, *args):
            return await remote(Mock(post=post), *args)

        payload = {"board":"test","mode":"sfx","provider":"sfx-test","prompt":"车窗雨声","duration_seconds":8,
                   "loop":True,"prompt_influence":0,"request_key":"sound-effect-test-1"}
        with patch.object(audio_routes,"audio_routes",side_effect=lambda mode:[route] if mode=="sfx" else []), \
                patch.object(server.remote,"run",side_effect=synth):
            for invalid in ({"duration_seconds":.2},{"prompt_influence":1.2},{"loop":1}):
                self.assertEqual((await self.client.post("/api/audio/generate",json={**payload,**invalid})).status,400)
            response = await self.client.post("/api/audio/generate", json=payload)
            self.assertEqual(response.status,200,await response.text())
            created = await response.json()
            self.assertEqual(await (await self.client.post("/api/audio/generate",json=payload)).json(),created)
            done = await self.check_job(created["ids"][0],"done")
            self.assertEqual(done["outputs"][0]["meta"]["duration"],3)
            self.assertEqual(db.one("SELECT units FROM tasks WHERE id=?",created["ids"][0])["units"],21)
            history = await (await self.client.get("/api/generation-history?type=audio")).json()
            self.assertEqual(history["items"][0]["audio_recipe"],created["recipe"])
            self.svc.model.side_effect=[call("audio_generate",{"mode":"sfx","prompt":"软雨声","loop":True}),answer()]
            await self.wait(await self.send("生成音效",selected=[]))
            node = self.load()["nodes"][-1]
            self.assertEqual(node["versions"][0]["audio_recipe"]["mode"],"sfx")
            self.svc.model.side_effect=[call("audio_generate",{"node_id":node["id"],"duration_seconds":6}),answer()]
            await self.wait(await self.send("改为 6 秒", "sound-request-02", [node["id"]]))
            updated = self.load()["nodes"][-1]
            self.assertEqual(updated["id"],node["id"])
            self.assertEqual(len(updated["versions"]),2)
            self.assertEqual(updated["versions"][-1]["audio_recipe"]["duration_seconds"],6)
        self.assertEqual(submissions[0],{"model_id":"eleven_text_to_sound_v3","text":"车窗雨声","duration_seconds":8,
                                         "loop":True,"prompt_influence":0})
        self.assertNotIn("duration_seconds",submissions[1])
        self.assertEqual((submissions[2]["duration_seconds"],submissions[2]["loop"]),(6,True))

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
        with patch.object(audio_routes,"audio_routes",return_value=[self.local]),patch.object(server.tts,"say",side_effect=speak) as mock:
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

        with patch.object(audio_routes,"audio_routes",side_effect=lambda mode:[self.music] if mode=="music" else [self.local]), \
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

        with patch.object(audio_routes,"audio_routes",return_value=[self.music]), patch.object(server.remote,"run",side_effect=synth):
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
