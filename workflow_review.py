"""Read-only evidence for how a canvas and its saved media versions were made."""
from collections import defaultdict
import math
import re
import camera_plan
import image_camera
import image_editor
import image_relight

KINDS = {"text":"文字", "script":"分镜脚本", "image":"图片", "video":"视频", "audio":"音频"}
SOURCES = {"upload":"上传", "gen":"生成", "edit":"编辑", "frame":"截帧", "tile":"宫格拆分",
           "film":"剪辑导出", "remake":"视频重制", "asset":"资产库", "previs":"白模预演", "audio_gen":"生成音频",
           "audio_separation":"人声分离"}
ROLES = {"first":"首帧", "last":"尾帧", "frame":"关键帧", "keyframe":"关键帧",
         "subject":"参考图", "text":"文字输入", "remake":"原片", "depth":"深度参考", "previs":"白模动作参考",
         "edit":"编辑源图", "clip":"剪辑片段", "cutaway":"补画面", "reference":"参考素材", "script":"分镜来源", "draft":"定稿样片",
         "bgm":"配乐", "narration":"旁白", "audio":"音频片段", "audio_ref":"音频参考", "video_ref":"视频参考", "original_sound":"原声",
         "version_copy":"复制自版本", "seed_audio_ref":"音频参考"}
TRANSITIONS = {"cut":"硬切", "fade":"叠化", "black":"黑场"}
SETTINGS = {
    "model":"模型", "provider_model":"模型", "provider":"服务", "backend":"编辑后端", "quality":"质量",
    "ar":"宽高比", "duration":"生成时长", "seed":"随机种子", "strength":"生成强度", "steps":"步数",
    "denoise":"去噪强度", "feather":"羽化", "padding":"扩图边距", "count":"结果数量",
    "voice":"音色", "speed":"配音语速", "lyrics":"歌词", "extension":"续拍方向", "resolution":"输出分辨率",
    "duration_seconds":"音效时长", "prompt_influence":"提示词影响", "loop":"循环音效",
    "subtitles":"生成同步字幕",
    "audio_format":"音频输出格式", "sample_rate":"音频采样率",
    "pitch_semitones":"音高（半音）", "gain":"音量倍率",
}
PROMPT_FIELDS = {"style":"风格","scene":"场景","people":"人物","camera":"镜头",
                 "action":"动作","dialogue":"对白","sound":"声音","music":"配乐"}


def obj(value):
    return value if isinstance(value, dict) else {}


def items(value):
    return value if isinstance(value, list) else []


def text(value, limit=120):
    return value[:limit] if isinstance(value, str) else ""


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def current(node):
    versions = items(node.get("versions"))
    index = node.get("cur")
    return index + 1 if type(index) is int and 0 <= index < len(versions) else 0


def record(v):
    edit = obj(v.get("edit"))
    return obj(v.get("generation_record")) or obj(v.get("video_recipe")) or obj(v.get("audio_recipe")) or obj(edit.get("recipe"))


def capture_generation(payload):
    inputs = [entry for entry in items(payload.get("images"))[:30] if isinstance(entry, dict)]
    if guide := obj(payload.get("previs_guide")):
        inputs.append({**guide, "role":"previs"})
    inputs.extend({**entry,"role":"video_ref"} for entry in items(payload.get("video_refs")) if isinstance(entry, dict))
    inputs.extend({**entry,"role":"audio_ref"} for entry in items(payload.get("audio_refs")) if isinstance(entry, dict))
    return {"settings":{key:payload[key] for key in SETTINGS if key in payload},
            "prompt":text(payload.get("prompt"), 5000), "mode":text(payload.get("mode")),
            **({"camera_plan":payload["camera_plan"]} if payload.get("camera_plan") else {}),
            **({"video_optics":payload["video_optics"]} if payload.get("video_optics") else {}),
            **({"object_edit":payload["object_edit"]} if payload.get("object_edit") else {}),
            "fields":{key:text(value, 2400) for key, value in obj(payload.get("fields")).items() if key in PROMPT_FIELDS},
            "inputs":[{k:entry[k] for k in ("node_id","ref","role","time","name","version","start","end","memory_id","memory_view") if k in entry}
                      for entry in inputs]}


