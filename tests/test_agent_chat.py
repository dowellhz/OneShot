"""Run HTTP integration tests on the deployment host; uses an isolated database and media."""
import asyncio
import copy
import io
import json
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from oneshot.assistant import agent_chat as chat
from oneshot.storage import db
from oneshot.generation import fields
from oneshot.editing import image_editor
from oneshot.providers import catalog as providers
import server
from oneshot import config
from oneshot.canvas import routes as canvas_routes
from oneshot.editing import audio_routes
from oneshot.editing import image_routes
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import prompts
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.memory import legacy_routes
from oneshot.web import media as media_routes


def answer(text="已完成"):
    return {"role": "assistant", "content": text}


def call(name, args, mid="step1"):
    return {"role": "assistant", "content": "开始执行", "tool_calls": [
        {"id": mid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}

class VideoDialogueFields(unittest.TestCase):
    def test_explicit_action_times_preserve_line_order_and_dialogue(self):
        prompt, _, _ = fields.compose({
            "scene":"空走廊",
            "action":"0–0.5 秒 保持站姿\n0.5 至 2.25 秒：乔纳低声问：“谁？”\n2.25-4.6 seconds 回到门口",
            "people":"乔纳：旧夹克",
        })
        self.assertEqual(prompt.splitlines()[-3:], [
            "0–0.5 s: 保持站姿。",
            "0.5–2.25 s: 乔纳 (S1)低声问: <d>[Chinese] 谁？</d>.",
            "2.25–4.6 s: 回到门口。",
        ])

    def test_unique_short_speaker_name_keeps_reference_binding(self):
        prompt, _, _ = fields.compose(
            {"people":"乔纳·里德：旧夹克\n抱画女人：米色外套",
             "dialogue":"抱画女人（试探）：你也是来看米拉的？\n乔纳（点头）：对。\n乔纳·里德：你买了哪一张？"},
            subj={"乔纳·里德":1,"抱画女人":2})
        self.assertIn("抱画女人 <Subject 2> (S1)",prompt)
        self.assertEqual(prompt.count("乔纳·里德 <Subject 1> (S2)"),2)
        self.assertIn("<d>[Chinese] 对。</d>",prompt)
        ambiguous, _, _ = fields.compose(
            {"people":"乔纳·里德：旧夹克\n乔纳·另一个：新夹克","dialogue":"乔纳：你好。"},
            subj={"乔纳·里德":1,"乔纳·另一个":2})
        self.assertIn("乔纳 (S1) says",ambiguous)

    def test_rewrite_request_keeps_character_identity_and_spoken_words(self):
        prompt = fields.for_rewriter({
            "people":"乔纳·里德：旧夹克\n抱画女人：米色外套",
            "action":"乔纳低声问：“你还好吗？”",
            "dialogue":"抱画女人：Je vais bien.\n乔纳（点头）：好。\n“走吧。”",
        },subj={"乔纳·里德":1,"抱画女人":2})
        self.assertIn("乔纳 = 乔纳·里德 <Subject 1>",prompt)
        self.assertIn("乔纳·里德 <Subject 1> (S1)低声问: <d>你还好吗？</d>",prompt)
        self.assertIn("抱画女人 <Subject 2> (S2) says: <d>Je vais bien.</d>",prompt)
        self.assertIn("乔纳·里德 <Subject 1> (S1) says: <d>走吧。</d>",prompt)
        self.assertIn("add the correct language tag",prompt)


class VideoTimingTranslation(unittest.IsolatedAsyncioTestCase):
    async def test_translation_preserves_exact_times_on_separate_lines(self):
        source = {"prompt":"0–0.5 s: 保持站姿。\n0.5–2.25 s: 走到门口。"}
        expected = "0–0.5 s: Hold still.\n0.5–2.25 s: Walk to the door."
        llm = SimpleNamespace(available=lambda:True, chat=AsyncMock())
        with patch.object(prompts, "_XLATE_CACHE", {}), tempfile.TemporaryDirectory() as folder, \
                patch.object(prompts, "XLATE_FILE", Path(folder)/"timing.json"):
            for invalid in (expected.replace("2.25", "2.5"), expected.replace("\n", " ")):
                llm.chat.return_value = json.dumps({"prompt":invalid})
                rejected = await server.to_english({"llm":llm}, source)
                self.assertIn("action timing changed", rejected["_xlate_err"])
                self.assertEqual(rejected["prompt"], source["prompt"])
            llm.chat.return_value = json.dumps({"prompt":expected})
            translated = await server.to_english({"llm":llm}, source)
        self.assertEqual(translated["prompt"], expected)


class ChatFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.patchers = [patch.object(db, "DB_PATH", self.root / "chat.db"), patch.object(db, "_conn", None),
                         patch.object(canvas_routes, "BOARDS", self.root / "boards"), patch.object(config, "COMFY_DIR", self.root / "media"),
                         patch.object(legacy_routes, "LIBRARY", self.root / "library.json"),
                         patch.object(generation_jobs, "EDIT_JOBS", self.root / "edits"), patch.object(generation_jobs, "record")]
        for p in self.patchers:
            p.start()
        db.conn()
        for uid in [7, 8]:
            db.run("INSERT INTO users(id,username,role,disabled,pw_hash) VALUES(?,?,?,0,'test-disabled')", uid, "test" + str(uid), "member")
        server.BOARDS.mkdir()
        self.source = image_editor.save(server.COMFY_DIR, Image.new("RGBA", (128, 96), "red"), "input")
        self.board = {"name": "Test", "owner": 7, "rev": 1, "nodes": [
            {"id": "n1", "type": "image", "name": "产品", "x": 30, "y": 40, "data": {}, "versions": [self.source], "cur": 0, "job": None},
            {"id": "n2", "type": "text", "name": "说明", "x": 620, "y": 200, "data": {"text": "Hello"}, "versions": [], "cur": -1, "job": None}],
            "edges": [], "groups": [], "seq": 3, "view": {"x": 0, "y": 0, "k": 1}}
        server.board_path("test").write_text(chat.dumps(self.board))

        @web.middleware
        async def identity(req, handler):
            req["user"] = {"id": int(req.headers.get("X-Uid", "7")), "role": "member"}
            return await handler(req)

        self.app = web.Application(middlewares=[identity])
        self.http = aiohttp.ClientSession()
        self.app["http"] = self.http
        self.app["llm"] = SimpleNamespace(available=lambda: False, running=lambda: False)
        chat.install(self.app, server)
        server.canvas_live.install(self.app,server)
        self.app.add_routes(server.routes)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.svc = self.app["agent_chat"]
        self.svc.model = AsyncMock(return_value=answer())
        response = await self.client.post("/api/chat/sessions", json={"board": "test"})
        self.assertEqual(response.status, 200)
        self.sid = (await response.json())["id"]

    async def asyncTearDown(self):
        await self.client.close()
        await self.http.close()
        db.conn().close()
        for p in reversed(self.patchers):
            p.stop()
        server.JOBS.clear()
        self.tmp.cleanup()

    async def test_video_preview_keeps_media_bindings_during_translation(self):
        images = [
            {"name": "走廊首帧", "ref": self.source["ref"], "time": 0, "role": "frame", "index": 1},
            {"name": "乔纳·里德", "ref": self.source["ref"], "role": "subject", "index": 2},
            {"name": "抱画女人", "ref": self.source["ref"], "role": "subject", "index": 3},
        ]
        raw = {"kind": "video", "board": "test", "planned": True, "images": images,
               "prompt": "从@图1开始，@图2与@图3交谈。"}
        llm = SimpleNamespace(available=lambda: True, chat=AsyncMock(side_effect=[
            json.dumps({"prompt": "Start at image one and show two people talking."}),
            json.dumps({"prompt": "Start at @图1, then @图2 talks with @图3."}),
        ]))
        with patch.object(server.providers, "primary", return_value=None), patch.object(
            prompts, "_XLATE_CACHE", {}
        ), patch.object(prompts, "XLATE_FILE", self.root / "translate.json"), patch.dict(self.app, {"llm": llm}):
            failed = await self.client.post("/api/preview", json=raw)
            self.assertEqual(failed.status, 200, await failed.text())
            fallback = await failed.json()
            self.assertIn("未翻译", fallback["mode"])
            self.assertIn("从<Picture 3>开始，<Picture 1>与<Picture 2>交谈。", fallback["prompt"])
            response = await self.client.post("/api/preview", json=raw)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual([item["role"] for item in result["inputs"]], ["frame", "subject", "subject"])
        self.assertIn("Start at <Picture 3>, then <Picture 1> talks with <Picture 2>.", result["prompt"])
        self.assertFalse(server.JOBS)

    async def test_third_party_video_preview_uses_translated_reference_roles(self):
        provider = {"id": "video", "name": "视频服务", "kind": "kling", "enabled": True}
        raw = {"kind": "video", "provider": "video", "board": "test",
               "images": [{"name": "走廊", "ref": self.source["ref"], "role": "frame"},
                          {"name": "乔纳·里德", "ref": self.source["ref"], "role": "subject"}],
               "fields": {"action": "从@图1开始，@图2向左看。"}, "prompt": ""}
        with patch.object(server.providers, "get", return_value=provider), patch.object(
            server.providers, "default_model", return_value="kling-3.0"
        ):
            response = await self.client.post("/api/preview", json=raw)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertIn("从首帧画面开始，第 1 张人物参考图向左看。", result["prompt"])
        self.assertEqual([item["role"] for item in result["inputs"]], ["first_frame", "subject"])
        self.assertFalse(server.JOBS)

    async def send(self, text="执行测试", key="request001", selected=None, placement=None):
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={
            "text": text, "request_key": key, "selected": selected if selected is not None else ["n1"],
            **({"placement": placement} if placement is not None else {})})
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())["id"]

    async def wait(self, rid, timeout=2):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        row = None
        while loop.time() < deadline:
            row = db.one("SELECT * FROM chat_runs WHERE id=?", rid)
            if row["state"] in chat.TERMINAL:
                return row
            await asyncio.sleep(.01)
        self.fail(f"run {rid} did not finish within {timeout}s (last state: {row and row['state']})")

    def load(self):
        return json.loads(server.board_path("test").read_text())

    async def pending_generation(self, rid):
        for _ in range(120):
            data = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            pending = next((a for a in data["approvals"] if a["run_id"] == rid),None)
            if pending:
                return pending
            await asyncio.sleep(.01)
        states = db.q("SELECT name,state,result FROM chat_calls WHERE run_id=?",rid)
        self.fail(f"generation did not pause for approval: {db.one('SELECT state,error FROM chat_runs WHERE id=?',rid)}, {states}")


