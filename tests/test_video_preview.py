"""Tests for video generation reference previews."""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from PIL import Image

import server
from oneshot import config
from oneshot.generation import local as local_generation
from oneshot.generation import reference as video_reference
from oneshot.generation import remote_jobs
from oneshot.web import media as media_routes


class VideoReferencePreview(unittest.IsolatedAsyncioTestCase):
    async def test_native_preview_uses_submitted_keyframe_positions(self):
        raw = {"kind":"video","prompt":"A steady camera", "duration":2.5,"planned":True,
               "images":[{"role":"frame","time":time,"index":i,"ref":f"input:h3studio/frame-{i}.png"}
                         for i,time in enumerate((0,2.53,5.5),1)]}
        service = SimpleNamespace(app={"creative_memory":SimpleNamespace(
            prepare=Mock(side_effect=lambda _user, raw, **_options: raw))})
        request = server.agent_chat.InternalRequest(service,{"id":7,"role":"member"},raw)
        with patch.object(server.providers,"primary",return_value=None), patch.object(local_generation,"engine_up",return_value=True):
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
        with TemporaryDirectory() as directory, patch.object(config,"COMFY_DIR",Path(directory)), \
                patch.object(media_routes,"require_media"), patch.object(video_reference,"prepare_reference_generation",side_effect=prepare), \
                patch.object(remote_jobs,"generate_remote",new=AsyncMock(return_value=result)) as submit:
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
            with patch.object(video_reference,"prepare_reference_generation",side_effect=server.bad("参考音频超过时长")):
                with self.assertRaises(web.HTTPBadRequest) as limit_error:
                    await server.asset_reference_review(request(raw),await request(raw).json())
                self.assertIn("参考音频超过时长",limit_error.exception.text)
            path.unlink()
            with self.assertRaises(web.HTTPBadRequest) as missing_image:
                await server.asset_reference_review(request(raw),await request(raw).json())
            self.assertIn("参考图无法读取",missing_image.exception.text)
