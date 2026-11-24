"""Structured virtual camera controls for image-to-image generation."""

LENSES = {18:"超广角",24:"广角",28:"广角",35:"小广角",40:"标准",50:"标准",85:"人像",100:"中长焦",135:"长焦",200:"长焦"}
FRAMINGS = ("", "面部特写", "近景", "中景", "全景", "远景")
SENSORS = {"s35":"Super 35","full-frame":"全画幅","medium-format":"中画幅"}
OPTICS = {"spherical":"球面定焦，保留自然的几何比例",
          "anamorphic":"变形镜头，采用椭圆散景与轻微的横向光晕",
          "vintage":"复古柔焦镜头，采用柔和的高光过渡和轻微光晕",
          "macro":"微距镜头，表现近距离的细节和纹理"}
APERTURES = ("1.4","2","2.8","4","5.6","8","11","16")


def validate_optics(value):
    if not isinstance(value, dict) or set(value) - {"lens", "sensor", "optics", "aperture"}:
        raise ValueError("请选择有效的镜头参数")
    settings = {}
    if "lens" in value:
        lens = value["lens"]
        if type(lens) is not int or lens not in LENSES:
            raise ValueError("请选择有效的镜头焦段")
        settings["lens"] = lens
    for key, options in (("sensor",SENSORS),("optics",OPTICS),("aperture",APERTURES)):
        detail = value.get(key,"")
        if not isinstance(detail,str) or detail and detail not in options:
            raise ValueError("请选择有效的传感器、镜头质感或光圈")
        if detail:
            settings[key] = detail
    return settings


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
    clean.update(lens=lens,framing=framing)
    clean.update(validate_optics({key:value[key] for key in ("sensor","optics","aperture") if key in value}))
    return clean


def instructions(view):
    yaw, pitch, distance, lens, framing = (view[key] for key in ("yaw","pitch","distance","lens","framing"))
    parts = [
        f"从原机位向{'右' if yaw > 0 else '左'}环绕 {abs(yaw)}°" if yaw else "保持水平机位",
        f"{'升高机位俯拍' if pitch > 0 else '降低机位仰拍'} {abs(pitch)}°" if pitch else "保持机位高度",
        f"相机{'靠近' if distance < 0 else '远离'}主体，移动幅度 {abs(distance)}/100" if distance else "保持拍摄距离",
        f"使用 {lens} mm {LENSES[lens]}镜头",
        f"景别采用{framing}" if framing else "保持原图景别",
    ]
    return "，".join(parts + optics_instructions(view, include_lens=False))


def optics_instructions(view, *, include_lens=True):
    parts = []
    if include_lens and (lens := view.get("lens")):
        parts.append(f"使用 {lens} mm {LENSES[lens]}镜头")
    if sensor := view.get("sensor"):
        parts.append(f"采用 {SENSORS[sensor]} 传感器的画面观感")
    if optics := view.get("optics"):
        parts.append(OPTICS[optics])
    if aperture := view.get("aperture"):
        depth = "主体清晰并自然虚化背景" if float(aperture) <= 2.8 else "保留更大的清晰范围" if float(aperture) >= 8 else "采用适中的景深"
        parts.append(f"以 f/{aperture} 光圈为参考，{depth}")
    return parts


def generation_prompt(view):
    yaw, pitch, distance, lens, framing = (view[key] for key in ("yaw","pitch","distance","lens","framing"))
    horizontal = "Keep the horizontal viewpoint."
    if yaw:
        side = "right" if yaw > 0 else "left"
        horizontal = (f"Orbit the camera {abs(yaw)} degrees to the {side} around the stationary subject. "
                      f"Show the subject's {side} side more prominently.")
        if abs(yaw) >= 150:
            horizontal = f"Orbit {abs(yaw)} degrees to the {side}. Show the back of the same subject."
    vertical = "Keep the camera height."
    if pitch > 0:
        vertical = f"Raise the camera and look down {pitch} degrees. Reveal more of the top surfaces."
    elif pitch < 0:
        vertical = f"Lower the camera and look up {abs(pitch)} degrees. Show more of the underside where visible."
    parts = ["Render @图1 from the requested camera position as a new single view of the same scene.",
             horizontal, vertical]
    if yaw or pitch:
        parts.append("Change the perspective and occlusions to match the new viewpoint. Keep the subject stationary.")
    if distance:
        parts.append(f"Move the camera {'closer to' if distance < 0 else 'farther from'} the subject by {abs(distance)}/100.")
    shot = dict(zip(FRAMINGS,("same shot size","face close-up","close-up","medium shot","wide shot","long shot")))[framing]
    parts.append(f"Frame a {shot} with a {lens} mm lens." if framing else f"Keep the same shot size using a {lens} mm lens.")
    if sensor := view.get("sensor"):
        name = {"s35":"Super 35","full-frame":"full-frame","medium-format":"medium-format"}[sensor]
        parts.append(f"Use a {name} sensor look.")
    if optics := view.get("optics"):
        parts.append({"spherical":"Use natural perspective and clean spherical optics.",
                      "anamorphic":"Use subtle oval bokeh and soft horizontal flare.",
                      "vintage":"Use soft highlight roll-off and subtle vintage halation.",
                      "macro":"Show fine surface detail at close focus."}[optics])
    if aperture := view.get("aperture"):
        depth = "with shallow depth of field" if float(aperture) <= 2.8 else "with deep focus" if float(aperture) >= 8 else "with moderate depth of field"
        parts.append(f"Use f/{aperture} {depth}.")
    parts.append("Preserve identity, pose, proportions, materials, visual style, surroundings and lighting from @图1. "
                 "Add no text, borders or panels.")
    return " ".join(parts)
