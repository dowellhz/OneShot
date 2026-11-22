"""Structured virtual camera controls for image-to-image generation."""

LENSES = {24:"广角",35:"小广角",50:"标准",85:"人像",135:"长焦"}
FRAMINGS = ("", "面部特写", "近景", "中景", "全景", "远景")


def validate(value):
    if not isinstance(value, dict):
        raise ValueError("请选择有效的图片机位参数")
    clean = {}
    for field, low, high in (("yaw",-180,180),("pitch",-60,60),("distance",-100,100)):
        point = value.get(field,0)
        if type(point) is not int or not low <= point <= high:
            raise ValueError("请检查图片机位的角度或距离")
        clean[field] = point
    lens, framing = value.get("lens",50), value.get("framing","")
    if type(lens) is not int or lens not in LENSES or not isinstance(framing,str) or framing not in FRAMINGS:
        raise ValueError("请选择有效的镜头焦段或景别")
    return {**clean,"lens":lens,"framing":framing}


def instructions(view):
    yaw, pitch, distance, lens, framing = (view[key] for key in ("yaw","pitch","distance","lens","framing"))
    parts = [
        f"从原机位向{'右' if yaw > 0 else '左'}环绕 {abs(yaw)}°" if yaw else "保持水平机位",
        f"{'升高机位俯拍' if pitch > 0 else '降低机位仰拍'} {abs(pitch)}°" if pitch else "保持机位高度",
        f"相机{'靠近' if distance < 0 else '远离'}主体，移动幅度 {abs(distance)}/100" if distance else "保持拍摄距离",
        f"使用 {lens} mm {LENSES[lens]}镜头",
        f"景别采用{framing}" if framing else "保持原图景别",
    ]
    return "，".join(parts)