def script_excerpt(data, limit):
    lines = [text(data.get(key), limit) for key in ("title", "prompt", "style")]
    for i, shot in enumerate(items(data.get("shots"))[:60], 1):
        shot = obj(shot)
        content = [text(shot.get(key), 300) for key in ("shot_size", "camera", "scene")]
        content.extend(text(line, 120) for line in items(shot.get("action"))[:8])
        if any(content):
            lines.append(f"镜头 {i} · " + "，".join(part for part in content if part))
    return "\n".join(line for line in lines if line)


def argument_rows(v, receipt, remake):
    values = []
    run = obj(v.get("generation_record"))
    if name := text(run.get("service")):
        values.append({"label":"实际服务", "value":name})
    if mode := text(v.get("mode")):
        values.append({"label":"模式", "value":mode})
    for i, title in enumerate(items(obj(v.get("film_recipe")).get("titles"))[:20],1):
        start, end = number(obj(title).get("start")), number(obj(title).get("end"))
        content = text(obj(title).get("text"))
        if start is not None and end is not None and content:
            values.append({"label":f"标题 {i}","value":f"{start:g}–{end:g} 秒 · {content}"})
    parameters = {**receipt, **obj(run.get("settings"))}
    shot = run.get("camera_plan") or obj(v.get("video_recipe")).get("camera_plan")
    if shot:
        try:
            shot = camera_plan.validate(shot)
            values.append({"label":"重拍机位", "value":camera_plan.instructions(shot)})
        except ValueError:
            pass
    if optics := run.get("video_optics") or obj(v.get("video_recipe")).get("video_optics"):
        try:
            values.append({"label":"视频镜头参数","value":"，".join(image_camera.optics_instructions(image_camera.validate_optics(optics)))})
        except ValueError:
            pass
    image_view = obj(obj(v.get("edit")).get("recipe")).get("camera_view")
    if image_view:
        try:
            values.append({"label":"图片机位", "value":image_camera.instructions(image_camera.validate(image_view))})
        except ValueError:
            pass
    edit = obj(v.get("edit"))
    if light := obj(edit.get("recipe")).get("relight") or edit.get("light"):
        try:
            values.append({"label":"图片布光", "value":image_relight.instructions(image_relight.validate(light))})
        except ValueError:
            pass
    resize = obj(v.get("edit")).get("resize")
    if resize:
        try:
            settings = image_editor.resize_spec(resize)
            values.append({"label":"像素尺寸", "value":f"{settings['width']} × {settings['height']} · {image_editor.RESIZE_FITS[settings['fit']]}"})
        except ValueError:
            pass
    if edit.get("mode") == "upscale" and edit.get("scale") in (2,4):
        details = [f"{edit['scale']:g}×", text(edit.get("model"))]
        values.append({"label":"智能放大","value":" · ".join(filter(None,details))})
    if remake.get("motion_model"):
        parameters["provider_model"] = remake["motion_model"]
    if number(v.get("seed")) is not None:
        parameters["seed"] = v["seed"]
    seen = set()
    for key, label in SETTINGS.items():
        val = parameters.get(key)
        if key=="extension" and isinstance(val,str):
            val = {"before":"补拍片头","after":"续拍片尾"}.get(val)
        if val is None or label in seen:
            continue
        if (key == "model" and parameters.get("provider_model")) or not (text(val) or number(val) is not None):
            continue
        values.append({"label":label, "value":text(val) if isinstance(val, str) else val})
        seen.add(label)
    width, height, duration = (number(v.get(key)) for key in ("w", "h", "seconds"))
    if width and height:
        values.append({"label":"输出尺寸", "value":f"{width:g} × {height:g}"})
    if duration is not None:
        values.append({"label":"输出时长", "value":f"{duration:g} 秒"})
    if separation := obj(v.get("audio_separation")):
        label = {"vocals":"人声","no_vocals":"伴奏与环境声"}.get(text(separation.get("stem")))
        if label:
            values.append({"label":"音轨", "value":label})
    if previs := obj(v.get("previs_recipe")):
        values.extend([
            {"label":"物体数量", "value":len(items(previs.get("objects")))},
            {"label":"机位关键帧", "value":len(items(previs.get("camera")))},
        ])
    return values


