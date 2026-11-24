#!/usr/bin/env python3
"""Real-model smoke on the deployment host, isolated from accounts, boards and task history.

Usage: ~/h3engine-venv/bin/python scripts/smoke_agent_chat.py --project ~/h3studio
Calls the configured text/image services and generates ONE image (normal provider charges apply).
"""
import argparse
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from oneshot.assistant import agent_chat
from oneshot.storage import db
from oneshot.providers import catalog as providers
from oneshot.generation import rewriter
import server


async def main(project):
    started = time.time()
    db.DB_PATH = project / "data/h3.db"
    db.KEY_PATH = project / "data/secret.key"
    routes = {cap: providers.routes(cap) for cap in providers.CAPS}
    print("TEXT ROUTE", [(r["provider"]["name"], r["model"]) for r in routes["text"]], flush=True)
    db.conn().close()
    db._conn = None
    # Reuse services in memory; credentials never get copied into the test DB or report.
    receipt = json.loads((project / "data/image-editor-smoke.json").read_text())
    report = {"started": started, "rounds": []}
    with tempfile.TemporaryDirectory(prefix="oneshot-agent-smoke-") as temp:
        root = Path(temp)
        db.DB_PATH = root / "test.db"
        db.conn()
        db.run("INSERT INTO users(id,username,pw_hash,role,disabled) VALUES(991,'smoke','disabled','member',0)")
        server.BOARDS = root / "boards"
        server.BOARDS.mkdir()
        server.DATA = root / "data"
        server.EDIT_JOBS = root / "edits"
        board = {"name": "Agent smoke", "owner": 991, "rev": 1, "seq": 2, "nodes": [{
            "id": "n1", "type": "image", "name": "参考小屋", "x": 100, "y": 100,
            "data": {"aspect": "auto"}, "versions": [receipt["source"]], "cur": 0, "job": None}],
            "edges": [], "groups": [], "view": {"x": 0, "y": 0, "k": 1}}
        server.board_path("smoke").write_text(json.dumps(board))

        @web.middleware
        async def user(req, handler):
            req["user"] = {"id": 991, "role": "member"}
            return await handler(req)

        async with aiohttp.ClientSession() as http:
            app = web.Application(middlewares=[user])
            app["http"] = http
            app["llm"] = rewriter.LLM(server.COMFY, lambda: http)
            agent_chat.install(app, server)
            app.add_routes(server.routes)
            with patch.object(providers, "routes", side_effect=lambda cap: routes.get(cap, [])):
                async with TestClient(TestServer(app)) as client:
                    response = await client.post("/api/chat/sessions", json={"board": "smoke"})
                    assert response.status == 200, await response.text()
                    sid = (await response.json())["id"]

                    async def run(text, selected, key):
                        t0 = time.time()
                        response = await client.post(f"/api/chat/sessions/{sid}/messages", json={"text": text, "selected": selected, "request_key": key})
                        assert response.status == 200, await response.text()
                        rid = (await response.json())["id"]
                        prior = None
                        for _ in range(600):
                            row = db.one("SELECT state,error,data FROM chat_runs WHERE id=?", rid)
                            if row["state"] != prior:
                                print("RUN", rid, row["state"], flush=True)
                                prior = row["state"]
                            if row["state"] in agent_chat.TERMINAL:
                                break
                            await asyncio.sleep(1)
                        assert row["state"] == "done", row
                        calls = db.q("SELECT name,state,result FROM chat_calls WHERE run_id=?", rid)
                        errors = [json.loads(c["result"])["error"] for c in calls if c["result"] and "error" in json.loads(c["result"])]
                        assert not errors, errors
                        result = {"seconds": round(time.time() - t0, 1), "tools": [c["name"] for c in calls], "model": json.loads(row["data"]).get("model")}
                        report["rounds"].append(result)
                        print("ROUND", json.dumps(result, ensure_ascii=False), flush=True)
                        return rid

                    await run("用选中的图片作为参考，生成1张暖色调版本，结果命名为暖色测试，再把原图和结果横向排列，最后告诉我完成了什么。不需要分析图片内容，不调用看图工具。", ["n1"], "real-smoke-1")
                    after = json.loads(server.board_path("smoke").read_text())
                    assert len(after["nodes"]) == 2, after
                    assert after["nodes"][0]["versions"][0]["ref"] == receipt["source"]["ref"]
                    await run("将刚生成的暖色测试图片顺时针旋转90度，保留已有图片，在原节点保存新版本。", [], "real-smoke-2")
                    final = json.loads(server.board_path("smoke").read_text())
                    assert len(final["nodes"]) == 2, final
                    assert len(final["nodes"][-1]["versions"]) == 2, final
                    assert "image_generate" in report["rounds"][0]["tools"]
                    assert "canvas_arrange" in report["rounds"][0]["tools"]
                    assert "image_transform" in report["rounds"][1]["tools"]
                    report["outputs"] = [{"id": n["id"], "name": n["name"], "ref": n["versions"][n["cur"]]["ref"]} for n in final["nodes"]]
                    report["completed"] = time.time()
                    (project / "data/agent-chat-smoke.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
                    print("REAL AGENT SMOKE PASSED", json.dumps(report, ensure_ascii=False), flush=True)
            app["llm"].stop()
        db.conn().close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    asyncio.run(main(parser.parse_args().project.expanduser().resolve()))
