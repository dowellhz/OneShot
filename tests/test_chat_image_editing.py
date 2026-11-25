"""Assistant editing for pinned versions and reusable layers."""

from unittest.mock import patch

from PIL import Image

from oneshot.editing import image_editor
from oneshot.editing import image_routes
import server

from chat_fixture import ChatFixture, answer, call


class ChatImageEditing(ChatFixture):
    async def test_upscale_routes_the_chosen_historical_image_and_keeps_both_versions(self):
        old = self.source["ref"]
        current = image_editor.save(server.COMFY_DIR,Image.new("RGB",(200,100),"blue"))
        server.grant_media({"id":7},current["ref"])
        board = self.load()
        board["nodes"][0]["versions"].append(current)
        board["nodes"][0]["cur"] = 1
        response = await self.client.put("/api/board/test",json=board)
        self.assertEqual(response.status,200,await response.text())

        def upscale(root, directory, ref, scale):
            self.assertEqual((ref,scale),(old,4))
            image = image_editor.load(root,ref)
            return image_editor.save(root,image.resize((image.width*scale,image.height*scale)))

        self.svc.model.side_effect = [call("image_upscale",{"node_id":"n1","scale":4,"version":1}),answer()]
        with patch.object(server.image_upscale,"upscale",side_effect=upscale) as invoked:
            rid = await self.send("把第一版超分四倍")
            self.assertEqual((await self.wait(rid))["state"],"done")
            self.assertEqual(invoked.call_count,1)
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual([v["ref"] for v in versions[:2]],[old,current["ref"]])
        self.assertEqual((versions[-1]["w"],versions[-1]["h"]),(512,384))
        self.assertEqual(versions[-1]["edit"],{"source":old,"mode":"upscale","scale":4,"model":"FSRCNN"})

    async def test_decompose_adds_a_reusable_layer_stack_to_the_source_node(self):
        ref = self.source["ref"]

        async def labels(_app, tool, payload):
            self.assertEqual((tool,payload["ref"]),("decompose",ref))
            image = Image.new("L",(128,96))
            image.paste(1,(12,20,60,64))
            image.paste(2,(72,14,100,80))
            return image_editor.save(server.COMFY_DIR,image)

        self.svc.model.side_effect = [call("image_decompose",{"node_id":"n1"}),answer()]
        with patch.object(image_routes,"run_image_tool",labels):
            rid = await self.send("把选中的图片自动拆成独立图层")
            self.assertEqual((await self.wait(rid))["state"],"done")
        versions = self.load()["nodes"][0]["versions"]
        self.assertEqual(len(versions),2)
        self.assertEqual(versions[0]["ref"],ref)
        self.assertEqual(versions[1]["edit"],{"source":ref,"mode":"decompose"})
        layers = versions[1]["layer_stack"]["layers"]
        self.assertEqual([(l["name"],l["x"],l["y"]) for l in layers],
                         [("背景",0,0),("物体 1",12,20),("物体 2",72,14)])
