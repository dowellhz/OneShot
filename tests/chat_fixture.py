"""Isolated workspace and tool responses for assistant integration tests."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import asyncio
import json
import tempfile
import unittest

from PIL import Image
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import aiohttp

from oneshot import config
from oneshot.assistant import agent_chat as chat
from oneshot.canvas import routes as canvas_routes
from oneshot.editing import image_editor
from oneshot.generation import jobs as generation_jobs
from oneshot.memory import legacy_routes
from oneshot.storage import db
import server


def answer(text="已完成"):
    return {"role": "assistant", "content": text}


def call(name, args, mid="step1"):
    return {"role": "assistant", "content": "开始执行", "tool_calls": [
        {"id": mid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def db_row(rid):
    return db.one("SELECT result FROM chat_calls WHERE run_id=? ORDER BY updated DESC LIMIT 1", rid)


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
