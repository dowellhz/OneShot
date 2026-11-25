"""Build the image and video workflows used by the H3 backends."""

import json
import math
import random
import re

from aiohttp import web

from engine import h3_int8
from oneshot import config
from oneshot.generation import rewriter
from oneshot.generation import tools
from oneshot.web import http as http_errors


M = {
    "fl2va": "minimax_h3_fl2va_bf16.safetensors",
    "ref2va": "minimax_h3_ref2va_bf16.safetensors",
    "clip": "qwen3vl_32b_minimax_h3_bf16.safetensors",
    "vae": "minimax_h3_video_vae_fp16.safetensors",
    "avae": "minimax_h3_audio_vae_fp32.safetensors",
    "lora8": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "lora768": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
    "lora_ref": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "image": "minimax_h3_image_pruned_bf16.safetensors",
    "image_vae": "minimax_h3_image_vae_fp16.safetensors",
    "pe": "qwen3.5_9b_w4a8_gptq.safetensors",
}


TEMPLATES = config.ROOT / "templates"


def size_for(ar: float, megapixels: float, multiple: int = 32):
    """ComfyUI ResolutionSelector's rule: megapixels of 1024*1024, sides rounded to the multiple."""
    px = megapixels * 1024 * 1024
    w = math.sqrt(px * ar)
    h = w / ar
    return max(multiple, round(w / multiple) * multiple), max(multiple, round(h / multiple) * multiple)


def frames_for(seconds: float) -> int:
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17   # H3's 17k+5 frame grid


def engine_video_frames(seconds: float) -> int:
    return min(345, max(124, frames_for(seconds)))


