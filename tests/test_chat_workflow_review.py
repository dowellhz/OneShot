"""Assistant workflow provenance and read-only canvas plans."""

import json

from PIL import Image

from oneshot.assistant import agent_chat as chat
from oneshot.editing import image_editor
from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class ChatWorkflowReview(ChatFixture):
    async def test_workflow_review_resolves_copied_version_source(self):
        ref = self.source["ref"]
        board = self.load()
        board["nodes"].append({"id":"n3","type":"image","name":"版本副本","data":{},"cur":0,
                               "versions":[{**self.source,"copied_from":{"node":"n1","ref":ref,"version":1}}]})
        response = await self.client.put("/api/board/test",json=board)
        self.assertEqual(response.status,200,await response.text())
        response = await self.client.get("/api/board/test/workflow-review?node=n3")
        self.assertEqual(response.status,200,await response.text())
        steps = (await response.json())["steps"]
        self.assertEqual([step["node"] for step in steps],["n1","n3"])
        source, = steps[-1]["inputs"]
        self.assertEqual((source["node"],source["version"],source["role"],source["ref"]),("n1",1,"复制自版本",ref))
        template = server.board_store.workflow_template(board,["n3"])
        self.assertEqual(template["nodes"][0]["versions"][0]["copied_from"],{"ref":ref,"version":1})

    async def test_workflow_review_preserves_reference_versions_and_is_read_only(self):
        guide = image_editor.save(server.COMFY_DIR, Image.new("RGB", (64, 64), "blue"), "input")
        node = self.board["nodes"][0]
        node["versions"].append(guide)
        node["cur"] = 1
        self.board["collaborators"] = {"8":"reviewer"}
        output = {"id":"n3","type":"video","name":"<成片>","cur":1,"versions":[
            {"ref":"output:h3studio/first.mp4","source":"gen","generation_record":{
                "prompt":"原始提示词\n```","settings":{"provider_model":"configured-test","duration":5},
                "inputs":[{"node_id":"n1","ref":self.source["ref"],"version":1,"role":"first","time":0},
                          {"node_id":"n2","role":"text","text":"录制时的旁白"}]}},
            {"ref":"output:h3studio/latest.mp4","source":"gen","prompt":"后来改写的提示词"},
        ]}
        self.board["nodes"].append(output)
        self.board["edges"] = [{"from":"n2","to":"n3"}]
        path = server.board_path("test")
        baseline = chat.dumps(self.board)
        path.write_text(baseline)
        url = "/api/board/test/workflow-review?node=n3&version=1"
        response = await self.client.get(url, headers={"X-Uid":"8"})
        self.assertEqual(response.status, 200)
        review = await response.json()
        self.assertEqual([(s["node"],s["version"]) for s in review["steps"]], [("n1",1),("n2",None),("n3",1)])
        self.assertEqual(review["steps"][-1]["inputs"][0]["evidence"], "生成记录")
        self.assertIn("录制时的旁白", review["markdown"])
        self.assertIn("configured-test", review["markdown"])
        self.assertNotIn("后来改写", review["markdown"])
        self.assertIn("````\n原始提示词", review["markdown"])
        self.assertNotIn("<成片>", review["markdown"])
        denied = await self.client.get(url, headers={"X-Uid":"9"})
        self.assertEqual(denied.status, 404)
        latest = await self.client.get("/api/board/test/workflow-review?node=n3")
        dependencies = (await latest.json())["steps"][-1]["inputs"]
        self.assertEqual(dependencies[0]["evidence"], "当前连线")
        self.assertEqual((await self.client.get("/api/board/test/workflow-review?node=n3&version=4")).status, 404)

        self.svc.model.side_effect = [call("canvas_workflow_review", {"node_id":"n3","version":1}), answer("复盘完成")]
        rid = await self.send("第一个版本怎么做的")
        self.assertEqual((await self.wait(rid))["state"], "done")
        data = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])
        self.assertEqual(data["workflow"]["version"], 1)
        self.assertEqual(data["workflow"]["steps"][-1]["inputs"][0]["ref"], self.source["ref"])
        self.assertEqual(path.read_text(), baseline)

    async def test_reference_plan_pins_replacement_and_does_not_modify_canvas(self):
        board = self.load()
        latest = image_editor.save(server.COMFY_DIR, Image.new("RGB", (60, 32), "blue"), "input")
        board["nodes"].extend([
            {"id":"replacement","type":"image","name":"新素材","x":1200,"y":100,
             "data":{},"versions":[self.source,latest],"cur":1},
            {"id":"target","type":"image","name":"镜头","x":1600,"y":100,
             "data":{},"versions":[],"cur":-1},
        ])
        board["groups"] = [{"id":"shots","name":"镜头组","nodes":["target","n2"]}]
        board["edges"] = [{"from":"n1","to":"target","ref":self.source["ref"],"prompt_slot":4}]
        path = server.board_path("test")
        server.write_board(path, board)
        original = path.read_text()
        args = {"source_node_id":"n1","replacement_node_id":"replacement","group_id":"shots","version":1}
        self.svc.model.side_effect = [call("canvas_reference_plan",args),answer("请在预览中确认")]
        rid = await self.send("换一下镜头组的参考素材")
        self.assertEqual((await self.wait(rid))["state"], "done")
        plan = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])["reference_plan"]
        self.assertEqual((plan["board"],plan["source"],plan["replacement"],plan["version"],plan["ref"],plan["group"]),
                         ("test","n1","replacement",1,self.source["ref"],"shots"))
        self.assertEqual(path.read_text(), original)
        self.svc.model.side_effect = [call("canvas_reference_plan",{**args,"replacement_node_id":"n2"}),answer()]
        invalid = await self.send("改用不匹配的素材",key="reference-plan-invalid")
        self.assertEqual((await self.wait(invalid))["state"], "done")
        error = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", invalid)["result"])
        self.assertIn("类型相同",error["error"])
        self.assertEqual(path.read_text(), original)
        memory = await self.client.post("/api/memory",json={"kind":"character","board":"test",
            "name":"林森","ref":self.source["ref"],"character_view":"main"})
        self.assertEqual(memory.status,200,await memory.text())
        memory_id = (await memory.json())["id"]
        side = await self.client.post("/api/memory",json={"id":memory_id,"board":"test","ref":latest["ref"],"character_view":"side"})
        self.assertEqual(side.status,200,await side.text())
        memory_args = {"source_node_id":"n1","memory_id":memory_id,"character_view":"side","target_ids":["target"]}
        self.svc.model.side_effect = [call("canvas_reference_plan",memory_args),answer("已准备侧面图")]
        rid = await self.send("只把镜头的参考换成林森侧面图",key="reference-plan-memory")
        self.assertEqual((await self.wait(rid))["state"], "done")
        asset_plan = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])["reference_plan"]
        self.assertEqual((asset_plan["memory"],asset_plan["ref"],asset_plan["character_view"],asset_plan["targets"]),
                         (memory_id,latest["ref"],"side",["target"]))
        self.assertEqual(path.read_text(), original)
        self.svc.model.side_effect = [call("canvas_reference_plan",{**memory_args,"character_view":"back"}),answer()]
        rid = await self.send("改用林森背面图",key="reference-plan-unapproved")
        self.assertEqual((await self.wait(rid))["state"], "done")
        error = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?", rid)["result"])
        self.assertIn("尚未定稿",error["error"])

    async def test_group_run_plan_is_scoped_and_does_not_submit_jobs(self):
        board = self.load()
        board["nodes"].append({"id":"n3","type":"video","name":"待生成镜头","x":1100,"y":80,
                               "data":{"prompt":"横移"},"versions":[],"cur":-1})
        board["groups"] = [{"id":"shots","name":"镜头组","nodes":["n1","n2","n3"]}]
        path = server.board_path("test")
        server.write_board(path, board)
        baseline = path.read_text()
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots"}),answer("请确认运行计划")]
        rid = await self.send("补齐镜头组")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertEqual(result["group_run_plan"],{"board":"test","group":"shots","name":"镜头组","targets":["n3"],"mode":"missing"})
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots","target_ids":["n1"]}),answer()]
        rid = await self.send("只重跑参考图",key="specific-group-run")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertEqual((result["group_run_plan"]["targets"],result["group_run_plan"]["mode"]),(["n1"],"all"))
        self.svc.model.side_effect = [call("canvas_group_run_plan",{"group_id":"shots","target_ids":["n2"]}),answer()]
        rid = await self.send("运行文字节点",key="invalid-group-run")
        self.assertEqual((await self.wait(rid))["state"],"done")
        result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",rid)["result"])
        self.assertIn("无法在分组内生成",result["error"])
        self.assertEqual(path.read_text(),baseline)
