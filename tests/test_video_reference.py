import asyncio
import io
import json
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import urlsplit

import av
import numpy as np
from aiohttp import web
from PIL import Image

from oneshot.assistant import agent_video
import server
from test_agent_chat import ChatFixture, answer, call


class CharacterReferencePrompts(unittest.TestCase):
    def test_asset_replay_keeps_original_numbered_audio_and_video_bindings(self):
        def asset(index, name):
            video = f"input:h3studio/clip{index}.mp4"
            audio = f"input:h3studio/voice{index}.wav"
            return {"id":str(index),"kind":"prop","name":name,"media":[{"ref":video},{"ref":audio}],
                    "references":[{"ref":video,"view":None,"type":"video","start":1,"end":4},
                                  {"ref":audio,"view":None,"type":"audio","start":2,"end":5}]}

        first, second = asset(1,"站台素材"),asset(2,"车厢素材")
        recorded = {item["id"]:item for item in (first,second)}
        store = server.creative_memory.Store(server)
        user = {"id":7,"role":"member"}
        raw = {"kind":"video","board":"test","prompt":"重拍 @车厢素材 和 @站台素材",
               "fields":{"action":"复用 @视频1 的运镜，按 @音频2 的节奏。"}}
        with TemporaryDirectory() as directory, patch.object(server,"COMFY_DIR",Path(directory)), \
                patch.object(store,"list",return_value=[first,second]), \
                patch.object(store,"get",side_effect=lambda _user, mid, _board: recorded[mid]), \
                patch.object(store,"historical_assets",return_value=recorded),patch.object(server,"require_media"):
            for item in recorded.values():
                for media in item["media"]:
                    path = server.tools.ref_path(server.COMFY_DIR,media["ref"])
                    path.parent.mkdir(parents=True,exist_ok=True)
                    path.touch()
            restored = store.prepare(user,raw,replay_ref="output:h3studio/previous.mp4")
            self.assertEqual([item["id"] for item in restored["memory_used"]],["1","2"])
            self.assertEqual([(item["ref"],item["start"],item["end"]) for item in restored["video_refs"]],
                             [("input:h3studio/clip1.mp4",1,4),("input:h3studio/clip2.mp4",1,4)])
            self.assertEqual([(item["ref"],item["start"],item["end"]) for item in restored["audio_refs"]],
                             [("input:h3studio/voice1.wav",2,5),("input:h3studio/voice2.wav",2,5)])
            self.assertIn(raw["fields"]["action"],restored["fields"]["action"])
            with self.assertRaises(web.HTTPBadRequest) as invalid:
                store.prepare(user,{**raw,"prompt":"参照 @音3"},replay_ref="output:h3studio/previous.mp4")
            self.assertIn("@音3",invalid.exception.text)
            with self.assertRaises(web.HTTPBadRequest) as missing:
                store.prepare(user,{"kind":"video","prompt":"参照 @视频1"})
            self.assertIn("@视频1",missing.exception.text)
            edit = {**raw,"segment_edit":True,
                    "previs_guide":{"node_id":"guide","ref":"output:h3studio/guide.mp4"},
                    "video_refs":[{"node_id":"source","ref":"input:h3studio/clip1.mp4","start":1,"end":4}]}
            reused = store.prepare(user,edit,replay_ref="output:h3studio/previous.mp4")
            self.assertIn("站台素材 的参考视频：@视频1。",reused["prompt"])
            self.assertIn("车厢素材 的参考视频：@视频3。",reused["prompt"])

    def test_mixed_media_keeps_timed_images_in_assistant_request_order(self):
        def source(_run, _user, node_id, *, pinned_ref=None):
            version = {"ref":pinned_ref or f"input:h3studio/{node_id}.png","w":640,"h":360}
            return {"id":node_id,"name":node_id,"versions":[{"ref":"input:h3studio/first.png"},version]},version

        service = SimpleNamespace(host=server,source=source)
        frames = [{"node_id":"late","role":"keyframe","time":3.2,"ref":"input:h3studio/older.png"},
                  {"node_id":"opening","role":"first"},{"node_id":"person","role":"subject"},
                  {"node_id":"environment"},{"node_id":"ending","role":"last"}]
        sounds = [{"ref":"input:h3studio/dialogue.wav"}]
        clips = [{"ref":"input:h3studio/motion.mp4"}]
        payload = agent_video.plan_payload(service,{"data":{}},{"id":7},frames,5,{},"按 @音1 的节奏。",
                                           sounds=sounds,clips=clips)
        self.assertTrue(payload["planned"])
        self.assertEqual([(item["node_id"],item["role"]) for item in payload["images"]],
                         [("late","frame"),("opening","frame"),("person","subject"),
                          ("environment","subject"),("ending","frame")])
        self.assertEqual([item["time"] for item in payload["images"][:2]],[3.2,0])
        self.assertEqual(payload["images"][0]["ref"],"input:h3studio/older.png")
        self.assertEqual(payload["images"][0]["version"],2)
        prompt = server.reference_prompt({**payload,"audio_refs":sounds,"video_refs":clips})
        self.assertIn("约在 3.2 秒参考 @图片1 的构图",prompt)
        self.assertIn("开头参考 @图片2 的构图",prompt)
        self.assertIn("结尾参考 @图片5 的构图",prompt)

    def test_assistant_history_uses_recorded_ranges_and_keeps_midshot_frame_timing(self):
        still, audio = "input:h3studio/still.png","input:h3studio/voice.wav"
        recipe = {"planned":True,"duration":8,
                  "images":[{"node_id":"still","role":"frame","time":3.2,"ref":still}],
                  "audio_refs":[{"node_id":"voice","ref":audio,"start":.75,"end":4.125}]}
        historical = {"ref":"output:h3studio/shot.mp4","video_recipe":recipe,"input_edges":[
            {"from":"still","to":"shot","role":"keyframe","time":3.2},
            {"from":"voice","to":"shot","relation":"audio_ref","ref":audio,"start":0}]}
        target = {"id":"shot","cur":0,"versions":[historical],"data":{}}
        board = {"nodes":[target,{"id":"still","type":"image","versions":[{"ref":still}]},
                          {"id":"voice","type":"audio","versions":[{"ref":audio}]}],"edges":[]}
        service = SimpleNamespace(host=server,current=lambda node:node["versions"][0])
        run = {"data":{}}
        _, _, _, edges = agent_video.video_edit_snapshot(service,run,board,target,1)
        self.assertEqual((edges[0]["ref"],edges[0]["role"],edges[0]["time"]),(still,"keyframe",3.2))
        self.assertEqual((edges[1]["start"],edges[1]["end"]),(.75,4.125))
        self.assertNotIn("end",historical["input_edges"][1])
        del historical["input_edges"]
        _, _, _, recovered = agent_video.video_edit_snapshot(service,run,board,target,1)
        self.assertEqual((recovered[0]["ref"],recovered[0]["role"],recovered[0]["time"]),(still,"keyframe",3.2))

    def test_explicit_angles_share_one_subject_and_keep_dialogue_with_its_character(self):
        frame, main, face, second = [f"input:h3studio/{name}.png" for name in ("frame","main","face","second")]
        jonah = {"id":"jonah","kind":"character","name":"乔纳·里德","ref":main,"desc":"深色外套",
                 "character_views":{"main":main,"face":face},"media":[{"ref":main},{"ref":face}]}
        woman = {"id":"woman","kind":"character","name":"抱画女人","ref":second,"desc":"怀抱一幅画",
                 "media":[{"ref":second}]}
        assets = [jonah,woman]
        store = server.creative_memory.Store(server)
        user = {"id":7,"role":"member"}
        raw = {"kind":"video","board":"test","duration":5,
               "prompt":"@乔纳·里德 与 @抱画女人 在走廊相遇。",
               "fields":{"action":"两人在门边停下。","dialogue":"乔纳·里德（轻声）：你好。\n抱画女人：你也来看画？"},
               "images":[{"ref":frame,"role":"frame"},{"ref":main,"role":"subject","asset":"jonah"}],
               "memory_views":[{"memory_id":"jonah","views":["main","face"]}]}
        with TemporaryDirectory() as directory, patch.object(server,"COMFY_DIR",Path(directory)), \
                patch.object(store,"list",return_value=assets), patch.object(store,"get",return_value=jonah), \
                patch.object(server,"lib_load",return_value=[]), patch.object(server,"requested_generation_route",return_value=None):
            for ref in (frame,main,face,second):
                path = server.tools.ref_path(server.COMFY_DIR,ref)
                path.parent.mkdir(parents=True,exist_ok=True)
                Image.new("RGB",(64,64),"blue").save(path)
            prepared = store.prepare(user,raw)
            with patch.object(store,"historical_assets",return_value={"jonah":prepared["memory_used"][0]}), \
                    patch.object(server,"require_media"):
                replayed = store.prepare(user,{key:value for key,value in raw.items() if key!="memory_views"},
                                         replay_ref="output:h3studio/previous.mp4")
            for payload in (prepared,replayed):
                self.assertEqual([entry["ref"] for entry in payload["images"]],[frame,main,face,second])
                self.assertEqual([entry.get("memory_view") for entry in payload["images"]],[None,"main","face",None])
                local_request, _ = server.engine_body(server.apply_fields(payload))
                local = local_request["prompt"]
                self.assertIn("<Picture 2> is an additional view of the same <Subject 1>",local)
                self.assertNotIn("<Subject 2>",local)
                self.assertIn("<Picture 4> is the first frame",local)
                self.assertIn("People shown in the keyframes and their corresponding character references share the same identity.",local)
                self.assertIn("乔纳·里德 <Subject 1> (S1) 轻声 says: <d>[Chinese] 你好。</d>",local)
                self.assertIn("抱画女人 <Subject 3> (S2) says: <d>[Chinese] 你也来看画？</d>",local)
                remote, roles = server.remote_video_prompt(payload,{"kind":"ark","config":{}},"doubao-seedance-2-5-fixture")
                self.assertEqual(roles,["image_ref"]*4)
                self.assertIn("开头参考 @图片1 的构图",remote)
                self.assertIn("关键帧里出现的人物与各自的角色参考图共用同一身份",remote)
                self.assertIn("乔纳·里德 · 正面头肩 的参考图：@图片3",remote)
                self.assertIn("「乔纳·里德」的不同视角，镜头中按同一位人物处理",remote)
                self.assertIn("关键帧里出现的人物",server.reference_prompt(payload))


