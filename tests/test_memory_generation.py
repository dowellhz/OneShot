"""Apply worldbuilding and pinned asset references to generation."""

from unittest.mock import AsyncMock, patch
import io
import json

from PIL import Image
from aiohttp import FormData, web

from oneshot.editing import image_editor
from oneshot.generation import local as local_generation
from oneshot.generation import prompts
from oneshot.generation import requests as generation_requests
from oneshot.web import media as media_routes
import server

from memory_fixture import MemoryFixture


class MemoryGeneration(MemoryFixture):
    async def test_project_world_and_scene_character_are_previewed_and_bound_to_video(self):
        await self.client.put("/api/board/another",json={"nodes":[]})
        hero = await self.create(character_view="main")
        raw = io.BytesIO()
        Image.new("RGB",(32,32),"blue").save(raw,"PNG")
        form = FormData()
        form.add_field("file",raw.getvalue(),filename="costume.png",content_type="image/png")
        upload = await self.client.post("/api/upload",data=form)
        self.assertEqual(upload.status,200,await upload.text())
        costume = (await upload.json())["ref"]
        hero = await self.create(id=hero["id"],ref=costume,source_board="",node_id=None,
                                 story_states=[{"scene":"十七号厅","notes":"改穿蓝色风衣","ref":costume}])
        world = await self.create(kind="world",name="馆内规则",ref="",desc="不能照相",
                                  story_scenes=["十七号厅"])
        await self.create(kind="world",name="旧馆内规则",ref="",story_draft=True,desc="允许照相")
        await self.create(kind="world",name="异项目规则",ref="",board="another",desc="不得穿蓝色")
        await self.create(name="林森",ref="",board="another",desc="另一项目的同名人物",
                          story_states=[{"scene":"十七号厅","notes":"改穿红色外套"}])
        request = {"kind":"video","board":"test","prompt":"","planned":True,"fields":{"scene":"十七号厅","people":"林森"},
                   "images":[{"asset":hero["id"],"ref":hero["ref"],"index":1,"role":"subject","story_cast":True}]}
        with patch.object(prompts,"to_english",side_effect=lambda app,p:p):
            preview = await self.client.post("/api/preview",json=request)
        self.assertEqual(preview.status,200,await preview.text())
        reviewed = await preview.json()
        self.assertEqual({asset["name"] for asset in reviewed["memory_context"]},{"林森","馆内规则"})
        self.assertEqual([image["ref"] for image in reviewed["inputs"]],[costume])
        self.assertIn("改穿蓝色风衣",reviewed["prompt"])
        self.assertNotIn("改穿红色外套",reviewed["prompt"])
        with patch.object(generation_requests,"_generate_request",new_callable=AsyncMock) as submit:
            submit.return_value = web.json_response({"ids":[]})
            initial = await self.client.post("/api/generate",json={**request,"asset_review_key":reviewed["asset_review_key"]})
            self.assertEqual(initial.status,200,await initial.text())
            retained = submit.await_args.args[1]
            self.assertEqual([image["ref"] for image in retained["images"]],[costume])
            self.assertIn("不能照相",retained["prompt"])
            await self.create(id=world["id"],kind="world",name=world["name"],ref="",desc="严禁闪光灯")
            rejected = await self.client.post("/api/generate",json={**request,"asset_review_key":reviewed["asset_review_key"]})
            self.assertEqual(rejected.status,409,await rejected.text())
            explicit = await self.client.post("/api/generate",json={**request,"images":[],
                "prompt":"@{"+hero["id"]+"#main|林森}"})
            self.assertEqual(explicit.status,200,await explicit.text())
            self.assertEqual([image["ref"] for image in submit.await_args.args[1]["images"]],[hero["ref"]])
            next_scene = await self.client.post("/api/generate",json={**request,
                "fields":{"scene":"门外","people":"林森"},"memory_ids":[hero["id"]]})
            self.assertEqual(next_scene.status,200,await next_scene.text())
            self.assertEqual([image["ref"] for image in submit.await_args.args[1]["images"]],[hero["ref"]])
            self.assertNotIn("严禁闪光灯",submit.await_args.args[1]["prompt"])

    async def test_world_candidates_apply_only_to_matching_storyboard_shots(self):
        matching = await self.create(kind="world",name="仓库规则",ref="",desc="仓库禁止点火",story_scenes=["夜间仓库"])
        whole_story = await self.create(kind="world",name="城镇设定",ref="",desc="城镇由河道分成两半")
        draft = await self.create(kind="world",name="设定草稿",ref="",story_draft=True)
        store = self.app["creative_memory"]
        candidates = store.storyboard_assets({"id":7,"role":"member"},"test","从夜间仓库来到河岸")
        self.assertEqual({asset["id"] for asset in candidates},{matching["id"],whole_story["id"]})
        shots = [{"scene":"夜间仓库","characters":[]},
                 {"scene":"河岸","characters":[],"asset_refs":[{"id":matching["id"]},{"id":draft["id"]}]}]
        server.tools.bind_storyboard_assets(shots,candidates)
        self.assertEqual({asset["id"] for asset in shots[0]["asset_refs"]},{matching["id"],whole_story["id"]})
        self.assertEqual([asset["id"] for asset in shots[1]["asset_refs"]],[whole_story["id"]])

    async def test_batch_generation_asset_review_is_scoped_and_blocks_changed_references(self):
        hero = await self.create(character_view="main")
        await self.client.put("/api/board/another",json={"nodes":[]})
        other = await self.create(board="another",name="只在另一画布")
        token = "@{"+hero["id"]+"#main|林森}"
        raw = {"kind":"image","prompt":token+" 站在街上","images":[],"board":"test"}
        entries = [{"id":"ready","kind":"image","prompt":raw["prompt"]},
                   {"id":"bad-view","kind":"video","prompt":"","fields":{"scene":token.replace("#main","#back")}},
                   {"id":"wrong-board","kind":"image","prompt":"@{"+other["id"]+"|其他素材}"}]
        route = "/api/memory/review-generation"
        reviewed = await self.client.post(route,json={"board":"test","entries":entries})
        self.assertEqual(reviewed.status,200,await reviewed.text())
        current, undrafted, hidden = await reviewed.json()
        self.assertEqual(current["assets"][0]["references"],[{"view":"main","ref":hero["ref"]}])
        self.assertIn("尚未定稿",undrafted["error"])
        self.assertIn("不可访问",hidden["error"])
        response = await self.client.post(route,json={"board":"test","entries":entries},headers={"X-Uid":"8"})
        self.assertEqual(response.status,403)

        with patch.object(generation_requests,"_generate_request",new_callable=AsyncMock) as submit:
            submit.return_value = web.json_response({"ids":[]})
            confirmed = await self.client.post("/api/generate",json={**raw,"asset_review_key":current["key"]})
            self.assertEqual(confirmed.status,200,await confirmed.text())
            user = {"id":7,"role":"member"}
            self.app["creative_memory"].put(user,{"id":hero["id"],"desc":"改用另一套服装"})
            stale = await self.client.post("/api/generate",json={**raw,"asset_review_key":current["key"]})
            self.assertEqual(stale.status,409,await stale.text())
            submit.assert_awaited_once()

    async def test_batch_resolution_returns_full_ordered_assets_and_requires_access_to_all(self):
        private = await self.create(name="相机",board="")
        document = await self.create(name="拍摄说明",board="",kind="document",shared=True,ref="",
                                     document={"name":"拍摄说明.md","format":"markdown","text":"# 镜头要求\n完整保留这段文字"})
        route = "/api/memory/resolve"
        ids = [document["id"],private["id"],document["id"]]
        owner = await self.client.post(route,json={"board":"test","ids":ids})
        self.assertEqual(owner.status,200,await owner.text())
        items = await owner.json()
        self.assertEqual([item["id"] for item in items],ids[:2])
        self.assertEqual(items[0]["document"]["text"],"# 镜头要求\n完整保留这段文字")
        self.assertEqual(items[1]["ref"],self.source["ref"])
        guest = {"X-Uid":"8"}
        await self.client.put("/api/board/b-guest",headers=guest,json={"name":"独立画布","nodes":[]})
        response = await self.client.post(route,json={"board":"b-guest","ids":ids},headers=guest)
        self.assertEqual(response.status,404)
        response = await self.client.post(route,json={"board":"b-guest","ids":ids[:1]},headers=guest)
        self.assertEqual(response.status,200)
        self.assertEqual([item["id"] for item in await response.json()],ids[:1])

    async def test_explicit_mention_reaches_generation_and_records_history(self):
        a = await self.create(aliases=['小林'], constraints='眼镜不能消失')
        output = image_editor.save(server.COMFY_DIR, Image.new('RGB',(64,48),'orange'))
        seen=[]
        async def submit(req,p):
            seen.append(p)
            server.JOBS['e000000000001']={'id':'e000000000001','state':'done','created':1,'meta':{'uid':7},'outputs':[{'ref':output['ref'],'meta':{'width':64,'height':48}}]}
            return web.json_response({'ids':['e000000000001']})
        with patch.object(generation_requests,'_generate_request',submit):
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

    async def test_generation_image_bundle_preserves_order_and_one_subject(self):
        a = await self.create(name="样品瓶", kind="prop")
        image = io.BytesIO()
        Image.new("RGB", (48, 64), "blue").save(image, "PNG")
        form = FormData()
        form.add_field("file", image.getvalue(), filename="side.png", content_type="image/png")
        upload = await self.client.post("/api/upload", data=form)
        self.assertEqual(upload.status, 200, await upload.text())
        other = (await upload.json())["ref"]
        refs = [other, a["ref"]]
        edit = {"id":a["id"],"mtime":a["mtime"],"ref":other,"generation_images":refs}
        for invalid in ([other,other],["input:h3studio/unowned.png"]):
            attempt = await self.client.post("/api/memory", json={**edit,"generation_images":invalid})
            self.assertEqual(attempt.status,400,await attempt.text())
        saved = await self.client.post("/api/memory", json=edit)
        self.assertEqual(saved.status,200,await saved.text())
        data = await saved.json()
        self.assertEqual(data["generation_images"],refs)
        self.assertEqual(data["ref"],a["ref"])

        frame = image_editor.save(server.COMFY_DIR, Image.new("RGB",(64,64),"white"))["ref"]
        model_payload = {"kind":"video","board":"test","prompt":"从首帧看 @样品瓶","images":[
            {"ref":frame,"role":"frame","time":0,"index":1}]}
        st = self.app["creative_memory"]
        user = {"id":7,"role":"member"}
        prepared = st.prepare(user,model_payload)
        self.assertEqual([entry["ref"] for entry in prepared["images"]],[frame,*refs])
        self.assertEqual([entry["ref"] for entry in prepared["memory_used"][0]["references"]],refs)
        _, meta = server.graph_video(prepared)
        prompt = meta["full_prompt"]
        self.assertIn("<Subject 1> is the object in <Picture 1>",prompt)
        self.assertIn("<Picture 2> is an additional view of the same <Subject 1>",prompt)
        self.assertNotIn("<Subject 2>",prompt)
        self.assertIn("<Picture 3> is the first frame",prompt)

        reset = await self.client.post("/api/memory",json={"id":a["id"],"mtime":data["mtime"],"generation_images":[]})
        self.assertEqual(reset.status,200,await reset.text())
        self.assertEqual([entry["ref"] for entry in st.prepare(user,model_payload)["images"]],[frame,a["ref"]])
        recorded = {**a,"references":[{"view":None,"ref":ref} for ref in refs]}
        with patch.object(st,"historical_assets",return_value={a["id"]:recorded}), \
                patch.object(media_routes,"require_media"):
            replay = st.prepare(user,model_payload,replay_ref=frame)
        self.assertEqual([entry["ref"] for entry in replay["images"]],[frame,*refs])

    async def test_project_world_adds_visual_details_to_image_without_document_text(self):
        world = await self.create(kind="world", name="故事世界观", ref="", story_scenes=["旧画市"],
                                  desc="旧画市用掉漆的绿色门框。此章节解释社会制度和小说主线。")
        char = await self.create(name="林森", constraints="保持眼镜")
        shot = '@林森 在旧画市门口等人，门牌写着「17」'
        generate = AsyncMock(return_value=web.json_response({"ids": []}))
        chat = AsyncMock(return_value='{"visual_details":["门框刷着磨损的暗绿色漆"]}')
        with patch.object(generation_requests, "_generate_request", generate), patch.object(self.app["llm"], "available", return_value=True), \
                patch.object(self.app["llm"], "chat", chat, create=True):
            response = await self.client.post("/api/generate", json={"kind":"image", "board":"test", "prompt":shot})
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result["image_story_context"], "applied")
        self.assertIn(world["id"], [item["id"] for item in result["memory_used"]])
        sent = generate.await_args.args[1]
        self.assertEqual([image["ref"] for image in sent["images"]], [char["ref"]])
        self.assertIn("保持眼镜", sent["prompt"])
        self.assertIn("暗绿色漆", sent["prompt"])
        self.assertIn("门牌写着「17」", sent["prompt"])
        self.assertNotIn("故事世界观", sent["prompt"])
        self.assertNotIn("小说主线", sent["prompt"])
        prepared_again = self.app["creative_memory"].prepare({"id":7,"role":"member"}, sent)
        self.assertNotIn("本镜画面要求", prepared_again["prompt"])

    async def test_replay_freezes_text_only_assets_and_cannot_be_claimed_by_another_user(self):
        user = {"id":7,"role":"member"}
        asset = await self.create(name="旧剧本",kind="document",ref="",desc="原设定",constraints="沿用红色",
                                  document={"name":"本集故事","text":"她带走蓝色钥匙"})
        request = {"board":"test","kind":"image","prompt":"根据 @旧剧本 绘制站台"}
        store = self.app["creative_memory"]
        original = store.prepare(user,request)
        output = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))
        store.track(user,original,{"ids":["old-doc-job"]})
        store.observe(user,{"old-doc-job":{"state":"done","outputs":[output]}})
        updated = await self.client.post("/api/memory",json={"id":asset["id"],"name":"新剧本","desc":"新设定",
            "constraints":"改用灰色","ref":self.source["ref"],"source_board":"test",
            "document":{"name":"本集故事","text":"她带走黑色钥匙"}})
        self.assertEqual(updated.status,200,await updated.text())

        chat = AsyncMock(return_value='{"visual_details":["红色站台，人物拿着蓝色钥匙"]}')
        with patch.object(generation_requests,"_generate_request",AsyncMock(return_value=web.json_response({"ids":[]}))) as submit, \
                patch.object(self.app["llm"], "available", return_value=True), patch.object(self.app["llm"], "chat", chat, create=True):
            response = await self.client.post("/api/generate",json={**request,"replay_memory_ref":output["ref"]})
            self.assertEqual(response.status,200,await response.text())
            payload = submit.await_args.args[1]
            source = json.loads(chat.await_args.args[1])["sources"][0]
            self.assertEqual((source["desc"],source["constraints"],source["document_excerpt"]),
                             ("原设定","沿用红色","她带走蓝色钥匙"))
            self.assertIn("红色站台，人物拿着蓝色钥匙",payload["prompt"])
            self.assertNotIn("她带走蓝色钥匙",payload["prompt"])
            self.assertNotIn("黑色钥匙",payload["prompt"])
            self.assertEqual(payload["images"],[])
            self.assertEqual(payload["memory_used"][0]["generation_context"],original["memory_used"][0]["generation_context"])
            server.grant_media({"id":8},output["ref"])
            guest = await self.client.post("/api/generate",headers={"X-Uid":"8"},
                json={**request,"prompt":"画一张图","replay_memory_ref":output["ref"]})
            self.assertEqual(guest.status,400,await guest.text())
            submit.assert_awaited_once()

    async def test_ambiguous_and_unknown_mentions_never_submit(self):
        a=await self.create();b=await self.create()
        with patch.object(generation_requests,'_generate_request') as submit:
            r=await self.client.post('/api/generate',json={'kind':'image','board':'test','prompt':'@林森 跑步'})
            self.assertEqual(r.status,409)
            r=await self.client.post('/api/generate',json={'kind':'image','board':'test','prompt':'@未保存人物 跑步'})
            self.assertEqual(r.status,400);submit.assert_not_called()
        p=self.app['creative_memory'].prepare({'id':7,'role':'member'},{'kind':'image','board':'test','prompt':'@{'+a['id']+'} 跑步'})
        self.assertEqual([m['id'] for m in p['memory_used']],[a['id']])

    async def test_longer_character_alias_wins_in_project_generation(self):
        created = await self.client.post("/api/canvas-projects",json={"name":"短片","board":"test"})
        project = (await created.json())["id"]
        await self.client.put("/api/board/shots",params={"project":project},json={"nodes":[]})
        elder = await self.create(name="红围巾",aliases=["林森","戴着红色围巾在街上走的人"],board="",project=project)
        younger = await self.create(name="黑夹克",aliases=["林森弟弟"],board="",project=project)
        await self.create(name="个人版本",aliases=["林森"],board="")
        raw = {"kind":"video","board":"shots","prompt":"@林森弟弟等车"}
        with patch.object(generation_requests,"_generate_request",AsyncMock(return_value=web.json_response({"ids":[]}))) as submit:
            response = await self.client.post("/api/generate",json=raw)
            self.assertEqual(response.status,200,await response.text())
            prepared = submit.await_args.args[1]
            self.assertEqual([m["id"] for m in prepared["memory_used"]],[younger["id"]])
            self.assertTrue(prepared["prompt"].startswith("黑夹克等车"))
            labelled = "@{" + elder["id"] + "|红围巾}"
            response = await self.client.post("/api/generate",json={**raw,"fields":{"action":labelled+"看向@林森弟弟"}})
            self.assertEqual(response.status,200,await response.text())
            prepared = submit.await_args.args[1]
            self.assertEqual(prepared["fields"]["action"],"红围巾看向黑夹克")
            self.assertEqual({m["id"] for m in prepared["memory_used"]},{elder["id"],younger["id"]})

    async def test_h3_edit_gets_real_memory_reference(self):
        a=await self.create();seen=[]
        async def submit(req,p):
            seen.append(p);return web.json_response({'ids':['e000000000002']})
        with patch.object(generation_requests,'_generate_request',submit):
            r=await self.client.post('/api/image-edit/generate',json={'ref':self.source['ref'],'prompt':'让 @林森 戴上帽子','board':'test','backend':'h3','mode':'whole'})
            result=await r.json();self.assertEqual(r.status,200,result)
        self.assertEqual(seen[0]['images'][-1]['ref'],a['ref'])
        self.assertIn('@图2',seen[0]['prompt'])
        self.assertEqual(seen[0]['_image_edit']['source'],self.source['ref'])

    async def test_native_does_not_silently_drop_memory_image(self):
        await self.create()
        mask=image_editor.save(server.COMFY_DIR,Image.new('L',(128,96),255),'input')
        from unittest.mock import AsyncMock
        with patch.object(local_generation,'generate_native_image',AsyncMock()) as native:
            r=await self.client.post('/api/image-edit/generate',json={'ref':self.source['ref'],'mask':mask['ref'],'prompt':'让 @林森 戴上帽子','board':'test','backend':'native','mode':'region'})
            result=await r.json();self.assertEqual(r.status,400,result);self.assertIn('H3',result['error']);native.assert_not_awaited()
