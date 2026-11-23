"""Remote HTTP roundtrips: memory ownership, actual generation refs and durable history."""
import io
import json
from zipfile import ZipFile
from unittest.mock import AsyncMock, patch
from aiohttp import FormData, web
from PIL import Image
import image_editor
import db
import server
from test_agent_chat import ChatFixture, call, answer


class MemoryIntegration(ChatFixture):
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

    async def test_folder_references_preserve_exact_asset_and_recheck_team_access(self):
        base, guest = "/api/asset-folders", {"X-Uid":"8"}
        team = (await (await self.client.post("/api/canvas-teams",json={"name":"选片组"})).json())["id"]
        query = "?team="+team
        roster = f"/api/canvas-teams/{team}/members"
        await self.client.patch(roster,json={"username":"test8","action":"add"})
        private_folder = (await (await self.client.post(base,json={"name":"同名参考"})).json())["id"]
        team_folder = (await (await self.client.post(base+query,json={"name":"同名参考"})).json())["id"]
        private_asset = await self.create(name="道具",board="",desc="个人图")
        shared_asset = await self.create(name="道具",board="",team=team,desc="团队造型")
        for fid, asset, scope in ((private_folder,private_asset,{}),(team_folder,shared_asset,{"team":team})):
            result = await self.client.post(base+"/members",json={"board":"test","folder":fid,"assets":[asset["id"]],**scope})
            self.assertEqual(result.status,200,await result.text())
        await self.client.put("/api/board/guest-folder-ref",headers=guest,json={"name":"成员画布","nodes":[]})
        route = base+"/references"
        response = await self.client.get(route,params={"board":"test"})
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual({folder["id"] for folder in await response.json()},{private_folder,team_folder})
        scope = {"board":"guest-folder-ref","folder":team_folder}
        details = await (await self.client.get(route,params=scope,headers=guest)).json()
        self.assertEqual([item["id"] for item in details["assets"]],[shared_asset["id"]])
        self.assertEqual((await self.client.get(route,params={**scope,"folder":private_folder},headers=guest)).status,404)
        token = "@{"+shared_asset["id"]+"|旧名字}"
        seen = []
        async def submit(_req,payload):
            seen.append(payload)
            return web.json_response({"ids":[]})
        with patch.object(server,"_generate_request",submit):
            generated = await self.client.post("/api/generate",json={"board":"test","kind":"image","prompt":token+" 上台"})
        self.assertEqual(generated.status,200,await generated.text())
        self.assertIn("道具 上台",seen[0]["prompt"])
        self.assertNotIn(token,seen[0]["prompt"])
        self.assertEqual([asset["id"] for asset in seen[0]["memory_used"]],[shared_asset["id"]])
        guest_session = (await (await self.client.post("/api/chat/sessions",json=scope,headers=guest)).json())["id"]
        await self.client.patch(roster,json={"username":"test8","action":"remove"})
        self.assertEqual((await self.client.get(route,params=scope,headers=guest)).status,404)
        denied = await self.client.post(f"/api/chat/sessions/{guest_session}/messages",headers=guest,
                                        json={"text":token+" 上台","request_key":"check-folder-permission"})
        self.assertEqual(denied.status,400,await denied.text())
        self.assertIn("已失效或不可访问",(await denied.json())["error"])

    async def test_team_asset_folders_share_placement_and_keep_personal_folders(self):
        base = "/api/asset-folders"
        team = (await (await self.client.post("/api/canvas-teams",json={"name":"团队档案"})).json())["id"]
        roster = "/api/canvas-teams/"+team+"/members"
        guest = {"X-Uid":"8"}
        query = "?team="+team
        await self.client.patch(roster,json={"username":"test8","action":"add"})
        personal = (await (await self.client.post(base,json={"name":"参考资料"})).json())["id"]
        response = await self.client.post(base+query,json={"name":"参考资料"})
        self.assertEqual(response.status,201,await response.text())
        fid = (await response.json())["id"]
        self.assertNotEqual(fid,personal)
        self.assertEqual(await (await self.client.get(base+query,headers=guest)).json(),[{"id":fid,"name":"参考资料"}])
        self.assertEqual(await (await self.client.get(base,headers=guest)).json(),[])
        self.assertEqual((await self.client.post(base+query,headers=guest,json={"name":"尝试创建"})).status,403)
        self.assertEqual((await self.client.delete(base+"/"+fid+query,headers=guest)).status,403)

        response = await self.client.post("/api/memory/import-canvas",json={"board":"test","team":team,"scope":"team",
                "folder":fid,"request_key":"team-folder-qa","nodes":[{"id":"n2","ref":None}]})
        self.assertEqual(response.status,201,await response.text())
        aid = (await response.json())["ids"][0]
        mem = "/api/memory/"+aid
        personal_move = {"board":"test","assets":[aid],"folder":personal}
        self.assertEqual((await self.client.post(base+"/members",json=personal_move)).status,200)
        mine = next(a for a in await (await self.client.get("/api/memory")).json() if a["id"]==aid)
        their = next(a for a in await (await self.client.get("/api/memory",headers=guest)).json() if a["id"]==aid)
        self.assertEqual((mine["folder_id"],mine["team_folder_id"]),(personal,fid))
        self.assertEqual((their["folder_id"],their["team_folder_id"]),(None,fid))

        await self.client.put("/api/board/guest-folders",headers=guest,json={"name":"测试","nodes":[]})
        move = {"board":"guest-folders","assets":[aid],"folder":None,"team":team}
        self.assertEqual((await self.client.post(base+"/members",headers=guest,json=move)).status,403)
        guest_asset = (await (await self.client.post("/api/memory",headers=guest,json={
            "name":"成员收录","kind":"prop","team":team})).json())["id"]
        self.assertEqual((await self.client.post(base+"/members",headers=guest,json={**move,"assets":[guest_asset],"folder":fid})).status,200)
        self.assertEqual((await self.client.patch(base+"/"+fid+query,json={"name":"改名后"})).status,200)
        self.assertEqual((await self.client.post("/api/memory",json={"id":aid,"team":""})).status,200)
        self.assertIsNone(db.one("SELECT 1 FROM team_asset_folder_items WHERE asset_id=?",aid))
        self.assertEqual((await self.client.get(mem,headers=guest)).status,404)
        self.assertEqual((await self.client.delete(base+"/"+fid+query)).status,200)
        self.assertIsNone(db.one("SELECT 1 FROM team_asset_folder_items WHERE asset_id=?",guest_asset))
        self.assertEqual((await self.client.get("/api/memory/"+guest_asset,headers=guest)).status,200)
        await self.client.patch(roster,json={"username":"test8","action":"remove"})
        self.assertEqual((await self.client.get(base+query,headers=guest)).status,404)

    async def test_named_team_assets_scope_download_and_generation(self):
        team = (await (await self.client.post("/api/canvas-teams",json={"name":"造型组"})).json())["id"]
        roster = "/api/canvas-teams/"+team+"/members"
        guest = {"X-Uid":"8"}
        self.assertEqual((await self.client.patch(roster,json={"username":"test8","action":"add"})).status,200)
        source = {"name":"团队海报","kind":"prop","team":team,"source_board":"test","node_id":"n1","ref":self.source["ref"]}
        self.assertEqual((await self.client.post("/api/memory",json={**source,"shared":True})).status,400)
        self.assertEqual((await self.client.post("/api/memory",json={**source,"board":"test"})).status,400)
        self.assertEqual((await self.client.post("/api/memory",json={**source,"team":"other"})).status,403)
        saved = await (await self.client.post("/api/memory",json=source)).json()
        self.assertEqual((saved["team"],saved["shared"],saved["board"]),(team,False,""))
        root = "/api/memory/"+saved["id"]
        self.assertEqual((await self.client.post("/api/memory",headers=guest,json={"id":saved["id"],"name":"重命名"})).status,403)
        self.assertEqual((await self.client.get(root,headers=guest)).status,200)
        self.assertEqual((await self.client.get("/media",headers=guest,params={"ref":self.source["ref"]})).status,200)
        with patch.object(server,"DATA",self.root):
            self.assertEqual((await self.client.get(root+"/download",headers=guest)).status,200)

        own_board = "/api/board/guest-board"
        self.assertEqual((await self.client.put(own_board,headers=guest,json={"name":"访客","nodes":[],"edges":[]})).status,200)
        self.assertEqual([a["id"] for a in await (await self.client.get("/api/memory?board=guest-board",headers=guest)).json()],[saved["id"]])
        seen = []
        async def submit(req,payload):
            seen.append(payload)
            return web.json_response({"ids":[]})
        with patch.object(server,"_generate_request",submit):
            response = await self.client.post("/api/generate",headers=guest,json={"kind":"image","board":"guest-board","prompt":"@团队海报"})
            self.assertEqual(response.status,200,await response.text())
        self.assertIn(self.source["ref"],[img["ref"] for img in seen[0]["images"]])
        imported = await (await self.client.post("/api/memory/import-canvas",json={"board":"test","team":team,
                "scope":"team","request_key":"named-team-test","nodes":[{"id":"n2","ref":None}]})).json()
        self.assertEqual((await (await self.client.get("/api/memory/"+imported["ids"][0],headers=guest)).json())["team"],team)

        self.assertEqual((await self.client.patch(roster,json={"username":"test8","action":"remove"})).status,200)
        self.assertEqual((await self.client.get(root,headers=guest)).status,404)
        self.assertEqual((await self.client.get(root+"/download",headers=guest)).status,404)
        self.assertEqual((await self.client.get("/media",headers=guest,params={"ref":self.source["ref"]})).status,404)
        self.assertEqual(await (await self.client.get("/api/memory?board=guest-board",headers=guest)).json(),[])
        with patch.object(server,"_generate_request",submit):
            response = await self.client.post("/api/generate",headers=guest,json={"kind":"image","board":"guest-board","prompt":"@团队海报"})
            self.assertEqual(response.status,400,await response.text())
        self.assertEqual(len(seen),1)

    async def test_duplicate_and_download_use_asset_permissions(self):
        notes = "# 镜头资料\n\n服装保持一致。\n"
        source_payload = {"name":"角色 山岚","kind":"character","shared":True,"tags":["主角"],
            "aliases":["岚"],"source_board":"test","node_id":"n1","ref":self.source["ref"],
            "character_view":"main","character_card":{"appearance":"浅灰外套"},
            "document":{"name":"镜头资料.md","text":notes,"format":"markdown"}}
        saved = await (await self.client.post("/api/memory",json=source_payload)).json()
        owner_route = "/api/memory/"+saved["id"]
        guest = {"X-Uid":"8"}
        request = {"request_key":"shared-memory-copy"}
        with patch.object(server,"DATA",self.root):
            reply = await self.client.get(owner_route+"/download",headers=guest)
            self.assertEqual(reply.status,200,await reply.text() if reply.status!=200 else "")
            self.assertIn("filename*=UTF-8''",reply.headers["Content-Disposition"])
            with ZipFile(io.BytesIO(await reply.read())) as package:
                self.assertEqual(package.read("背景资料.md").decode(),notes)
                self.assertIn("浅灰外套",package.read("资产说明.md").decode())
                self.assertEqual(package.read("01-main.png"),server.tools.ref_path(server.COMFY_DIR,self.source["ref"]).read_bytes())
        copied = await (await self.client.post(owner_route+"/duplicate",headers=guest,json=request)).json()
        self.assertEqual((copied["name"],copied["owner"],copied["shared"],copied["board"],copied["aliases"]),
                         ("角色 山岚 副本",8,False,"",[]))
        self.assertEqual(copied["character_views"],saved["character_views"])
        self.assertIsNone(copied["media"][0].get("node_id"))
        self.assertEqual((await (await self.client.post(owner_route+"/duplicate",headers=guest,json=request)).json())["id"],copied["id"])
        second = await (await self.client.post(owner_route+"/duplicate",headers=guest,json={"request_key":"new-copy-request"})).json()
        self.assertEqual(second["name"],"角色 山岚 副本 2")
        self.assertEqual((await self.client.post("/api/memory",json={"id":saved["id"],"shared":False})).status,200)
        self.assertEqual((await self.client.get(owner_route+"/download",headers=guest)).status,404)
        self.assertEqual((await self.client.post(owner_route+"/duplicate",headers=guest,json=request)).status,404)
        self.assertEqual((await self.client.get("/media",params={"ref":self.source["ref"]},headers=guest)).status,200)
        self.assertEqual((await self.client.get("/api/memory/"+copied["id"])).status,404)

    async def test_import_canvas_assets_is_atomic_and_retry_safe(self):
        board = self.load()
        full_document = "    开场\n\n" + "镜头说明\n" * 1600 + "\n尾注  \n"
        board["nodes"][1]["data"].update(text=full_document, text_format="markdown")
        ref = "input:h3studio/group-sound.wav"
        path = server.tools.ref_path(server.COMFY_DIR,ref)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(b"RIFF audio fixture")
        server.grant_media({"id":7},ref)
        board["nodes"].append({"id":"n3","type":"audio","name":"现场录音","x":700,"y":50,
                               "data":{},"versions":[{"ref":ref,"source":"upload","seconds":2}],"cur":0})
        self.assertEqual((await self.client.put("/api/board/test",json=board)).status,200)
        folder = await (await self.client.post("/api/asset-folders",json={"name":"样片"})).json()
        url = "/api/memory/import-canvas"
        entries = [{"id":"n1","ref":self.source["ref"]},{"id":"n2","ref":None},{"id":"n3","ref":ref}]
        payload = {"board":"test","scope":"personal","folder":folder["id"],"request_key":"qa-import-1234","nodes":entries}
        bad = {**payload,"nodes":[*entries,{"id":"n4","ref":None}]}
        self.assertEqual((await self.client.post(url,json=bad)).status,409)
        self.assertEqual(db.q("SELECT id FROM creative_memories"),[])
        self.assertEqual(db.q("SELECT asset_id FROM asset_folder_items"),[])
        response = await self.client.post(url,json=payload)
        self.assertEqual(response.status,201,await response.text())
        ids = (await response.json())["ids"]
        self.assertEqual((await (await self.client.post(url,json=payload)).json())["ids"],ids)
        assets = {a["id"]:a for a in await (await self.client.get("/api/memory?board=test")).json()}
        self.assertEqual(len(assets),3)
        self.assertTrue(all(a["folder_id"]==folder["id"] and not a["shared"] and not a["board"] for a in assets.values()))
        self.assertEqual(assets[ids[0]]["ref"],self.source["ref"])
        self.assertNotIn("text",assets[ids[1]]["document"])
        full_asset = await (await self.client.get(f"/api/memory/{ids[1]}?board=test")).json()
        self.assertEqual(full_asset["document"]["text"],full_document)
        self.assertEqual(full_asset["document"]["format"],"markdown")
        self.assertEqual((assets[ids[2]]["media"][0]["type"],assets[ids[2]]["media"][0]["seconds"]),("audio",2))
        await self.client.patch("/api/board/test/access",json={"username":"test8","role":"reviewer"})
        guest = {"X-Uid":"8"}
        self.assertEqual((await self.client.post(url,json=payload,headers=guest)).status,403)
        self.assertEqual(await (await self.client.get("/api/memory?board=test",headers=guest)).json(),[])
        project = await (await self.client.post("/api/canvas-projects",json={"name":"制作","board":"test"})).json()
        scoped = {**payload,"scope":"project","project":project["id"],"folder":None,"nodes":entries[:1]}
        self.assertEqual((await self.client.post(url,json={**scoped,"project":"stale"})).status,409)
        response = await self.client.post(url,json=scoped)
        self.assertEqual(response.status,201,await response.text())
        scoped_id = (await response.json())["ids"][0]
        self.assertEqual(db.one("SELECT json_extract(data,'$.project') AS project FROM creative_memories WHERE id=?",scoped_id)["project"],project["id"])

    async def import_document(self, name, raw):
        form = FormData()
        form.add_field("file",raw,filename=name,content_type="application/octet-stream")
        return await self.client.post("/api/document-import",data=form)

    async def test_document_search_and_generation_use_relevant_original_passage(self):
        raw = ("日常资料\n"*6000 + "港口雨夜灯位：蓝色灯从左侧照亮吊车。").encode()
        response = await self.import_document("场景档案.md",raw)
        self.assertEqual(response.status,200,await response.text())
        document = await response.json()
        self.assertEqual(document["name"],"场景档案.md")
        self.assertFalse(document["truncated"])
        saved = await self.client.post("/api/memory",json={
            "kind":"document","name":"港口设定","board":"test","document":document,
        })
        self.assertEqual(saved.status,200,await saved.text())
        result = await (await self.client.get("/api/memory",params={"board":"test","q":"吊车"})).json()
        self.assertTrue(result[0]["document_match"])
        self.assertLessEqual(len(result[0]["document"]["excerpt"]),350)
        self.assertNotIn("text",result[0]["document"])
        seen = []
        async def submit(req,payload):
            seen.append(payload)
            return web.json_response({"ids":[]})
        with patch.object(server,"_generate_request",submit):
            generated = await self.client.post("/api/generate",json={"kind":"image","board":"test","prompt":"@港口设定 拍吊车","images":[]})
            self.assertEqual(generated.status,200,await generated.text())
        self.assertIn("蓝色灯从左侧照亮吊车",seen[0]["prompt"])
        self.assertLess(len(seen[0]["prompt"]),2500)
        self.assertEqual(seen[0]["images"],[])

    async def test_docx_and_pdf_extract_text_without_rendering_active_content(self):
        word = io.BytesIO()
        with ZipFile(word,"w") as archive:
            archive.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>灯从左侧来</w:t></w:r></w:p></w:body></w:document>')
        response = await self.import_document("布光.docx",word.getvalue())
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["text"],"灯从左侧来")
        self.assertEqual((await self.import_document("空.txt",b" \n")).status,400)

        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=612,height=792)
        font = DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):font})})
        content = DecodedStreamObject()
        content.set_data(b"BT /F1 18 Tf 40 700 Td (Scene notes) Tj ET")
        page[NameObject("/Contents")] = content
        pdf = io.BytesIO()
        writer.write(pdf)
        response = await self.import_document("镜头.pdf",pdf.getvalue())
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["text"],"Scene notes")

    async def test_asset_folders_organize_shared_assets_privately(self):
        asset = await self.create(board="",shared=True)
        await self.client.put("/api/board/test",json={**self.load(),"shared":True})
        guest = {"X-Uid":"8"}
        response = await self.client.post("/api/asset-folders",headers=guest,json={"name":"镜头准备"})
        self.assertEqual(response.status,201,await response.text())
        folder = (await response.json())["id"]
        body = {"board":"test","assets":[asset["id"]],"folder":folder}
        self.assertEqual((await self.client.post("/api/asset-folders/members",json=body)).status,404)
        self.assertEqual((await self.client.post("/api/asset-folders/members",headers=guest,json=body)).status,200)
        self.assertEqual(await (await self.client.get("/api/asset-folders")).json(),[])
        self.assertIsNone((await (await self.client.get("/api/memory?board=test")).json())[0]["folder_id"])
        self.assertEqual((await (await self.client.get("/api/memory?board=test",headers=guest)).json())[0]["folder_id"],folder)
        self.assertEqual((await self.client.patch("/api/asset-folders/"+folder,headers=guest,json={"name":"定稿"})).status,200)
        self.assertEqual((await self.client.delete("/api/asset-folders/"+folder,headers=guest)).status,200)
        remaining = (await (await self.client.get("/api/memory?board=test",headers=guest)).json())[0]
        self.assertEqual(remaining["id"],asset["id"])
        self.assertIsNone(remaining["folder_id"])

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

    async def test_project_assets_are_reused_only_in_member_canvases(self):
        created = await self.client.post("/api/canvas-projects", json={"name":"短片", "board":"test"})
        self.assertEqual(created.status, 201, await created.text())
        project = (await created.json())["id"]
        sibling = await self.client.put("/api/board/shots", params={"project":project}, json={"nodes":[], "shared":True})
        self.assertEqual(sibling.status, 200, await sibling.text())
        await self.client.put("/api/board/standalone", json={"nodes":[]})
        asset = await self.create(board="", project=project)
        private = await self.create(name="仅限这张画布")
        matching = await (await self.client.get("/api/memory", params={"board":"shots"})).json()
        self.assertEqual({a["id"] for a in matching}, {asset["id"],private["id"]})
        linked = await self.client.get(f"/api/memory/{private['id']}?board=shots")
        self.assertEqual(linked.status,200,await linked.text())
        self.assertNotEqual(asset["id"], private["id"])
        seen = []

        async def submit(req, payload):
            seen.append(payload)
            return web.json_response({"ids":[]})

        with patch.object(server, "_generate_request", submit):
            response = await self.client.post("/api/generate", json={"kind":"image","board":"shots","prompt":"@林森 在巷口等车","images":[]})
            self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(seen[0]["images"][0]["ref"], asset["ref"])
        self.assertEqual((await self.client.get("/api/memory", params={"board":"standalone"})).status, 200)
        self.assertEqual(await (await self.client.get("/api/memory?board=standalone")).json(), [])
        guest = {"X-Uid":"8"}
        self.assertEqual(await (await self.client.get("/api/memory?board=shots", headers=guest)).json(), [])
        self.assertEqual((await self.client.get("/api/memory/"+asset["id"], headers=guest)).status, 404)
        denied = await self.client.post("/api/memory", json={"name":"越权", "project":project, "kind":"document"}, headers=guest)
        self.assertEqual(denied.status, 403)

        self.assertEqual((await self.client.post("/api/board/shots/project", json={"project":None})).status, 200)
        self.assertEqual(await (await self.client.get("/api/memory?board=shots")).json(), [])
        self.assertEqual((await self.client.delete("/api/canvas-projects/"+project)).status, 200)
        matching = await (await self.client.get("/api/memory?board=shots")).json()
        self.assertEqual([(a["id"],a["project"],a["shared"],a["ref"]) for a in matching], [(asset["id"],"",False,asset["ref"])])

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
        with patch.object(st,"historical_references",return_value={a["id"]:[(None,ref) for ref in refs]}), \
                patch.object(server,"require_media"):
            replay = st.prepare(user,model_payload,replay_ref=frame)
        self.assertEqual([entry["ref"] for entry in replay["images"]],[frame,*refs])

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
        with patch.object(server,'_generate_request',submit):
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
        with patch.object(server,"_generate_request",submit):
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
        selected = {"kind":"video","board":"test","prompt":"@林森 回头","duration":5,
                    "images":[{"ref":third, "node_id":"n1"}],
                    "memory_views":[{"memory_id":asset["id"],"views":["main","face"]}]}
        payload = self.app["creative_memory"].prepare({"id":7,"role":"member"}, selected)
        self.assertEqual([(item["ref"],item["role"],item.get("memory_view")) for item in payload["images"]],
                         [(third,"frame",None),(other,"subject","main"),(source,"subject","face")])
        body, _ = server.engine_body(payload)
        self.assertEqual(len(body["keyframes"]),1)
        self.assertEqual(body["references"],[str(server.tools.ref_path(server.COMFY_DIR,ref)) for ref in (other,source)])
        face_token = "@{"+asset["id"]+"#face|同名素材}"
        handwritten = await self.client.post("/api/generate",json={"kind":"image","board":"test","prompt":"@林森#face"})
        self.assertEqual(handwritten.status,400,await handwritten.text())
        self.assertIn("选择已定稿视角",(await handwritten.json())["error"])
        with patch.object(server,"_generate_request",return_value=web.json_response({"ids":[]})):
            manual = await self.client.post("/api/generate",json={
                "kind":"video","board":"test","prompt":"慢慢回头","fields":{"people":face_token}})
        self.assertEqual(manual.status,200,await manual.text())
        applied = await manual.json()
        self.assertEqual(applied["memory_used"][0]["references"],[{"view":"face","ref":source}])
        self.assertEqual(applied["memory_context"]["memory_views"],[{"memory_id":asset["id"],"views":["face"]}])
        self.assertIn("林森",applied["memory_context"]["prompt"])
        self.assertNotIn("同名素材",applied["memory_context"]["prompt"])
        response = await update(third, "main")
        result = await response.json()
        self.assertEqual(result["character_views"], {"main": third})
        self.assertEqual(len(result["media"]), 3)
        stale = await self.client.post("/api/generate",json=selected)
        self.assertEqual(stale.status,400,await stale.text())
        self.assertIn("正面头肩尚未定稿",(await stale.json())["error"])

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

    async def test_character_result_is_visible_in_asset_library_after_job_recovery(self):
        asset = await self.create()
        result = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "green"))["ref"]
        job_id = "character-test"
        async def submit(req, payload):
            from db import task_start, task_update
            task_start(id=job_id, user_id=7, board_id="test", capability="image")
            task_update(job_id, state="done", outputs=[result])
            server.JOBS[job_id] = {"id": job_id, "state": "done", "outputs": [{"ref": result}]}
            return web.json_response({"ids": [job_id]})

        with patch.object(server, "_generate_request", submit):
            response = await self.client.post("/api/generate", json={
                "kind": "image", "board": "test", "prompt": "按 @图1 生成角色主图",
                "images": [{"ref": asset["ref"]}], "character_draft": {"asset": asset["id"], "slot": "main"}
            })
        self.assertEqual(response.status, 200, await response.text())
        server.JOBS.pop(job_id)
        listing = await (await self.client.get("/api/memory?board=test")).json()
        self.assertEqual(listing[0]["character_drafts"]["main"]["ref"], result)
        self.assertEqual(listing[0]["default_ref"], asset["ref"])
        detail = await (await self.client.get("/api/memory/" + asset["id"] + "?board=test")).json()
        self.assertEqual(detail["history"][0]["ref"], result)
        response = await self.client.post("/api/memory", json={
            "id": asset["id"], "character_view": "main", "ref": result, "source_board": "test"
        })
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["default_ref"], result)
