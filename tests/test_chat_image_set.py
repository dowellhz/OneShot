"""Assistant image-set generation, recovery, and retry."""

from unittest.mock import patch
import asyncio
import copy
import json

from PIL import Image
from aiohttp import web

from oneshot.assistant import agent_chat as chat
from oneshot.editing import image_editor
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatImageSet(ChatFixture):
    async def test_image_set_recovers_known_jobs_without_issuing_the_unconfirmed_submission_again(self):
        plan = {"name":"插图","items":[{"name":"首页","prompt":"简洁封面","aspect":"16:9"},
                 {"name":"正文","prompt":"桌上的文档"},{"name":"收尾","prompt":"夕阳中的桌子"}]}
        self.svc.model.side_effect = [call("image_generate_set",plan),answer()]
        paused = asyncio.Event()
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"yellow"))

        async def generate(req,payload):
            if payload["label"]!="首页":
                paused.set()
                await asyncio.Future()
            jid = "e000000115001"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            rid = await self.send()
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["count"],3)
            submit.assert_not_awaited()
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            await asyncio.wait_for(paused.wait(),3)
            self.svc.closing = True
            worker = self.svc.tasks[rid]
            worker.cancel()
            await asyncio.gather(worker,return_exceptions=True)
            self.svc.closing = False
            await self.svc.work(rid)
            self.assertEqual((await self.wait(rid))["state"],"done")
            self.assertEqual(submit.await_count,2)
        saved = db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)
        value = json.loads(saved["result"])
        self.assertEqual([entry["state"] for entry in value["batch"]],["done","uncertain","unsubmitted"])
        self.assertEqual([node["name"] for node in value["nodes"]],["首页"])
        self.assertEqual([node["name"] for node in self.load()["nodes"] if node["id"].startswith("a")],["首页"])

    async def test_image_set_retries_only_confirmed_failures_with_original_asset_versions(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        asset = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                               "source_board":"test","character_view":"main"})
        plan = {"items":[{"name":"成功图","prompt":"场景全景"},{"name":"失败图","prompt":"拍摄 @林森"},
                         {"name":"取消图","prompt":"留白"}]}
        self.svc.model.side_effect = [call("image_generate_set",plan),answer()]
        requests = []

        async def submit(req,payload,*,fixed_route=None):
            requests.append((copy.deepcopy(payload),fixed_route))
            req["generation_route"] = {"provider":None,"model":None}
            jid = f"e{len(requests):012x}"
            state,error = {2:("error","服务生成失败"),3:("error","已取消")}.get(len(requests),("done",None))
            db.task_start(id=jid,user_id=7,board_id="test",capability="image",state=state)
            outputs = [image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),(0,0,len(requests))))] if state=="done" else []
            server.JOBS[jid] = {"state":state,"created":1,"meta":{"uid":7},"outputs":outputs,"error":error}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"_generate_request",side_effect=submit):
            rid = await self.send("生成三张套图")
            approval = await self.pending_generation(rid)
            await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual((await self.wait(rid))["state"],"done")
            session_url = f"/api/chat/sessions/{self.sid}"
            session = await (await self.client.get(session_url)).json()
            failed = next(event["data"] for event in session["events"] if event["run_id"]==rid and event["kind"]=="tool_end")
            self.assertEqual(failed["retry_count"],1)
            self.assertEqual([row["state"] for row in failed["result"]["batch"]],["done","error","error"])
            retry_url = f"{session_url}/calls/{failed['call_id']}/retry"
            fresh = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"purple"),"input")
            b = self.load()
            b["nodes"][0]["versions"].append(fresh)
            server.write_board(server.board_path("test"),b)
            store.put(user,{"id":asset["id"],"ref":fresh["ref"],"source_board":"test","character_view":"main"})
            responses = await asyncio.gather(self.client.post(retry_url,json={}),self.client.post(retry_url,json={}))
            self.assertEqual([response.status for response in responses],[200,200])
            retries = [(await response.json())["id"] for response in responses]
            self.assertEqual(retries[0],retries[1])
            self.assertEqual((await self.wait(retries[0]))["state"],"done")
        self.assertEqual(len(requests),4)
        self.assertEqual(requests[-1],(requests[1][0],{"provider":None,"model":None}))
        self.assertEqual(requests[-1][0]["images"][0]["ref"],self.source["ref"])
        self.assertEqual([node["name"] for node in self.load()["nodes"] if node["versions"] and node["id"]!="n1"],
                         ["成功图","失败图"])

    async def test_image_set_retry_recovers_known_jobs_without_resubmitting_after_restart(self):
        plan = {"items":[{"name":"图一","prompt":"景别一"},{"name":"图二","prompt":"景别二"}]}
        self.svc.model.side_effect = [call("image_generate_set",plan),answer()]
        stalled = asyncio.Event()
        calls = []

        async def submit(req,payload,*,fixed_route=None):
            calls.append((payload["label"],fixed_route))
            req["generation_route"] = {"provider":None,"model":None}
            phase = len(calls)
            if phase==4:
                stalled.set()
                await asyncio.Future()
            jid = f"e{phase:012x}"
            state = "error" if phase<3 else "done"
            outputs = [image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))] if phase==3 else []
            db.task_start(id=jid,user_id=7,board_id="test",capability="image",state=state)
            server.JOBS[jid] = {"state":state,"created":1,"meta":{"uid":7},"outputs":outputs}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"_generate_request",side_effect=submit):
            rid = await self.send("做两张套图")
            approval = await self.pending_generation(rid)
            await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            await self.wait(rid)
            original = db.one("SELECT id FROM chat_calls WHERE run_id=?",rid)
            url = f"/api/chat/sessions/{self.sid}/calls/{original['id']}/retry"
            response = await self.client.post(url,json={})
            self.assertEqual(response.status,200,await response.text())
            retry = (await response.json())["id"]
            await asyncio.wait_for(stalled.wait(),3)
            self.svc.closing = True
            worker = self.svc.tasks[retry]
            worker.cancel()
            await asyncio.gather(worker,return_exceptions=True)
            self.svc.closing = False
            await self.svc.work(retry)
            self.assertEqual((await self.wait(retry))["state"],"done")
        self.assertEqual([name for name,_ in calls],["图一","图二","图一","图二"])
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",retry)["result"])
        self.assertEqual([row["state"] for row in result["batch"]],["done","uncertain"])
        self.assertEqual([node["name"] for node in result["nodes"]],["图一"])

    async def test_image_set_previews_each_asset_selection_and_rechecks_it_before_submission(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        face = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"cyan"))
        b = self.load()
        b["nodes"][0]["versions"].append(face)
        server.write_board(server.board_path("test"),b)
        hero = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                              "source_board":"test","character_view":"main"})
        store.put(user,{"id":hero["id"],"ref":face["ref"],"source_board":"test","character_view":"face"})
        station = store.put(user,{"board":"test","kind":"scene","name":"车站","desc":"窗外有雨"})
        plan = {"name":"双镜头套图","reference_ids":["n1"],"items":[
            {"name":"远景","prompt":"拍摄站台","memory_views":[{"memory_id":hero["id"],"views":["main"]}]},
            {"name":"特写","prompt":"拍摄脸部","memory_ids":[],"memory_views":[{"memory_id":hero["id"],"views":["face"]}]},
        ]}
        seen = []

        async def submit(_req,payload):
            seen.append(payload)
            jid = f"e{len(seen):012x}"
            output = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),(10,len(seen),0)))
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[output]}
            return web.json_response({"ids":[jid]})

        async def review(key, change=False):
            self.svc.model.side_effect = [call("memory_use",{"memory_ids":[station["id"]]},"station"),
                                          call("image_generate_set",plan,"set"),answer()]
            rid = await self.send(text="用 @林森 生成两张图",key=key)
            approval = await self.pending_generation(rid)
            self.assertEqual([item["assets"] for item in approval["plan"]["items"]],
                             [["林森（标准主图）","车站"],["林森（正面头肩）"]])
            self.assertEqual(approval["plan"]["asset_count"],2)
            if change:
                store.put(user,{"id":station["id"],"desc":"修改为晴天"})
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            call_row = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='image_generate_set'",rid)
            return json.loads(call_row["result"])

        with patch.object(generation_requests,"_generate_request",submit):
            stale = await review("stale-set-assets",change=True)
            self.assertIn("参考资产已更新",stale["error"])
            self.assertEqual(seen,[])
            finished = await review("fresh-set-assets")
        self.assertEqual([item["state"] for item in finished["batch"]],["done","done"])
        self.assertEqual([[asset["id"] for asset in payload["memory_used"]] for payload in seen],
                         [[hero["id"],station["id"]],[hero["id"]]])
        self.assertEqual([payload["memory_used"][0]["references"][0]["ref"] for payload in seen],
                         [self.source["ref"],face["ref"]])
        self.assertTrue(all(payload["images"][0]["node_id"]=="n1" for payload in seen))

    async def test_retry_failed_batch_uses_pinned_submission_once(self):
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        self.svc.model.side_effect = [call("image_generate",{
            "prompt":"海报初稿","count":2,"reference_ids":["n1"]}),answer()]
        first = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))
        second = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"green"))
        newer_source = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"yellow"),"input")
        requests = []

        async def generate(req, payload, *, fixed_route=None):
            requests.append((copy.deepcopy(payload),fixed_route))
            req["generation_route"] = {"provider":None,"model":None}
            batch = [(first,"done"),(None,"error")] if len(requests) == 1 else [(second,"done")]
            ids = []
            for index,(result,state) in enumerate(batch):
                jid = f"retry-{len(requests)}-{index}"
                db.task_start(id=jid,user_id=7,board_id="test",capability="image",state=state)
                server.JOBS[jid] = {"state":state,"created":1,"meta":{"uid":7},
                                   "outputs":[result] if result else [],"error":None if result else "生成失败"}
                ids.append(jid)
            return web.json_response({"ids":ids})

        with patch.object(generation_requests,"_generate_request", side_effect=generate):
            response = await self.client.post(endpoint,json={
                "text":"生成海报","request_key":"retry-batch","generation_mode":"manual","selected":["n1"]})
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={
                "decision":"adjust","parameters":{"prompt":"最终确认的海报提示词"}})
            approval = await self.pending_generation(rid)
            await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            run = await self.wait(rid)
            self.assertEqual(run["state"],"done",(run["error"],db.q("SELECT name,state,result FROM chat_calls WHERE run_id=?",rid)))
            session = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            failed = next(e["data"] for e in session["events"] if e["run_id"] == rid and e["kind"] == "tool_end")
            self.assertEqual(failed["retry_count"],1)
            self.assertEqual(len(failed["result"]["nodes"]),1)
            cid = failed["call_id"]
            url = f"/api/chat/sessions/{self.sid}/calls/{cid}/retry"
            self.assertEqual((await self.client.post(url,headers={"X-Uid":"8"},json={})).status,404)

            board = self.load()
            source_path = server.tools.ref_path(server.COMFY_DIR,self.source["ref"])
            original_bytes = source_path.read_bytes()
            source_path.unlink()
            self.assertEqual((await self.client.post(url,json={})).status,409)
            source_path.write_bytes(original_bytes)
            board["nodes"][0]["versions"] = [self.source,newer_source]
            board["nodes"][0]["cur"] = 1
            server.board_path("test").write_text(chat.dumps(board))

            retries = await asyncio.gather(self.client.post(url,json={}),self.client.post(url,json={}))
            self.assertEqual([r.status for r in retries],[200,200])
            ids = [(await r.json())["id"] for r in retries]
            self.assertEqual(ids[0],ids[1])
            self.assertEqual((await self.wait(ids[0]))["state"],"done")
            self.assertEqual(len(requests),2)
            self.assertEqual(requests[1],({**requests[0][0],"count":1},{"provider":None,"model":None}))
            self.assertEqual(requests[1][0]["images"][0]["ref"],self.source["ref"])
            self.assertEqual(requests[1][0]["prompt"],"最终确认的海报提示词")
            self.assertEqual(self.svc.model.await_count,2)
            nodes = self.load()["nodes"]
            self.assertEqual(nodes[0]["cur"],1)
            self.assertEqual([n["versions"][0]["ref"] for n in nodes[2:]],[first["ref"],second["ref"]])
            session = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            self.assertEqual([e["kind"] for e in session["events"] if e["run_id"] == ids[0]],
                             ["retry_queued","tool_start","submitted","progress","board","tool_end"])

    async def test_retry_preserves_a_multi_image_provider_batch_and_route(self):
        self.svc.model.side_effect = [call("image_generate",{"prompt":"一组海报","count":3}),answer()]
        first_provider = {"id":"original","kind":"mock","enabled":True}
        other_provider = {"id":"changed","kind":"mock","enabled":True}
        sent = []

        async def generate(req, payload, route, cap):
            sent.append((payload["count"],route["provider"]["id"],route["model"],cap))
            jid = f"provider-batch-{len(sent)}"
            db.task_start(id=jid,user_id=7,board_id="test",capability="image",state="error",error="生成失败")
            server.JOBS[jid] = {"state":"error","created":1,"meta":{"uid":7},"outputs":[],"error":"生成失败"}
            return web.json_response({"ids":[jid]})

        with (patch.object(remote_jobs,"generate_remote",side_effect=generate),
              patch.object(server.providers,"primary",side_effect=[
                  {"provider":first_provider,"model":"original-model"},{"provider":other_provider,"model":"changed-model"}]),
              patch.object(server.providers,"get",return_value=first_provider),
              patch.object(server.providers,"caps_of",return_value=["image"])):
            rid = await self.send()
            self.assertEqual((await self.wait(rid))["state"],"done")
            session = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            error = next(e["data"] for e in session["events"] if e["kind"] == "tool_end")
            self.assertEqual(error["retry_count"],3)
            url = f"/api/chat/sessions/{self.sid}/calls/{error['call_id']}/retry"
            response = await self.client.post(url,json={})
            self.assertEqual(response.status,200,await response.text())
            retry_id = (await response.json())["id"]
            self.assertEqual((await self.wait(retry_id))["state"],"error")
            self.assertEqual(sent,[(3,"original","original-model","image")]*2)
            session = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            retry_error = next(e["data"] for e in session["events"] if e["run_id"] == retry_id and e["kind"] == "tool_end")
            self.assertNotEqual(retry_error["call_id"],error["call_id"])
            self.assertEqual(retry_error["retry_count"],3)