class VideoReferencePreview(unittest.IsolatedAsyncioTestCase):
    async def test_native_preview_uses_submitted_keyframe_positions(self):
        raw = {"kind":"video","prompt":"A steady camera", "duration":2.5,"planned":True,
               "images":[{"role":"frame","time":time,"index":i,"ref":f"input:h3studio/frame-{i}.png"}
                         for i,time in enumerate((0,2.53,5.5),1)]}
        service = SimpleNamespace(app={"creative_memory":SimpleNamespace(
            prepare=Mock(side_effect=lambda _user, raw, **_options: raw))})
        request = server.agent_chat.InternalRequest(service,{"id":7,"role":"member"},raw)
        with patch.object(server.providers,"primary",return_value=None), patch.object(server,"engine_up",return_value=True):
            preview = json.loads((await server.preview(request)).body)
        body, _ = server.engine_body(server.apply_fields(raw))
        self.assertEqual(body["frames"],124)
        self.assertEqual([item["frame"] for item in body["keyframes"]],[0,61,120])
        self.assertEqual([item["time"] for item in preview["inputs"]],[0,61/24,5])
        self.assertEqual(preview["duration"],124/24)
        self.assertEqual(preview["prompt"],body["prompt"])
        self.assertIn("<Picture 3> is the last frame",preview["prompt"])

    async def test_numbered_review_matches_provider_video_input_order(self):
        guide = {"ref":"output:h3studio/guide.mp4","node_id":"guide"}
        clips = [{"ref":"input:h3studio/source.mp4","node_id":"source"},
                 {"ref":"input:h3studio/other.mp4","node_id":"other"}]
        sound = {"ref":"input:h3studio/sound.wav","node_id":"sound"}
        for source_first in (False,True):
            raw = {"previs_guide":guide,"video_refs":clips,"audio_refs":[sound],**({"segment_edit":True} if source_first else {})}
            rows = server.numbered_reference_inputs(server.workflow_review.capture_generation(raw)["inputs"],raw)
            order = ["source","guide","other"] if source_first else ["guide","source","other"]
            body = await server.remote.ark_video_body("doubao-seedance-2-5-fixture",
                {"prompt":"测试","refs":[],"duration":5,"motion_url":guide["node_id"],
                 "video_urls":[item["node_id"] for item in clips],"segment_edit":source_first})
            self.assertEqual([item["video_url"]["url"] for item in body["content"][1:]],order)
            self.assertEqual([(item["node_id"],item["prompt_reference"]) for item in rows],
                             [*[(node_id,f"@视频{index}") for index,node_id in enumerate(order,1)],("sound","@音频1")])

    def test_retired_history_routes_do_not_fall_back_to_default_provider(self):
        with patch.object(server.providers,"get",return_value=None), patch.object(server.providers,"primary") as fallback:
            with self.assertRaises(web.HTTPBadRequest):
                server.requested_generation_route({"provider":"legacy","selected_model":"old-model"},"video")
            with self.assertRaises(web.HTTPBadRequest):
                server.requested_generation_route({"provider":"local_h3"},"video")
            fallback.assert_not_called()
            server.requested_generation_route({},"video")
            fallback.assert_called_once_with("video")

    async def test_explicit_video_route_checks_preview_after_normalizing_the_camera_plan(self):
        provider = {"id":"ark","kind":"ark","name":"方舟","config":{},"updated":1}
        route = {"provider":provider,"model":"doubao-seedance-2-5-fixture"}
        service = SimpleNamespace(app={"creative_memory":SimpleNamespace(
            prepare=Mock(side_effect=lambda _user, raw, **_options: raw))})
        user = {"id":7,"role":"member"}
        view = {"angle":"front","scale":"medium"}
        raw = {"kind":"video","board":"test","prompt":"保留原动作", "duration":5,
               "provider":provider["id"],"selected_model":route["model"],"segment_edit":True,
               "camera_plan":{"mode":"move","start":view,"end":view},
               "images":[{"role":"frame","time":0,"name":"走廊","ref":"input:h3studio/hall.png","version":2}],
               "video_refs":[{"node_id":"clip","ref":"input:h3studio/clip.mp4","start":1,"end":6,"version":3}],
               "audio_refs":[{"node_id":"audio","ref":"input:h3studio/audio.wav","start":0,"end":2,"version":1}]}

        def request(payload, key=None):
            req = server.agent_chat.InternalRequest(service,user,payload)
            if key is not None:
                req["reference_preview"] = key
            return req

        async def prepare(_user, payload, _plan, **_options):
            clip = payload["video_refs"][0]
            return route,None,[{"ticks":round((clip["end"]-clip["start"])*server.film.FPS)}],[]

        result = web.json_response({"ids":["fixture"]})
        with TemporaryDirectory() as directory, patch.object(server,"COMFY_DIR",Path(directory)), \
                patch.object(server,"require_media"), patch.object(server,"prepare_reference_generation",side_effect=prepare), \
                patch.object(server,"generate_remote",new=AsyncMock(return_value=result)) as submit:
            path = server.tools.ref_path(server.COMFY_DIR,raw["images"][0]["ref"])
            path.parent.mkdir(parents=True)
            Image.new("RGB",(64,64),"blue").save(path)
            preview = json.loads((await server.preview(request(raw))).body)
            self.assertFalse(server.needs_reference_review(raw))
            self.assertIn("固定机位",preview["prompt"])
            self.assertEqual(preview["duration"],5)
            key = preview["reference_preview"]
            self.assertRegex(key,r"^[0-9a-f]{64}$")
            approval, _ = await server.asset_reference_review(request(raw),await request(raw).json())
            self.assertEqual(approval["key"],key)
            self.assertEqual((approval["provider"],approval["model"]),("方舟",route["model"]))
            self.assertEqual([(item["role"],item["version"],item.get("start"),item.get("end")) for item in approval["inputs"]],
                             [("frame",2,None,None),("video_ref",3,1,6),("audio_ref",1,0,2)])
            self.assertIs(await server._generate_request(request(raw,key),await request(raw).json()),result)
            self.assertEqual(submit.call_args.args[1]["camera_plan"],{"mode":"fixed","start":view})

            moved = {**raw,"video_refs":[{**raw["video_refs"][0],"start":2,"end":7}]}
            with self.assertRaises(web.HTTPConflict) as trim_conflict:
                await server._generate_request(request(moved,key),await request(moved).json())
            self.assertIn("重新预览",trim_conflict.exception.text)
            provider["updated"] = 2
            confirmed = request(raw,approval["key"])
            confirmed["reference_reviewed"] = True
            with self.assertRaises(web.HTTPConflict) as approval_conflict:
                await server._generate_request(confirmed,await confirmed.json())
            self.assertIn("重新确认生成",approval_conflict.exception.text)
            submit.assert_awaited_once()
            self.assertIs(await server._generate_request(request(raw),await request(raw).json()),result)
            with patch.object(server,"prepare_reference_generation",side_effect=server.bad("参考音频超过时长")):
                with self.assertRaises(web.HTTPBadRequest) as limit_error:
                    await server.asset_reference_review(request(raw),await request(raw).json())
                self.assertIn("参考音频超过时长",limit_error.exception.text)
            path.unlink()
            with self.assertRaises(web.HTTPBadRequest) as missing_image:
                await server.asset_reference_review(request(raw),await request(raw).json())
            self.assertIn("参考图无法读取",missing_image.exception.text)


