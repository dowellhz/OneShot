import asyncio
import io
import json
from unittest.mock import patch
from urllib.parse import urlsplit

import av
import numpy as np
from aiohttp import web
from PIL import Image

import server
from test_agent_chat import ChatFixture, answer, call


class ReferenceVideo(ChatFixture):
    async def test_video_optics_reaches_generation_prompt_and_leaves_request_reusable(self):
        optics={"lens":85,"sensor":"full-frame","optics":"anamorphic","aperture":"2.8"}
        raw={"kind":"video","board":"test","fields":{"scene":"雨夜车站","camera":"缓慢推近","action":"列车到站"},
             "prompt":"","video_optics":optics}
        requested=[]
        async def engine(_req,payload,_count):
            requested.append(payload)
            return web.json_response({"ids":["optic-job"]})
        with patch.object(server.providers,"primary",return_value=None),patch.object(server,"engine_up",return_value=True), \
                patch.object(server,"generate_engine",side_effect=engine):
            response=await self.client.post("/api/generate",json=raw)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(requested[0]["prompt"].count("85 mm"),1)
            for text in ("缓慢推近","全画幅","椭圆散景","f/2.8","列车到站"):
                self.assertIn(text,requested[0]["prompt"])
            for bad in ({"lens":87},{"sensor":"unknown"},{"unexpected":True}):
                response=await self.client.post("/api/generate",json={**raw,"video_optics":bad})
                self.assertEqual(response.status,400,await response.text())
            self.assertEqual(len(requested),1)
        composed=server.apply_video_optics(raw)
        self.assertEqual(raw["fields"]["camera"],"缓慢推近")
        self.assertIn("85 mm",server.plain_prompt(composed))
        structured="integrated_multimodal_description: [Shot 1] A train arrives.\n\noverall_soundscape: Rain."
        augmented=server.apply_video_optics({"prompt":structured,"video_optics":{"lens":24}})["prompt"]
        self.assertIn("24 mm",augmented.split("\n\noverall_soundscape:")[0])
        self.assertTrue(augmented.endswith("overall_soundscape: Rain."))

    async def test_extension_uses_head_or_tail_and_keeps_direction_when_regenerating(self):
        path, ref = server.film._new(server.COMFY_DIR, "input", "source", ".mp4")
        frames=(Image.new("RGB",(64,64),"red" if i<36 else "blue") for i in range(84))
        server.film.encode_silent(path,frames,64,64,12,lambda:False,lambda _:None)
        source={"id":"n3","type":"video","name":"原片","x":300,"y":60,"data":{},"cur":0,
                "versions":[{"ref":ref,"w":64,"h":64,"seconds":7}]}
        self.board["nodes"].append(source)
        server.write_board(server.board_path("test"),self.board)
        provider={"id":"ark-extend","name":"方舟","enabled":True,"kind":"ark",
                  "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-fixture"}
        requested=[]

        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="GET":
                return {"status":"succeeded","content":{"video_url":"https://provider.example/ext.mp4"}}
            body=kwargs["json"]
            self.assertEqual((body["ratio"],body["omni_reference_task_type"],body["duration"]),("adaptive","extend",5))
            text, video=body["content"]
            direction="before" if text["text"].startswith("向前延长 @视频1") else "after"
            self.assertTrue(text["text"].startswith(("向前延长 @视频1","向后延长 @视频1")))
            self.assertEqual(text["text"].count("35 mm"),1)
            self.assertIn("f/4",text["text"])
            blob=await self.client.get(urlsplit(video["video_url"]["url"]).path)
            self.assertEqual(blob.status,200)
            with av.open(io.BytesIO(await blob.read())) as recording:
                decoded=list(recording.decode(video=0))
                self.assertEqual(len(decoded),96)
                color=decoded[0 if direction=="before" else -1].to_ndarray(format="rgb24")[0,0]
                self.assertGreater(color[0 if direction=="before" else 2],225)
            requested.append(direction)
            return {"id":"external-job"}

        async def download(*_):
            out, media=server.film._new(server.COMFY_DIR,"output","continuation",".mp4")
            out.write_bytes(path.read_bytes())
            return {"files":[{"ref":media,"path":out,"kind":"video"}]}

        with patch.object(server.providers,"routes",return_value=[route]),patch.object(server.providers,"all_providers",return_value=[]), \
                patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",side_effect=download):
            for direction in ("after","before"):
                self.svc.model.side_effect=[call("video_extend",{"node_id":"n3","direction":direction,"prompt":"列车靠站",
                    "video_optics":{"lens":35,"aperture":"4"}}),answer()]
                run_id=await self.send("续拍",f"extension-{direction}",["n3"])
                await self.wait(run_id, timeout=10)
                saved=self.load()
                result=saved["nodes"][-1]
                self.assertEqual(result["versions"][0]["video_recipe"]["extension"],direction)
                edge=result["versions"][0]["input_edges"][0]
                self.assertEqual([edge["ref"],edge["start"],edge["end"]],[ref,3,7] if direction=="after" else [ref,0,4])
                self.assertEqual(edge["extension"],direction)
                self.assertEqual(saved["nodes"][2],source)
            self.svc.model.side_effect=[call("video_regenerate",{"node_id":result["id"],"prompt":"加上夜景"}),answer()]
            await self.wait(await self.send("重新生成", "extension-regenerate",[result["id"]]), timeout=10)
            final=self.load()["nodes"][-1]
            self.assertEqual(final["id"],result["id"])
            self.assertEqual([v["video_recipe"]["extension"] for v in final["versions"]],["before","before"])
            self.assertEqual([v["video_recipe"]["video_optics"] for v in final["versions"]],[{"lens":35,"aperture":"4"}]*2)
            response=await self.client.post("/api/generate",json={"kind":"video","board":"test","provider":provider["id"],
                "extension":"before","prompt":"降落","video_refs":[{"ref":ref,"node_id":"n3","start":2,"end":6}]})
            self.assertEqual(response.status,400)
            self.assertIn("接点",json.loads(await response.text())["error"])
        self.assertEqual(requested,["after","before","before"])

    async def test_trimmed_reference_order_marks_and_leases(self):
        self.board["collaborators"] = {"8":"reviewer"}
        refs = []
        for nid, start in [("n3", 2), ("n4", 0)]:
            path, ref = server.film._new(server.COMFY_DIR, "input", "motion", ".mp4")
            frames = (Image.new("RGB", (64, 64), "red" if i < 24 else "blue") for i in range(60))
            server.film.encode_silent(path, frames, 64, 64, 12, lambda:False, lambda _:None)
            self.board["nodes"].append({"id":nid,"type":"video","name":nid,"versions":[{"ref":ref,"w":64,"h":64,"seconds":5}],
                                        "data":{},"cur":0,"x":50,"y":50})
            refs.append({"node_id":nid, "ref":ref, "start":start, "end":start+2})
        server.write_board(server.board_path("test"), self.board)
        provider = {"id":"ark-clip", "name":"方舟", "enabled":True, "kind":"ark",
                    "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"fixture"}}
        route = {"provider":provider, "model":"doubao-seedance-2-0-fixture"}
        leases = []
        checked = []

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "GET":
                return {"status":"succeeded", "content":{"video_url":"https://provider.example/result.mp4"}}
            text, *contents = kwargs["json"]["content"]
            self.assertIn("@视频1", text["text"])
            self.assertIn("@视频2", text["text"])
            self.assertTrue(kwargs["json"]["generate_audio"])
            self.assertEqual([part["role"] for part in contents], ["reference_video","reference_video"])
            for part, expected in zip(contents, ["blue","red"]):
                url = urlsplit(part["video_url"]["url"])
                self.assertEqual(url.hostname, "studio.example")
                leases.append(url.path)
                response = await self.client.get(url.path)
                self.assertEqual(response.status, 200)
                with av.open(io.BytesIO(await response.read())) as video:
                    self.assertFalse(video.streams.audio)
                    self.assertEqual(video.streams.video[0].average_rate, 24)
                    frames = [image.to_ndarray(format="rgb24") for image in video.decode(video=0)]
                self.assertEqual(len(frames), 48)
                pixel = np.mean(frames[12], axis=(0,1))
                self.assertGreater(pixel[2 if expected=="blue" else 0], 230)
                checked.append(expected)
            return {"id":"fake-job"}

        async def download(*_):
            path, ref = server.film._new(server.COMFY_DIR, "output", "formal", ".mp4")
            path.write_bytes(server.tools.ref_path(server.COMFY_DIR, refs[0]["ref"]).read_bytes())
            return {"files":[{"ref":ref,"path":path,"kind":"video"}]}

        payload = {"board":"test","kind":"video","provider":provider["id"],"video_refs":refs,
                   "prompt":"按 @视频1 运镜，并参考 @视频2 动作。","ar":1,"duration":5}
        with patch.object(server.providers, "routes", return_value=[route]), \
                patch.object(server.providers, "all_providers", return_value=[]), \
                patch.object(server.remote, "json_req", side_effect=upstream), \
                patch.object(server.remote, "_save_video", side_effect=download):
            self.assertEqual((await self.client.post("/api/generate", json=payload, headers={"X-Uid":"8"})).status, 403)
            self.assertEqual((await self.client.post("/api/generate", json={**payload,"video_refs":[{**refs[0],"end":3}]})).status, 400)
            self.assertEqual((await self.client.post("/api/generate", json={**payload,"video_refs":[{**refs[0],"node_id":"n4"}]})).status, 400)
            self.svc.model.side_effect = [call("video_generate", {"prompt":payload["prompt"], "video_refs":[
                {k:v for k,v in item.items() if k!="ref"} for item in refs]}), answer()]
            await self.wait(await self.send("按这两个参考片段生成", selected=["n3","n4"]), timeout=10)
        self.assertEqual(checked, ["blue","red"])
        for lease in leases:
            self.assertEqual((await self.client.get(lease)).status, 404)
        board = self.load()
        result = board["nodes"][-1]
        self.assertEqual([e["ref"] for e in board["edges"]], [item["ref"] for item in refs])
        self.assertEqual([e["start"] for e in result["versions"][0]["input_edges"]], [2,0])
        self.assertTrue(all(e["relation"]=="video_ref" for e in board["edges"]))
