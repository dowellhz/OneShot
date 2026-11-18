"""Remote HTTP roundtrips: memory ownership, actual generation refs and durable history."""
import io
import json
from unittest.mock import patch
from aiohttp import FormData, web
from PIL import Image
import image_editor
import db
import server
from test_agent_chat import ChatFixture, call, answer


class MemoryIntegration(ChatFixture):
    async def create(self, **kw):
        p = {"name": "林森", "kind": "character", "desc": "黑发、圆框眼镜，绿色外套", "board": "test", "ref": self.source["ref"], "source_board": "test", "node_id": "n1", **kw}
        r = await self.client.post('/api/memory', json=p)
        self.assertEqual(r.status, 200, await r.text())
        return await r.json()

    async def test_upload_and_generated_sources_preserve_default(self):
        raw = io.BytesIO(); Image.new('RGB', (48, 64), 'blue').save(raw, 'PNG')
        form = FormData(); form.add_field('file', raw.getvalue(), filename='person.png', content_type='image/png')
        r = await self.client.post('/api/upload', data=form)
        self.assertEqual(r.status, 200, await r.text()); upload = await r.json()
        a = await self.create(ref=upload['ref'], node_id=None, source_board='')
        self.assertEqual(a['media'][0]['source'], 'upload')
        p = {**a, 'ref': self.source['ref'], 'source_board': 'test', 'node_id': 'n1'}
        r = await self.client.post('/api/memory', json=p)
        b = await r.json(); self.assertEqual(r.status, 200, b)
        self.assertEqual(len(b['media']), 2)
        self.assertEqual(b['ref'], upload['ref'])
        r = await self.client.post('/api/memory', json={**b, 'default_ref': self.source['ref']})
        self.assertEqual((await r.json())['ref'], self.source['ref'])
        r = await self.client.post('/api/memory', json={**a, 'name': 'stale'})
        self.assertEqual(r.status, 409)

    async def test_scope_privacy_and_private_history(self):
        a = await self.create()
        self.assertEqual((await self.client.get('/api/memory/'+a['id'], headers={'X-Uid':'8'})).status, 404)
        self.assertEqual((await self.client.get('/api/memory?board=test', headers={'X-Uid':'8'})).status, 403)
        self.assertEqual((await self.client.post('/api/memory', headers={'X-Uid':'8'}, json={'name':'stolen','kind':'character','ref':self.source['ref']})).status, 403)
        r = await self.client.post('/api/memory', json={**a, 'board':'', 'shared':True}); public = await r.json()
        self.assertEqual(r.status, 200, public)
        self.assertEqual((await self.client.get('/api/memory/'+a['id'], headers={'X-Uid':'8'})).status, 200)
        r = await self.client.post('/api/memory', headers={'X-Uid':'8'}, json={**public,'name':'overwrite'})
        self.assertEqual(r.status, 403)
        self.assertEqual((await self.client.delete('/api/memory/'+a['id'], headers={'X-Uid':'8'})).status, 403)

    async def test_explicit_mention_reaches_generation_and_records_history(self):
        a = await self.create(aliases=['小林'], constraints='眼镜不能消失')
        output = image_editor.save(server.COMFY_DIR, Image.new('RGB',(64,48),'orange'))
        seen=[]
        async def submit(req,p):
            seen.append(p)
            server.JOBS['e000000000001']={'id':'e000000000001','state':'done','created':1,'meta':{'uid':7},'outputs':[{'ref':output['ref'],'meta':{'width':64,'height':48}}]}
            return web.json_response({'ids':['e000000000001']})
        with patch.object(server,'_generate_request',submit):
            r=await self.client.post('/api/generate',json={'kind':'image','board':'test','prompt':'@小林 在书店读书','images':[]})
            result=await r.json();self.assertEqual(r.status,200,result)
        self.assertEqual(seen[0]['images'][0]['ref'],a['ref'])
        self.assertIn('@图1',seen[0]['prompt']);self.assertIn('眼镜不能消失',seen[0]['prompt'])
        self.assertEqual(result['memory_used'][0]['id'],a['id'])
        st=self.app['creative_memory'];st.observe({'id':7},server.JOBS);st.observe({'id':7},server.JOBS)
        detail=await (await self.client.get('/api/memory/'+a['id'])).json()
        self.assertEqual(detail['ref'],a['ref']);self.assertEqual(len(detail['history']),1)
        self.assertEqual(detail['history'][0]['ref'],output['ref'])

    async def test_video_reference_preserves_first_last_frames(self):
        a=await self.create()
        last=image_editor.save(server.COMFY_DIR, Image.new('RGB',(128,96),'blue'))
        st=self.app['creative_memory'];p=st.prepare({'id':7,'role':'member'},{'kind':'video','board':'test','prompt':'@林森 走进房间','duration':5,'images':[{'ref':last['ref'],'node_id':'n1'},{'ref':last['ref']+'unused','node_id':'n2'}]})
        self.assertTrue(p['planned']);self.assertEqual([i['role'] for i in p['images']],['frame','frame','subject'])
        self.assertEqual(p['images'][0]['time'],0);self.assertGreater(p['images'][1]['time'],4)
        self.assertEqual([i['index'] for i in p['images']],[1,2,3])
        # Official request planner must accept the injected reference without missing index/role keys.
        graph,meta=server.graph_video(p);self.assertEqual(meta['mode'],'planned')
        again=st.prepare({'id':7,'role':'member'},{**p,'memory_ids':[a['id']]})
        self.assertEqual(len(again['images']),3);self.assertEqual(again['prompt'].count('创作参考资料'),1)

    async def test_document_context_and_project_exclusion(self):
        a=await self.create(name='世界观',kind='document',desc='城市禁止燃油车辆',ref=None)
        st=self.app['creative_memory'];p=st.prepare({'id':7,'role':'member'},{'kind':'image','board':'test','prompt':'@世界观 街道远景'})
        self.assertIn('禁止燃油车辆',p['prompt']);self.assertEqual(p['images'],[])
        other={**self.board,'name':'Other'};server.board_path('other').write_text(json.dumps(other))
        self.assertFalse(any(a['id']==m['id'] for m in st.list({'id':7,'role':'member'},'other')))
        self.assertEqual((await self.client.post('/api/generate',json={'kind':'image','board':'other','prompt':'@世界观 街道'})).status,400)

    async def test_ambiguous_and_unknown_mentions_never_submit(self):
        a=await self.create();b=await self.create()
        with patch.object(server,'_generate_request') as submit:
            r=await self.client.post('/api/generate',json={'kind':'image','board':'test','prompt':'@林森 跑步'})
            self.assertEqual(r.status,409)
            r=await self.client.post('/api/generate',json={'kind':'image','board':'test','prompt':'@未保存人物 跑步'})
            self.assertEqual(r.status,400);submit.assert_not_called()
        p=self.app['creative_memory'].prepare({'id':7,'role':'member'},{'kind':'image','board':'test','prompt':'@{'+a['id']+'} 跑步'})
        self.assertEqual([m['id'] for m in p['memory_used']],[a['id']])

    async def test_legacy_import_and_delete_never_resurrect(self):
        old={'id':'old1','owner':7,'name':'老角色','kind':'character','desc':'旧设定','ref':self.source['ref']}
        server.LIBRARY.write_text(json.dumps([old]))
        r=await self.client.get('/api/library');items=await r.json();self.assertEqual(items[0]['id'],'old1')
        self.assertEqual((await self.client.delete('/api/library/old1')).status,200)
        for _ in range(2):
            self.assertEqual(await (await self.client.get('/api/library')).json(),[])
        self.assertEqual(json.loads(server.LIBRARY.read_text()),[old])

    async def test_agent_retrieves_and_adopts_implicit_memory(self):
        a=await self.create(tags=['森林','主角'])
        output=image_editor.save(server.COMFY_DIR,Image.new('RGB',(64,48),'green'));seen=[]
        async def submit(req,p):
            seen.append(p);server.JOBS['e000000000001']={'id':'e000000000001','state':'done','created':1,'meta':{'uid':7},'outputs':[{'ref':output['ref'],'meta':{'width':64,'height':48}}]}
            return web.json_response({'ids':['e000000000001']})
        self.svc.model.side_effect=[call('memory_search',{'query':'森林主角'}),call('memory_use',{'memory_ids':[a['id']]},'use'),call('image_generate',{'prompt':'主角穿过森林'},'gen'),answer()]
        with patch.object(server,'_generate_request',submit):
            rid=await self.send(text='让主角穿过森林');row=await self.wait(rid)
        self.assertEqual(row['state'],'done',row.get('error'));self.assertEqual(seen[0]['images'][0]['ref'],a['ref'])
        self.assertEqual(len(self.load()['nodes']),3)
        version=self.load()['nodes'][-1]['versions'][0];self.assertEqual(version['memory_used'][0]['id'],a['id'])

    async def test_agent_save_is_idempotent_and_saves_text(self):
        self.svc.model.side_effect=[call('memory_save',{'name':'项目背景','kind':'document','description':'时间是2040年'}),answer()]
        rid=await self.send('记住这个项目背景');self.assertEqual((await self.wait(rid))['state'],'done')
        row=db.one('SELECT * FROM chat_calls WHERE run_id=?',rid);run=db.one('SELECT * FROM chat_runs WHERE id=?',rid);run['data']=json.loads(run['data'])
        await self.svc.execute(run,{'id':7,'role':'member'},row['id'],'memory_save',json.loads(row['args']))
        memories=await (await self.client.get('/api/memory?board=test')).json();self.assertEqual(len(memories),1);self.assertEqual(memories[0]['desc'],'时间是2040年')

    async def test_h3_edit_gets_real_memory_reference(self):
        a=await self.create();seen=[]
        async def submit(req,p):
            seen.append(p);return web.json_response({'ids':['e000000000002']})
        with patch.object(server,'_generate_request',submit):
            r=await self.client.post('/api/image-edit/generate',json={'ref':self.source['ref'],'prompt':'让 @林森 戴上帽子','board':'test','backend':'h3','mode':'whole'})
            result=await r.json();self.assertEqual(r.status,200,result)
        self.assertEqual(seen[0]['images'][-1]['ref'],a['ref'])
        self.assertIn('@图2',seen[0]['prompt'])
        self.assertEqual(seen[0]['_image_edit']['source'],self.source['ref'])

    async def test_native_does_not_silently_drop_memory_image(self):
        await self.create()
        mask=image_editor.save(server.COMFY_DIR,Image.new('L',(128,96),255),'input')
        from unittest.mock import AsyncMock
        with patch.object(server,'generate_native_image',AsyncMock()) as native:
            r=await self.client.post('/api/image-edit/generate',json={'ref':self.source['ref'],'mask':mask['ref'],'prompt':'让 @林森 戴上帽子','board':'test','backend':'native','mode':'region'})
            result=await r.json();self.assertEqual(r.status,400,result);self.assertIn('H3',result['error']);native.assert_not_awaited()

    async def test_scene_memory_uses_environment_semantics(self):
        await self.create(name='老书店',kind='scene',desc='木质书架和暖色灯光')
        p=self.app['creative_memory'].prepare({'id':7,'role':'member'},{'kind':'video','board':'test','prompt':'@老书店 的晨光','duration':5})
        body,meta=server.engine_body(p)
        self.assertEqual(body['references'],[str(server.tools.ref_path(server.COMFY_DIR,self.source['ref']))])
        self.assertEqual(body['keyframes'],[]);self.assertIn('is the environment',body['prompt']);self.assertNotIn('face, body shape',body['prompt'])

    async def test_character_main_approval_controls_default_and_invalidates_old_angles(self):
        asset = await self.create()
        source = asset["ref"]
        other = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"))["ref"]
        third = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "green"))["ref"]
        board = self.load()
        board["nodes"][0]["versions"].extend([{"ref": other}, {"ref": third}])
        server.board_path("test").write_text(json.dumps(board))

        async def update(ref, slot, **fields):
            return await self.client.post("/api/memory", json={
                "id": asset["id"], "ref": ref, "character_view": slot,
                "source_board": "test", **fields
            })

        self.assertEqual((await update(other, "face")).status, 400)
        response = await update(other, "main", character_card={"details": "戒指固定在本人左手"})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["default_ref"], other)
        response = await update(source, "face")
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result["character_views"], {"main": other, "face": source})
        payload = self.app["creative_memory"].prepare({"id": 7, "role": "member"}, {
            "kind": "image", "board": "test", "prompt": "@林森 正在读书"
        })
        self.assertEqual([item["ref"] for item in payload["images"]], [other])
        self.assertIn("戒指固定在本人左手", payload["prompt"])
        response = await update(third, "main")
        result = await response.json()
        self.assertEqual(result["character_views"], {"main": third})
        self.assertEqual(len(result["media"]), 3)

    async def test_deleted_asset_unlinks_board_and_can_be_saved_again(self):
        asset = await self.create()
        board = self.load()
        item = board["nodes"][0]
        item["data"]["asset"] = {"id": asset["id"], "kind": "character"}
        item["data"]["character_draft"] = {"asset": asset["id"], "slot": "main"}
        saved = await self.client.put("/api/board/test", json=board)
        self.assertEqual(saved.status, 200)
        board["rev"] = (await saved.json())["rev"]
        response = await self.client.delete("/api/memory/" + asset["id"])
        self.assertEqual(response.status, 200)
        loaded = await (await self.client.get("/api/board/test")).json()
        self.assertNotIn("asset", loaded["nodes"][0]["data"])
        self.assertNotIn("character_draft", loaded["nodes"][0]["data"])
        self.assertEqual(loaded["nodes"][0]["versions"][0]["ref"], item["versions"][0]["ref"])
        stale = await self.client.put("/api/board/test", json=board)
        self.assertEqual(stale.status, 200)
        self.assertNotIn("asset", self.load()["nodes"][0]["data"])
        recreated = await self.client.post("/api/library", json={
            "id": asset["id"], "recreate_deleted": True, "kind": "character",
            "name": asset["name"], "ref": asset["ref"], "source_board": "test", "node_id": item["id"]
        })
        self.assertEqual(recreated.status, 200, await recreated.text())
        replacement = await recreated.json()
        self.assertNotEqual(replacement["id"], asset["id"])
        self.assertEqual(replacement["board"], "test")
