"""Video draft finalization and task recovery."""

from unittest.mock import patch
import asyncio
import json
import time

from PIL import Image

from oneshot.storage import db
import server

from chat_fixture import ChatFixture, answer, call


class VideoDraft(ChatFixture):
    async def test_native_draft_can_finalize_after_job_recovery_without_resubmitting_inputs(self):
        film=server.film
        files=[]
        for i in range(2):
            path,ref=film._new(server.COMFY_DIR,"output",f"draft-result-{i}",".mp4")
            film.encode_silent(path,(Image.new("RGB",(64,64),"red") for _ in range(24)),
                               64,64,24,lambda:False,lambda _:None)
            files.append({"files":[{"path":path,"ref":ref,"kind":"video"}]})
        draft_ref=files[0]["files"][0]["ref"]
        provider={"id":"ark-draft","name":"方舟","kind":"ark","enabled":True,"config":{},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-test"}
        payload={"kind":"video","board":"test","prompt":"产品入镜","draft":True}
        posts=[]

        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="POST":
                posts.append(kwargs["json"])
                return {"id":f"task-{len(posts)}"}
            return {"status":"succeeded","content":{"video_url":"https://provider.example/edit.mp4"}}

        async def job(response):
            self.assertEqual(response.status,200,await response.text())
            jid=(await response.json())["ids"][0]
            for _ in range(300):
                state=server.JOBS[jid]
                if state["state"] in ("done","error"):
                    break
                await asyncio.sleep(.01)
            self.assertEqual(state["state"],"done",state.get("error"))
            return jid

        with patch.object(server.providers,"primary",return_value=route),patch.object(server.providers,"get",return_value=provider), \
             patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",side_effect=files):
            route["model"]="doubao-seedance-2-5-flash-test"
            self.assertEqual((await self.client.post("/api/generate",json=payload)).status,400)
            route["model"]="doubao-seedance-2-5-test"
            jid=await job(await self.client.post("/api/generate",json=payload))
            self.assertEqual((posts[0]["draft"],posts[0]["resolution"]),(True,"480p"))
            self.assertEqual(posts[0]["content"][0]["text"],"产品入镜")
            server.JOBS.clear()
            recovered=await (await self.client.get("/api/jobs?ids="+jid)).json()
            self.assertGreater(recovered[jid]["outputs"][0]["extra"]["draft_expires"],0)
            self.assertNotIn("task-1",json.dumps(recovered))
            self.board["nodes"].append({"id":"n4","type":"video","name":"样片","x":0,"y":0,"data":{},"cur":0,
                                       "versions":[{"ref":draft_ref}]})
            server.write_board(server.board_path("test"),self.board)
            final={"board":"test","node":"n4","ref":draft_ref,"resolution":"4k","request_key":"test-draft-final-0001"}
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json=final,headers={"X-Uid":"8"})).status,403)
            final_id=await job(await self.client.post("/api/video/draft/finalize",json=final))
            self.assertEqual(posts[1],{"model":route["model"],"content":[{"type":"draft_task","draft_task":{"id":"task-1"}}],
                                       "resolution":"4k","watermark":False})
            replay=await self.client.post("/api/video/draft/finalize",json=final)
            self.assertEqual((await replay.json())["ids"],[final_id])
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json={**final,"resolution":"1080p"})).status,400)
            db.run("UPDATE video_drafts SET expires=0 WHERE ref=?",draft_ref)
            server.JOBS.clear()
            recovered=await self.client.post("/api/video/draft/finalize",json=final)
            self.assertEqual((await recovered.json())["ids"],[final_id])
            self.assertEqual((await self.client.post("/api/video/draft/finalize",json={
                **final,"request_key":"test-draft-final-0002"})).status,400)
            self.assertEqual(len(posts),2)

    async def test_assistant_finalizes_a_previous_draft_in_the_same_node(self):
        files = []
        for color in ("red", "green", "blue"):
            path, ref = server.film._new(server.COMFY_DIR, "output", f"draft-{color}", ".mp4")
            server.film.encode_silent(path, (Image.new("RGB", (64, 64), color) for _ in range(24)),
                                      64, 64, 24, lambda: False, lambda _: None)
            files.append({"path":path, "ref":ref, "kind":"video"})
        sample, alternate, final = files
        provider = {"id":"ark-draft", "name":"方舟", "kind":"ark", "enabled":True,
                    "config":{}, "secrets":{"api_key":"fixture"}}
        model = "doubao-seedance-2-5-test"
        db.task_start(id="sample-job", user_id=7, board_id="test", provider_id=provider["id"],
                      provider_kind="ark", model=model, state="done", outputs=[sample["ref"]])
        db.run("INSERT INTO video_drafts VALUES (?,?,?,?)", sample["ref"], "sample-job", "private-sample-id", time.time()+3600)
        sample_edge = {"from":"n1", "to":"n4", "role":"first"}
        alternate_edge = {"from":"n2", "to":"n4"}
        self.board["edges"] = [alternate_edge]
        self.board["nodes"].append({"id":"n4", "type":"video", "name":"产品镜头", "x":0, "y":0, "cur":1,
            "data":{"prompt":"当前的另一镜"}, "versions":[
                {"ref":sample["ref"], "prompt":"原样片提示", "input_edges":[sample_edge],
                 "node_data":{"prompt":"原样片提示", "draft":True},
                 "video_recipe":{"kind":"video", "prompt":"原样片提示", "draft":True, "duration":4},
                 "generation_record":{"effective_prompt":"原样片提示", "settings":{"duration":4}}},
                {"ref":alternate["ref"], "prompt":"当前的另一镜"}]})
        server.write_board(server.board_path("test"), self.board)
        posts = []

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "POST":
                board = self.load()
                self.assertEqual(board["nodes"][-1]["data"]["prompt"], "当前的另一镜")
                self.assertEqual(board["edges"], [alternate_edge])
                posts.append(kwargs["json"])
                return {"id":"final-task"}
            return {"status":"succeeded", "content":{"video_url":"https://provider.example/final.mp4"}}

        self.svc.model.side_effect = [call("video_draft_status", {"node_id":"n4"}, "read"),
            call("video_draft_finalize", {"node_id":"n4", "version":1, "resolution":"4k"}, "finalize"), answer()]
        with patch.object(server.providers, "get", return_value=provider), \
             patch.object(server.remote, "json_req", side_effect=upstream), \
             patch.object(server.remote, "_save_video", return_value={"files":[final]}):
            run = await self.send("把第一版样片做成 4K 定稿", selected=["n4"])
            await self.wait(run)
        rows = db.q("SELECT result FROM chat_calls WHERE run_id=? ORDER BY rowid", run)
        status, result = [json.loads(row["result"]) for row in rows]
        self.assertEqual([(v["version"], v["current"], v["expired"]) for v in status["drafts"]], [(1, False, False)])
        self.assertNotIn("private-sample-id", json.dumps([status, result]))
        self.assertEqual(posts, [{"model":model, "content":[{"type":"draft_task", "draft_task":{"id":"private-sample-id"}}],
                                  "resolution":"4k", "watermark":False}])
        self.assertEqual(result["nodes"][0]["id"], "n4")
        board = self.load()
        node = board["nodes"][-1]
        self.assertEqual((len(node["versions"]), node["cur"]), (3, 2))
        self.assertEqual([v["ref"] for v in node["versions"]], [v["ref"] for v in files])
        self.assertEqual((node["data"]["prompt"], board["edges"]), ("原样片提示", [sample_edge]))
        self.assertNotIn("draft", node["data"])
        self.assertEqual(node["versions"][-1]["generation_record"]["settings"],
                         {"duration":4, "resolution":"4k", "provider_model":model})
        report = server.workflow_review.build(board, "n4", 3)
        self.assertFalse(report["has_cycle"])
        self.assertEqual([(v["node"], v["version"]) for v in report["steps"][-1]["inputs"] if v["role"] == "定稿样片"],
                         [("n4", 1)])

        self.svc.model.side_effect = [
            call("video_draft_finalize", {"node_id":"n4","version":1,"placement":"branch"}, "branch"), answer()]
        release_branch = asyncio.Event()

        async def branch_status(_http, method, *args, **kwargs):
            if method == "POST":
                return {"id":"branch-final"}
            await release_branch.wait()
            return {"status":"succeeded","content":{"video_url":"https://provider.example/final.mp4"}}

        with patch.object(server.providers,"get",return_value=provider), \
             patch.object(server.remote,"json_req",side_effect=branch_status), \
             patch.object(server.remote,"_save_video",return_value={"files":[final]}):
            branched_run = await self.send("把第一版样片做成并排定稿",key="draft-branch",selected=["n4"])
            for _ in range(150):
                pending = self.load()
                if pending["nodes"][-1]["id"] != "n4" and pending["nodes"][-1].get("job"):
                    break
                await asyncio.sleep(.01)
            else:
                self.fail("assistant did not put the final on a new branch")
            source, branch = pending["nodes"][-2:]
            self.assertEqual(source,node)
            self.assertGreater(branch["x"],source["x"])
            self.assertEqual(pending["edges"],[sample_edge,
                {"from":"n4","to":branch["id"],"relation":"draft_final","ref":sample["ref"]}])
            moved = source["versions"].pop(0)
            source["cur"] -= 1
            moved["tab_nodes"] = ["n4"]
            pending["nodes"].insert(-1,{**source,"id":"moved-draft","cur":0,"versions":[moved]})
            pending["edges"][-1]["from"] = "moved-draft"
            server.write_board(server.board_path("test"),pending)
            release_branch.set()
            await self.wait(branched_run)
        branch_result = json.loads(db.one("SELECT result FROM chat_calls WHERE run_id=?",branched_run)["result"])
        self.assertTrue(branch_result.get("nodes"),branch_result)
        branched = self.load()
        branch = branched["nodes"][-1]
        self.assertNotEqual(branch["id"],"n4")
        self.assertEqual(branched["edges"],[sample_edge,
            {"from":"moved-draft","to":branch["id"],"relation":"draft_final","ref":sample["ref"]}])
        self.assertEqual((branch["cur"],branch["versions"][0]["ref"]),(0,final["ref"]))
        self.assertEqual(branch["versions"][0]["draft_final"]["source_node"],"moved-draft")
        self.assertEqual(branch["versions"][0]["input_edges"],[branched["edges"][-1]])
        branch_report = server.workflow_review.build(branched,branch["id"],1)
        self.assertFalse(branch_report["has_cycle"])
        self.assertEqual([(v["node"],v["version"]) for v in branch_report["steps"][-1]["inputs"]
                          if v["role"]=="定稿样片"],[("moved-draft",1)])