class MiniMaxVideoOptions(unittest.IsolatedAsyncioTestCase):
    def test_cloud_h3_prompt_binds_character_views_and_preserves_dialogue(self):
        images = [{"role":"frame"},
                  {"role":"subject","memory_id":"hero","memory_kind":"character","memory_name":"乔纳·里德"},
                  {"role":"subject","memory_id":"hero","memory_kind":"character","memory_name":"乔纳·里德"},
                  {"role":"subject","memory_kind":"prop","name":"画框"}]
        speech = "<d>[Chinese] 标签原文是 @图2。</d>"
        raw = {"prompt":f"从 @图1 开始，借用 @视频1 的运镜和 @音1 的声音。{speech}",
               "images":images,"video_refs":[{}],"audio_refs":[{}]}
        cloud = server.video_reference_prompt(raw,{"kind":"minimax"},"MiniMax-H3")
        self.assertIn("<Picture 2>、<Picture 3> 用于保持「乔纳·里德」的身份和外观",cloud)
        self.assertIn("<Video 1> 的运镜和 <Audio 1> 的声音",cloud)
        self.assertIn(speech,cloud)
        self.assertNotIn("「画框」的身份",cloud)
        self.assertIn("@视频1 的运镜和 @音频1 的声音",
                      server.video_reference_prompt(raw,{"kind":"ark"},"doubao-seedance-2-5"))

    def test_h3_quotes_include_input_costs_and_machgen_reference_rates(self):
        rates = server.providers.generation_rates(
            "video MiniMax-H3 hd 0.5\nvideo-input MiniMax-H3 hd 0.25\n"
            "video-image MiniMax-H3 hd 0.1\nvideo MiniMax-H3-MG hd 0.3\nvideo-ref MiniMax-H3-MG hd 0.6\n"
            "video MiniMax-H3-Max hd 0.4", ["video"], kind="minimax")
        provider = {"kind":"minimax","config":{"generation_rates":rates}}
        def estimate(model, raw, video_seconds=None):
            return server.quoted_video_unit_cost({"provider":provider,"model":model},raw,5,
                                                 input_video_seconds=video_seconds)
        references = {"images":[{"role":"subject"}]*7}
        mixed = {**references,"video_refs":[{}],"audio_refs":[{}]}
        self.assertEqual(estimate("MiniMax-H3",references),2.7)
        self.assertEqual(estimate("MiniMax-H3",{"images":[{},*references["images"]]}),2.8)
        self.assertEqual(estimate("MiniMax-H3",mixed,3.5),3.575)
        self.assertIsNone(estimate("MiniMax-H3",mixed))
        self.assertIsNone(estimate("MiniMax-H3-Max",{"images":[{}]}))
        self.assertEqual(estimate("MiniMax-H3-MG",references),3)
        self.assertEqual(estimate("MiniMax-H3-MG",{"images":[{}]}),1.5)
        self.assertIsNone(estimate("MiniMax-H3-MG",mixed,3.5))

    async def test_cloud_h3_preview_and_submission_keep_frames_and_characters(self):
        model = "MiniMax-H3"
        provider = {"id":"cloud","kind":"minimax","name":"云端 H3","enabled":True,"updated":1,
                    "config":{},"secrets":{"api_key":"fixture"}}
        route = {"provider":provider,"model":model}
        user = {"id":7,"role":"member"}
        memory = SimpleNamespace(prepare=Mock(side_effect=lambda _user, raw, **_options: raw))
        service = SimpleNamespace(app={"creative_memory":memory})
        def request(payload):
            return server.agent_chat.InternalRequest(service,user,payload)

        with TemporaryDirectory() as directory, patch.object(server,"COMFY_DIR",Path(directory)), \
                patch.object(server,"JOBS",{}), patch.object(server,"require_media"), \
                patch.object(server,"requested_generation_route",return_value=route), \
                patch.object(server,"board_meta",return_value={"owner":7}), patch.object(server,"can_edit",return_value=True), \
                patch.object(server.providers,"routes",return_value=[route]), patch.object(server.providers,"all_providers",return_value=[]), \
                patch.object(server.db,"task_start"), patch.object(server,"start_remote") as start, \
                patch.object(server.remote,"json_req",return_value={"task_id":"fixture"}) as remote_submit, \
                patch.object(server.remote,"mm_result",return_value={"files":[]}):
            assets = []
            for name, role in (("hall","frame"),("jonah","subject"),("woman","subject")):
                ref = f"input:h3studio/{name}.png"
                path = server.tools.ref_path(server.COMFY_DIR,ref)
                path.parent.mkdir(parents=True,exist_ok=True)
                Image.new("RGB",(320,320),"blue").save(path)
                assets.append({"ref":ref,"role":role,"time":0})
            raw = {"kind":"video","board":"test","provider":provider["id"],"selected_model":model,"duration":5,
                   "quality":"hd","prompt":"@图2 与 @图3 交谈。","planned":True,"images":assets}
            options = json.loads((await server.video_reference_models(request(raw))).body)
            self.assertEqual(options["counts"]["images"],3)
            self.assertEqual(options["models"][0]["limits"]["images"],9)
            self.assertNotIn("error",options["models"][0])
            planned = json.loads((await server.preview(request(raw))).body)
            self.assertIn("参考图 3/9",planned["mode"])
            self.assertIn("开头参考 <Picture 1> 的构图",planned["prompt"])
            self.assertIn("<Picture 2> 与 <Picture 3> 交谈",planned["prompt"])
            self.assertEqual([item["role"] for item in planned["inputs"]],["image_ref"]*3)
            self.assertEqual([item["image_role"] for item in planned["inputs"]],["frame","subject","subject"])
            self.assertEqual([item["prompt_reference"] for item in planned["inputs"]],
                             ["<Picture 1>","<Picture 2>","<Picture 3>"])

            stale = request(raw)
            stale["reference_preview"] = planned["reference_preview"]
            provider["updated"] = 2
            with self.assertRaises(web.HTTPConflict):
                await server._generate_request(stale,stale.payload)
            start.assert_not_called()
            provider["updated"] = 1
            await server._generate_request(stale,stale.payload)
            params = start.call_args.args[-1]
            self.assertEqual([path.name for path in params["refs"]],["hall.png","jonah.png","woman.png"])
            await server.remote.mm_video(None,server.COMFY_DIR,provider,model,params)
            body = remote_submit.call_args.kwargs["json"]
            self.assertEqual(body["content"][0]["text"],planned["prompt"])
            self.assertEqual([item["role"] for item in body["content"][1:]],["reference_image"]*3)

            native = {**raw,"prompt":"由这两帧过渡。","planned":False,"images":[assets[0],{**assets[1],"role":"frame"}]}
            await server._generate_request(request(native),native)
            await server.remote.mm_video(None,server.COMFY_DIR,provider,model,start.call_args.args[-1])
            self.assertEqual([item["role"] for item in remote_submit.call_args.kwargs["json"]["content"][1:]],
                             ["first_frame","last_frame"])
            with self.assertRaises(web.HTTPBadRequest) as too_many:
                await server.preview(request({**raw,"images":assets*4}))
            self.assertIn("9 张参考图",too_many.exception.text)

    async def test_cloud_h3_resolution_options_match_the_provider_request(self):
        expected = {
            "MiniMax-H3": (4, {"480p":"480P", "std":"768P", "hd":"2K"}),
            "MiniMax-H3-Highspeed": (4, {"std":"480P", "hd":"768P"}),
            "MiniMax-H3-Lite": (4, {"std":"480P", "hd":"768P"}),
            "MiniMax-H3-Max": (5, {"std":"480P", "hd":"768P"}),
            "MiniMax-H3-Max-Turbo": (5, {"std":"480P", "hd":"768P"}),
            "MiniMax-H3-MG": (4, {"std":"768P", "hd":"2K"}),
            "MiniMax-H3-NC": (4, {"std":"480P", "hd":"768P"}),
        }
        self.assertEqual(set(server.providers.CATALOG["minimax"]["models"]["video"]), set(expected))
        provider = {"id":"minimax","name":"云端 H3","kind":"minimax","config":{},"secrets":{"api_key":"fixture"}}
        with patch.object(server.remote,"json_req",return_value={"task_id":"test"}) as submit, \
                patch.object(server.remote,"mm_result",return_value={"files":[]}):
            for model, (minimum, qualities) in expected.items():
                self.assertEqual(server.remote.video_resolutions("minimax",model),qualities)
                for key, resolution in qualities.items():
                    with self.subTest(model=model, resolution=resolution):
                        await server.remote.mm_video(None,server.COMFY_DIR,provider,model,
                                                     {"prompt":"站台","duration":4,"quality":key})
                        body = submit.call_args.kwargs["json"]
                        self.assertEqual((body["model"],body["duration"],body["resolution"]),
                                         (model,minimum,resolution))


