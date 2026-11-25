"""Creative memory scope, permissions, folders, and media imports."""

from unittest.mock import patch
from zipfile import ZipFile
import io
import json

from aiohttp import web

from oneshot import config
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from memory_fixture import MemoryFixture


class MemoryIntegration(MemoryFixture):
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
        with patch.object(generation_requests,"_generate_request",submit):
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
        with patch.object(config,"DATA_DIR",self.root):
            self.assertEqual((await self.client.get(root+"/download",headers=guest)).status,200)

        own_board = "/api/board/guest-board"
        self.assertEqual((await self.client.put(own_board,headers=guest,json={"name":"访客","nodes":[],"edges":[]})).status,200)
        self.assertEqual([a["id"] for a in await (await self.client.get("/api/memory?board=guest-board",headers=guest)).json()],[saved["id"]])
        seen = []
        async def submit(req,payload):
            seen.append(payload)
            return web.json_response({"ids":[]})
        with patch.object(generation_requests,"_generate_request",submit):
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
        with patch.object(generation_requests,"_generate_request",submit):
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
        with patch.object(config,"DATA_DIR",self.root):
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

        with patch.object(generation_requests, "_generate_request", submit):
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

    async def test_library_limits_and_search_are_applied_within_the_requested_scope(self):
        project = (await (await self.client.post("/api/canvas-projects",json={"name":"短片","board":"test"})).json())["id"]
        await self.client.put("/api/board/shots",params={"project":project},json={"nodes":[]})
        await self.client.put("/api/board/standalone",json={"nodes":[]})
        project_asset = await self.create(board="",project=project,name="项目剧本",kind="document",ref="")
        sibling_asset = await self.create(name="旧画布素材",ref="")
        db.run("""WITH RECURSIVE numbers(n) AS (
                    VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<305)
                  INSERT INTO creative_memories(id,owner,kind,name,data,updated)
                  SELECT 'personal-'||n,7,'document','个人剧本 '||n,'{}',?+n FROM numbers""",sibling_asset["mtime"])

        async def browse(board, **filters):
            reply = await self.client.get("/api/memory",params={"board":board,**filters})
            self.assertEqual(reply.status,200,await reply.text())
            return await reply.json()

        self.assertEqual(len(await browse("shots",scope="personal")),300)
        current = await browse("shots",scope="current")
        self.assertEqual({asset["id"] for asset in current},{project_asset["id"],sibling_asset["id"]})
        self.assertEqual([asset["id"] for asset in await browse("shots",scope="current",q="剧本")],[project_asset["id"]])
        self.assertEqual(await browse("standalone",scope="current"),[])

        # A tied timestamp must still paginate deterministically.
        db.run("UPDATE creative_memories SET updated=? WHERE id LIKE 'personal-%'",sibling_asset["mtime"]+1)
        page = await browse("shots",scope="personal",cursor="")
        ids = [asset["id"] for asset in page["items"]]
        self.assertEqual(len(ids),120)
        self.assertTrue(page["next_cursor"])
        db.run("""INSERT INTO creative_memories(id,owner,kind,name,data,updated)
                  VALUES('new-personal',7,'document','新剧本','{}',?)""",sibling_asset["mtime"]+2)
        for expected in (120,65):
            page = await browse("shots",scope="personal",cursor=page["next_cursor"])
            self.assertEqual(len(page["items"]),expected)
            ids.extend(asset["id"] for asset in page["items"])
        self.assertIsNone(page["next_cursor"])
        self.assertEqual(ids,sorted((f"personal-{i}" for i in range(1,306)),reverse=True))
        response = await self.client.get("/api/memory",params={"board":"shots","scope":"personal","cursor":"bad"})
        self.assertEqual(response.status,400)

    async def test_legacy_import_and_delete_never_resurrect(self):
        old={'id':'old1','owner':7,'name':'老角色','kind':'character','desc':'旧设定','ref':self.source['ref']}
        server.LIBRARY.write_text(json.dumps([old]))
        r=await self.client.get('/api/library');items=await r.json();self.assertEqual(items[0]['id'],'old1')
        self.assertEqual((await self.client.delete('/api/library/old1')).status,200)
        for _ in range(2):
            self.assertEqual(await (await self.client.get('/api/library')).json(),[])
        self.assertEqual(json.loads(server.LIBRARY.read_text()),[old])
