"""Run HTTP integration tests on the deployment host; uses an isolated database and media."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

import agent_chat as chat
import db
import image_editor
import server


def answer(text="已完成"):
    return {"role": "assistant", "content": text}


def call(name, args, mid="step1"):
    return {"role": "assistant", "content": "开始执行", "tool_calls": [
        {"id": mid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


class ChatFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patchers = [patch.object(db, "DB_PATH", self.root / "chat.db"), patch.object(db, "_conn", None),
                         patch.object(server, "BOARDS", self.root / "boards"), patch.object(server, "COMFY_DIR", self.root / "media"),
                         patch.object(server, "LIBRARY", self.root / "library.json"),
                         patch.object(server, "EDIT_JOBS", self.root / "edits"), patch.object(server, "record")]
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

    async def send(self, text="执行测试", key="request001", selected=None):
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={
            "text": text, "request_key": key, "selected": selected if selected is not None else ["n1"]})
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())["id"]

    async def wait(self, rid):
        for _ in range(200):
            row = db.one("SELECT * FROM chat_runs WHERE id=?", rid)
            if row["state"] in chat.TERMINAL:
                return row
            await asyncio.sleep(.01)
        self.fail("run did not finish")

    def load(self):
        return json.loads(server.board_path("test").read_text())


class ChatIntegration(ChatFixture):
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
        with patch.object(server, "generate_request", submit):
            rid = await self.send()
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])
        self.assertEqual(len(self.load()["nodes"]), 5)
        results = [n for n in self.load()["nodes"] if n["id"] not in ("n1", "n2")]
        self.assertEqual(len({n["id"] for n in results}), 3)
        self.svc.model.side_effect = [call("image_transform", {"node_id": results[1]["id"], "rotate": 90}, "rotate"), answer()]
        rid2 = await self.send("第二张旋转一下", "request002", [])
        self.assertEqual((await self.wait(rid2))["state"], "done")
        self.assertEqual(len(self.load()["nodes"]), 5)
        modified = next(n for n in self.load()["nodes"] if n["id"] == results[1]["id"])
        self.assertEqual(len(modified["versions"]), 2)

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

    async def test_invalid_tools_and_mask_never_execute(self):
        self.svc.model.side_effect = [call("image_generate", {"prompt": "test", "count": 200}),
                                     call("image_edit", {"node_id": "n1", "prompt": "test", "mask_ref": "input:private.png"}, "badmask"), answer()]
        with patch.object(server, "generate_request", AsyncMock()) as generate:
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
        with patch.object(server, "image_edit_tool", AsyncMock(return_value=web.json_response(selection))):
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
        with patch.object(server, "generate_request", AsyncMock()) as submit:
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
        with patch.object(server, "generate_request", side_effect=submit), patch.object(server, "jobs", AsyncMock(return_value=web.json_response({"e111111111111": {"state": "running", "phase": "sampling"}}))), patch.object(server, "cancel", AsyncMock(return_value=web.json_response({"ok": True}))) as cancel:
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