class ReferenceVideo(ChatFixture):
    async def test_ark_endpoint_uses_its_configured_model_for_limits_and_keeps_the_endpoint_on_submit(self):
        endpoint, flash, unmarked = "ep-project-main","ep-project-fast","ep-project-original"
        config = {"motion_origin":"https://studio.example","models":{"video":endpoint},
                  "video_endpoint_models":f"{endpoint} seedance-2.5\n{flash} seedance-2.5-flash",
                  "generation_rates":f"video {endpoint} 4k 0.25"}
        provider = server.providers.save(None,"ark","方舟接入点",config,{"api_key":"fixture"},True)
        server.providers.set_route("video",[{"provider_id":provider,"model":model} for model in (endpoint,unmarked)])
        with self.assertRaisesRegex(server.providers.ProviderError,"接入点 ID 重复"):
            server.providers.save(provider,"ark","错误配置",
                {"video_endpoint_models":f"{endpoint} seedance-2.5\n{endpoint} seedance-2.0"},{},True)
        self.assertEqual(server.providers.get(provider)["config"]["video_endpoint_models"],
                         {endpoint:"seedance-2.5",flash:"seedance-2.5-flash"})
        options = json.loads((await server.capabilities(None)).body)
        configured = next(item for item in options["video"] if item["id"] == provider)
        rows = {option["id"]:option for option in configured["models"]}
        self.assertEqual((rows[endpoint]["durations"][-1],rows[endpoint]["qualities"]["4k"],rows[endpoint]["draft"]),(30,"4k",True))
        self.assertEqual(rows[flash]["reference_limits"],{"images":10,"videos":5,"audio":5,"seconds":30})
        self.assertFalse(rows[flash]["draft"])
        self.assertNotIn("4k",rows[flash]["qualities"])
        self.assertEqual(rows[unmarked]["reference_limits"]["seconds"],15)
        self.assertEqual([model["id"] for service in options["segment_edit"] if service["id"]==provider
                          for model in service["models"]],[endpoint,flash])

        path,ref = server.film._new(server.COMFY_DIR,"input","endpoint-sound",".wav")
        with wave.open(str(path),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x08"*(18*8000))
        server.grant_media({"id":7},ref)
        self.board["nodes"].append({"id":"endpoint-audio","type":"audio","name":"声音","x":0,"y":0,"data":{},
                                    "versions":[{"ref":ref}],"cur":0})
        server.write_board(server.board_path("test"),self.board)
        request = {"kind":"video","board":"test","provider":provider,"selected_model":endpoint,"prompt":"跟随声音",
                   "duration":22,"quality":"4k","audio_refs":[{"node_id":"endpoint-audio","ref":ref}]}
        preview = await self.client.post("/api/preview",json=request)
        self.assertEqual(preview.status,200,await preview.text())
        self.assertIn("22 秒 · 4k",(await preview.json())["mode"])
        costs = await self.client.post("/api/generation-cost",json={"requests":[{**request,"count":2}]})
        self.assertEqual((await costs.json())["amounts"],[11])
        with patch.object(server,"start_remote") as submit:
            response = await self.client.post("/api/generate",json=request)
            self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["video_model"],{"provider":provider,"selected_model":endpoint})
        _,_,service,model,_,request_data = submit.call_args.args
        self.assertEqual(model,endpoint)
        submitted = await server.remote.ark_video_body(model,request_data,provider=service)
        self.assertEqual((submitted["model"],submitted["resolution"],submitted["duration"]),(endpoint,"4k",22))
        self.assertEqual(submitted["content"][-1]["role"],"reference_audio")
        extension = await server.remote.ark_video_body(model,{**request_data,"audio_refs":[],"extension":"after",
            "video_urls":["https://studio.example/clip.mp4"]},provider=service)
        self.assertEqual((extension["model"],extension["omni_reference_task_type"],extension["ratio"]),
                         (endpoint,"extend","adaptive"))

    async def test_cloud_h3_sends_mixed_references_and_revokes_leases(self):
        provider = server.providers.save(None,"minimax","云端 H3 测试",{"motion_origin":"https://studio.example",
            "generation_rates":"video MiniMax-H3 std 1\nvideo-input MiniMax-H3 std 0.25"},
                                         {"api_key":"fixture"},True)
        model = "MiniMax-H3"
        server.providers.set_route("video",[{"provider_id":provider,"model":model}])
        path, ref = server.film._new(server.COMFY_DIR,"input","h3-motion",".mp4")
        server.film.encode_silent(path,(Image.new("RGB",(64,64),"navy") for _ in range(48)),64,64,24,lambda:False,lambda _:None)
        audio, sound = server.film._new(server.COMFY_DIR,"input","h3-sound",".wav")
        with wave.open(str(audio),"wb") as recording:
            recording.setparams((1,2,8000,0,"NONE",""))
            recording.writeframes(b"\x00\x00" * (16*8000) + b"\x00\x08" * 16000)
        self.board["nodes"].extend([
            {"id":"n3","type":"video","name":"参考动作","versions":[{"ref":ref}],"cur":0,"data":{}},
            {"id":"n4","type":"audio","name":"参考声音","versions":[{"ref":sound}],"cur":0,"data":{}},
        ])
        server.write_board(server.board_path("test"),self.board)
        request = {"kind":"video","board":"test","provider":provider,"selected_model":model,"duration":4,
                   "prompt":"参考 @视频1 和 @音频1","quality":"std","images":[{"ref":self.source["ref"]}],
                   "video_refs":[{"node_id":"n3","ref":ref}],"audio_refs":[{"node_id":"n4","ref":sound,"start":16,"end":18}]}
        quote = await self.client.post("/api/generation-cost",json={"requests":[{**request,"count":2}]})
        self.assertEqual(quote.status,200,await quote.text())
        self.assertEqual((await quote.json())["amounts"],[9])
        leases = []

        async def upstream(_http,method,url,_name,**kwargs):
            if method == "GET":
                return {"task":{"status":"succeeded","content":{"url":"https://example.test/result.mp4"}}}
            self.assertTrue(url.endswith("/v2/video_generation"))
            payload = kwargs["json"]
            self.assertEqual((payload["duration"],payload["resolution"]),(4,"768P"))
            self.assertEqual([item.get("role") for item in payload["content"]],
                             [None,"reference_image","reference_video","reference_audio"])
            for item, mime in zip(payload["content"][2:],("video/mp4","audio/wav")):
                lease = urlsplit(item[item["type"]]["url"]).path
                response = await self.client.get(lease)
                self.assertEqual((response.status,response.content_type),(200,mime))
                if mime == "audio/wav":
                    with wave.open(io.BytesIO(await response.read()),"rb") as recording:
                        self.assertEqual(recording.getnframes(),2*recording.getframerate())
                        self.assertTrue(any(recording.readframes(recording.getnframes())))
                leases.append(lease)
            return {"task_id":"h3-mixed"}

        with patch.object(server.remote,"json_req",side_effect=upstream), \
                patch.object(server.remote,"_save_video",return_value={"files":[]}):
            response = await self.client.post("/api/generate",json=request)
            self.assertEqual(response.status,200,await response.text())
            jid = (await response.json())["ids"][0]
            for _ in range(300):
                if server.JOBS[jid]["state"] in ("done","error"):
                    break
                await asyncio.sleep(.02)
        self.assertEqual(server.JOBS[jid]["state"],"done",server.JOBS[jid].get("error"))
        self.assertEqual(len(leases),2)
        for lease in leases:
            self.assertEqual((await self.client.get(lease)).status,404)
        options = json.loads((await server.capabilities(None)).body)
        output = next(item for item in options["video"] if item["id"]==provider)["models"][0]
        self.assertEqual((output["durations"][0],output["durations"][-1],output["qualities"]),
                         (4,15,{"480p":"480P","std":"768P","hd":"2K"}))
        self.assertTrue(output["accepts_audio"] and output["accepts_video"])
        self.assertEqual(output["reference_limits"],{"images":9,"videos":3,"audio":3,"seconds":15,"total":12})
        self.assertNotIn(provider,[item["id"] for item in options["video_extension"]])

    async def test_video_optics_reaches_generation_prompt_and_leaves_request_reusable(self):
        optics={"lens":85,"sensor":"full-frame","optics":"anamorphic","aperture":"2.8"}
        raw={"kind":"video","board":"test","fields":{"scene":"雨夜车站","camera":"缓慢推近","action":"列车到站"},
             "prompt":"","video_optics":optics}
        requested=[]
        async def engine(_req,payload,_count):
            requested.append(payload)
            return web.json_response({"ids":["optic-job"]})
        with patch.object(server.providers,"primary",return_value=None),patch.object(server,"engine_up",return_value=True), \
                patch.object(server,"generate_engine",side_effect=engine):
            response=await self.client.post("/api/generate",json=raw)
            self.assertEqual(response.status,200,await response.text())
            self.assertEqual(requested[0]["prompt"].count("85 mm"),1)
            for text in ("缓慢推近","全画幅","椭圆散景","f/2.8","列车到站"):
                self.assertIn(text,requested[0]["prompt"])
            for bad in ({"lens":87},{"sensor":"unknown"},{"unexpected":True}):
                response=await self.client.post("/api/generate",json={**raw,"video_optics":bad})
                self.assertEqual(response.status,400,await response.text())
            self.assertEqual(len(requested),1)
        composed=server.apply_video_optics(raw)
        self.assertEqual(raw["fields"]["camera"],"缓慢推近")
        self.assertIn("85 mm",server.plain_prompt(composed))
        structured="integrated_multimodal_description: [Shot 1] A train arrives.\n\noverall_soundscape: Rain."
        augmented=server.apply_video_optics({"prompt":structured,"video_optics":{"lens":24}})["prompt"]
        self.assertIn("24 mm",augmented.split("\n\noverall_soundscape:")[0])
        self.assertTrue(augmented.endswith("overall_soundscape: Rain."))

    async def test_extension_uses_head_or_tail_and_keeps_direction_when_regenerating(self):
        path, ref = server.film._new(server.COMFY_DIR, "input", "source", ".mp4")
        frames=(Image.new("RGB",(64,64),"red" if i<36 else "blue") for i in range(84))
        server.film.encode_silent(path,frames,64,64,12,lambda:False,lambda _:None)
        source={"id":"n3","type":"video","name":"原片","x":300,"y":60,"data":{},"cur":0,
                "versions":[{"ref":ref,"w":64,"h":64,"seconds":7}]}
        self.board["nodes"].append(source)
        server.write_board(server.board_path("test"),self.board)
        provider={"id":"ark-extend","name":"方舟","enabled":True,"kind":"ark",
                  "config":{"motion_origin":"https://studio.example"},"secrets":{"api_key":"fixture"}}
        route={"provider":provider,"model":"doubao-seedance-2-5-fixture"}
        requested=[]

        async def upstream(_http,method,_url,_name,**kwargs):
            if method=="GET":
                return {"status":"succeeded","content":{"video_url":"https://provider.example/ext.mp4"}}
            body=kwargs["json"]
            self.assertEqual((body["ratio"],body["omni_reference_task_type"],body["duration"]),("adaptive","extend",5))
            text, video=body["content"]
            direction="before" if text["text"].startswith("向前延长 @视频1") else "after"
            self.assertTrue(text["text"].startswith(("向前延长 @视频1","向后延长 @视频1")))
            self.assertEqual(text["text"].count("35 mm"),1)
            self.assertIn("f/4",text["text"])
            blob=await self.client.get(urlsplit(video["video_url"]["url"]).path)
            self.assertEqual(blob.status,200)
            with av.open(io.BytesIO(await blob.read())) as recording:
                decoded=list(recording.decode(video=0))
                self.assertEqual(len(decoded),96)
                color=decoded[0 if direction=="before" else -1].to_ndarray(format="rgb24")[0,0]
                self.assertGreater(color[0 if direction=="before" else 2],225)
            requested.append(direction)
            return {"id":"external-job"}

        async def download(*_):
            out, media=server.film._new(server.COMFY_DIR,"output","continuation",".mp4")
            out.write_bytes(path.read_bytes())
            return {"files":[{"ref":media,"path":out,"kind":"video"}]}

        with patch.object(server.providers,"routes",return_value=[route]),patch.object(server.providers,"all_providers",return_value=[]), \
                patch.object(server.remote,"json_req",side_effect=upstream),patch.object(server.remote,"_save_video",side_effect=download):
            for direction in ("after","before"):
                self.svc.model.side_effect=[call("video_extend",{"node_id":"n3","direction":direction,"prompt":"列车靠站",
                    "video_optics":{"lens":35,"aperture":"4"}}),answer()]
                run_id=await self.send("续拍",f"extension-{direction}",["n3"])
                await self.wait(run_id, timeout=10)
                saved=self.load()
                result=saved["nodes"][-1]
                self.assertEqual(result["versions"][0]["video_recipe"]["extension"],direction)
                edge=result["versions"][0]["input_edges"][0]
                self.assertEqual([edge["ref"],edge["start"],edge["end"]],[ref,3,7] if direction=="after" else [ref,0,4])
                self.assertEqual(edge["extension"],direction)
                self.assertEqual(saved["nodes"][2],source)
            self.svc.model.side_effect=[call("video_regenerate",{"node_id":result["id"],"prompt":"加上夜景"}),answer()]
            await self.wait(await self.send("重新生成", "extension-regenerate",[result["id"]]), timeout=10)
            final=self.load()["nodes"][-1]
            self.assertEqual(final["id"],result["id"])
            self.assertEqual([v["video_recipe"]["extension"] for v in final["versions"]],["before","before"])
            self.assertEqual([v["video_recipe"]["video_optics"] for v in final["versions"]],[{"lens":35,"aperture":"4"}]*2)
            response=await self.client.post("/api/generate",json={"kind":"video","board":"test","provider":provider["id"],
                "extension":"before","prompt":"降落","video_refs":[{"ref":ref,"node_id":"n3","start":2,"end":6}]})
            self.assertEqual(response.status,400)
            self.assertIn("接点",json.loads(await response.text())["error"])
        self.assertEqual(requested,["after","before","before"])

    async def test_trimmed_reference_order_marks_and_leases(self):
        self.board["collaborators"] = {"8":"reviewer"}
        refs = []
        for nid, start in [("n3", 2), ("n4", 0)]:
            path, ref = server.film._new(server.COMFY_DIR, "input", "motion", ".mp4")
            frames = (Image.new("RGB", (64, 64), "red" if i < 24 else "blue") for i in range(60))
            server.film.encode_silent(path, frames, 64, 64, 12, lambda:False, lambda _:None)
            self.board["nodes"].append({"id":nid,"type":"video","name":nid,"versions":[{"ref":ref,"w":64,"h":64,"seconds":5}],
                                        "data":{},"cur":0,"x":50,"y":50})
            refs.append({"node_id":nid, "ref":ref, "start":start, "end":start+2})
        server.write_board(server.board_path("test"), self.board)
        provider = {"id":"ark-clip", "name":"方舟", "enabled":True, "kind":"ark",
                    "config":{"motion_origin":"https://studio.example"}, "secrets":{"api_key":"fixture"}}
        route = {"provider":provider, "model":"doubao-seedance-2-0-fixture"}
        leases = []
        checked = []

        async def upstream(_http, method, _url, _name, **kwargs):
            if method == "GET":
                return {"status":"succeeded", "content":{"video_url":"https://provider.example/result.mp4"}}
            text, *contents = kwargs["json"]["content"]
            self.assertIn("@视频1", text["text"])
            self.assertIn("@视频2", text["text"])
            self.assertTrue(kwargs["json"]["generate_audio"])
            self.assertEqual([part["role"] for part in contents], ["reference_video","reference_video"])
            for part, expected in zip(contents, ["blue","red"]):
                url = urlsplit(part["video_url"]["url"])
                self.assertEqual(url.hostname, "studio.example")
                leases.append(url.path)
                response = await self.client.get(url.path)
                self.assertEqual(response.status, 200)
                with av.open(io.BytesIO(await response.read())) as video:
                    self.assertFalse(video.streams.audio)
                    self.assertEqual(video.streams.video[0].average_rate, 24)
                    frames = [image.to_ndarray(format="rgb24") for image in video.decode(video=0)]
                self.assertEqual(len(frames), 48)
                pixel = np.mean(frames[12], axis=(0,1))
                self.assertGreater(pixel[2 if expected=="blue" else 0], 230)
                checked.append(expected)
            return {"id":"fake-job"}

        async def download(*_):
            path, ref = server.film._new(server.COMFY_DIR, "output", "formal", ".mp4")
            path.write_bytes(server.tools.ref_path(server.COMFY_DIR, refs[0]["ref"]).read_bytes())
            return {"files":[{"ref":ref,"path":path,"kind":"video"}]}

        payload = {"board":"test","kind":"video","provider":provider["id"],"video_refs":refs,
                   "prompt":"按 @视频1 运镜，并参考 @视频2 动作。","ar":1,"duration":5}
        with patch.object(server.providers, "routes", return_value=[route]), \
                patch.object(server.providers, "all_providers", return_value=[]), \
                patch.object(server.remote, "json_req", side_effect=upstream), \
                patch.object(server.remote, "_save_video", side_effect=download):
            self.assertEqual((await self.client.post("/api/generate", json=payload, headers={"X-Uid":"8"})).status, 403)
            self.assertEqual((await self.client.post("/api/generate", json={**payload,"video_refs":[{**refs[0],"end":3}]})).status, 400)
            self.assertEqual((await self.client.post("/api/generate", json={**payload,"video_refs":[{**refs[0],"node_id":"n4"}]})).status, 400)
            self.svc.model.side_effect = [call("video_generate", {"prompt":payload["prompt"], "video_refs":[
                {k:v for k,v in item.items() if k!="ref"} for item in refs]}), answer()]
            await self.wait(await self.send("按这两个参考片段生成", selected=["n3","n4"]), timeout=10)
        self.assertEqual(checked, ["blue","red"])
        for lease in leases:
            self.assertEqual((await self.client.get(lease)).status, 404)
        board = self.load()
        result = board["nodes"][-1]
        self.assertEqual([e["ref"] for e in board["edges"]], [item["ref"] for item in refs])
        self.assertEqual([e["start"] for e in result["versions"][0]["input_edges"]], [2,0])
        self.assertTrue(all(e["relation"]=="video_ref" for e in board["edges"]))
