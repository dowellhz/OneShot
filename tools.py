"""Canvas tools beyond plain generation.

- storyboard(): a story + named reference images -> a shot list (Qwen3.5 VL), shaped like the canvas's video fields
- describe(): image -> a regeneration prompt, or -> 风格/场景/人物/镜头 fields
- find_shots() + analyze_shots(): 拉片 — cut a reference video into shots, keep each shot's first frame, describe them
- split_grid(): a storyboard grid image -> tiles
- concat(): several clips -> one mp4 (H.264 + AAC), audio kept in sync with each clip's picture
"""
import json, re, time, uuid
from fractions import Fraction
from pathlib import Path

from rewriter import LLM, image_part, strip_fences

FPS = 24
SR = 44100


def ref_path(comfy_dir: Path, ref: str) -> Path:
    """'input:h3studio/x.png' -> the file, only ever inside <media>/input|output/h3studio (no absolute paths, no ..)."""
    kind, _, path = str(ref).partition(":")
    if kind not in ("input", "output") or not path.startswith("h3studio/") or "\\" in path or "\0" in path:
        raise ValueError("bad ref")
    root = (comfy_dir / kind / "h3studio").resolve()
    p = (comfy_dir / kind / path).resolve()
    if not p.is_relative_to(root):
        raise ValueError("bad ref")
    return p


def _new(comfy_dir: Path, kind: str, prefix: str, ext: str) -> tuple[Path, str]:
    name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:5]}{ext}"
    d = comfy_dir / kind / "h3studio"
    d.mkdir(parents=True, exist_ok=True)
    return d / name, f"{kind}:h3studio/{name}"


def parse_json(text: str):
    t = strip_fences(text)
    a, b = min([i for i in (t.find("{"), t.find("[")) if i >= 0], default=-1), max(t.rfind("}"), t.rfind("]"))
    if a < 0 or b < a:
        raise RuntimeError("模型没有返回 JSON，请重试")
    t = t[a:b + 1]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        t = re.sub(r",\s*([}\]])", r"\1", t)          # trailing commas
        t = t.replace("“", "\"").replace("”", "\"") if t.count("\"") < 4 else t
        return json.loads(t)


def _lines(v) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [x.strip() for x in str(v or "").splitlines() if x.strip()]


# ------------------------------------------------------------------ storyboard

STORYBOARD_SYS = """你是电影分镜师。把用户的剧情拆成一组连续镜头，供 AI 视频模型（MiniMax H3，单镜头 3~8 秒，可生成对白和音效）逐镜生成。
只输出一个 JSON 对象，不要任何解释或代码块标记，格式：
{"title": "片名", "style": "全片统一的画面风格（写实/动画、色调、光线）",
 "characters": [{"name": "角色名", "look": "外貌、年龄、发型、服装，写具体", "voice": "声音特点，如 清亮的少女音，语速轻快"}],
 "shots": [{"duration": 5, "shot_size": "景别，如 中景", "camera": "机位与运镜，如 固定机位，缓慢推近",
   "scene": "这个镜头的地点、时间、环境、光线", "characters": ["出现在画面里的角色名"],
   "action": ["按时间顺序的动作，一行一个，2~4 条"], "dialogue": ["角色名（语气）：台词"],
   "sound": "环境音和动作音效", "keyframe": "这个镜头第一帧的静态画面，一句话写清人物位置、姿态、表情、景别、构图和光线，用于生成分镜图"}]}
要求：
- 镜头之间动作和空间连续，前一镜结尾接得上后一镜开头；每镜只讲一件事，3~8 秒。
- 角色名必须和用户给的参考图名字一致；参考图里能看到的外貌要写进 look，并在每个镜头保持一致。
- 台词只用剧情里写到的或剧情明显需要的，台词原文保留；没有台词就给空数组。
- 全部用中文。"""


