import json
import time

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from oneshot.web import auth
from oneshot.storage import db
from oneshot.editing import image_editor
import server
from oneshot.canvas import shared_canvas_items
from test_agent_chat import ChatFixture


class SharedCanvasItems(ChatFixture):
    async def test_version_and_reviewed_transcript_are_frozen_and_revocable(self):
        app = web.Application(middlewares=[auth.middleware])
        app.add_routes(server.routes)
        shared_canvas_items.install(app,server)
        db.run("UPDATE users SET role='admin' WHERE id=8")
        for uid in (7,8):
            db.run("INSERT INTO sessions VALUES(?,?,?,?)",f"shared-item-{uid}",uid,time.time(),time.time()+600)
        owner,other = ({"Cookie":f"{auth.COOKIE}=shared-item-{uid}"} for uid in (7,8))
        backup = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))
        board = self.load()
        board["nodes"][0]["versions"].append(backup)
        server.board_path("test").write_text(json.dumps(board))
        self.svc.emit(self.sid,None,"user",{"text":"公开的提问","documents":[{"name":"private.pdf","text":"内部附件"}]})
        self.svc.emit(self.sid,None,"assistant",{"text":"**公开的回答**"})
        self.svc.emit(self.sid,None,"tool_end",{"result":{"internal":"隐藏执行记录"}})
        db.run("INSERT INTO chat_sessions VALUES(?,?,?,?,?,?)","someone-else",8,"test","其他成员的消息",time.time(),time.time())
        url = "/api/board/test/shared-items"
        source = {"kind":"media","node":"n1","ref":self.source["ref"],"version":1}
        async with TestClient(TestServer(app)) as client:
            self.assertEqual((await client.get(url,headers=other)).status,403)
            self.assertEqual((await client.post(url+"/preview",headers=owner,json={
                "source":{"kind":"conversation","session":"someone-else"}})).status,404)
            media_preview = await (await client.post(url+"/preview",headers=owner,json={"source":source})).json()
            self.assertEqual(media_preview["version"],1)
            self.assertEqual((await client.post(url,headers=owner,json={
                "source":source,"digest":media_preview["digest"]})).status,400)
            async def publish(source,review):
                return await client.post(url,headers=owner,json={"confirmed":True,"source":source,"digest":review["digest"]})
            media_share = await publish(source,media_preview)
            self.assertEqual(media_share.status,201,await media_share.text())
            token = (await media_share.json())["token"]
            self.assertEqual((await (await publish(source,media_preview)).json())["token"],token)
            board["nodes"][0]["cur"] = 1
            server.board_path("test").write_text(json.dumps(board))
            public = "/api/shared-item/"+token
            info = await (await client.get(public)).json()
            self.assertEqual(set(info),{"kind","title","media_type","version","media_url","created"})
            self.assertEqual((await client.get("/shared-item/"+token)).status,200)
            file = await client.get(info["media_url"])
            self.assertEqual(file.status,200)
            self.assertEqual(await file.read(),server.tools.ref_path(server.COMFY_DIR,self.source["ref"]).read_bytes())
            self.assertEqual((await client.get("/media",params={"ref":backup["ref"]})).status,401)

            source = {"kind":"conversation","session":self.sid}
            review = await (await client.post(url+"/preview",headers=owner,json={"source":source})).json()
            self.svc.emit(self.sid,None,"assistant",{"text":"再次检查"})
            self.assertEqual((await publish(source,review)).status,409)
            new_review = await (await client.post(url+"/preview",headers=owner,json={"source":source})).json()
            published = await publish(source,new_review)
            self.assertEqual(published.status,201)
            chat_token = (await published.json())["token"]
            self.svc.emit(self.sid,None,"user",{"text":"之后写的私密消息"})
            address = "/api/shared-item/"+chat_token
            data = await (await client.get(address)).json()
            self.assertEqual([item["text"] for item in data["messages"]],["公开的提问","**公开的回答**","再次检查"])
            self.assertNotIn("internal",json.dumps(data))
            self.assertNotIn("private.pdf",json.dumps(data))
            self.assertEqual((await client.get(address+"/media")).status,404)
            self.assertEqual((await client.delete(url+"/"+token,headers=owner)).status,200)
            self.assertEqual((await client.get(public+"/media")).status,404)
            self.assertEqual((await client.delete("/api/board/test",headers=owner)).status,200)
            self.assertEqual((await client.get(address)).status,404)
