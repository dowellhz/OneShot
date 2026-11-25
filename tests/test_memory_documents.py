"""Import narrative documents and select relevant source passages."""

from unittest.mock import AsyncMock, patch
from zipfile import ZipFile
import io
import json

from aiohttp import FormData, web

from oneshot.generation import requests as generation_requests
import server

from memory_fixture import MemoryFixture


class MemoryDocuments(MemoryFixture):
    async def import_document(self, name, raw):
        form = FormData()
        form.add_field("file",raw,filename=name,content_type="application/octet-stream")
        return await self.client.post("/api/document-import",data=form)

    async def test_document_search_and_generation_use_relevant_original_passage(self):
        raw = ("日常资料\n"*6000 + "港口雨夜灯位：蓝色灯从左侧照亮吊车。").encode()
        response = await self.import_document("场景档案.md",raw)
        self.assertEqual(response.status,200,await response.text())
        document = await response.json()
        self.assertEqual(document["name"],"场景档案.md")
        self.assertFalse(document["truncated"])
        saved = await self.client.post("/api/memory",json={
            "kind":"document","name":"港口设定","board":"test","document":document,
        })
        self.assertEqual(saved.status,200,await saved.text())
        result = await (await self.client.get("/api/memory",params={"board":"test","q":"吊车"})).json()
        self.assertTrue(result[0]["document_match"])
        self.assertLessEqual(len(result[0]["document"]["excerpt"]),350)
        self.assertNotIn("text",result[0]["document"])
        seen = []
        async def submit(req,payload):
            seen.append(payload)
            return web.json_response({"ids":[]})
        chat = AsyncMock(return_value='{"visual_details":["蓝灯从左侧照亮吊车"]}')
        with patch.object(generation_requests,"_generate_request",submit), patch.object(self.app["llm"], "available", return_value=True), \
                patch.object(self.app["llm"], "chat", chat, create=True):
            generated = await self.client.post("/api/generate",json={"kind":"image","board":"test","prompt":"@港口设定 拍吊车","images":[]})
            self.assertEqual(generated.status,200,await generated.text())
            self.assertEqual((await generated.json())["image_story_context"], "applied")
        self.assertIn("蓝灯从左侧照亮吊车",seen[0]["prompt"])
        self.assertIn("蓝色灯从左侧照亮吊车",chat.await_args.args[1])
        self.assertNotIn("港口设定",seen[0]["prompt"])
        self.assertNotIn("港口雨夜灯位",seen[0]["prompt"])
        self.assertLess(len(seen[0]["prompt"]),2500)
        self.assertEqual(seen[0]["images"],[])

    async def test_docx_and_pdf_extract_text_without_rendering_active_content(self):
        word = io.BytesIO()
        with ZipFile(word,"w") as archive:
            archive.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>灯从左侧来</w:t></w:r></w:p></w:body></w:document>')
        response = await self.import_document("布光.docx",word.getvalue())
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["text"],"灯从左侧来")
        self.assertEqual((await self.import_document("空.txt",b" \n")).status,400)

        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=612,height=792)
        font = DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):font})})
        content = DecodedStreamObject()
        content.set_data(b"BT /F1 18 Tf 40 700 Td (Scene notes) Tj ET")
        page[NameObject("/Contents")] = content
        pdf = io.BytesIO()
        writer.write(pdf)
        response = await self.import_document("镜头.pdf",pdf.getvalue())
        self.assertEqual(response.status,200,await response.text())
        self.assertEqual((await response.json())["text"],"Scene notes")

    async def test_document_context_and_project_exclusion(self):
        a=await self.create(name='世界观',kind='document',desc='城市禁止燃油车辆',ref=None)
        st=self.app['creative_memory'];p=st.prepare({'id':7,'role':'member'},{'kind':'image','board':'test','prompt':'@世界观 街道远景'})
        prompt, status = await server.image_story_prompt(self.app["llm"], p)
        self.assertEqual(status, "unavailable")
        self.assertIn("街道远景", prompt["prompt"])
        self.assertNotIn("禁止燃油车辆", prompt["prompt"])
        self.assertEqual(prompt['images'],[])
        other={**self.board,'name':'Other'};server.board_path('other').write_text(json.dumps(other))
        self.assertFalse(any(a['id']==m['id'] for m in st.list({'id':7,'role':'member'},'other')))
        self.assertEqual((await self.client.post('/api/generate',json={'kind':'image','board':'other','prompt':'@世界观 街道'})).status,400)
