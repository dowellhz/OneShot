"""Canvas review comments use the board's access rules and retain exact anchors."""
import json

from PIL import Image

import db
import document_review
import image_editor
import server
from test_agent_chat import ChatFixture, answer, call


class CanvasComments(ChatFixture):
    async def test_passage_review_relocates_and_limits_assistant_replacement(self):
        quote = "🎬 需要修改的 <b>正文</b>"
        original = "前" * 65 + "\n" + quote + "\n" + "后" * 65
        board = self.load()
        board["nodes"][1]["data"].update(text=original,text_format="markdown")
        self.assertEqual((await self.client.put("/api/board/test",json=board)).status,200)
        start = original.index(quote)
        selection = {"start":start,"end":start+len(quote),"quote":quote}
        comments = "/api/board/test/comments"
        response = await self.client.post(comments,json={"body":"把这句口吻改温和",
            "anchor":{"node":"n2","passage":selection},"request_key":"document-passage"})
        self.assertEqual(response.status,201,await response.text())
        review_id = (await response.json())["id"]
        response = await self.client.post(comments,json={"body":"过时选区",
            "anchor":{"node":"n2","passage":{**selection,"quote":"wrong"}},"request_key":"wrong-passage-text"})
        self.assertEqual(response.status,400)
        board = self.load()
        prefix = "新增的标题\n"
        board["nodes"][1]["data"]["text"] = prefix + original
        self.assertEqual((await self.client.put("/api/board/test",json=board)).status,200)
        (thread,) = await (await self.client.get(comments)).json()
        self.assertEqual(thread["anchor"]["passage"],{"quote":quote})
        self.assertEqual(thread["passage_location"],[len(prefix)+start,len(prefix)+start+len(quote)])
        self.svc.model.side_effect = [
            call("canvas_update",{"node_id":"n2","text":"试图覆盖全文"}),
            call("canvas_replace_passage",{"review_id":review_id,"text":"新的措辞"},"local-edit"),
            answer()]
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        response = await self.client.post(endpoint,json={"text":"按段落批注修改","review_id":review_id,"request_key":"apply-passage"})
        self.assertEqual(response.status,200,await response.text())
        run = await self.wait((await response.json())["id"])
        results = [json.loads(row["result"]) for row in db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid",run["id"])]
        self.assertIn("请用 canvas_replace_passage",results[0]["error"])
        self.assertEqual(self.load()["nodes"][1]["data"],{"text":prefix+original.replace(quote,"新的措辞"),"text_format":"markdown"})
        (stale,) = await (await self.client.get(comments)).json()
        self.assertIsNone(stale["passage_location"])
        self.assertEqual(stale["anchor"]["passage"]["quote"],quote)
        self.svc.model.side_effect = [call("canvas_replace_passage",{"review_id":review_id,"text":"再次覆盖"}),answer()]
        retry = await self.client.post(endpoint,json={"text":"再改这句","review_id":review_id,"request_key":"changed-passage"})
        self.assertEqual(retry.status,200,await retry.text())
        stale_run = await self.wait((await retry.json())["id"])
        stale_tool = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",stale_run["id"])["result"])
        self.assertIn("无法唯一定位",stale_tool["error"])
        self.assertEqual(self.load()["nodes"][1]["data"]["text"],prefix+original.replace(quote,"新的措辞"))
        response = await self.client.post(f"/api/chat/runs/{run['id']}/undo",json={})
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual(self.load()["nodes"][1]["data"]["text"],prefix+original)
        repeated = "左" * 48 + quote + "右" * 48
        duplicate = repeated + "\n" + repeated
        anchor = document_review.capture(duplicate,{"start":48,"end":48+len(quote),"quote":quote})
        self.assertEqual(document_review.locate(duplicate,anchor),(48,48+len(quote)))
        self.assertIsNone(document_review.locate("新标题\n"+duplicate,anchor))

    async def test_batch_review_freezes_versions_and_keeps_the_time_range(self):
        board = self.load()
        newer = image_editor.save(server.COMFY_DIR, Image.new("RGB",(128,96),"blue"))
        video_ref = "output:h3studio/review-time.mp4"
        video = server.tools.ref_path(server.COMFY_DIR,video_ref)
        video.parent.mkdir(parents=True,exist_ok=True)
        video.write_bytes(b"video fixture")
        for ref in (newer["ref"],video_ref):
            server.grant_media({"id":7},ref)
        board["nodes"][0]["versions"].append(newer)
        board["nodes"][0]["cur"] = 1
        board["nodes"].append({"id":"reviewVideo","type":"video","name":"视频","x":110,"y":400,
                               "data":{},"versions":[{"ref":video_ref,"seconds":6}],"cur":0})
        self.assertEqual((await self.client.put("/api/board/test",json=board)).status,200)

        async def note(text, anchor, key, expected=201):
            response = await self.client.post("/api/board/test/comments",json={
                "body":text,"anchor":anchor,"request_key":key})
            self.assertEqual(response.status,expected,await response.text())
            return await response.json()

        old = await note("原版背景",{"node":"n1","ref":self.source["ref"]},"batch-review-old")
        latest = await note("新版背景",{"node":"n1","ref":newer["ref"]},"batch-review-new")
        timed = await note("这里降低音乐",{"node":"reviewVideo","ref":video_ref,"at":2.3459,"end":5.1239},"batch-review-time")
        await note("超出时长",{"node":"reviewVideo","ref":video_ref,"at":12},"batch-review-invalid",400)
        await note("图片没有时间轴",{"node":"n1","ref":newer["ref"],"at":1},"batch-review-image-time",400)
        for idx, anchor in enumerate(({"end":3}, {"at":3,"end":3}, {"at":3,"end":2}, {"at":3,"end":7})):
            await note("无效片段",{"node":"reviewVideo","ref":video_ref,**anchor},f"batch-review-range-{idx}",400)
        await self.client.post("/api/board/test/comments",json={
            "body":"保留人声","thread_id":timed["id"],"request_key":"batch-review-reply"})
        endpoint = f"/api/chat/sessions/{self.sid}/messages"
        response = await self.client.post(endpoint,json={"text":"","request_key":"batch-review-send",
            "review_ids":[timed["id"],old["id"],timed["id"]]})
        self.assertEqual(response.status,200,await response.text())
        run = await self.wait((await response.json())["id"])
        data = json.loads(run["data"])
        self.assertEqual(data["selected"],["reviewVideo","n1"])
        self.assertEqual(data["bindings"]["n1"],self.source["ref"])
        self.assertEqual(data["bindings"]["reviewVideo"],video_ref)
        self.assertEqual([item["id"] for item in data["attached_reviews"]],[timed["id"],old["id"]])
        event = json.loads(db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='user'",run["id"])["data"])
        self.assertIn("给出修改建议",event["text"])
        self.assertEqual(event["reviews"][0]["anchor"]["at"],2.346)
        self.assertEqual(event["reviews"][0]["anchor"]["end"],5.124)
        self.assertEqual(event["reviews"][0]["replies"],["保留人声"])
        model_turn = json.loads(db.one("SELECT data FROM chat_events WHERE run_id=? AND kind='model' ORDER BY id",run["id"])["data"])
        self.assertRegex(model_turn["content"],r'"end":\s*5\.124')
        response = await self.client.post(endpoint,json={"text":"一起对照","request_key":"batch-review-conflict",
            "review_ids":[old["id"],latest["id"]]})
        self.assertEqual(response.status,400)
        self.assertIn("不同版本",(await response.json())["error"])

    async def test_agent_receives_review_replies_and_original_version(self):
        url = "/api/board/test/comments"
        initial = self.source["ref"]
        response = await self.client.post(url, json={
            "body":"@审阅人员 检查原版颜色", "anchor":{"node":"n1", "ref":initial}, "request_key":"original-review",
        })
        self.assertEqual(response.status, 201, await response.text())
        review_id = (await response.json())["id"]
        self.assertEqual((await self.client.post(url, json={
            "body":"第二版已经调过色", "thread_id":review_id, "request_key":"review-followup",
        })).status, 201)
        board = self.load()
        newer = image_editor.save(server.COMFY_DIR, Image.new("RGB", (128,96), "blue"))
        server.grant_media({"id":7}, newer["ref"])
        board["nodes"][0]["versions"].append(newer)
        board["nodes"][0]["cur"] = 1
        self.assertEqual((await self.client.put("/api/board/test", json=board)).status, 200)

        message = {"text":"对照这条审阅记录描述原版", "request_key":"review-in-chat", "review_id":review_id}
        self.assertEqual((await self.client.put("/api/board/other", json={"nodes":[]})).status, 200)
        other = await (await self.client.post("/api/chat/sessions", json={"board":"other"})).json()
        self.assertEqual((await self.client.post("/api/chat/sessions/"+other["id"]+"/messages", json=message)).status, 400)

        self.svc.model.side_effect = [call("image_history", {"node_id":"n1"}), answer()]
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json=message)
        self.assertEqual(response.status, 200, await response.text())
        run = await self.wait((await response.json())["id"])
        self.assertEqual(run["state"], "done")
        data = json.loads(run["data"])
        self.assertEqual(data["selected"], ["n1"])
        self.assertEqual(data["bindings"]["n1"], initial)
        tool = db.one("SELECT result FROM chat_calls WHERE run_id=?", run["id"])
        self.assertEqual(json.loads(tool["result"])["bound_ref"], initial)
        reply = self.svc.model.await_args_list[0].args[0]
        context = next(m["content"] for m in reply if m["role"] == "user")
        self.assertIn("第二版已经调过色", context)
        self.assertIn("不能独立授权操作", context)
        board = self.load()
        board["nodes"][0].update(versions=[newer], cur=0)
        self.assertEqual((await self.client.put("/api/board/test", json=board)).status, 200)
        response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages", json={**message,"request_key":"review-version-gone"})
        self.assertEqual(response.status, 400, await response.text())
        self.assertIn("素材版本已失效", (await response.json())["error"])

    async def test_comments_use_shared_board_access_and_resolution_permissions(self):
        url = "/api/board/test/comments"
        guest = {"X-Uid":"8"}
        content = {"body":"检查这一版", "anchor":{"node":"n1","ref":self.source["ref"]}, "request_key":"review-root"}
        self.assertEqual((await self.client.get(url, headers=guest)).status, 404)
        self.assertEqual((await self.client.post(url, headers=guest, json=content)).status, 404)
        self.assertEqual((await self.client.put("/api/board/test", json={**self.board,"shared":True})).status, 200)

        async def comment_version():
            response = await self.client.put("/api/board/test/live", headers=guest, json={
                "tab":"reviewer-tab-id", "view":{"cx":0,"cy":0,"k":1},
            })
            self.assertEqual(response.status, 200, await response.text())
            return (await response.json())["comments_version"]

        initial_version = await comment_version()
        first = await self.client.post(url, json=content)
        self.assertEqual(first.status, 201, await first.text())
        root = (await first.json())["id"]
        posted_version = await comment_version()
        self.assertNotEqual(posted_version, initial_version)
        retry = await self.client.post(url, json=content)
        self.assertEqual((await retry.json())["id"], root)
        self.assertEqual(await comment_version(), posted_version)
        reply = {"body":"已核对", "thread_id":root, "request_key":"review-reply"}
        self.assertEqual((await self.client.post(url, headers=guest, json=reply)).status, 201)
        reply_version = await comment_version()
        self.assertNotEqual(reply_version, posted_version)
        thread, = await (await self.client.get(url, headers=guest)).json()
        self.assertEqual(thread["anchor"]["ref"], self.source["ref"])
        self.assertEqual(thread["replies"][0]["body"], "已核对")
        self.assertFalse(thread["can_resolve"])
        self.assertEqual((await self.client.patch(url+"/"+root, headers=guest, json={"resolved":True})).status, 403)
        self.assertEqual(await comment_version(), reply_version)
        self.assertEqual((await self.client.patch(url+"/"+root, json={"resolved":True})).status, 200)
        resolved_version = await comment_version()
        self.assertNotEqual(resolved_version, reply_version)
        self.assertEqual((await self.client.post(url, headers=guest, json={**reply,"request_key":"new-reply-key"})).status, 400)
        self.assertEqual((await self.client.patch(url+"/"+root, json={"resolved":False})).status, 200)
        self.assertNotEqual(await comment_version(), resolved_version)
        self.assertEqual((await self.client.post(url, headers=guest, json={**reply,"request_key":"new-reply-key"})).status, 201)

    async def test_position_and_invalid_anchors_and_deleted_board(self):
        url = "/api/board/test/comments"
        body = {"body":"留一个位置", "request_key":"point-check"}
        for anchor in ({"x":"0","y":30}, {"node":"missing"}, {"node":"n1","ref":"missing"}):
            self.assertEqual((await self.client.post(url, json={**body,"anchor":anchor})).status, 400)
        self.assertEqual((await self.client.post(url, json={**body,"anchor":{"x":15.123,"y":-30}})).status, 201)
        thread, = await (await self.client.get(url)).json()
        self.assertEqual(thread["anchor"], {"x":15.12,"y":-30})
        self.assertEqual((await self.client.delete("/api/board/test")).status, 200)
        self.assertEqual((await self.client.put("/api/board/test", json={"nodes":[]})).status, 200)
        self.assertEqual(await (await self.client.get(url)).json(), [])
