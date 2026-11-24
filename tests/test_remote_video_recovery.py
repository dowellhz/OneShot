import asyncio
import time
from unittest.mock import AsyncMock, patch

from PIL import Image

from oneshot.storage import db
import server
from test_agent_chat import ChatFixture


class RemoteVideoRecovery(ChatFixture):
    async def test_recovered_cloud_video_preserves_submission_settings(self):
        provider = {"id":"ark","kind":"ark","name":"提交时的服务","config":{},"enabled":True}
        model = "doubao-seedance-2-5-qa"
        jid = "xabcdef000008"
        prompt = "让红色火车驶出画面"
        receipt = server.remote.video_receipt(provider,"external-42")
        db.task_start(id=jid,capability="video",provider_id=provider["id"],provider_kind=provider["kind"],model=model,
                      user_id=7,request={"prompt":prompt,"resolution":"4k"})
        job = server.job_from_log(db.one("SELECT * FROM tasks WHERE id=?",jid))
        job["started"] = time.time()
        job["meta"].update(provider=provider["name"],model=model,resolution="4k",mode_name="局部修改")
        server.record_remote_video(job,receipt)

        renamed = {**provider,"name":"现在的服务名称"}
        with patch.object(server.providers,"get",return_value=renamed), patch.object(server,"start_remote") as start:
            restored = server.restore_logged_job(self.app,db.one("SELECT * FROM tasks WHERE id=?",jid))
        expected = {"provider":provider["name"],"model":model,"resolution":"4k","mode_name":"局部修改","prompt":prompt}
        self.assertEqual({k:restored["meta"][k] for k in expected},expected)
        self.assertEqual(start.call_args.kwargs["receipt"],receipt)

        restored.update(state="done",finished=time.time(),outputs=[])
        server.log_end(restored)
        del server.JOBS[jid]
        completed = server.restore_logged_job(self.app,db.one("SELECT * FROM tasks WHERE id=?",jid))
        self.assertEqual({k:completed["meta"][k] for k in expected},expected)

        legacy = "xabcdef000009"
        db.task_start(id=legacy,capability="video",provider_id=provider["id"],provider_kind=provider["kind"],model=model,
                      user_id=7,state="done",request={"prompt":prompt,"resolution":"1080p","mode_name":"1080P 定稿"})
        restored = server.restore_logged_job(self.app,db.one("SELECT * FROM tasks WHERE id=?",legacy))
        self.assertEqual((restored["meta"]["model"],restored["meta"]["resolution"],restored["meta"]["mode_name"]),
                         (model,"1080p","1080P 定稿"))

    async def test_interrupted_video_keeps_the_provider_job_and_recovers_its_output(self):
        fixtures = {
            "kling": ("kling-3.0", {"data":{"id":"external-42"}}, {"data":[{
                "status":"succeeded", "outputs":[{"type":"video","url":"https://media.example/result.mp4"}],
                "billing":[{"currency":"CNY","amount":"1.8"}]}]}),
            "minimax": ("MiniMax-H3", {"task_id":42}, {
                "task":{"status":"succeeded","content":{"url":"https://media.example/result.mp4"}}}),
            "ark": ("ep-example", {"id":"external-42"}, {
                "status":"succeeded","content":{"video_url":"https://media.example/result.mp4"}}),
        }
        source = self.root / "video.mp4"
        frames = (Image.new("RGB", (64, 64), "red") for _ in range(24))
        server.film.encode_silent(source, frames, 64, 64, 12, lambda:False, lambda _:None)

        async def download(_http, url, path, _name):
            self.assertEqual(url, "https://media.example/result.mp4")
            path.write_bytes(source.read_bytes())

        for index, (kind, (model, sent, result)) in enumerate(fixtures.items()):
            with self.subTest(provider=kind):
                jid = "x" + f"{index:012x}"
                provider = {"id":kind,"name":kind,"kind":kind,"enabled":True,"config":{},
                            "secrets":{"api_key":"example-secret"}}
                draft = kind == "ark"
                request = {"prompt":"车站镜头", "draft":draft}
                db.task_start(id=jid, capability="video", provider_id=kind, provider_kind=kind,
                              model=model, user_id=7, board_id="test", request=request)
                row = db.one("SELECT * FROM tasks WHERE id=?", jid)
                job = server.JOBS[jid] = server.job_from_log(row)
                polling = asyncio.Event()
                restarted = False
                calls = []

                async def upstream(_http, method, url, _name, **kwargs):
                    calls.append(method)
                    if method == "POST":
                        self.assertFalse(restarted)
                        self.assertEqual(kwargs["json"].get("draft", False), draft)
                        return sent
                    recorded = db.one("SELECT state,request FROM tasks WHERE id=?", jid)
                    payload = server.task_settings(recorded["request"])
                    task_id = "42" if kind == "minimax" else "external-42"
                    self.assertEqual(recorded["state"], "running")
                    self.assertEqual(payload["remote_video"]["task_id"], task_id)
                    self.assertEqual(payload["prompt"], request["prompt"])
                    self.assertNotIn("example-secret", recorded["request"])
                    if kind == "kling":
                        self.assertEqual(kwargs["params"], {"task_ids":task_id})
                    else:
                        self.assertTrue(url.endswith("/" + task_id))
                    if not restarted:
                        polling.set()
                        await asyncio.Future()
                    return result

                with patch.object(server.remote, "json_req", side_effect=upstream), \
                        patch.object(server.remote, "download", side_effect=download), \
                        patch.object(server.providers, "get", return_value=provider), \
                        patch.object(server, "start_remote", wraps=server.start_remote) as start:
                    task = server.start_remote(self.app, job, provider, model, "video", request)
                    try:
                        await asyncio.wait_for(polling.wait(), 2)
                    finally:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    server.JOBS.pop(jid)
                    restarted = True
                    server.recover_remote_videos(self.app)
                    server.recover_remote_videos(self.app)
                    self.assertEqual(start.call_count, 2)
                    for _ in range(100):
                        if server.JOBS[jid]["state"] == "done":
                            break
                        await asyncio.sleep(.01)
                    self.assertEqual(calls, ["POST","GET","GET"])
                    final = db.one("SELECT * FROM tasks WHERE id=?", jid)
                    self.assertEqual(final["state"], "done", final["error"])
                    self.assertEqual(final["started"], job["started"])
                    self.assertEqual(final["cost"], 1.8 if kind == "kling" else None)
                    output, = server.JOBS[jid]["outputs"]
                    self.assertEqual(output["meta"]["duration"], 2)
                    saved_draft = db.one("SELECT * FROM video_drafts WHERE job_id=?", jid)
                    if draft:
                        self.assertEqual(saved_draft["provider_task"], "external-42")
                        receipt = server.task_settings(final["request"])["remote_video"]
                        self.assertEqual(saved_draft["expires"], receipt["draft_created"] + 14 * 86400)
                        self.assertEqual(output["extra"]["draft_expires"], saved_draft["expires"])
                    else:
                        self.assertIsNone(saved_draft)

    async def test_recovery_does_not_contact_a_changed_endpoint(self):
        provider = {"kind":"ark","name":"Seedance","config":{"base_url":"https://original.example/api"}}
        receipt = server.remote.video_receipt(provider, "external-42", time.time())
        provider["config"]["base_url"] = "https://different.example/api"
        with patch.object(server.remote, "json_req", new_callable=AsyncMock) as upstream:
            with self.assertRaisesRegex(server.providers.ProviderError, "请求地址已变更"):
                await server.remote.resume_video(self.http, server.COMFY_DIR, provider, receipt)
            upstream.assert_not_called()

    async def test_interrupted_download_removes_partial_video(self):
        async def download(_http, _url, path, _name):
            path.write_bytes(b"partial")
            raise asyncio.CancelledError()

        with patch.object(server.remote, "download", side_effect=download):
            with self.assertRaises(asyncio.CancelledError):
                await server.remote._save_video(self.http, server.COMFY_DIR, "MiniMax", "https://media.example/result.mp4")
        self.assertEqual(list((server.COMFY_DIR / "output/h3studio").glob("vid_*")), [])

    async def test_recovered_error_hides_temporary_reference_link(self):
        provider = {"id":"ark","kind":"ark","name":"Seedance","config":{}}
        jid = "xabcdef000003"
        receipt = server.remote.video_receipt(provider, "external-42")
        db.task_start(id=jid, capability="video", provider_kind="ark", request={"remote_video":receipt})
        job = server.job_from_log(db.one("SELECT * FROM tasks WHERE id=?", jid))
        token = "a" * 64
        detail = f"参考视频无法读取 https://studio.example/api/motion-guide/{token}"
        with patch.object(server.remote, "resume_video", side_effect=server.providers.ProviderError(detail)):
            await server.run_remote(self.app, job, provider, "ep-example", "video", {}, receipt=receipt)
        self.assertEqual(job["state"], "error")
        self.assertNotIn(token, db.one("SELECT error FROM tasks WHERE id=?", jid)["error"])

    async def test_older_job_without_receipt_and_already_cancelled_job_do_not_resubmit(self):
        older = "xabcdef000001"
        cancelled = "xabcdef000002"
        db.task_start(id=older, capability="video", provider_kind="ark", request={"prompt":"车站"})
        db.task_start(id=cancelled, capability="video", provider_kind="ark", state="error",
                      error="已取消", request={"remote_video":{"task_id":"external-42"}})
        with patch.object(server, "start_remote") as start:
            server.recover_remote_videos(self.app)
            self.assertNotIn(older, server.JOBS)
            self.assertNotIn(cancelled, server.JOBS)
            job = server.restore_logged_job(self.app, db.one("SELECT * FROM tasks WHERE id=?", older))
            self.assertIn("请先到视频服务查询", job["error"])
            start.assert_not_called()
