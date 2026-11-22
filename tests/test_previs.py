import asyncio
import io
import json
from unittest.mock import patch
from urllib.parse import urlsplit

import av
import numpy as np

import db
import previs
import server
from test_agent_chat import ChatFixture, answer, call


class PrevisIntegration(ChatFixture):
    async def test_assistant_authors_renders_and_reuses_a_pinned_guide(self):
        scene = {"duration":2, "aspect":"9:16",
                 "camera":[{"t":0,"x":4,"y":2,"z":6,"tx":0,"ty":.8,"tz":0,"fov":38}],
                 "objects":[{"id":"walker","label":"人物","shape":"figure","width":.8,"height":1.7,"depth":.6,
                             "keys":[{"t":0,"x":-1,"y":0,"z":0,"yaw":0},{"t":48,"x":1,"y":0,"z":0,"yaw":25}]}]}

        async def author(messages, _):
            results = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            if not results:
                return call("video_previs_save", {"scene":scene,"name":"车站走位"}, "save")
            if len(results) == 1:
                return call("video_previs_render", {"node_id":results[0]["node_id"]}, "render")
            self.assertEqual(results[-1].get("media_type"), "video", results[-1])
            return answer()

        self.svc.model.side_effect = author
        await self.wait(await self.send("做一个竖屏走位白模并渲染", selected=[]), timeout=10)
        board = self.load()
        guide_node = board["nodes"][-1]
        nid = guide_node["id"]
        guide = guide_node["versions"][0]
        self.assertEqual(guide["source"], "previs")
        self.assertEqual((guide["w"],guide["h"],guide["seconds"]), (720,1280,2))
        self.assertEqual(guide["previs_recipe"], previs.validate(scene))
        self.assertIsNone(guide_node["job"])
        first_ref = guide["ref"]

        revised = {**scene, "camera":[{**scene["camera"][0],"y":3}]}
        async def edit(messages, _):
            recent = messages[max(i for i, m in enumerate(messages) if m["role"] == "user"):]
            results = {m["tool_call_id"]:json.loads(m["content"]) for m in recent if m["role"] == "tool"}
            if "stale" not in results:
                return call("video_previs_save", {"node_id":nid,"scene_revision":"stale","scene":revised}, "stale")
            if "inspect" not in results:
                return call("video_previs_get", {"node_id":nid}, "inspect")
            if "edit" not in results:
                return call("video_previs_save", {"node_id":nid,"scene_revision":results["inspect"]["scene_revision"],"scene":revised}, "edit")
            if "render" not in results:
                return call("video_previs_render", {"node_id":nid}, "render")
            return answer()

        self.svc.model.side_effect = edit
        rid = await self.send("把机位抬高并重渲染", "request002", [nid])
        await self.wait(rid, timeout=10)
        old_call = db.one("SELECT result FROM chat_calls WHERE run_id=? AND args LIKE ?", rid, '%"stale"%')
        self.assertIn("重新读取", json.loads(old_call["result"])["error"])
        guide_node = self.load()["nodes"][-1]
        self.assertEqual(guide_node["id"], nid)
        self.assertEqual([v["previs_recipe"]["camera"][0]["y"] for v in guide_node["versions"]], [2,3])
        self.assertNotEqual(guide_node["versions"][1]["ref"], first_ref)

        route = {"provider":{"id":"ark-assistant", "name":"方舟", "enabled":True, "kind":"ark",
                             "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"fixture"}},
                 "model":"ep-configured"}
        submitted = []

        async def provider(_http, root, _provider, model, kind, request):
            self.assertEqual((kind,model), ("video","ep-configured"))
            submitted.append(request)
            path, ref = server.film._new(root, "output", "formal", ".mp4")
            path.write_bytes(server.tools.ref_path(root, first_ref).read_bytes())
            return {"files":[{"ref":ref,"path":path,"kind":"video"}]}

        with patch.object(server.providers, "routes", return_value=[route]), \
                patch.object(server.providers, "all_providers", return_value=[]), \
                patch.object(server.remote, "run", side_effect=provider):
            self.svc.model.side_effect = [call("video_generate", {"prompt":"猫走进车站","previs":{"node_id":nid,"version":1},
                                                  "frames":[{"node_id":"n1","role":"subject"}]}), answer()]
            # The worker polls media tasks and probes the exported clip before updating the node.
            await self.wait(await self.send("用白模第一版做正式视频", "request003", [nid, "n1"]), timeout=10)
            formal_id = self.load()["nodes"][-1]["id"]
            self.svc.model.side_effect = [call("video_regenerate", {"node_id":formal_id,"prompt":"改成雨天"}), answer()]
            await self.wait(await self.send("在原节点重生成", "request004", [formal_id]), timeout=10)

        board = self.load()
        formal = board["nodes"][-1]
        self.assertEqual(len(board["nodes"]), 4)
        self.assertEqual(formal["id"], formal_id)
        self.assertEqual(len(formal["versions"]), 2)
        self.assertEqual([v["video_recipe"]["previs_guide"]["ref"] for v in formal["versions"]], [first_ref]*2)
        self.assertEqual([v["generation_record"]["inputs"][-1]["version"] for v in formal["versions"]], [1,1])
        self.assertEqual([e["ref"] for e in board["edges"] if e.get("relation") == "previs"], [first_ref])
        self.assertEqual([r["ar"] for r in submitted], [9/16,9/16])
        self.assertTrue(all(r["refs"] and r["motion_url"] for r in submitted))

    async def test_scene_render_saves_exact_silent_mp4_and_reuses_submission(self):
        scene = {
            "duration":2, "aspect":"1:1",
            "camera":[{"t":0,"x":3,"y":2,"z":6,"tx":0,"ty":.8,"tz":0,"fov":38}],
            "objects":[{"id":"actor","label":"角色","shape":"figure","width":.8,"height":1.7,"depth":.6,
                        "keys":[{"t":0,"x":-1.5,"y":0,"z":0,"yaw":0},
                                {"t":48,"x":1.5,"y":0,"z":0,"yaw":20,"ease":"smooth"}]}],
        }
        original = previs.validate(scene)
        self.assertEqual(previs.sample(original["objects"][0]["keys"], 24, previs.POSE_FIELDS)["x"], 0)
        self.board["collaborators"] = {"8":"reviewer"}
        self.board["nodes"].append({"id":"n3","type":"video","name":"机位样片","data":{"previs":scene},"versions":[],"cur":-1})
        server.write_board(server.board_path("test"), self.board)
        payload = {"board":"test","node":"n3","revision":1,"request_key":"previs-test-render-1"}
        api = "/api/previs/render"
        self.assertEqual((await self.client.post(api, json=payload, headers={"X-Uid":"8"})).status, 404)
        self.assertEqual((await self.client.post(api, json={**payload,"revision":0})).status, 409)
        first = await self.client.post(api, json=payload)
        self.assertEqual(first.status, 200, await first.text())
        jobs = (await first.json())["ids"]
        self.assertEqual((await (await self.client.post(api,json=payload)).json())["ids"], jobs)
        for _ in range(300):
            job = server.JOBS[jobs[0]]
            if job["state"] in ("done", "error"):
                break
            await asyncio.sleep(.01)
        self.assertEqual(job["state"], "done", job.get("error"))
        url = job["outputs"][0]["url"]
        response = await self.client.get(url)
        self.assertEqual(response.status, 200)
        data = await response.read()
        with av.open(io.BytesIO(data)) as video:
            self.assertEqual(len(video.streams.audio), 0)
            stream = video.streams.video[0]
            self.assertEqual((stream.average_rate,stream.width,stream.height), (24,720,720))
            frames = [frame.to_ndarray(format="rgb24") for frame in video.decode(video=0)]
        self.assertEqual(len(frames), 48)
        self.assertGreater(np.mean(np.abs(frames[0].astype(float)-frames[-1])), 3)
        self.assertEqual(self.load()["rev"], 1)

        node = self.board["nodes"][-1]
        ref = job["outputs"][0]["ref"]
        node["versions"] = [{"ref":ref, "source":"previs"}, {"ref":self.source["ref"], "source":"upload"}]
        node["cur"] = 1
        server.write_board(server.board_path("test"), self.board)
        provider = {"id":"ark-previs", "name":"方舟", "kind":"ark", "enabled":True,
                    "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"fixture"}}
        route = {"provider":provider, "model":"ep-configured-seedance"}
        request = {"board":"test", "provider":provider["id"], "kind":"video", "duration":2, "ar":1,
                   "prompt":"参考 @视频1 的走位，穿红色风衣走进车站。",
                   "previs_guide":{"ref":ref, "node_id":"n3"}, "images":[]}
        guides = []
        bodies = []

        async def ark_payload(_http, method, _url, _name, **kwargs):
            if method == "GET":
                return {"status":"succeeded", "content":{"video_url":"https://provider.example/formal.mp4"}}
            body = kwargs["json"]
            bodies.append(body)
            guide = body["content"][-1]
            signed = urlsplit(guide["video_url"]["url"])
            self.assertEqual(signed.hostname, "studio.example")
            guides.append(signed.path)
            video = await self.client.get(signed.path)
            self.assertEqual(video.status, 200)
            with av.open(io.BytesIO(await video.read())) as guide_file:
                self.assertFalse(guide_file.streams.audio)
                self.assertEqual(sum(1 for _ in guide_file.decode(video=0)), 48)
            return {"id":"remote-video"}

        async def save_video(*_):
            path, output = server.film._new(server.COMFY_DIR, "output", "formal", ".mp4")
            path.write_bytes(data)
            return {"files":[{"ref":output, "path":path, "kind":"video"}]}

        with patch.object(server.providers, "routes", return_value=[route]), \
                patch.object(server.providers, "all_providers", return_value=[]), \
                patch.object(server.remote, "json_req", side_effect=ark_payload), \
                patch.object(server.remote, "_save_video", side_effect=save_video):
            path = "/api/generate"
            self.assertEqual((await self.client.post(path, json=request, headers={"X-Uid":"8"})).status, 403)
            self.assertEqual((await self.client.post(path, json={**request, "provider":"local_h3"})).status, 400)
            self.assertEqual((await self.client.post(path, json={**request, "previs_guide":{"ref":ref,"node_id":"n2"}})).status, 400)
            preview = await self.client.post("/api/preview", json=request)
            self.assertEqual(preview.status, 200, await preview.text())
            expected_prompt = (await preview.json())["prompt"]
            for images, roles in [([], ["reference_video"]), ([{"ref":self.source["ref"],"role":"frame"}], ["reference_image","reference_video"])]:
                response = await self.client.post(path, json={**request, "images":images, "provider_model":"unconfigured-model"})
                self.assertEqual(response.status, 200, await response.text())
                jid = (await response.json())["ids"][0]
                for _ in range(300):
                    formal = server.JOBS[jid]
                    if formal["state"] in ("done","error"):
                        break
                    await asyncio.sleep(.01)
                self.assertEqual(formal["state"], "done", formal.get("error"))
                body = bodies[-1]
                self.assertEqual((body["model"],body["duration"],body["ratio"]), (route["model"],4,"1:1"))
                self.assertTrue(body["generate_audio"])
                self.assertEqual(body["content"][0]["text"], expected_prompt)
                self.assertIn("参考 @视频1 的走位", expected_prompt)
                self.assertEqual([item["role"] for item in body["content"][1:]], roles)
                self.assertEqual((await self.client.get(guides[-1])).status, 404)
                log = db.one("SELECT request FROM tasks WHERE id=?", jid)["request"]
                self.assertEqual(json.loads(log)["previs_ref"], ref)
                self.assertNotIn(guides[-1], log)
