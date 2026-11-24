import asyncio
import base64
import io
import json
import time
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from oneshot.assistant import agent_chat as chat
from oneshot.web import auth
from oneshot.storage import db
from oneshot.editing import image_editor
from oneshot.integrations import mcp_bridge
import server
from test_agent_chat import ChatFixture


class ConnectorIntegration(ChatFixture):
    async def test_streamable_connector_only_acts_on_owned_canvas_after_user_confirmation(self):
        app = web.Application(middlewares=[auth.middleware])
        app["http"] = self.http
        chat.install(app,server)
        mcp_bridge.install(app,server.ROOT)
        db.run("UPDATE users SET role='admin' WHERE id=7")
        for uid in (7,8):
            db.run("INSERT INTO sessions VALUES(?,?,?,?)",f"connector-{uid}",uid,time.time(),time.time()+600)
        owner, other = ({"Cookie":f"{auth.COOKIE}=connector-{uid}"} for uid in (7,8))
        server.board_path("other").write_text(json.dumps({**self.board,"name":"Other","owner":8,"shared":True}))
        db.run("INSERT INTO asset_folders VALUES('qa-folder',7,'QA')")
        async with TestClient(TestServer(app)) as client:
            tokens = "/api/connector/tokens"
            self.assertEqual((await client.post(tokens,headers={**owner,"Origin":"https://other.invalid"},
                json={"label":"外部助手"})).status,403)
            created = await client.post(tokens,headers=owner,json={"label":"外部助手"})
            self.assertEqual(created.status,201,await created.text())
            key = await created.json()
            self.assertNotIn(key["token"],db.one("SELECT digest FROM connector_tokens")["digest"])
            self.assertNotIn(key["token"],await (await client.get(tokens,headers=owner)).text())
            self.assertEqual(await (await client.get(tokens,headers=other)).json(),[])
            bearer = {"Authorization":"Bearer "+key["token"],"Accept":"application/json, text/event-stream"}
            async def rpc(method, params, headers=bearer, *, notification=False):
                message = {"jsonrpc":"2.0","method":method,"params":params}
                if not notification:
                    message["id"] = 1
                return await client.post("/mcp",headers=headers,json=message)
            async def use(name,args):
                return (await (await rpc("tools/call",{"name":name,"arguments":args})).json())["result"]
            init = await (await rpc("initialize",{"protocolVersion":"2025-11-25"})).json()
            self.assertEqual(init["result"]["protocolVersion"],"2025-11-25")
            self.assertEqual((await rpc("notifications/initialized",{},notification=True)).status,202)
            self.assertEqual((await client.get("/mcp",headers=bearer)).status,405)
            self.assertEqual((await rpc("tools/list",{},headers=owner)).status,401)
            self.assertEqual((await rpc("tools/list",{},headers={**bearer,"Origin":"https://other.invalid"})).status,403)
            self.assertEqual((await client.get(tokens,headers=bearer)).status,401)
            tools = (await (await rpc("tools/list",{})).json())["result"]["tools"]
            self.assertIn("request_video",{tool["name"] for tool in tools})
            self.assertEqual([item["id"] for item in (await use("list_canvases",{}))["structuredContent"]["canvases"]],["test"])
            self.assertTrue((await use("get_canvas",{"board":"other"}))["isError"])
            self.assertTrue((await use("request_image",{"board":"other","prompt":"not owned","request_key":"wrong-board-key"}))["isError"])

            asset_args = {"board":"test","node_id":"n1","version":1,"folder_id":"qa-folder","request_key":"asset-test-key"}
            asset = (await use("save_canvas_asset",asset_args))["structuredContent"]["asset_ids"][0]
            self.assertEqual((await use("save_canvas_asset",asset_args))["structuredContent"]["asset_ids"],[asset])
            results = (await use("search_assets",{"board":"test","folder_id":"qa-folder","query":"产品"}))["structuredContent"]
            self.assertEqual([item["id"] for item in results["assets"]],[asset])
            self.assertEqual(results["folders"],[{"id":"qa-folder","name":"QA"}])
            preview = await use("preview_asset",{"asset_id":asset,"board":"test","max_side":128})
            self.assertEqual(preview["structuredContent"]["frames"],[{"width":128,"height":96}])
            jpeg = preview["content"][1]
            self.assertEqual((jpeg["type"],jpeg["mimeType"]),("image","image/jpeg"))
            self.assertEqual(Image.open(io.BytesIO(base64.b64decode(jpeg["data"]))).size,(128,96))
            denied = await use("preview_canvas_media",{"board":"other","node_id":"n1","version":1})
            self.assertTrue(denied["isError"])
            self.assertNotIn("image",[part["type"] for part in denied["content"]])
            path,ref = server.film._new(server.COMFY_DIR,"input","connector",".mp4")
            server.film.encode_silent(path,(Image.new("RGB",(64,64),"red" if i<6 else "blue") for i in range(12)),
                                      64,64,24,lambda:False,lambda _:None)
            board = self.load()
            board["nodes"].append({"id":"n3","name":"短片","type":"video","versions":[{"ref":ref}],"cur":0})
            server.board_path("test").write_text(json.dumps(board))
            clip = {"board":"test","node_id":"n3","version":1}
            images = await use("preview_canvas_media",{**clip,"times":[0,.33]})
            self.assertEqual(images["structuredContent"]["media_type"],"video")
            frames = [Image.open(io.BytesIO(base64.b64decode(part["data"]))).getpixel((30,30))
                      for part in images["content"] if part["type"]=="image"]
            self.assertEqual(len(frames),2)
            self.assertGreater(frames[0][0],frames[0][2])
            self.assertGreater(frames[1][2],frames[1][0])
            self.assertTrue((await use("preview_canvas_media",{**clip,"times":[2]}))["isError"])

            resize = {"board":"test","node_id":"n1","version":1,"request_key":"resize-fixture-key",
                      "resize":{"width":160,"height":160,"fit":"contain"}}
            scaled = (await use("resize_canvas_image",resize))["structuredContent"]
            await self.wait(scaled["task_id"],"done")
            resized = (await use("get_generation",{"task_id":scaled["task_id"]}))["structuredContent"]
            node = resized["nodes"][0]
            self.assertEqual((node["id"],node["version"],node["width"],node["height"]),("n1",2,160,160))
            versions = self.load()["nodes"][0]["versions"]
            self.assertEqual(len(versions),2)
            self.assertEqual(versions[0]["ref"],self.source["ref"])
            self.assertEqual(versions[1]["edit"]["resize"]["fit"],"contain")
            self.assertEqual(image_editor.load(server.COMFY_DIR,versions[1]["ref"]).getpixel((0,0))[3],0)
            self.assertEqual((await use("resize_canvas_image",resize))["structuredContent"]["task_id"],scaled["task_id"])
            self.assertTrue((await use("resize_canvas_image",{**resize,"version":2}))["isError"])

            result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))
            async def generate(req, payload):
                self.assertTrue(req["connector_own_assets"])
                self.assertEqual(req["user"]["role"],"member")
                self.assertEqual(payload["memory_ids"],[asset])
                jid = "e000000111001"
                server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]}
                return web.json_response({"ids":[jid]})

            app["agent_chat"].model = AsyncMock(side_effect=AssertionError("MCP uses the external client's planning"))
            settings = {"board":"test","prompt":"生成外部海报","reference_ids":["n1"],"asset_ids":[asset],"request_key":"generate-test-key"}
            with patch.object(server,"generate_request",side_effect=generate) as submission:
                data = (await use("request_image",settings))["structuredContent"]
                rid = data["task_id"]
                self.assertIn("session=",data["canvas_url"])
                await self.wait(rid,"waiting_approval")
                submission.assert_not_awaited()
                self.assertEqual((await use("request_image",settings))["structuredContent"]["task_id"],rid)
                self.assertTrue((await use("request_image",{**settings,"prompt":"不一样"}))["isError"])
                aid = db.one("SELECT a.id FROM chat_approvals a JOIN chat_calls c ON c.id=a.call_id WHERE c.run_id=?",rid)["id"]
                confirm = f"/api/chat/runs/{rid}/approvals/{aid}"
                self.assertEqual((await client.post(confirm,headers=bearer,json={"decision":"approve"})).status,401)
                self.assertEqual((await client.post(confirm,headers=other,json={"decision":"approve"})).status,404)
                self.assertEqual((await client.post(confirm,headers=owner,json={"decision":"approve"})).status,200)
                await self.wait(rid,"done")
                status = (await use("get_generation",{"task_id":rid}))["structuredContent"]
                self.assertEqual(status["state"],"done")
                self.assertIn(status["nodes"][0]["id"],[node["id"] for node in self.load()["nodes"]])
                submission.assert_awaited_once()
                async def set_image(req,payload):
                    index = ["白底","场景","细节"].index(payload["label"])
                    self.assertEqual(payload["count"],1)
                    self.assertIn("暖色背景",payload["prompt"])
                    self.assertEqual(payload["images"][0]["node_id"],"n1")
                    self.assertTrue(req["connector_own_assets"])
                    jid = "e00000011200"+str(index)
                    server.JOBS[jid] = {"state":"error" if index==1 else "done","created":1,"meta":{"uid":7},
                                        "error":"场景失败" if index==1 else None,
                                        "outputs":[] if index==1 else [{**result,"meta":{"width":128,"height":96}}]}
                    return web.json_response({"ids":[jid]})
                with patch.object(server,"generate_request",side_effect=set_image) as make_set:
                    plan = {"board":"test","request_key":"image-set-test-key","name":"商品图套组","style":"暖色背景",
                            "reference_ids":["n1"],"items":[{"name":"白底","prompt":"红色商品白色衬底","aspect":"1:1"},
                            {"name":"场景","prompt":"放在桌面上","aspect":"16:9"},{"name":"细节","prompt":"拍摄边沿"}]}
                    task = (await use("request_image_set",plan))["structuredContent"]
                    set_id = task["task_id"]
                    await self.wait(set_id,"waiting_approval")
                    make_set.assert_not_awaited()
                    approval = db.one("SELECT a.id,a.plan FROM chat_approvals a JOIN chat_calls c ON c.id=a.call_id WHERE c.run_id=?",set_id)
                    shown = json.loads(approval["plan"])
                    self.assertEqual([item["name"] for item in shown["items"]],["白底","场景","细节"])
                    self.assertEqual(shown["count"],3)
                    self.assertEqual((await client.post(f"/api/chat/runs/{set_id}/approvals/{approval['id']}",
                                      headers=owner,json={"decision":"approve"})).status,200)
                    await self.wait(set_id,"done")
                    receipt = (await use("get_generation",{"task_id":set_id}))["structuredContent"]
                    self.assertEqual([item["state"] for item in receipt["batch"]],["done","error","done"])
                    self.assertEqual([item["name"] for item in receipt["nodes"]],["白底","细节"])
                    self.assertEqual([item.args[1]["ar"] for item in make_set.await_args_list], [1,16/9,1])
                    self.assertEqual((await use("request_image_set",plan))["structuredContent"]["task_id"],set_id)
                    self.assertEqual(make_set.await_count,3)
                next_result = (await use("request_image",{**settings,"request_key":"generate-revoke-key"}))["structuredContent"]
                await self.wait(next_result["task_id"],"waiting_approval")
                self.assertEqual((await client.delete(tokens+"/"+key["id"],headers=other)).status,200)
                self.assertEqual((await rpc("tools/list",{})).status,200)
                self.assertEqual((await client.delete(tokens+"/"+key["id"],headers=owner)).status,200)
                self.assertEqual((await rpc("tools/list",{})).status,401)
                await self.wait(next_result["task_id"],"error")
                submission.assert_awaited_once()

    async def wait(self, rid, expected):
        async with asyncio.timeout(5):
            while True:
                state = db.one("SELECT state,error FROM chat_runs WHERE id=?",rid)
                if state["state"]==expected:
                    return
                if state["state"] in chat.TERMINAL:
                    self.fail(f"expected {expected}: {state}")
                await asyncio.sleep(.01)
