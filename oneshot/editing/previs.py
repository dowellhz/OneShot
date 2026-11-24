"""Deterministic CPU output for the canvas blockout editor."""
from bisect import bisect_left
from math import ceil, cos, floor, hypot, isfinite, pi, radians, sin, sqrt, tan
import re

from PIL import Image, ImageDraw

from oneshot.editing import render

ASPECTS = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (720, 720)}
MAX_SECONDS = 14
SHAPES = {"box", "column", "figure", "mesh"}
MAX_TRIANGLES = 2000
POSE_FIELDS = ("x", "y", "z", "yaw")
CAMERA_FIELDS = ("x", "y", "z", "tx", "ty", "tz", "fov")
CAMERA_TRANSITIONS = ("linear","smooth","cut")
NEAR = .12
CAMERA_MOVES = ("push", "pull", "slide_left", "slide_right", "orbit_left", "orbit_right", "follow")
LIGHT_LIMITS = {"azimuth":(-180,180),"elevation":(-90,90),"key":(0,1.5),"ambient":(0,1)}
LIGHT_TONES = {"neutral":(1,1,1),"warm":(1,.78,.58),"cool":(.64,.81,1)}


def bounded(value, low, high):
    if type(value) not in (int, float) or not low <= value <= high or not isfinite(value):
        raise ValueError("场景坐标、机位或尺寸超出范围")
    return value


def keys(entries, fields, frames):
    if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
        raise ValueError("每条轨道需要 1 到 32 个关键帧")
    result, previous = [], -1
    for key in entries:
        if not isinstance(key, dict) or type(key.get("t")) is not int or not previous < key["t"] <= frames:
            raise ValueError("关键帧必须按时间排列")
        previous = key["t"]
        allowed = CAMERA_TRANSITIONS if fields==CAMERA_FIELDS else ("linear","smooth")
        ease = key.get("ease")
        pose = {"t":previous, "ease":ease if ease in allowed else "linear"}
        for field in fields:
            limits = (18, 95) if field == "fov" else (-360, 360) if field == "yaw" else (-50, 50)
            pose[field] = bounded(key.get(field), *limits)
        result.append(pose)
    return result


def validate(value):
    if not isinstance(value, dict) or type(value.get("duration")) is not int or not 2 <= value["duration"] <= MAX_SECONDS:
        raise ValueError("白模时长必须是 2 到 14 秒的整数")
    aspect = value.get("aspect")
    if not isinstance(aspect, str) or aspect not in ASPECTS:
        raise ValueError("请选择支持的白模画幅")
    frames = value["duration"] * render.FPS
    camera = keys(value.get("camera"), CAMERA_FIELDS, frames)
    objects = value.get("objects")
    if not isinstance(objects, list) or len(objects) > 24:
        raise ValueError("一个白模场景最多包含 24 个物体")
    result, seen, total_triangles = [], set(), 0
    for item in objects:
        if not isinstance(item, dict):
            raise ValueError("物体格式不正确")
        ident, shape, label = item.get("id"), item.get("shape"), item.get("label")
        if (not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", ident) or ident == "camera" or ident in seen
                or not isinstance(shape, str) or shape not in SHAPES or not isinstance(label, str) or not label.strip()):
            raise ValueError("物体编号、名称或形状不正确")
        seen.add(ident)
        entry = {"id":ident, "shape":shape, "label":label.strip()[:40],
                 **{field:bounded(item.get(field), .1, 20) for field in ("width","height","depth")},
                 "keys":keys(item.get("keys"), POSE_FIELDS, frames)}
        if shape == "mesh":
            triangles = item.get("triangles")
            if not isinstance(triangles, list) or not triangles:
                raise ValueError("导入模型的三角网格无效")
            total_triangles += len(triangles)
            if total_triangles > MAX_TRIANGLES:
                raise ValueError("场景最多支持 2000 个导入三角面")
            if any(not isinstance(face, list) or len(face) != 9 for face in triangles):
                raise ValueError("导入模型的三角网格无效")
            entry["triangles"] = [[bounded(value, -1, 1) for value in face] for face in triangles]
        result.append(entry)
    scene = {"duration":value["duration"], "aspect":aspect, "camera":camera, "objects":result}
    if "lighting" in value:
        light = value["lighting"]
        try:
            if not isinstance(light,dict) or type(light.get("enabled",True)) is not bool:
                raise ValueError
            if light.get("enabled", True):
                tone = light.get("tone")
                if not isinstance(tone,str) or tone not in LIGHT_TONES:
                    raise ValueError
                scene["lighting"] = {**{key:bounded(light.get(key),*limits) for key,limits in LIGHT_LIMITS.items()},
                                     "tone":tone}
        except ValueError:
            raise ValueError("白模灯光设置超出范围或缺少参数") from None
    return scene