class ChatIntegration(ChatFixture):
    async def test_manual_node_can_select_configured_route_models(self):
        provider = {"id":"ark-models","name":"测试方舟","kind":"ark","enabled":True,
                    "config":{"models":{"image":"image-default","video":"doubao-seedance-2-0-fixture"},
                              "motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        image_model = "image-alternate"
        reference_model = "doubao-seedance-2-5-fixture"
        routes = {"image":[{"provider":provider,"model":image_model}],
                  "video":[{"provider":provider,"model":reference_model}]}
        draft = {"kind":"video","provider":provider["id"],"board":"test",
                 "prompt":"按 @音1 的节奏。","audio_refs":[{"ref":"input:h3studio/sound.wav"}],
                 "selected_model":reference_model}
        send = AsyncMock(side_effect=lambda *_args, **_kwargs: web.json_response({"ids":[]}))
        with patch.object(server.providers,"get",return_value=provider), patch.object(
            server.providers,"all_providers",return_value=[provider]
        ), patch.object(server.providers,"routes",side_effect=lambda cap:routes.get(cap,[])), patch.object(
            remote_jobs,"generate_remote",send
        ), patch.object(video_reference,"resolve_audio_refs",AsyncMock(return_value=[("source.wav",0,4)])):
            capabilities = json.loads((await server.capabilities(None)).body)
            self.assertEqual(capabilities["image"][0]["default_route_model"],image_model)
            self.assertEqual([m["id"] for m in capabilities["image"][0]["models"]],["image-default",image_model])
            self.assertEqual([m["id"] for m in capabilities["audio_reference"][0]["models"]],
                             [reference_model,"doubao-seedance-2-0-fixture"])
            self.assertEqual([m["id"] for m in capabilities["segment_edit"][0]["models"]],[reference_model])
            image = {"kind":"image","prompt":"画一条走廊","provider":provider["id"],"selected_model":image_model}
            response = await self.client.post("/api/generate",json=image)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(send.call_args.args[2]["model"],image_model)
            response = await self.client.post("/api/preview",json=draft)
            self.assertEqual(response.status,200,await response.text())
            self.assertIn(reference_model,(await response.json())["mode"])
            response = await self.client.post("/api/generate",json=draft)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(send.call_args.args[2]["model"],reference_model)
            for request in (image,draft):
                response = await self.client.post("/api/generate",json={**request,"selected_model":"unconfigured"})
                self.assertEqual(response.status,400,await response.text())
            self.assertEqual(send.await_count,2)

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

    async def test_start_from_brief_creates_one_canvas_and_preserves_project_permissions(self):
        project = await (await self.client.post("/api/canvas-projects",json={"name":"短片项目"})).json()
        endpoint = "/api/chat/start-canvas"
        settings = {"text":"春季新品\n写一条 15 秒短片的开场","project":project["id"],"request_key":"from-directory-key"}
        before = len(list(server.BOARDS.glob("*.json")))
        invalid = await self.client.post(endpoint,json={**settings,"text":"@不存在的角色","request_key":"from-directory-bad"})
        self.assertEqual(invalid.status,400)
        self.assertEqual(len(list(server.BOARDS.glob("*.json"))),before)
        self.svc.model.side_effect = [call("canvas_create_text",{"text":"春风吹过橱窗","name":"开场"}),answer()]
        created = await self.client.post(endpoint,json=settings)
        self.assertEqual(created.status,201,await created.text())
        draft = await created.json()
        row = await self.wait(draft["task"])
        self.assertEqual(row["state"],"done")
        board = await (await self.client.get("/api/board/"+draft["board"])).json()
        self.assertEqual(board["name"],"春季新品")
        self.assertEqual(board["nodes"][0]["data"]["text"],"春风吹过橱窗")
        self.assertEqual(db.one("SELECT project_id FROM canvas_project_boards WHERE board_id=?",draft["board"])["project_id"],project["id"])
        unchanged = await self.client.post(endpoint,json=settings)
        self.assertEqual(unchanged.status,200)
        self.assertEqual(await unchanged.json(),draft)
        self.assertEqual(len(list(server.BOARDS.glob("*.json"))),before+1)
        self.assertEqual((await self.client.post(endpoint,json={**settings,"text":"换一个需求"})).status,400)
        guest = {"X-Uid":"8"}
        self.assertEqual((await self.client.post(endpoint,headers=guest,json=settings)).status,400)

        team = await (await self.client.post("/api/canvas-teams",json={"name":"协作组"})).json()
        team_start = {"text":"画一张产品海报","title":"团队海报","team":team["id"],"request_key":"team-directory-key"}
        self.assertEqual((await self.client.post(endpoint,headers=guest,json=team_start)).status,404)
        self.assertEqual((await self.client.put("/api/board/member-blank",headers=guest,params={"team":team["id"]},
            json={"nodes":[]})).status,404)
        await self.client.patch("/api/canvas-teams/"+team["id"]+"/members",json={"username":"test8","action":"add"})
        blank = await self.client.put("/api/board/member-blank",headers=guest,params={"team":team["id"]},json={"nodes":[]})
        self.assertEqual(blank.status,200,await blank.text())
        visible = await (await self.client.get("/api/board/member-blank")).json()
        self.assertEqual((visible["team"],visible["owner"]),(team["id"],8))
        self.svc.model.side_effect = [call("image_generate",{"prompt":"商品海报"}),answer()]
        member = await self.client.post(endpoint,headers=guest,json=team_start)
        self.assertEqual(member.status,201,await member.text())
        receipt = await member.json()
        async with asyncio.timeout(5):
            while True:
                confirm = db.one("""SELECT a.id FROM chat_approvals a JOIN chat_calls c ON c.id=a.call_id
                    JOIN chat_runs r ON r.id=c.run_id WHERE r.id=? AND r.state='waiting_approval'""",receipt["task"])
                if confirm:
                    break
                await asyncio.sleep(.01)
        url = f"/api/chat/runs/{receipt['task']}/approvals/{confirm['id']}"
        self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,404)
        self.assertEqual((await self.client.post(url,headers=guest,json={"decision":"skip"})).status,200)
        self.assertEqual((await self.wait(receipt["task"]))["state"],"done")
        self.assertEqual((await self.client.get("/api/chat/sessions/"+receipt["session"])).status,404)

    async def test_assistant_profile_is_applied_per_account_and_current_project(self):
        board = self.load()
        board["collaborators"] = {"8":"editor"}
        server.board_path("test").write_text(chat.dumps(board))
        server.board_path("other").write_text(chat.dumps(board))
        project = await (await self.client.post("/api/canvas-projects",json={"name":"海报项目","board":"test"})).json()
        url = "/api/chat/profile"
        stored = await self.client.put(url,json={"board":"test","changes":{
            "personal":{"text":"个人习惯使用短字幕","revision":0},
            "project":{"id":project["id"],"text":"该项目统一使用蓝白色","revision":0},
        }})
        self.assertEqual(stored.status,200,await stored.text())
        saved = await stored.json()
        self.assertEqual(saved["personal"],{"text":"个人习惯使用短字幕","revision":1})
        self.assertEqual(saved["project"]["revision"],1)
        editor = {"X-Uid":"8"}
        private = await (await self.client.get(url,params={"board":"test"},headers=editor)).json()
        self.assertEqual(private,{"personal":{"text":"","revision":0},"project":None})
        disallowed = await self.client.put(url,headers=editor,json={"board":"test","changes":{
            "project":{"id":project["id"],"text":"尝试覆盖别人的项目","revision":1}}})
        self.assertEqual(disallowed.status,409)
        stale = await self.client.put(url,json={"board":"test","changes":{
            "personal":{"text":"事务内不应保存的改动","revision":1},
            "project":{"id":project["id"],"text":"过期项目规则","revision":0},
        }})
        self.assertEqual(stale.status,409)
        self.assertEqual((await (await self.client.get(url,params={"board":"test"})).json()),saved)

        async def model_prompt(board_id, headers=None):
            created = await self.client.post("/api/chat/sessions",json={"board":board_id},headers=headers)
            self.assertEqual(created.status,200,await created.text())
            session = (await created.json())["id"]
            message = await self.client.post(f"/api/chat/sessions/{session}/messages",
                json={"text":"这次根据指定要求做分镜","request_key":"profile-context"},headers=headers)
            self.assertEqual(message.status,200,await message.text())
            self.assertEqual((await self.wait((await message.json())["id"]))["state"],"done")
            return self.svc.model.await_args.args[0][0]["content"]

        in_project = await model_prompt("test")
        self.assertIn("当前用户的明确要求优先",in_project)
        self.assertIn("个人习惯使用短字幕",in_project)
        self.assertIn("该项目统一使用蓝白色",in_project)
        own_other_board = await model_prompt("other")
        self.assertIn("个人习惯使用短字幕",own_other_board)
        self.assertNotIn("该项目统一使用蓝白色",own_other_board)
        editor_prompt = await model_prompt("test",editor)
        self.assertNotIn("个人习惯使用短字幕",editor_prompt)
        self.assertNotIn("该项目统一使用蓝白色",editor_prompt)
        await self.client.post("/api/board/other/project",json={"project":project["id"]})
        self.assertIn("该项目统一使用蓝白色",await model_prompt("other"))
        cleared = await self.client.put(url,json={"board":"other","changes":{
            "personal":{"text":"","revision":1}}})
        self.assertEqual(cleared.status,200,await cleared.text())
        await self.client.delete(f"/api/canvas-projects/{project['id']}")
        after_dissolve = await model_prompt("other")
        self.assertNotIn("个人习惯使用短字幕",after_dissolve)
        self.assertNotIn("该项目统一使用蓝白色",after_dissolve)
        self.assertFalse(db.one("SELECT 1 FROM assistant_profiles WHERE project_id=?",project["id"]))

    async def test_assistant_memory_suggestion_requires_confirm_and_survives_replay(self):
        self.svc.model.side_effect = [
            call("creative_profile_suggest",{"scope":"personal","instruction":"长片默认给分镜编号"}),answer(),
            call("creative_profile_suggest",{"scope":"personal","instruction":"偏好无衬线字幕"}),answer(),
        ]
        settings_url = "/api/chat/profile?board=test"
        url = f"/api/chat/sessions/{self.sid}"

        async def suggestion(key, text):
            rid = await self.send(text,key)
            self.assertEqual((await self.wait(rid))["state"],"done")
            chat_data = await (await self.client.get(url)).json()
            return next(e["data"]["result"]["profile_suggestion"] for e in chat_data["events"]
                        if e["run_id"] == rid and e["kind"] == "tool_end")

        first = await suggestion("profile-first","记住，长片默认给分镜编号")
        self.assertEqual(first["scope"],"personal")
        self.assertEqual((await (await self.client.get(settings_url)).json())["personal"]["text"],"")
        endpoint = f"{url}/profile/{first['id']}"
        blocked = await self.client.post(endpoint,headers={"X-Uid":"8"},json={"decision":"save"})
        self.assertEqual(blocked.status,404)
        for _ in range(2):
            saved = await self.client.post(endpoint,json={"decision":"save"})
            self.assertEqual(saved.status,200,await saved.text())
        self.assertEqual((await self.client.post(endpoint,json={"decision":"dismiss"})).status,409)
        second = await suggestion("profile-second","记住，偏好无衬线字幕")
        declined = await self.client.post(f"{url}/profile/{second['id']}",json={"decision":"dismiss"})
        self.assertEqual(declined.status,200,await declined.text())
        profile = await (await self.client.get(settings_url)).json()
        self.assertEqual(profile["personal"],{"text":"长片默认给分镜编号","revision":1})
        events = (await (await self.client.get(url)).json())["events"]
        self.assertEqual([e["data"] for e in events if e["kind"] == "profile_decision"],
                         [{"id":first["id"],"decision":"save"},{"id":second["id"],"decision":"dismiss"}])

    async def test_project_suggestion_cannot_save_to_another_project_or_overwrite_changes(self):
        project = await (await self.client.post("/api/canvas-projects",json={"name":"海报项目","board":"test"})).json()
        new_project = await (await self.client.post("/api/canvas-projects",json={"name":"影片项目"})).json()
        self.svc.model.side_effect = [
            call("creative_profile_suggest",{"scope":"project","instruction":"统一使用竖屏构图"}),answer(),
        ]
        rid = await self.send("记住，本项目统一使用竖屏构图","profile-project-proposal")
        self.assertEqual((await self.wait(rid))["state"],"done")
        path = f"/api/chat/sessions/{self.sid}"
        events = (await (await self.client.get(path)).json())["events"]
        recommendation = next(e["data"]["result"]["profile_suggestion"] for e in events if e["kind"] == "tool_end")
        self.assertEqual((recommendation["scope"],recommendation["project"]),("project","海报项目"))
        endpoint = f"{path}/profile/{recommendation['id']}"
        await self.client.post("/api/board/test/project",json={"project":new_project["id"]})
        self.assertEqual((await self.client.post(endpoint,json={"decision":"save"})).status,409)
        await self.client.post("/api/board/test/project",json={"project":project["id"]})
        saved = await self.client.put("/api/chat/profile",json={"board":"test","changes":{
            "project":{"id":project["id"],"text":"使用横屏构图","revision":0}}})
        self.assertEqual(saved.status,200,await saved.text())
        self.assertEqual((await self.client.post(endpoint,json={"decision":"save"})).status,409)
        self.assertEqual((await self.client.post(endpoint,json={"decision":"dismiss"})).status,200)
        settings = await (await self.client.get("/api/chat/profile?board=test")).json()
        self.assertEqual(settings["project"]["text"],"使用横屏构图")

    async def test_generation_cost_uses_the_selected_route_model_and_duration(self):
        video = providers.save(None,"kling","Video fixture",{"generation_rates":"video kling-2.6 hd 0.25"}, {}, True)
        providers.set_route("video",[{"provider_id":video,"model":"kling-2.6"}])
        image = providers.save(None,"ark","Image fixture",{"generation_rates":"image custom-image 0.125",
            "models":{"image":"custom-image"}}, {}, True)
        reference_model = "doubao-seedance-2-5-fixture"
        reference = providers.save(None,"ark","Reference fixture",{"generation_rates":f"video {reference_model} 4k 0.5",
            "models":{"video":reference_model},"motion_origin":"https://studio.example"},{"api_key":"fixture"},True)
        audio_reference = providers.save(None,"ark","Audio reference fixture",{"generation_rates":f"video {reference_model} 4k 1",
            "models":{"video":reference_model}},{"api_key":"fixture"},True)
        with self.assertRaisesRegex(providers.ProviderError,"重复"):
            providers.save(image,"ark","Image fixture",{"generation_rates":"image custom-image 1\nimage custom-image 2"}, {}, True)
        video_request = {"kind":"video","duration":8,"quality":"hd","count":2}
        media_request = {**video_request,"provider":reference,"selected_model":reference_model,"quality":"4k",
                         "video_refs":True,"audio_refs":True,"prompt":"按 @视频{123} 和 @音频1 的节奏"}
        requests = [
            video_request, {**video_request,"quality":"std"}, {**video_request,"video_refs":True},
            {"kind":"image","provider":image,"selected_model":"custom-image","count":4},
            {"kind":"image","provider":image,"selected_model":"unavailable"},
            {"kind":"image","count":2},
            {**video_request,"prompt":"照着 @图1 构图"},
            media_request,
            {**media_request,"prompt":"按 @林森 和 @视频1"},
            {**media_request,"previs_guide":True,"duration":15},
            {**media_request,"provider":audio_reference,"previs_guide":False,"video_refs":False,"prompt":"按 @音频1 的节奏"},
        ]
        response = await self.client.post("/api/generation-cost",json={"requests":requests})
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["amounts"],[5,None,None,.5,None,0,5,8,None,None,16])
        self.assertFalse(server.JOBS)
        self.assertFalse(db.q("SELECT id FROM tasks"))

    async def test_manual_generation_waits_and_recovers_across_worker_restart(self):
        provider = providers.save(None,"ark","Image fixture",{"generation_rates":"image custom-image 0.125"}, {}, True)
        providers.set_route("image",[{"provider_id":provider,"model":"custom-image"}])
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        self.svc.model.side_effect = [call("image_generate",{"prompt":"先审阅这张海报","count":1}),answer(),answer()]
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))

        async def generate(_req, payload):
            jid = "e000000001001"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]*payload["count"]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"生成海报","request_key":"manual-confirm","generation_mode":"manual"})
            self.assertEqual(response.status,200)
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["prompt"],"先审阅这张海报")
            self.assertEqual(approval["plan"]["count"],1)
            self.assertEqual(approval["plan"]["unit_cost"],.125)
            submit.assert_not_awaited()
            original_url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            for parameters in ({"count":5},{"count":True},{"provider":"unexpected"},{"prompt":"   "}):
                invalid = await self.client.post(original_url,json={"decision":"adjust","parameters":parameters})
                self.assertEqual(invalid.status,400)
            adjusted = await self.client.post(original_url,json={"decision":"adjust","parameters":{"count":2,"prompt":"  改成暖色海报  "}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            approval = await self.pending_generation(rid)
            self.assertEqual((approval["plan"]["count"],approval["plan"]["prompt"]),(2,"改成暖色海报"))
            self.assertEqual(approval["plan"]["unit_cost"],.125)
            self.assertEqual((await self.client.post(original_url,json={"decision":"approve"})).status,409)
            submit.assert_not_awaited()
            queued = await self.client.post(endpoint,json={"text":"继续","request_key":"after-approval","enqueue":True})
            task = (await queued.json())
            self.assertEqual(task["state"],"queued")
            self.svc.closing = True
            worker = self.svc.tasks[rid]
            worker.cancel()
            await asyncio.gather(worker,return_exceptions=True)
            self.svc.closing = False
            self.svc.launch(rid)
            self.assertEqual((await self.pending_generation(rid))["id"],approval["id"])
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"approve"},headers={"X-Uid":"8"})).status,404)
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.client.post(url,json={"decision":"approve"})).status,200)
            self.assertEqual((await self.client.post(url,json={"decision":"skip"})).status,409)
            await self.wait(rid)
            await self.wait(task["id"])
            submit.assert_awaited_once()
            self.assertEqual((submit.await_args.args[1]["count"],submit.await_args.args[1]["prompt"]),(2,"改成暖色海报"))
        self.assertEqual(len(self.load()["nodes"]),4)
        self.assertEqual(self.load()["nodes"][-1]["versions"][0]["prompt"],"改成暖色海报")

    async def test_video_approval_reviews_adjusted_assets_and_stops_when_they_change(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        asset = store.put(user,{"board":"test","name":"站台参考","kind":"scene","ref":self.source["ref"],"source_board":"test"})
        audio, sound = server.film._new(server.COMFY_DIR,"input","approval-sound",".wav")
        with wave.open(str(audio),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x08"*16000)
        server.grant_media(user,sound)
        store.put(user,{"id":asset["id"],"ref":sound,"generation_media":[self.source["ref"],sound]})
        model = "doubao-seedance-2-5-fixture"
        default_provider = providers.save(None,"kling","普通镜头",{"generation_rates":"video kling-2.6 hd 0.1"}, {}, True)
        provider = providers.save(None,"ark","方舟测试",{"generation_rates":f"video {model} hd 0.25"},{"api_key":"test"},True)
        providers.set_route("video",[{"provider_id":default_provider,"model":"kling-2.6"},{"provider_id":provider,"model":model}])
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        pending = asyncio.Event()
        refresh = asyncio.Event()
        original_review = server.asset_reference_review

        async def review(req,payload):
            if payload["prompt"].startswith("改为"):
                pending.set()
                await refresh.wait()
            return await original_review(req,payload)

        self.svc.model.side_effect = [call("video_generate",{"prompt":"空镜头","duration":5}),answer()]
        with patch.object(video_reference,"asset_reference_review",side_effect=review),patch.object(remote_jobs,"start_remote") as submit:
            started = await self.client.post(endpoint,json={"text":"生成空镜头","request_key":"asset-review-edit","generation_mode":"manual"})
            rid = (await started.json())["id"]
            approval = await self.pending_generation(rid)
            url = f"/api/chat/runs/{rid}/approvals/"
            self.assertIsNone(approval["plan"]["reference_review"])
            self.assertEqual(approval["plan"]["unit_cost"],.5)
            adjusted = await self.client.post(url+approval["id"],json={"decision":"adjust","parameters":{"prompt":"改为 @站台参考"}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            revised = (await adjusted.json())["approval_id"]
            await asyncio.wait_for(pending.wait(),2)
            self.assertIsNone((await self.pending_generation(rid))["plan"]["unit_cost"])
            blocked = await self.client.post(url+revised,json={"decision":"approve"})
            self.assertEqual(blocked.status,409)
            refresh.set()
            for _ in range(100):
                approval = await self.pending_generation(rid)
                if approval["plan"].get("reference_review"):
                    break
                await asyncio.sleep(.02)
            shown = approval["plan"]["reference_review"]
            self.assertEqual(approval["plan"]["unit_cost"],1.25)
            self.assertNotIn("key",shown)
            self.assertEqual((shown["provider"],shown["model"],shown["duration"]),("方舟测试","doubao-seedance-2-5-fixture",5))
            self.assertEqual([(entry["role"],entry.get("end")) for entry in shown["inputs"]],[("subject",None),("audio_ref",2)])
            store.put(user,{"id":asset["id"],"generation_media":[self.source["ref"]]})
            self.assertEqual((await self.client.post(url+revised,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            submit.assert_not_called()
            self.assertIn("参考素材已变化",db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])

        store.put(user,{"id":asset["id"],"generation_media":[self.source["ref"],sound]})
        self.svc.model.side_effect = [call("video_generate",{"prompt":"参考 @站台参考","duration":5}),answer()]

        def finish_placeholder(_app,job,*args,**kwargs):
            job.update(state="done",outputs=[])

        with patch.object(remote_jobs,"start_remote",side_effect=finish_placeholder) as submit:
            started = await self.client.post(endpoint,json={"text":"生成有站台声的镜头","request_key":"asset-review-unchanged",
                                                           "generation_mode":"manual"})
            rid = (await started.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["reference_review"]["assets"],["站台参考"])
            response = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual(response.status,200,await response.text())
            await self.wait(rid,timeout=5)
            submit.assert_called_once()
            self.assertEqual(submit.call_args.args[-1]["audio_refs"],[(audio,0,2)])

    async def test_image_approval_shows_edited_asset_references_and_blocks_stale_submission(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        face = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))
        b = self.load()
        b["nodes"][0]["versions"].append(face)
        server.write_board(server.board_path("test"),b)
        asset = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                               "source_board":"test","character_view":"main","desc":"蓝衣"})
        store.put(user,{"id":asset["id"],"ref":face["ref"],"source_board":"test","character_view":"face"})
        prompt = "画 @{"+asset["id"]+"#face|林森} 的头肩特写"
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        seen = []

        async def submit(_req,payload):
            seen.append(payload)
            jid = "e000000124001"
            output = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"green"))
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[output]}
            return web.json_response({"ids":[jid]})

        async def start(key, text):
            self.svc.model.side_effect = [call("image_generate",{"prompt":text,"reference_ids":["n1"]}),answer()]
            response = await self.client.post(endpoint,json={"text":"生成海报","request_key":key,"generation_mode":"manual"})
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            return rid,await self.pending_generation(rid)

        with patch.object(generation_requests,"_generate_request",submit):
            rid, approval = await start("image-asset-adjust","只有场景")
            review = approval["plan"]["reference_review"]
            self.assertEqual(review["assets"],[])
            self.assertEqual([(entry["ref"],entry["version"]) for entry in review["inputs"]],[(self.source["ref"],1)])
            url = f"/api/chat/runs/{rid}/approvals/"
            adjusted = await self.client.post(url+approval["id"],json={"decision":"adjust","parameters":{"prompt":prompt}})
            self.assertEqual(adjusted.status,200,await adjusted.text())
            revised = (await adjusted.json())["approval_id"]
            for _ in range(100):
                plan = (await self.pending_generation(rid))["plan"]
                if (plan.get("reference_review") or {}).get("assets"):
                    break
                await asyncio.sleep(.02)
            review = plan["reference_review"]
            self.assertEqual(review["assets"],["林森（正面头肩）"])
            self.assertEqual([(entry["ref"],entry.get("memory_view")) for entry in review["inputs"]],
                             [(self.source["ref"],None),(face["ref"],"face")])
            self.assertNotIn("key",review)
            store.put(user,{"id":asset["id"],"desc":"红衣"})
            self.assertEqual((await self.client.post(url+revised,json={"decision":"approve"})).status,200)
            await self.wait(rid)
            self.assertEqual(seen,[])
            self.assertIn("参考素材或生成服务已变化",db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            rid, approval = await start("image-asset-confirmed",prompt)
            b = self.load()
            b["nodes"][0]["cur"] = 1
            server.write_board(server.board_path("test"),b)
            decision = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
            self.assertEqual(decision.status,200,await decision.text())
            await self.wait(rid)
        self.assertEqual(len(seen),1)
        self.assertEqual([entry["ref"] for entry in seen[0]["images"]],[self.source["ref"],face["ref"]])
        self.assertIn("红衣",seen[0]["prompt"])

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

    async def test_smart_generation_skips_extra_submission_without_spending_budget(self):
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        self.svc.model.side_effect = [call("image_generate",{"prompt":"两张草稿","count":2}),
                                      call("image_generate",{"prompt":"再生成一张"},"next"),answer()]
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))

        async def generate(_req, payload):
            jid = "e000000001002"
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]*payload["count"]}
            return web.json_response({"ids":[jid]})

        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            response = await self.client.post(endpoint,json={"text":"生成画面","request_key":"smart-confirm","generation_mode":"smart"})
            self.assertEqual(response.status,200)
            rid = (await response.json())["id"]
            approval = await self.pending_generation(rid)
            self.assertEqual(approval["plan"]["prompt"],"再生成一张")
            submit.assert_awaited_once()
            url = f"/api/chat/runs/{rid}/approvals/{approval['id']}"
            self.assertEqual((await self.client.post(url,json={"decision":"skip"})).status,200)
            run = await self.wait(rid)
            self.assertEqual(json.loads(run["data"])["generated"],2)
            submit.assert_awaited_once()

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

    async def test_regenerate_video_keeps_named_clip_and_audio_references(self):
        board = self.load()
        clip = "input:h3studio/clip-old.mp4"
        sound = "input:h3studio/audio-old.wav"
        guide = "output:h3studio/previs_20260101_120000_abcde.mp4"
        def media(nid,kind,values):
            return {"id":nid,"type":kind,"name":nid,"cur":len(values)-1,"data":{},"versions":values}
        board["nodes"].extend([
            {**media("n3","video",[]),"data":{"prompt":"","pmode":"fields","duration":5,
                "fields":{"action":"参考 @视频{6} 的运镜，采用 @音{2} 的节奏"}}},
            media("n4","video",[{"ref":clip,"seconds":12},{"ref":"input:h3studio/clip-new.mp4","seconds":12}]),
            media("n5","audio",[{"ref":sound,"seconds":4},{"ref":"input:h3studio/audio-new.wav","seconds":4}]),
            media("n6","video",[{"ref":guide,"source":"previs","seconds":4}]),
        ])
        board["edges"] = [
            {"from":"n4","to":"n3","relation":"video_ref","ref":clip,"prompt_slot":6,"start":1,"end":5},
            {"from":"n5","to":"n3","relation":"audio_ref","ref":sound,"prompt_slot":2},
            {"from":"n6","to":"n3","relation":"previs","ref":guide},
        ]
        server.write_board(server.board_path("test"),board)
        seen = []
        async def submit(req,raw):
            seen.append(raw)
            return web.json_response({"ids":[]})
        route = {"provider":{"id":"seedance-qa","kind":"ark"},"model":"doubao-seedance-2-5"}
        self.svc.model.side_effect = [call("video_regenerate",{"node_id":"n3"}),answer()]
        with patch.object(generation_requests,"generate_request",side_effect=submit),patch.object(video_reference,"reference_routes",return_value=[route]):
            rid = await self.send("用这条配方重生成",selected=["n3"])
            self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertTrue(seen,db.one("SELECT result FROM chat_calls WHERE run_id=?",rid))
        payload = seen[0]
        self.assertEqual(payload["fields"]["action"],"参考 @视频2 的运镜，采用 @音1 的节奏")
        self.assertEqual([(item["ref"],item["prompt_slot"],item["start"],item["end"]) for item in payload["video_refs"]],
                         [(clip,6,1,5)])
        self.assertEqual([(item["ref"],item["prompt_slot"]) for item in payload["audio_refs"]],[(sound,2)])
        self.assertNotIn("provider",payload,"unselected reference service stays automatic until preflight")

    async def test_regenerate_video_keeps_prompt_image_version_pinned(self):
        board = self.load()
        latest = image_editor.save(server.COMFY_DIR,Image.new("RGB",(60,32),"blue"),"input")
        board["nodes"][0]["versions"].append(latest)
        board["nodes"][0]["cur"] = 1
        board["nodes"].append({"id":"n3","type":"video","name":"镜头","cur":-1,"versions":[],
                               "data":{"prompt":"用 @图{3} 作首帧","duration":5}})
        board["edges"] = [{"from":"n1","to":"n3","role":"first","ref":self.source["ref"],"prompt_slot":3}]
        server.write_board(server.board_path("test"),board)
        seen = []
        async def submit(req,raw):
            seen.append(raw)
            return web.json_response({"ids":[]})
        self.svc.model.side_effect = [call("video_regenerate",{"node_id":"n3"}),answer()]
        with patch.object(generation_requests,"generate_request",side_effect=submit):
            rid = await self.send("重拍镜头",selected=["n3"])
            self.assertEqual((await self.wait(rid))["state"],"done")
        self.assertTrue(seen,db.one("SELECT result FROM chat_calls WHERE run_id=?",rid))
        self.assertEqual(seen[0]["prompt"],"用 @图1 作首帧")
        self.assertEqual((seen[0]["images"][0]["ref"],seen[0]["images"][0]["prompt_slot"]),(self.source["ref"],3))

    async def test_canvas_reference_can_pin_an_older_version(self):
        latest = image_editor.save(server.COMFY_DIR,Image.new("RGB",(60,32),"blue"),"input")
        board = self.load()
        board["nodes"][0]["versions"].append(latest)
        board["nodes"][0]["cur"] = 1
        server.write_board(server.board_path("test"),board)
        url = f"/api/chat/sessions/{self.sid}/messages"
        pinned = {"node_id":"n1","ref":self.source["ref"]}
        body = {"text":"分析产品旧图","request_key":"pin-version-01","selected":["n1"],"selected_versions":[pinned]}
        self.assertEqual((await self.client.post(url,json={**body,"selected":[]})).status,400)
        self.assertEqual((await self.client.post(url,json={**body,"selected_versions":[{**pinned,"ref":"input:h3studio/unavailable.png"}]})).status,400)
        self.assertEqual((await self.client.post(url,json={**body,"selected_versions":[pinned,{**pinned,"ref":latest["ref"]}]})).status,400)
        self.svc.model.side_effect = [call("canvas_workflow_review",{"node_id":"n1"}),answer("已读取旧版本")]
        response = await self.client.post(url,json=body)
        self.assertEqual(response.status,200,await response.text())
        run = await self.wait((await response.json())["id"])
        self.assertEqual(run["state"],"done")
        self.assertEqual(json.loads(run["data"])["bindings"]["n1"],self.source["ref"])
        self.assertEqual(self.load()["nodes"][0]["cur"],1)
        result = db.one("SELECT result FROM chat_calls WHERE run_id=?",run["id"])
        self.assertEqual(json.loads(result["result"])["workflow"]["version"],1)
        context = self.svc.context({"id":7,"role":"member"},"test",json.loads(run["data"]))
        self.assertEqual(context["nodes"][0]["reference_version"],1)
        event = db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='user'",run["id"])
        self.assertEqual(json.loads(event["data"])["selected_versions"],[{"node_id":"n1","name":"产品","version":1}])

    async def test_chat_attachment_is_private_and_scoped_to_queued_message(self):
        started, release = asyncio.Event(), asyncio.Event()
        captured = []
        async def model(messages,run):
            captured.append(messages)
            if len(captured)==1:
                started.set()
                await release.wait()
            return answer("已阅读")
        self.svc.model.side_effect = model
        first = await self.send("先等待")
        await asyncio.wait_for(started.wait(),2)
        url = f"/api/chat/sessions/{self.sid}/documents"
        filename, phrase = "拍摄方案.md", "吊车挂一盏深蓝色灯"
        document = aiohttp.FormData()
        document.add_field("file",("背景文字\n"*3800+phrase).encode(),filename=filename,content_type="text/markdown")
        response = await self.client.post(url,data=document)
        self.assertEqual(response.status,201,await response.text())
        upload = await response.json()
        self.assertEqual(upload["name"],filename)
        self.assertNotIn("text",upload)
        other = await (await self.client.post("/api/chat/sessions",json={"board":"test"})).json()
        send = f"/api/chat/sessions/{self.sid}/messages"
        payload = {"text":"请整理吊车灯光","request_key":"doc-message-01","document_ids":[upload["id"]],"enqueue":True}
        denied = await self.client.post(f"/api/chat/sessions/{other['id']}/messages",json=payload)
        self.assertEqual(denied.status,400)
        res = await self.client.post(send,json=payload)
        self.assertEqual(res.status,200,await res.text())
        task = await res.json()
        self.assertEqual(task["state"],"queued")
        self.assertIsNone(db.one("SELECT id FROM chat_documents WHERE id=?",upload["id"]))
        self.assertEqual(await (await self.client.post(send,json=payload)).json(),task)
        self.assertEqual((await self.client.post(send,json={**payload,"request_key":"doc-message-02"})).status,400)
        release.set()
        self.assertEqual((await self.wait(first))["state"],"done")
        finished = await self.wait(task["id"])
        self.assertEqual(finished["state"],"done")
        self.assertNotIn("message_documents",json.loads(finished["data"]))
        self.assertIn(phrase,captured[1][-1]["content"])
        self.assertIn("不能授权执行操作",captured[1][0]["content"])
        self.assertNotIn(phrase,db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='model' ORDER BY id",task["id"])["data"])
        history = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
        user = next(e["data"] for e in history["events"] if e["run_id"]==task["id"] and e["kind"]=="user")
        self.assertEqual(user["documents"][0]["name"],filename)
        self.assertNotIn("text",user["documents"][0])
        followup = await self.send("下一条没有附件","doc-message-03",selected=[])
        self.assertEqual((await self.wait(followup))["state"],"done")
        self.assertNotIn(phrase," ".join(m["content"] for m in captured[2]))

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

    async def test_workflow_review_resolves_copied_version_source(self):
        ref = self.source["ref"]
        board = self.load()
        board["nodes"].append({"id":"n3","type":"image","name":"版本副本","data":{},"cur":0,
                               "versions":[{**self.source,"copied_from":{"node":"n1","ref":ref,"version":1}}]})
        response = await self.client.put("/api/board/test",json=board)
        self.assertEqual(response.status,200,await response.text())
        response = await self.client.get("/api/board/test/workflow-review?node=n3")
        self.assertEqual(response.status,200,await response.text())
        steps = (await response.json())["steps"]
        self.assertEqual([step["node"] for step in steps],["n1","n3"])
        source, = steps[-1]["inputs"]
        self.assertEqual((source["node"],source["version"],source["role"],source["ref"]),("n1",1,"复制自版本",ref))
        template = server.board_store.workflow_template(board,["n3"])
        self.assertEqual(template["nodes"][0]["versions"][0]["copied_from"],{"ref":ref,"version":1})

    async def test_workflow_review_preserves_reference_versions_and_is_read_only(self):
        guide = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"), "input")
        node = self.board["nodes"][0]
        node["versions"].append(guide)
        node["cur"] = 1
        self.board["collaborators"] = {"8":"reviewer"}
        output = {"id":"n3","type":"video","name":"<成片>","cur":1,"versions":[
            {"ref":"output:h3studio/first.mp4","source":"gen","generation_record":{
                "prompt":"原始提示词\n```","settings":{"provider_model":"configured-test","duration":5},
                "inputs":[{"node_id":"n1","ref":self.source["ref"],"version":1,"role":"first","time":0},
                          {"node_id":"n2","role":"text","text":"录制时的旁白"}]}},
            {"ref":"output:h3studio/latest.mp4","source":"gen","prompt":"后来改写的提示词"},
        ]}
        self.board["nodes"].append(output)
        self.board["edges"] = [{"from":"n2","to":"n3"}]
        path = server.board_path("test")
        baseline = chat.dumps(self.board)
        path.write_text(baseline)
        url = "/api/board/test/workflow-review?node=n3&version=1"
        response = await self.client.get(url, headers={"X-Uid":"8"})
        self.assertEqual(response.status, 200)
        review = await response.json()
        self.assertEqual([(s["node"],s["version"]) for s in review["steps"]], [("n1",1),("n2",None),("n3",1)])
        self.assertEqual(review["steps"][-1]["inputs"][0]["evidence"], "生成记录")
        self.assertIn("录制时的旁白", review["markdown"])
        self.assertIn("configured-test", review["markdown"])
        self.assertNotIn("后来改写", review["markdown"])
        self.assertIn("````\n原始提示词", review["markdown"])
        self.assertNotIn("<成片>", review["markdown"])
        denied = await self.client.get(url, headers={"X-Uid":"9"})
        self.assertEqual(denied.status, 404)
        latest = await self.client.get("/api/board/test/workflow-review?node=n3")
        dependencies = (await latest.json())["steps"][-1]["inputs"]
        self.assertEqual(dependencies[0]["evidence"], "当前连线")
        self.assertEqual((await self.client.get("/api/board/test/workflow-review?node=n3&version=4")).status, 404)

        self.svc.model.side_effect = [call("canvas_workflow_review", {"node_id":"n3","version":1}), answer("复盘完成")]
        rid = await self.send("第一个版本怎么做的")
        self.assertEqual((await self.wait(rid))["state"], "done")
        data = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])
        self.assertEqual(data["workflow"]["version"], 1)
        self.assertEqual(data["workflow"]["steps"][-1]["inputs"][0]["ref"], self.source["ref"])
        self.assertEqual(path.read_text(), baseline)

    async def test_reference_plan_pins_replacement_and_does_not_modify_canvas(self):
        board = self.load()
        latest = image_editor.save(server.COMFY_DIR, Image.new("RGB", (60, 32), "blue"), "input")
        board["nodes"].extend([
            {"id":"replacement","type":"image","name":"新素材","x":1200,"y":100,
             "data":{},"versions":[self.source,latest],"cur":1},
            {"id":"target","type":"image","name":"镜头","x":1600,"y":100,
             "data":{},"versions":[],"cur":-1},
        ])
        board["groups"] = [{"id":"shots","name":"镜头组","nodes":["target","n2"]}]
        board["edges"] = [{"from":"n1","to":"target","ref":self.source["ref"],"prompt_slot":4}]
        path = server.board_path("test")
        server.write_board(path, board)
        original = path.read_text()
        args = {"source_node_id":"n1","replacement_node_id":"replacement","group_id":"shots","version":1}
        self.svc.model.side_effect = [call("canvas_reference_plan",args),answer("请在预览中确认")]
        rid = await self.send("换一下镜头组的参考素材")
        self.assertEqual((await self.wait(rid))["state"], "done")
        plan = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])["reference_plan"]
        self.assertEqual((plan["board"],plan["source"],plan["replacement"],plan["version"],plan["ref"],plan["group"]),
                         ("test","n1","replacement",1,self.source["ref"],"shots"))
        self.assertEqual(path.read_text(), original)
        self.svc.model.side_effect = [call("canvas_reference_plan",{**args,"replacement_node_id":"n2"}),answer()]
        invalid = await self.send("改用不匹配的素材",key="reference-plan-invalid")
        self.assertEqual((await self.wait(invalid))["state"], "done")
        error = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", invalid)["result"])
        self.assertIn("类型相同",error["error"])
        self.assertEqual(path.read_text(), original)
        memory = await self.client.post("/api/memory",json={"kind":"character","board":"test",
            "name":"林森","ref":self.source["ref"],"character_view":"main"})
        self.assertEqual(memory.status,200,await memory.text())
        memory_id = (await memory.json())["id"]
        side = await self.client.post("/api/memory",json={"id":memory_id,"board":"test","ref":latest["ref"],"character_view":"side"})
        self.assertEqual(side.status,200,await side.text())
        memory_args = {"source_node_id":"n1","memory_id":memory_id,"character_view":"side","target_ids":["target"]}
        self.svc.model.side_effect = [call("canvas_reference_plan",memory_args),answer("已准备侧面图")]
        rid = await self.send("只把镜头的参考换成林森侧面图",key="reference-plan-memory")
        self.assertEqual((await self.wait(rid))["state"], "done")
        asset_plan = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])["reference_plan"]
        self.assertEqual((asset_plan["memory"],asset_plan["ref"],asset_plan["character_view"],asset_plan["targets"]),
                         (memory_id,latest["ref"],"side",["target"]))
        self.assertEqual(path.read_text(), original)
        self.svc.model.side_effect = [call("canvas_reference_plan",{**memory_args,"character_view":"back"}),answer()]
        rid = await self.send("改用林森背面图",key="reference-plan-unapproved")
        self.assertEqual((await self.wait(rid))["state"], "done")
        error = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])
        self.assertIn("尚未定稿",error["error"])

    async def test_group_run_plan_is_scoped_and_does_not_submit_jobs(self):
        board = self.load()
        board["nodes"].append({"id":"n3","type":"video","name":"待生成镜头","x":1100,"y":80,
                               "data":{"prompt":"横移"},"versions":[],"cur":-1})
        board["groups"] = [{"id":"shots","name":"镜头组","nodes":["n1","n2","n3"]}]
        path = server.board_path("test")
        server.write_board(path, board)
        baseline = path.read_text()
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots"}),answer("请确认运行计划")]
        rid = await self.send("补齐镜头组")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertEqual(result["group_run_plan"],{"board":"test","group":"shots","name":"镜头组","targets":["n3"],"mode":"missing"})
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots","target_ids":["n1"]}),answer()]
        rid = await self.send("只重跑参考图",key="specific-group-run")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertEqual((result["group_run_plan"]["targets"],result["group_run_plan"]["mode"]),(["n1"],"all"))
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots","target_ids":["n2"]}),answer()]
        rid = await self.send("运行文字节点",key="invalid-group-run")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertIn("无法在分组内生成",result["error"])
        self.assertEqual(path.read_text(),baseline)

    async def test_new_storyboard_uses_the_shared_splitter_without_writing_the_board(self):
        path = server.board_path("test")
        before = path.read_text()
        setup = {"title":"开门","shots":[{"duration":20,"action":["找到钥匙","打开门"]}]}
        repaired = {"replacements":[{"shot":1,"shots":[
            {"duration":10,"action":["找到钥匙"],"keyframe":"桌边看见钥匙"},
            {"duration":10,"action":["打开门"],"keyframe":"手靠近门把"},
        ]}]}
        llm = SimpleNamespace(chat=AsyncMock(side_effect=[json.dumps(setup),json.dumps(repaired)]))
        self.svc.model.side_effect = [
            call("storyboard_create_plan",{"story":"找到钥匙，打开门。","target_seconds":20,"aspect":"9:16","image_nodes":["n1"]}),
            answer("已拟好镜头"),
        ]
        with patch.dict(self.app,{"llm":llm}):
            rid = await self.send("做一个 20 秒分镜",selected=["n1"])
            self.assertEqual((await self.wait(rid))["state"],"done")
        result = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='storyboard_create_plan'",rid)
        plan = json.loads(result["result"])["storyboard_create"]
        self.assertEqual((plan["board"],plan["aspect"],plan["planned_seconds"]),("test","9:16",20))
        self.assertEqual([shot["duration"] for shot in plan["shots"]],[10,10])
        self.assertEqual(plan["refs"],[{"node":"n1","ref":self.source["ref"],"name":"产品"}])
        self.assertEqual(llm.chat.await_count,2)
        self.assertEqual(path.read_text(),before)
        self.assertFalse(server.JOBS)

    async def test_storyboard_binds_assets_to_their_shots_on_canvas_and_in_assistant(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        hero = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                              "source_board":"test","character_view":"main"})
        face = image_editor.save(server.COMFY_DIR,Image.new("RGB",(64,64),"blue"))
        b = self.load()
        b["nodes"][0]["versions"].append(face)
        server.write_board(server.board_path("test"),b)
        store.put(user,{"id":hero["id"],"ref":face["ref"],"source_board":"test","character_view":"face"})
        station = store.put(user,{"board":"test","kind":"scene","name":"站台","desc":"玻璃顶棚"})
        await self.client.put("/api/board/another",json={"nodes":[]})
        hidden = store.put(user,{"board":"another","kind":"document","name":"其他项目资料"})
        story = "林森在站台转身。接着拍远处的天空。"
        token = "@{"+hero["id"]+"#face|林森}"
        proposed = {"title":"站台","shots":[
            {"duration":5,"scene":"站台","characters":["林森"],"action":["转身"],"keyframe":"人物站在月台中央",
             "asset_refs":[{"id":station["id"],"view":"main"}]},
            {"duration":5,"scene":"天空","action":["云慢慢飘过"],"keyframe":"远处的天空",
             "asset_refs":[{"id":hidden["id"]}]},
        ]}
        llm = SimpleNamespace(chat=AsyncMock(return_value=json.dumps(proposed)),available=lambda: True,via="fixture")
        self.svc.model.side_effect = [call("storyboard_create_plan",{"story":story}),answer()]
        with patch.dict(self.app,{"llm":llm}):
            rid = await self.send(text=f"用 {token} 做分镜，{story}")
            self.assertEqual((await self.wait(rid))["state"],"done")
            endpoint = await self.client.post("/api/storyboard",json={"board":"test","story":token+"，"+story})
            self.assertEqual(endpoint.status,200,await endpoint.text())
            from_canvas = await endpoint.json()
        row = db.one("SELECT result FROM chat_calls WHERE run_id=? AND name='storyboard_create_plan'",rid)
        from_assistant = json.loads(row["result"])["storyboard_create"]
        for result in (from_canvas,from_assistant):
            self.assertEqual(result["shots"][0]["asset_refs"],[
                {"id":station["id"],"name":"站台","kind":"scene"},
                {"id":hero["id"],"name":"林森","kind":"character","view":"face"},
            ])
            self.assertNotIn("asset_refs",result["shots"][1])
        for invocation in llm.chat.await_args_list:
            planner_input = invocation.args[1][0]["text"]
            self.assertIn("asset_refs",planner_input)
            self.assertIn(hero["id"],planner_input)
            self.assertIn('"preferred_views": ["face"]',planner_input)
            self.assertNotIn(hidden["id"],planner_input)

    async def test_storyboard_continuation_and_revisions_validate_shot_asset_changes(self):
        user = {"id":7,"role":"member"}
        store = self.app["creative_memory"]
        hero = store.put(user,{"board":"test","kind":"character","name":"林森","ref":self.source["ref"],
                              "source_board":"test","character_view":"main"})
        store.put(user,{"id":hero["id"],"ref":self.source["ref"],"source_board":"test","character_view":"face"})
        room = store.put(user,{"board":"test","kind":"scene","name":"旧房"})
        bridge = store.put(user,{"board":"test","kind":"scene","name":"桥面"})
        extra = store.put(user,{"board":"test","kind":"character","name":"小孟"})
        await self.client.put("/api/board/another",json={"nodes":[]})
        hidden = store.put(user,{"board":"another","kind":"scene","name":"其他画布"})
        previous = {"duration":5,"shot_size":"中景","camera":"缓推","scene":"窗边暖光","characters":["林森"],
                    "action":["拿起木盒"],"dialogue":[],"sound":"风声","keyframe":"木盒在窗台",
                    "asset_refs":[{"id":room["id"],"name":"旧房","kind":"scene"}]}
        b = self.load()
        b["nodes"].append({"id":"story","type":"script","name":"换景","data":{"shots":[previous]},"cur":-1,"versions":[]})
        server.write_board(server.board_path("test"),b)
        baseline = self.load()
        next_shot = {**previous,"scene":"桥面","asset_refs":[
            {"memory_id":hero["id"]},{"memory_id":bridge["id"]},
        ]}
        self.svc.model.side_effect = [
            call("storyboard_context",{"node_id":"story"},"read"),
            call("storyboard_next_shot_plan",{"node_id":"story","after_shot":1,"shot":next_shot},"next"),
            call("storyboard_revision_plan",{"node_id":"story","shot":1,"changes":{"asset_refs":[]}},"clear"),
            call("storyboard_revision_plan",{"node_id":"story","shot":1,
                 "changes":{"asset_refs":[{"memory_id":hidden["id"]}]}},"hidden"),
            call("storyboard_revision_plan",{"node_id":"story","shot":1,
                 "changes":{"asset_refs":[{"memory_id":extra["id"],"views":["back"]}]}},"undrafted"),
            call("storyboard_revision_plan",{"node_id":"story","shot":1,
                 "changes":{"asset_refs":[{"memory_id":hero["id"],"views":["main"]}]}},"replace-view"),
            answer(),
        ]
        explicit = "@{"+hero["id"]+"#face|林森}"
        rid = await self.send(f"用 {explicit} 续写，并清除上一镜的场景参考",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        results = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)]
        context, next_plan, clear = results[0]["storyboard"],results[1]["storyboard_plan"],results[2]["shot_revision"]
        self.assertEqual(context["shots"][0]["asset_refs"],previous["asset_refs"])
        self.assertEqual(next_plan["anchor"]["last"]["asset_refs"],previous["asset_refs"])
        self.assertEqual(next_plan["shot"]["asset_refs"],[
            {"id":hero["id"],"name":"林森","kind":"character","view":"face"},{"id":bridge["id"],"name":"桥面","kind":"scene"},
        ])
        self.assertEqual(clear["before"]["asset_refs"],previous["asset_refs"])
        self.assertEqual(clear["changes"],{"asset_refs":[]})
        self.assertIn("不可访问",results[3]["error"])
        self.assertIn("未定稿",results[4]["error"])
        self.assertEqual(results[5]["shot_revision"]["changes"]["asset_refs"],
                         [{"id":hero["id"],"name":"林森","kind":"character","view":"main"}])
        self.assertEqual(self.load(),baseline)

    async def test_storyboard_continuation_reads_pinned_reference_and_prepares_one_shot(self):
        current = image_editor.save(server.COMFY_DIR,Image.new("RGB",(60,32),"blue"),"input")
        board = self.load()
        board["nodes"][0]["versions"].append(current)
        board["nodes"][0]["cur"] = 1
        previous = {"duration":5,"shot_size":"中景","camera":"缓推","scene":"窗边暖光","characters":["林森"],
                    "action":["林森右手拿起木盒"],"dialogue":[],"sound":"风声","keyframe":"木盒还放在窗台上"}
        next_shot = {**previous,"shot_size":"近景","keyframe":"林森右手握住木盒","action":["林森用左手打开盒盖"]}
        board["nodes"].append({"id":"story","type":"script","name":"窗边分镜","x":1000,"y":80,
                               "data":{"style":"写实暖光","characters":[{"name":"林森","look":"深蓝外套"}],"shots":[previous]},
                               "cur":-1,"versions":[]})
        board["edges"].append({"from":"n1","to":"story","ref":self.source["ref"]})
        path = server.board_path("test")
        server.write_board(path,board)
        previous_board = path.read_text()
        self.svc.model.side_effect = [
            call("storyboard_context",{"node_id":"story"},"read-story"),
            call("storyboard_next_shot_plan",{"node_id":"story","after_shot":1,"shot":next_shot},"plan-shot"),
            answer("下一镜草案已准备"),
        ]
        rid = await self.send("续写下一镜",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        results = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=?",rid)]
        context = next(row["storyboard"] for row in results if "storyboard" in row)
        self.assertEqual(context["shots"][-1]["action"],previous["action"])
        self.assertEqual((context["references"][0]["version"],context["references"][0]["ref"]),(1,self.source["ref"]))
        plan = next(row["storyboard_plan"] for row in results if "storyboard_plan" in row)
        self.assertEqual(plan["anchor"]["last"],{**previous,"asset_refs":None})
        self.assertEqual(plan["shot"],next_shot)
        self.assertEqual(path.read_text(),previous_board)
        script = board["nodes"][-1]
        anchor_ref, current_ref = "output:h3studio/previous.mp4", "output:h3studio/current.mp4"
        tail_ref = "input:h3studio/continuity.png"
        script["data"]["shots"] = [{**previous,"id":"previous-shot"},{**next_shot,"id":"next-shot"}]
        script["data"]["made"] = [{"shot_id":"previous-shot","vid":"previous-video"},{"shot_id":"next-shot","img":"next-image"}]
        board["nodes"].extend([
            {"id":"previous-video","type":"video","name":"镜1","data":{},"cur":1,"versions":[{"ref":anchor_ref},{"ref":current_ref}]},
            {"id":"tail","type":"image","name":"上一镜尾帧","data":{},"cur":0,"versions":[{"ref":tail_ref,
                "capture":{"position":"last","source_node":"previous-video","source_ref":anchor_ref}}]},
            {"id":"next-image","type":"image","name":"镜2 · 分镜图","data":{},"cur":0,"versions":[{"ref":"output:h3studio/new.png",
                "generation_record":{"inputs":[{"ref":self.source["ref"]}]}}]},
        ])
        board["edges"].append({"from":"tail","to":"next-image","ref":tail_ref,"story_continuity":True})
        server.write_board(path,board)
        self.svc.model.side_effect = [call("storyboard_context",{"node_id":"story","from_shot":2}),answer("第2镜尾帧已过期")]
        rid = await self.send("检查第二镜的尾帧",key="check-storyboard-tail",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        context = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])["storyboard"]
        row, = context["shots"]
        self.assertEqual(row["canvas"]["image_node"],"next-image")
        continuity = row["continuity"]
        self.assertEqual((continuity["state"],continuity["captured_from_ref"],continuity["previous_video_ref"],
                          continuity["previous_version"],continuity["image_used_tail"]),
                         ("stale",anchor_ref,current_ref,2,False))
        reordered = {**script,"data":{**script["data"],"shots":script["data"]["shots"][::-1]}}
        first = self.svc.storyboard_context(board,reordered)["shots"][0]
        self.assertEqual(first["canvas"]["image_node"],"next-image")
        self.assertEqual(first["continuity"]["state"],"no_previous")
        self.assertEqual(first["continuity"]["tail_ref"],tail_ref)
        baseline = path.read_text()
        self.svc.model.side_effect = [call("storyboard_revision_plan",{"node_id":"story","shot":2,
            "changes":{"keyframe":"左手握住木盒","scene":next_shot["scene"]}}),answer("请确认")]
        rid = await self.send("改第二镜的首帧",key="revise-storyboard",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        plan = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])["shot_revision"]
        self.assertEqual((plan["shot"],plan["shot_id"]),(2,"next-shot"))
        self.assertEqual(plan["before"],{"keyframe":next_shot["keyframe"]})
        self.assertEqual(plan["changes"],{"keyframe":"左手握住木盒"})
        storyboard_range = call("storyboard_range_run_plan",{"node_id":"story","first":1,"last":2,
            "stage":"frame","tail_mode":"connect_and_refresh"},"plan-range")
        write_attempt = call("canvas_create_text",{"text":"应该等待确认"},"try-before-confirm")
        self.svc.model.side_effect = [{**storyboard_range,"tool_calls":storyboard_range["tool_calls"]+write_attempt["tool_calls"]},answer()]
        rid = await self.send("只补第 1 到 2 镜的分镜图，有上一镜的都用最新尾帧",key="plan-shot-range",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        prepared, blocked = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",rid)]
        self.assertEqual(prepared["shot_range_plan"]["anchors"],[{"id":"previous-shot"},{"id":"next-shot"}])
        self.assertEqual(prepared["shot_range_plan"]["mode"],"missing_frame")
        self.assertEqual(prepared["shot_range_plan"]["tail_mode"],"connect_and_refresh")
        self.assertIn("确认运行",blocked["error"])
        self.assertEqual(path.read_text(),baseline)
        self.svc.model.side_effect = [call("storyboard_range_run_plan",{"node_id":"story","first":1,"last":2,
            "stage":"video","tail_mode":"refresh"}),answer()]
        rid = await self.send("只生成第 1 到 2 镜的视频，并更新分镜图的尾帧引用",key="video-with-tail",selected=["story"])
        self.assertEqual((await self.wait(rid))["state"],"done")
        rejected = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertIn("尾帧用于生成分镜图",rejected["error"])
        self.assertNotIn("shot_range_plan",rejected)
        self.assertEqual(path.read_text(),baseline)

    async def test_visual_continuity_review_uses_pinned_boundary_frames_without_writing(self):
        board = self.load()
        old, current, next_video = ("input:h3studio/previous.mp4","input:h3studio/current.mp4","input:h3studio/next.mp4")
        board["nodes"].extend([
            {"id":"story","type":"script","name":"分镜","data":{"shots":[{"id":"first"},{"id":"second","keyframe":"木盒放在桌边"}],
             "made":[{"shot_id":"first","vid":"previous-video"},{"shot_id":"second","vid":"next-video","img":"n1"}]},"versions":[],"cur":-1},
            {"id":"previous-video","name":"镜1","type":"video","data":{},"versions":[{"ref":old},{"ref":current}],"cur":1},
            {"id":"next-video","name":"镜2","type":"video","data":{},"versions":[{"ref":next_video}],"cur":0},
        ])
        path = server.board_path("test")
        server.write_board(path,board)
        baseline = path.read_text()
        before = set(server.COMFY_DIR.rglob("*"))
        vision = AsyncMock(return_value="木盒位置从右手变到桌边，建议保持在右手。")
        user_args = {"node_id":"story","shot":2,"previous_version":1}
        with patch.object(self.app["llm"],"available",return_value=True), patch.object(self.app["llm"],"chat",vision,create=True), \
             patch.object(server.film,"capture_frame",return_value=(Image.new("RGB",(24,24),"blue"),0)) as capture:
            self.svc.model.side_effect = [call("storyboard_visual_review",user_args),answer()]
            rid = await self.send("对比前后两镜",selected=["story"])
            self.assertEqual((await self.wait(rid))["state"],"done")
            result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            self.assertEqual((result["shot_review"]["left"]["ref"],result["shot_review"]["right"]["ref"]),(old,next_video))
            self.assertEqual([(call.args[0].name,call.args[1]) for call in capture.call_args_list],[("previous.mp4","last"),("next.mp4","first")])
            self.assertEqual([part["type"] for part in vision.await_args.args[1]],["text","image_url","text","image_url"])
            self.svc.model.side_effect = [call("storyboard_visual_review",{**user_args,"current_type":"image"}),answer()]
            rid = await self.send("换成分镜图看",key="visual-review-use-still",selected=["story"])
            self.assertEqual((await self.wait(rid))["state"],"done")
            result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            self.assertEqual((result["shot_review"]["right"]["kind"],result["shot_review"]["right"]["ref"]),("image",self.source["ref"]))
            self.assertEqual(capture.call_count,3)
            def sampled_frame(path,position,at=None):
                seconds = {"first":0,"last":2}.get(position,at)
                return Image.new("RGB",(24,24),"blue"),seconds

            capture.side_effect = sampled_frame
            self.svc.model.side_effect = [call("storyboard_visual_review",{**user_args,"motion":True}),answer()]
            rid = await self.send("核对人物移动方向",key="visual-review-motion",selected=["story"])
            self.assertEqual((await self.wait(rid))["state"],"done")
            result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            review = result["shot_review"]
            self.assertEqual((review["left"]["ref"],review["right"]["ref"]),(old,next_video))
            self.assertEqual([[round(frame["seconds"],1) for frame in review["samples"][side]] for side in ("left","right")],
                             [[1.2,1.6,2],[0,.4,.8]])
            self.assertEqual([part["type"] for part in vision.await_args.args[1]],["text","image_url"]*6)
            endpoint = f"/api/chat/sessions/{self.sid}/messages"
            payload = {"text":"审阅选中的视频版本","request_key":"direct-visual-motion","enqueue":True,
                       "shot_review":{"node_id":"story","shot":2,"current_type":"video",
                       "left":{"node":"previous-video","ref":old,"version":2},
                       "right":{"node":"next-video","ref":next_video,"version":1}}}
            model_calls = self.svc.model.await_count
            response = await self.client.post(endpoint,json=payload)
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            self.assertEqual((await self.wait(rid))["state"],"done")
            result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
            self.assertEqual((result["shot_review"]["left"]["ref"],result["shot_review"]["left"]["version"]),(old,1))
            self.assertIn("samples",result["shot_review"])
            self.assertEqual(self.svc.model.await_count,model_calls)
            repeat = await self.client.post(endpoint,json=payload)
            self.assertEqual((await repeat.json())["id"],rid)
            source_call = db.one("SELECT id FROM chat_calls WHERE run_id=?",rid)["id"]
            self.svc.model.side_effect = [
                call("canvas_create_text",{"text":"不应执行"},"wrong-tool"),
                call("storyboard_revision_plan",{"node_id":"story","shot":1,"changes":{"keyframe":"改错了镜头"}},"wrong-shot"),
                call("storyboard_revision_plan",{"node_id":"story","shot":2,"changes":{"keyframe":"木盒一直在右手"}},"right-shot"),answer(),
            ]
            revise = await self.client.post(endpoint,json={"text":"按审阅拟修改","request_key":"revise-visual-motion",
                                                           "review_revision_call":source_call,"enqueue":True})
            self.assertEqual(revise.status,200,await revise.text())
            revision_run = (await revise.json())["id"]
            self.assertEqual((await self.wait(revision_run))["state"],"done")
            plans = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",revision_run)]
            self.assertIn("只为已审阅的镜头",plans[0]["error"])
            self.assertIn("审阅指向的当前镜头",plans[1]["error"])
            self.assertEqual((plans[2]["shot_revision"]["shot_id"],plans[2]["shot_revision"]["before"]),
                             ("second",{"keyframe":"木盒放在桌边"}))
            model_input = self.svc.model.await_args_list[model_calls].args[0][0]["content"]
            self.assertIn(vision.return_value,model_input)
            self.assertIn(old,model_input)
            payload["request_key"] = "direct-visual-stale"
            payload["shot_review"]["left"]["ref"] = "input:h3studio/removed.mp4"
            count = vision.await_count
            removed = await self.client.post(endpoint,json=payload)
            self.assertEqual(removed.status,200,await removed.text())
            failed = (await removed.json())["id"]
            self.assertEqual((await self.wait(failed))["state"],"error")
            error = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",failed)["result"])["error"]
            self.assertIn("版本不可用",error)
            self.assertEqual(vision.await_count,count)
        self.assertEqual(path.read_text(),baseline)
        self.assertEqual(set(server.COMFY_DIR.rglob("*")),before)

    async def test_private_skill_can_be_loaded_automatically_with_references(self):
        payload = {"name": "样片审稿", "description": "检查镜头的交付格式", "instructions": "按照三列格式写反馈",
                   "references": {"notes/checklist.md": "逐镜检查片尾字幕"}, "automatic": True}
        response = await self.client.post("/api/chat/skills", json=payload)
        self.assertEqual(response.status, 200, await response.text())
        skill = await response.json()
        sid = skill["id"]
        for method in ("GET", "DELETE"):
            response = await self.client.request(method, f"/api/chat/skills/{sid}", headers={"X-Uid": "8"})
            self.assertEqual(response.status, 404)
        response = await self.client.post("/api/chat/skills", json={**payload, "id": sid}, headers={"X-Uid": "8"})
        self.assertEqual(response.status, 404)
        response = await self.client.get("/api/chat/skills", headers={"X-Uid": "8"})
        self.assertNotIn(sid, {s["id"] for s in await response.json()})
        self.svc.model.side_effect = [
            call("creative_skill_load", {"skill_id": sid}, "skill"),
            call("creative_skill_load", {"skill_id": sid, "reference": "notes/checklist.md"}, "reference"),
            answer("检查完成"),
        ]
        rid = await self.send("检查这段样片的交付格式")
        self.assertEqual((await self.wait(rid))["state"], "done")
        first, second, third = [args.args[0][0]["content"] for args in self.svc.model.await_args_list]
        self.assertIn(payload["description"], first)
        self.assertNotIn(payload["instructions"], first)
        self.assertIn(payload["instructions"], second)
        self.assertNotIn(payload["references"]["notes/checklist.md"], second)
        self.assertIn(payload["references"]["notes/checklist.md"], third)
        response = await self.client.get(f"/api/chat/sessions/{self.sid}")
        events = (await response.json())["events"]
        self.assertNotIn(payload["instructions"], chat.dumps(events))
        self.assertEqual([e["data"]["result"]["skill"]["name"] for e in events if e["kind"] == "tool_end"],
                         [payload["name"], payload["name"]])

    async def test_skill_attachment_is_explicit_and_survives_idempotent_retry(self):
        payload = {"name": "构图校对", "description": "构图", "instructions": "保留构图与留白", "automatic": False}
        response = await self.client.post("/api/chat/skills", json=payload)
        skill = await response.json()
        auto = await self.send("普通聊天")
        await self.wait(auto)
        self.assertNotIn(skill["id"], self.svc.model.await_args.args[0][0]["content"])
        request = {"text": "帮我校对", "request_key": "skill-manual", "skill_id": skill["id"]}
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json=request)
        rid = (await response.json())["id"]
        await self.wait(rid)
        self.assertIn(payload["instructions"], self.svc.model.await_args.args[0][0]["content"])
        response = await self.client.delete("/api/chat/skills/" + skill["id"])
        self.assertEqual(response.status, 200)
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json=request)
        self.assertEqual((await response.json())["id"], rid)
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",
                                          json={**request, "request_key": "skill-new-key"})
        self.assertEqual(response.status, 400)
        response = await self.client.get(f"/api/chat/sessions/{self.sid}")
        events = (await response.json())["events"]
        self.assertEqual([e["data"].get("skill", {}).get("name") for e in events if e["kind"] == "user"],
                         [None, payload["name"]])
        rid = await self.send("继续聊其他话题", key="skill-clear")
        await self.wait(rid)
        self.assertNotIn(payload["instructions"], self.svc.model.await_args.args[0][0]["content"])

    async def test_transcription_uses_configured_routes_without_adding_messages(self):
        provider = server.providers
        response = await self.client.get("/api/transcription")
        self.assertEqual(await response.json(), {"available": False})
        response = await self.client.post("/api/transcription", json={})
        self.assertEqual(response.status, 503)

        primary = provider.save(None, "asr_compat", "主服务", {"base_url": "https://primary.invalid/v1"}, {}, True)
        backup = provider.save(None, "asr_compat", "备用服务", {"base_url": "https://backup.invalid/v1"}, {}, True)
        provider.set_route("asr", [{"provider_id": primary}, {"provider_id": backup, "model": "backup-model"}])
        response = await self.client.get("/api/transcription")
        self.assertEqual(await response.json(), {"available": True})

        def form(audio):
            data = aiohttp.FormData()
            data.add_field("file", audio, filename="test.wav", content_type="audio/wav")
            return data

        transcribe = AsyncMock(side_effect=[provider.ProviderError("offline"), "把这张图调暖"])
        with patch.object(provider, "transcribe", transcribe):
            response = await self.client.post("/api/transcription", data=form(b"<html>"))
            self.assertEqual(response.status, 400)
            with patch.object(audio_routes, "ASR_AUDIO_LIMIT", 12):
                response = await self.client.post("/api/transcription", data=form(b"RIFF0000WAVEdata"))
                self.assertEqual(response.status, 413)
            transcribe.assert_not_awaited()
            response = await self.client.post("/api/transcription", data=form(b"RIFF0000WAVE"))
        self.assertEqual(await response.json(), {"text": "把这张图调暖"})
        self.assertEqual([(c.args[1]["id"], c.args[2]) for c in transcribe.await_args_list],
                         [(primary, "gpt-transcribe"), (backup, "backup-model")])
        self.assertFalse(db.q("SELECT id FROM chat_runs"))

        sample = io.BytesIO()
        with wave.open(sample, "wb") as audio:
            audio.setparams((2,2,48000,0,"NONE",""))
            audio.writeframes(b"\x12\x01\x20\x01" * 48000)
        preview = AsyncMock(return_value="初步转写")
        with patch.object(provider,"transcribe",preview):
            response = await self.client.post("/api/transcription?preview=1",data=form(b"RIFF0000WAVE"))
            self.assertEqual(response.status,400)
            preview.assert_not_awaited()
            response = await self.client.post("/api/transcription?preview=1",data=form(sample.getvalue()))
        self.assertEqual(await response.json(),{"text":"初步转写"})
        _, _, _, payload, extension, content_type = preview.await_args.args
        self.assertEqual((extension,content_type),(".wav","audio/wav"))
        with wave.open(io.BytesIO(payload),"rb") as audio:
            self.assertEqual((audio.getnchannels(),audio.getframerate()),(1,16000))
            self.assertGreater(audio.getnframes(),15000)
        self.assertFalse(db.q("SELECT id FROM chat_runs"))

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

    async def test_empty_image_node_receives_generated_candidates_in_place(self):
        self.board["nodes"].append({"id":"empty","type":"image","name":"封面","x":800,"y":120,
                                    "data":{},"versions":[],"cur":-1,"job":None})
        server.write_board(server.board_path("test"),self.board)
        media = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,96),"blue"))
        async def submit(req, payload):
            ids = [f"e{i:012}" for i in range(payload["count"])]
            for jid in ids:
                server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},
                                    "outputs":[{"ref":media["ref"],"meta":{"width":128,"height":96}}]}
            return web.json_response({"ids":ids})
        self.svc.model.side_effect = [call("image_generate",{"prompt":"电影感夜景","count":2}),answer()]
        route = f"/api/chat/sessions/{self.sid}/messages"
        payload = {"text":"生成两张封面","request_key":"target-image-1","selected":["empty"],"empty_media_node":"empty"}
        with patch.object(generation_requests,"generate_request",submit):
            response = await self.client.post(route,json=payload)
            self.assertEqual(response.status,200,await response.text())
            rid = (await response.json())["id"]
            finished = await self.wait(rid)
            self.assertEqual(finished["state"],"done",finished["error"])
        loaded = self.load()["nodes"]
        self.assertEqual([node["id"] for node in loaded],["n1","n2","empty"])
        self.assertEqual([v["ref"] for v in loaded[-1]["versions"]],[media["ref"],media["ref"]])
        self.assertEqual((await self.client.post(route,json={**payload,"request_key":"target-image-2"})).status,400)

    async def test_empty_video_and_audio_nodes_receive_generation_in_place(self):
        for kind in ("video","audio"):
            self.board["nodes"].append({"id":kind,"type":kind,"name":kind,"x":800,"y":120,
                                        "data":{},"versions":[],"cur":-1,"job":None})
        server.write_board(server.board_path("test"),self.board)
        video_ref, audio_ref = "output:h3studio/target.mp4", "output:h3studio/target.wav"
        def job(jid, ref):
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[{"ref":ref}]}
            return [jid]
        async def submit_video(req, payload):
            return web.json_response({"ids":job("e000000000001",video_ref)})
        async def submit_audio(req):
            request = await req.json()
            self.assertEqual(request["node"],"audio")
            return web.json_response({"ids":job("e000000000002",audio_ref),
                                      "recipe":{"mode":"tts","prompt":request["prompt"]}})
        with patch.object(generation_requests,"generate_request",submit_video), patch.object(audio_routes,"generate_audio",submit_audio), \
             patch.object(media_routes,"media_info",return_value={"width":128,"height":96,"duration":2}):
            for kind, ref in (("video",video_ref),("audio",audio_ref)):
                with self.subTest(kind=kind):
                    self.svc.model.side_effect = [call(kind+"_generate",{"prompt":"雨夜"}),answer()]
                    route = f"/api/chat/sessions/{self.sid}/messages"
                    response = await self.client.post(route,json={"text":"开始生成","request_key":"target-"+kind,
                                                                 "selected":[kind],"empty_media_node":kind})
                    self.assertEqual(response.status,200,await response.text())
                    finished = await self.wait((await response.json())["id"])
                    self.assertEqual(finished["state"],"done",finished["error"])
                    nodes = {node["id"]:node for node in self.load()["nodes"]}
                    self.assertEqual(set(nodes),{"n1","n2","video","audio"})
                    self.assertEqual(nodes[kind]["versions"][0]["ref"],ref)

    async def test_generate_real_handler_shape_and_continue(self):
        made = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        received = []

        async def submit(req, payload):
            received.append(payload)
            for i in range(payload["count"]):
                jid = "e" + str(i).zfill(12)
                server.JOBS[jid] = {"state": "done", "created": 1, "meta": {"uid": 7, "seed": 42},
                                    "outputs": [{"ref": made["ref"], "meta": {"width": 128, "height": 96}}]}
            return web.json_response({"ids": list(server.JOBS)})

        self.svc.model.side_effect = [call("image_generate", {"prompt": "暖色产品图", "reference_ids": ["n1"], "count": 3}), answer("三个版本已生成")]
        with patch.object(generation_requests, "generate_request", submit):
            rid = await self.send(placement={"x":-500,"y":-300})
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])
        self.assertEqual(len(self.load()["nodes"]), 5)
        results = [n for n in self.load()["nodes"] if n["id"] not in ("n1", "n2")]
        self.assertEqual(len({n["id"] for n in results}), 3)
        self.assertEqual((results[0]["x"],results[0]["y"]),(-500,-300))
        for first, second in zip(results, results[1:]):
            self.assertGreaterEqual(second["x"],first["x"]+self.svc.placement_size(first)[0])
            self.assertEqual(second["y"],first["y"])
        receipt = results[0]["versions"][0]["generation_record"]
        self.assertEqual(receipt["prompt"], "暖色产品图")
        self.assertEqual(receipt["inputs"][0]["node_id"], "n1")
        self.assertEqual(receipt["inputs"][0]["version"], 1)
        self.svc.model.side_effect = [call("image_transform", {"node_id": results[1]["id"], "rotate": 90}, "rotate"), answer()]
        rid2 = await self.send("第二张旋转一下", "request002", [], placement={"x":2000,"y":2000})
        self.assertEqual((await self.wait(rid2))["state"], "done")
        self.assertEqual(len(self.load()["nodes"]), 5)
        modified = next(n for n in self.load()["nodes"] if n["id"] == results[1]["id"])
        self.assertEqual(len(modified["versions"]), 2)
        self.assertEqual((modified["x"],modified["y"]),(results[1]["x"],results[1]["y"]))

    async def test_selected_version_is_frozen(self):
        gate = asyncio.Event()

        async def delayed(*_):
            await gate.wait()
            return call("image_transform", {"node_id": "n1", "rotate": 90})

        self.svc.model.side_effect = [delayed, answer()]
        async def first_then_answer(messages, run):
            if not gate.is_set():
                return await delayed()
            return answer()
        self.svc.model.side_effect = first_then_answer
        rid = await self.send()
        await asyncio.sleep(.01)
        b = self.load()
        other = image_editor.save(server.COMFY_DIR, Image.new("RGB", (200, 100), "blue"))
        b["nodes"][0]["versions"].append(other)
        b["nodes"][0]["cur"] = 1
        await self.client.put("/api/board/test", json=b)
        gate.set()
        await self.wait(rid)
        out = self.load()["nodes"][0]["versions"][-1]
        self.assertEqual((out["w"], out["h"]), (96, 128))

    async def test_upscale_routes_the_chosen_historical_image_and_keeps_both_versions(self):
        old = self.source["ref"]
        current = image_editor.save(server.COMFY_DIR,Image.new("RGB",(200,100),"blue"))
        server.grant_media({"id":7},current["ref"])
        board = self.load()
        board["nodes"][0]["versions"].append(current)
        board["nodes"][0]["cur"] = 1
        response = await self.client.put("/api/board/test",json=board)
        self.assertEqual(response.status,200,await response.text())

        def upscale(root, directory, ref, scale):
            self.assertEqual((ref,scale),(old,4))
            image = image_editor.load(root,ref)
            return image_editor.save(root,image.resize((image.width*scale,image.height*scale)))

        self.svc.model.side_effect = [call("image_upscale",{"node_id":"n1","scale":4,"version":1}),answer()]
        with patch.object(server.image_upscale,"upscale",side_effect=upscale) as invoked:
            rid = await self.send("把第一版超分四倍")
            self.assertEqual((await self.wait(rid))["state"],"done")
            self.assertEqual(invoked.call_count,1)
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual([v["ref"] for v in versions[:2]],[old,current["ref"]])
        self.assertEqual((versions[-1]["w"],versions[-1]["h"]),(512,384))
        self.assertEqual(versions[-1]["edit"],{"source":old,"mode":"upscale","scale":4,"model":"FSRCNN"})

    async def test_decompose_adds_a_reusable_layer_stack_to_the_source_node(self):
        ref = self.source["ref"]

        async def labels(_app, tool, payload):
            self.assertEqual((tool,payload["ref"]),("decompose",ref))
            image = Image.new("L",(128,96))
            image.paste(1,(12,20,60,64))
            image.paste(2,(72,14,100,80))
            return image_editor.save(server.COMFY_DIR,image)

        self.svc.model.side_effect = [call("image_decompose",{"node_id":"n1"}),answer()]
        with patch.object(image_routes,"run_image_tool",labels):
            rid = await self.send("把选中的图片自动拆成独立图层")
            self.assertEqual((await self.wait(rid))["state"],"done")
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual(len(versions),2)
        self.assertEqual(versions[0]["ref"],ref)
        self.assertEqual(versions[1]["edit"],{"source":ref,"mode":"decompose"})
        layers = versions[1]["layer_stack"]["layers"]
        self.assertEqual([(l["name"],l["x"],l["y"]) for l in layers],
                         [("背景",0,0),("物体 1",12,20),("物体 2",72,14)])

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


if __name__ == "__main__":
    unittest.main()
