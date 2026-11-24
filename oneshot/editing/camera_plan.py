"""Camera direction for a selected video interval."""
MODES = {"fixed": "固定机位", "cut": "切换机位", "move": "连续运镜"}
ANGLES = {"front": "正面", "front_left": "左前方三分之四角度", "front_right": "右前方三分之四角度",
          "left": "左侧", "right": "右侧", "rear": "背面", "overhead": "俯拍", "low": "低机位仰拍"}
SCALES = {"detail": "大特写", "close": "特写", "medium_close": "中近景", "medium": "中景", "wide": "全景", "far": "远景"}


def validate(value):
    if not isinstance(value, dict) or value.get("mode") not in tuple(MODES):
        raise ValueError("请选择有效的镜头方式")
    mode = value["mode"]

    def view(key):
        endpoint = value.get(key)
        if (not isinstance(endpoint, dict) or endpoint.get("angle") not in tuple(ANGLES)
                or endpoint.get("scale") not in tuple(SCALES)):
            raise ValueError("请选择有效的机位角度和景别")
        return {"angle": endpoint["angle"], "scale": endpoint["scale"]}

    start = view("start")
    if mode == "fixed":
        return {"mode": mode, "start": start}
    end = view("end")
    return {"mode": mode, "start": start, "end": end} if end != start else {"mode": "fixed", "start": start}


def instructions(plan):
    def describe(view):
        return ANGLES[view["angle"]] + " · " + SCALES[view["scale"]]

    start = describe(plan["start"])
    mode = plan["mode"]
    if mode == "fixed":
        return f"整段使用固定机位（{start}），保持取景和景别。"
    end = describe(plan["end"])
    if mode == "cut":
        return f"前半段用固定机位（{start}），片段中点硬切到固定机位（{end}），两机位之间不要连续移动。"
    return f"从起始机位（{start}）平滑、连续移动至结束机位（{end}），不中途切镜。"
