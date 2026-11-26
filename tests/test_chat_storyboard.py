"""Assistant storyboards, continuity review, and shot revision."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import json

from PIL import Image
from aiohttp import web

from oneshot.editing import image_editor
from oneshot.generation import requests as generation_requests
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatStoryboard(ChatFixture):
    async def test_continue_in_auto_mode_applies_existing_plan_and_generates_shot_images(self):
        plan_data = {"title":"开门","shots":[
            {"duration":5,"scene":"门口","keyframe":"桌上的钥匙","action":["找到钥匙"]},
            {"duration":5,"scene":"门口","keyframe":"钥匙靠近门把","action":["打开门"]}]}
        llm = SimpleNamespace(chat=AsyncMock(return_value=json.dumps(plan_data)))
        self.svc.model.side_effect = [
            call("storyboard_create_plan",{"story":"找到钥匙，打开门。","aspect":"16:9"}),answer()]
        with patch.dict(self.app,{"llm":llm}):
            drafted = await self.send("准备分镜方案",selected=[])
            self.assertEqual((await self.wait(drafted))["state"],"done")
        result = image_editor.save(server.COMFY_DIR,Image.new("RGB",(128,72),"yellow"))

        async def generate(req,payload):
            jid = "e0000000"+str(len(server.JOBS)+12345)
            server.JOBS[jid] = {"state":"done","created":1,"meta":{"uid":7},"outputs":[result]}
            return web.json_response({"ids":[jid]})

        async def continue_turn(key, mode):
            response = await self.client.post(f"/api/chat/sessions/{self.sid}/messages",json={
                "text":"继续","request_key":key,"selected":[],"generation_mode":mode})
            self.assertEqual(response.status,200,await response.text())
            return await self.wait((await response.json())["id"],timeout=5)

        self.svc.model.side_effect = [answer("手动模式继续确认"),answer("已有分镜图")]
        with patch.object(generation_requests,"generate_request",side_effect=generate) as submit:
            self.assertEqual((await continue_turn("request-manual","manual"))["state"],"done")
            submit.assert_not_awaited()
            self.assertEqual((await continue_turn("request-auto","auto"))["state"],"done")
            self.assertEqual(submit.await_count,2)
            self.assertEqual((await continue_turn("request-again","auto"))["state"],"done")
            self.assertEqual(submit.await_count,2)
        board = self.load()
        script, = [n for n in board["nodes"] if n["type"]=="script"]
        pairs = script["data"]["made"]
        images = {n["id"]:n for n in board["nodes"] if n["type"]=="image"}
        self.assertEqual([images[p["img"]]["versions"][0]["ref"] for p in pairs],[result["ref"]]*2)
        self.assertTrue(any(e["from"]==pairs[0]["img"] and e["to"]==pairs[1]["img"] for e in board["edges"]))

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

    async def test_explicit_apply_can_use_plan_created_in_the_same_turn(self):
        draft = {"title":"一扇门","shots":[{"duration":5,"scene":"门外","keyframe":"门半开"}]}
        llm = SimpleNamespace(chat=AsyncMock(return_value=json.dumps(draft)))
        self.svc.model.side_effect = [call("storyboard_create_plan",{"story":"推开门。"},"draft"),
                                      call("storyboard_apply",{},"apply"),answer("已加入分镜")]
        with patch.dict(self.app,{"llm":llm}):
            rid = await self.send("拟好分镜并直接加入画布",selected=[])
            self.assertEqual((await self.wait(rid))["state"],"done")
        script, = [node for node in self.load()["nodes"] if node["type"]=="script"]
        self.assertEqual(script["name"],"一扇门")

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
