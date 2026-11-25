"""Assistant references and private attachments across generation requests."""

from unittest.mock import patch
import asyncio
import json

from PIL import Image
from aiohttp import web
import aiohttp

from oneshot.editing import image_editor
from oneshot.generation import reference as video_reference
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatPinnedInputs(ChatFixture):
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
