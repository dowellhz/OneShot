import asyncio
import base64
import io
import json
import time
from fractions import Fraction
from unittest.mock import patch
from urllib.parse import urlsplit

import av
import numpy as np
from PIL import Image

import server
import db
from test_agent_chat import ChatFixture, answer, call


class SegmentEdit(ChatFixture):
    async def test_native_draft_can_finalize_after_job_recovery_without_resubmitting_inputs(self):
        film=server.film
        files=[]
        for i in range(2):
            path,ref=film._new(server.COMFY_DIR,"output",f"draft-result-{i}",".mp4")
            film.encode_silent(path,(Image.new("RGB",(64,64),"red") for _ in range(24)),
                               64,64,24,lambda:False,lambda _:None)
            files.append({"files":[{"path":path,"ref":ref,"kind":"video"}]})
        draft_ref=files[0]["files"][0]["ref"]
        provider={"id":"ark-draft","name":"方舟","kind":"ark","enabled":True,"config":{},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-test"}
        payload={"kind":"video","board":"test","prompt":"产品入镜","draft":True}
        posts=[]

        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="POST":
                posts.append(kwargs["json"])
                return {"id":f"task-{len(posts)}"}
            return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}

        async def job(response):
            self.assertEqual(response.status,200,await response.text())
            jid=(await response.json())["ids"][0]
            for _ in range(300):
                state=server.JOBS[jid]
                if state["state"] in ("done","error"):
                    break
                await asyncio.sleep(.01)
            self.assertEqual(state["state"],"done",state.get("error"))
            return jid

        with patch.object(server.providers,"primary",return_value=route),patch.object(server.providers,"get",return_value=provider), \
             patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",side_effect=files):
            route["model"]="doubao-seedance-2-5-flash-test"
            self.assertEqual((await self.client.post("/api/generate",json=payload)).status,400)
            route["model"]="doubao-seedance-2-5-test"
            jid=await job(await self.client.post("/api/generate",json=payload))
            self.assertEqual((posts[0]["draft"],posts[0]["resolution"]),(True,"480p"))
            self.assertEqual(posts[0]["content"][0]["text"],"产品入镜")
            server.JOBS.clear()
            recovered=await (await self.client.get("/api/jobs?ids="+jid)).json()
            self.assertGreater(recovered[jid]["outputs"][0]["extra"]["draft_expires"],0)
            self.assertNotIn("task-1",json.dumps(recovered))
            self.board["nodes"].append({"id":"n4","type":"video","name":"样片","x":0,"y":0,"data":{},"cur":0,
                                       "versions":[{"ref":draft_ref}]})
            server.write_board(server.board_path("test"),self.board)
            final={"board":"test","node":"n4","ref":draft_ref,"resolution":"4k","request_key":"test-draft-final-0001"}
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json=final,headers={"X-Uid":"8"})).status,403)
            final_id=await job(await self.client.post("/api/video/draft/finalize",json=final))
            self.assertEqual(posts[1],{"model":route["model"],"content":[{"type":"draft_task","draft_task":{"id":"task-1"}}],
                                       "resolution":"4k","watermark":False})
            replay=await self.client.post("/api/video/draft/finalize",json=final)
            self.assertEqual((await replay.json())["ids"],[final_id])
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json={**final,"resolution":"1080p"})).status,400)
            db.run("UPDATE video_drafts SET expires=0 WHERE ref=?",draft_ref)
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json={
                **final,"request_key":"test-draft-final-0002"})).status,400)
            self.assertEqual(len(posts),2)

    async def test_assistant_finalizes_a_previous_draft_in_the_same_node(self):
        files = []
        for color in ("red", "green", "blue"):
            path, ref = server.film._new(server.COMFY_DIR, "output", f"draft-{color}", ".mp4")
            server.film.encode_silent(path, (Image.new("RGB", (64, 64), color) for _ in range(24)),
                                      64, 64, 24, lambda: False, lambda _: None)
            files.append({"path":path, "ref":ref, "kind":"video"})
        sample, alternate, final = files
        provider = {"id":"ark-draft", "name":"方舟", "kind":"ark", "enabled":True,
                    "config":{}, "secrets":{"api_key":"fixture"}}
        model = "doubao-seedance-2-5-test"
        db.task_start(id="sample-job", user_id=7, board_id="test", provider_id=provider["id"],
                      provider_kind="ark", model=model, state="done", outputs=[sample["ref"]])
        db.run("INSERT INTO video_drafts VALUES (?,?,?,?)", sample["ref"], "sample-job", "private-sample-id", time.time()+3600)
        sample_edge = {"from":"n1", "to":"n4", "role":"first"}
        alternate_edge = {"from":"n2", "to":"n4"}
        self.board["edges"] = [alternate_edge]
        self.board["nodes"].append({"id":"n4", "type":"video", "name":"产品镜头", "x":0, "y":0, "cur":1,
            "data":{"prompt":"当前的另一镜"}, "versions":[
                {"ref":sample["ref"], "prompt":"原样片提示", "input_edges":[sample_edge],
                 "node_data":{"prompt":"原样片提示", "draft":True},
                 "video_recipe":{"kind":"video", "prompt":"原样片提示", "draft":True, "duration":4},
                 "generation_record":{"effective_prompt":"原样片提示", "settings":{"duration":4}}},
                {"ref":alternate["ref"], "prompt":"当前的另一镜"}]})
        server.write_board(server.board_path("test"), self.board)
        posts = []

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "POST":
                board = self.load()
                self.assertEqual(board["nodes"][-1]["data"]["prompt"], "当前的另一镜")
                self.assertEqual(board["edges"], [alternate_edge])
                posts.append(kwargs["json"])
                return {"id":"final-task"}
            return {"status":"succeeded", "content":{"video_url":"https://provider.example/final.mp4"}}

        self.svc.model.side_effect = [call("video_draft_status", {"node_id":"n4"}, "read"),
            call("video_draft_finalize", {"node_id":"n4", "version":1, "resolution":"4k"}, "finalize"), answer()]
        with patch.object(server.providers, "get", return_value=provider), \
             patch.object(server.remote, "json_req", side_effect=upstream), \
             patch.object(server.remote, "_save_video", return_value={"files":[final]}):
            run = await self.send("把第一版样片做成 4K 定稿", selected=["n4"])
            await self.wait(run)
        rows = db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid", run)
        status, result = [json.loads(row["result"]) for row in rows]
        self.assertEqual([(v["version"], v["current"], v["expired"]) for v in status["drafts"]], [(1, False, False)])
        self.assertNotIn("private-sample-id", json.dumps([status, result]))
        self.assertEqual(posts, [{"model":model, "content":[{"type":"draft_task", "draft_task":{"id":"private-sample-id"}}],
                                  "resolution":"4k", "watermark":False}])
        self.assertEqual(result["nodes"][0]["id"], "n4")
        board = self.load()
        node = board["nodes"][-1]
        self.assertEqual((len(node["versions"]), node["cur"]), (3, 2))
        self.assertEqual([v["ref"] for v in node["versions"]], [v["ref"] for v in files])
        self.assertEqual((node["data"]["prompt"], board["edges"]), ("原样片提示", [sample_edge]))
        self.assertNotIn("draft", node["data"])
        self.assertEqual(node["versions"][-1]["generation_record"]["settings"],
                         {"duration":4, "resolution":"4k", "provider_model":model})
        report = server.workflow_review.build(board, "n4", 3)
        self.assertFalse(report["has_cycle"])
        self.assertEqual([(v["node"], v["version"]) for v in report["steps"][-1]["inputs"] if v["role"] == "定稿样片"],
                         [("n4", 1)])

    async def test_agent_can_read_a_saved_box_and_change_replacement_using_an_older_version(self):
        film = server.film
        source, ref = film._new(server.COMFY_DIR,"input","agent-object",".mp4")
        film.encode_silent(source,(Image.new("RGB",(64,64),"gray") for _ in range(144)),
                           64,64,24,lambda:False,lambda _:None)
        blue = server.image_editor.save(server.COMFY_DIR,Image.new("RGBA",(64,64),"blue"),"input")
        self.board["nodes"][0]["versions"].append(blue)
        self.board["nodes"][0]["cur"] = 1
        self.board["nodes"].append({"id":"n3","type":"video","name":"道具镜头","x":30,"y":350,
                                   "data":{},"cur":0,"versions":[{"ref":ref,"seconds":6,"w":64,"h":64}]})
        server.write_board(server.board_path("test"),self.board)
        asset_response=await self.client.post("/api/library",json={
            "kind":"prop","name":"蓝色道具","ref":blue["ref"],"board":"test","source_board":"test","node_id":"n1"})
        self.assertEqual(asset_response.status,200,await asset_response.text())
        asset=await asset_response.json()
        outputs = []
        for i in range(3):
            path, take = film._new(server.COMFY_DIR,"output",f"agent-take-{i}",".mp4")
            film.encode_silent(path,(Image.new("RGB",(64,64),"white") for _ in range(96)),
                               64,64,24,lambda:False,lambda _:None)
            outputs.append({"files":[{"path":path,"ref":take,"kind":"video"}]})
        route = {"provider":{"id":"object-service","name":"方舟","kind":"ark","enabled":True,
                 "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}},
                 "model":"doubao-seedance-2-5-test"}
        posts = []
        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="POST":
                posts.append(kwargs["json"])
                return {"id":f"agent-object-{len(posts)}"}
            return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}
        plan={"action":"remove","at":1,"box":[.1,.2,.7,.8]}
        first={"node_id":"n3","start":0,"end":4}
        with patch.object(server.providers,"routes",return_value=[route]),patch.object(server.providers,"all_providers",return_value=[]), \
             patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",side_effect=outputs):
            self.svc.model.side_effect=[call("video_edit_segment",{**first,"object_edit":{"action":"remove"}}),answer()]
            invalid=await self.send("移除物体",selected=["n3"])
            await self.wait(invalid)
            self.assertIn("标注物体的时间",json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",invalid)["result"])["error"])
            self.assertEqual(posts,[])

            self.svc.model.side_effect=[call("video_edit_segment",{**first,"object_edit":plan}),answer()]
            await self.wait(await self.send("移除框选的物体",key="request002",selected=["n3"]))
            saved=self.load()
            target=saved["nodes"][-1]
            nid=target["id"]
            target["data"]["object_edit"]={**plan,"at":2,"box":[.2,.2,.8,.8]}
            saved["edges"][-1].update(start=1,end=5)
            saved["rev"]+=1
            server.write_board(server.board_path("test"),saved)

            self.svc.model.side_effect=[
                call("video_object_settings",{"node_id":nid,"version":1},"read-prior"),
                call("video_regenerate",{"node_id":nid,"version":1,
                    "object_edit":{"replacement":{"node_id":"n1","version":1}}},"revise"),answer()]
            run=await self.send("用图片第一版替换，沿用视频第一版的框",key="request003",selected=[nid,"n1"])
            await self.wait(run)
            self.svc.model.side_effect=[call("video_regenerate",{"node_id":nid,
                "object_edit":{"replacement":{"memory_id":asset["id"]}}},"use-asset"),answer()]
            await self.wait(await self.send("改用资产库的蓝色道具",key="request004",selected=[nid]))
        results=[json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",run)]
        self.assertEqual(results[0]["object_edit"],plan)
        self.assertEqual((results[0]["source"]["start"],results[0]["source"]["end"]),(0,4))
        revised=self.load()["nodes"][-1]
        self.assertEqual(revised["id"],nid)
        self.assertEqual(len(revised["versions"]),3)
        expected={**plan,"action":"replace","replacement_ref":self.source["ref"],"replacement_name":"产品"}
        self.assertEqual(revised["versions"][0]["video_recipe"]["object_edit"],plan)
        self.assertEqual(revised["versions"][1]["video_recipe"]["object_edit"],expected)
        self.assertEqual(revised["versions"][2]["video_recipe"]["object_edit"],{
            **expected,"replacement_ref":blue["ref"],"replacement_name":"蓝色道具"})
        stills=[item["image_url"]["url"] for item in posts[1]["content"] if item["type"]=="image_url"]
        self.assertEqual(len(stills),2)
        with Image.open(io.BytesIO(base64.b64decode(stills[1].split(",",1)[1]))) as image:
            red, _, blue_value=image.convert("RGB").getpixel((image.width//2,image.height//2))
            self.assertGreater(red-blue_value,150)

    async def test_assistant_edits_titles_on_the_selected_timeline_and_saves_a_version(self):
        from PIL import ImageFont

        refs = []
        for color in ("navy", "navy", "green"):
            path, ref = server.film._new(server.COMFY_DIR,"output","title-fixture",".mp4")
            frames = (Image.new("RGB",(64,64),color) for _ in range(24))
            server.film.encode_silent(path,frames,64,64,24,lambda:False,lambda _:None)
            refs.append(ref)
        original, prior, other = refs
        clip = {"node":"n4","ref":original,"kind":"video","in":0,"out":1,"trans":"cut","volume":1,"subs":[],
                "captions":[{"text":"A line","start":.2,"end":.4}]}
        timeline = {"clips":[clip],"aspect":"source","fit":"blur","subtitles":True,"narration":[],"audio_clips":[],"cover":.25,
                    "titles":[{"text":"Remove Me","start":0,"end":.3},
                              {"text":"Station","start":.1,"end":.4,"position":"lower_left"},
                              {"text":"Scene 1","start":.4,"end":.6,"position":"top"}]}
        edge = {"from":"n1","to":"n4","role":"first"}
        self.board["nodes"].append({"id":"n4","type":"video","name":"站台镜头","x":0,"y":0,"cur":1,
             "data":{"prompt":"当前的另一镜"},"versions":[{"ref":prior,"prompt":"原镜头","input_edges":[edge],
                "node_data":{"prompt":"原镜头"},"film_recipe":{"clips":[clip],"audio":[],"timeline":timeline}}, {"ref":other}]})
        self.board["collaborators"] = {"8":"reviewer"}
        server.write_board(server.board_path("test"),self.board)
        stale = {"board":"test","spec":timeline,"target":{"node":"n4","ref":original},"request_key":"stale-title-export"}
        self.assertEqual((await self.client.post("/api/render",json=stale)).status,409)
        self.assertEqual((await self.client.post("/api/render",json={**stale,"target":{"node":"n4","ref":prior}},
                                                headers={"X-Uid":"8"})).status,403)
        self.assertFalse(server.JOBS)
        identify = {"node_id":"n4","version":1}
        changes = [{"action":"remove","number":1},{"action":"update","number":2,"title":{"text":"Platform 2"}},
                   {"action":"add","title":{"text":"Closing","start":.7,"style":"label"}}]
        self.svc.model.side_effect = [call("video_titles_get",identify,"read-titles"),
            call("video_titles_edit",{**identify,"changes":changes},"edit-titles"),answer()]
        font = ImageFont.load_default(size=12)
        with patch.object(ImageFont,"truetype",side_effect=lambda _path,size:font.font_variant(size=size)):
            run = await self.send("改第一版的标题，保留字幕",selected=["n4"])
            await self.wait(run)
        results = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",run)]
        self.assertEqual([v["text"] for v in results[0]["titles"]],["Remove Me","Station","Scene 1"])
        self.assertEqual([v["text"] for v in results[1]["titles"]],["Platform 2","Scene 1","Closing"])
        self.assertEqual(results[1]["titles"][2]["end"],1)
        self.assertEqual(results[1]["nodes"][0]["id"],"n4")
        board = self.load()
        node = board["nodes"][-1]
        self.assertEqual((len(node["versions"]),node["cur"],node["data"]["prompt"],board["edges"]),(3,2,"原镜头",[edge]))
        self.assertEqual(node["versions"][0]["film_recipe"]["timeline"],timeline)
        rendered = node["versions"][-1]
        self.assertEqual(rendered["film_recipe"]["timeline"]["clips"],[clip])
        self.assertTrue(server.tools.ref_path(server.COMFY_DIR,rendered["ref"]).is_file())
        self.assertTrue(server.tools.ref_path(server.COMFY_DIR,rendered["cover"]).is_file())
        report = server.workflow_review.build(board,"n4",3)
        self.assertIn({"label":"标题 1","value":"0.1–0.4 秒 · Platform 2"},report["steps"][-1]["settings"])

    async def test_assistant_renders_cutaways_and_titles_together_with_pinned_sources(self):
        from PIL import ImageFont

        refs = []
        for colors in (("black",)*24, ("blue",)*12+("lime",)*12, ("yellow",)*24):
            path, ref = server.film._new(server.COMFY_DIR,"output","cutaway-agent",".mp4")
            server.film.encode_silent(path,(Image.new("RGB",(64,64),color) for color in colors),64,64,24,
                                      lambda:False,lambda _:None)
            refs.append(ref)
        main, insert, alternate = refs
        for nid, name, versions in (("n4","主片",[main]),("n5","书店镜头",[insert,alternate])):
            self.board["nodes"].append({"id":nid,"type":"video","name":name,"x":0,"y":0,"data":{},
                "cur":len(versions)-1,"versions":[{"ref":ref} for ref in versions]})
        server.write_board(server.board_path("test"),self.board)
        response = await self.client.post("/api/library",json={"kind":"prop","name":"红色道具","ref":self.source["ref"],
                                                  "board":"test","source_board":"test","node_id":"n1"})
        self.assertEqual(response.status,200,await response.text())
        asset = await response.json()
        video = {"action":"add","cutaway":{"source":{"node_id":"n5","version":1},"start":.25,"duration":.25,"in":.5}}
        still = {"action":"add","cutaway":{"source":{"memory_id":asset["id"]},"start":.5,"duration":.25}}
        overlap = {**still,"cutaway":{**still["cutaway"],"start":.3}}
        self.svc.model.side_effect = [call("video_cutaways_edit",{"node_id":"n4","changes":[video,overlap]}),answer()]
        invalid = await self.send("测试重叠的补画面",selected=["n4","n5"])
        await self.wait(invalid)
        self.assertIn("重叠",json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",invalid)["result"])["error"])
        self.assertFalse(db.q("SELECT id FROM tasks WHERE capability='render'"))

        title = {"action":"add","title":{"text":"Title","start":.75,"end":1,"style":"label"}}
        self.svc.model.side_effect = [call("video_cutaways_edit",{"node_id":"n4","changes":[video,still],"title_changes":[title]},"edit"),
            call("video_cutaways_get",{"node_id":"n4"},"get"),answer()]
        font = ImageFont.load_default(size=12)
        with patch.object(ImageFont,"truetype",side_effect=lambda _path,size:font.font_variant(size=size)):
            rid = await self.send("插入书店镜头第一版和道具图，再加标题",key="request002",selected=["n4","n5"])
            await self.wait(rid)
        edit, read = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)]
        self.assertEqual(len(db.q("SELECT id FROM tasks WHERE capability='render'")),1)
        self.assertEqual(read["cutaways"],edit["cutaways"])
        self.assertEqual(read["titles"][0]["text"],"Title")
        self.assertEqual([(item["ref"],item["start"],item["in"]) for item in read["cutaways"]],
                         [(insert,.25,.5),(self.source["ref"],.5,0)])
        node = next(n for n in self.load()["nodes"] if n["id"]=="n4")
        self.assertEqual((node["cur"],len(node["versions"])),(1,2))
        output = node["versions"][1]
        self.assertEqual(output["film_recipe"]["timeline"]["clips"][0]["ref"],main)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,output["ref"]))) as media:
            colors = [frame.to_ndarray(format="rgb24")[2,2] for frame in media.decode(video=0)]
        self.assertEqual(len(colors),24)
        self.assertGreater(colors[6][1],190)
        self.assertGreater(colors[12][0],190)
        self.assertLess(max(colors[18]),50)

        edits = [{"action":"update","number":2,"cutaway":{"start":.25}},{"action":"remove","number":1}]
        self.svc.model.side_effect = [call("video_cutaways_edit",{"node_id":"n4","version":2,"changes":edits}),answer()]
        with patch.object(ImageFont,"truetype",side_effect=lambda _path,size:font.font_variant(size=size)):
            rid = await self.send("移除书店镜头，保留道具图并移到 0.25 秒",key="request003",selected=["n4"])
            await self.wait(rid)
        node = next(n for n in self.load()["nodes"] if n["id"]=="n4")
        self.assertEqual((node["cur"],len(node["versions"])),(2,3))
        timeline = node["versions"][2]["film_recipe"]["timeline"]
        self.assertEqual(timeline["titles"],output["film_recipe"]["timeline"]["titles"])
        self.assertEqual([(item["ref"],item["start"]) for item in timeline["cutaways"]],[(self.source["ref"],.25)])

    async def test_assistant_saves_reorders_and_exports_a_playlist_without_changing_sources(self):
        refs = []
        for color in ("red", "yellow", "blue"):
            path, ref = server.film._new(server.COMFY_DIR,"output","playlist-agent",".mp4")
            server.film.encode_silent(path,(Image.new("RGB",(64,64),color) for _ in range(24)),
                                      64,64,24,lambda:False,lambda _:None)
            refs.append(ref)
        old, current, blue = refs
        for nid, values in (("n4",[old,current]),("n5",[blue])):
            self.board["nodes"].append({"id":nid,"name":nid,"type":"video","x":0,"y":0,"data":{},
                "cur":len(values)-1,"versions":[{"ref":ref} for ref in values]})
        server.write_board(server.board_path("test"),self.board)

        def tool_result(rid):
            return json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid DESC LIMIT 1",rid)["result"])

        self.svc.model.side_effect = [call("video_playlist_create",{"name":"审片","clips":[{"node_id":"n4","version":1},{"node_id":"n5"}]}),answer()]
        rid = await self.send("把两镜保存成审片列表",selected=["n4","n5"])
        await self.wait(rid)
        created = tool_result(rid)
        nid = created["playlist_node"]
        self.assertEqual([c["ref"] for c in created["clips"]],[old,blue])
        self.assertFalse(db.q("SELECT id FROM tasks WHERE capability='render'"))

        self.svc.model.side_effect = [call("video_playlist_read",{"node_id":nid},"read"),
            call("video_playlist_edit",{"node_id":nid,"revision":created["revision"],"order":[2,1],
                "changes":[{"action":"trim","number":2,"in":.25,"out":.75}]},"edit"),answer()]
        rid = await self.send("第二镜放到前面，只留 0.25 到 0.75 秒",key="request002",selected=[nid])
        await self.wait(rid)
        edited = tool_result(rid)
        self.assertEqual([(c["ref"],c["in"],c["out"]) for c in edited["clips"]],[(blue,.25,.75),(old,0,None)])
        saved = next(n for n in self.load()["nodes"] if n["id"]==nid)
        self.assertEqual(saved["versions"],[])
        self.assertFalse(db.q("SELECT id FROM tasks WHERE capability='render'"))
        stale = {"board":"test","spec":saved["data"]["film"],"request_key":"playlist-stale-request",
                 "target":{"node":nid,"playlist_revision":created["revision"]}}
        self.assertEqual((await self.client.post("/api/render",json=stale)).status,409)

        self.svc.model.side_effect = [call("video_playlist_export",{"node_id":nid,"revision":edited["revision"]}),answer()]
        rid = await self.send("导出这个播放列表",key="request003",selected=[nid])
        await self.wait(rid)
        exported = tool_result(rid)
        nodes = {n["id"]:n for n in self.load()["nodes"]}
        self.assertEqual(exported["playlist_node"],nid)
        self.assertEqual(exported["nodes"][0]["id"],nid)
        self.assertEqual(nodes[nid]["data"]["film"],saved["data"]["film"])
        self.assertEqual([v["ref"] for v in nodes["n4"]["versions"]],[old,current])
        self.assertEqual(nodes["n4"]["cur"],1)
        self.assertEqual(len(db.q("SELECT id FROM tasks WHERE capability='render'")),1)
        output = nodes[nid]["versions"][0]
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,output["ref"]))) as media:
            colors = [frame.to_ndarray(format="rgb24")[0,0] for frame in media.decode(video=0)]
        self.assertEqual(len(colors),36)
        self.assertTrue(all(px[2]>190 for px in colors[:12]))
        self.assertTrue(all(px[0]>190 and px[1]<60 for px in colors[12:]))

    async def test_box_guided_video_object_edit_submits_labeled_still_and_optional_replacement(self):
        film = server.film
        source, ref = film._new(server.COMFY_DIR, "input", "object-video", ".mp4")
        film.encode_silent(source, (Image.new("RGB",(96,96),"gray") for _ in range(120)),
                           96,96,24,lambda:False,lambda _:None)
        self.board["nodes"].append({"id":"n3","type":"video","name":"物体场景","x":0,"y":0,"data":{},"cur":0,
                                   "versions":[{"ref":ref,"seconds":5,"w":96,"h":96}]})
        server.write_board(server.board_path("test"),self.board)
        provider={"id":"ark-object","name":"方舟","kind":"ark","enabled":True,
                  "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-test"}
        submitted=[]
        request={"kind":"video","board":"test","provider":provider["id"],"segment_edit":True,
                 "video_refs":[{"node_id":"n3","ref":ref,"start":0,"end":4}],"prompt":""}
        selection={"action":"remove","at":1,"box":[.25,.25,.75,.75]}

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "GET":
                return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}
            submitted.append(kwargs["json"])
            return {"id":f"object-{len(submitted)}"}

        with patch.object(server.providers,"routes",return_value=[route]),patch.object(server.providers,"all_providers",return_value=[]), \
             patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",return_value={
                 "files":[{"path":source,"ref":ref,"kind":"video"}]}):
            for plan in ({**selection,"at":4}, {**selection,"box":[.5,.2,.3,.5]}, {**selection,"action":"replace"}):
                invalid=await self.client.post("/api/generate",json={**request,"object_edit":plan})
                self.assertEqual(invalid.status,400)
            replacement={**selection,"action":"replace","replacement_ref":self.source["ref"]}
            for plan in (selection,replacement):
                response=await self.client.post("/api/generate",json={**request,"object_edit":plan})
                self.assertEqual(response.status,200)
                payload=await response.json()
                self.assertEqual(payload["reference_context"]["object_edit"],plan)
                job=server.JOBS[payload["ids"][0]]
                for _ in range(200):
                    if job["state"] in ("done","error"):
                        break
                    await asyncio.sleep(.01)
                self.assertEqual(job["state"],"done",job.get("error"))

        for request, expected, count in zip(submitted,("移除该物体","用 @图片2"),(1,2)):
            self.assertEqual(request["omni_reference_task_type"],"edit")
            self.assertIn(expected,request["content"][0]["text"])
            pictures=[item["image_url"]["url"] for item in request["content"] if item["type"]=="image_url"]
            self.assertEqual(len(pictures),count)
            with Image.open(io.BytesIO(base64.b64decode(pictures[0].split(",",1)[1]))) as frame:
                red, green, _=frame.convert("RGB").getpixel((frame.width//2,round(.25*frame.height)))
                self.assertGreater(red-green,60)

    async def test_camera_retake_preview_and_regeneration_keep_structured_version_settings(self):
        film = server.film
        def sample(kind, name, color, frames):
            path, ref = film._new(server.COMFY_DIR, kind, name, ".mp4")
            film.encode_silent(path, (Image.new("RGB", (64,64), color) for _ in range(frames)),
                               64, 64, 24, lambda:False, lambda _:None)
            return path, ref
        _, source_ref = sample("input", "retake-source", "red", 120)
        takes = [sample("output", f"take-{i}", color, 96) for i, color in enumerate(("green","blue"))]
        self.board["nodes"].append({"id":"n3","type":"video","name":"原片","x":100,"y":100,"data":{},"cur":0,
                                   "versions":[{"ref":source_ref,"seconds":5,"w":64,"h":64}]})
        server.write_board(server.board_path("test"), self.board)
        provider = {"id":"ark-retake","name":"方舟","kind":"ark","enabled":True,
                    "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        route = {"provider":provider,"model":"doubao-seedance-2-5-test"}
        start={"angle":"front","scale":"close"}
        end={"angle":"right","scale":"wide"}
        cut={"mode":"cut","start":start,"end":end}
        move={**cut,"mode":"move"}
        scope={"node_id":"n3","start":.5,"end":4.5}
        payload={"kind":"video","board":"test","segment_edit":True,"video_refs":[{**scope,"ref":source_ref}],
                 "provider":provider["id"],"camera_plan":cut,"prompt":""}
        preview=await self.client.post("/api/preview",json=payload)
        self.assertEqual(preview.status,200)
        expected=(await preview.json())["prompt"]
        self.assertIn("片段中点硬切",expected)
        self.assertIn("右侧 · 全景",expected)
        invalid=await self.client.post("/api/generate",json={**payload,"camera_plan":{"mode":"move","start":start}})
        self.assertEqual(invalid.status,400)

        submitted=[]
        async def upstream(_http, method, _url, _name, **kwargs):
            if method=="POST":
                request=kwargs["json"]
                self.assertEqual(request["omni_reference_task_type"], "edit")
                submitted.append(request["content"][0]["text"])
                return {"id":f"retake-{len(submitted)}"}
            return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}

        files=[{"files":[{"path":path,"ref":ref,"kind":"video"}]} for path,ref in takes]
        with patch.object(server.providers,"routes",return_value=[route]), patch.object(server.providers,"all_providers",return_value=[]), \
             patch.object(server.remote,"json_req",side_effect=upstream), patch.object(server.remote,"_save_video",side_effect=files):
            self.svc.model.side_effect=[call("video_edit_segment",{**scope,"camera_plan":cut}),answer()]
            await self.wait(await self.send("换一个机位",selected=["n3"]),timeout=10)
            first=self.load()["nodes"][-1]
            self.svc.model.side_effect=[call("video_regenerate",{"node_id":first["id"],"camera_plan":move},"retake"),answer()]
            await self.wait(await self.send("改成连续运镜",key="request002",selected=[first["id"]]),timeout=10)
        final=self.load()
        retained=final["nodes"][-1]
        self.assertEqual(len(final["nodes"]),4)
        self.assertEqual(retained["id"],first["id"])
        self.assertEqual([v["video_recipe"]["camera_plan"] for v in retained["versions"]],[cut,move])
        self.assertEqual([v["node_data"]["camera_plan"] for v in retained["versions"]],[cut,move])
        self.assertEqual(submitted[0],expected)
        self.assertIn("平滑、连续移动",submitted[1])
        self.assertNotIn("片段中点硬切",submitted[1])

    async def test_chat_capture_creates_a_linked_image_from_an_explicit_older_video_version(self):
        film = server.film
        old, old_ref = film._new(server.COMFY_DIR, "input", "old-frame-source", ".mp4")
        new, new_ref = film._new(server.COMFY_DIR, "input", "new-frame-source", ".mp4")
        for path, color in [(old,"orange"), (new,"blue")]:
            film.encode_silent(path, (Image.new("RGB", (64,64), color) for _ in range(24)),
                               64, 64, 24, lambda:False, lambda _:None)
        self.board["nodes"].append({"id":"n3","type":"video","name":"镜头","x":200,"y":300,"data":{},"cur":1,
                                   "versions":[{"ref":old_ref,"seconds":1},{"ref":new_ref,"seconds":1}]})
        server.write_board(server.board_path("test"), self.board)
        self.svc.model.side_effect = [call("video_capture_frame", {"node_id":"n3","version":1,"position":"time","at":.52}), answer()]
        await self.wait(await self.send("第一版取 0.52 秒画面", selected=["n3"]))
        board = self.load()
        image = board["nodes"][-1]
        v = image["versions"][0]
        self.assertEqual(image["type"], "image")
        self.assertEqual(v["capture"], {"source_node":"n3","source_ref":old_ref,"position":"time","at":.5})
        self.assertEqual(board["edges"][-1], {"from":"n3","to":image["id"],"relation":"capture","source_ref":old_ref,"at":.5})
        with Image.open(server.tools.ref_path(server.COMFY_DIR, v["ref"])) as picture:
            self.assertGreater(picture.getpixel((32,32))[0], 190)
        self.assertEqual(board["nodes"][-2]["cur"], 1)

    async def test_trim_api_detects_and_exports_independent_frame_accurate_clips(self):
        film = server.film
        source, ref = film._new(server.COMFY_DIR, "input", "trim-source", ".mp4")
        with av.open(str(source), "w") as output:
            video = output.add_stream("libx264", rate=24)
            video.width = video.height = 64
            video.pix_fmt = "yuv420p"
            audio = output.add_stream("aac", rate=film.SR)
            audio.layout = "stereo"
            for index in range(72):
                color = "white" if 24 <= index < 48 else "black"
                for packet in video.encode(av.VideoFrame.from_image(Image.new("RGB", (64,64), color))):
                    output.mux(packet)
            for packet in video.encode():
                output.mux(packet)
            for offset in range(0, film.SR * 2, 1024):
                ticks = np.arange(offset, min(offset + 1024, film.SR * 2))
                tone = (.2 * np.sin(ticks * 440 * 2 * np.pi / film.SR)).astype(np.float32)
                frame = av.AudioFrame.from_ndarray(np.stack([tone, tone]), format="fltp", layout="stereo")
                frame.sample_rate = film.SR
                frame.pts = offset + round(1.125 * film.SR)
                frame.time_base = Fraction(1, film.SR)
                for packet in audio.encode(frame):
                    output.mux(packet)
            for packet in audio.encode():
                output.mux(packet)

        async def trim(action, points):
            return await self.client.post("/api/video/trim", json={"ref":ref,"action":action,"points":points})

        detected = await trim("detect", [3,69])
        self.assertEqual(detected.status, 200)
        self.assertEqual((await detected.json())["cuts"], [24,48])
        self.assertEqual((await trim("render", [3,3,69])).status, 400)
        self.assertEqual((await trim("render", [3,73])).status, 400)
        generated = await trim("render", [3,24,48,69])
        self.assertEqual(generated.status, 200)
        clips = (await generated.json())["clips"]
        self.assertEqual([(c["start"],c["end"]) for c in clips], [(.125,1),(1,2),(2,2.875)])
        for clip, length, white in zip(clips, [21,24,21], [False,True,False]):
            self.assertNotEqual(clip["ref"], ref)
            response = await self.client.get(clip["url"])
            self.assertEqual(response.status, 200)
            with av.open(io.BytesIO(await response.read())) as media:
                frames = list(media.decode(video=0))
            self.assertEqual(len(frames), length)
            self.assertEqual(frames[0].to_ndarray(format="rgb24")[0,0,0] > 200, white)
        silence = film.read_audio(server.tools.ref_path(server.COMFY_DIR, clips[0]["ref"]))[0]
        sound = film.read_audio(server.tools.ref_path(server.COMFY_DIR, clips[1]["ref"]))[0]
        self.assertLess(float(np.max(np.abs(silence))), .025)
        self.assertGreater(float(np.max(np.abs(sound))), .1)
        self.assertEqual(film.probe(source)[2], 3)

    async def test_native_edit_restricts_reference_and_can_reconstruct_exact_timeline(self):
        film=server.film
        original,source_ref=film._new(server.COMFY_DIR,"input","original",".mp4")
        frames=(Image.new("RGB",(64,64),"red" if i<6 else "green") for i in range(120))
        film.encode_silent(original,frames,64,64,24,lambda:False,lambda _:None)
        edited,edit_ref=film._new(server.COMFY_DIR,"output","segment",".mp4")
        film.encode_silent(edited,(Image.new("RGB",(64,64),"blue") for _ in range(96)),64,64,24,lambda:False,lambda _:None)
        self.board["nodes"].append({"id":"n3","type":"video","name":"原镜头","x":200,"y":100,"data":{},"cur":0,
                                   "versions":[{"ref":source_ref,"seconds":5,"w":64,"h":64}]})
        server.write_board(server.board_path("test"),self.board)
        provider={"id":"ark-segment","name":"方舟","kind":"ark","enabled":True,
                  "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-test"}
        submitted=[]

        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="GET":
                return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}
            req=kwargs["json"]
            self.assertEqual((req["omni_reference_task_type"],req["duration"],req["ratio"]),("edit",-1,"adaptive"))
            self.assertIn("编辑 @视频1",req["content"][0]["text"])
            lease=urlsplit(req["content"][1]["video_url"]["url"])
            submitted.append(lease.path)
            response=await self.client.get(lease.path)
            self.assertEqual(response.status,200)
            with av.open(io.BytesIO(await response.read())) as source:
                self.assertEqual(len(list(source.decode(video=0))),96)
            return {"id":"edit-job"}

        with patch.object(server.providers,"routes",return_value=[route]),patch.object(server.providers,"all_providers",return_value=[]), \
             patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",return_value={
                 "files":[{"path":edited,"ref":edit_ref,"kind":"video"}]}):
            raw={"kind":"video","board":"test","provider":provider["id"],"segment_edit":True,"prompt":"改成夜景",
                 "video_refs":[{"node_id":"n3","ref":source_ref,"start":.25,"end":3.25}]}
            invalid=await self.client.post("/api/generate",json=raw)
            self.assertEqual(invalid.status,400)
            self.assertIn("4 到 30 秒",(await invalid.json())["error"])
            valid={**raw,"video_refs":[{**raw["video_refs"][0],"end":4.25}]}
            route["model"]="doubao-seedance-2-0-test"
            self.assertEqual((await self.client.post("/api/generate",json=valid)).status,400)
            route["model"]="doubao-seedance-2-5-test"
            self.svc.model.side_effect=[call("video_edit_segment",{"node_id":"n3","start":.25,"end":4.25,"prompt":"改成夜景"}),answer()]
            await self.wait(await self.send("修改这四秒",selected=["n3"]))
        self.assertEqual(len(submitted),1)
        self.assertEqual((await self.client.get(submitted[0])).status,404)
        saved=self.load()
        result=saved["nodes"][-1]["versions"][0]
        self.assertEqual(result["seconds"],4)
        self.assertTrue(result["input_edges"][0]["segment_edit"])
        self.assertEqual(result["video_recipe"]["video_refs"][0]["source_seconds"],5)
        self.assertEqual(saved["nodes"][2]["versions"][0]["ref"],source_ref)

        specification={"clips":[{"ref":ref,"kind":"video","in":start,"out":end,"tight":True}
             for ref,start,end in [(source_ref,0,.25),(edit_ref,0,4),(source_ref,4.25,5)]]}
        output=await asyncio.to_thread(film.render,server.COMFY_DIR,specification)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,output["ref"]))) as rendered:
            decoded=list(rendered.decode(video=0))
        self.assertEqual(len(decoded),120)
        self.assertGreater(decoded[4].to_ndarray(format="rgb24")[0,0,0],220)
        self.assertGreater(decoded[6].to_ndarray(format="rgb24")[0,0,2],220)
        self.assertGreater(decoded[102].to_ndarray(format="rgb24")[0,0,1],100)
