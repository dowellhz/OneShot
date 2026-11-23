"""Workflow templates preserve editable data and enforce publication boundaries."""
import wave
from urllib.parse import quote

import db
import server
from test_agent_chat import ChatFixture


class WorkflowTemplates(ChatFixture):
    async def test_selection_can_keep_pinned_upstream_versions(self):
        source = self.load()

        def audio(ref_name):
            path, ref = server.film._new(server.COMFY_DIR,"output",ref_name,".wav")
            with wave.open(str(path),"wb") as wav:
                wav.setparams((1,2,8000,0,"NONE",""))
                wav.writeframes(b"\0\0" * 16000)
            return {"ref":ref}

        first, old, current, result = [audio(name) for name in ("first","old","current","result")]
        server.grant_media({"id":7}, *(item["ref"] for item in (first,old,current,result)))
        refs = [{"node_id":ident,"ref":version["ref"],"kind":"audio"}
                for ident, version in (("sound-a",first),("sound-b",old))]
        recipe = {"mode":"seed_audio","prompt":"采用 @音频2","references":refs}
        source["nodes"].extend([
            {"id":"sound-a","type":"audio","name":"音频 A","data":{},"versions":[first],"cur":0},
            {"id":"sound-b","type":"audio","name":"音频 B","data":{},"versions":[old,current],"cur":1},
            {"id":"result","type":"audio","name":"结果","data":recipe,"versions":[
                {**result,"audio_recipe":recipe,"input_edges":[{"from":"n1","to":"result","ref":self.source["ref"]}]}
            ],"cur":0},
        ])
        saved_board = await self.client.put("/api/board/test",json=source)
        self.assertEqual(saved_board.status,200,await saved_board.text())
        api = "/api/canvas-templates"
        selection = {"board":"test","name":"声音模板","selected":["sound-b","result"]}
        for include, ids, expected_refs, prompt in (
            (False,["sound-b","result"],refs[1:],"采用 @音频1"),
            (True,["n1","sound-a","sound-b","result"],refs,"采用 @音频2"),
        ):
            response = await self.client.post(api,json={**selection,"include_upstream":include})
            self.assertEqual(response.status,201,await response.text())
            root = api+"/"+(await response.json())["id"]
            preview = await (await self.client.get(root+"/preview")).json()
            self.assertNotIn("media",preview)
            self.assertNotIn(old["ref"],str(preview))
            pinned = next(edge for edge in preview["edges"] if edge["from"]=="sound-b")
            self.assertEqual((pinned["version"],pinned["slot"]),(1,len(expected_refs)))
            current_media = next(node["media"] for node in preview["nodes"] if node["id"]=="sound-b")
            self.assertNotEqual(pinned["media"],current_media)
            media_url = root+"/preview/media/"+str(pinned["media"])
            historical = await self.client.get(media_url)
            self.assertEqual(historical.status,200)
            self.assertEqual(await historical.read(),server.tools.ref_path(server.COMFY_DIR,old["ref"]).read_bytes())
            self.assertEqual((await self.client.get(media_url,headers={"X-Uid":"8"})).status,404)
            opened = await self.client.post(root+"/open",json={"request_key":"seed-upstream-test"})
            bid = (await opened.json())["id"]
            board = await (await self.client.get("/api/board/"+bid)).json()
            self.assertEqual([node["id"] for node in board["nodes"]],ids)
            self.assertEqual(board["nodes"][-2]["cur"],1)
            draft = board["nodes"][-1]
            for saved in (draft["data"],draft["versions"][0]["audio_recipe"]):
                self.assertEqual((saved["references"],saved["prompt"]),(expected_refs,prompt))
            self.assertEqual([edge["ref"] for edge in board["edges"]], [item["ref"] for item in expected_refs])
            self.assertEqual([edge["slot"] for edge in board["edges"]],list(range(1,len(expected_refs)+1)))
            self.assertEqual(bool(draft["versions"][0]["input_edges"]),include)

    async def test_template_capture_group_and_create_private_board(self):
        source = self.load()
        source.update(shared=True, seq=4, agent_ops=[{"id":"old"}])
        source["nodes"].append({"id":"n3","type":"video","name":"镜头","x":630,"y":40,"cur":-1,
                                "versions":[],"data":{"prompt":"平移镜头","duration":5},"job":{"ids":["demo"],"agent_call":"old"}})
        source["edges"] = [{"from":"n1","to":"n3","role":"first"},{"from":"n2","to":"n3"}]
        source["groups"] = [{"id":"g1","name":"镜头组","nodes":["n1","n3"]}]
        response = await self.client.put("/api/board/test",json=source)
        self.assertEqual(response.status, 200, await response.text())
        revision = (await response.json())["rev"]
        request = {"name":"镜头工作流","board":"test","selected":["n1","n3"],"revision":revision,
                   "description":"从首帧生成镜头"}
        self.assertEqual((await self.client.post("/api/canvas-templates",json={**request,"revision":1})).status,409)
        self.assertEqual((await self.client.post("/api/canvas-templates",json={**request,"selected":["missing"]})).status,400)
        guest = {"X-Uid":"8"}
        self.assertEqual((await self.client.post("/api/canvas-templates",headers=guest,json=request)).status,403)
        result = await self.client.post("/api/canvas-templates",json=request)
        self.assertEqual(result.status,201,await result.text())
        saved = await result.json()
        self.assertEqual(saved["nodes"],2)
        root = "/api/canvas-templates/"+saved["id"]
        self.assertEqual(await (await self.client.get("/api/canvas-templates",headers=guest)).json(),[])
        self.assertEqual((await self.client.post(root+"/fragment",headers=guest,json={})).status,404)
        self.assertEqual((await self.client.delete("/api/board/test")).status,200)

        fragment = await (await self.client.post(root+"/fragment",json={})).json()
        self.assertEqual([n["id"] for n in fragment["nodes"]],["n1","n3"])
        self.assertEqual(fragment["edges"],[{"from":"n1","to":"n3","role":"first"}])
        self.assertEqual(fragment["groups"][0]["nodes"],["n1","n3"])
        self.assertEqual(fragment["nodes"][1]["data"]["prompt"],"平移镜头")
        self.assertIsNone(fragment["nodes"][1]["job"])
        self.assertEqual(fragment["nodes"][0]["versions"][0]["ref"],self.source["ref"])
        self.assertEqual((await self.client.patch(root,json={"name":"复用镜头"})).status,200)
        preview = await (await self.client.get(root+"/preview")).json()
        self.assertEqual(preview["description"],"从首帧生成镜头")
        project = await (await self.client.post("/api/canvas-projects",json={"name":"视频项目"})).json()
        options = {"project":project["id"],"request_key":"workflow-test"}
        made = await self.client.post(root+"/open",json=options)
        self.assertEqual(made.status,201,await made.text())
        bid = (await made.json())["id"]
        self.assertEqual((await (await self.client.post(root+"/open",json=options)).json())["id"],bid)
        self.assertEqual((await self.client.delete(root)).status,200)
        board = await (await self.client.get("/api/board/"+bid)).json()
        self.assertEqual((board["name"],board["shared"],board["owner"]),("复用镜头",False,7))
        self.assertNotIn("agent_ops",board)
        self.assertNotIn("template_description",board)
        directory = await (await self.client.get("/api/boards")).json()
        self.assertEqual(next(b for b in directory if b["id"]==bid)["project"],project["id"])

    async def test_shared_catalog_preview_and_revoke_preserve_copies(self):
        owner, guest = {"X-Uid":"7"}, {"X-Uid":"8"}
        ref = self.source["ref"]
        db.run("INSERT INTO memory_uploads VALUES(?,?,?)", ref, 7, 0)
        media_url = "/media?ref=" + quote(ref, safe="")
        self.assertEqual((await self.client.get(media_url,headers=guest)).status,404)
        saved = await (await self.client.post("/api/canvas-templates",json={"name":"共享工作流","board":"test"})).json()
        catalog = "/api/canvas-templates/catalog"
        root = "/api/canvas-templates/" + saved["id"]
        preview = root + "/preview"
        self.assertEqual(await (await self.client.get(catalog,headers=guest)).json(),[])
        for path in (preview,preview+"/media/0"):
            self.assertEqual((await self.client.get(path,headers=guest)).status,404)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":False})).status,400)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":True},headers=guest)).status,404)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":True},headers=owner)).status,200)
        rows = await (await self.client.get(catalog,headers=guest)).json()
        self.assertEqual([(r["id"],r["author"],r["owned"]) for r in rows],[(saved["id"],"test7",0)])
        self.assertEqual(await (await self.client.get("/api/canvas-templates",headers=guest)).json(),[])
        shown = await (await self.client.get(preview,headers=guest)).json()
        self.assertNotIn("media",shown)
        self.assertEqual(shown["nodes"][0]["media"],0)
        self.assertEqual(shown["nodes"][1]["text"],"Hello")
        content = await self.client.get(preview+"/media/0",headers=guest)
        self.assertEqual(content.status,200,await content.text() if content.status != 200 else "")
        self.assertTrue(content.content_type.startswith("image/"))
        self.assertEqual((await self.client.get(media_url,headers=guest)).status,404)
        self.assertEqual((await self.client.delete(root+"/publication",headers=guest)).status,404)
        self.assertEqual((await self.client.patch(root,headers=guest,json={"name":"不允许"})).status,404)

        opened = await self.client.post(root+"/open",headers=guest,json={"request_key":"catalog-copy"})
        self.assertEqual(opened.status,201,await opened.text())
        bid = (await opened.json())["id"]
        fragment = await (await self.client.post(root+"/fragment",headers=guest,json={})).json()
        self.assertEqual(fragment["nodes"][0]["versions"][0]["ref"],ref)
        self.assertEqual((await self.client.delete(root+"/publication",headers=owner)).status,200)
        self.assertEqual(await (await self.client.get(catalog,headers=guest)).json(),[])
        self.assertEqual((await self.client.get(preview+"/media/0",headers=guest)).status,404)
        self.assertEqual((await self.client.post(root+"/fragment",headers=guest,json={})).status,404)
        copy = await (await self.client.get("/api/board/"+bid,headers=guest)).json()
        self.assertEqual((copy["owner"],copy["shared"]),(8,False))
        self.assertEqual(copy["nodes"],fragment["nodes"])
        self.assertEqual((await self.client.delete("/api/board/"+bid,headers=guest)).status,200)
        self.assertEqual((await self.client.get(media_url,headers=guest)).status,200)

    async def test_builtin_workflows_preview_and_create_editable_group(self):
        api = "/api/canvas-templates"
        guest = {"X-Uid":"8"}
        rows = await (await self.client.get(api+"/presets",headers=guest)).json()
        self.assertEqual({row["category"] for row in rows},{"分镜","商品","视频","角色"})
        for row in rows:
            self.assertTrue(row["builtin"])
            self.assertTrue(row["description"])
            self.assertNotIn("data",row)
            root = api+"/"+row["id"]
            preview = await (await self.client.get(root+"/preview",headers=guest)).json()
            fragment = await (await self.client.post(root+"/fragment",headers=guest,json={})).json()
            self.assertEqual(preview["description"],row["description"])
            ids = [n["id"] for n in fragment["nodes"]]
            self.assertEqual(len(ids),row["nodes"])
            self.assertEqual(fragment["groups"][0]["nodes"],ids)
            self.assertEqual(preview["edges"],fragment["edges"])
            self.assertTrue(all(n["job"] is None and not n["versions"] for n in fragment["nodes"]))
            self.assertEqual((await self.client.patch(root,json={"name":"编辑内置模板"},headers=guest)).status,404)
            self.assertEqual((await self.client.delete(root,headers=guest)).status,404)

        root = api+"/starter-keyframes"
        created = await self.client.post(root+"/open",headers=guest,json={"request_key":"builtin-keyframes"})
        self.assertEqual(created.status,201,await created.text())
        bid = (await created.json())["id"]
        reply = await self.client.get("/api/board/"+bid,headers=guest)
        board = await reply.json()
        self.assertEqual((board["owner"],board["shared"],board["access"]),(8,False,"owner"))
        self.assertEqual([edge["role"] for edge in board["edges"] if edge["to"]=="n3"],["first","last"])
        board["nodes"][0]["name"] = "我的首帧"
        self.assertEqual((await self.client.put("/api/board/"+bid,headers=guest,json=board)).status,200)
        preview = await (await self.client.get(root+"/preview",headers=guest)).json()
        self.assertEqual(preview["nodes"][0]["name"],"起始画面")
