"""Assistant generation previews, approval, and target selection."""

from unittest.mock import AsyncMock, patch
import asyncio
import json
import wave

from PIL import Image
from aiohttp import web

from oneshot.editing import audio_routes
from oneshot.editing import image_editor
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.providers import catalog as providers
from oneshot.storage import db
from oneshot.web import media as media_routes
import server

from chat_fixture import ChatFixture, answer, call


class ChatGenerationApproval(ChatFixture):
    async def test_manual_node_can_select_configured_route_models(self):
        provider = {"id":"ark-models","name":"测试方舟","kind":"ark","enabled":True,
                    "config":{"models":{"image":"image-default","video":"doubao-seedance-2-0-fixture"},
                              "motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        image_model = "image-alternate"
        reference_model = "doubao-seedance-2-5-fixture"
        routes = {"image":[{"provider":provider,"model":image_model}],
                  "video":[{"provider":provider,"model":reference_model}]}
        draft = {"kind":"video","provider":provider["id"],"board":"test",
                 "prompt":"按 @音1 的节奏。","audio_refs":[{"ref":"input:h3studio/sound.wav"}],
                 "selected_model":reference_model}
        send = AsyncMock(side_effect=lambda *_args, **_kwargs: web.json_response({"ids":[]}))
        with patch.object(server.providers,"get",return_value=provider), patch.object(
            server.providers,"all_providers",return_value=[provider]
        ), patch.object(server.providers,"routes",side_effect=lambda cap:routes.get(cap,[])), patch.object(
            remote_jobs,"generate_remote",send
        ), patch.object(video_reference,"resolve_audio_refs",AsyncMock(return_value=[("source.wav",0,4)])):
            capabilities = json.loads((await server.capabilities(None)).body)
            self.assertEqual(capabilities["image"][0]["default_route_model"],image_model)
            self.assertEqual([m["id"] for m in capabilities["image"][0]["models"]],["image-default",image_model])
            self.assertEqual([m["id"] for m in capabilities["audio_reference"][0]["models"]],
                             [reference_model,"doubao-seedance-2-0-fixture"])
            self.assertEqual([m["id"] for m in capabilities["segment_edit"][0]["models"]],[reference_model])
            image = {"kind":"image","prompt":"画一条走廊","provider":provider["id"],"selected_model":image_model}
            response = await self.client.post("/api/generate",json=image)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(send.call_args.args[2]["model"],image_model)
            response = await self.client.post("/api/preview",json=draft)
            self.assertEqual(response.status,200,await response.text())
            self.assertIn(reference_model,(await response.json())["mode"])
            response = await self.client.post("/api/generate",json=draft)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(send.call_args.args[2]["model"],reference_model)
            for request in (image,draft):
                response = await self.client.post("/api/generate",json={**request,"selected_model":"unconfigured"})
                self.assertEqual(response.status,400,await response.text())
            self.assertEqual(send.await_count,2)

    async def test_generation_cost_uses_the_selected_route_model_and_duration(self):
        video = providers.save(None,"kling","Video fixture",{"generation_rates":"video kling-2.6 hd 0.25"}, {}, True)
        providers.set_route("video",[{"provider_id":video,"model":"kling-2.6"}])
        image = providers.save(None,"ark","Image fixture",{"generation_rates":"image custom-image 0.125",
            "models":{"image":"custom-image"}}, {}, True)
        reference_model = "doubao-seedance-2-5-fixture"
        reference = providers.save(None,"ark","Reference fixture",{"generation_rates":f"video {reference_model} 4k 0.5",
            "models":{"video":reference_model},"motion_origin":"https://studio.example"},{"api_key":"fixture"},True)
        audio_reference = providers.save(None,"ark","Audio reference fixture",{"generation_rates":f"video {reference_model} 4k 1",
            "models":{"video":reference_model}},{"api_key":"fixture"},True)
        with self.assertRaisesRegex(providers.ProviderError,"重复"):
            providers.save(image,"ark","Image fixture",{"generation_rates":"image custom-image 1\nimage custom-image 2"}, {}, True)
        video_request = {"kind":"video","duration":8,"quality":"hd","count":2}
        media_request = {**video_request,"provider":reference,"selected_model":reference_model,"quality":"4k",
                         "video_refs":True,"audio_refs":True,"prompt":"按 @视频{123} 和 @音频1 的节奏"}
        requests = [
            video_request, {**video_request,"quality":"std"}, {**video_request,"video_refs":True},
            {"kind":"image","provider":image,"selected_model":"custom-image","count":4},
            {"kind":"image","provider":image,"selected_model":"unavailable"},
            {"kind":"image","count":2},
            {**video_request,"prompt":"照着 @图1 构图"},
            media_request,
            {**media_request,"prompt":"按 @林森 和 @视频1"},
            {**media_request,"previs_guide":True,"duration":15},
            {**media_request,"provider":audio_reference,"previs_guide":False,"video_refs":False,"prompt":"按 @音频1 的节奏"},
        ]
        response = await self.client.post("/api/generation-cost",json={"requests":requests})
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["amounts"],[5,None,None,.5,None,0,5,8,None,None,16])
        self.assertFalse(server.JOBS)
        self.assertFalse(db.q("SELECT id FROM tasks"))

    async def test_manual_generation_waits_and_recovers_across_worker_restart(self):
        provider = providers.save(None,"ark","Image fixture",{"generation_rates":"image custom-image 0.125"}, {}, True)
        providers.set_route("image",[{"provider_id":provider,"model":"custom-image"}])
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        self.svc.model.side_effect = [call("image_generate",{"prompt":"先审阅这张海报","count":1}),answer(),answer()]
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))

        async def generate(_req, payload):
            jid = "e000000001001"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]*payload["count"]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"生成海报","request_key":"manual-confirm","generation_mode":"manual"})
            self.assertEqual(response.status,200)
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["prompt"],"先审阅这张海报")
            self.assertEqual(approval["plan"]["count"],1)
            self.assertEqual(approval["plan"]["unit_cost"],.125)
            submit.assert_not_awaited()
            original_url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            for parameters in ({"count":5},{"count":True},{"provider":"unexpected"},{"prompt":"   "}):
                invalid = await self.client.post(original_url,json={"decision":"adjust","parameters":parameters})
                self.assertEqual(invalid.status,400)
            adjusted = await self.client.post(original_url,json={"decision":"adjust","parameters":{"count":2,"prompt":"  改成暖色海报  "}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            approval = await self.pending_generation(rid)
            self.assertEqual((approval["plan"]["count"],approval["plan"]["prompt"]),(2,"改成暖色海报"))
            self.assertEqual(approval["plan"]["unit_cost"],.125)
            self.assertEqual((await self.client.post(original_url,json={"decision":"approve"})).status,409)
            submit.assert_not_awaited()
            queued = await self.client.post(endpoint,json={"text":"继续","request_key":"after-approval","enqueue":True})
            task = (await queued.json())
            self.assertEqual(task["state"],"queued")
            self.svc.closing = True
            worker = self.svc.tasks[rid]
            worker.cancel()
            await asyncio.gather(worker,return_exceptions=True)
            self.svc.closing = False
            self.svc.launch(rid)
            self.assertEqual((await self.pending_generation(rid))["id"],approval["id"])
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"approve"},headers={"X-Uid":"8"})).status,404)
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.client.post(url,json={"decision":"skip"})).status,409)
            await self.wait(rid)
            await self.wait(task["id"])
            submit.assert_awaited_once()
            self.assertEqual((submit.await_args.args[1]["count"],submit.await_args.args[1]["prompt"]),(2,"改成暖色海报"))
        self.assertEqual(len(self.load()["nodes"]),4)
        self.assertEqual(self.load()["nodes"][-1]["versions"][0]["prompt"],"改成暖色海报")

    async def test_video_approval_reviews_adjusted_assets_and_stops_when_they_change(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        asset = store.put(user,{"board":"test","name":"站台参考","kind":"scene","ref":self.source["ref"],"source_board":"test"})
        audio, sound = server.film._new(server.COMFY_DIR,"input","approval-sound",".wav")
        with wave.open(str(audio),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x08"*16000)
        server.grant_media(user,sound)
        store.put(user,{"id":asset["id"],"ref":sound,"generation_media":[self.source["ref"],sound]})
        model = "doubao-seedance-2-5-fixture"
        default_provider = providers.save(None,"kling","普通镜头",{"generation_rates":"video kling-2.6 hd 0.1"}, {}, True)
        provider = providers.save(None,"ark","方舟测试",{"generation_rates":f"video {model} 480p 0.25"},{"api_key":"test"},True)
        providers.set_route("video",[{"provider_id":default_provider,"model":"kling-2.6"},{"provider_id":provider,"model":model}])
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        pending = asyncio.Event()
        refresh = asyncio.Event()
        original_review = server.asset_reference_review

        async def review(req,payload):
            if payload["prompt"].startswith("改为"):
                pending.set()
                await refresh.wait()
            return await original_review(req,payload)

        self.svc.model.side_effect = [call("video_generate",{"prompt":"空镜头","duration":5}),answer()]
        with patch.object(video_reference,"asset_reference_review",side_effect=review),patch.object(remote_jobs,"start_remote") as submit:
            started = await self.client.post(endpoint,json={"text":"生成空镜头","request_key":"asset-review-edit","generation_mode":"manual"})
            rid = (await started.json())["id"]
            approval = await self.pending_generation(rid)
            url = f"/api/chat/runs/{rid}/approvals/"
            self.assertIsNone(approval["plan"]["reference_review"])
            self.assertEqual(approval["plan"]["unit_cost"],.5)
            adjusted = await self.client.post(url+approval["id"],json={"decision":"adjust","parameters":{"prompt":"改为 @站台参考"}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            revised = (await adjusted.json())["approval_id"]
            await asyncio.wait_for(pending.wait(),2)
            self.assertIsNone((await self.pending_generation(rid))["plan"]["unit_cost"])
            blocked = await self.client.post(url+revised,json={"decision":"approve"})
            self.assertEqual(blocked.status,409)
            refresh.set()
            for _ in range(100):
                approval = await self.pending_generation(rid)
                if approval["plan"].get("reference_review"):
                    break
                await asyncio.sleep(.02)
            shown = approval["plan"]["reference_review"]
            self.assertEqual(approval["plan"]["unit_cost"],1.25)
            self.assertNotIn("key",shown)
            self.assertEqual((shown["provider"],shown["model"],shown["duration"]),("方舟测试","doubao-seedance-2-5-fixture",5))
            self.assertEqual([(entry["role"],entry.get("end")) for entry in shown["inputs"]],[("subject",None),("audio_ref",2)])
            store.put(user,{"id":asset["id"],"generation_media":[self.source["ref"]]})
            self.assertEqual((await self.client.post(url+revised,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            submit.assert_not_called()
            self.assertIn("参考素材已变化",db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])

        store.put(user,{"id":asset["id"],"generation_media":[self.source["ref"],sound]})
        self.svc.model.side_effect = [call("video_generate",{"prompt":"参考 @站台参考","duration":5}),answer()]

        def finish_placeholder(_app,job,*args,**kwargs):
            job.update(state="done",outputs=[])

        with patch.object(remote_jobs,"start_remote",side_effect=finish_placeholder) as submit:
            started = await self.client.post(endpoint,json={"text":"生成有站台声的镜头","request_key":"asset-review-unchanged",
                                                           "generation_mode":"manual"})
            rid = (await started.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["reference_review"]["assets"],["站台参考"])
            response = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual(response.status,200,await response.text())
            await self.wait(rid,timeout=5)
            submit.assert_called_once()
            self.assertEqual(submit.call_args.args[-1]["audio_refs"],[(audio,0,2)])
            self.assertEqual(submit.call_args.args[-1]["quality"], "480p")

    async def test_image_approval_shows_edited_asset_references_and_blocks_stale_submission(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        face = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))
        b = self.load()
        b["nodes"][0]["versions"].append(face)
        server.write_board(server.board_path("test"),b)
        asset = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                               "source_board":"test","character_view":"main","desc":"蓝衣"})
        store.put(user,{"id":asset["id"],"ref":face["ref"],"source_board":"test","character_view":"face"})
        prompt = "画 @{"+asset["id"]+"#face|林森} 的头肩特写"
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        seen = []

        async def submit(_req,payload):
            seen.append(payload)
            jid = "e000000124001"
            output = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"green"))
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[output]}
            return web.json_response({"ids":[jid]})

        async def start(key, text):
            self.svc.model.side_effect = [call("image_generate",{"prompt":text,"reference_ids":["n1"]}),answer()]
            response = await self.client.post(endpoint,json={"text":"生成海报","request_key":key,"generation_mode":"manual"})
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            return rid,await self.pending_generation(rid)

        with patch.object(generation_requests,"_generate_request",submit):
            rid, approval = await start("image-asset-adjust","只有场景")
            review = approval["plan"]["reference_review"]
            self.assertEqual(review["assets"],[])
            self.assertEqual([(entry["ref"],entry["version"]) for entry in review["inputs"]],[(self.source["ref"],1)])
            url = f"/api/chat/runs/{rid}/approvals/"
            adjusted = await self.client.post(url+approval["id"],json={"decision":"adjust","parameters":{"prompt":prompt}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            revised = (await adjusted.json())["approval_id"]
            for _ in range(100):
                plan = (await self.pending_generation(rid))["plan"]
                if (plan.get("reference_review") or {}).get("assets"):
                    break
                await asyncio.sleep(.02)
            review = plan["reference_review"]
            self.assertEqual(review["assets"],["林森（正面头肩）"])
            self.assertEqual([(entry["ref"],entry.get("memory_view")) for entry in review["inputs"]],
                             [(self.source["ref"],None),(face["ref"],"face")])
            self.assertNotIn("key",review)
            store.put(user,{"id":asset["id"],"desc":"红衣"})
            self.assertEqual((await self.client.post(url+revised,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            self.assertEqual(seen,[])
            self.assertIn("参考素材或生成服务已变化",db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            rid, approval = await start("image-asset-confirmed",prompt)
            b = self.load()
            b["nodes"][0]["cur"] = 1
            server.write_board(server.board_path("test"),b)
            decision = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual(decision.status,200,await decision.text())
            await self.wait(rid)
        self.assertEqual(len(seen),1)
        self.assertEqual([entry["ref"] for entry in seen[0]["images"]],[self.source["ref"],face["ref"]])
        self.assertIn("红衣",seen[0]["prompt"])

    async def test_smart_generation_skips_extra_submission_without_spending_budget(self):
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        self.svc.model.side_effect = [call("image_generate",{"prompt":"两张草稿","count":2}),
                                      call("image_generate",{"prompt":"再生成一张"},"next"),answer()]
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))

        async def generate(_req, payload):
            jid = "e000000001002"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]*payload["count"]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"生成画面","request_key":"smart-confirm","generation_mode":"smart"})
            self.assertEqual(response.status,200)
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["prompt"],"再生成一张")
            submit.assert_awaited_once()
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"skip"})).status,200)
            run = await self.wait(rid)
            self.assertEqual(json.loads(run["data"])["generated"],2)
            submit.assert_awaited_once()

    async def test_empty_image_node_receives_generated_candidates_in_place(self):
        self.board["nodes"].append({"id":"empty","type":"image","name":"封面","x":800,"y":120,
                                    "data":{},"versions":[],"cur":-1,"job":None})
        server.write_board(server.board_path("test"),self.board)
        media = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))
        async def submit(req, payload):
            ids = [f"e{i:012}" for i in range(payload["count"])]
            for jid in ids:
                server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},
                                    "outputs":[{"ref":media["ref"],"meta":{"width":128,"height":96}}]}
            return web.json_response({"ids":ids})
        self.svc.model.side_effect = [call("image_generate",{"prompt":"电影感夜景","count":2}),answer()]
        route = f"/api/chat/sessions/{self.sid}/messages"
        payload = {"text":"生成两张封面","request_key":"target-image-1","selected":["empty"],"empty_media_node":"empty"}
        with patch.object(generation_requests,"generate_request",submit):
            response = await self.client.post(route,json=payload)
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            finished = await self.wait(rid)
            self.assertEqual(finished["state"],"done",finished["error"])
        loaded = self.load()["nodes"]
        self.assertEqual([node["id"] for node in loaded],["n1","n2","empty"])
        self.assertEqual([v["ref"] for v in loaded[-1]["versions"]],[media["ref"],media["ref"]])
        self.assertEqual((await self.client.post(route,json={**payload,"request_key":"target-image-2"})).status,400)

    async def test_empty_video_and_audio_nodes_receive_generation_in_place(self):
        for kind in ("video","audio"):
            self.board["nodes"].append({"id":kind,"type":kind,"name":kind,"x":800,"y":120,
                                        "data":{},"versions":[],"cur":-1,"job":None})
        server.write_board(server.board_path("test"),self.board)
        video_ref, audio_ref = "output:h3studio/target.mp4", "output:h3studio/target.wav"
        def job(jid, ref):
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[{"ref":ref}]}
            return [jid]
        async def submit_video(req, payload):
            return web.json_response({"ids":job("e000000000001",video_ref)})
        async def submit_audio(req):
            request = await req.json()
            self.assertEqual(request["node"],"audio")
            return web.json_response({"ids":job("e000000000002",audio_ref),
                                      "recipe":{"mode":"tts","prompt":request["prompt"]}})
        with patch.object(generation_requests,"generate_request",submit_video), patch.object(audio_routes,"generate_audio",submit_audio), \
             patch.object(media_routes,"media_info",return_value={"width":128,"height":96,"duration":2}):
            for kind, ref in (("video",video_ref),("audio",audio_ref)):
                with self.subTest(kind=kind):
                    self.svc.model.side_effect = [call(kind+"_generate",{"prompt":"雨夜"}),answer()]
                    route = f"/api/chat/sessions/{self.sid}/messages"
                    response = await self.client.post(route,json={"text":"开始生成","request_key":"target-"+kind,
                                                                 "selected":[kind],"empty_media_node":kind})
                    self.assertEqual(response.status,200,await response.text())
                    finished = await self.wait((await response.json())["id"])
                    self.assertEqual(finished["state"],"done",finished["error"])
                    nodes = {node["id"]:node for node in self.load()["nodes"]}
                    self.assertEqual(set(nodes),{"n1","n2","video","audio"})
                    self.assertEqual(nodes[kind]["versions"][0]["ref"],ref)

    async def test_generate_real_handler_shape_and_continue(self):
        made = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        received = []

        async def submit(req, payload):
            received.append(payload)
            for i in range(payload["count"]):
                jid = "e" + str(i).zfill(12)
                server.JOBS[jid] = {"state": "done", "created": 1, "meta": {"uid": 7, "seed": 42},
                                    "outputs": [{"ref": made["ref"], "meta": {"width": 128, "height": 96}}]}
            return web.json_response({"ids": list(server.JOBS)})

        self.svc.model.side_effect = [call("image_generate", {"prompt": "暖色产品图", "reference_ids": ["n1"], "count": 3}), answer("三个版本已生成")]
        with patch.object(generation_requests, "generate_request", submit):
            rid = await self.send(placement={"x":-500,"y":-300})
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])
        self.assertEqual(len(self.load()["nodes"]), 5)
        results = [n for n in self.load()["nodes"] if n["id"] not in ("n1", "n2")]
        self.assertEqual(len({n["id"] for n in results}), 3)
        self.assertEqual((results[0]["x"],results[0]["y"]),(-500,-300))
        for first, second in zip(results, results[1:]):
            self.assertGreaterEqual(second["x"],first["x"]+self.svc.placement_size(first)[0])
            self.assertEqual(second["y"],first["y"])
        receipt = results[0]["versions"][0]["generation_record"]
        self.assertEqual(receipt["prompt"], "暖色产品图")
        self.assertEqual(receipt["inputs"][0]["node_id"], "n1")
        self.assertEqual(receipt["inputs"][0]["version"], 1)
        self.svc.model.side_effect = [call("image_transform", {"node_id": results[1]["id"], "rotate": 90}, "rotate"), answer()]
        rid2 = await self.send("第二张旋转一下", "request002", [], placement={"x":2000,"y":2000})
        self.assertEqual((await self.wait(rid2))["state"], "done")
        self.assertEqual(len(self.load()["nodes"]), 5)
        modified = next(n for n in self.load()["nodes"] if n["id"] == results[1]["id"])
        self.assertEqual(len(modified["versions"]), 2)
        self.assertEqual((modified["x"],modified["y"]),(results[1]["x"],results[1]["y"]))

    async def test_selected_version_is_frozen(self):
        gate = asyncio.Event()

        async def delayed(*_):
            await gate.wait()
            return call("image_transform", {"node_id": "n1", "rotate": 90})

        self.svc.model.side_effect = [delayed, answer()]
        async def first_then_answer(messages, run):
            if not gate.is_set():
                return await delayed()
            return answer()
        self.svc.model.side_effect = first_then_answer
        rid = await self.send()
        await asyncio.sleep(.01)
        b = self.load()
        other = image_editor.save(server.COMFY_DIR, Image.new("RGB", (200, 100), "blue"))
        b["nodes"][0]["versions"].append(other)
        b["nodes"][0]["cur"] = 1
        await self.client.put("/api/board/test", json=b)
        gate.set()
        await self.wait(rid)
        out = self.load()["nodes"][0]["versions"][-1]
        self.assertEqual((out["w"], out["h"]), (96, 128))
