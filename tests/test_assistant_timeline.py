"""Assistant timeline titles, cutaways, and playlists."""

from unittest.mock import patch
import json

from PIL import Image
import av

from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class AssistantTimeline(ChatFixture):
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
