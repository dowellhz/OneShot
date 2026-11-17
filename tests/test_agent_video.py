"""Video tool routing, regeneration inputs and media-type verification."""
import asyncio
import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp import web
from PIL import Image

import agent_chat
import agent_video
import image_editor
import server
from test_agent_chat import ChatFixture, answer, call


class VideoIntegration(ChatFixture):
    def make_video(self):
        import av
        path, ref = server.tools._new(server.COMFY_DIR, "output", "test-video", ".mp4")
        with av.open(str(path), "w") as out:
            stream = out.add_stream("libx264", rate=6)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            for i in range(12):
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), (20 * i, 60, 80)))
                for packet in stream.encode(frame):
                    out.mux(packet)
            for packet in stream.encode():
                out.mux(packet)
        return {"ref": ref, "url": "/media?ref=" + ref, "w": 64, "h": 64, "seconds": 2}

    async def test_video_generate_routes_as_video_and_creates_playable_video_node(self):
        video = self.make_video()
        received = []
        async def submit(req, raw):
            received.append(raw)
            server.JOBS["e123456789012"] = {"state": "done", "created": 1, "meta": {"uid": 7, "seed": 42},
                "outputs": [{"ref": video["ref"], "meta": {"width": 64, "height": 64, "duration": 2}}]}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "camera slowly moves", "frames": [{"node_id": "n1", "role": "first"}], "duration": 5, "quality": "std"}), answer()]
        with patch.object(server, "generate_request", side_effect=submit):
            rid = await self.send("生成视频")
            self.assertEqual((await self.wait(rid))["state"], "done")
        self.assertEqual(received[0]["kind"], "video")
        self.assertEqual(received[0]["images"][0]["ref"], self.source["ref"])
        node = self.load()["nodes"][-1]
        self.assertEqual(node["type"], "video")
        self.assertEqual(node["versions"][0]["seconds"], 2)
        self.assertEqual(node["versions"][0]["video_recipe"]["kind"], "video")
        self.assertEqual(node["versions"][0]["video_recipe"]["seed"], 42)
        self.assertTrue(any(e["from"] == "n1" and e["to"] == node["id"] for e in self.load()["edges"]))
        result = json.loads(db_row(rid)["result"])
        self.assertEqual(result["media_type"], "video")
        self.assertEqual(node["versions"][0]["video_recipe"]["seed"], 42)
        self.assertEqual(self.load()["edges"], [{"from": "n1", "to": node["id"], "role": "first"}])
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["edges"], [])
        self.assertEqual(len(self.load()["nodes"]), 2)
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["edges"], [])
        self.assertEqual(len(self.load()["nodes"]), 2)

    async def test_video_regenerate_preserves_keyframe_roles_and_replacements(self):
        b = self.load()
        second = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128, 96), "blue"))
        b["nodes"].extend([
            {"id": "n3", "type": "image", "name": "尾帧", "x": 0, "y": 0, "data": {}, "versions": [second], "cur": 0},
            {"id": "n4", "type": "image", "name": "修正首帧", "x": 0, "y": 0, "data": {}, "versions": [second], "cur": 0},
            {"id": "n5", "type": "video", "name": "原视频", "x": 0, "y": 0, "data": {"prompt": "original movement", "duration": 8, "quality": "hd", "aspect": "auto", "seed": 10}, "versions": [self.make_video()], "cur": 0}])
        b["edges"] = [{"from": "n1", "to": "n5", "role": "first"}, {"from": "n3", "to": "n5", "role": "last"}]
        server.board_path("test").write_text(json.dumps(b))
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "n5", "prompt": "scissors close naturally", "replacements": [{"from_node_id": "n1", "to_node_id": "n4"}]}), answer()]
        with patch.object(self.svc, "submit_generation", AsyncMock(return_value={"media_type": "video", "nodes": []})) as submit:
            rid = await self.send("重生成视频", selected=["n5"])
            await self.wait(rid)
        payload = submit.await_args.args[3]
        self.assertEqual(payload["kind"], "video")
        self.assertEqual(payload["duration"], 8)
        self.assertEqual(payload["quality"], "hd")
        self.assertEqual([i["ref"] for i in payload["images"]], [second["ref"], second["ref"]])
        self.assertEqual(payload["prompt"], "scissors close naturally")
        self.assertEqual(submit.await_args.kwargs["target_id"], "n5")
        self.assertEqual(self.load()["nodes"], b["nodes"])

    async def test_regeneration_appends_to_original_and_snapshots_both_input_graphs(self):
        old, new = self.make_video(), self.make_video()
        b = self.load()
        b["nodes"].append({"id": "video", "type": "video", "name": "原视频", "x": 700, "y": 90,
                           "data": {"prompt": "old movement", "duration": 5, "quality": "std"}, "versions": [old], "cur": 0, "job": None})
        corrected = copy.deepcopy(b["nodes"][0]); corrected["id"] = "corrected"
        b["nodes"].append(corrected)
        original_edges = [{"from": "n1", "to": "video", "role": "first"}, {"from": "n2", "to": "video"}]
        b["edges"] = original_edges
        server.board_path("test").write_text(json.dumps(b))
        started, finish = asyncio.Event(), asyncio.Event()
        async def submit(*_):
            return web.json_response({"ids": ["e123456789012"]})
        async def jobs(req):
            started.set()
            return web.json_response({"e123456789012": {"state": "done" if finish.is_set() else "running", "meta": {"seed": 42},
                                    "outputs": [{"ref": new["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "video", "prompt": "new movement", "replacements": [{"from_node_id": "n1", "to_node_id": "corrected"}]}), answer()]
        with patch.object(server, "generate_request", side_effect=submit), patch.object(server, "jobs", side_effect=jobs):
            rid = await self.send("原视频上再修改", selected=["video"])
            await started.wait()
            waiting = self.load(); n = next(n for n in waiting["nodes"] if n["id"] == "video")
            self.assertEqual(len(waiting["nodes"]), 4)
            self.assertEqual(n["versions"][0]["input_edges"], original_edges)
            self.assertEqual(n["versions"][0]["node_data"]["prompt"], "old movement")
            self.assertTrue(n["job"]["agent_call"])
            self.assertEqual({e["from"] for e in waiting["edges"]}, {"corrected", "n2"})
            # Simulate Web restart; the durable waiting call must finish in the same node.
            self.svc.closing = True
            task = self.svc.tasks[rid]; task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.svc.closing = False
            finish.set(); self.svc.launch(rid)
            self.assertEqual((await self.wait(rid))["state"], "done")
        final = self.load(); n = next(n for n in final["nodes"] if n["id"] == "video")
        self.assertEqual(len(final["nodes"]), 4)
        self.assertEqual(len(n["versions"]), 2)
        self.assertEqual(n["cur"], 1)
        self.assertIsNone(n["job"])
        self.assertEqual((n["name"], n["x"], n["y"]), ("原视频", 700, 90))
        self.assertEqual(n["versions"][1]["input_edges"], final["edges"])
        self.assertEqual(n["versions"][1]["node_data"]["prompt"], "new movement")
        self.assertEqual(n["versions"][1]["video_recipe"]["seed"], 42)
        result = json.loads(db_row(rid)["result"])
        self.assertEqual(result["nodes"][0]["id"], "video")
        self.assertEqual(result["nodes"][0]["version_index"], 1)
        response = await self.client.post(f"/api/chat/runs/{rid}/undo", json={})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.load()["nodes"], b["nodes"])
        self.assertCountEqual(self.load()["edges"], original_edges)

    async def test_failed_regeneration_keeps_old_video_and_restores_inputs(self):
        b = self.load(); old = self.make_video()
        b["nodes"].append({"id": "video", "type": "video", "name": "原视频", "x": 700, "y": 90,
                           "data": {"prompt": "old movement", "duration": 5}, "versions": [old], "cur": 0, "job": None})
        b["edges"] = [{"from": "n1", "to": "video", "role": "first"}]
        server.board_path("test").write_text(json.dumps(b))
        async def submit(*_):
            server.JOBS["e123456789012"] = {"state": "error", "created": 1, "meta": {"uid": 7}, "error": "failed"}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_regenerate", {"node_id": "video", "prompt": "new movement"}), answer()]
        with patch.object(server, "generate_request", side_effect=submit):
            rid = await self.send(selected=["video"]); await self.wait(rid)
        n = self.load()["nodes"][-1]
        self.assertEqual(n["versions"][0]["ref"], old["ref"])
        self.assertEqual(len(n["versions"]), 1)
        self.assertEqual(n["cur"], 0)
        self.assertIsNone(n["job"])
        self.assertEqual(n["data"], b["nodes"][-1]["data"])
        self.assertEqual(self.load()["edges"], b["edges"])
        self.assertEqual(n["agent_error"], "failed")

    async def test_pending_video_is_connected_before_completion_and_finishes_in_place(self):
        video = self.make_video()
        started, finish = asyncio.Event(), asyncio.Event()
        async def submit(req, raw):
            return web.json_response({"ids": ["e123456789012"]})
        async def jobs(req):
            started.set()
            return web.json_response({"e123456789012": {"state": "done" if finish.is_set() else "running", "phase": "sampling",
                "meta": {"seed": 42}, "outputs": [{"ref": video["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "move", "frames": [{"node_id": "n1", "role": "first"}]}), answer()]
        with patch.object(server, "generate_request", side_effect=submit), patch.object(server, "jobs", side_effect=jobs):
            rid = await self.send("生成视频")
            await started.wait()
            b = self.load();pending = b["nodes"][-1];nid = pending["id"]
            self.assertEqual(pending["type"], "video")
            self.assertFalse(pending["versions"])
            self.assertEqual(pending["job"]["ids"], ["e123456789012"])
            self.assertTrue(pending["job"]["agent_call"])
            self.assertEqual(b["edges"], [{"from": "n1", "to": nid, "role": "first"}])
            # A normal canvas save can omit transient status; the server still owns completion.
            response=await self.client.put("/api/board/test",json=b)
            self.assertEqual(response.status,200)
            finish.set()
            self.assertEqual((await self.wait(rid))["state"],"done")
        final=self.load();self.assertEqual(len(final["nodes"]),3)
        self.assertEqual(final["nodes"][-1]["id"],nid)
        self.assertIsNone(final["nodes"][-1]["job"])
        self.assertEqual(len(final["nodes"][-1]["versions"]),1)
        self.assertEqual((await self.client.post(f"/api/chat/runs/{rid}/undo",json={})).status,200)
        self.assertEqual(len(self.load()["nodes"]),2)

    async def test_deleted_pending_video_is_not_recreated(self):
        video = self.make_video()
        ready, finish = asyncio.Event(), asyncio.Event()
        async def submit(*_):return web.json_response({"ids":["e123456789012"]})
        async def jobs(req):
            ready.set()
            return web.json_response({"e123456789012":{"state":"done" if finish.is_set() else "running","meta":{},"outputs":[{"ref":video["ref"]}] if finish.is_set() else []}})
        self.svc.model.side_effect=[call("video_generate",{"prompt":"move","frames":[{"node_id":"n1"}]}),answer()]
        with patch.object(server,"generate_request",side_effect=submit),patch.object(server,"jobs",side_effect=jobs):
            rid=await self.send();await ready.wait()
            b=self.load();b["nodes"]=b["nodes"][:-1];b["edges"]=[]
            await self.client.put("/api/board/test",json=b);finish.set();await self.wait(rid)
        self.assertEqual(len(self.load()["nodes"]),2)

    async def test_planned_three_keyframes_times_are_retained(self):
        rid = await self.send()
        await self.wait(rid)
        import db
        run = db.one("SELECT * FROM chat_runs WHERE id=?", rid);run["data"] = json.loads(run["data"])
        payload = agent_video.plan_payload(self.svc, run, {"id": 7, "role": "member"}, [
            {"node_id": "n1", "role": "first"}, {"node_id": "n1", "role": "keyframe", "time": 2}, {"node_id": "n1", "role": "last"}], 5, {}, "move")
        self.assertTrue(payload["planned"])
        self.assertEqual(payload["images"][0]["time"], 0)
        self.assertEqual(payload["images"][1]["time"], 2)
        self.assertGreater(payload["images"][2]["time"], 4.8)

    async def test_image_result_cannot_be_saved_as_video(self):
        async def submit(req, raw):
            server.JOBS["e123456789012"] = {"state": "done", "created": 1, "meta": {"uid": 7}, "outputs": [{"ref": self.source["ref"]}]}
            return web.json_response({"ids": ["e123456789012"]})
        self.svc.model.side_effect = [call("video_generate", {"prompt": "move"}), answer()]
        with patch.object(server, "generate_request", side_effect=submit):
            rid = await self.send("生成视频")
            await self.wait(rid)
        self.assertIn("error", json.loads(db_row(rid)["result"]))
        failed=self.load()["nodes"][-1]
        self.assertEqual(failed["type"],"video")
        self.assertFalse(failed["versions"])
        self.assertIsNone(failed["job"])
        self.assertTrue(failed["agent_error"])

    async def test_video_describe_reads_actual_video_frames(self):
        b = self.load()
        b["nodes"].append({"id": "n3", "type": "video", "name": "视频", "x": 0, "y": 0, "data": {}, "versions": [self.make_video()], "cur": 0})
        server.board_path("test").write_text(json.dumps(b))
        self.svc.model.side_effect = [call("media_describe", {"node_id": "n3"}), answer()]
        with patch.object(server, "describe", AsyncMock(return_value=web.json_response({"text": "实际视频画面"}))) as describe:
            rid = await self.send("看视频", selected=["n3"])
            await self.wait(rid)
            request = await describe.await_args.args[0].json()
            self.assertGreaterEqual(len(request["images"]), 3)
        self.assertEqual(json.loads(db_row(rid)["result"])["media_type"], "video")


def db_row(rid):
    import db
    return db.one("SELECT result FROM chat_calls WHERE run_id=? ORDER BY updated DESC LIMIT 1", rid)
