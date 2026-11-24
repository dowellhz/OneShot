import asyncio
import io
import json
import time
import wave
import zipfile
from array import array
from unittest.mock import patch

from oneshot.storage import db
import server
from oneshot import config
from PIL import Image
from test_agent_chat import ChatFixture


class GenerationHistory(ChatFixture):
    async def test_video_history_restores_effective_generation_details(self):
        ref = "output:h3studio/sample.mp4"
        meta = {"uid":7,"provider":"本地 H3","model":"h3-video","mode":"planned",
                "mode_name":"人物设定","resolution":"480P","full_prompt":"Use the red toy train as a reference.","seed":63071}
        db.task_start(id="local-video-history",user_id=7,capability="video",state="running")
        server.log_end({"id":"local-video-history","kind":"video","state":"done","created":100,
                        "finished":104,"outputs":[{"ref":ref}],"meta":meta})
        reply = await self.client.get("/api/jobs",params={"ids":"local-video-history"})
        self.assertEqual(reply.status,200)
        restored = (await reply.json())["local-video-history"]
        self.assertEqual(restored["state"],"done")
        self.assertEqual({key:restored["meta"][key] for key in meta},meta)

    async def test_audio_waveform_is_version_specific_and_private(self):
        ref = "input:h3studio/waveform.wav"
        path = server.tools.ref_path(server.COMFY_DIR,ref)
        path.parent.mkdir(parents=True,exist_ok=True)
        sample_rate = 8000
        with wave.open(str(path),"wb") as output:
            output.setparams((2,2,sample_rate,0,"NONE",""))
            samples = array("h",[0,0])*sample_rate + array("h",[16384,-16384])*sample_rate
            output.writeframes(samples.tobytes())
        db.run("INSERT INTO memory_uploads VALUES(?,?,?)",ref,7,time.time())
        route = "/api/audio/waveform"
        response = await self.client.get(route,params={"ref":ref})
        self.assertEqual(response.status,200)
        data = await response.json()
        self.assertEqual(data["seconds"],2)
        self.assertEqual(data["peaks"][:64],[0]*64)
        self.assertEqual(data["peaks"][64:],[.5]*64)
        denied = await self.client.get(route,params={"ref":ref},headers={"X-Uid":"8"})
        self.assertEqual(denied.status,404)
        self.assertEqual((await self.client.get(route,params={"ref":self.source["ref"]})).status,404)

    async def test_asset_transfers_stream_source_and_deduplicated_archive(self):
        ref = self.source["ref"]
        original = server.tools.ref_path(server.COMFY_DIR,ref).read_bytes()
        other = server.image_editor.save(server.COMFY_DIR,Image.new("RGBA",(32,32),"blue"),"extra","input")["ref"]
        db.run("INSERT INTO memory_uploads VALUES(?,?,?)",other,7,time.time())
        route = "/api/assets/transfers"
        with patch.object(config,"DATA_DIR",self.root),patch.object(server.asset_transfers,"TRANSFERS",{}):
            reply = await self.client.post(route,json={"refs":[ref,ref],"name":"素材清单.zip"})
            self.assertEqual(reply.status,202)
            single = await reply.json()
            single_path = route+"/"+single["id"]
            self.assertEqual((single["count"],single["state"]),(1,"ready"))
            self.assertEqual((await self.client.get(single_path,headers={"X-Uid":"8"})).status,404)
            self.assertEqual((await self.client.get(single_path+"/file",headers={"X-Uid":"8"})).status,404)
            file = await self.client.get(single_path+"/file")
            self.assertEqual(file.status,200)
            self.assertEqual(await file.read(),original)
            sent = await (await self.client.get(single_path)).json()
            self.assertEqual((sent["state"],sent["bytes"],sent["total"]),("sent",len(original),len(original)))

            multi = await (await self.client.post(route,json={"refs":[ref,ref,other],"name":"素材清单.zip"})).json()
            multi_path = route+"/"+multi["id"]
            for _ in range(100):
                status = await (await self.client.get(multi_path)).json()
                if status["state"]!="packing":
                    break
                await asyncio.sleep(.02)
            self.assertEqual((status["state"],status["count"],status["name"]),("ready",2,"素材清单.zip"))
            bundle = await self.client.get(multi_path+"/file")
            self.assertEqual(bundle.status,200)
            with zipfile.ZipFile(io.BytesIO(await bundle.read())) as archive:
                self.assertEqual(len(archive.namelist()),2)
                self.assertEqual(archive.read(archive.namelist()[0]),original)
            db.run("DELETE FROM memory_uploads WHERE ref=?",other)
            self.assertEqual((await self.client.get(multi_path+"/file")).status,400)
            status = await (await self.client.get(multi_path)).json()
            self.assertEqual(status["state"],"error")

    async def test_watermark_is_snapshotted_and_published_as_an_owned_output(self):
        ref = self.source["ref"]
        original = server.tools.ref_path(server.COMFY_DIR,ref)
        before = original.read_bytes()
        db.task_start(id="unmarked",user_id=7,capability="image",state="running")
        db.run("INSERT INTO media_preferences VALUES(7,1)")
        db.task_start(id="watermarked",user_id=7,capability="image",state="running")
        db.task_start(id="other-owner",user_id=8,capability="image",state="running")
        db.task_start(id="ordinary-render",user_id=7,capability="render",state="running")
        db.run("UPDATE media_preferences SET ai_watermark=0 WHERE user_id=7")
        self.assertEqual(db.q("SELECT job_id FROM task_watermarks"),[{"job_id":"watermarked"}])

        job = {"id":"watermarked","kind":"image","state":"running","meta":{"uid":7},"created":time.time()}
        await server.complete_outputs(job,[{"ref":ref,"meta":{"width":128,"height":96}}])
        self.assertEqual(job["state"],"done",job.get("error"))
        self.assertEqual(original.read_bytes(),before)
        output, = job["outputs"]
        self.assertTrue(output["extra"]["ai_watermark"])
        self.assertNotEqual(output["ref"],ref)
        response = await self.client.get(output["url"])
        self.assertEqual(response.status,200)
        with Image.open(io.BytesIO(await response.read())) as picture:
            self.assertEqual((picture.size,picture.getpixel((1,1))),((128,96),(255,0,0,255)))
            self.assertGreater(len(picture.getcolors()),1)
        self.assertEqual((await self.client.get(output["url"],headers={"X-Uid":"8"})).status,404)
        row = db.one("SELECT * FROM tasks WHERE id='watermarked'")
        restored = server.restore_logged_job(self.app,row)
        self.assertTrue(restored["outputs"][0]["extra"]["ai_watermark"])
        self.assertEqual(restored["outputs"][0]["ref"],output["ref"])

    async def test_favorite_is_idempotent_and_marks_only_the_owners_history(self):
        ref = self.source["ref"]
        db.task_start(id="fav-result", user_id=7, board_id="test", capability="image", state="done", outputs=[ref])
        path = "/api/media-favorites"
        payload = {"ref":ref, "favorite":True, "label":"茶色封面", "prompt":"琥珀色茶汤", "width":128, "height":96}
        for _ in range(2):
            self.assertEqual(await (await self.client.post(path,json=payload)).json(), {"favorite":True})
        favorites = await (await self.client.get(path,params={"kind":"image","q":"琥珀色"})).json()
        item, = favorites["items"]
        self.assertEqual((item["ref"],item["width"],item["label"],item["available"]),(ref,128,"茶色封面",True))
        history = await (await self.client.get("/api/generation-history?board=test")).json()
        self.assertTrue(history["items"][0]["favorite"])
        self.assertEqual((await (await self.client.get(path,headers={"X-Uid":"8"})).json())["items"],[])
        self.assertEqual(await (await self.client.post(path,json={"ref":ref,"favorite":False})).json(), {"favorite":False})
        history = await (await self.client.get("/api/generation-history?board=test")).json()
        self.assertFalse(history["items"][0]["favorite"])

    async def test_favorite_does_not_grant_permanent_access_to_shared_media(self):
        guest, ref = {"X-Uid":"8"}, self.source["ref"]
        path = "/api/media-favorites"
        data = {"ref":ref,"favorite":True}
        self.assertEqual((await self.client.post(path,json=data,headers=guest)).status,404)
        self.board["collaborators"] = {"8":"reviewer"}
        server.write_board(server.board_path("test"),self.board)
        self.assertEqual((await self.client.post(path,json=data,headers=guest)).status,200)
        self.board.pop("collaborators")
        server.write_board(server.board_path("test"),self.board)
        item, = (await (await self.client.get(path,headers=guest)).json())["items"]
        self.assertFalse(item["available"])
        self.assertIsNone(item["url"])
        self.assertEqual((await self.client.get("/media",params={"ref":ref},headers=guest)).status,404)
        self.assertEqual((await self.client.post(path,json={**data,"favorite":False},headers=guest)).status,200)
        self.assertEqual((await (await self.client.get(path,headers=guest)).json())["items"],[])

    async def test_completed_outputs_remain_available_after_source_deletion(self):
        own = "output:h3studio/take.png"
        path = server.tools.ref_path(server.COMFY_DIR, own)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"test generation output")
        db.task_start(id="mine", user_id=7, board_id="test", capability="image", label="封面",
                      model="Local Image", request={"engine": {"id": "internal"}})
        server.log_end({"id":"mine", "kind":"image", "state":"done", "created":100,
                        "finished":101, "meta":{"uid":7, "prompt":"Blue sky", "seed":46},
                        "outputs":[{"ref":own},{"ref":"output:h3studio/missing.png"}]})
        db.task_start(id="other", user_id=8, board_id="test", capability="image", label="别人的图片",
                      state="done", outputs=[self.source["ref"]])
        db.task_start(id="legacy", user_id=7, board_id="test", capability="image", state="done", outputs="{bad json")
        db.task_start(id="failed", user_id=7, board_id="test", capability="image", state="error", outputs=[own])

        response = await self.client.get("/api/generation-history", params={"board":"test", "kind":"image", "q":"bLuE"})
        self.assertEqual(response.status, 200)
        rows = (await response.json())["items"]
        self.assertEqual([row["available"] for row in rows], [True, False])
        self.assertEqual((rows[0]["prompt"], rows[0]["seed"]), ("Blue sky", 46))
        self.assertNotIn("request", rows[0])
        request = json.loads(db.one("SELECT request FROM tasks WHERE id='mine'")["request"])
        self.assertEqual(request["engine"], {"id":"internal"})
        server.board_path("test").unlink()
        remaining = await self.client.get("/api/generation-history")
        self.assertEqual([row["id"] for row in (await remaining.json())["items"]], ["mine:0", "mine:1"])
        output = await self.client.get(rows[0]["url"])
        self.assertEqual(output.status, 200)
        self.assertEqual(await output.read(), b"test generation output")
        self.assertEqual((await self.client.get("/api/generation-history?board=test")).status, 404)

    async def test_cursor_uses_task_order_and_only_existing_audio_type(self):
        for i in range(26):
            db.task_start(id=f"music-{i}", user_id=7, board_id="test", capability="music", state="done",
                          request={"recipe":{"lyrics":"合唱", "prompt":"轻音乐"}}, outputs=[f"output:h3studio/music-{i}.wav"])
        first = await (await self.client.get("/api/generation-history?kind=audio")).json()
        self.assertEqual(len(first["items"]), 24)
        self.assertEqual(first["items"][0]["audio_recipe"], {"mode":"music", "lyrics":"合唱", "prompt":"轻音乐"})
        db.task_start(id="new", user_id=7, capability="tts", state="done", outputs=["output:h3studio/new.wav"])
        second = await (await self.client.get("/api/generation-history", params={"kind":"audio", "before":first["next"]})).json()
        self.assertEqual([item["id"] for item in second["items"]], ["music-1:0", "music-0:0"])
        self.assertIsNone(second["next"])
        self.assertEqual((await self.client.get("/api/generation-history?before=-1")).status, 400)
