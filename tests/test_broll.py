import asyncio
from unittest.mock import AsyncMock

import av
from PIL import Image, ImageDraw

from oneshot.editing import image_editor
from oneshot.storage import db
import server
from chat_fixture import ChatFixture, answer, call


class BRollIntegration(ChatFixture):
    async def approval(self, run):
        for _ in range(500):
            data = await (await self.client.get(f"/api/chat/sessions/{self.sid}")).json()
            if approval := next((item for item in data["approvals"] if item["run_id"]==run),None):
                return approval
            await asyncio.sleep(.02)
        self.fail("未显示 B-roll 确认卡")

    async def test_chat_approves_exact_reference_and_places_linked_result(self):
        backup = image_editor.save(server.COMFY_DIR,Image.new("RGBA",(96,64),"blue"),"input")
        self.board["nodes"][0].update(versions=[self.source,backup],cur=1)
        server.write_board(server.board_path("test"),self.board)
        args = {"node_id":"n1","mode":"motion","duration":1,"direction":"out"}
        self.svc.model.side_effect = [call("video_broll_generate",args),answer()]
        reply = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json={"text":"把第一版图片做成拉远的 B-roll",
                "request_key":"broll-chat-reference","selected":["n1"],"selected_versions":[{"node_id":"n1","ref":self.source["ref"]}]})
        self.assertEqual(reply.status,200,await reply.text())
        rid = (await reply.json())["id"]
        approval = await self.approval(rid)
        self.assertIn("来源版本 1",approval["plan"]["prompt"])
        self.assertIn("拉远",approval["plan"]["prompt"])
        self.assertEqual(server.JOBS,{})
        confirm = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"approve"})
        self.assertEqual(confirm.status,200,await confirm.text())
        settled = await self.wait(rid,timeout=15)
        self.assertEqual(settled["state"],"done")
        board = self.load()
        result = board["nodes"][-1]
        self.assertEqual(result["versions"][0]["broll_recipe"]["direction"],"out")
        self.assertEqual(result["versions"][0]["broll_source"],{"node":"n1","ref":self.source["ref"]})
        self.assertEqual(board["edges"][-1],{"from":"n1","to":result["id"],"relation":"broll","ref":self.source["ref"]})
        self.assertEqual(board["nodes"][0]["cur"],1)
        archive = await (await self.client.get("/api/generation-history?board=test&kind=video")).json()
        self.assertEqual([item["source"] for item in archive["items"]],["broll"])
        self.assertEqual(archive["items"][0]["ref"],result["versions"][0]["ref"])

    async def test_skip_does_not_enqueue_render(self):
        self.svc.model.side_effect = [call("video_broll_generate",{"node_id":"n1","mode":"motion"}),answer()]
        rid = await self.send("做一个图片推进镜头")
        approval = await self.approval(rid)
        response = await self.client.post(f"/api/chat/runs/{rid}/approvals/{approval['id']}",json={"decision":"skip"})
        self.assertEqual(response.status,200,await response.text())
        await self.wait(rid,timeout=10)
        self.assertEqual(server.JOBS,{})
        self.assertIsNone(db.one("SELECT id FROM tasks WHERE capability='render'"))
        self.assertEqual(len(self.load()["nodes"]),2)

    async def test_draft_respects_chosen_style_and_is_separate_from_render(self):
        self.app["llm"].chat = AsyncMock(return_value='{"title":"晨间新品","mode":"motion","start":1,"style":"plain"}')
        payload = {"board":"test","node":"n1","ref":self.source["ref"],"mode":"title",
                   "brief":"为新品写开场标题","start":0,"end":1,"duration":2,"style":"card"}
        response = await self.client.post("/api/broll/draft",json=payload)
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual(await response.json(),{"mode":"title","title":"晨间新品","start":0,"end":1,"duration":2,"style":"card"})
        self.assertEqual(server.JOBS,{})
        self.board["collaborators"] = {"8":"reviewer"}
        server.write_board(server.board_path("test"),self.board)
        self.assertEqual((await self.client.post("/api/broll/draft",json=payload,headers={"X-Uid":"8"})).status,403)
        self.assertEqual(self.app["llm"].chat.await_count,1)

    async def test_animate_still_preserves_source_and_replays_same_render(self):
        image = Image.new("RGBA",(128,96),"blue")
        ImageDraw.Draw(image).rectangle((0,0,25,96),fill="orange")
        still = image_editor.save(server.COMFY_DIR,image,"input")
        self.board["nodes"][0]["versions"] = [self.source,still]
        server.write_board(server.board_path("test"),self.board)
        baseline = self.load()
        payload = {"board":"test","node":"n1","ref":still["ref"],"request_key":"broll-request-0001",
                   "recipe":{"mode":"motion","duration":1,"start":0,"end":1,"direction":"in"}}
        wrong = await self.client.post("/api/broll/render",json={**payload,"ref":"input:h3studio/not-the-source.png"})
        self.assertEqual(wrong.status,400)
        invalid = await self.client.post("/api/broll/render",json={**payload,"recipe":{"mode":"chart","title":"示例","bars":[{"label":"A","value":-2},{"label":"B","value":1}]}})
        self.assertEqual(invalid.status,400)
        response = await self.client.post("/api/broll/render",json=payload)
        self.assertEqual(response.status,200,await response.text())
        first = await response.json()
        repeated = await (await self.client.post("/api/broll/render",json=payload)).json()
        self.assertEqual(repeated["ids"],first["ids"])
        self.assertEqual((await self.client.post("/api/broll/render",json={**payload,"recipe":{**payload["recipe"],"direction":"out"}})).status,409)
        job = server.JOBS[first["ids"][0]]
        for _ in range(500):
            if job["state"] in ("done","error"):
                break
            await asyncio.sleep(.02)
        self.assertEqual(job["state"],"done",job.get("error"))
        with av.open(str(server.tools.ref_path(server.COMFY_DIR,job["outputs"][0]["ref"]))) as video:
            frames = list(video.decode(video=0))
        self.assertEqual(len(frames),24)
        self.assertNotEqual(frames[0].to_ndarray(format="rgb24").tobytes(),frames[-1].to_ndarray(format="rgb24").tobytes())
        self.assertEqual(self.load(),baseline)
