from unittest.mock import AsyncMock, patch

from PIL import Image, ImageDraw

from chat_fixture import ChatFixture
from oneshot import config
from oneshot.editing import image_editor
from oneshot.generation.rewriter import LLM
from oneshot.web.media import grant_media


class WizardFrameReview(ChatFixture):
    async def test_near_identical_copies_are_reported_without_flagging_visible_motion(self):
        refs = []
        for ball_x in (18, 18, 78):
            image = Image.new("RGBA", (120, 96), (30, 100, 50, 255))
            ImageDraw.Draw(image).ellipse((ball_x,32,ball_x+15,47), fill=(250,200,0,255))
            ref = image_editor.save(config.COMFY_DIR, image, "input")["ref"]
            grant_media({"id":7}, ref)
            refs.append(ref)
        response = await self.client.post("/api/wizard/frame-review",json={"shots":[refs]})
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual(await response.json(),{"warnings":[{"shot":0,"left":0,"right":1}]})
        denied = await self.client.post("/api/wizard/frame-review",json={"shots":[refs]},headers={"X-Uid":"8"})
        self.assertEqual(denied.status,403)

    async def test_vision_checks_prop_state_even_when_composition_changes(self):
        refs = []
        for color in ("navy", "skyblue"):
            image = Image.new("RGBA", (150, 100), color)
            ImageDraw.Draw(image).ellipse((64, 20, 78, 34), fill="yellow")
            ref = image_editor.save(config.COMFY_DIR, image, "input")["ref"]
            grant_media({"id": 7}, ref)
            refs.append(ref)
        payload = {"shots": [refs], "expectations": ["The ball reaches the ground."], "english": True}
        payload_url = "/api/wizard/frame-review"
        response = await self.client.post(payload_url, json=payload)
        self.assertEqual(await response.json(), {"warnings": [], "semantic": [], "checked": 0, "requested": 1})
        llm = LLM("", lambda: self.http)
        with patch.dict(self.app, {"llm": llm}), patch.object(llm, "local_vision_available", return_value=True), \
                patch.object(llm, "local_vision", AsyncMock(return_value=(
                    '{"verdict":"mismatch","reason":"The ball is still in the air in both frames."}'
                ))) as inspect:
            response = await self.client.post(payload_url, json=payload)
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual(await response.json(), {"warnings": [], "checked": 1, "requested": 1,
                "semantic": [{"shot": 0, "reason": "The ball is still in the air in both frames."}]})
            _, messages = inspect.await_args.args
            self.assertIn("ball reaches the ground", messages[0]["text"])
            self.assertEqual([part["type"] for part in messages], ["text", "image_url", "image_url"])
