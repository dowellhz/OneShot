"""Assistant conversation, tracked canvas changes, and execution lifecycle."""

from unittest.mock import AsyncMock, patch
import asyncio
import copy
import json

from PIL import Image
from aiohttp import web
from aiohttp.test_utils import TestServer

from oneshot.assistant import agent_chat as chat
from oneshot.editing import image_editor
from oneshot.editing import image_routes
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatIntegration(ChatFixture):
    async def test_creative_questions_pause_and_resume_exact_run(self):
        questions = [{"prompt":"选择画面比例","options":["16:9","9:16"]},{"prompt":"填写片名"}]
        self.svc.model.side_effect = [call("ask_creative_questions",{"questions":questions}),
            call("canvas_create_text",{"text":"9:16 · 海风","name":"交付要求"},"next-step"),answer()]
        rid = await self.send()
        session = f"/api/chat/sessions/{self.sid}"
        for _ in range(30):
            state = await (await self.client.get(session)).json()
            if state["questionnaires"]:
                break
            await asyncio.sleep(.02)
        card, = state["questionnaires"]
        self.assertEqual(card["run_id"],rid)
        self.assertEqual(state["runs"][0]["state"],"waiting_input")
        self.assertEqual(len(self.load()["nodes"]),2)
        endpoint = f"/api/chat/runs/{rid}/questions/{card['id']}"
        answers = {"answers":["9:16","海风"]}
        guest = await self.client.post(endpoint,json=answers,headers={"X-Uid":"8"})
        self.assertEqual(guest.status,404)
        partial = await self.client.post(endpoint,json={"answers":["9:16"]})
        self.assertEqual(partial.status,400)
        for _ in range(2):
            self.assertEqual((await self.client.post(endpoint,json=answers)).status,200)
        self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertEqual((await self.client.post(endpoint,json={"answers":["16:9","别名"]})).status,409)
        state = await (await self.client.get(session)).json()
        self.assertEqual(state["questionnaires"],[])
        event, = [event for event in state["events"] if event["kind"]=="question_answer"]
        self.assertEqual([item["answer"] for item in event["data"]["answers"]],answers["answers"])
        continued = self.svc.model.await_args_list[1].args[0]
        self.assertEqual(continued[-1]["role"],"tool")
        self.assertEqual(json.loads(continued[-1]["content"])["answers"],event["data"]["answers"])
        self.assertEqual(self.load()["nodes"][-1]["data"]["text"],"9:16 · 海风")

    async def test_streamed_reply_reconnects_and_waits_for_complete_tool_arguments(self):
        self.svc.model = chat.AgentService.model.__get__(self.svc)
        release, started = asyncio.Event(), asyncio.Event()
        request_bodies = []

        async def completion(req):
            body = await req.json()
            request_bodies.append(body)
            response = web.StreamResponse(headers={"Content-Type":"text/event-stream"})
            await response.prepare(req)

            async def chunk(delta, finish=None):
                data = json.dumps({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]},ensure_ascii=False)
                await response.write(("data: "+data+"\r\n\r\n").encode())

            if len(request_bodies)==1:
                await chunk({"content":"开始 <thi"})
                await chunk({"content":"nk>具体内部过程","reasoning_content":"内部推理"})
                started.set()
                await release.wait()
                await chunk({"content":"</think>执行","tool_calls":[{"index":0,"id":"chunked","type":"function",
                    "function":{"name":"canvas_create_text","arguments":"{\"text\":\""}}]})
                await chunk({"tool_calls":[{"index":0,"function":{"arguments":"完整文字\"}"}}]},"tool_calls")
            else:
                await chunk({"content":"**最终回复**"})
                await chunk({},"stop")
            await response.write(b"data: [DONE]\n\n")
            return response

        upstream = web.Application()
        upstream.router.add_post("/complete",completion)
        route = {"provider":{"id":"p1","kind":"openai_compat","name":"Stream","secrets":{}},"model":"stream-test"}
        endpoint = f"/api/chat/sessions/{self.sid}"
        async with TestServer(upstream) as model:
            with patch.object(chat.providers,"routes",return_value=[route]), patch.object(
                    chat.providers,"llm_endpoint",return_value=(str(model.make_url("/complete")),{})):
                rid = await self.send("生成一段文字")
                try:
                    await asyncio.wait_for(started.wait(),2)
                    async with asyncio.timeout(2):
                        while rid not in self.svc.reply_previews:
                            await asyncio.sleep(.01)
                    for _ in range(2):
                        state = await (await self.client.get(endpoint)).json()
                        self.assertEqual(state["reply_previews"],[{"run_id":rid,"text":"开始"}])
                        self.assertFalse(any(e["kind"]=="assistant" for e in state["events"]))
                        self.assertEqual(len(self.load()["nodes"]),2)
                        self.assertNotIn("内部",json.dumps(state,ensure_ascii=False))
                finally:
                    release.set()
                self.assertEqual((await self.wait(rid))["state"],"done")
                state = await (await self.client.get(endpoint)).json()
        self.assertEqual(state["reply_previews"],[])
        self.assertEqual([e["data"]["text"] for e in state["events"] if e["kind"]=="assistant"],["开始 执行","**最终回复**"])
        self.assertEqual(self.load()["nodes"][-1]["data"]["text"],"完整文字")
        self.assertEqual([body["stream"] for body in request_bodies],[True,True])

    async def test_provider_declining_stream_uses_a_complete_reply(self):
        self.svc.model = chat.AgentService.model.__get__(self.svc)
        flags = []

        async def completion(req):
            stream = (await req.json())["stream"]
            flags.append(stream)
            if stream:
                return web.json_response({"error":{"message":"stream is not supported"}},status=400)
            return web.json_response({"choices":[{"message":answer("完整回复")}]})

        upstream = web.Application()
        upstream.router.add_post("/complete",completion)
        route = {"provider":{"id":"p1","kind":"openai_compat","name":"Fallback","secrets":{}},"model":"json-test"}
        async with TestServer(upstream) as model:
            with patch.object(chat.providers,"routes",return_value=[route]), patch.object(
                    chat.providers,"llm_endpoint",return_value=(str(model.make_url("/complete")),{})):
                rid = await self.send()
                self.assertEqual((await self.wait(rid))["state"],"done")
                state = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
        self.assertEqual(flags,[True,False])
        self.assertEqual(state["reply_previews"],[])
        self.assertEqual([e["data"]["text"] for e in state["events"] if e["kind"]=="assistant"],["完整回复"])

    async def test_model_choice_is_locked_and_thinking_survives_tool_calls_and_queue(self):
        deep = {"provider":{"id":"p1","kind":"deepseek","name":"Cloud","secrets":{}}, "model":"deepseek-flash"}
        other = {"provider":{"id":"p2","kind":"openai_compat","name":"Other","secrets":{}}, "model":"alternative"}
        choice, second = [chat.chat_model_option(r)["id"] for r in (deep,other)]
        self.svc.model = chat.AgentService.model.__get__(self.svc)
        responses = [
            {**call("canvas_create_text",{"text":"保存的文字","name":"笔记"}), "reasoning_content":"internal first"},
            {**answer(), "reasoning_content":"internal second"},
            answer("已处理排队指令"),
        ]
        requests, first = [], asyncio.Event()
        release = asyncio.Event()

        async def complete(*args, **kwargs):
            requests.append(copy.deepcopy(kwargs["json"]))
            if len(requests) == 1:
                first.set()
                await release.wait()
            return {"choices":[{"message":responses[len(requests)-1]}]}

        endpoint = f"/api/chat/sessions/{self.sid}"
        async def send(key, model, level):
            return await self.client.post(endpoint+"/messages",json={
                "text":"测试","request_key":key,"chat_model":model,"thinking_level":level,"enqueue":True})

        with (patch.object(chat.providers,"routes",return_value=[other,deep]),
              patch.object(chat.providers,"llm_endpoint",return_value=("https://model.example",{})),
              patch.object(chat.providers,"json_req",side_effect=complete)):
            options = (await (await self.client.get(endpoint)).json())["model_options"]
            self.assertEqual(options[0]["levels"],[])
            self.assertEqual(options[1]["levels"],list(chat.THINKING_LEVELS))
            unsupported = await send("unsupported-level",second,"high")
            self.assertEqual(unsupported.status,400)
            submitted = await send("choose-deepseek",choice,"high")
            self.assertEqual(submitted.status,200,await submitted.text())
            await asyncio.wait_for(first.wait(),2)
            try:
                change = await send("choose-another",second,"off")
                self.assertEqual(change.status,400)
                queued = await send("reasoning-off",choice,"off")
                queued_data = await queued.json()
                self.assertEqual(queued_data["state"],"queued")
            finally:
                release.set()
            self.assertEqual((await self.wait((await submitted.json())["id"]))["state"],"done")
            self.assertEqual((await self.wait(queued_data["id"]))["state"],"done")
            state = await (await self.client.get(endpoint)).json()
            self.assertEqual(state["chat_model"]["id"],choice)
            self.assertEqual(state["thinking_level"],"off")
            self.assertNotIn("internal first",json.dumps(state))
        self.assertEqual([request["model"] for request in requests],["deepseek-flash"]*3)
        self.assertEqual(requests[0]["reasoning_effort"],"high")
        self.assertTrue(any(message.get("reasoning_content")=="internal first" for message in requests[1]["messages"]))
        self.assertFalse(any("reasoning_content" in message for message in requests[2]["messages"]))
        self.assertEqual(requests[2]["thinking"],{"type":"disabled"})

    async def test_chat_history_idempotency_and_privacy(self):
        rid = await self.send()
        self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(await self.send(), rid)
        self.assertEqual(self.svc.model.await_count, 1)
        r = await self.client.get(f"/api/chat/sessions/{self.sid}")
        content = await r.json()
        self.assertEqual([e["kind"] for e in content["events"]], ["user", "assistant"])
        self.assertNotIn("data", content["runs"][0])
        self.assertEqual((await self.client.get(f"/api/chat/sessions/{self.sid}", headers={"X-Uid": "8"})).status, 404)
        self.assertEqual((await self.client.get("/api/chat/sessions?board=test", headers={"X-Uid": "8"})).status, 403)

    async def test_create_arrange_undo_and_version_conflict(self):
        self.svc.model.side_effect = [call("canvas_create_text", {"text": "新的说明"}), call("canvas_arrange", {"node_ids": ["n1", "n2"], "operation": "top"}, "step2"), answer()]
        rid = await self.send()
        self.assertEqual((await self.wait(rid))["state"], "done")
        b = self.load()
        self.assertEqual(len(b["nodes"]), 3)
        self.assertEqual(b["nodes"][0]["y"], b["nodes"][1]["y"])
        r = await self.client.put("/api/board/test", json=self.board)
        self.assertEqual(r.status, 409)
        r = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(r.status, 200, await r.text())
        self.assertEqual(self.load()["nodes"], self.board["nodes"])
        # Repeating undo is idempotent too.
        self.assertEqual((await self.client.post(f"/api/chat/runs/{rid}/undo", json={})).status, 200)

    async def test_undo_preserves_subsequent_manual_edit(self):
        self.svc.model.side_effect = [call("canvas_update", {"node_id": "n2", "text": "agent text"}), answer()]
        rid = await self.send()
        await self.wait(rid)
        b = self.load()
        b["nodes"][1]["data"]["text"] = "my manual change"
        await self.client.put("/api/board/test", json=b)
        r = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(r.status, 409)
        self.assertEqual(self.load()["nodes"][1]["data"]["text"], "my manual change")

    async def test_marked_placement_avoids_existing_nodes_and_respects_locks(self):
        self.board["nodes"][0]["locked"] = True
        server.board_path("test").write_text(chat.dumps(self.board))
        initial = self.load()["nodes"]
        point = {"x": 30, "y": 40}
        self.svc.model.side_effect = [
            call("canvas_arrange", {"node_ids": ["n1", "n2"], "operation": "bottom"}),
            call("canvas_create_text", {"text": "把说明放在这里"}, "placed-text"), answer()]
        rid = await self.send(placement=point)
        self.assertEqual((await self.wait(rid))["state"], "done")
        current = self.load()["nodes"]
        self.assertEqual(current[:2], initial)
        self.assertEqual((current[-1]["x"], current[-1]["y"]), (980, 40))
        events = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
        event = next(e for e in events["events"] if e["kind"] == "user")
        self.assertEqual(event["data"]["placement"], point)
        arranged = next(e for e in events["events"] if e["kind"] == "tool_end" and e["data"]["name"] == "canvas_arrange")
        self.assertIn("锁定", arranged["data"]["result"]["error"])
        r = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(r.status, 200, await r.text())
        self.assertEqual(self.load()["nodes"], initial)
        invalid = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={
            "text":"无效放置点","request_key":"invalid-point","placement":{"x":1000001,"y":0}})
        self.assertEqual(invalid.status, 400)

    async def test_invalid_tools_and_mask_never_execute(self):
        self.svc.model.side_effect = [call("image_generate", {"prompt": "test", "count": 200}),
                                     call("image_edit", {"node_id": "n1", "prompt": "test", "mask_ref": "input:private.png"}, "badmask"), answer()]
        with patch.object(generation_requests, "generate_request", AsyncMock()) as generate:
            rid = await self.send()
            await self.wait(rid)
            generate.assert_not_awaited()
        rows = db.q("SELECT result FROM chat_calls WHERE run_id=?", rid)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("error" in json.loads(r["result"]) for r in rows))

    async def test_stop_and_continue_without_orphan_tools(self):
        entered = asyncio.Event()
        async def slow(*_):
            entered.set()
            await asyncio.sleep(30)
        self.svc.model.side_effect = slow
        rid = await self.send()
        await entered.wait()
        r = await self.client.post(f"/api/chat/runs/{rid}/stop", json={})
        self.assertEqual(r.status, 200)
        self.assertEqual((await self.wait(rid))["state"], "stopped")
        self.svc.model.side_effect = None
        self.svc.model.return_value = answer("可以继续")
        rid2 = await self.send("继续聊", "request002")
        self.assertEqual((await self.wait(rid2))["state"], "done")

    async def test_restart_after_committed_tool_does_not_duplicate(self):
        self.svc.model.side_effect = [call("canvas_create_text", {"text": "唯一节点"}), answer()]
        rid = await self.send()
        await self.wait(rid)
        row = db.one("SELECT * FROM chat_runs WHERE id=?", rid)
        row["data"] = json.loads(row["data"])
        saved = db.one("SELECT * FROM chat_calls WHERE run_id=?", rid)
        result = self.svc.commit(row, {"id": 7, "role": "member"}, saved["id"], lambda _: self.fail("effect duplicated"))
        self.assertEqual(len(self.load()["nodes"]), 3)
        self.assertIn("node_id", result)

    async def test_segment_alpha_becomes_real_grayscale_mask(self):
        from PIL import ImageDraw
        rgba = Image.new("RGBA", (128, 96), (255, 255, 255, 0))
        ImageDraw.Draw(rgba).rectangle((20, 20, 50, 50), fill=(255, 255, 255, 255))
        selection = image_editor.save(server.COMFY_DIR, rgba)
        rid = await self.send()
        await self.wait(rid)
        run = db.one("SELECT * FROM chat_runs WHERE id=?", rid)
        run["data"] = json.loads(run["data"])
        with patch.object(image_routes, "image_edit_tool", AsyncMock(return_value=web.json_response(selection))):
            result = await self.svc.execute(run, {"id": 7}, "segment-test", "image_segment", {"node_id": "n1", "points": [{"x": 30, "y": 30}]})
        mask = image_editor.load(server.COMFY_DIR, result["mask_ref"]).convert("L")
        self.assertEqual(mask.getpixel((0, 0)), 0)
        self.assertEqual(mask.getpixel((30, 30)), 255)
        self.assertEqual(run["data"]["masks"][result["mask_ref"]], self.source["ref"])

    async def test_restart_resumes_waiting_generation_without_resubmitting(self):
        import uuid
        rid = await self.send()
        await self.wait(rid)
        msg = call("image_generate", {"prompt": "blue"}, "recover")
        cid = "c" + uuid.uuid5(uuid.NAMESPACE_URL, rid + "recover").hex[:24]
        result = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        pending = {"ids": ["e999999999999"], "name": "Recovered", "prompt": "blue"}
        db.run("DELETE FROM chat_events WHERE run_id=? AND kind IN ('model','assistant') AND data LIKE '%assistant%'", rid)
        self.svc.emit(self.sid, rid, "model", msg)
        db.run("INSERT INTO chat_calls VALUES(?,?,?,?,?,?,?)", cid, rid, "image_generate", '{}', "waiting", json.dumps(pending), 1)
        db.run("UPDATE chat_runs SET state='running' WHERE id=?", rid)
        server.JOBS[pending["ids"][0]] = {"state": "done", "created": 1, "meta": {"uid": 7}, "outputs": [{"ref": result["ref"], "meta": {"width": 128, "height": 96}}]}
        with patch.object(generation_requests, "generate_request", AsyncMock()) as submit:
            await self.svc.work(rid)
            submit.assert_not_awaited()
        self.assertEqual(db.one("SELECT state FROM chat_runs WHERE id=?", rid)["state"], "done")
        self.assertEqual(len(self.load()["nodes"]), 3)

    async def test_board_active_run_and_bad_selection(self):
        async def delayed(*_):
            await asyncio.sleep(30)
        self.svc.model.side_effect = delayed
        rid = await self.send()
        r = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={"text": "another", "request_key": "request002"})
        self.assertEqual(r.status, 409)
        await self.client.post(f"/api/chat/runs/{rid}/stop", json={})
        await self.wait(rid)
        r = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={"text": "bad", "request_key": "request003", "selected": ["missing"]})
        self.assertEqual(r.status, 400)

    async def test_manual_change_before_tool_is_not_overwritten(self):
        gate = asyncio.Event()
        async def delayed(*_):
            await gate.wait()
            return call("canvas_update", {"node_id": "n2", "text": "agent overwrite"})
        async def model(messages, run):
            return answer() if any(m["role"] == "tool" for m in messages) else await delayed()
        self.svc.model.side_effect = model
        rid = await self.send()
        await asyncio.sleep(.01)
        b = self.load()
        b["nodes"][1]["data"]["text"] = "manual text"
        await self.client.put("/api/board/test", json=b)
        gate.set()
        await self.wait(rid)
        self.assertEqual(self.load()["nodes"][1]["data"]["text"], "manual text")
        self.assertIn("error", json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"]))

    async def test_stop_waiting_generation_cancels_owned_job(self):
        self.svc.model.return_value = call("image_generate", {"prompt": "blue"})
        async def submit(*_):
            return web.json_response({"ids": ["e111111111111"]})
        with patch.object(generation_requests, "generate_request", side_effect=submit), patch.object(generation_jobs, "jobs", AsyncMock(return_value=web.json_response({"e111111111111": {"state": "running", "phase": "sampling"}}))), patch.object(generation_jobs, "cancel", AsyncMock(return_value=web.json_response({"ok": True}))) as cancel:
            rid = await self.send()
            for _ in range(100):
                if db.one("SELECT id FROM chat_calls WHERE run_id=? AND state='waiting'", rid):
                    break
                await asyncio.sleep(.01)
            await self.client.post(f"/api/chat/runs/{rid}/stop", json={})
            self.assertEqual((await self.wait(rid))["state"], "stopped")
            cancel.assert_awaited_once()
            request = cancel.await_args.args[0]
            self.assertEqual((await request.json())["ids"], ["e111111111111"])