def engine_video_size(p):
    ar = float(p.get("ar") or 16 / 9)
    short = 768 if p.get("quality", "hd") == "hd" else 480
    long_side = min(round(short * max(ar, 1 / ar) / 32) * 32, (1032192 // short) // 32 * 32)
    return (long_side, short) if ar >= 1 else (short, long_side)


def keyframe_index(seconds, length):
    return max(0, min(length - 4, round(float(seconds or 0) * 24)))


def load_name(ref: str) -> str:
    """'input:sub/x.png' -> 'sub/x.png'; 'output:sub/x.png' -> 'sub/x.png [output]' (LoadImage's annotated names)."""
    try:
        tools.ref_path(config.COMFY_DIR, ref)
    except ValueError:
        raise web.HTTPBadRequest(text="bad image reference")
    kind, path = ref.split(":", 1)
    return path if kind == "input" else f"{path} [output]"


def seed_of(v) -> int:
    try:
        v = int(v)
    except (TypeError, ValueError):
        v = -1
    return v if v >= 0 else random.randrange(1, 2**48)


def ts(sec: float) -> str:
    return f"00:{int(sec):02d}.{int(round((sec - int(sec)) * 1000)):03d}"


H3IMG_IDS = {
    True: {"unet": "29", "clip": "30", "vae": "31", "cond": "32", "zero": "33", "pe": "34", "pe_clip": "35", "sys": "36",
           "preview": "37", "ks": "38", "task": "39", "repl": "40", "sw": "41", "dec": "42", "user": "43", "json": "44"},
    False: {"unet": "23:1", "clip": "23:2", "vae": "23:3", "cond": "23:5", "zero": "23:6", "pe": "23:15", "pe_clip": "23:16",
            "sys": "23:17", "preview": "23:18", "ks": "23:7", "task": "23:20", "repl": "23:19", "sw": "23:22", "dec": "23:8",
            "user": "23:24", "json": "23:26"},
}


SOUND_DEFAULT = "Natural ambient sound that matches the scene, with physical sounds synchronized to every visible action."


def base_structure(prompt: str, frame_times, seconds: float, sound: str, music: str) -> str:
    """The official T2VA/I2VA/FL2VA/L2VA layout around the user's words (kept as they are when already structured)."""
    align = rewriter.alignment_line(frame_times, seconds)
    if "integrated_multimodal_description:" in prompt:
        body = prompt[prompt.index("integrated_multimodal_description:"):]
    else:
        body = (f"integrated_multimodal_description: [Shot 1] {prompt}\n\noverall_soundscape: {http_errors.clean(sound) or SOUND_DEFAULT}"
                f"\n\nnon_diegetic_music: {http_errors.clean(music) or 'N/A'}")
    return (align + "\n\n" + body) if align else body


def graph_h3image(p: dict):
    """MiniMax H3-Image: text-to-image, or editing / multi-reference when images come in (<Picture n> = image n)."""
    imgs = p.get("images") or []
    edit = bool(imgs)
    t = json.loads((TEMPLATES / ("h3image_edit.json" if edit else "h3image_t2i.json")).read_text())
    g = {k: v for k, v in t.items()}
    ids = H3IMG_IDS[edit]
    seed = seed_of(p.get("seed"))
    mp = {"4mp": 4.0, "16mp": 16.0}.get(p.get("quality"), 4.0)
    prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {m.group(1)}>", p["prompt"].strip())
    pe = bool(p.get("expand", False))
    g[ids["unet"]]["inputs"]["unet_name"] = M["image"]
    g[ids["clip"]]["inputs"]["clip_name"] = M["clip"]
    g[ids["vae"]]["inputs"]["vae_name"] = M["image_vae"]
    g[ids["pe_clip"]]["inputs"]["clip_name"] = M["pe"]
    g[ids["ks"]]["inputs"]["seed"] = seed
    g[ids["user"]]["inputs"]["value"] = prompt
    g[ids["pe"]]["inputs"]["sampling_mode.seed"] = seed % (2**31)
    # the prompt expander streams its weights over PCIe at ~3 tokens/s here: no thinking, a short answer
    g[ids["pe"]]["inputs"]["thinking"] = False
    g[ids["pe"]]["inputs"]["max_length"] = 1024
    for k in ("9", "62", "14"):
        g.pop(k, None)
    g["save"] = {"class_type": "SaveImage", "inputs": {"filename_prefix": "h3studio/img", "images": [ids["dec"], 0]}}
    if edit:
        for k in ("45", "48", "50", "56"):
            g.pop(k)
        cond, pe_in = g[ids["cond"]]["inputs"], g[ids["pe"]]["inputs"]
        for k in [k for k in cond if k.startswith("images.")]: cond.pop(k)
        for k in [k for k in pe_in if k.startswith("images.")]: pe_in.pop(k)
        for i, im in enumerate(imgs[:9]):
            g[f"load{i}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
            g[f"px{i}"] = {"class_type": "ResizeImageMaskNode", "inputs": {"resize_type": "scale total pixels", "resize_type.megapixels": 4,
                                                                          "scale_method": "area", "input": [f"load{i}", 0]}}
            g[f"m32{i}"] = {"class_type": "ResizeImageMaskNode", "inputs": {"resize_type": "scale to multiple", "resize_type.multiple": 32,
                                                                           "scale_method": "area", "input": [f"px{i}", 0]}}
            cond[f"images.image_{i+1}"] = [f"m32{i}", 0]
            pe_in[f"images.image{i+1}"] = [f"m32{i}", 0]
        # the canvas sends image 1's ratio when the ratio follows it; 0 lets the node follow image 1 at 4 MP
        w, h = size_for(float(p["ar"]), mp) if p.get("ar") else (0, 0)
        cond["width"], cond["height"] = w, h
    else:
        w, h = size_for(float(p.get("ar") or 1.0), mp)
        g[ids["cond"]]["inputs"]["width"], g[ids["cond"]]["inputs"]["height"] = w, h
    if not pe:   # the user's words go straight to the conditioning
        for k in ("pe", "pe_clip", "sys", "task", "repl", "json", "sw"):
            g.pop(ids[k], None)
        g[ids["preview"]]["inputs"]["source"] = [ids["user"], 0]
    return g, {"seed": seed, "width": w, "height": h, "steps": 6, "mode_name": ("图像编辑" if edit else "H3-Image") + (" · 扩写" if pe else "")}


def graph_image(p: dict):
    if p.get("model", "h3img") != "h3video":
        return graph_h3image(p)
    ar = float(p.get("ar") or 16 / 9)
    w, h = size_for(ar, {"std": 1.0, "hd": 2.0}.get(p.get("quality"), 1.0), 16)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    steps = 8 if turbo else 30
    model = ["1", 0]
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M["fl2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": re.sub(r"@\S+\d+", "", p["prompt"]).strip(), "clip": ["2", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
    }
    if turbo:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": M["lora8"], "strength_model": 1.0}}
        model = ["6", 0]
    g.update({
        "7": {"class_type": "ModelAttentionBackend", "inputs": {"attention": "comfy kitchen attention", "model": model}},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["7", 0], "conditioning": ["4", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"scheduler": "simple", "steps": steps, "denoise": 1.0, "model": ["7", 0]}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["5", 0]}},
        "13": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["12", 0]}},
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["3", 0]}},
        "15": {"class_type": "SaveImage", "inputs": {"filename_prefix": "h3studio/img", "images": ["14", 0]}},
    })
    return g, {"seed": seed, "width": w, "height": h, "steps": steps}


