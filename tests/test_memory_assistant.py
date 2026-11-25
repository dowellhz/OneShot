"""Retrieve, archive, and apply creative memory from conversations."""

from unittest.mock import AsyncMock, patch
import json

from PIL import Image
from aiohttp import web

from oneshot.editing import image_editor
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import call, answer
from memory_fixture import MemoryFixture


class MemoryAssistant(MemoryFixture):
    async def test_conversation_archive_can_be_searched_updated_and_explicitly_used(self):
        route = f"/api/chat/sessions/{self.sid}/memory"
        self.assertEqual((await self.client.post(route,json={})).status,400)
        for kind,text in (("user","蓝钟镇没有电灯"),("assistant","夜间改用纸灯"),("tool_end","内部执行记录")):
            self.svc.emit(self.sid,None,kind,{"text":text})
        denied = await self.client.post(route,json={},headers={"X-Uid":"8"})
        self.assertEqual(denied.status,404,await denied.text())
        created = await self.client.post(route,json={})
        self.assertEqual(created.status,200,await created.text())
        first = await created.json()
        self.assertEqual(first["messages"],2)
        self.svc.emit(self.sid,None,"user",{"text":"纸灯只挂在河边"})
        second = await (await self.client.post(route,json={})).json()
        self.assertEqual(second["id"],first["id"])
        self.assertEqual(second["messages"],3)
        self.assertEqual(await (await self.client.post(route,json={})).json(),second)
        asset_route = "/api/memory/"+second["id"]
        detail = await (await self.client.get(asset_route)).json()
        self.assertEqual(detail["document"]["format"],"plain")
        self.assertEqual(detail["document"]["text"],"用户\n蓝钟镇没有电灯\n\n助手\n夜间改用纸灯\n\n用户\n纸灯只挂在河边")
        self.assertTrue(detail["story_draft"])
        self.assertEqual((await self.client.get(asset_route,headers={"X-Uid":"8"})).status,404)
        self.assertEqual((await self.client.post("/api/memory",json={"id":second["id"],"shared":True})).status,400)
        listed = await (await self.client.get("/api/memory",params={"board":"test","scope":"current","q":"纸灯"})).json()
        self.assertEqual([item["id"] for item in listed],[second["id"]])
        store = self.app["creative_memory"]
        user = {"id":7,"role":"member"}
        self.assertEqual(store.storyboard_assets(user,"test","纸灯"),[])
        found, method = await store.search(self.app["llm"],user,"test","纸灯",mode="keyword")
        self.assertEqual(method,"keyword")
        self.assertEqual([item["id"] for item in found],[second["id"]])
        self.assertEqual(store.summary(found[0])["source_type"],"conversation")
        prepared = store.prepare(user,{"kind":"video","board":"test","prompt":"写纸灯","memory_ids":[second["id"]]})
        self.assertIn("纸灯只挂在河边",prepared["prompt"])

    async def test_mention_suggestions_search_beyond_recent_assets_and_bind_the_chosen_identity(self):
        personal = await self.create(board="",name="林森",aliases=["林导"],tags=["主角"])
        current = await self.create(name="林森",character_view="main")
        await self.client.put("/api/board/another",json={"nodes":[]})
        await self.create(board="another",name="其他画布的主角",tags=["主角"])
        db.run("""WITH RECURSIVE numbers(n) AS (
                    VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<305)
                  INSERT INTO creative_memories(id,owner,kind,name,data,updated)
                  SELECT 'recent-'||n,7,'document','近期素材 '||n,'{}',?+n FROM numbers""",current["mtime"])

        async def suggestions(query, **filters):
            response = await self.client.get("/api/memory/mentions",params={"board":"test","q":query,**filters})
            self.assertEqual(response.status,200,await response.text())
            return await response.json()

        recent = await (await self.client.get("/api/memory?board=test")).json()
        self.assertNotIn(personal["id"], [item["id"] for item in recent])
        found = await suggestions("林")
        self.assertEqual([item["id"] for item in found],[current["id"],personal["id"]])
        self.assertTrue(all(item["reference_ambiguous"] for item in found))
        self.assertEqual([item["id"] for item in await suggestions("林导")],[personal["id"]])
        self.assertEqual([item["id"] for item in await suggestions("主角")],[personal["id"]])
        self.assertEqual([item["id"] for item in await suggestions("林",view="主图")],[current["id"]])
        self.assertEqual(await suggestions("林",view="背面"),[])
        self.assertTrue(all(item["kind"]=="character" for item in found))
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        selected = store.mentions(user,"test","@{"+personal["id"]+"|林森} 出场")
        self.assertEqual([item["id"] for item in selected],[personal["id"]])

    async def test_assistant_semantic_search_only_uses_accessible_candidates_in_scope(self):
        st = self.app["creative_memory"]
        user = {"id":7,"role":"member"}
        clue = await self.create(name="回程钥匙",kind="prop",desc="小巧的铜制开锁物，属于故事主角。")
        await self.create(name="普通盘子",kind="prop",desc="白色餐具")
        await self.create(name="个人挂件",kind="prop",board="")
        await self.client.put("/api/board/other-library",json={"nodes":[]})
        st.put(user,{"name":"另一画布的门卡","kind":"prop","board":"other-library"})
        query = "把能开启房门的随身器物放在长凳上"
        self.assertNotIn(clue["id"],[a["id"] for a in st.list(user,"test",query)])

        async def shortlist(_, raw, **kwargs):
            request = json.loads(raw)
            self.assertEqual(request["query"],query)
            candidates = request["candidates"]
            self.assertEqual({a["name"] for a in candidates},{"回程钥匙","普通盘子"})
            self.assertNotIn(clue["ref"],raw)
            number = next(a["number"] for a in candidates if a["name"]=="回程钥匙")
            return json.dumps({"matches":[number,number]})

        self.svc.model.side_effect = [call("memory_search",{"query":query,"kind":"prop"}),answer()]
        llm = self.app["llm"]
        llm.available = lambda:True
        llm.chat = AsyncMock(side_effect=shortlist)
        rid = await self.send(query)
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertEqual(result["search_method"],"semantic")
        self.assertEqual([a["id"] for a in result["memories"]],[clue["id"]])
        self.assertEqual(llm.chat.await_count,1)

        assets, method = await st.search(llm,user,"test","回程钥匙")
        self.assertEqual(([a["id"] for a in assets],method),([clue["id"]],"exact"))
        self.assertEqual(llm.chat.await_count,1)
        personal, method = await st.search(llm,user,"test","个人挂件",scope="available")
        self.assertEqual(([a["name"] for a in personal],method),(["个人挂件"],"exact"))
        query_payload = {"board":"test","query":"个人挂件","scope":"personal","kind":"prop"}
        response = await self.client.post("/api/memory/search",json=query_payload)
        self.assertEqual(response.status,200,await response.text())
        match = await response.json()
        self.assertEqual(match["method"],"exact")
        self.assertEqual([entry["name"] for entry in match["items"]],["个人挂件"])
        self.assertIn("folder_id",match["items"][0])
        hidden = await self.client.post("/api/memory/search",json=query_payload,headers={"X-Uid":"8"})
        self.assertEqual(hidden.status,403,await hidden.text())
        llm.chat = AsyncMock(return_value='{"matches":[999]}')
        assets, method = await st.search(llm,user,"test","回程钥匙",mode="semantic")
        self.assertEqual(([a["id"] for a in assets],method),([clue["id"]],"keyword"))

    async def test_agent_retrieves_and_adopts_implicit_memory(self):
        a=await self.create(tags=['森林','主角'], character_view='main')
        face=image_editor.save(server.COMFY_DIR,Image.new('RGB',(48,64),'blue'))
        board=self.load()
        board["nodes"][0]["versions"].append({"ref":face["ref"]})
        server.write_board(server.board_path("test"),board)
        saved=await self.client.post("/api/memory",json={"id":a["id"],"ref":face["ref"],
            "character_view":"face","source_board":"test"})
        self.assertEqual(saved.status,200,await saved.text())
        output=image_editor.save(server.COMFY_DIR,Image.new('RGB',(64,48),'green'));seen=[]
        async def submit(req,p):
            seen.append(p);server.JOBS['e000000000001']={'id':'e000000000001','state':'done','created':1,'meta':{'uid':7},'outputs':[{'ref':output['ref'],'meta':{'width':64,'height':48}}]}
            return web.json_response({'ids':['e000000000001']})
        self.svc.model.side_effect=[call('memory_search',{'query':'森林主角'}),
            call('memory_use',{'memory_ids':[a['id']]},'use'),
            call('image_generate',{'prompt':'主角穿过森林，头肩近景',
                'memory_views':[{'memory_id':a['id'],'views':['face']}]},'gen'),answer()]
        with patch.object(generation_requests,'_generate_request',submit):
            rid=await self.send(text='让主角穿过森林');row=await self.wait(rid)
        self.assertEqual(row['state'],'done',row.get('error'))
        self.assertEqual([image['ref'] for image in seen[0]['images']],[face['ref']])
        self.assertEqual(len(self.load()['nodes']),3)
        version=self.load()['nodes'][-1]['versions'][0]
        self.assertEqual(version['memory_used'][0]['id'],a['id'])
        self.assertEqual(version['memory_used'][0]['references'],[{'view':'face','ref':face['ref']}])
        self.assertEqual(version['generation_record']['inputs'][0]['memory_view'],'face')
        explicit = "@{"+a["id"]+"#face|林森}"
        self.svc.model.side_effect = [
            call("image_generate",{"prompt":"面部近景","memory_views":[{"memory_id":a["id"],"views":["main"]}]}),
            answer(),
        ]
        with patch.object(generation_requests,"_generate_request",submit):
            rid = await self.send(text=f"用 {explicit} 生成一张图片", key="explicit-angle")
            self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertEqual([item["ref"] for item in seen[-1]["images"]],[face["ref"]])

    async def test_agent_save_is_idempotent_and_saves_text(self):
        self.svc.model.side_effect=[call('memory_save',{'name':'项目背景','kind':'document','description':'时间是2040年'}),answer()]
        rid=await self.send('记住这个项目背景');self.assertEqual((await self.wait(rid))['state'],'done')
        row=db.one('SELECT * FROM chat_calls WHERE run_id=?',rid);run=db.one('SELECT * FROM chat_runs WHERE id=?',rid);run['data']=json.loads(run['data'])
        await self.svc.execute(run,{'id':7,'role':'member'},row['id'],'memory_save',json.loads(row['args']))
        memories=await (await self.client.get('/api/memory?board=test')).json();self.assertEqual(len(memories),1);self.assertEqual(memories[0]['desc'],'时间是2040年')
        self.assertEqual(memories[0].get("board"),"test")
        self.assertFalse(memories[0].get("project"))
        sibling=await self.client.put("/api/board/another-workspace",json={"name":"另一张画布","nodes":[]})
        self.assertEqual(sibling.status,200)
        visible=await (await self.client.get("/api/memory?board=another-workspace")).json()
        self.assertEqual(visible,[])

    async def test_scene_memory_uses_environment_semantics(self):
        await self.create(name='老书店',kind='scene',desc='木质书架和暖色灯光')
        p=self.app['creative_memory'].prepare({'id':7,'role':'member'},{'kind':'video','board':'test','prompt':'@老书店 的晨光','duration':5})
        body,meta=server.engine_body(p)
        self.assertEqual(body['references'],[str(server.tools.ref_path(server.COMFY_DIR,self.source['ref']))])
        self.assertEqual(body['keyframes'],[]);self.assertIn('is the environment',body['prompt']);self.assertNotIn('face, body shape',body['prompt'])
        self.assertEqual((meta["mode"],meta["provider"],meta["model"],meta["resolution"]),("planned","本地 H3","h3-video","768P"))
