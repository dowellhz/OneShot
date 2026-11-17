#!/usr/bin/env python3
"""Real-model smoke on the deployment host, isolated from accounts, boards and task history.

Usage: ~/h3engine-venv/bin/python scripts/smoke_agent_stage2.py --project ~/h3studio --scenario editing
Calls the configured text/image/video services and generates test media (normal provider charges apply).
"""
import argparse
import asyncio
import base64
import io
from PIL import Image
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

import agent_chat
import db
import providers
import rewriter
import server


async def main(project, scenario):
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
        if scenario == "video":
            import av
            out,ref=server.tools._new(server.COMFY_DIR,"output","agent-video-source",".mp4")
            with av.open(str(out),"w") as movie:
                stream=movie.add_stream("libx264",rate=4);stream.width=64;stream.height=48;stream.pix_fmt="yuv420p"
                for i in range(8):
                    for packet in stream.encode(av.VideoFrame.from_image(Image.new("RGB",(64,48),(100+i*10,70,60)))):movie.mux(packet)
                for packet in stream.encode():movie.mux(packet)
            board["nodes"].append({"id":"n2","type":"video","name":"原视频","x":600,"y":100,"data":{"prompt":"A gentle camera push toward the house, soft daylight, natural ambient sound.","duration":5,"quality":"std","aspect":"auto","turbo":True,"seed":23},"versions":[{"ref":ref,"url":"/media?ref="+ref,"w":64,"h":48,"seconds":2}],"cur":0,"job":None})
            board["edges"]=[{"from":"n1","to":"n2","role":"first"}]
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
                        for _ in range(1200):
                            row = db.one("SELECT state,error,data FROM chat_runs WHERE id=?", rid)
                            if row["state"] != prior:
                                print("RUN", rid, row["state"], flush=True)
                                prior = row["state"]
                            if row["state"] == "waiting_input":
                                state=await (await client.get(f"/api/chat/sessions/{sid}")).json()
                                if state["inputs"]:
                                    item=state["inputs"][0]
                                    mask=server.image_editor.load(server.COMFY_DIR,receipt["mask"]).convert("L")
                                    buffer=io.BytesIO();mask.save(buffer,"PNG")
                                    submitted=await client.post(f"/api/chat/runs/{rid}/selection",json={"call_id":item["call_id"],"mask_data":"data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode()})
                                    assert submitted.status==200,await submitted.text()
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

                    if scenario == "video":
                        await run("重新生成选中的视频，沿用连接图片作为首帧，5秒，标准清晰度，结果叫视频重生成测试。不要生成静态图片，也不需要分析画面。",["n2"],"video-regenerate-smoke")
                        final=json.loads(server.board_path("smoke").read_text())
                        assert len(final["nodes"])==2,final
                        assert len(final["nodes"][-1]["versions"])==2
                        video=final["nodes"][-1]
                        assert video["type"]=="video",video
                        v=video["versions"][-1]
                        info=server.media_info(server.tools.ref_path(server.COMFY_DIR,v["ref"]),"video")
                        assert info.get("duration",0)>=4.8,info
                        assert "video_regenerate" in report["rounds"][0]["tools"],report
                        assert "image_generate" not in report["rounds"][0]["tools"],report
                        assert v["video_recipe"]["images"][0]["ref"]==receipt["source"]["ref"]
                        report["video"]=info
                    else:
                        await run("只把选中图片的背景改成暖色日落天空，主体房子保持不动。必须使用原生遮罩重绘，结果命名背景修改。完成后提供前后对比，不需要描述图片。",["n1"],"stage2-background")
                        after=json.loads(server.board_path("smoke").read_text());edited=after["nodes"][-1];v=edited["versions"][-1]
                        assert v.get("edit",{}).get("recipe",{}).get("backend")=="native",v
                        mask=server.image_editor.load(server.COMFY_DIR,v["edit"]["recipe"]["mask"]).convert("L")
                        original=server.image_editor.load(server.COMFY_DIR,receipt["source"]["ref"]);result=server.image_editor.load(server.COMFY_DIR,v["ref"])
                        protected=0
                        for before,pixel,allowed in zip(original.getdata(),result.getdata(),mask.getdata()):
                            if allowed==0:assert before==pixel;protected+=1
                        assert protected>1000
                        report["protected_pixels"]=protected
                        await run("把刚生成的背景修改图片中，生成区域图层的不透明度改为50%，其他图层保持不变，保存新结果。",[],"stage2-layers")
                        layered=json.loads(server.board_path("smoke").read_text())["nodes"][-1]
                        assert any(l["id"]=="generated" and l["opacity"]==.5 for l in layered["versions"][-1]["layer_stack"]["layers"])
                        await run(f"沿用图片节点 {edited['id']} 的版本索引1的编辑参数，以原始输入图和相同遮罩重新生成，提示词不变，种子改为73。",[],"stage2-reuse")
                        retried=json.loads(server.board_path("smoke").read_text())["nodes"][-1]["versions"][-1]
                        assert retried["edit"]["recipe"]["ref"]==receipt["source"]["ref"]
                        assert retried["edit"]["recipe"]["seed"]==73
                        await run("我要自己画选区，先等我在编辑器画好，再把选区改成蓝色屋顶，使用原生遮罩重绘。",["n1"],"stage2-manual")
                        final=json.loads(server.board_path("smoke").read_text())
                        assert "image_select" in report["rounds"][-1]["tools"]
                        assert "image_edit" in report["rounds"][-1]["tools"]
                    report["outputs"] = [{"id": n["id"], "name": n["name"], "ref": n["versions"][n["cur"]]["ref"]} for n in final["nodes"]]
                    report["completed"] = time.time()
                    (project / ("data/agent-"+scenario+"-smoke.json")).write_text(json.dumps(report, ensure_ascii=False, indent=2))
                    print("REAL AGENT SMOKE PASSED", json.dumps(report, ensure_ascii=False), flush=True)
            app["llm"].stop()
        db.conn().close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--scenario",choices=["editing","video"],default="editing")
    args=parser.parse_args()
    asyncio.run(main(args.project.expanduser().resolve(),args.scenario))
