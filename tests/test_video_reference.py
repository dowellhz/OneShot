import asyncio
import io
import json
import wave
from unittest.mock import patch
from urllib.parse import urlsplit

import av
import numpy as np
from aiohttp import web
from PIL import Image

import server
from test_agent_chat import ChatFixture, answer, call


class ReferenceVideo(ChatFixture):
    async def test_ark_endpoint_uses_its_configured_model_for_limits_and_keeps_the_endpoint_on_submit(self):
        endpoint, flash, unmarked = "ep-project-main","ep-project-fast","ep-project-original"
        config = {"motion_origin":"https://studio.example","models":{"video":endpoint},
                  "video_endpoint_models":f"{endpoint} seedance-2.5\n{flash} seedance-2.5-flash",
                  "generation_rates":f"video {endpoint} 4k 0.25"}
        provider = server.providers.save(None,"ark","方舟接入点",config,{"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":model} for model in (endpoint,unmarked)])
        with self.assertRaisesRegex(server.providers.ProviderError,"接入点 ID 重复"):
            server.providers.save(provider,"ark","错误配置",
                {"video_endpoint_models":f"{endpoint} seedance-2.5\n{endpoint} seedance-2.0"},{},True)
        self.assertEqual(server.providers.get(provider)["config"]["video_endpoint_models"],
                         {endpoint:"seedance-2.5",flash:"seedance-2.5-flash"})
        options = json.loads((await server.capabilities(None)).body)
        configured = next(item for item in options["video"] if item["id"] == provider)
        rows = {option["id"]:option for option in configured["models"]}
        self.assertEqual((rows[endpoint]["durations"][-1],rows[endpoint]["qualities"]["4k"],rows[endpoint]["draft"]),(30,"4k",True))
        self.assertEqual(rows[flash]["reference_limits"],{"images":10,"videos":5,"audio":5,"seconds":30})
        self.assertFalse(rows[flash]["draft"])
        self.assertNotIn("4k",rows[flash]["qualities"])
        self.assertEqual(rows[unmarked]["reference_limits"]["seconds"],15)
        self.assertEqual([model["id"] for service in options["segment_edit"] if service["id"]==provider
                          for model in service["models"]],[endpoint,flash])

        path,ref = server.film._new(server.COMFY_DIR,"input","endpoint-sound",".wav")
        with wave.open(str(path),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x08"*(18*8000))
        server.grant_media({"id":7},ref)
        self.board["nodes"].append({"id":"endpoint-audio","type":"audio","name":"声音","x":0,"y":0,"data":{},
                                    "versions":[{"ref":ref}],"cur":0})
        server.write_board(server.board_path("test"),self.board)
        request = {"kind":"video","board":"test","provider":provider,"selected_model":endpoint,"prompt":"跟随声音",
                   "duration":22,"quality":"4k","audio_refs":[{"node_id":"endpoint-audio","ref":ref}]}
        preview = await self.client.post("/api/preview",json=request)
        self.assertEqual(preview.status,200,await preview.text())
        self.assertIn("22 秒 · 4k",(await preview.json())["mode"])
        costs = await self.client.post("/api/generation-cost",json={"requests":[{**request,"count":2}]})
        self.assertEqual((await costs.json())["amounts"],[11])
        with patch.object(server,"start_remote") as submit:
            response = await self.client.post("/api/generate",json=request)
            self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["video_model"],{"provider":provider,"selected_model":endpoint})
        _,_,service,model,_,request_data = submit.call_args.args
        self.assertEqual(model,endpoint)
        submitted = await server.remote.ark_video_body(model,request_data,provider=service)
        self.assertEqual((submitted["model"],submitted["resolution"],submitted["duration"]),(endpoint,"4k",22))
        self.assertEqual(submitted["content"][-1]["role"],"reference_audio")
        extension = await server.remote.ark_video_body(model,{**request_data,"audio_refs":[],"extension":"after",
            "video_urls":["https://studio.example/clip.mp4"]},provider=service)
        self.assertEqual((extension["model"],extension["omni_reference_task_type"],extension["ratio"]),
                         (endpoint,"extend","adaptive"))

    async def test_cloud_h3_sends_mixed_references_and_revokes_leases(self):
        provider = server.providers.save(None,"minimax","云端 H3 测试",{"motion_origin":"https://studio.example"},
                                         {"api_key":"fixture"},True)
        model = "MiniMax-H3"
        server.providers.set_route("video",[{"provider_id":provider,"model":model}])
        path, ref = server.film._new(server.COMFY_DIR,"input","h3-motion",".mp4")
        server.film.encode_silent(path,(Image.new("RGB",(64,64),"navy") for _ in range(48)),64,64,24,lambda:False,lambda _:None)
        audio, sound = server.film._new(server.COMFY_DIR,"input","h3-sound",".wav")
        with wave.open(str(audio),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x00" * (16*8000) + b"\x00\x08" * 16000)
        self.board["nodes"].extend([
            {"id":"n3","type":"video","name":"参考动作","versions":[{"ref":ref}],"cur":0,"data":{}},
            {"id":"n4","type":"audio","name":"参考声音","versions":[{"ref":sound}],"cur":0,"data":{}},
        ])
        server.write_board(server.board_path("test"),self.board)
        request = {"kind":"video","board":"test","provider":provider,"selected_model":model,"duration":4,
                   "prompt":"参考 @视频1 和 @音频1","quality":"std","images":[{"ref":self.source["ref"]}],
                   "video_refs":[{"node_id":"n3","ref":ref}],"audio_refs":[{"node_id":"n4","ref":sound,"start":16,"end":18}]}
        leases = []

        async def upstream(_http,method,url,_name,**kwargs):
            if method == "GET":
                return {"task":{"status":"succeeded","content":{"url":"https://example.test/result.mp4"}}}
            self.assertTrue(url.endswith("/v2/video_generation"))
            payload = kwargs["json"]
            self.assertEqual((payload["duration"],payload["resolution"]),(4,"768P"))
            self.assertEqual([item.get("role") for item in payload["content"]],
                             [None,"reference_image","reference_video","reference_audio"])
            for item, mime in zip(payload["content"][2:],("video/mp4","audio/wav")):
                lease = urlsplit(item[item["type"]]["url"]).path
                response = await self.client.get(lease)
                self.assertEqual((response.status,response.content_type),(200,mime))
                if mime == "audio/wav":
                    with wave.open(io.BytesIO(await response.read()),"rb") as recording:
                        self.assertEqual(recording.getnframes(),2*recording.getframerate())
                        self.assertTrue(any(recording.readframes(recording.getnframes())))
                leases.append(lease)
            return {"task_id":"h3-mixed"}

        with patch.object(server.remote,"json_req",side_effect=upstream), \
                patch.object(server.remote,"_save_video",return_value={"files":[]}):
            response = await self.client.post("/api/generate",json=request)
            self.assertEqual(response.status,200,await response.text())
            jid = (await response.json())["ids"][0]
            for _ in range(300):
                if server.JOBS[jid]["state"] in ("done","error"):
                    break
                await asyncio.sleep(.02)
        self.assertEqual(server.JOBS[jid]["state"],"done",server.JOBS[jid].get("error"))
        self.assertEqual(len(leases),2)
        for lease in leases:
            self.assertEqual((await self.client.get(lease)).status,404)
        options = json.loads((await server.capabilities(None)).body)
        output = next(item for item in options["video"] if item["id"]==provider)["models"][0]
        self.assertEqual((output["durations"][0],output["durations"][-1],output["qualities"]),
                         (4,15,{"std":"768P","hd":"2K"}))
        self.assertTrue(output["accepts_audio"] and output["accepts_video"])
        self.assertEqual(output["reference_limits"],{"images":9,"videos":3,"audio":3,"seconds":15,"total":12})
        self.assertNotIn(provider,[item["id"] for item in options["video_extension"]])

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