def sample(track, t, fields):
    right = bisect_left(track, t, key=lambda pose:pose["t"])
    if right == 0 or right == len(track):
        return track[0] if not right else track[-1]
    a, b = track[right - 1], track[right]
    if b["ease"] == "cut":
        return a if t<b["t"] else b
    factor = (t - a["t"]) / (b["t"] - a["t"])
    if b["ease"] == "smooth":
        factor = factor * factor * (3 - 2 * factor)
    return {k:a[k] + (b[k] - a[k]) * factor for k in fields}


def camera_motion(scene, plan):
    if not isinstance(plan,dict) or plan.get("mode") not in CAMERA_MOVES:
        raise ValueError("请选择运镜方式")
    mode = plan["mode"]
    start, end = plan.get("start"), plan.get("end")
    limit = scene["duration"] * render.FPS
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= limit:
        raise ValueError("请选择有效的运镜时间区间")
    track = scene["camera"]
    current = sample(track,start,CAMERA_FIELDS)
    pose = {key:current[key] for key in CAMERA_FIELDS}
    keys_before = [key for key in track if key["t"] < start]
    keys_after = [key for key in track if key["t"] > end]
    incoming = next((key for key in track if key["t"] >= start),None)
    ease_in = incoming["ease"] if incoming and (incoming["ease"]!="cut" or incoming["t"]==start) else "linear"
    if mode == "follow":
        actor = next((item for item in scene["objects"] if item["id"] == plan.get("target")),None)
        if actor is None:
            raise ValueError("请选择要跟拍的物体")
        generated = follow_camera(pose,actor,start,end,ease_in)
    else:
        generated = move_camera(pose,mode,plan.get("amount"),start,end,ease_in)
    combined = keys_before + generated + keys_after
    if len(combined) > 32:
        raise ValueError("运镜后的机位超过 32 个关键帧，请缩小区间或精简机位轨道")
    return keys(combined, CAMERA_FIELDS, limit)


def follow_camera(pose, actor, start, end, ease_in):
    track = actor["keys"]
    base = sample(track,start,POSE_FIELDS)
    target_height = actor["height"] * .6
    ticks = [start, *(key["t"] for key in track if start < key["t"] < end), end]
    result = []
    for tick in ticks:
        position = sample(track,tick,POSE_FIELDS)
        ease = ease_in if tick == start else next((key["ease"] for key in track if key["t"] >= tick),"linear")
        result.append({**pose,"t":tick,"ease":ease,
                       **{axis:pose[axis]+position[axis]-base[axis] for axis in ("x","y","z")},
                       "tx":position["x"],"ty":position["y"]+target_height,"tz":position["z"]})
    return result


def object_motion(scene, plan):
    if not isinstance(plan,dict):
        raise ValueError("请选择物体及路线")
    target = next((item for item in scene["objects"] if item["id"] == plan.get("target")),None)
    if target is None:
        raise ValueError("请选择要设置路线的物体")
    start, end = plan.get("start"), plan.get("end")
    limit = scene["duration"] * render.FPS
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= limit:
        raise ValueError("请选择有效的起止时间")
    points = plan.get("points")
    if not isinstance(points,list) or not 1 <= len(points) <= min(31,end-start):
        raise ValueError("请添加路线点，且每段至少占一帧")
    track = target["keys"]
    initial = sample(track,start,POSE_FIELDS)
    x, z = initial["x"], initial["z"]
    distances, route = [], []
    for point in points:
        if not isinstance(point,dict):
            raise ValueError("路线点格式无效")
        next_x, next_z = bounded(point.get("x"),-50,50), bounded(point.get("z"),-50,50)
        distance = hypot(next_x-x,next_z-z)
        if distance < .01:
            raise ValueError("相邻路线点重合，请拉开距离")
        distances.append(distance)
        route.append((next_x,next_z))
        x, z = next_x, next_z
    combined = [key for key in track if key["t"] < start]
    ease_in = next((key["ease"] for key in track if key["t"] >= start),"linear")
    combined.append({"t":start,"ease":ease_in,**{field:initial[field] for field in POSE_FIELDS}})
    distance_sum, covered, tick = sum(distances), 0, start
    for index, ((x,z),distance) in enumerate(zip(route,distances)):
        covered += distance
        remaining = len(route) - index - 1
        tick = end if not remaining else min(end-remaining,max(tick+1,start+round((end-start)*covered/distance_sum)))
        pose = sample(track,tick,POSE_FIELDS)
        combined.append({"t":tick,"ease":"linear","x":x,"z":z,"y":pose["y"],"yaw":pose["yaw"]})
    combined.extend(key for key in track if key["t"] > end)
    if len(combined) > 32:
        raise ValueError("路线超过 32 个关键帧，请删除部分路点或精简原轨道")
    return keys(combined,POSE_FIELDS,limit)