def ref2va_prompt(prompt: str, captions, times, mode: str) -> str:
    n = len(captions)
    cap = [http_errors.clean(c) or "the scene" for c in captions]
    if mode == "reference":
        subj = "\n".join(f"<Subject {i+1}> is the main subject in <Picture {i+1}>, showing {cap[i]}." for i in range(n))
        keep = "\n".join(f"<Subject {i+1}>: fully_preserved - its appearance, colors and outfit stay identical to <Picture {i+1}>." for i in range(n))
        return (f"subject_definitions:\n{subj}\n\nsummary:\n[reference generation] {prompt}\n\n"
                f"retention_analysis:\n{keep}\n\ndetailed_description:\n[Shot 1] {prompt}")
    lines = [f"<Subject 1> is the main subject in <Picture 1>.",
             f"<Picture 1> is the first frame of [Shot 1], showing {cap[0]}."]
    lines += [f"<Picture {i+1}> is the keyframe of [Shot 1], showing {cap[i]}." for i in range(1, n)]
    steps = "".join(f" At {ts(times[i])} the shot matches <Picture {i+1}>: {cap[i]}." for i in range(1, n))
    keep = [f"<Subject 1> (appears in [Shot 1]): fully_preserved - the subject's appearance stays identical throughout.",
            "<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from <Picture 1>."]
    keep += [f"<Picture {i+1}> ([Shot 1] keyframe): fully_preserved - reached at {ts(times[i])}." for i in range(1, n)]
    return ("subject_definitions:\n" + "\n".join(lines) + "\n\nsummary:\n[keyframe completion + reference generation] "
            f"One continuous shot. {prompt} It begins with <Picture 1>"
            + "".join(f", then matches <Picture {i+1}>" for i in range(1, n)) + ".\n\nretention_analysis:\n" + "\n".join(keep)
            + f"\n\ndetailed_description:\n[Shot 1] The shot begins from <Picture 1>. {prompt}{steps}")


def is_character_reference(image):
    return image.get("role") == "subject" and image.get("memory_kind") in (None,"character")


