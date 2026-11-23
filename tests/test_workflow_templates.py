"""Workflow templates preserve editable data and enforce publication boundaries."""
import json
import wave
from urllib.parse import quote

import db
import server
from test_agent_chat import ChatFixture, answer, call


class WorkflowTemplates(ChatFixture):
    async def test_assistant_search_returns_only_readable_workflow_summaries(self):
        api = "/api/canvas-templates"
        private = await (await self.client.post(api,json={"board":"test","name":"雨夜短片内部模板"})).json()
        public = await (await self.client.post(api,json={"board":"test","name":"雨夜短片共享模板"})).json()
        self.assertEqual((await self.client.put(f"{api}/{public['id']}/publication",json={"confirmed":True})).status,200)
        guest = {"X-Uid":"8"}
        self.assertEqual((await self.client.put(f"{api}/{public['id']}/favorite",headers=guest)).status,200)
        board = server.board_path("guest-search")
        server.write_board(board,{"owner":8,"name":"素材画布","rev":1,"nodes":[],"edges":[]})
        session = await self.client.post("/api/chat/sessions",headers=guest,json={"board":"guest-search"})
        self.assertEqual(session.status,200,await session.text())
        endpoint = f"/api/chat/sessions/{(await session.json())['id']}/messages"
        baseline = board.read_text()

        async def invoke(key, args, tool="workflow_template_search"):
            self.svc.model.side_effect = [call(tool,args),answer()]
            response = await self.client.post(endpoint,headers=guest,json={"text":"帮我找模板","request_key":key})
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            self.assertEqual((await self.wait(rid))["state"],"done")
            return json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])

        rows = (await invoke("search-shared-template",{"terms":["雨夜短片"]}))["workflow_templates"]
        self.assertEqual([(row["id"],row["scope"]) for row in rows],[(public["id"],"catalog")])
        self.assertNotIn(private["id"],str(rows))
        self.assertTrue(rows[0]["favorite"])
        self.assertNotIn("data",rows[0])
        starred = (await invoke("search-favorite-template",{"scope":"favorites"}))["workflow_templates"]
        self.assertEqual([(row["id"],row["scope"]) for row in starred],[(public["id"],"favorites")])
        presets = (await invoke("search-preset-template",{"scope":"presets","terms":["首尾帧"]}))["workflow_templates"]
        self.assertEqual([(row["id"],row["scope"]) for row in presets],[("starter-keyframes","presets")])
        denied = await invoke("read-private-inputs",{"template_id":private["id"]},"workflow_template_inputs")
        self.assertIn("不可用",denied["error"])
        inputs = await invoke("read-premade-inputs",{"template_id":"starter-storyboard","node_ids":["n1"]},"workflow_template_inputs")
        field, = inputs["template_inputs"]
        self.assertEqual((field["node"],field["field"]),("n1","text"))
        plan = await invoke("plan-starter-fill",{"template_id":"starter-storyboard","changes":[
            {"node":"n1","field":"text","value":"在车站等一班不会来的列车。"}]},"workflow_template_plan")
        draft = plan["template_fill_plan"]
        self.assertEqual((draft["board"],draft["scope"]),("guest-search","presets"))
        self.assertEqual((draft["inputs"][0]["before"],draft["inputs"][0]["value"]),(field["value"],"在车站等一班不会来的列车。"))
        invalid = await invoke("plan-starter-invalid",{"template_id":"starter-storyboard","changes":[
            {"node":"n1","field":"ref","value":"output:h3studio/fiction.png"}]},"workflow_template_plan")
        self.assertIn("填写项不存在",invalid["error"])
        self.assertEqual(board.read_text(),baseline)

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
                                "versions":[],"data":{"prompt":"平移镜头","duration":5,"pmode":"fields",
                                "fields":{"camera":"固定","scene":"湖边"}},"job":{"ids":["demo"],"agent_call":"old"}})
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
        prompt = {"node":"n3","field":"fields.camera","before":"固定","value":"缓慢推近"}
        self.assertEqual(preview["nodes"][1]["inputs"][prompt["field"]],prompt["before"])
        configured = await self.client.post(root+"/fragment",json={"inputs":[prompt]})
        self.assertEqual(configured.status,200,await configured.text())
        draft = await configured.json()
        self.assertEqual(draft["nodes"][1]["data"]["fields"],{"camera":"缓慢推近","scene":"湖边"})
        self.assertEqual((draft["edges"],draft["groups"]),(fragment["edges"],fragment["groups"]))
        for edit, expected in (({**prompt,"field":"fields.model"},400),({**prompt,"before":"旧内容"},409)):
            self.assertEqual((await self.client.post(root+"/fragment",json={"inputs":[edit]})).status,expected)
        project = await (await self.client.post("/api/canvas-projects",json={"name":"视频项目"})).json()
        options = {"project":project["id"],"request_key":"workflow-test","inputs":[prompt]}
        made = await self.client.post(root+"/open",json=options)
        self.assertEqual(made.status,201,await made.text())
        bid = (await made.json())["id"]
        self.assertEqual((await (await self.client.post(root+"/open",json=options)).json())["id"],bid)
        self.assertEqual((await self.client.delete(root)).status,200)
        board = await (await self.client.get("/api/board/"+bid)).json()
        self.assertEqual((board["name"],board["shared"],board["owner"]),("复用镜头",False,7))
        self.assertEqual(board["nodes"][1]["data"]["fields"],{"camera":"缓慢推近","scene":"湖边"})
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
        favorites = "/api/canvas-templates/favorites"
        self.assertEqual((await self.client.put(root+"/favorite",headers=guest)).status,404)
        self.assertEqual(await (await self.client.get(catalog,headers=guest)).json(),[])
        for path in (preview,preview+"/media/0"):
            self.assertEqual((await self.client.get(path,headers=guest)).status,404)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":False})).status,400)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":True},headers=guest)).status,404)
        self.assertEqual((await self.client.put(root+"/publication",json={"confirmed":True},headers=owner)).status,200)
        rows = await (await self.client.get(catalog,headers=guest)).json()
        self.assertEqual([(r["id"],r["author"],r["owned"]) for r in rows],[(saved["id"],"test7",0)])
        for _ in range(2):
            self.assertEqual((await self.client.put(root+"/favorite",headers=guest)).status,200)
        self.assertEqual((await (await self.client.get(catalog,headers=guest)).json())[0]["favorite"],1)
        self.assertEqual(await (await self.client.get(favorites,headers=owner)).json(),[])
        self.assertEqual([row["id"] for row in await (await self.client.get(favorites,headers=guest)).json()],[saved["id"]])
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
        source = self.load()
        source["nodes"][1]["data"]["text"] = "新版简报"
        current = await self.client.put("/api/board/test",json=source)
        self.assertEqual(current.status,200,await current.text())
        update = {"name":"共享工作流","board":"test","revision":(await current.json())["rev"],
                  "template_updated":saved["updated"]}
        endpoint = root+"/content"
        for headers, payload, code in ((guest,update,404),(owner,update,400),
            (owner,{**update,"confirmed_shared":True,"template_updated":0},409),
            (owner,{**update,"confirmed_shared":True,"revision":0},409)):
            self.assertEqual((await self.client.put(endpoint,headers=headers,json=payload)).status,code)
        updated = await self.client.put(endpoint,headers=owner,json={**update,"confirmed_shared":True})
        self.assertEqual(updated.status,200,await updated.text())
        fresh = await (await self.client.get(preview,headers=guest)).json()
        self.assertEqual(fresh["nodes"][1]["text"],"新版简报")
        self.assertEqual([row["id"] for row in await (await self.client.get(favorites,headers=guest)).json()],[saved["id"]])
        history = root+"/history"
        archived, = await (await self.client.get(history,headers=owner)).json()
        revision = history+"/"+str(archived["id"])
        for path in (history,revision):
            self.assertEqual((await self.client.get(path,headers=guest)).status,404)
        snapshot = await (await self.client.get(revision,headers=owner)).json()
        self.assertEqual(snapshot["nodes"][1]["inputs"]["text"],"Hello")
        current_template, = await (await self.client.get("/api/canvas-templates",headers=owner)).json()
        restore = {"template_updated":current_template["updated"]}
        self.assertEqual((await self.client.post(revision+"/restore",headers=guest,json=restore)).status,404)
        self.assertEqual((await self.client.post(revision+"/restore",headers=owner,json=restore)).status,400)
        restored = await self.client.post(revision+"/restore",headers=owner,json={**restore,"confirmed_shared":True})
        self.assertEqual(restored.status,200,await restored.text())
        active = await (await self.client.get(preview,headers=guest)).json()
        self.assertEqual(active["nodes"][1]["text"],"Hello")
        newer, earlier = await (await self.client.get(history,headers=owner)).json()
        self.assertEqual(earlier["id"],archived["id"])
        superseded = await (await self.client.get(history+"/"+str(newer["id"]),headers=owner)).json()
        self.assertEqual(superseded["nodes"][1]["inputs"]["text"],"新版简报")
        self.assertEqual((await self.client.delete(root+"/publication",headers=owner)).status,200)
        self.assertEqual(await (await self.client.get(catalog,headers=guest)).json(),[])
        self.assertEqual(await (await self.client.get(favorites,headers=guest)).json(),[])
        self.assertEqual((await self.client.delete(root+"/favorite",headers=guest)).status,200)
        starter = "/api/canvas-templates/starter-storyboard/favorite"
        self.assertEqual((await self.client.put(starter,headers=guest)).status,200)
        rows = await (await self.client.get(favorites,headers=guest)).json()
        self.assertEqual([(r["id"],r["favorite"],r["builtin"]) for r in rows],[("starter-storyboard",True,True)])
        self.assertNotIn("data",rows[0])
        self.assertEqual((await self.client.get(preview+"/media/0",headers=guest)).status,404)
        self.assertEqual((await self.client.post(root+"/fragment",headers=guest,json={})).status,404)
        copy = await (await self.client.get("/api/board/"+bid,headers=guest)).json()
        self.assertEqual((copy["owner"],copy["shared"]),(8,False))
        self.assertEqual(copy["nodes"],fragment["nodes"])
        self.assertEqual((await self.client.delete("/api/board/"+bid,headers=guest)).status,200)
        self.assertEqual((await self.client.get(media_url,headers=guest)).status,200)
        self.assertEqual((await self.client.delete(root,headers=owner)).status,200)
        self.assertIsNone(db.one("SELECT 1 FROM canvas_template_history WHERE template_id=?",saved["id"]))

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
        starter = api+"/starter-storyboard"
        starter_preview = await (await self.client.get(starter+"/preview",headers=guest)).json()
        original = starter_preview["nodes"][0]["inputs"]["text"]
        changed = await self.client.post(starter+"/fragment",headers=guest,json={"inputs":[
            {"node":"n1","field":"text","before":original,"value":"雨后车站里的故事"}]})
        self.assertEqual(changed.status,200,await changed.text())
        self.assertEqual((await changed.json())["nodes"][0]["data"]["text"],"雨后车站里的故事")
        untouched = await (await self.client.post(starter+"/fragment",headers=guest)).json()
        self.assertEqual(untouched["nodes"][0]["data"]["text"],original)
