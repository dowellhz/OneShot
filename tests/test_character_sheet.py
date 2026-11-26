"""Single-character references stay independent of story composition."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from chat_fixture import ChatFixture


class CharacterSheet(ChatFixture):
    async def test_count_requires_exactly_one_visible_character(self):
        vision = AsyncMock(side_effect=['{"count":2}','{"count":1}','{"count":-1}'])
        llm = SimpleNamespace(local_vision_available=lambda:True,local_vision=vision)
        with patch.dict(self.app,{"llm":llm}):
            for expected in (False,True,False):
                response = await self.client.post("/api/character-sheet/review",json={"ref":self.source["ref"]})
                self.assertEqual(response.status,200,await response.text())
                result = await response.json()
                self.assertTrue(result["checked"])
                self.assertEqual(result["passed"],expected)
        self.assertIn("child",vision.await_args.args[0])

    def test_character_sheet_does_not_receive_story_memory_or_images(self):
        isolated = self.app["creative_memory"].prepare(
            {"id":7,"role":"member"},{"kind":"image","character_sheet":True,"board":"test",
             "prompt":"一只母猫正面定妆照","images":[{"ref":self.source["ref"]}],
             "memory_ids":["unrelated"],"memory_used":[{"desc":"抱着小猫"}],"expand":True},
        )
        self.assertEqual(isolated["prompt"],"一只母猫正面定妆照")
        self.assertFalse(isolated["images"])
        self.assertFalse(isolated["expand"])
        self.assertNotIn("memory_used",isolated)
