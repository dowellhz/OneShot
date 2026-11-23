"""Deterministic CPU output for the canvas blockout editor."""
from bisect import bisect_left
from math import cos, isfinite, pi, radians, sin, sqrt, tan
import re

from PIL import Image, ImageDraw

import render

ASPECTS = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (720, 720)}
MAX_SECONDS = 14
SHAPES = {"box", "column", "figure", "mesh"}
MAX_TRIANGLES = 2000
POSE_FIELDS = ("x", "y", "z", "yaw")
CAMERA_FIELDS = ("x", "y", "z", "tx", "ty", "tz", "fov")
NEAR = .12


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
        pose = {"t":previous, "ease":"smooth" if key.get("ease") == "smooth" else "linear"}
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
    return {"duration":value["duration"], "aspect":aspect, "camera":camera, "objects":result}


def sample(track, t, fields):
    right = bisect_left(track, t, key=lambda pose:pose["t"])
    if right == 0 or right == len(track):
        return track[0] if not right else track[-1]
    a, b = track[right - 1], track[right]
    factor = (t - a["t"]) / (b["t"] - a["t"])
    if b["ease"] == "smooth":
        factor = factor * factor * (3 - 2 * factor)
    return {k:a[k] + (b[k] - a[k]) * factor for k in fields}


def box(cx=0, bottom=0, cz=0, width=1, height=1, depth=1, shade=1):
    x0, x1 = cx - width/2, cx + width/2
    y0, y1 = bottom, bottom + height
    z0, z1 = cz - depth/2, cz + depth/2
    vertices = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
                (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    faces = [((0,1,2,3),.74), ((4,5,6,7),.86), ((0,4,7,3),.68),
             ((1,5,6,2),.78), ((3,2,6,7),1), ((0,1,5,4),.62)]
    return [([vertices[i] for i in order], intensity * shade) for order, intensity in faces]


def column():
    rim = [(cos(i*pi/8)/2, sin(i*pi/8)/2) for i in range(16)]
    bottom = [(x,0,z) for x,z in rim]
    top = [(x,1,z) for x,z in rim]
    faces = [(bottom,.62), (top,1)]
    for i in range(16):
        j = (i+1)%16
        faces.append(([bottom[i],bottom[j],top[j],top[i]], .76 + .14 * cos((i+2)*pi/8)))
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

    faces = []
    for item in scene["objects"]:
        pose = sample(item["keys"], tick, POSE_FIELDS)
        a = radians(pose["yaw"])
        c, s = cos(a), sin(a)
        geometry = meshes[item["id"]] if item["shape"] == "mesh" else MESHES[item["shape"]]
        for vertices, light in geometry:
            points = clip([transform((pose["x"] + x*item["width"]*c - z*item["depth"]*s,
                                      pose["y"] + y*item["height"],
                                      pose["z"] + x*item["width"]*s + z*item["depth"]*c))
                           for x,y,z in vertices])
            if len(points) >= 3:
                faces.append((sum(p[2] for p in points)/len(points), [project(p) for p in points], light))
    for _, points, light in sorted(faces, key=lambda face:face[0], reverse=True):
        brightness = round(228 * light)
        draw.polygon(points, fill=(brightness,brightness,brightness), outline="#555861")
    return image


def export(comfy_dir, scene, progress, cancelled):
    width, height = ASPECTS[scene["aspect"]]
    total = scene["duration"] * render.FPS
    path, ref = render._new(comfy_dir, "output", "previs", ".mp4")
    try:
        meshes = {item["id"]:mesh_faces(item["triangles"]) for item in scene["objects"] if item["shape"] == "mesh"}
        frames = (paint(scene, tick, width, height, meshes) for tick in range(total))
        count = render.encode_silent(path, frames, width, height, render.FPS, cancelled,
                                     lambda n:progress(n,total))
        if cancelled():
            raise render.Cancelled()
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return {"ref":ref, "w":width, "h":height, "seconds":count/render.FPS}