def planned_prompt(prompt: str, subj, frames, end: float) -> str:
    """Ref2VA's structured prompt for character references (<Picture 1..S>) and timed frames (<Picture S+1..>)."""
    S = len(subj)
    lines, keep, steps = [], [], ""
    bundles = {}
    for k, im in enumerate(subj, 1):
        asset = im.get("memory_id") if im.get("memory_bundle") else None
        number = bundles.setdefault(asset, k) if isinstance(asset, str) and asset else k
        if number != k:
            lines.append(f"<Picture {k}> is an additional view of the same <Subject {number}>.")
            continue
        cap = http_errors.clean(im.get("caption"))
        subject = {"scene": "environment", "prop": "object", "style": "visual style"}.get(im.get("memory_kind"), "character")
        lines.append(f"<Subject {k}> is the {subject} in <Picture {k}>" + (f", {cap}." if cap else "."))
        features = "visual style, colors and lighting" if subject == "visual style" else "layout, materials, colors and visual details" if subject != "character" else "face, body shape, colors and outfit"
        keep.append(f"<Subject {k}>: fully_preserved - the {features} of <Subject {k}> stay identical to <Picture {k}> throughout.")
    for j, im in enumerate(frames):
        pn, t, cap = S + j + 1, float(im["time"]), http_errors.clean(im.get("caption")) or "the scene"
        kind = "first frame" if t <= 0.01 else ("last frame" if t >= end - 0.05 else "keyframe")
        lines.append(f"<Picture {pn}> is the {kind} of [Shot 1], showing {cap}.")
        keep.append(f"<Picture {pn}> ([Shot 1] {kind}): fully_preserved - " + ("the video starts exactly from it." if kind == "first frame" else f"reached at {ts(t)}."))
        if kind != "first frame":
            steps += f" At {ts(t)} the shot matches <Picture {pn}>."
    tag = "[keyframe completion + reference generation]" if frames else "[reference generation]"
    start = " The shot begins from <Picture %d>." % (S + 1) if frames and float(frames[0]["time"]) <= 0.01 else ""
    if frames and any(is_character_reference(image) for image in subj):
        keep.append("People shown in the keyframes and their corresponding character references share the same identity. "
                    "Keep one on-screen instance per character unless the shot explicitly calls for duplicates.")
    return (f"subject_definitions:\n" + "\n".join(lines) + f"\n\nsummary:\n{tag} {prompt}\n\nretention_analysis:\n" + "\n".join(keep)
            + f"\n\ndetailed_description:\n[Shot 1]{start} {prompt}{steps}")


def graph_video_planned(p: dict, *, native=False, int8=False):
    imgs = p.get("images") or []
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    length = engine_video_frames(seconds) if native else frames_for(seconds)
    end = (length - 4) / 24
    hd = p.get("quality", "hd") == "hd"
    w, h = engine_video_size(p) if int8 else size_for(float(p.get("ar") or 16 / 9), 1.0 if hd else 0.4)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    subj = [im for im in imgs if im["role"] == "subject"][:9]
    frames = sorted((im for im in imgs if im["role"] != "subject"), key=lambda im: float(im.get("time", 0)))
    frames = [{**im, "time": keyframe_index(im.get("time"), length) / 24} for im in frames]
    # @图k (the k-th input on the canvas) -> its picture number
    pic = {}
    for k, im in enumerate(subj): pic[im["index"]] = k + 1
    for j, im in enumerate(frames): pic[im["index"]] = len(subj) + j + 1
    prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {pic[int(m.group(1))]}>" if int(m.group(1)) in pic else m.group(0), p["prompt"].strip())
    if "subject_definitions:" in prompt:
        full = prompt[prompt.index("subject_definitions:"):]
    else:
        full = (planned_prompt(prompt, subj, frames, end) + f"\n\noverall_soundscape:\n{http_errors.clean(p.get('sound')) or SOUND_DEFAULT}"
                f"\n\nnon_diegetic_music:\n{http_errors.clean(p.get('music')) or 'N/A'}")
    lora, steps = (M["lora_ref"], 4) if turbo else (None, 20)
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": h3_int8.WEIGHTS if int8 else M["ref2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": M["avae"]}},
    }
    model = ["1", 0]
    if lora:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora, "strength_model": 1.0}}
        model = ["6", 0]
    refs = {}
    for k, im in enumerate(subj):
        g[f"s{k}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
        refs[f"ref_images.ref_image_{k}"] = [f"s{k}", 0]
    g["5"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
        "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0], "prompt": full, "width": w, "height": h,
        "length": length, "ref_image_size": "match", **refs}}
    cond, latent = ["5", 0], ["5", 1]
    for j, im in enumerate(frames):
        g[f"f{j}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
        g[f"guide{j}"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
            "positive": cond, "latent": latent, "vae": ["3", 0], "audio_vae": ["4", 0], "image": [f"f{j}", 0],
            "frame_idx": keyframe_index(im["time"], length)}}
        cond = [f"guide{j}", 0]
    g.update({
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9": {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "10": {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": cond}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["9", 0], "latent_image": latent}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24}},
        "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": "h3studio/video", "format": "auto", "codec": "auto"}},
    })
    name = ("人物设定" if subj else "") + (" + " if subj and frames else "") + (f"{len(frames)} 张关键帧" if frames else "")
    if int8 and not name:
        name = "文生视频"
    return g, {"seed": seed, "width": w, "height": h, "steps": steps, "frames": length, "mode": "planned", "mode_name": name,
               "full_prompt": full}