def move_camera(pose, mode, amount, start, end, ease_in):
    dx, dz = pose["x"]-pose["tx"], pose["z"]-pose["tz"]
    distance = hypot(dx,dz)
    if distance < .2:
        raise ValueError("机位和目标在俯视图中重合，请先拉开距离")
    if mode.startswith("orbit"):
        angle = bounded(amount,5,180)
        steps = min(end-start,ceil(angle/12))
        angle = radians(angle) * (1 if mode=="orbit_left" else -1)
        result = [{**pose,"t":start,"ease":ease_in}]
        for index in range(1,steps+1):
            fraction = index/steps
            theta = angle * fraction * fraction * (3-2*fraction)
            result.append({**pose,"t":round(start+fraction*(end-start)),"ease":"linear",
                           "x":pose["tx"]+dx*cos(theta)-dz*sin(theta),
                           "z":pose["tz"]+dx*sin(theta)+dz*cos(theta)})
        return result
    length = bounded(amount,.1,20)
    if mode == "push" and length >= distance-.15:
        raise ValueError("推进距离超过机位与目标之间的距离")
    if mode.startswith("slide"):
        direction = -1 if mode=="slide_left" else 1
        shift_x, shift_z = direction*dz*length/distance, -direction*dx*length/distance
        finish = {**pose,"x":pose["x"]+shift_x,"z":pose["z"]+shift_z,
                  "tx":pose["tx"]+shift_x,"tz":pose["tz"]+shift_z}
    else:
        direction = -1 if mode=="push" else 1
        finish = {**pose,"x":pose["x"]+direction*dx*length/distance,
                  "z":pose["z"]+direction*dz*length/distance}
    return [{**pose,"t":start,"ease":ease_in},{**finish,"t":end,"ease":"smooth"}]


