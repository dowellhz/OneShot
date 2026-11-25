"""Assistant video generation, reference routing, pending results, and inspection."""

from unittest.mock import AsyncMock, patch
import asyncio
import base64
import io
import json
import wave

from PIL import Image
from aiohttp import web

from oneshot.assistant import agent_video
from oneshot.editing import image_editor
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import prompts
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call, db_row
from video_fixture import make_video


class VideoIntegration(ChatFixture):
    async def test_agent_can_change_automatic_assets_between_shots_and_keep_explicit_view(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        hero = store.put(user,{"board":"test","kind":"character","name":"林森","character_view":"main",
                              "ref":self.source["ref"],"source_board":"test","node_id":"n1"})
        station = store.put(user,{"board":"test","kind":"scene","name":"车站","desc":"旧车站有蓝色顶棚"})
        bridge = store.put(user,{"board":"test","kind":"scene","name":"小桥","desc":"桥下是浅水"})
        seen = []

        async def submit(req,payload):
            seen.append(payload)
            sequence = len(seen)
            jid = f"e{sequence:012x}"
            if payload["kind"] == "video":
                video = make_video()
                ref, meta = video["ref"], {"width":video["w"],"height":video["h"],"duration":video["seconds"]}
            else:
                ref = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,48),(0,sequence,0)))["ref"]
                meta = {"width":64,"height":48}
            server.JOBS[jid] = {"id":jid,"state":"done","created":1,"meta":{"uid":7},"outputs":[{"ref":ref,"meta":meta}]}
            return web.json_response({"ids":[jid]})

        self.svc.model.side_effect = [
            call("memory_use",{"memory_ids":[station["id"]]},"choose-station"),
            call("image_generate",{"prompt":"人物在站台等车","name":"车站镜头"},"make-station"),
            call("memory_use",{"mode":"replace","memory_ids":[bridge["id"]]},"choose-bridge"),
            call("image_generate",{"prompt":"人物来到桥上","name":"小桥镜头"},"make-bridge"),
            call("memory_use",{"mode":"replace","memory_ids":[]},"clear-reference"),
            call("video_generate",{"prompt":"人物向镜头挥手","name":"挥手镜头","duration":5},"make-video"),
            answer(),
        ]
        explicit = "@{"+hero["id"]+"#main|林森}"
        with patch.object(generation_requests,"_generate_request",submit):
            rid = await self.send(text=f"用 {explicit} 做三段测试镜头")
            row = await self.wait(rid)
        self.assertEqual(row["state"],"done",row.get("error"))
        self.assertEqual([item["kind"] for item in seen],["image","image","video"])
        self.assertEqual([[a["id"] for a in item["memory_used"]] for item in seen],
                         [[hero["id"],station["id"]],[hero["id"],bridge["id"]],[hero["id"]]])
        self.assertTrue(all(item["memory_used"][0]["references"]==[{"view":"main","ref":hero["ref"]}] for item in seen))
        self.assertNotIn("蓝色顶棚",seen[1]["prompt"])
        self.assertNotIn("浅水",seen[2]["prompt"])
        data = json.loads(row["data"])
        self.assertEqual(data["explicit_memory_ids"],[hero["id"]])
        self.assertEqual(data["memory_ids"],[hero["id"]])
        versions = [node["versions"][-1] for node in self.load()["nodes"] if node["name"] in
                    ("车站镜头","小桥镜头","挥手镜头")]
        self.assertEqual([[asset["name"] for asset in version["memory_used"]] for version in versions],
                         [["林森","车站"],["林森","小桥"],["林森"]])

    async def test_auto_reference_route_checks_canvas_audio_and_asset_audio_together(self):
        user = {"id":7,"role":"member"}
        short,long = "ep-mixed-short","ep-mixed-long"
        provider = server.providers.save(None,"ark","混合素材模型",{"models":{"video":short},
            "video_endpoint_models":f"{short} seedance-2.0\n{long} seedance-2.5"},{"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":short}])
        clips = []
        for name,seconds in (("canvas-audio",11),("asset-audio",7)):
            path,ref = server.film._new(server.COMFY_DIR,"input",name,".wav")
            with wave.open(str(path),"wb") as recording:
                recording.setparams((1,2,8000,0,"NONE",""))
                recording.writeframes(b"\x08\x00"*(seconds*8000))
            server.grant_media(user,ref)
            clips.append((path,ref,seconds))
        board = self.load()
        board["nodes"].append({"id":"canvas-sound","type":"audio","name":"现场声","data":{},"cur":0,
                               "versions":[{"ref":clips[0][1],"seconds":11}]})
        server.write_board(server.board_path("test"),board)
        self.app["creative_memory"].put(user,{"board":"test","name":"环境声","kind":"scene","ref":clips[1][1],
                                               "generation_media":[clips[1][1]]})
        args = {"duration":8,"prompt":"根据画布声音和 @环境声 制作镜头",
                "audio_refs":[{"node_id":"canvas-sound"}],"frames":[{"node_id":"n1","role":"subject"}]}
        result = make_video(72)

        async def generate(_http,_root,service,model,_cap,request,**_):
            self.assertEqual((service["id"],model,request["duration"]),(provider,long,8))
            self.assertEqual(request["audio_refs"],[(path,0,seconds) for path,_,seconds in clips])
            return {"files":[{**result,"kind":"video","path":server.tools.ref_path(server.COMFY_DIR,result["ref"])}]}

        self.svc.model.side_effect = [call("video_generate",args),answer()]
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        with patch.object(server.remote,"run",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"混合两段音频生成",
                "request_key":"auto-mixed-audio","generation_mode":"manual"})
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            review = approval["plan"]["reference_review"]
            self.assertEqual(review["model"],long)
            self.assertEqual([(entry["ref"],entry["end"]) for entry in review["inputs"] if entry["role"]=="audio_ref"],
                             [(ref,seconds) for _,ref,seconds in clips])
            submit.assert_not_called()
            approved = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual(approved.status,200,await approved.text())
            await self.wait(rid)
            submit.assert_awaited_once()
            self.svc.model.side_effect = [
                call("video_generate",{**args,"provider":provider,"selected_model":short}),answer(),
            ]
            attempt = await self.send("指定短模型生成",key="explicit-mixed-audio")
            await self.wait(attempt)
            error = db.one("SELECT result FROM chat_calls WHERE run_id=?",attempt)["result"]
            self.assertIn("参考音频总时长不能超过 15 秒",error)
            submit.assert_awaited_once()

    async def test_asset_only_audio_uses_compatible_model_beyond_the_plain_route_limit(self):
        user = {"id":7,"role":"member"}
        plain = server.providers.save(None,"kling","短视频模型",{}, {},True)
        model = "ep-asset-long"
        reference = server.providers.save(None,"ark","长视频参考模型",{"models":{"video":model},
            "video_endpoint_models":f"{model} seedance-2.5","generation_rates":f"video {model} 4k 0.25"},
            {"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":plain,"model":"kling-2.6"},{"provider_id":reference,"model":model}])
        audio,ref = server.film._new(server.COMFY_DIR,"input","assistant-asset-audio",".wav")
        with wave.open(str(audio),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x08\x00"*(5*8000))
        server.grant_media(user,ref)
        self.app["creative_memory"].put(user,{"board":"test","name":"环境声","kind":"scene","ref":ref,
            "generation_media":[ref],"generation_audio_ranges":{ref:[1,4]}})
        result = make_video()

        async def generate(_http,_root,provider,selected,_cap,request,**_):
            self.assertEqual((provider["id"],selected,request["duration"],request["quality"]),(reference,model,20,"4k"))
            self.assertEqual(request["audio_refs"],[(audio,1,3)])
            return {"files":[{**result,"kind":"video","path":server.tools.ref_path(server.COMFY_DIR,result["ref"])}]}

        self.svc.model.side_effect = [
            call("video_generate",{"duration":20,"quality":"4k","prompt":"按 @环境声 生成入场镜头"}),answer(),
        ]
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        with patch.object(server.remote,"run",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"用声音素材生成20秒镜头",
                "request_key":"asset-only-long-video","generation_mode":"manual"})
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["reference_review"]["model"],model)
            self.assertEqual((approval["plan"]["reference_review"]["duration"],approval["plan"]["unit_cost"]),(20,5))
            submit.assert_not_called()
            path = f"/api/chat/runs/{rid}/approvals/"
            adjusted = await self.client.post(path+approval["id"],json={"decision":"adjust","parameters":{"prompt":"普通空镜"}})
            revised = (await adjusted.json())["approval_id"]
            for _ in range(100):
                plan = (await self.pending_generation(rid))["plan"]
                if plan.get("reference_error"):
                    break
                await asyncio.sleep(.02)
            self.assertIn("最长 10 秒",plan.get("reference_error",""))
            self.assertEqual((await self.client.post(path+revised,json={"decision":"approve"})).status,409)
            adjusted = await self.client.post(path+revised,json={"decision":"adjust","parameters":{"prompt":"采用 @环境声"}})
            revised = (await adjusted.json())["approval_id"]
            for _ in range(100):
                plan = (await self.pending_generation(rid))["plan"]
                if plan.get("reference_review"):
                    break
                await asyncio.sleep(.02)
            self.assertEqual((await self.client.post(path+revised,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            submit.assert_awaited_once()
        video = next(n for n in self.load()["nodes"] if n["type"]=="video")
        self.assertEqual(video["versions"][0]["video_recipe"]["selected_model"],model)
        self.assertEqual((video["versions"][0]["video_recipe"]["audio_refs"][0]["start"],
                          video["versions"][0]["video_recipe"]["audio_refs"][0]["end"]),(1,4))

    async def test_direct_motion_review_uses_native_samples_from_the_pinned_versions(self):
        older, current, following = make_video(30), make_video(220), make_video(120)
        board = self.load()
        board["nodes"].extend([
            {"id":"story","type":"script","name":"连续镜头","data":{
                "shots":[{"id":"first"},{"id":"second"}],
                "made":[{"shot_id":"first","vid":"left"},{"shot_id":"second","vid":"right"}]},"versions":[],"cur":-1},
            {"id":"left","type":"video","name":"前镜","data":{},"versions":[older,current],"cur":1},
            {"id":"right","type":"video","name":"本镜","data":{},"versions":[following],"cur":0},
        ])
        path = server.board_path("test")
        server.write_board(path,board)
        baseline = path.read_text()
        files = set(server.COMFY_DIR.rglob("*"))
        request = {"text":"检查动作衔接","request_key":"native-motion-review","enqueue":True,
                   "shot_review":{"node_id":"story","shot":2,"current_type":"video",
                       "left":{"node":"left","ref":older["ref"],"version":1},
                       "right":{"node":"right","ref":following["ref"],"version":1}}}
        vision = AsyncMock(return_value="两个镜头的动作需要接在同一位置。")
        with patch.object(self.app["llm"],"available",return_value=True), patch.object(self.app["llm"],"chat",vision,create=True):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json=request)
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])["shot_review"]
        self.assertEqual([result[side]["ref"] for side in ("left","right")],[older["ref"],following["ref"]])
        self.assertEqual([len(result["samples"][side]) for side in ("left","right")],[3,3])
        pixels = []
        for part in vision.await_args.args[1]:
            if part["type"]!="image_url":
                continue
            encoded = part["image_url"]["url"].split(",",1)[1]
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
                pixels.append(image.getpixel((32,32)))
        self.assertEqual(len(pixels),6)
        self.assertTrue(all(abs(pixel[2]-30)<8 for pixel in pixels[:3]),pixels)
        self.assertTrue(all(abs(pixel[2]-120)<8 for pixel in pixels[3:]),pixels)
        for side in (pixels[:3],pixels[3:]):
            reds = [pixel[0] for pixel in side]
            self.assertEqual(reds,sorted(set(reds)))
        self.svc.model.assert_not_awaited()
        self.assertEqual(path.read_text(),baseline)
        self.assertEqual(set(server.COMFY_DIR.rglob("*")),files)

    async def test_video_generate_routes_as_video_and_creates_playable_video_node(self):
        video = make_video()
        received = []
        async def submit(req, raw):
            received.append(raw)
            server.JOBS["e123456789012"] = {"state": "done", "created": 1, "meta": {"uid": 7, "seed": 42},
                "outputs": [{"ref": video["ref"], "meta": {"width": 64, "height": 64, "duration": 2}}]}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "camera slowly moves", "frames": [{"node_id": "n1", "role": "first"}], "duration": 5, "quality": "std"}), answer()]
        with patch.object(generation_requests, "generate_request", side_effect=submit):
            rid = await self.send("生成视频")
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(received[0]["kind"], "video")
        self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])
        node = self.load()["nodes"][-1]
        self.assertEqual(node["type"], "video")
        self.assertEqual(node["versions"][0]["seconds"], 2)
        self.assertEqual(node["versions"][0]["video_recipe"]["kind"], "video")
        self.assertEqual(node["versions"][0]["video_recipe"]["seed"], 42)
        self.assertTrue(any(e["from"] == "n1" and e["to"] == node["id"] for e in self.load()["edges"]))
        result = json.loads(db_row(rid)["result"])
        self.assertEqual(result["media_type"], "video")
        self.assertEqual(node["versions"][0]["video_recipe"]["seed"], 42)
        self.assertEqual(self.load()["edges"], [{"from": "n1", "to": node["id"], "role": "first"}])
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["edges"], [])
        self.assertEqual(len(self.load()["nodes"]), 2)
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["edges"], [])
        self.assertEqual(len(self.load()["nodes"]), 2)

    async def test_pending_video_is_connected_before_completion_and_finishes_in_place(self):
        video = make_video()
        started, finish = asyncio.Event(), asyncio.Event()
        async def submit(req, raw):
            return web.json_response({"ids": ["e123456789012"]})
        async def jobs(req):
            started.set()
            return web.json_response({"e123456789012": {"state": "done" if finish.is_set() else "running", "phase": "sampling",
                "meta": {"seed": 42}, "outputs": [{"ref": video["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "move", "frames": [{"node_id": "n1", "role": "first"}]}), answer()]
        with patch.object(generation_requests, "generate_request", side_effect=submit), patch.object(generation_jobs, "jobs", side_effect=jobs):
            rid = await self.send("生成视频")
            await started.wait()
            b = self.load();pending = b["nodes"][-1];nid = pending["id"]
            self.assertEqual(pending["type"], "video")
            self.assertFalse(pending["versions"])
            self.assertEqual(pending["job"]["ids"], ["e123456789012"])
            self.assertTrue(pending["job"]["agent_call"])
            self.assertEqual(b["edges"], [{"from": "n1", "to": nid, "role": "first"}])
            # A normal canvas save can omit transient status; the server still owns completion.
            response=await self.client.put("/api/board/test",json=b)
            self.assertEqual(response.status,200)
            finish.set()
            self.assertEqual((await self.wait(rid))["state"],"done")
        final=self.load();self.assertEqual(len(final["nodes"]),3)
        self.assertEqual(final["nodes"][-1]["id"],nid)
        self.assertIsNone(final["nodes"][-1]["job"])
        self.assertEqual(len(final["nodes"][-1]["versions"]),1)
        self.assertEqual((await self.client.post(f"/api/chat/runs/{rid}/undo",json={})).status,200)
        self.assertEqual(len(self.load()["nodes"]),2)

    async def test_deleted_pending_video_is_not_recreated(self):
        video = make_video()
        ready, finish = asyncio.Event(), asyncio.Event()
        async def submit(*_):return web.json_response({"ids":["e123456789012"]})
        async def jobs(req):
            ready.set()
            return web.json_response({"e123456789012":{"state":"done" if finish.is_set() else "running","meta":{},"outputs":[{"ref":video["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect=[call("video_generate",{"prompt":"move","frames":[{"node_id":"n1"}]}),answer()]
        with patch.object(generation_requests,"generate_request",side_effect=submit),patch.object(generation_jobs,"jobs",side_effect=jobs):
            rid=await self.send();await ready.wait()
            b=self.load();b["nodes"]=b["nodes"][:-1];b["edges"]=[]
            await self.client.put("/api/board/test",json=b);finish.set();await self.wait(rid)
        self.assertEqual(len(self.load()["nodes"]),2)

    async def test_planned_three_keyframes_times_are_retained(self):
        rid = await self.send()
        await self.wait(rid)
        from oneshot.storage import db
        run = db.one("SELECT * FROM chat_runs WHERE id=?", rid);run["data"] = json.loads(run["data"])
        payload = agent_video.plan_payload(self.svc, run, {"id": 7, "role": "member"}, [
            {"node_id": "n1", "role": "first"}, {"node_id": "n1", "role": "keyframe", "time": 2}, {"node_id": "n1", "role": "last"}], 5, {}, "move")
        self.assertTrue(payload["planned"])
        self.assertEqual(payload["images"][0]["time"], 0)
        self.assertEqual(payload["images"][1]["time"], 2)
        self.assertGreater(payload["images"][2]["time"], 4.8)

    async def test_image_result_cannot_be_saved_as_video(self):
        async def submit(req, raw):
            server.JOBS["e123456789012"] = {"state": "done", "created": 1, "meta": {"uid": 7}, "outputs": [{"ref": self.source["ref"]}]}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "move"}), answer()]
        with patch.object(generation_requests, "generate_request", side_effect=submit):
            rid = await self.send("生成视频")
            await self.wait(rid)
        self.assertIn("error", json.loads(db_row(rid)["result"]))
        failed=self.load()["nodes"][-1]
        self.assertEqual(failed["type"],"video")
        self.assertFalse(failed["versions"])
        self.assertIsNone(failed["job"])
        self.assertTrue(failed["agent_error"])

    async def test_video_describe_reads_actual_video_frames(self):
        b = self.load()
        b["nodes"].append({"id": "n3", "type": "video", "name": "视频", "x": 0, "y": 0, "data": {}, "versions": [make_video()], "cur": 0})
        server.board_path("test").write_text(json.dumps(b))
        self.svc.model.side_effect = [call("media_describe", {"node_id": "n3"}), answer()]
        with patch.object(prompts, "describe", AsyncMock(return_value=web.json_response({"text": "实际视频画面"}))) as describe:
            rid = await self.send("看视频", selected=["n3"])
            await self.wait(rid)
            request = await describe.await_args.args[0].json()
            self.assertGreaterEqual(len(request["images"]), 3)
        self.assertEqual(json.loads(db_row(rid)["result"])["media_type"], "video")