class BoardReview:
    def __init__(self, board, *, limit, prompt_limit):
        self.board = board
        self.nodes = {n["id"]: n for n in items(board.get("nodes"))
                      if isinstance(n, dict) and isinstance(n.get("id"), str)}
        self.sources = defaultdict(list)
        self.incoming = defaultdict(list)
        self.scripts = defaultdict(list)
        for nid, n in self.nodes.items():
            for i, v in enumerate(items(n.get("versions")), 1):
                if ref := text(obj(v).get("ref"), 300):
                    self.sources[ref].append((nid, i))
            if n.get("type") == "script":
                for entry in items(obj(n.get("data")).get("made")):
                    for kind in ("img", "vid"):
                        source = obj(entry).get(kind)
                        if isinstance(source, str):
                            self.scripts[source].append(nid)
        for link in items(board.get("edges")):
            if isinstance(link, dict) and isinstance(link.get("to"), str):
                self.incoming[link["to"]].append(link)
        self.limit, self.prompt_limit = limit, prompt_limit
        self.rows, self.active, self.done = [], set(), set()
        self.incomplete = self.loop = False

    def dependency(self, preferred, ref, role, evidence, time=None, caption=None, version=None, snapshot=None):
        nid = preferred if isinstance(preferred, str) and preferred in self.nodes else None
        ref = text(ref, 300)
        candidates = self.sources.get(ref, [])
        if nid and ref:
            exact = [key for key in candidates if key[0] == nid]
            if (nid, version) in exact:
                index = version
            elif len(exact) == 1:
                index = exact[0][1]
            elif len(candidates) == 1:
                nid, index = candidates[0]
            else:
                nid = index = None
        elif nid:
            index = (current(self.nodes[nid]) if evidence == "当前连线" else 0) or None
        elif len(candidates) == 1:
            nid, index = candidates[0]
        else:
            index = None
        name = text(self.nodes[nid].get("name")) if nid else ""
        return {"node":nid, "version":index, "name":name or text(caption) or
                (ref.rsplit("/", 1)[-1] if ref else "已移除的节点"), "role":ROLES.get(role, "参考素材"),
                "evidence":evidence, "ref":ref or None, "time":number(time),
                "text":text(snapshot, self.prompt_limit),
                "ambiguous":bool(not nid and len(candidates) > 1)}

    def dependencies(self, node, v, index, receipt, remake):
        found = {}

        def add(preferred, ref, role, evidence, time=None, caption=None, version=None, snapshot=None, **metadata):
            link = self.dependency(preferred, ref, role, evidence, time, caption, version, snapshot)
            key = (link["node"] or (preferred if isinstance(preferred, str) else ""), link["ref"],
                   link["role"], link["time"], metadata.get("sequence"))
            found.setdefault(key, {**link, **metadata})

        captured = obj(v.get("generation_record"))
        audio_recipe = obj(v.get("audio_recipe"))
        seed_refs = audio_recipe.get("references") if audio_recipe.get("mode") == "seed_audio" else None
        copied = obj(v.get("copied_from"))
        source, ref = copied.get("node"), text(copied.get("ref"),300)
        if isinstance(source,str) and source != node["id"] and ref and any(
            source == nid for nid,_ in self.sources.get(ref,[])
        ):
            add(source, ref, "version_copy", "版本记录", version=copied.get("version"))
        if isinstance(seed_refs, list):
            for slot, entry in enumerate(seed_refs, 1):
                if isinstance(entry, dict) and entry.get("ref"):
                    role = "audio_ref" if entry.get("kind") == "audio" else "subject"
                    add(entry.get("node_id"), entry["ref"], role, "版本配方",
                        token=f"@音频{slot}" if role == "audio_ref" else None)
            entries = []
        else:
            entries = [entry for entry in items(captured.get("inputs")) + items(receipt.get("images")) if isinstance(entry, dict)]
        frame_order = [i for i, entry in enumerate(entries) if entry.get("role") == "frame"]
        for i, entry in enumerate(entries):
            role = text(entry.get("role")) or "reference"
            time = entry.get("time")
            if role == "frame" and (receipt.get("mode") == "fl2v" or receipt.get("mode") == "fl2va"):
                role = "first" if i == frame_order[0] else "last"
                time = 0 if role == "first" else None
            clip_range = {"end":number(entry.get("end"))} if role in ("video_ref","audio_ref") else {}
            add(entry.get("node_id"), entry.get("ref"), role, "生成记录", entry.get("start", time), entry.get("name"),
                entry.get("version"), entry.get("text"), **clip_range)
        edit_source = obj(v.get("edit")).get("source") or v.get("agent_source")
        if edit_source:
            add(node["id"] if any(key[0] == node["id"] for key in self.sources.get(text(edit_source, 300), [])) else None,
                edit_source, "edit", "编辑记录")
        draft = obj(v.get("draft_final"))
        draft_ref = draft.get("source_ref")
        if draft_ref and draft_ref != v.get("ref"):
            add(draft.get("source_node") or node["id"], draft_ref, "draft", "样片任务")
        origin = remake or obj(v.get("capture"))
        if origin.get("source_ref"):
            add(origin.get("source_node"), origin["source_ref"], "remake" if remake else "reference", "版本记录", origin.get("at"))
        if separation := obj(v.get("audio_separation")):
            add(separation.get("source_node"),separation.get("source_ref"),"original_sound","版本记录",
                separation.get("start"),end=number(separation.get("end")))
        if remake.get("depth_ref"):
            add(None, remake["depth_ref"], "depth", "版本记录")
        object_plan = obj(captured.get("object_edit")) or obj(obj(v.get("video_recipe")).get("object_edit"))
        if object_plan.get("replacement_ref"):
            add(None, object_plan["replacement_ref"], "subject", "物体替换参考图")
        film_recipe = obj(v.get("film_recipe"))
        clips = items(remake.get("clips")) + items(film_recipe.get("clips"))
        clip_evidence = "剪辑记录"
        if not clips and v.get("source") == "film" and index == current(node):
            clips = items(obj(obj(node.get("data")).get("film")).get("clips"))
            clip_evidence = "当前剪辑台"
        for i, clip in enumerate(clips, 1):
            if isinstance(clip, dict) and clip.get("ref"):
                finish = number(clip.get("out"))
                if finish is None and (duration := number(clip.get("duration"))) is not None:
                    finish = (number(clip.get("in")) or 0) + duration
                add(clip.get("node"), clip["ref"], "clip", clip_evidence, clip.get("in", 0),
                    end=finish, transition=TRANSITIONS.get(text(clip.get("trans"))), sequence=i,
                    **({"speed":speed} if (speed := number(clip.get("speed"))) not in (None, 1) else {}))
        for audio in items(film_recipe.get("audio")):
            if isinstance(audio, dict) and audio.get("ref"):
                add(audio.get("node"), audio["ref"], text(audio.get("role")), "剪辑记录", audio.get("start"))
        for cutaway in items(film_recipe.get("cutaways")):
            if isinstance(cutaway,dict) and cutaway.get("ref"):
                start, duration = number(cutaway.get("start")), number(cutaway.get("duration"))
                add(cutaway.get("node"),cutaway["ref"],"cutaway","补画面轨",start,cutaway.get("name"),cutaway.get("version"),
                    end=start+duration if start is not None and duration is not None else None)
        n = node["id"]
        for source in self.scripts[n]:
            add(source, None, "script", "分镜展开记录")
        stored_links = v.get("input_edges")
        if isinstance(stored_links, list):
            links, evidence = stored_links, "版本连线"
        elif index == current(node):
            links, evidence = self.incoming[n], "当前连线"
        else:
            links, evidence = [], "当前连线"
        covered = {link["node"] for link in found.values() if link["node"]}
        for edge in links[:100]:
            if not isinstance(edge, dict):
                continue
            source = edge.get("from")
            if isinstance(source, str) and source not in covered:
                relation = edge.get("relation")
                if relation == "draft_final":
                    relation = "draft"
                if relation == "seed_audio_ref" and audio_recipe:
                    continue
                if relation == "seed_audio_ref" and self.nodes.get(source, {}).get("type") == "image":
                    relation = "subject"
                ref = edge.get("ref") or edge.get("source_ref")
                clip_range = {"end":number(edge.get("end"))} if relation in ("video_ref","audio_ref") else {}
                add(source, ref, text(relation or edge.get("role")) or
                    ("text" if self.nodes.get(source, {}).get("type") == "text" else "reference"), evidence,
                    edge.get("start", edge.get("time")), **clip_range)
        return list(found.values())

    def inspect(self, key):
        if key in self.done:
            return
        if key in self.active:
            self.loop = True
            return
        if len(self.done) + len(self.active) >= self.limit:
            self.incomplete = True
            return
        nid, index = key
        n = self.nodes[nid]
        versions = items(n.get("versions"))
        v = obj(versions[index - 1]) if index else {}
        receipt = record(v)
        remake = obj(v.get("remake"))
        inputs = self.dependencies(n, v, index, receipt, remake)
        self.active.add(key)
        for link in inputs:
            if link["node"]:
                self.inspect((link["node"], link["version"] or 0))
        self.active.remove(key)
        self.done.add(key)
        data = obj(n.get("data"))
        fields = obj(receipt.get("fields"))
        field_prompt = "\n".join(f"{name} · {value}" for key, name in PROMPT_FIELDS.items() if (value := text(fields.get(key), self.prompt_limit)))
        prompt = text(receipt.get("effective_prompt") or field_prompt or receipt.get("prompt") or v.get("prompt"), self.prompt_limit + 1)
        contents = script_excerpt(data, self.prompt_limit) if n.get("type") == "script" else data.get("text")
        snippet = text(contents, self.prompt_limit + 1)
        type_text = KINDS.get(text(n.get("type")), "素材")
        operation = SOURCES.get(text(v.get("source")), type_text)
        if remake.get("kind") == "depth":
            operation = "提取深度参考"
        self.rows.append({"node":nid, "name":text(n.get("name")) or type_text,
                          "kind":type_text, "operation":operation, "version":index or None, "versions":len(versions),
                          "current":index == current(n), "ref":text(v.get("ref"), 300) or None,
                          "in_progress":bool(n.get("job") and index == current(n)), "inputs":inputs,
                          "prompt":prompt[:self.prompt_limit], "text":snippet[:self.prompt_limit],
                          "truncated_text":max(len(prompt), len(snippet)) > self.prompt_limit,
                          "settings":argument_rows(v, receipt, remake),
                          "recorded":bool(receipt or remake or v.get("edit") or v.get("film_recipe") or
                                          v.get("previs_recipe") or v.get("audio_separation")),
                          "memory":[text(a.get("name")) for a in items(v.get("memory_used"))[:8] if isinstance(a, dict)]})