def box(cx=0, bottom=0, cz=0, width=1, height=1, depth=1, shade=1):
    x0, x1 = cx - width/2, cx + width/2
    y0, y1 = bottom, bottom + height
    z0, z1 = cz - depth/2, cz + depth/2
    vertices = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
                (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    faces = [((0,3,2,1),.74), ((4,5,6,7),.86), ((0,4,7,3),.68),
             ((1,2,6,5),.78), ((3,7,6,2),1), ((0,1,5,4),.62)]
    return [([vertices[i] for i in order], intensity * shade) for order, intensity in faces]


def column():
    rim = [(cos(i*pi/8)/2, sin(i*pi/8)/2) for i in range(16)]
    bottom = [(x,0,z) for x,z in rim]
    top = [(x,1,z) for x,z in rim]
    faces = [(bottom,.62), (top[::-1],1)]
    for i in range(16):
        j = (i+1)%16
        faces.append(([bottom[i],top[i],top[j],bottom[j]], .76 + .14 * cos((i+2)*pi/8)))
    return faces


MESHES = {
    "box": box(),
    "column": column(),
    "figure": [face for shape in [
        box(0,.82,0,.43,.18,.70,1), box(0,.40,0,.63,.41,.75),
        box(-.17,0,0,.24,.42,.50,.91), box(.17,0,0,.24,.42,.50,.91),
        box(-.40,.36,0,.16,.39,.45,.96), box(.40,.36,0,.16,.39,.45,.96),
    ] for face in shape],
}


def unit(v, fallback):
    mag = sqrt(sum(x*x for x in v))
    return tuple(x / mag for x in v) if mag > 1e-6 else fallback


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def mesh_faces(triangles):
    faces = []
    for face in triangles:
        a, b, c = face[:3], face[3:6], face[6:]
        normal = cross(tuple(v-u for v,u in zip(b,a)), tuple(v-u for v,u in zip(c,a)))
        length = sqrt(sum(value*value for value in normal))
        if length:
            light = .63 + .34 * abs(sum(value*axis for value,axis in zip(normal,(.36,.8,.48))) / length)
            faces.append(((a,b,c),light))
    return faces


def view(camera):
    position = tuple(camera[k] for k in ("x","y","z"))
    forward = unit(tuple(camera[k] - x for k,x in zip(("tx","ty","tz"), position)), (0,0,-1))
    right = unit(cross(forward, (0,1,0)), (1,0,0))
    up = cross(right, forward)
    def to_camera(point):
        delta = tuple(a-b for a,b in zip(point, position))
        return tuple(sum(a*b for a,b in zip(axis, delta)) for axis in (right, up, forward))
    return to_camera


def near_hit(a, b):
    f = (NEAR - a[2]) / (b[2] - a[2])
    return (a[0] + (b[0] - a[0])*f, a[1] + (b[1] - a[1])*f, NEAR)


def clip(points):
    result, previous = [], points[-1]
    for point in points:
        if (point[2] >= NEAR) != (previous[2] >= NEAR):
            result.append(near_hit(previous, point))
        if point[2] >= NEAR:
            result.append(point)
        previous = point
    return result


def light_setup(settings):
    if not settings:
        return None
    a, e = map(radians,(settings["azimuth"],settings["elevation"]))
    return (sin(a)*cos(e),sin(e),cos(a)*cos(e)), LIGHT_TONES[settings["tone"]], settings["key"], settings["ambient"]


def light_color(vertices, legacy, lighting):
    if lighting is None:
        return (round(228*legacy),)*3
    a, b, c = vertices[:3]
    normal = unit(cross(tuple(v-u for u,v in zip(a,b)),tuple(v-u for u,v in zip(a,c))),(0,0,0))
    direction, tint, key, ambient = lighting
    direct = key*max(0,sum(u*v for u,v in zip(normal,direction)))
    return tuple(min(255,floor(228*(ambient+direct*channel)+.5)) for channel in tint)


def paint(scene, tick, width, height, meshes=None):
    if meshes is None:
        meshes = {item["id"]:mesh_faces(item["triangles"]) for item in scene["objects"] if item["shape"] == "mesh"}
    image = Image.new("RGB", (width, height), "#24262b")
    draw = ImageDraw.Draw(image)
    camera = sample(scene["camera"], tick, CAMERA_FIELDS)
    transform = view(camera)
    focal = height / (2 * tan(radians(camera["fov"]) / 2))

    def project(point):
        x, y, z = point
        return (width/2 + focal*x/z, height/2 - focal*y/z)

    for offset in range(-16,17):
        for a,b in [((offset,0,-16),(offset,0,16)),((-16,0,offset),(16,0,offset))]:
            a, b = transform(a), transform(b)
            if a[2] < NEAR and b[2] < NEAR:
                continue
            if a[2] < NEAR:
                a = near_hit(a, b)
            if b[2] < NEAR:
                b = near_hit(b, a)
            draw.line((project(a),project(b)), fill="#64666c" if not offset else "#3c3e44")

    faces, lighting = [], light_setup(scene.get("lighting"))
    for item in scene["objects"]:
        pose = sample(item["keys"], tick, POSE_FIELDS)
        a = radians(pose["yaw"])
        c, s = cos(a), sin(a)
        geometry = meshes[item["id"]] if item["shape"] == "mesh" else MESHES[item["shape"]]
        for vertices, light in geometry:
            world = [(pose["x"] + x*item["width"]*c - z*item["depth"]*s,
                      pose["y"] + y*item["height"],
                      pose["z"] + x*item["width"]*s + z*item["depth"]*c) for x,y,z in vertices]
            points = clip([transform(vertex) for vertex in world])
            if len(points) >= 3:
                faces.append((sum(p[2] for p in points)/len(points), [project(p) for p in points], light_color(world,light,lighting)))
    for _, points, color in sorted(faces, key=lambda face:face[0], reverse=True):
        draw.polygon(points, fill=color, outline="#555861")
    return image


def render_span(scene, span=None):
    end = scene["duration"] * render.FPS
    if span is None:
        return 0, end
    if (not isinstance(span,(list,tuple)) or len(span)!=2 or any(type(t) is not int for t in span)
            or not 0 <= span[0] < span[1] <= end):
        raise ValueError("白模渲染区间超出时间轴")
    return tuple(span)


def export(comfy_dir, scene, progress, cancelled, *, span=None):
    width, height = ASPECTS[scene["aspect"]]
    start, end = render_span(scene,span)
    total = end - start
    path, ref = render._new(comfy_dir, "output", "previs", ".mp4")
    try:
        meshes = {item["id"]:mesh_faces(item["triangles"]) for item in scene["objects"] if item["shape"] == "mesh"}
        frames = (paint(scene, tick, width, height, meshes) for tick in range(start,end))
        count = render.encode_silent(path, frames, width, height, render.FPS, cancelled,
                                     lambda n:progress(n,total))
        if cancelled():
            raise render.Cancelled()
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return {"ref":ref, "w":width, "h":height, "seconds":count/render.FPS}
