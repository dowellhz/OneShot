"""Assistant queue ordering, capacity, history, and write-target reservation."""

from unittest.mock import patch
import asyncio
import copy
import json
import time

from PIL import Image
from aiohttp import web

from oneshot.assistant import agent_chat as chat
from oneshot.editing import image_editor
from oneshot.editing import image_routes
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatQueue(ChatFixture):
    async def test_queued_chat_runs_in_order_and_pins_explicit_reference(self):
        started, release = asyncio.Event(), asyncio.Event()
        contexts = []
        async def model(messages, run):
            contexts.append((messages,copy.deepcopy(run["data"])))
            if len(contexts)==1:
                started.set()
                await release.wait()
            return answer("完成")
        self.svc.model.side_effect = model
        first = await self.send("第一条")
        await asyncio.wait_for(started.wait(),2)
        route = f"/api/chat/sessions/{self.sid}/messages"
        payload = {"text":"排队生成","request_key":"waiting-1","selected":["n1"],"enqueue":True}
        second = await (await self.client.post(route,json=payload)).json()
        self.assertEqual(second["state"],"queued")
        self.assertEqual(await (await self.client.post(route,json=payload)).json(),second)
        discarded = await (await self.client.post(route,json={**payload,"text":"移除这一条","request_key":"waiting-2"})).json()
        third = await (await self.client.post(route,json={**payload,"text":"最后一条","request_key":"waiting-3","selected":[]})).json()
        self.assertEqual((await self.client.post(route,json={**payload,"request_key":"legacy-1","enqueue":False})).status,409)
        session_url = f"/api/chat/sessions/{self.sid}"
        session = await (await self.client.get(session_url)).json()
        self.assertEqual([item["id"] for item in session["queue"]],[second["id"],discarded["id"],third["id"]])
        self.assertEqual([event["data"]["text"] for event in session["events"] if event["kind"]=="user"],["第一条"])
        directory = (await (await self.client.get("/api/chat/sessions?board=test")).json())["sessions"]
        self.assertEqual(directory[0]["active_task_text"],"第一条")
        self.assertEqual([(item["id"],item["text"],item["removable"]) for item in directory[0]["queued_tasks"]],
                         [(second["id"],"排队生成",1),(discarded["id"],"移除这一条",1),(third["id"],"最后一条",1)])
        delete = f"/api/chat/runs/{discarded['id']}/queue"
        self.assertEqual((await self.client.delete(delete,headers={"X-Uid":"8"})).status,404)
        self.assertEqual((await self.client.delete(delete)).status,200)
        directory = (await (await self.client.get("/api/chat/sessions?board=test")).json())["sessions"]
        self.assertEqual(directory[0]["active_task_text"],"第一条")
        self.assertEqual([item["id"] for item in directory[0]["queued_tasks"]],[second["id"],third["id"]])
        newest = image_editor.save(server.COMFY_DIR,Image.new("RGB",(48,64),"blue"),"input")
        board = self.load()
        board["nodes"][0]["versions"].append(newest)
        board["nodes"][0]["cur"] = 1
        board["nodes"].append({"id":"n3","type":"text","name":"上一轮的新素材","data":{"text":"追加资料"},"versions":[]})
        server.write_board(server.board_path("test"),board)
        db.run("UPDATE chat_runs SET created=? WHERE id=?",time.time()-chat.MAX_RUN_SECONDS-10,third["id"])
        release.set()
        for rid in (first,second["id"],third["id"]):
            self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertEqual(len(contexts),3)
        self.assertEqual(contexts[1][1]["bindings"]["n1"],self.source["ref"])
        self.assertIn("n3",contexts[1][1]["node_state"])
        self.assertEqual(contexts[2][1]["bindings"]["n1"],newest["ref"])
        session = await (await self.client.get(session_url)).json()
        self.assertEqual(session["queue"],[])
        self.assertEqual([event["data"]["text"] for event in session["events"] if event["kind"]=="user"],
                         ["第一条","排队生成","最后一条"])
        self.assertEqual([line["id"] for line in session["runs"] if line["id"]==discarded["id"]],[])
        self.assertEqual((await self.client.delete(f"/api/chat/runs/{third['id']}/queue")).status,409)

    async def test_startup_consumes_pending_chat_queue_without_client(self):
        url = f"/api/chat/sessions/{self.sid}/messages"
        with patch.object(self.svc,"start_next"):
            response = await self.client.post(url,json={"text":"恢复等待任务","request_key":"durable-1","enqueue":True})
        queued = await response.json()
        self.assertEqual(queued["state"],"queued")
        await chat.startup(self.app)
        self.assertEqual((await self.wait(queued["id"]))["state"],"done")
        self.svc.model.assert_awaited_once()

    async def test_execution_scope_is_enforced_after_queuing(self):
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        already_running, release = asyncio.Event(),asyncio.Event()
        baseline = server.board_path("test").read_text()
        traces = {}

        async def model(messages, run):
            query = run["data"]["memory_query"]
            if query=="占用当前对话":
                already_running.set()
                await release.wait()
                return answer()
            if messages[-1]["role"]=="tool":
                return answer()
            traces[query]=messages[0]["content"]
            no_write=call("canvas_create_text",{"text":"不可执行"},"write-attempt")
            preview=call("workflow_template_plan",{"template_id":"starter-storyboard","changes":[
                {"node":"n1","field":"text","value":"雨后车站"}]},"template-plan")
            calls = no_write["tool_calls"] + preview["tool_calls"]
            if query=="brainstorm":
                generation=call("image_generate",{"prompt":"不可生成"},"gen-attempt")
                directions=call("creative_directions",{"directions":[
                    {"title":title,"premise":premise,"approach":"先写分镜","tradeoff":"需要额外角色","first_step":"试写开场"}
                    for title,premise in (("悬疑","空站台收到信"),("温情","久别重逢"),("喜剧","认错列车"))]},"ideas")
                calls += generation["tool_calls"] + directions["tool_calls"]
            return {**no_write,"tool_calls":calls}

        self.svc.model.side_effect=model
        first=await self.send("占用当前对话",key="scope-first-run")
        await asyncio.wait_for(already_running.wait(),2)
        queued={}
        for scope in ("analysis","plan","brainstorm"):
            response=await self.client.post(endpoint,json={"text":scope,"request_key":"scope-"+scope,"execution_scope":scope,"enqueue":True})
            self.assertEqual(response.status,200,await response.text())
            queued[scope]=await response.json()
            self.assertEqual(queued[scope]["state"],"queued")
        release.set()
        self.assertEqual((await self.wait(first))["state"],"done")
        for scope,label in (("analysis","仅分析"),("plan","仅拟方案"),("brainstorm","头脑风暴")):
            rid=queued[scope]["id"]
            self.assertEqual((await self.wait(rid))["state"],"done")
            rejected,draft,*rest = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)]
            self.assertIn(label,rejected["error"])
            self.assertIn(label,traces[scope])
            if scope!="plan":
                self.assertIn(label,draft["error"])
            else:
                self.assertEqual(draft["template_fill_plan"]["inputs"][0]["value"],"雨后车站")
            if scope=="brainstorm":
                self.assertIn(label,rest[0]["error"])
                self.assertEqual([item["title"] for item in rest[1]["creative_directions"]],["悬疑","温情","喜剧"])
        self.assertEqual(server.board_path("test").read_text(),baseline)
        self.assertNotIn("workflow_template_plan",chat.scoped_tools({"execution_scope":"analysis"}))
        self.assertNotIn("canvas_create_text",chat.scoped_tools({"execution_scope":"plan"}))
        self.assertNotIn("image_generate",chat.scoped_tools({"execution_scope":"brainstorm"}))

    async def test_board_task_history_paginates_runs_in_the_same_conversation(self):
        self.board["collaborators"] = {"8":"editor"}
        server.board_path("test").write_text(chat.dumps(self.board))
        colleague = await self.client.post("/api/chat/sessions", headers={"X-Uid":"8"}, json={"board":"test"})
        self.assertEqual(colleague.status,200)
        colleague_session = (await colleague.json())["id"]
        for number in range(24):
            uid, sid = (8,colleague_session) if number==21 else (7,self.sid)
            state = "queued" if number==20 else "stopped" if number==19 else "done"
            data = chat.dumps({"discarded_before_start":True}) if number==19 else "{}"
            run_id = f"history-{number}"
            db.run("INSERT INTO chat_runs VALUES(?,?,?,?,?,?,?,?,?,?)",
                   run_id,sid,uid,"test",run_id,state,data,None,number,number)
            self.svc.emit(sid,run_id,"user",{"text":f"任务 {number}"})
        path = "/api/chat/task-history?board=test"
        first = await self.client.get(path)
        self.assertEqual(first.status,200)
        page = await first.json()
        self.assertEqual([task["id"] for task in page["tasks"]],
                         ["history-23","history-22"]+[f"history-{number}" for number in range(18,0,-1)])
        self.assertEqual(page["tasks"][0]["text"],"任务 23")
        self.assertTrue(all(task["session_id"]==self.sid for task in page["tasks"]))
        next_page = await self.client.get(path+f"&before={page['before']}")
        second = await next_page.json()
        self.assertEqual([task["id"] for task in second["tasks"]],["history-0"])
        self.assertIsNone(second["before"])
        colleague_page = await self.client.get(path,headers={"X-Uid":"8"})
        self.assertEqual([task["id"] for task in (await colleague_page.json())["tasks"]],["history-21"])
        self.assertEqual((await self.client.get(path+"&before=-1")).status,400)
        self.assertEqual((await self.client.get("/api/chat/task-history?board=missing")).status,403)

    async def test_independent_sessions_share_slots_without_blocking_eligible_queue_entries(self):
        sessions = [self.sid]
        for _ in range(3):
            response = await self.client.post("/api/chat/sessions",json={"board":"test"})
            sessions.append((await response.json())["id"])
        entered = {name:asyncio.Event() for name in ("对话甲","对话乙","对话丙","对话丁","甲的下一条")}
        releases = {name:asyncio.Event() for name in entered}
        contexts = {}

        async def model(messages, run):
            key = run["data"]["memory_query"]
            contexts[key] = [msg["content"] for msg in messages if msg["role"] == "user"]
            entered[key].set()
            await releases[key].wait()
            return answer(key+" 完成")

        async def send(sid, text, key):
            response = await self.client.post(f"/api/chat/sessions/{sid}/messages",
                json={"text":text,"request_key":key,"enqueue":True,"selected":["n1"] if key=="parallel-a" else []})
            self.assertEqual(response.status,200,await response.text())
            return await response.json()

        self.svc.model.side_effect = model
        first = await send(sessions[0],"对话甲","parallel-a")
        await asyncio.wait_for(entered["对话甲"].wait(),1)
        queued_same = await send(sessions[0],"甲的下一条","parallel-a-followup")
        self.assertEqual(queued_same["state"],"queued")
        second = await send(sessions[1],"对话乙","parallel-b")
        third = await send(sessions[2],"对话丙","parallel-c")
        await asyncio.wait_for(entered["对话乙"].wait(),1)
        await asyncio.wait_for(entered["对话丙"].wait(),1)
        fourth = await send(sessions[3],"对话丁","parallel-d")
        self.assertEqual(fourth["state"],"queued")
        snapshot = await (await self.client.get("/api/chat/sessions?board=test")).json()
        directory = snapshot["sessions"]
        self.assertEqual({item["id"] for item in directory if item["run_state"]=="thinking"},set(sessions[:3]))
        self.assertEqual({item["id"]:item["queued_count"] for item in directory if item["queued_count"]},
                         {sessions[0]:1,sessions[3]:1})
        self.assertEqual(next(item["node_activity"] for item in directory if item["id"]==sessions[0]),{"nodes":["n1"],"calls":[]})
        self.assertEqual(next(item["active_task_id"] for item in directory if item["id"]==sessions[0]),first["id"])
        active_task = next(item for item in directory if item["id"]==sessions[0])
        self.assertLessEqual(active_task["active_task_updated"],snapshot["task_snapshot_at"])
        conversation = await (await self.client.get(f"/api/chat/sessions/{sessions[0]}")).json()
        self.assertGreaterEqual(conversation["task_snapshot_at"],snapshot["task_snapshot_at"])
        self.assertNotIn("node_activity",next(item for item in directory if item["id"]==sessions[3]))
        self.assertNotIn("active_task_id",next(item for item in directory if item["id"]==sessions[3]))
        releases["对话乙"].set()
        self.assertEqual((await self.wait(second["id"]))["state"],"done")
        await asyncio.wait_for(entered["对话丁"].wait(),1)
        self.assertFalse(entered["甲的下一条"].is_set())
        self.assertEqual((await self.client.post(f"/api/chat/runs/{third['id']}/stop",json={})).status,200)
        self.assertEqual((await self.wait(third["id"]))["state"],"stopped")
        self.assertFalse(entered["甲的下一条"].is_set())
        releases["对话甲"].set()
        self.assertEqual((await self.wait(first["id"]))["state"],"done")
        await asyncio.wait_for(entered["甲的下一条"].wait(),1)
        releases["对话丁"].set()
        releases["甲的下一条"].set()
        self.assertEqual((await self.wait(fourth["id"]))["state"],"done")
        self.assertEqual((await self.wait(queued_same["id"]))["state"],"done")
        directory = {item["id"]:item for item in
                     (await (await self.client.get("/api/chat/sessions?board=test")).json())["sessions"]}
        self.assertEqual(directory[sessions[0]]["recent_task"]["id"],queued_same["id"])
        self.assertEqual(directory[sessions[1]]["recent_task"]["state"],"done")
        self.assertEqual(directory[sessions[2]]["recent_task"]["state"],"stopped")
        self.assertIsNone(directory[sessions[2]]["run_state"])
        self.assertEqual([len(contexts[name]) for name in entered],[1,1,1,1,2])
        self.assertTrue(contexts["甲的下一条"][0].startswith("对话甲"))
        self.assertTrue(contexts["甲的下一条"][1].startswith("甲的下一条"))

    async def test_parallel_generation_reserves_the_write_target_before_submission(self):
        other = (await (await self.client.post("/api/chat/sessions",json={"board":"test"})).json())["id"]
        distinct = (await (await self.client.post("/api/chat/sessions",json={"board":"test"})).json())["id"]
        entered, release = asyncio.Event(), asyncio.Event()
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))
        independent_source = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"yellow"),"input")
        self.board["nodes"].append({"id":"n3","type":"image","name":"独立图片","x":1200,"y":70,"data":{},
                                    "versions":[independent_source],"cur":0,"job":None})
        server.write_board(server.board_path("test"),self.board)
        sources = []

        def model(messages,run):
            if messages[-1]["role"] == "tool":
                return answer()
            return call("image_edit",{"node_id":run["data"]["selected"][0],"prompt":"调整色调"})

        async def generate(req):
            ref = (await req.json())["ref"]
            sources.append(ref)
            if ref == self.source["ref"]:
                entered.set()
                await release.wait()
            jid = "e000000001104" if ref == self.source["ref"] else "e000000001105"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]}
            return web.json_response({"ids":[jid]})

        self.svc.model.side_effect = model
        with patch.object(image_routes,"image_edit_generate",side_effect=generate) as submitted:
            first = await self.send("第一份改色","parallel-image-first")
            await asyncio.wait_for(entered.wait(),1)
            response = await self.client.post(f"/api/chat/sessions/{other}/messages",json={
                "text":"第二份改色","request_key":"parallel-image-second","selected":["n1"]})
            self.assertEqual(response.status,200,await response.text())
            second = (await response.json())["id"]
            self.assertEqual((await self.wait(second))["state"],"done")
            failed = db.one("SELECT result FROM chat_calls WHERE run_id=?",second)
            self.assertIn("另一个助手正在写入",json.loads(failed["result"])["error"])
            response = await self.client.post(f"/api/chat/sessions/{distinct}/messages",json={
                "text":"修改另一张图","request_key":"parallel-image-distinct","selected":["n3"]})
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual((await self.wait((await response.json())["id"]))["state"],"done")
            self.assertFalse(release.is_set())
            release.set()
            self.assertEqual((await self.wait(first))["state"],"done")
            self.assertEqual(submitted.await_count,2)
        self.assertEqual(sources,[self.source["ref"],independent_source["ref"]])
        nodes = {n["id"]:n for n in self.load()["nodes"]}
        self.assertEqual([v["ref"] for v in nodes["n1"]["versions"]],[self.source["ref"],result["ref"]])
        self.assertEqual([v["ref"] for v in nodes["n3"]["versions"]],[independent_source["ref"],result["ref"]])
        self.assertEqual(db.q("SELECT * FROM chat_node_writes"),[])