async def storyboard(llm: LLM, comfy_dir: Path, story: str, refs: list, nshots, seconds, style: str, aspect: str) -> dict:
    content = []
    head = f"剧情：\n{story.strip()}\n"
    if style:
        head += f"\n指定风格：{style}"
    if nshots:
        head += f"\n镜头数：{int(nshots)} 个"
    if seconds:
        head += f"\n每个镜头时长：约 {int(seconds)} 秒"
    head += f"\n画幅：{aspect or '16:9'}"
    if refs:
        head += "\n\n参考图（按顺序附上）：\n" + "\n".join(
            f"- {r.get('name') or '参考图'}（{ {'character': '角色', 'scene': '场景', 'prop': '道具'}.get(r.get('kind'), '参考') }）"
            + (f"：{r['desc']}" if r.get("desc") else "") for r in refs)
    content.append({"type": "text", "text": head})
    for r in refs[:8]:
        content.append({"type": "text", "text": f"参考图「{r.get('name') or '参考图'}」"})
        content.append(image_part(ref_path(comfy_dir, r["ref"]), 640))
    out = parse_json(await llm.chat(STORYBOARD_SYS, content, max_tokens=3500, temperature=0.5))
    shots = []
    for s in out.get("shots") or []:
        d = s.get("duration") or seconds or 5
        try:
            d = int(round(float(d)))
        except Exception:
            d = 5
        shots.append({
            "duration": min(10, max(3, d)), "shot_size": str(s.get("shot_size") or ""), "camera": str(s.get("camera") or ""),
            "scene": str(s.get("scene") or ""), "characters": [str(c) for c in (s.get("characters") or [])],
            "action": _lines(s.get("action")), "dialogue": _lines(s.get("dialogue")), "sound": str(s.get("sound") or ""),
            "keyframe": str(s.get("keyframe") or ""),
        })
    if not shots:
        raise RuntimeError("没有拆出镜头，请把剧情写具体一些再试")
    chars = [{"name": str(c.get("name") or ""), "look": str(c.get("look") or ""), "voice": str(c.get("voice") or "")}
             for c in (out.get("characters") or []) if c.get("name")]
    return {"title": str(out.get("title") or ""), "style": str(out.get("style") or style or ""), "characters": chars, "shots": shots}


# ------------------------------------------------------------------ describe (反推)

DESC_PROMPT_SYS = """你是 AI 绘画提示词专家。看图，用中文写一段可以重新生成这张图的提示词（120~220 字）：
主体与外貌、服装、动作表情、场景环境、光线、色调、构图与景别、画面风格。只输出提示词本身。"""

DESC_FIELDS_SYS = """你是电影分镜师。看用户给的图（可能是视频首帧、角色图或场景图），为生成视频填写下列字段，只输出 JSON 对象：
{"style": "画面风格、质感、色调", "scene": "地点、时间、环境、光线", "people": ["名字：外貌、服装（图里有几个人写几行；用户给了名字就用用户的名字，否则用 人物1、人物2）"], "camera": "这张图的景别和适合的机位"}
全部用中文，写具体。"""


async def describe(llm: LLM, comfy_dir: Path, images: list, mode: str) -> dict:
    content = []
    for im in images[:4]:
        content.append({"type": "text", "text": f"图「{im.get('name') or '图'}」"})
        content.append(image_part(ref_path(comfy_dir, im["ref"]), 896))
    if mode == "fields":
        out = parse_json(await llm.chat(DESC_FIELDS_SYS, content, max_tokens=900, temperature=0.4))
        ppl = out.get("people")
        return {"fields": {"style": str(out.get("style") or ""), "scene": str(out.get("scene") or ""),
                           "people": "\n".join(_lines(ppl)), "camera": str(out.get("camera") or "")}}
    text = strip_fences(await llm.chat(DESC_PROMPT_SYS, content, max_tokens=700, temperature=0.4))
    return {"text": text}


# ------------------------------------------------------------------ 拉片

