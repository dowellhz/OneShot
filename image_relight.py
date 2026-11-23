"""Structured lighting instructions for image-to-image editing."""

CONTROLS = {
    "x":(-100,100,-55), "y":(-100,100,-55), "depth":(-100,100,0),
    "key":(0,100,55), "exposure":(-100,100,0), "temperature":(-100,100,0), "rim":(0,100,15),
}


def validate(value):
    if not isinstance(value,dict) or not value or set(value) - CONTROLS.keys():
        raise ValueError("请选择有效的图片布光参数")
    settings = {}
    for key, (low, high, default) in CONTROLS.items():
        setting = value.get(key,default)
        if type(setting) is not int or not low <= setting <= high:
            raise ValueError("图片布光参数超出可用范围")
        settings[key] = setting
    return settings


def instructions(light):
    x, y, depth, temp = (light[key] for key in ("x","y","depth","temperature"))
    horizontal = "左侧" if x < -15 else "右侧" if x > 15 else "横向居中"
    vertical = "偏上" if y < -15 else "偏下" if y > 15 else "与主体齐平"
    distance = f"{'前方' if depth > 0 else '后方'} {abs(depth)}%" if depth else "侧向"
    color = "偏冷" if temp < -15 else "偏暖" if temp > 15 else "中性"
    kelvin = 5600 - temp * (31 if temp >= 0 else 39)
    return (f"主光来自{horizontal}、{vertical}、{distance}，主光强度 {light['key']}/100，"
            f"整体曝光 {light['exposure']/100:g} EV，色温 {kelvin} K（{color}），轮廓光强度 {light['rim']}/100")


def generation_prompt(light):
    x, y, depth, temp = (light[key] for key in ("x","y","depth","temperature"))
    horizontal = "left" if x < -15 else "right" if x > 15 else "centered horizontally"
    vertical = "above" if y < -15 else "below" if y > 15 else "at subject height"
    distance = "in front of the subject" if depth > 0 else "behind the subject" if depth < 0 else "to the side"
    kelvin = 5600 - temp * (31 if temp >= 0 else 39)
    color = "cool blue" if temp < -15 else "warm amber" if temp > 15 else "neutral white"
    return ("Reproduce @图1 with the same objects, framing, background and illustration or photographic style. "
            f"Modify only the highlights and shadows: illumination from the {horizontal}, {vertical} and {distance}, "
            f"{color} ({kelvin} K), key strength {light['key']}%, rim strength {light['rim']}%, "
            f"exposure compensation {light['exposure']/100:g} EV. "
            "Keep the background unobstructed and add no objects. "
            "Output only the edited image. Do not add lettering, numbers, logos, captions or diagrams.")
