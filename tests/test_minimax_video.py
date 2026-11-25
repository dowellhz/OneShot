"""Tests for cloud MiniMax video options and project bindings."""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from aiohttp import web
from PIL import Image

import server
from oneshot import config
from oneshot.generation import jobs as generation_jobs
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.generation import requests as generation_requests
from oneshot.web import media as media_routes


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

        with TemporaryDirectory() as directory, patch.object(config,"COMFY_DIR",Path(directory)), \
                patch.object(generation_jobs,"JOBS",{}), patch.object(media_routes,"require_media"), \
                patch.object(generation_requests,"requested_generation_route",return_value=route), \
                patch.object(video_reference,"board_meta",return_value={"owner":7}), \
                patch.object(video_reference,"can_edit",return_value=True), \
                patch.object(server.providers,"routes",return_value=[route]), patch.object(server.providers,"all_providers",return_value=[]), \
                patch.object(server.db,"task_start"), patch.object(remote_jobs,"start_remote") as start, \
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
