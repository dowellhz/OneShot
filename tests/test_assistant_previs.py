"""Assistant planning, generation, and editing with pinned previsualizations."""

from unittest.mock import patch
import asyncio
import json

from PIL import Image
from aiohttp import web
import av

from oneshot.editing import previs
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call
from previs_fixture import motion_scene


class AssistantPrevis(ChatFixture):
    async def test_assistant_generates_in_place_from_fixed_whitebox_and_checks_approval(self):
        box = server.image_editor.save(server.COMFY_DIR,Image.new("RGB",(90,160),"gray"),"input")
        older = server.image_editor.save(server.COMFY_DIR,Image.new("RGB",(90,160),"yellow"))
        final = server.image_editor.save(server.COMFY_DIR,Image.new("RGB",(144,256),"blue"))
        board = self.load()
        board["nodes"][0]["versions"].append(older)
        board["nodes"][0]["cur"] = 1
        board["nodes"].extend([
            {"id":"picture","type":"image","name":"镜1 · 分镜图","data":{"previs_composition":{"ref":box["ref"]},
             "provider":"fixture-image","quality":"16mp"},
             "versions":[{**box,"source":"previs-frame"},older],"cur":1},
            {"id":"video","type":"video","name":"镜1","data":{},"versions":[],"cur":-1}])
        board["edges"].extend([{"from":"n1","to":"picture","ref":self.source["ref"],"prompt_slot":3},
                               {"from":"picture","to":"video","role":"first"}])
        path = server.board_path("test")
        server.write_board(path,board)
        context = self.svc.context({"id":7,"role":"member"},"test",{"selected":["picture"]})
        self.assertEqual(context["nodes"][0]["previs_composition"],box["ref"])
        received = []
        async def submit(req,payload):
            received.append(payload)
            jid = "e000000000061"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[
                {"ref":final["ref"],"meta":{"width":144,"height":256}}]}
            return web.json_response({"ids":[jid]})
        args = {"node_id":"picture","prompt":"让 @图{3} 的角色出现在夜景里"}
        self.svc.model.side_effect = [call("image_previs_frame",args),answer()]
        with patch.object(generation_requests,"generate_request",submit):
            rid = await self.send("用固定白模构图生成这一镜的首帧",selected=["picture"])
            self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        request, = received
        self.assertEqual((request["kind"],request["ar"]),("image",9/16))
        self.assertEqual((request["provider"],request["quality"]),("fixture-image","16mp"))
        self.assertEqual([im["ref"] for im in request["images"]],[self.source["ref"],box["ref"]])
        self.assertIn("@图1 的角色",request["prompt"])
        self.assertIn("按 @图2 的机位",request["prompt"])
        after = self.load()
        self.assertEqual(after["edges"],board["edges"])
        picture, video = after["nodes"][-2:]
        self.assertEqual([v["ref"] for v in picture["versions"]],[box["ref"],older["ref"],final["ref"]])
        self.assertEqual(picture["cur"],2)
        self.assertEqual(picture["versions"][2]["generation_record"]["inputs"][-1]["version"],1)
        self.assertEqual(video["versions"],[])

        self.svc.model.side_effect = [call("image_previs_frame",args),answer()]
        with patch.object(generation_requests,"generate_request",submit):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json={
                "text":"先确认，再生成首帧","request_key":"previs-approval","generation_mode":"manual","selected":["picture"]})
            self.assertEqual(response.status,200)
            rid = (await response.json())["id"]
            async with asyncio.timeout(8):
                while not (approval := db.one("""SELECT a.id FROM chat_approvals a JOIN chat_calls c ON c.id=a.call_id
                                                  WHERE c.run_id=?""",rid)):
                    await asyncio.sleep(.02)
            picture["data"]["previs_composition"]["enabled"] = False
            server.write_board(path,after)
            approval_url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(approval_url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertIn("白模构图已变更",result["error"])
        self.assertEqual(len(received),1)
        self.assertEqual(len(self.load()["nodes"][-2]["versions"]),3)

    async def test_assistant_plans_storyboard_without_generating_and_reads_actual_frame(self):
        scene = motion_scene()
        pose = scene["camera"][0]
        scene["camera"] = [{**pose,"ease":"cut"}, {**pose,"t":31,"ease":"cut"},
                           scene["camera"][1], {**pose,"t":96,"ease":"cut"}]
        preview = {"id":"n3","type":"video","name":"开门预演","data":{"previs":scene},"versions":[],"cur":-1}
        frame = {"ref":self.source["ref"],"source":"previs-frame","w":60,"h":32}
        replacement = {**frame,"ref":"input:h3studio/final.png","source":"gen"}
        script = {"id":"story","type":"script","name":"开门预演 · 分镜","data":{"previs_source":"n3",
                  "shots":[{"id":"shot1","duration":31/24,"previs_range":[0,31],"frame":frame}],
                  "made":[{"shot_id":"shot1","img":"picture","vid":"clip"}]},"versions":[],"cur":-1}
        board = self.load()
        board["nodes"].extend([preview,script,
            {"id":"picture","type":"image","name":"分镜图","data":{},"versions":[frame,replacement],"cur":1},
            {"id":"clip","type":"video","name":"镜1","data":{"duration":5},"versions":[],"cur":-1}])
        board["edges"].append({"from":"picture","to":"clip","role":"first","ref":frame["ref"]})
        path = server.board_path("test")
        server.write_board(path,board)
        baseline = path.read_text()
        plan_call = call("video_previs_storyboard_plan",{"node_id":"n3"},"previs-storyboard")
        blocked = call("canvas_create_text",{"text":"等待确认"},"premature-write")
        self.svc.model.side_effect = [{**plan_call,"tool_calls":plan_call["tool_calls"] + blocked["tool_calls"]},
                                       call("storyboard_context",{"node_id":"story"},"read-import"),answer()]
        rid = await self.send("按白模切点导入分镜",selected=["n3"])
        self.assertEqual((await self.wait(rid,timeout=8))["state"],"done")
        results = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)]
        self.assertEqual(results[0]["previs_storyboard_plan"],{"board":"test","node":"n3","name":"开门预演",
                                                              "aspect":"16:9","fps":24,"boundaries":[0,31,96]})
        self.assertIn("核对并创建分镜",results[1]["error"])
        shot = results[2]["storyboard"]["shots"][0]
        self.assertEqual(shot["previs"],{"source_node":"n3","start":0,"end":31/24,"video_duration":5,
                                         "first_frame":{"ref":frame["ref"],"source":"previs-frame"}})
        board["edges"][-1].pop("ref")
        unfixed = self.svc.storyboard_context(board,script)["shots"][0]
        self.assertEqual(unfixed["previs"]["first_frame"],{"ref":replacement["ref"],"source":"gen"})
        board["edges"].append({"from":"n3","to":"clip","relation":"previs"})
        referenced = self.svc.storyboard_context(board,script)["shots"][0]
        self.assertIsNone(referenced["previs"]["first_frame"])
        self.assertEqual(path.read_text(),baseline)

    async def test_assistant_follows_actor_with_revision_protection(self):
        scene = previs.validate(motion_scene())
        node = {"id":"n3","type":"video","name":"白模走位","x":10,"y":20,"data":{"previs":scene},"versions":[],"cur":-1}
        self.board["nodes"].append(node)
        server.write_board(server.board_path("test"),self.board)
        args = {"node_id":"n3","mode":"follow","target":"walker","start":0,"end":4}
        self.svc.model.side_effect = [
            call("video_previs_camera_motion",{**args,"scene_revision":"0"*64},"stale-camera"),
            call("video_previs_camera_motion",{**args,"scene_revision":server.agent_chat.agent_video.scene_revision(scene)},"follow-camera"),
            call("video_previs_render",{"node_id":"n3"},"render-motion"),
            answer(),
        ]
        rid = await self.send("整段跟拍人物",selected=["n3"])
        self.assertEqual((await self.wait(rid,timeout=18))["state"],"done")
        calls = db.q("SELECT state,result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)
        self.assertIn("重新读取",json.loads(calls[0]["result"])["error"])
        self.assertEqual(json.loads(calls[1]["result"])["previs_node"],"n3")
        saved = self.load()["nodes"][-1]
        track = saved["data"]["previs"]["camera"]
        self.assertEqual([[key[field] for field in ("t","x","z","tx","ty","tz")] for key in track],
                         [[0,0,6,0,1.2,0],[48,2,7,2,1.2,1],[96,4,8,4,1.2,2]])
        self.assertEqual(track[1]["ease"],"smooth")
        self.assertEqual(saved["data"]["previs"]["objects"],scene["objects"])
        version, = saved["versions"]
        self.assertEqual(version["previs_recipe"]["camera"],track)
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,version["ref"]))) as video:
            self.assertEqual((video.streams.video[0].frames,len(video.streams.audio)),(96,0))

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

        imported = {"id":"prop","label":"导入道具","shape":"mesh","width":1,"height":1,"depth":1,
                    "triangles":[[-.5,0,0,.5,0,0,0,1,0]],"keys":[{"t":0,"x":0,"y":0,"z":1,"yaw":0}]}
        guide_node["data"]["previs"]["objects"].append(imported)
        server.write_board(server.board_path("test"), board)

        async def edit(messages, _):
            recent = messages[max(i for i, m in enumerate(messages) if m["role"] == "user"):]
            results = {m["tool_call_id"]:json.loads(m["content"]) for m in recent if m["role"] == "tool"}
            if "stale" not in results:
                return call("video_previs_save", {"node_id":nid,"scene_revision":"stale","scene":scene}, "stale")
            if "inspect" not in results:
                return call("video_previs_get", {"node_id":nid}, "inspect")
            if "edit" not in results:
                editable = results["inspect"]["scene"]
                self.assertNotIn("triangles", editable["objects"][1])
                editable["camera"][0]["y"] = 3
                return call("video_previs_save", {"node_id":nid,"scene_revision":results["inspect"]["scene_revision"],"scene":editable}, "edit")
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
        self.assertEqual(guide_node["versions"][1]["previs_recipe"]["objects"][1]["triangles"], imported["triangles"])

        route = {"provider":{"id":"ark-assistant", "name":"方舟", "enabled":True, "kind":"ark",
                             "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"fixture"}},
                 "model":"ep-configured"}
        submitted = []

        async def provider(_http, root, _provider, model, kind, request, *, on_submitted=None):
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
