"""Instructions and validation for storyboard keyframe timing."""

MOTION_FRAMES = """
本次用于多关键帧动画。每镜优先只安排一个主要动作，能容纳对白时优先用 5 秒，后续动作拆到下一镜。
keyframe 写首帧，motion_frames.end 写尾帧。首帧写动作开始前的状态，尾帧写动作完成后的可见结果。简单动作、静止和普通对白只写首尾两帧。
只有首尾无法明确表现关键动作时，才同时填写 motion_frames.middle（关键动作瞬间的静态画面）和 motion_frames.middle_time（从本镜开头算起的秒数，数字，严格介于首尾之间）。离手、触地、交接需要约束时，选择最能说明该动作的瞬间，按动作实际发生的时间填写，避免默认放在镜头正中。
每帧各用一句话描述可绘制的静态画面。若一镜有多个需要分别约束的动作，按动作拆镜并保留原有顺序和台词。
保持人物身份、服装、机位和光线。人物和道具的位置按动作推进。尾帧不要回到起始姿态或描述再次执行同一动作，除非剧情明确要求。
凡动作涉及道具移动或交接，逐帧写出道具相对地面、手或其他固定参照的位置，以及它正接触哪里。尾帧应明确道具最终被谁拿住、落在哪里或从哪一侧出画，并交代与下一镜的衔接。
例如，5 秒抛球镜头：球在右手中 → 1.2 秒球刚离手、位于手前上方 → 同一颗球在远处草地贴地向右滚动。下一镜从球贴地滚动开始。小狗交还球时，首帧的球在狗嘴里，尾帧的球接触掌心，狗嘴已与球分开。
仅当首帧可直接复用上一镜尾帧且不切换机位时，设置 continues_previous 为 true，并逐字沿用上一镜的 scene、shot_size 和 camera。
"""

def shot_text_key(text):
    return "".join(char for char in text if char.isalnum())


def motion_frame_plan(raw: dict, duration: int, first: str) -> dict:
    end = raw.get("end")
    middle = raw.get("middle")
    result = {"end": end.strip()[:1200]} if isinstance(end, str) else {}
    time = raw.get("middle_time")
    if not isinstance(middle, str) or type(time) not in (int, float) or not 1 / 24 <= time <= duration - 1 / 24:
        return result
    middle = middle.strip()[:1200]
    key = shot_text_key(middle)
    if key and key not in (shot_text_key(first), shot_text_key(result.get("end", ""))):
        result.update(middle=middle, middle_time=time)
    return result