NO_SPEECH = ("No one speaks: there is no dialogue, narration, voiceover or singing, and every character's mouth stays "
             "closed except while eating or drinking.")


NO_SPEECH_SOUND = "No human speech, narration or voices of any kind."
SCRIPTED_SPEECH_SOUND = ("Only the explicitly scripted vocal lines are audible, verbatim and in order. "
                         "No additional speech or narration. Do not read directions, labels or scene descriptions aloud.")


_SECTION = re.compile(r"\n\n[a-z_]+:")


def _append_to_section(full: str, names, text: str) -> tuple[str, bool]:
    for name in names:
        m = re.search(rf"(^|\n){name}:", full)
        if not m:
            continue
        nxt = _SECTION.search(full, m.end())
        end = nxt.start() if nxt else len(full)
        body = full[:end].rstrip()
        sep = "" if body.endswith(":") else " "
        return body + sep + text + full[end:], True
    return full, False


def no_speech_guard(full: str) -> str:
    """Constrain H3's generated voices to the supplied dialogue and lyrics."""
    scripted = bool(re.search(r"<d>\s*[^<].*?</d>", full, re.S))
    sound = SCRIPTED_SPEECH_SOUND if scripted else NO_SPEECH_SOUND
    if sound in full:
        return full
    if not scripted:
        full, _ = _append_to_section(full, ("detailed_description", "integrated_multimodal_description"), NO_SPEECH)
    full, ok = _append_to_section(full, ("overall_soundscape",), sound)
    if not ok:
        full = full.rstrip() + f"\n\noverall_soundscape:\n{SOUND_DEFAULT} {sound}"
    return full


def graph_video(p: dict, *, native=False):
    if p.get("_int8"):
        g, meta = graph_int8_video(p)
    else:
        g, meta = _graph_video(p, native=native)
    full = meta["full_prompt"]
    if p.get("_preserve_speech_motion") is not True:
        full = no_speech_guard(full)
    if "5" in g and "prompt" in g["5"].get("inputs", {}):
        g["5"]["inputs"]["prompt"] = full
    meta["full_prompt"] = full
    return g, meta


def int8_video_input(p):
    if p.get("planned"):
        return p
    images = p.get("images") or []
    mode = p.get("mode") or "auto"
    if mode == "fl2v" and len(images) > 2:
        images = [images[0], images[-1]]
    frames = engine_video_frames(min(15.0, max(2.0, float(p.get("duration") or 5))))
    end = (frames - 4) / 24
    role = "subject" if mode == "reference" else "frame"
    return {**p, "planned": True, "images": [dict(image, index=image.get("index") or i + 1, role=role,
                                                 time=i * end / max(1, len(images) - 1)) for i, image in enumerate(images)]}


def graph_int8_video(p):
    graph, meta = graph_video_planned(int8_video_input(p), native=True, int8=True)
    meta.update(provider="本地 H3", model=h3_int8.MODEL, resolution="768P" if p.get("quality", "hd") == "hd" else "480P")
    return graph, meta


