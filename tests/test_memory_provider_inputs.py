"""Submit mixed asset references through provider adapters and retain history."""

from unittest.mock import patch
import wave

from PIL import Image

from oneshot.editing import image_editor
from oneshot.generation import remote_jobs
import server

from memory_fixture import MemoryFixture


class MemoryProviderInputs(MemoryFixture):
    async def test_seedance_image_only_bundle_is_not_truncated_and_native_frames_still_work(self):
        user = {"id":7,"role":"member"}
        asset = await self.create(name="服装图组",kind="prop")
        refs = [asset["ref"]]
        for index in range(11):
            image = image_editor.save(server.COMFY_DIR,Image.new("RGB",(80,80),(index,40,60)),"reference","input")
            server.grant_media(user,image["ref"])
            await self.client.post("/api/memory",json={"id":asset["id"],"ref":image["ref"]})
            refs.append(image["ref"])
        saved = await self.client.post("/api/memory",json={"id":asset["id"],"generation_media":refs})
        self.assertEqual((await saved.json())["generation_media"],refs)
        endpoint, flash = "ep-images-main","ep-images-flash"
        provider = server.providers.save(None,"ark","方舟参考图",
            {"models":{"video":endpoint},"video_endpoint_models":f"{endpoint} seedance-2.5\n{flash} seedance-2.5-flash"},
            {"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":endpoint}])
        frames = []
        for color in ("skyblue","gold"):
            image = image_editor.save(server.COMFY_DIR,Image.new("RGB",(80,80),color),"boundary","input")
            server.grant_media(user,image["ref"])
            frames.append({"ref":image["ref"],"role":"frame"})
        request = {"kind":"video","board":"test","provider":provider,"selected_model":endpoint,"images":frames,
                   "prompt":"展示 @服装图组","duration":8}
        options = await self.client.post("/api/video/reference-models",json={**request,"selected_model":flash})
        checked = await options.json()
        self.assertTrue(checked["image_only"])
        self.assertEqual(checked["counts"]["images"],14)
        self.assertNotIn("error",checked["models"][0])
        self.assertIn("10 张",checked["models"][1]["error"])
        preview = await self.client.post("/api/preview",json=request)
        self.assertEqual(preview.status,200,await preview.text())
        planned = await preview.json()
        self.assertIn("参考图 14/30",planned["mode"])
        self.assertIn("关键帧构图由提示词引导",planned["mode"])
        self.assertEqual([item["role"] for item in planned["inputs"]],["image_ref"]*14)
        self.assertIn("开头参考 @图片1",planned["prompt"])
        self.assertIn("结尾参考 @图片2",planned["prompt"])
        self.assertIn("@图片14",planned["prompt"])
        with patch.object(remote_jobs,"start_remote") as submit:
            generated = await self.client.post("/api/generate",json={**request,"reference_preview":planned["reference_preview"]})
            self.assertEqual(generated.status,200,await generated.text())
            _,_,service,model,_,args = submit.call_args.args
            body = await server.remote.ark_video_body(model,args,provider=service)
            self.assertEqual([item.get("role") for item in body["content"]],[None]+["reference_image"]*14)
            self.assertEqual([entry["ref"] for entry in (await generated.json())["memory_used"][0]["references"]],refs)
            await self.client.post("/api/memory",json={"id":asset["id"],"generation_media":refs[:-1]})
            stale = await self.client.post("/api/generate",json={**request,"reference_preview":planned["reference_preview"]})
            self.assertEqual(stale.status,409)
            submit.assert_called_once()
            untouched = await self.client.post("/api/generate",json={**request,"prompt":"场景开场与收尾"})
            self.assertEqual(untouched.status,200,await untouched.text())
            args = submit.call_args.args[-1]
            body = await server.remote.ark_video_body(endpoint,args,provider=service)
            self.assertEqual([item.get("role") for item in body["content"]],[None,"first_frame","last_frame"])

    async def test_mixed_asset_references_reach_the_selected_provider_and_history(self):
        user = {"id":7,"role":"member"}
        asset = await self.create(name="样品素材",kind="prop",document={"name":"拍摄说明","text":"瓶盖保持红色"})
        original_image = asset["ref"]
        video, video_ref = server.film._new(server.COMFY_DIR,"input","memory-guide",".mp4")
        server.film.encode_silent(video,(Image.new("RGB",(64,64),"blue") for _ in range(384)),
                                  64,64,24,lambda:False,lambda _:None)
        audio, audio_ref = server.film._new(server.COMFY_DIR,"input","memory-sound",".wav")
        with wave.open(str(audio),"wb") as file:
            file.setparams((1,2,16000,0,"NONE",""))
            file.writeframes(b"\x80\x01" * 48000)
        server.grant_media(user,video_ref,audio_ref)
        for ref in (video_ref,audio_ref):
            response = await self.client.post("/api/memory",json={"id":asset["id"],"ref":ref})
            self.assertEqual(response.status,200,await response.text())
        refs = [video_ref,original_image,audio_ref]
        response = await self.client.post("/api/memory",json={"id":asset["id"],"generation_media":refs})
        self.assertEqual((await response.json())["generation_media"],refs)
        request = {"board":"test","kind":"video","prompt":"展示 @样品素材","duration":5}
        unconfigured = await self.client.post("/api/preview",json=request)
        self.assertEqual(unconfigured.status,400)
        model = "doubao-seedance-2-5-260628"
        limited = "doubao-seedance-2-0-fixture"
        provider = server.providers.save(None,"ark","Seedance 测试",
                                         {"motion_origin":"https://oneshot.example","models":{"video":model},
                                          "generation_rates":f"video {model} hd 0.2\nvideo {limited} hd 0.1\nvideo {model} 480p 0.08"},
                                         {"api_key":"test-key"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":limited}])
        models = await self.client.post("/api/video/reference-models",json={**request,"duration":22,"quality":"4k"})
        self.assertEqual(models.status,200,await models.text())
        checked = await models.json()
        self.assertEqual(checked["counts"],{"images":1,"videos":1,"audio":1})
        shorter, longer = checked["models"]
        self.assertEqual((shorter["model"],shorter["duration"],shorter["limits"]["seconds"]),(limited,15,15))
        self.assertIn("15 秒",shorter["error"])
        self.assertEqual((longer["model"],longer["duration"],longer["resolution"],longer["video_seconds"],longer["audio_seconds"]),
                         (model,22,"4k",16,3))
        self.assertNotIn("error",longer)
        self.assertFalse(server.JOBS)
        rejected = await self.client.post("/api/video/reference-models",json={**request,"board":"other"})
        self.assertEqual(rejected.status,403)
        preview = await self.client.post("/api/preview",json=request)
        self.assertEqual(preview.status,200,await preview.text())
        planned = await preview.json()
        self.assertIn("瓶盖保持红色",planned["prompt"])
        self.assertIn("@视频1",planned["prompt"])
        self.assertIn("@音频1",planned["prompt"])
        self.assertIn("@图片1",planned["prompt"])
        self.assertIn(model,planned["mode"])
        self.assertEqual([(entry["role"],entry["ref"],entry.get("end")) for entry in planned["inputs"]],
                         [("image_ref",original_image,None),("video_ref",video_ref,16),("audio_ref",audio_ref,3)])
        quote = await self.client.post("/api/generation-cost",json={"requests":[{**request,"count":2}]})
        self.assertEqual((await quote.json())["amounts"],[2])
        with patch.object(remote_jobs,"start_remote") as submit:
            rejected = await self.client.post("/api/generate",json={**request,"provider":"local_h3"})
            self.assertEqual(rejected.status,400,await rejected.text())
            rejected = await self.client.post("/api/generate",json={**request,"provider":provider,"selected_model":limited})
            self.assertEqual(rejected.status,400,await rejected.text())
            submit.assert_not_called()
        for ranges in ({audio_ref:[0,2]},{video_ref:[14,16.2]},{video_ref:[1,2]}):
            bad_range = await self.client.post("/api/memory",json={"id":asset["id"],"generation_video_ranges":ranges})
            self.assertEqual(bad_range.status,400,await bad_range.text())
        trimmed = await self.client.post("/api/memory",json={"id":asset["id"],"generation_video_ranges":{video_ref:[2,9]},
                                                           "generation_audio_ranges":{audio_ref:[.5,2.5]}})
        saved_ranges = await trimmed.json()
        self.assertEqual(saved_ranges["generation_video_ranges"],{video_ref:[2,9]})
        self.assertEqual(saved_ranges["generation_audio_ranges"],{audio_ref:[.5,2.5]})
        models = await self.client.post("/api/video/reference-models",json={**request,"provider":provider,"selected_model":limited})
        selected = (await models.json())["models"][0]
        self.assertTrue(selected["selected"])
        self.assertEqual(selected["video_seconds"],7)
        self.assertEqual(selected["audio_seconds"],2)
        self.assertNotIn("error",selected)
        quote = await self.client.post("/api/generation-cost",json={"requests":[
            {**request,"count":2},
            {**request,"provider":provider,"selected_model":model,"draft":True,"quality":"std"},
            {**request,"provider":provider,"selected_model":model,"quality":"4k"},
            {**request,"board":"other"},
        ]})
        self.assertEqual((await quote.json())["amounts"],[1,.4,None,None])
        with patch.object(remote_jobs,"start_remote") as submit:
            stale_preview = await self.client.post("/api/generate",json={**request,"reference_preview":planned["reference_preview"]})
            self.assertEqual(stale_preview.status,409,await stale_preview.text())
            submit.assert_not_called()
            chosen_model = {**request,"provider":provider,"selected_model":model}
            preview = await self.client.post("/api/preview",json=chosen_model)
            self.assertEqual(preview.status,200,await preview.text())
            planned = await preview.json()
            video_input = next(entry for entry in planned["inputs"] if entry["role"]=="video_ref")
            self.assertEqual((video_input["start"],video_input["end"]),(2,9))
            response = await self.client.post("/api/generate",json={**chosen_model,"reference_preview":planned["reference_preview"]})
        self.assertEqual(response.status,200,await response.text())
        receipt = await response.json()
        queued_request = submit.call_args.args[-1]
        self.assertEqual(queued_request["audio_refs"],[(audio,.5,2)])
        sent_clip = submit.call_args.kwargs["video_refs"][0]
        self.assertEqual((sent_clip["path"],sent_clip["start"],sent_clip["ticks"]),(video,2,7*24))
        upstream = await server.remote.ark_video_body(model,{**queued_request,"video_urls":["https://oneshot.example/fixture"]})
        self.assertEqual([item.get("role") for item in upstream["content"]],
                         [None,"reference_image","reference_video","reference_audio"])
        self.assertEqual([entry["ref"] for entry in receipt["memory_used"][0]["references"]],refs)
        self.assertEqual((receipt["reference_context"]["audio_refs"][0]["start"],receipt["reference_context"]["audio_refs"][0]["end"]),(.5,2.5))
        self.assertEqual(receipt["reference_context"]["selected_model"],model)
        self.assertEqual(receipt["memory_used"][0]["document_excerpt"],"瓶盖保持红色")
        store = self.app["creative_memory"]
        output_ref = "output:h3studio/mixed-result.mp4"
        store.observe(user,{receipt["ids"][0]:{"state":"done","outputs":[{"ref":output_ref}]}})
        server.grant_media(user,output_ref)
        recorded = store.historical_assets(user,output_ref)[asset["id"]]
        self.assertEqual([entry["ref"] for entry in recorded["references"]],refs)
        self.assertEqual((recorded["references"][0]["start"],recorded["references"][0]["end"]),(2,9))
        reset = await self.client.post("/api/memory",json={"id":asset["id"],"generation_media":[original_image]})
        self.assertEqual(reset.status,200,await reset.text())
        reset_asset = await reset.json()
        self.assertNotIn("generation_video_ranges",reset_asset)
        self.assertNotIn("generation_audio_ranges",reset_asset)
        with patch.object(remote_jobs,"start_remote") as submit:
            stale = await self.client.post("/api/generate",json={**request,"reference_preview":planned["reference_preview"]})
            self.assertEqual(stale.status,409,await stale.text())
            submit.assert_not_called()
        replay = store.prepare(user,request,replay_ref=output_ref)
        self.assertEqual(replay["audio_refs"][0]["ref"],audio_ref)
        self.assertEqual((replay["audio_refs"][0]["start"],replay["audio_refs"][0]["end"]),(.5,2.5))
        self.assertEqual(replay["video_refs"][0]["ref"],video_ref)
        self.assertEqual((replay["video_refs"][0]["start"],replay["video_refs"][0]["end"]),(2,9))
        image = store.prepare(user,{**request,"kind":"image"},replay_ref=output_ref)
        self.assertEqual([entry["ref"] for entry in image["images"]],[original_image])
        self.assertEqual(image["memory_used"][0]["omitted_media_count"],2)
        self.assertNotIn("video_refs",image)
        self.assertNotIn("audio_refs",image)
