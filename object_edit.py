"""Frame annotations for targeted edits of a video segment."""
import math

from PIL import ImageDraw

from render import capture_frame

ACTIONS = {"remove": "移除物体", "replace": "替换物体"}


def validate(value):
    if not isinstance(value, dict) or value.get("action") not in tuple(ACTIONS):
        raise ValueError("请选择移除或替换物体")
    at, box, ref = value.get("at"), value.get("box"), value.get("replacement_ref")
    if type(at) not in (int, float) or not math.isfinite(at) or at < 0:
        raise ValueError("请选择原片中标注物体的时间")
    if (not isinstance(box, list) or len(box) != 4 or
            any(type(point) not in (int, float) or not 0 <= point <= 1 for point in box) or
            box[2] - box[0] < .005 or box[3] - box[1] < .005):
        raise ValueError("请在视频画面上框选有效的目标范围")
    plan = {"action":value["action"], "at":at, "box":box}
    if value["action"] == "replace":
        if not isinstance(ref, str) or not ref:
            raise ValueError("请选择用来替换物体的参考图")
        plan["replacement_ref"] = ref
        name = value.get("replacement_name")
        if isinstance(name, str) and name.strip():
            plan["replacement_name"] = name.strip()[:120]
    return plan


def instructions(plan, image_number):
    action = ("移除该物体，补全被遮挡的背景。" if plan["action"] == "remove" else
              f"用 @图片{image_number + 1} 展示的物体替换它，按原片调整大小、透视和光线。")
    return (f"在 @视频1 中跟随并编辑 @图片{image_number} 红框标出的同一个物体。{action}"
            "红框仅用于定位，生成画面里不要出现红框。其他人物、物体、背景和运镜沿用原片，保留片段的时长和画幅。")


def annotate(path, output, plan):
    image, _ = capture_frame(path, "time", plan["at"])
    image.thumbnail((1600, 1600))
    w, h = image.size
    x1, y1, x2, y2 = plan["box"]
    ImageDraw.Draw(image).rectangle((round(x1*(w-1)), round(y1*(h-1)), round(x2*(w-1)), round(y2*(h-1))),
                                    outline="#ff3030", width=max(2, round(min(w,h)*.009)))
    image.save(output)
