"""Tests for image editing transformations and mask compositing."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

from oneshot.editing import image_editor as editor


class ImageEdits(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.im = Image.new("RGBA", (300, 180), (30, 80, 120, 217))
        ImageDraw.Draw(self.im).rectangle((110, 50, 140, 90), fill=(200, 90, 30, 255))
        self.source = editor.save(self.root, self.im, kind="input")["ref"]
        self.mask = Image.new("L", self.im.size)
        ImageDraw.Draw(self.mask).rectangle((110, 50, 140, 90), fill=255)
        self.mask_ref = editor.save(self.root, self.mask, kind="input")["ref"]

    def tearDown(self):
        self.tmp.cleanup()

    def prepared(self, **kwargs):
        return editor.prepare(self.root, {"ref": self.source, "mask": self.mask_ref,
                                         "prompt": "换成绿色", "mode": "region", **kwargs})

    def generated(self, color="lime"):
        # Different model output size exercises result alignment / resizing.
        return [editor.save(self.root, Image.new("RGBA", (160, 160), color))]

    def test_region_preserves_every_unselected_rgba_pixel(self):
        spec = self.prepared(feather=12)["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        result = editor.load(self.root, output["ref"])
        self.assertEqual(result.size, self.im.size)
        for y in range(self.im.height):
            for x in range(self.im.width):
                if self.mask.getpixel((x, y)) == 0:
                    self.assertEqual(self.im.getpixel((x, y)), result.getpixel((x, y)))
        self.assertNotEqual(result.getpixel((125, 70)), self.im.getpixel((125, 70)))
        self.assertEqual(editor.load(self.root, self.source).tobytes(), self.im.tobytes())

    def test_result_blend_is_opacity(self):
        spec = self.prepared(feather=0, strength=.5)["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        pixel = editor.load(self.root, output["ref"]).getpixel((125, 70))
        self.assertTrue(98 <= pixel[0] <= 101)
        self.assertTrue(171 <= pixel[1] <= 174)

    def test_outpaint_preserves_original_and_fills_new_canvas(self):
        spec = self.prepared(mode="outpaint", padding={"left": 30, "top": 20, "right": 40})["_image_edit"]
        output = editor.composite(self.root, spec, self.generated())[0]
        result = editor.load(self.root, output["ref"])
        self.assertEqual(result.size, (370, 200))
        self.assertEqual(result.crop((30, 20, 330, 200)).tobytes(), self.im.tobytes())
        self.assertEqual(result.getpixel((0, 0)), (0, 255, 0, 255))

    def test_crop_rotate_flip_preserves_transparency_and_source(self):
        result = editor.transform(self.root, {"ref": self.source, "crop": {"x": 30, "y": 20, "w": 100, "h": 80}, "rotate": 90, "flip_x": True})
        actual = editor.load(self.root, result["ref"])
        expected = self.im.crop((30, 20, 130, 100)).rotate(-90, expand=True).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(actual.size, (80, 100))
        self.assertEqual(editor.load(self.root, self.source).tobytes(), self.im.tobytes())

    def test_rejects_invalid_inputs(self):
        blank = editor.save(self.root, Image.new("L", self.im.size), kind="input")["ref"]
        small = editor.save(self.root, Image.new("L", (10, 10), 255), kind="input")["ref"]
        for kwargs in ({"mask": blank}, {"mask": small}, {"feather": float("nan")}, {"strength": 2},
                       {"ref": "input:h3studio/../../../etc/passwd"}, {"mode": "unknown"}, {"prompt": ""},
                       {"mode": "outpaint", "padding": {}}, {"mode": "outpaint", "padding": {"left": -1}}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, OSError)):
                self.prepared(**kwargs)
        for crop in ({"x": 290, "y": 0, "w": 20, "h": 10}, {"x": -1, "y": 0, "w": 10, "h": 10}):
            with self.assertRaises(ValueError):
                editor.transform(self.root, {"ref": self.source, "crop": crop})


    def test_ordered_layers_opacity_position_and_hidden_layers(self):
        red = editor.save(self.root, Image.new("RGBA", (20, 20), (255, 0, 0, 255)), kind="input")
        blue = editor.save(self.root, Image.new("RGBA", (20, 20), (0, 0, 255, 255)), kind="input")
        r = editor.compose_layers(self.root, {"ref": self.source, "layers": [
            {"ref": red["ref"], "x": -10, "y": 10, "opacity": .5},
            {"ref": blue["ref"], "x": 0, "y": 10, "visible": False}]})
        im = editor.load(self.root, r["ref"])
        self.assertEqual(im.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(im.getpixel((5, 15)), (255, 0, 0, 128))
        self.assertEqual(im.getpixel((15, 15)), (0, 0, 0, 0))

    def test_selection_cutout_multiplies_existing_alpha(self):
        r = editor.cut_selection(self.root, {"ref": self.source, "mask": self.mask_ref})
        im = editor.load(self.root, r["ref"])
        self.assertEqual(im.getpixel((0, 0))[3], 0)
        self.assertEqual(im.getpixel((125, 70)), self.im.getpixel((125, 70)))

    def test_native_prepare_uses_real_mask_and_preserves_recipe(self):
        p = self.prepared(backend="native", denoise=.7, steps=30, seed=123)
        self.assertIsNotNone(p["_native_inpaint"])
        self.assertEqual(len(p["images"]), 1)
        native = p["_native_inpaint"]
        self.assertEqual(native["prompt"], "换成绿色")
        self.assertEqual(native["denoise"], .7)
        self.assertEqual(editor.load(self.root, native["mask"]).size, editor.load(self.root, native["image"]).size)
        result = editor.composite(self.root, p["_image_edit"], self.generated())[0]
        recipe = result["extra"]["edit"]["recipe"]
        self.assertEqual(recipe["mask"], self.mask_ref)
        self.assertEqual(recipe["seed"], 123)
        patch = editor.load(self.root, result["extra"]["edit"]["layer"]["ref"])
        self.assertEqual(patch.getpixel((0, 0))[3], 0)
