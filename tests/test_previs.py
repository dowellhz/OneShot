"""Previsualization rendering, lighting, camera cuts, and scene geometry."""

from unittest.mock import patch
from urllib.parse import urlsplit
import asyncio
import io
import json

import av
import numpy as np

from oneshot.editing import previs
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call
from previs_fixture import motion_scene


class PrevisIntegration(ChatFixture):
    async def test_render_shot_span_is_frame_exact_idempotent_and_retained(self):
        scene = motion_scene()
        scene["aspect"] = "1:1"
        base = scene["camera"][0]
        scene["camera"] = [base,{**base,"t":36,"z":3,"ease":"cut"},{**base,"t":84,"z":9,"ease":"cut"}]
        scene = previs.validate(scene)
        self.board["nodes"].append({"id":"n3","type":"video","name":"白模","data":{"previs":scene},"versions":[],"cur":-1})
        server.write_board(server.board_path("test"),self.board)
        api = "/api/previs/render"
        payload = {"board":"test","node":"n3","revision":1,"request_key":"previs-span-test-0001"}
        for span in ([36,36],[-1,84],[True,42],[36,97],{"start":36,"end":84}):
            self.assertEqual((await self.client.post(api,json={**payload,"span":span})).status,400)
        response = await self.client.post(api,json={**payload,"span":[36,84]})
        self.assertEqual(response.status,200,await response.text())
        jid, = (await response.json())["ids"]
        repeat = await self.client.post(api,json={**payload,"span":[36,84]})
        self.assertEqual((await repeat.json())["ids"],[jid])
        self.assertEqual((await self.client.post(api,json={**payload,"span":[24,72]})).status,409)
        async with asyncio.timeout(8):
            while server.JOBS[jid]["state"] not in ("done","error"):
                await asyncio.sleep(.02)
        job = server.JOBS[jid]
        self.assertEqual(job["state"],"done",job.get("error"))
        out, = job["outputs"]
        self.assertEqual(out["meta"]["duration"],2)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,out["ref"]))) as video:
            self.assertEqual(len(video.streams.audio),0)
            frames = [frame.to_ndarray(format="rgb24").astype(np.int16) for frame in video.decode(video=0)]
        self.assertEqual(len(frames),48)
        errors = []
        for tick,frame in ((36,frames[0]),(83,frames[-1])):
            expected = np.asarray(previs.paint(scene,tick,720,720),dtype=np.int16)
            errors.append(np.abs(frame-expected).mean())
            self.assertLess(errors[-1],4)
        cut_out = np.asarray(previs.paint(scene,84,720,720),dtype=np.int16)
        self.assertGreater(np.abs(frames[-1]-cut_out).mean(),errors[-1]+.5)

        self.svc.model.side_effect = [call("video_previs_render",{"node_id":"n3","span":[0,36]}),answer()]
        rid = await self.send("单独渲染第一镜",selected=["n3"])
        self.assertEqual((await self.wait(rid,timeout=12))["state"],"done")
        version, = self.load()["nodes"][-1]["versions"]
        self.assertEqual((version["source"],version["seconds"],version["previs_span"]),("previs",1.5,[0,36]))
        self.assertEqual(version["previs_recipe"],scene)

    async def test_lighting_renders_and_saved_scene_retains_settings(self):
        scene = {"duration":2,"aspect":"1:1",
                 "camera":[{"t":0,"x":0,"y":1,"z":5,"tx":0,"ty":1,"tz":0,"fov":42,"ease":"linear"}],
                 "objects":[{"id":"box","label":"方块","shape":"box","width":2,"height":2,"depth":1,
                             "keys":[{"t":0,"x":0,"y":0,"z":0,"yaw":0,"ease":"linear"}]}]}
        settings = {"azimuth":0,"elevation":0,"key":.6,"ambient":.2,"tone":"warm"}
        lit = previs.validate({**scene,"lighting":settings})
        front = previs.paint(lit,0,160,160)
        back = previs.paint(previs.validate({**scene,"lighting":{**settings,"azimuth":180}}),0,160,160)
        original = previs.paint(previs.validate(scene),0,160,160)
        self.assertEqual(front.getpixel((80,80)),(182,152,125))
        self.assertEqual(back.getpixel((80,80)),(46,46,46))
        self.assertEqual(original.getpixel((80,80)),(196,196,196))
        for invalid in ({**settings,"ambient":1.3},{**settings,"tone":"green"},{"enabled":1}):
            with self.assertRaisesRegex(ValueError,"灯光"):
                previs.validate({**scene,"lighting":invalid})
        result = await asyncio.to_thread(previs.export,server.COMFY_DIR,lit,lambda *_:None,lambda:False)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,result["ref"]))) as video:
            frame = next(video.decode(video=0)).to_ndarray(format="rgb24")
            self.assertLess(np.max(np.abs(frame[360,360].astype(np.int16)-[182,152,125])),6)

        self.svc.model.side_effect = [call("video_previs_save",{"scene":lit},"lit-preview"),answer()]
        rid = await self.send("保留暖色主光",selected=[])
        self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        node = self.load()["nodes"][-1]
        self.assertEqual(node["data"]["previs"]["lighting"],settings)
        for i,desired in enumerate((scene,{**scene,"lighting":{"enabled":False}})):
            args = {"node_id":node["id"],"scene":desired,
                    "scene_revision":server.agent_chat.agent_video.scene_revision(node["data"]["previs"])}
            self.svc.model.side_effect = [call("video_previs_save",args,f"light-change-{i}"),answer()]
            rid = await self.send("编辑灯光方案",key=f"lighting-{i}",selected=[node["id"]])
            self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
            node = self.load()["nodes"][-1]
            self.assertEqual(node["data"]["previs"].get("lighting"),settings if i==0 else None)

    async def test_camera_cut_holds_until_the_exact_frame_in_saved_and_rendered_scene(self):
        scene = motion_scene()
        scene.update(duration=2,aspect="1:1")
        scene["camera"] = [scene["camera"][0], {**scene["camera"][0],"t":24,"z":2,"fov":55,"ease":"cut"}]
        scene["objects"][0]["keys"] = scene["objects"][0]["keys"][:1]
        self.svc.model.side_effect = [call("video_previs_save",{"scene":scene},"cut"),answer()]
        rid = await self.send("在第 1 秒切到近机位",selected=[])
        self.assertEqual((await self.wait(rid,timeout=9))["state"],"done")
        saved = self.load()["nodes"][-1]["data"]["previs"]
        self.assertEqual(saved["camera"][1]["ease"],"cut")
        self.assertEqual(previs.sample(saved["camera"],23,previs.CAMERA_FIELDS)["z"],6)
        self.assertEqual(previs.sample(saved["camera"],24,previs.CAMERA_FIELDS)["z"],2)
        ramp = previs.camera_motion(saved,{"mode":"pull","start":6,"end":12,"amount":1})
        self.assertEqual([(key["t"],key["ease"]) for key in ramp],[(0,"linear"),(6,"linear"),(12,"smooth"),(24,"cut")])
        exported = await asyncio.to_thread(previs.export,server.COMFY_DIR,saved,lambda *_:None,lambda:False)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,exported["ref"]))) as video:
            frames = {index:frame.to_ndarray(format="rgb24").astype(np.int16)
                      for index,frame in enumerate(video.decode(video=0)) if index in (22,23,24,25)}
        self.assertLess(np.abs(frames[22]-frames[23]).mean(),1.5)
        self.assertGreater(np.abs(frames[23]-frames[24]).mean(),3)
        self.assertLess(np.abs(frames[24]-frames[25]).mean(),1.5)

    async def test_camera_move_api_range_geometry_and_bounds(self):
        scene = previs.validate(motion_scene())
        path = "/api/previs/camera-motion"
        for mode, value, x, z in (("push",2,0,4),("pull",2,0,8),("slide_left",1,-1,6),
                                  ("slide_right",1,1,6),("orbit_left",90,-6,0),("orbit_right",90,6,0)):
            with self.subTest(mode=mode):
                response = await self.client.post(path,json={"scene":scene,"plan":{"mode":mode,"start":12,"end":72,"amount":value}})
                self.assertEqual(response.status,200,await response.text())
                track = (await response.json())["camera"]
                self.assertEqual((track[0],track[-1]),(scene["camera"][0],scene["camera"][-1]))
                self.assertEqual((track[1]["t"],track[-2]["t"]),(12,72))
                self.assertAlmostEqual(track[-2]["x"],x)
                self.assertAlmostEqual(track[-2]["z"],z)
                if mode.startswith("orbit"):
                    for key in track[1:-1]:
                        self.assertAlmostEqual(key["x"]**2+key["z"]**2,36)
        for plan in ({"mode":"push","start":0,"end":36,"amount":6},
                     {"mode":"follow","start":0,"end":97,"target":"walker"},
                     {"mode":"follow","start":0,"end":48,"target":"absent"}):
            self.assertEqual((await self.client.post(path,json={"scene":scene,"plan":plan})).status,400)

    async def test_object_motion_uses_distance_and_keeps_other_tracks(self):
        scene = previs.validate(motion_scene())
        path = "/api/previs/object-motion"
        plan = {"target":"walker","start":0,"end":72,"points":[{"x":1,"z":0},{"x":1,"z":3}]}
        response = await self.client.post(path,json={"scene":scene,"plan":plan})
        self.assertEqual(response.status,200,await response.text())
        track = (await response.json())["keys"]
        self.assertEqual([[key["t"],key["x"],key["z"]] for key in track],
                         [[0,0,0],[18,1,0],[72,1,3],[96,4,2]])
        for invalid in ({**plan,"end":1},{**plan,"points":[{"x":0,"z":0}]},
                        {**plan,"points":[{"x":51,"z":0}]},{**plan,"target":"absent"}):
            self.assertEqual((await self.client.post(path,json={"scene":scene,"plan":invalid})).status,400)

        node = {"id":"n3","type":"video","name":"白模走位","x":10,"y":20,"data":{"previs":scene},"versions":[],"cur":-1}
        self.board["nodes"].append(node)
        server.write_board(server.board_path("test"),self.board)
        args = {**plan,"end":3,"node_id":"n3","scene_revision":server.agent_chat.agent_video.scene_revision(scene)}
        self.svc.model.side_effect = [call("video_previs_object_motion",args,"path"),answer()]
        rid = await self.send("在前三秒走过两个路点",selected=["n3"])
        self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        saved = self.load()["nodes"][-1]["data"]["previs"]
        self.assertEqual(saved["objects"][0]["keys"],track)
        self.assertEqual(saved["camera"],scene["camera"])

    async def test_scene_render_saves_exact_silent_mp4_and_reuses_submission(self):
        scene = {
            "duration":2, "aspect":"1:1",
            "camera":[{"t":0,"x":3,"y":2,"z":6,"tx":0,"ty":.8,"tz":0,"fov":38}],
            "objects":[{"id":"actor","label":"角色","shape":"figure","width":.8,"height":1.7,"depth":.6,
                        "keys":[{"t":0,"x":-1.5,"y":0,"z":0,"yaw":0},
                                {"t":48,"x":1.5,"y":0,"z":0,"yaw":20,"ease":"smooth"}]},
                       {"id":"prop","label":"导入道具","shape":"mesh","width":2,"height":1.6,"depth":1,
                        "triangles":[[-.5,0,0,.5,0,0,0,1,0]],
                        "keys":[{"t":0,"x":0,"y":0,"z":1,"yaw":25}]}],
        }
        original = previs.validate(scene)
        self.assertEqual(original["objects"][1]["triangles"], scene["objects"][1]["triangles"])
        without_mesh = {**original, "objects":original["objects"][:1]}
        self.assertNotEqual(previs.paint(original, 0, 200, 200).tobytes(),
                            previs.paint(without_mesh, 0, 200, 200).tobytes())
        too_large = {**scene["objects"][1], "triangles":scene["objects"][1]["triangles"] * 2001}
        with self.assertRaisesRegex(ValueError, "2000"):
            previs.validate({**scene, "objects":[too_large]})
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
            for images, roles in [([], ["reference_video"]), ([{"ref":self.source["ref"],"role":"frame"}], ["reference_image","reference_video"])]:
                payload = {**request, "images":images, "provider_model":"unconfigured-model"}
                preview = await self.client.post("/api/preview", json=payload)
                self.assertEqual(preview.status, 200, await preview.text())
                review = await preview.json()
                expected_prompt = review["prompt"]
                self.assertEqual("开头参考 @图片1 的构图。" in expected_prompt, bool(images))
                response = await self.client.post(path, json={**payload, "reference_preview":review["reference_preview"]})
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
