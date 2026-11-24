import io
import unittest
from unittest.mock import AsyncMock, patch

from PIL import Image
from oneshot.storage import db
from oneshot.integrations import web_research as research
from test_agent_chat import ChatFixture, answer, call


class PublicResearch(unittest.IsolatedAsyncioTestCase):
    async def test_public_result_normalization_and_documented_fallback(self):
        parser = research.DuckResults()
        parser.feed('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage">A <b>heading</b></a>'
                    '<a class="result__snippet">A <strong>snippet</strong></a>'
                    '<a class="result__a" href="http://127.0.0.1/">Ignored</a>')
        self.assertEqual(parser.items,[{"title":"A heading","url":"https://example.org/page","snippet":"A snippet"}])
        with patch.object(research.providers,"routes",return_value=[]), \
             patch.object(research,"fetch",new=AsyncMock(return_value=b'<form id="challenge-form"></form>')), \
             patch.object(research,"wikipedia",new=AsyncMock(return_value=parser.items)):
            source, items = await research.search(None,"lighting")
            self.assertIn("百科",source)
            self.assertEqual(items,parser.items)
            with self.assertRaises(research.ResearchError):
                await research.search(None,"lighting",site="example.org")
            with self.assertRaises(research.ResearchError):
                await research.search(None,"lighting",days=7)

    async def test_brave_filters_dates_and_exact_domain(self):
        route = {"provider":{"secrets":{"api_key":"fixture-only"}}}
        rows = [{"title":"A","url":"https://example.org/a","description":"First","page_age":"2026-01-10"},
                {"title":"B","url":"https://example.org.invalid/b","description":"Wrong"}]
        upstream = AsyncMock(return_value={"web":{"results":rows}})
        with patch.object(research.providers,"routes",return_value=[route]), patch.object(research,"json_results",upstream):
            provider, items = await research.search(None,"cinema",days=7,site="example.org")
        self.assertEqual(provider,"Brave Search")
        self.assertEqual([item["title"] for item in items],["A"])
        self.assertEqual(items[0]["date"],"2026-01-10")
        self.assertEqual(upstream.await_args.args[2]["freshness"],"pw")


class ResearchAssistant(ChatFixture):
    async def test_search_and_import_retains_source_license_and_conversation_scope(self):
        item = {"title":"参考光线","url":"https://commons.wikimedia.org/?curid=1","credit":"Example",
                "license":"CC BY 4.0","license_url":"https://creativecommons.org/licenses/by/4.0/",
                "image":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/demo.png/640px-demo.png"}
        payload = io.BytesIO()
        Image.new("RGB",(120,80),"blue").save(payload,format="PNG")
        async def model(messages,_):
            tool_messages = [message for message in messages if message["role"]=="tool"]
            if not tool_messages:
                return call("web_search",{"query":"公开图片","kind":"images"},"search")
            if len(tool_messages)==1:
                import json
                source = json.loads(tool_messages[0]["content"])["sources"][0]
                return call("web_save_references",{"source_ids":[source["id"]],"kind":"images"},"save")
            return answer()
        self.svc.model.side_effect = model
        with patch.object(research,"search",new=AsyncMock(return_value=("Wikimedia Commons",[item]))), \
             patch.object(research,"fetch",new=AsyncMock(return_value=payload.getvalue())) as downloaded:
            run = await self.wait(await self.send("找一张开放图片并放在画布上"),timeout=10)
        self.assertEqual(run["state"],"done")
        version = self.load()["nodes"][-1]["versions"][0]
        self.assertEqual(version["web_source"]["link"],item["url"])
        self.assertEqual(version["web_source"]["license"],item["license"])
        self.assertEqual(version["w"],120)
        self.assertEqual(downloaded.await_args.args[1],item["image"])
        call_id = db.one("SELECT id FROM chat_calls WHERE run_id=? AND name='web_search'",run["id"])["id"]
        with self.assertRaises(research.ResearchError):
            research.lookup("different-session",[call_id+"-1"])
        with self.assertRaises(research.ResearchError):
            await research.download_image(None,self.root,{"image":"https://example.org/my-photo.png"})
