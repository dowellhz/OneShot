"""Assistant profiles, creative memory, and skill attachments."""

import asyncio

from oneshot.assistant import agent_chat as chat
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatCreativeContext(ChatFixture):
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