def _graph_video(p: dict, *, native=False):
    if p.get("planned"):
        return graph_video_planned(p, native=native)
    imgs = p.get("images") or []
    n = len(imgs)
    mode = p.get("mode") or "auto"
    if mode == "auto":
        mode = "fl2v" if n <= 2 else "keyframes"
    if mode == "fl2v" and n > 2:
        imgs, n = [imgs[0], imgs[-1]], 2
    if mode in ("keyframes", "reference") and n == 0:
        mode = "fl2v"
    seconds = min(15.0, max(2.0, float(p.get("duration") or 5)))
    length = engine_video_frames(seconds) if native else frames_for(seconds)
    hd = p.get("quality", "hd") == "hd"
    ar = float(p.get("ar") or 16 / 9)
    w, h = size_for(ar, 1.0 if hd else 0.4)
    turbo = bool(p.get("turbo", True))
    seed = seed_of(p.get("seed"))
    ref = mode in ("keyframes", "reference")
    prompt = p["prompt"].strip()
    if ref:   # @图k -> <Picture k>, the reference pipeline's names
        prompt = re.sub(r"@图(\d+)", lambda m: f"<Picture {m.group(1)}>", prompt)
    else:
        prompt = re.sub(r"@图(\d+)", lambda m: "the first frame" if m.group(1) == "1" else (
            "the last frame" if int(m.group(1)) == n else m.group(0)), prompt)
    if turbo:
        lora, steps = (M["lora_ref"], 4) if ref else ((M["lora768"], 4) if hd else (M["lora8"], 8))
    else:
        lora, steps = None, 20
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M["ref2va" if ref else "fl2va"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M["clip"], "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": M["avae"]}},
    }
    model = ["1", 0]
    if lora:
        g["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora, "strength_model": 1.0}}
        model = ["6", 0]
    for i, im in enumerate(imgs):
        g[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": load_name(im["ref"])}}
    times = []
    if not ref:
        times = [0.0] if n == 1 else ([0.0, seconds] if n >= 2 else [])
        prompt = base_structure(prompt, times, seconds, p.get("sound"), p.get("music"))
        times = []
        inp = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "width": w, "height": h, "length": length}
        if n >= 1: inp["first_frame"] = ["img0", 0]
        if n >= 2: inp["last_frame"] = [f"img{n-1}", 0]
        g["5"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": inp}
        cond, latent = ["5", 0], ["5", 1]
        full_prompt = prompt
    else:
        caps = [im.get("caption") or "" for im in imgs]
        if mode == "keyframes":
            last = (length - 4) / 24
            times = [last * i / (n - 1) for i in range(n)]
            full_prompt = ref2va_prompt(prompt, caps, times, mode)
            refs = {"ref_images.ref_image_0": ["img0", 0]}
        else:
            full_prompt = ref2va_prompt(prompt, caps, [], mode)
            refs = {f"ref_images.ref_image_{i}": [f"img{i}", 0] for i in range(min(n, 9))}
        g["5"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0], "prompt": full_prompt, "width": w, "height": h,
            "length": length, "ref_image_size": "match", **refs}}
        cond, latent = ["5", 0], ["5", 1]
        if mode == "keyframes":
            for i in range(1, n):
                g[f"guide{i}"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": cond, "latent": latent, "vae": ["3", 0], "audio_vae": ["4", 0], "image": [f"img{i}", 0],
                    "frame_idx": min(length - 4, round(times[i] * 24))}}
                cond = [f"guide{i}", 0]
    g.update({
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9": {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "10": {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": cond}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["9", 0], "latent_image": latent}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "audio": ["13", 0], "fps": 24}},
        "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": "h3studio/video", "format": "auto", "codec": "auto"}},
    })
    names = {"fl2v": ["文生视频", "首帧生视频", "首尾帧生视频"][min(n, 2)], "keyframes": f"{n} 张关键帧", "reference": f"{n} 张主体参考"}
    return g, {"seed": seed, "width": w, "height": h, "steps": steps, "frames": length, "mode": mode,
               "mode_name": names[mode], "times": [round(t, 2) for t in times], "full_prompt": full_prompt}