def find_shots(comfy_dir: Path, ref: str, max_shots: int = 12, *, relative_time=False) -> dict:
    """Cut detection on 4 fps samples; each shot's first frame is saved as an input image."""
    import av
    import numpy as np
    src = ref_path(comfy_dir, ref)
    samples = []                       # (time, small gray thumb, PIL frame)
    with av.open(str(src)) as c:
        vs = c.streams.video[0]
        dur = float(vs.duration * vs.time_base) if vs.duration else float(c.duration or 0) / 1e6
        origin = float((vs.start_time or 0) * vs.time_base) if relative_time else 0
        nxt = 0.0
        for f in c.decode(video=0):
            t = float(f.time if f.time is not None else origin) - origin
            if t + 1e-6 < nxt:
                continue
            nxt = t + 0.25
            img = f.to_image()
            g = np.asarray(img.convert("L").resize((48, 27)), dtype=np.float32)
            samples.append((t, g, img))
        dur = max(dur, samples[-1][0] + 0.25 if samples else 0)
    if not samples:
        raise RuntimeError("读不出视频画面")
    diffs = [0.0] + [float(np.mean(np.abs(samples[i][1] - samples[i - 1][1]))) for i in range(1, len(samples))]
    # a cut is an isolated spike; fast motion inside a shot gives runs of high values instead
    cuts = [0]
    for i in range(1, len(samples)):
        around = max(diffs[i - 1] if i > 1 else 0.0, diffs[i + 1] if i + 1 < len(diffs) else 0.0)
        if diffs[i] > 30 and diffs[i] > 2.5 * around and samples[i][0] - samples[cuts[-1]][0] >= 0.8:
            cuts.append(i)
    while len(cuts) > max_shots:       # merge the weakest cut
        k = min(range(1, len(cuts)), key=lambda j: diffs[cuts[j]])
        cuts.pop(k)
    shots = []
    for j, i in enumerate(cuts):
        start = samples[i][0]
        end = samples[cuts[j + 1]][0] if j + 1 < len(cuts) else dur
        img = samples[i][2]
        mid = samples[min((i + (cuts[j + 1] if j + 1 < len(cuts) else len(samples))) // 2, len(samples) - 1)][2]
        p, r = _new(comfy_dir, "input", "shot", ".png")
        img.save(p)
        mp, mr = _new(comfy_dir, "input", "shotmid", ".jpg")
        mid.convert("RGB").save(mp, quality=88)
        shots.append({"start": round(start, 2), "end": round(end, 2), "ref": r, "w": img.width, "h": img.height, "mid": mr})
    return {"duration": round(dur, 2), "shots": shots}


ANALYZE_SYS = """你是拉片分析师。用户给出一段视频按镜头切开后的画面（每个镜头给开头帧和中间帧，并标明时间段）。
逐个镜头分析，只输出 JSON 对象：
{"title": "概括这段视频", "style": "整体画面风格、色调、光线",
 "characters": [{"name": "人物1", "look": "外貌服装"}],
 "shots": [{"shot_size": "景别", "camera": "机位与运镜（对比开头帧和中间帧判断推/拉/摇/移/跟/固定）", "scene": "场景环境光线",
   "characters": ["出现的人物名"], "action": ["这个镜头里按顺序发生的动作，一行一个"], "sound": "推测的环境音和动作音效",
   "keyframe": "开头帧画面的一句话描述"}]}
shots 的个数和顺序必须与给出的镜头完全一致。人物用 人物1、人物2 命名并保持一致。全部用中文。"""


async def analyze_shots(llm: LLM, comfy_dir: Path, cut: dict) -> dict:
    content = [{"type": "text", "text": f"视频总长 {cut['duration']} 秒，共 {len(cut['shots'])} 个镜头。"}]
    if cut.get("known_people"):
        content.append({"type": "text", "text": "已有原片人物编号和外貌。能确认身份时沿用对应编号："
                        + json.dumps(cut["known_people"], ensure_ascii=False)})
    for k, s in enumerate(cut["shots"]):
        content.append({"type": "text", "text": f"镜头 {k + 1}（{s['start']:.1f}s–{s['end']:.1f}s）开头帧："})
        content.append(image_part(ref_path(comfy_dir, s["ref"]), 512))
        content.append({"type": "text", "text": f"镜头 {k + 1} 中间帧："})
        content.append(image_part(ref_path(comfy_dir, s["mid"]), 384))
    out = parse_json(await llm.chat(ANALYZE_SYS, content, max_tokens=3500, temperature=0.3))
    got = out.get("shots") or []
    shots = []
    for k, s in enumerate(cut["shots"]):
        a = got[k] if k < len(got) and isinstance(got[k], dict) else {}
        shots.append({
            "duration": min(10, max(3, int(round(s["end"] - s["start"])) or 3)), "shot_size": str(a.get("shot_size") or ""),
            "camera": str(a.get("camera") or ""), "scene": str(a.get("scene") or ""),
            "characters": [str(c) for c in (a.get("characters") or [])], "action": _lines(a.get("action")), "dialogue": [],
            "sound": str(a.get("sound") or ""), "keyframe": str(a.get("keyframe") or ""),
            "frame": {"ref": s["ref"], "w": s["w"], "h": s["h"]}, "src": [s["start"], s["end"]],
        })
    chars = [{"name": str(c["name"]), "look": str(c.get("look") or "")}
             for c in (out.get("characters") or []) if isinstance(c, dict) and c.get("name")]
    return {"title": str(out.get("title") or ""), "style": str(out.get("style") or ""), "characters": chars, "shots": shots}


async def locate_shot_person(llm: LLM, comfy_dir: Path, ref: str, person: str, look: str) -> dict:
    system = (
        "你负责在给出的这一帧画面里定位指定人物。将人物名称和外貌描述作为识别依据。"
        "只有能确认匹配人物时，才选一个落在其可见身体内部的点，尽量选胸口或头肩，避开遮挡物和相邻人物。"
        "以整张图为坐标系，左上角 [0,0]，右下角 [1,1]，横坐标在前。"
        '仅输出 JSON {"point":[x,y]}。人物未出现、无法区分或被完全挡住时输出 {"point":null}。'
    )
    content = [{"type": "text", "text": json.dumps({"name": person, "appearance": look}, ensure_ascii=False)},
               image_part(ref_path(comfy_dir, ref), 768)]
    result = parse_json(await llm.chat(system, content, max_tokens=120, temperature=0.1))
    return {"point": result.get("point")}


async def describe_shot_motion(llm: LLM, samples, fps, person, appearance):
    system = (
        "按时间顺序比较同一镜头的采样画面，描述看得见的人物动作、停顿、入画、出画、道具互动以及运镜。"
        "指定了原片人物时重点描述此人，无法辨认时标明。动作归到能看到它的采样编号，不推测准确起止时刻、音频或台词。"
        '只用中文输出 JSON 对象 {"camera":"机位和运镜","beats":[{"sample":1,"action":"可见动作"}]}。'
        "保持短句，只给关键变化，同一个采样编号最多一项。"
    )
    content = []
    if person:
        content.append({"type": "text", "text": json.dumps({"name":person, "appearance":appearance}, ensure_ascii=False)})
    for number, (tick, image) in enumerate(samples, 1):
        content.append({"type":"text", "text":f"采样 {number}，镜头内第 {tick / fps:.3f} 秒"})
        content.append(image)
    return parse_json(await llm.chat(system, content, max_tokens=1000, temperature=0.2))


async def locate_shot_entry(llm: LLM, samples, person, appearance):
    system = (
        "这些是同一镜头按时间顺序采样的画面。找出最早能明确辨认指定人物的那张采样。"
        "按人物名称和外貌核对，人物没有出现、身体太模糊或无法区分时，跳过该采样。"
        "在选中的画面上标出落在该人物可见身体内部的一点，左上[0,0]，右下[1,1]。"
        '只输出JSON {"sample":1,"point":[x,y]}，编号从1开始。均无法确认时输出 {"sample":null,"point":null}。'
    )
    content = [{"type":"text", "text":json.dumps({"name":person, "appearance":appearance}, ensure_ascii=False)}]
    for number, (_, image) in enumerate(samples, 1):
        content.extend([{"type":"text", "text":f"采样 {number}"}, image])
    return parse_json(await llm.chat(system, content, max_tokens=120, temperature=0.1))


# ------------------------------------------------------------------ grid split

def split_grid(comfy_dir: Path, ref: str, rows: int, cols: int) -> list:
    from PIL import Image
    im = Image.open(ref_path(comfy_dir, ref)).convert("RGB")
    W, H = im.size
    tw, th = W / cols, H / rows
    inset = round(min(tw, th) * 0.012)          # drop thin separators between panels
    out = []
    for r in range(rows):
        for c in range(cols):
            box = (round(c * tw) + inset, round(r * th) + inset, round((c + 1) * tw) - inset, round((r + 1) * th) - inset)
            tile = im.crop(box)
            p, rf = _new(comfy_dir, "input", f"tile{r + 1}{c + 1}", ".png")
            tile.save(p)
            out.append({"ref": rf, "w": tile.width, "h": tile.height, "row": r, "col": c})
    return out


# ------------------------------------------------------------------ concat

def concat(comfy_dir: Path, refs: list) -> dict:
    import av
    import numpy as np
    from PIL import Image
    if len(refs) < 2:
        raise ValueError("至少选两段视频")
    srcs = [ref_path(comfy_dir, r) for r in refs]
    with av.open(str(srcs[0])) as c0:
        W, H = c0.streams.video[0].codec_context.width, c0.streams.video[0].codec_context.height
    W, H = W - W % 2, H - H % 2
    path, ref = _new(comfy_dir, "output", "cut", ".mp4")
    out = av.open(str(path), "w")
    vo = out.add_stream("libx264", rate=FPS)
    vo.width, vo.height, vo.pix_fmt = W, H, "yuv420p"
    vo.options = {"crf": "18", "preset": "medium"}
    ao = out.add_stream("aac", rate=SR)
    ao.layout = "stereo"
    vpts = 0
    audio = []

    def fit(frame):
        if frame.width == W and frame.height == H:
            return frame.reformat(format="yuv420p")
        img = frame.to_image()
        s = min(W / img.width, H / img.height)
        img = img.resize((max(2, round(img.width * s)), max(2, round(img.height * s))))
        bg = Image.new("RGB", (W, H))
        bg.paste(img, ((W - img.width) // 2, (H - img.height) // 2))
        return av.VideoFrame.from_image(bg).reformat(format="yuv420p")

    for src in srcs:
        n0 = vpts
        with av.open(str(src)) as c:
            t_next, last = 0.0, None
            for f in c.decode(video=0):      # resample to 24 fps by time: each output tick shows the frame on screen then
                t = float(f.time or 0)
                while t_next <= t + 1e-6:
                    g = fit(f if last is None or t_next >= t - 0.5 / FPS else last)
                    g.pts = vpts; g.time_base = Fraction(1, FPS); vpts += 1
                    for pkt in vo.encode(g):
                        out.mux(pkt)
                    t_next += 1 / FPS
                last = f
        nframes = vpts - n0
        want = round(nframes / FPS * SR)
        pcm = np.zeros((2, 0), dtype=np.float32)
        with av.open(str(src)) as c:
            if c.streams.audio:
                rs = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
                parts = []
                for f in c.decode(audio=0):
                    for g in rs.resample(f):
                        parts.append(g.to_ndarray())
                for g in rs.resample(None):
                    parts.append(g.to_ndarray())
                if parts:
                    pcm = np.concatenate(parts, axis=1).astype(np.float32)
        if pcm.shape[1] < want:
            pcm = np.concatenate([pcm, np.zeros((2, want - pcm.shape[1]), dtype=np.float32)], axis=1)
        audio.append(pcm[:, :want])
    for pkt in vo.encode():
        out.mux(pkt)
    pcm = np.concatenate(audio, axis=1)
    apts = 0
    for i in range(0, pcm.shape[1], 1024):
        chunk = np.ascontiguousarray(pcm[:, i:i + 1024])
        af = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="stereo")
        af.sample_rate = SR
        af.pts = apts; af.time_base = Fraction(1, SR)
        apts += chunk.shape[1]
        for pkt in ao.encode(af):
            out.mux(pkt)
    for pkt in ao.encode():
        out.mux(pkt)
    out.close()
    return {"ref": ref, "w": W, "h": H, "seconds": round(vpts / FPS, 2)}


def video_info(path: Path) -> dict:
    from render import probe
    w, h, duration, _ = probe(path)
    return {"w": w, "h": h, "seconds": round(duration, 2)}