def build(board, node_id=None, version=None, *, limit=120, prompt_limit=2400):
    review = BoardReview(board, limit=limit, prompt_limit=prompt_limit)
    roots = [node_id] if node_id else list(review.nodes)
    for nid in roots:
        node = review.nodes.get(nid)
        if node is None:
            raise ValueError("节点已不存在")
        index = current(node) if version is None else version
        if index < 0 or index > len(items(node.get("versions"))) or version == 0:
            raise ValueError("版本已不存在")
        review.inspect((nid, index))
    return {"name":text(board.get("name")) or "画布", "rev":number(board.get("rev")), "node":node_id,
            "version":version, "total_nodes":len(review.nodes), "steps":review.rows,
            "truncated":review.incomplete, "has_cycle":review.loop}


def markdown(report):
    def plain(value):
        value = str(value).replace("\n", " ").replace("\r", " ")
        return re.sub(r"([\\`*_{}\[\]()#+!|<>])", r"\\\1", value)

    def block(value):
        fence = "`" * max(3, 1 + max(map(len, re.findall(r"`+", value)), default=0))
        return [fence, value, fence]

    lines = [f"# {plain(report['name'])} · 制作复盘", "", f"画布修订 {report['rev'] or 0} · {len(report['steps'])} 个步骤", ""]
    lines += ["报告依据已保存的画布记录。连线表示素材关系。", ""]
    if report["has_cycle"]:
        lines += ["画布包含环形关系，相关步骤按访问顺序列出。", ""]
    if report["truncated"]:
        lines += ["画布较大，报告已截取部分步骤。", ""]
    for index, step in enumerate(report["steps"], 1):
        version = f" · 版本 {step['version']}/{step['versions']}" if step["version"] else ""
        lines += [f"## {index}. {plain(step['name'])}{version}", "", plain(step["operation"])]
        for item in step["settings"]:
            lines.append(f"- {item['label']} · {plain(item['value'])}")
        for item in step["inputs"]:
            upstream = f" 版本 {item['version']}" if item["version"] else ""
            end = f"–{item['end']:g}" if item.get("end") is not None else ""
            event = f" · {item['time']:g}{end} 秒" if item["time"] is not None else ""
            trans = f" · {item['transition']}" if item.get("transition") else ""
            rate = f" · {item['speed']:g}×" if item.get("speed") else ""
            token = f" {item['token']}" if item.get("token") else ""
            lines.append(f"- {item['role']}{token} · {plain(item['name'])}{upstream}{event}{trans}{rate}（{item['evidence']}）")
            if item["text"]:
                lines.extend(block(item["text"]))
        if step["memory"]:
            lines.append("- 资产库 · " + "、".join(map(plain, step["memory"])))
        for label, value in (("提示词", step["prompt"]), ("文字内容", step["text"])):
            if value:
                lines += ["", f"**{label}**", *block(value)]
        if step["truncated_text"]:
            lines += ["", "部分文字已截取。"]
        lines.append("")
    return "\n".join(lines)
