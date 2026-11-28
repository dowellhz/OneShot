"""Assistant video regeneration and extension with pinned inputs and routes."""

from unittest.mock import AsyncMock, patch
import asyncio
import copy
import json

from PIL import Image
from aiohttp import web

from oneshot.assistant import agent_chat
from oneshot.editing import image_editor
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import reference as video_reference
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call, db_row
from video_fixture import make_video


class AssistantVideoRegeneration(ChatFixture):
    async def test_video_models_and_historical_regeneration_keep_the_selected_route(self):
        endpoint,flash = "ep-assistant-main","ep-assistant-fast"
        provider = server.providers.save(None,"ark","方舟模型",{"models":{"video":flash},
            "video_endpoint_models":f"{endpoint} seedance-2.5\n{flash} seedance-2.5-flash"},{"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":flash}])
        outputs = [make_video(blue) for blue in (42,84,126)]
        used = []

        async def generate(_http,_root,service,model,_cap,request,**_):
            used.append((service["id"],model,request["quality"],request["duration"]))
            output = outputs[len(used)-1]
            return {"files":[{**output,"kind":"video","path":server.tools.ref_path(server.COMFY_DIR,output["ref"])}]}

        self.svc.model.side_effect = [
            call("video_models",{"mode":"audio_reference"},"list"),
            call("video_generate",{"provider":provider,"selected_model":endpoint,"duration":20,"quality":"4k","prompt":"开场"},"make"),
            answer(),
        ]
        with patch.object(server.remote,"run",side_effect=generate):
            run = await self.send("查看模型，用方舟的 2.5 接入点生成视频",key="choose-video-model")
            await self.wait(run)
            calls = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",run)]
            choices = calls[0]["providers"][0]["models"]
            self.assertEqual({model["id"] for model in choices},{endpoint,flash})
            self.assertTrue(next(model for model in choices if model["id"]==endpoint)["draft"])
            nid = calls[1]["nodes"][0]["id"]
            board = self.load()
            node = next(node for node in board["nodes"] if node["id"]==nid)
            self.assertEqual(node["versions"][0]["video_recipe"]["selected_model"],endpoint)
            self.assertEqual(node["versions"][0]["node_data"]["selected_model"],endpoint)
            first = node["versions"][0]
            for key in ("video_recipe","node_data"):
                first[key].pop("provider",None)
                first[key].pop("selected_model",None)
            first["generation_record"]["settings"].pop("provider",None)
            node["data"]["selected_model"] = flash
            server.write_board(server.board_path("test"),board)
            self.svc.model.side_effect = [
                call("video_regenerate",{"node_id":nid,"version":1,"prompt":"保留模型，调整动作"}),answer(),
            ]
            await self.wait(await self.send("沿用第一版模型重生成",key="historical-video-model"))
            self.svc.model.side_effect = [
                call("video_regenerate",{"node_id":nid,"version":1,"provider":provider,"selected_model":flash,
                    "quality":"std","prompt":"改用快速模型"}),answer(),
            ]
            await self.wait(await self.send("改用快速模型",key="override-video-model"))
        self.assertEqual(used,[(provider,endpoint,"4k",20),(provider,endpoint,"4k",20),(provider,flash,"std",20)])
        node = next(node for node in self.load()["nodes"] if node["id"]==nid)
        self.assertEqual([item["video_recipe"].get("selected_model") for item in node["versions"]],[None,endpoint,flash])

    async def test_historical_regeneration_uses_the_recorded_asset_view_after_new_approval(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        face = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))["ref"]
        replacement = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"green"))["ref"]
        board = self.load()
        board["nodes"][0]["versions"].extend([{"ref":face},{"ref":replacement}])
        server.write_board(server.board_path("test"),board)
        asset = store.put(user,{"name":"林森","kind":"character","board":"test","source_board":"test",
                                "ref":self.source["ref"],"character_view":"main"})
        store.put(user,{"id":asset["id"],"source_board":"test","ref":face,"character_view":"face"})
        background = store.put(user,{"name":"城市设定","kind":"document","board":"test","desc":"雨夜列车停运"})
        usage = [{"memory_id":asset["id"],"views":["face"]}]
        prepared = store.prepare(user,{"board":"test","kind":"video","prompt":"近景","memory_views":usage,
                                      "memory_ids":[asset["id"],background["id"]]})
        old = make_video()
        store.track(user,prepared,{"ids":["old-job"]})
        store.observe(user,{"old-job":{"state":"done","outputs":[old]}})
        board["nodes"].append({"id":"old-video","type":"video","name":"旧镜头","data":{"prompt":"近景"},
            "versions":[{**old,"memory_used":prepared["memory_used"],"video_recipe":prepared}],"cur":0})
        server.write_board(server.board_path("test"),board)
        route = f"/api/memory/{asset['id']}/impact?board=test"
        before = await (await self.client.get(route)).json()
        self.assertEqual(before["canvas"],[])
        store.put(user,{"id":asset["id"],"source_board":"test","ref":replacement,"character_view":"face"})
        store.put(user,{"id":background["id"],"desc":"所有列车照常运行"})
        after = await (await self.client.get(route)).json()
        self.assertEqual(after["canvas"][0]["views"],[{"view":"face","previous":face,"reference":replacement}])
        received = []

        async def submit(_, payload):
            received.append(payload)
            jid = f"e{len(received):012d}"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[make_video()]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"_generate_request",submit):
            for key, options, expected in (
                ("preserve-original",{"reuse_asset_references":True},face),
                ("use-current",{},replacement),
            ):
                self.svc.model.side_effect = [call("video_regenerate",{"node_id":"old-video","version":1,**options}),answer()]
                rid = await self.send("重新生成视频",key=key,selected=["old-video"])
                self.assertEqual((await self.wait(rid))["state"],"done")
                self.assertEqual([item["ref"] for item in received[-1]["images"]], [expected])
                self.assertIn("雨夜列车停运" if expected==face else "所有列车照常运行",received[-1]["prompt"])
                self.assertEqual([item["id"] for item in received[-1]["memory_used"]],[asset["id"],background["id"]])
            self.svc.model.side_effect = [call("video_regenerate",{"node_id":"old-video","version":1,
                "prompt":"空站台的远景","memory_ids":[]}),answer()]
            rid = await self.send("清除旧素材，重新生成",key="clear-assets",selected=["old-video"])
            self.assertEqual((await self.wait(rid))["state"],"done")
            self.assertFalse(received[-1].get("memory_used"))
            self.assertEqual(received[-1]["images"],[])
        versions = self.load()["nodes"][-1]["versions"]
        self.assertEqual([v["memory_used"][0]["references"][0]["ref"] for v in versions[:3]],
                         [face,face,replacement])
        self.assertEqual(versions[-1]["memory_used"],[])

    async def test_generation_and_regeneration_keep_the_explicit_first_frame_version(self):
        current = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        board = self.load()
        source = board["nodes"][0]
        source["versions"].append(current)
        source["cur"] = 1
        server.write_board(server.board_path("test"), board)
        received = []

        async def submit(req, raw):
            received.append(raw)
            ref = make_video()["ref"]
            jid = f"e{len(received):012d}"
            server.JOBS[jid] = {"state":"done", "created":1, "meta":{"uid":7},
                                "outputs":[{"ref":ref, "meta":{"width":64, "height":64, "duration":2}}]}
            return web.json_response({"ids":[jid]})

        self.svc.model.side_effect = [
            call("video_generate", {"prompt":"camera slowly moves", "frames":[{"node_id":"n1", "role":"first"}]}),
            answer(),
        ]
        with patch.object(generation_requests, "generate_request", side_effect=submit):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={
                "text":"用第一版图片生成视频", "request_key":"pin-first-frame", "selected":["n1"],
                "selected_versions":[{"node_id":"n1", "ref":self.source["ref"]}],
            })
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual((await self.wait((await response.json())["id"]))["state"], "done")
            saved = self.load()
            video = saved["nodes"][-1]
            expected = [{"from":"n1", "to":video["id"], "role":"first", "ref":self.source["ref"]}]
            self.assertEqual(saved["edges"], expected)
            self.assertEqual(video["versions"][0]["input_edges"], expected)
            self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])

            self.svc.model.side_effect = [call("video_regenerate", {"node_id":video["id"]}), answer()]
            rid = await self.send("重新生成视频", key="reuse-first-frame", selected=[video["id"]])
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(received[1]["images"][0]["ref"], self.source["ref"])
        saved = self.load()
        self.assertEqual(saved["edges"], expected)
        self.assertEqual([v["input_edges"] for v in saved["nodes"][-1]["versions"]], [expected, expected])

    async def test_local_extension_captures_the_selected_source_version_and_preserves_the_anchor(self):
        old, latest = make_video(), make_video()
        b = self.load()
        b["nodes"].append({"id":"n3","type":"video","name":"原片","x":500,"y":0,"data":{},
                           "versions":[old,latest],"cur":1})
        server.write_board(server.board_path("test"),b)
        received = []

        async def submit(req, raw):
            received.append(raw)
            job = f"e{len(received):012d}"
            server.JOBS[job] = {"state":"done","created":1,"meta":{"uid":7},
                "outputs":[{"ref":latest["ref"],"meta":{"width":64,"height":64,"duration":2}}]}
            return web.json_response({"ids":[job]})

        server.providers.seed()
        local = server.providers.get("local_h3")
        with patch.object(video_reference,"reference_routes",return_value=[]), patch.object(server.providers,"all_providers",return_value=[local]), \
                patch.object(generation_requests,"generate_request",side_effect=submit):
            for direction, position, role in (("after","last","first"),("before","first","last")):
                self.svc.model.side_effect = [
                    call("video_extend",{"node_id":"n3","version":1,"direction":direction,"duration":2.4,"prompt":"列车靠站"}),
                    call("video_extend",{"node_id":"n3","version":1,"direction":direction,"method":"frame","prompt":"再次接拍"},"extension-extra"),
                    answer(),
                ]
                rid = await self.send("用本地服务接拍",f"local-extension-{direction}",["n3"])
                await self.wait(rid)
                saved = self.load()
                image, result = saved["nodes"][-2:]
                self.assertEqual(image["versions"][0]["capture"]["source_ref"],old["ref"])
                self.assertEqual(image["versions"][0]["capture"]["position"],position)
                self.assertIn({"from":"n3","to":image["id"],"relation":"capture","source_ref":old["ref"],
                               "at":image["versions"][0]["capture"]["at"]},saved["edges"])
                self.assertEqual(result["versions"][0]["input_edges"][0]["role"],role)
                payload = received[-1]
                self.assertNotIn("video_refs",payload)
                self.assertEqual(payload["provider"],local["id"])
                self.assertEqual(payload["images"][0]["time"] == 0,direction=="after")
                engine, _ = server.engine_body(payload)
                self.assertEqual(engine["frames"],124)
                if direction=="before":
                    self.assertEqual(engine["keyframes"][0]["frame"],engine["frames"]-4)
                rejected = agent_chat.db.one("SELECT result FROM chat_calls WHERE run_id=? ORDER BY updated DESC LIMIT 1",rid)
                self.assertIn("新消息会加入队列",json.loads(rejected["result"])["error"])
            self.assertEqual(len(received),2)
            self.svc.model.side_effect = [call("video_regenerate",{"node_id":result["id"],"prompt":"更慢地靠站"}),answer()]
            await self.wait(await self.send("修改续拍", "local-extension-regenerate", [result["id"]]))
            final = self.load()["nodes"][-1]
            self.assertEqual(final["id"],result["id"])
            self.assertEqual(len(final["versions"]),2)
            self.assertEqual(received[-1]["images"][0]["ref"],image["versions"][0]["ref"])

    async def test_video_regenerate_preserves_keyframe_roles_and_replacements(self):
        b = self.load()
        second = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        views = [{"memory_id":"character-a", "views":["main","back"]}]
        b["nodes"].extend([
            {"id": "n3", "type": "image", "name": "尾帧", "x": 0, "y": 0, "data": {}, "versions": [second], "cur": 0},
            {"id": "n4", "type": "image", "name": "修正首帧", "x": 0, "y": 0, "data": {}, "versions": [second], "cur": 0},
            {"id": "n5", "type": "video", "name": "原视频", "x": 0, "y": 0, "data": {"prompt": "original movement", "duration": 8, "quality": "hd", "aspect": "auto", "seed": 10},
             "versions": [{**make_video(),"video_recipe":{"memory_views":views}}], "cur": 0}])
        b["edges"] = [{"from": "n1", "to": "n5", "role": "first"}, {"from": "n3", "to": "n5", "role": "last"}]
        server.board_path("test").write_text(json.dumps(b))
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "n5", "prompt": "scissors close naturally", "replacements": [{"from_node_id": "n1", "to_node_id": "n4"}]}), answer()]
        with patch.object(self.svc, "submit_generation", AsyncMock(return_value={"media_type": "video", "nodes": []})) as submit:
            rid = await self.send("重生成视频", selected=["n5"])
            await self.wait(rid)
        payload = submit.await_args.args[3]
        self.assertEqual(payload["kind"], "video")
        self.assertEqual(payload["duration"], 8)
        self.assertEqual(payload["quality"], "hd")
        self.assertEqual([i["ref"] for i in payload["images"]], [second["ref"], second["ref"]])
        self.assertEqual(payload["prompt"], "scissors close naturally")
        self.assertEqual(payload["memory_views"], views)
        self.assertEqual(submit.await_args.kwargs["target_id"], "n5")
        self.assertEqual(self.load()["nodes"], b["nodes"])

    async def test_regeneration_appends_to_original_and_snapshots_both_input_graphs(self):
        old, new = make_video(), make_video()
        b = self.load()
        b["nodes"].append({"id": "video", "type": "video", "name": "原视频", "x": 700, "y": 90,
                           "data": {"prompt": "old movement", "duration": 5, "quality": "std",
                                    "video_optics":{"lens":85,"aperture":"2"}}, "versions": [old], "cur": 0, "job": None})
        corrected = copy.deepcopy(b["nodes"][0]); corrected["id"] = "corrected"
        b["nodes"].append(corrected)
        original_edges = [{"from": "n1", "to": "video", "role": "first"}, {"from": "n2", "to": "video"}]
        b["edges"] = original_edges
        server.board_path("test").write_text(json.dumps(b))
        started, finish = asyncio.Event(), asyncio.Event()
        async def submit(*_):
            return web.json_response({"ids": ["e123456789012"]})
        async def jobs(req):
            started.set()
            return web.json_response({"e123456789012": {"state": "done" if finish.is_set() else "running", "meta": {"seed": 42},
                                    "outputs": [{"ref": new["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "video", "prompt": "new movement", "replacements": [{"from_node_id": "n1", "to_node_id": "corrected"}]}), answer()]
        with patch.object(generation_requests, "generate_request", side_effect=submit), patch.object(generation_jobs, "jobs", side_effect=jobs):
            rid = await self.send("原视频上再修改", selected=["video"])
            await started.wait()
            waiting = self.load(); n = next(n for n in waiting["nodes"] if n["id"] == "video")
            self.assertEqual(len(waiting["nodes"]), 4)
            self.assertEqual(n["versions"][0]["input_edges"], original_edges)
            self.assertEqual(n["versions"][0]["node_data"]["prompt"], "old movement")
            self.assertTrue(n["job"]["agent_call"])
            self.assertEqual({e["from"] for e in waiting["edges"]}, {"corrected", "n2"})
            # Simulate Web restart; the durable waiting call must finish in the same node.
            self.svc.closing = True
            task = self.svc.tasks[rid]; task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.svc.closing = False
            finish.set(); self.svc.launch(rid)
            self.assertEqual((await self.wait(rid))["state"], "done")
        final = self.load(); n = next(n for n in final["nodes"] if n["id"] == "video")
        self.assertEqual(len(final["nodes"]), 4)
        self.assertEqual(len(n["versions"]), 2)
        self.assertEqual(n["cur"], 1)
        self.assertIsNone(n["job"])
        self.assertEqual((n["name"], n["x"], n["y"]), ("原视频", 700, 90))
        self.assertEqual(n["versions"][1]["input_edges"], final["edges"])
        self.assertEqual(n["versions"][1]["node_data"]["prompt"], "new movement")
        self.assertEqual(n["versions"][1]["video_recipe"]["seed"], 42)
        self.assertEqual(n["versions"][0]["node_data"]["video_optics"],{"lens":85,"aperture":"2"})
        self.assertEqual(n["versions"][1]["video_recipe"]["video_optics"],{"lens":85,"aperture":"2"})
        result = json.loads(db_row(rid)["result"])
        self.assertEqual(result["nodes"][0]["id"], "video")
        self.assertEqual(result["nodes"][0]["version_index"], 1)
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["nodes"], b["nodes"])
        self.assertCountEqual(self.load()["edges"], original_edges)

    async def test_video_regeneration_accepts_an_explicit_first_frame_and_subjects(self):
        board = self.load()
        expected = [self.source["ref"]]
        frames = [{"node_id":"n1","role":"first"}]
        for index,color in enumerate(("blue","white"),3):
            asset = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),color))
            nid = f"n{index}"
            board["nodes"].append({"id":nid,"type":"image","name":color,"x":0,"y":0,"data":{},"versions":[asset],"cur":0})
            frames.append({"node_id":nid,"role":"subject"})
            expected.append(asset["ref"])
        board["nodes"].append({"id":"video","type":"video","name":"原视频","x":800,"y":0,
                               "data":{"prompt":"original","quality":"std"},"versions":[make_video()],"cur":0})
        board["edges"] = [{"from":"n4","to":"video","role":"last"}]
        server.write_board(server.board_path("test"),board)
        self.svc.model.side_effect = [call("video_regenerate",{
            "node_id":"video","frames":frames,"duration":5,"prompt":"camera moves","name":"原视频"}),answer()]
        with patch.object(self.svc,"submit_generation",AsyncMock(return_value={"media_type":"video","nodes":[]})) as submit:
            rid = await self.send("重新生成",selected=["video","n1","n3","n4"])
            self.assertEqual((await self.wait(rid))["state"],"done")
        payload = submit.await_args.args[3]
        self.assertEqual([item["ref"] for item in payload["images"]],expected)
        self.assertEqual([item["role"] for item in payload["images"]],["frame","subject","subject"])
        self.assertEqual((payload["duration"],payload["quality"],submit.await_args.kwargs["target_id"]),(5,"std","video"))

    async def test_failed_regeneration_keeps_old_video_and_restores_inputs(self):
        b = self.load(); old = make_video()
        b["nodes"].append({"id": "video", "type": "video", "name": "原视频", "x": 700, "y": 90,
                           "data": {"prompt": "old movement", "duration": 5}, "versions": [old], "cur": 0, "job": None})
        b["edges"] = [{"from": "n1", "to": "video", "role": "first"}]
        server.board_path("test").write_text(json.dumps(b))
        async def submit(*_):
            server.JOBS["e123456789012"] = {"state": "error", "created": 1, "meta": {"uid": 7}, "error": "failed"}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "video", "prompt": "new movement"}), answer()]
        with patch.object(generation_requests, "generate_request", side_effect=submit):
            rid = await self.send(selected=["video"]); await self.wait(rid)
        n = self.load()["nodes"][-1]
        self.assertEqual(n["versions"][0]["ref"], old["ref"])
        self.assertEqual(len(n["versions"]), 1)
        self.assertEqual(n["cur"], 0)
        self.assertIsNone(n["job"])
        self.assertEqual(n["data"], b["nodes"][-1]["data"])
        self.assertEqual(self.load()["edges"], b["edges"])
        self.assertEqual(n["agent_error"], "failed")
